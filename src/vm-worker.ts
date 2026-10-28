import { createMoeJS, type Engine } from "moejs-wasm"
import { VmInput, VmOutput, maxVmBytes } from "./vm-protocol.js"
import { extractLibrary, extractLoaders, normalizeLoader } from "./loader.js"
import { createRuntime, runScript } from "./vm.js"

// Game code runs inside the MoeJS WASM sandbox. This process adds fault/timeout
// isolation and requires explicit trusted-code authorization in the parent CLI.
async function main(): Promise<void> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > maxVmBytes) throw new Error("VM input exceeds 64 MiB")
    chunks.push(chunk)
  }
  const input = VmInput.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
  chunks.length = 0
  const engine = await createMoeJS({ timeoutMs: 5000 })
  try {
    const output = await decode(input, engine)
    const serialized = JSON.stringify(output)
    if (Buffer.byteLength(serialized) > maxVmBytes) throw new Error("VM output exceeds 64 MiB")
    process.stdout.write(serialized)
  } finally {
    await engine.close()
  }
}

async function decode(input: VmInput, engine: Engine): Promise<VmOutput> {
  const runtime = await createRuntime(engine)
  const run = (source: string, filename: string, timeoutMs: number) =>
    runScript(engine, runtime, filename, source, timeoutMs)
  await runtime.setGlobal("__filesJson", JSON.stringify(input.files))
  await runtime.setGlobal(
    "__pluginsJson",
    JSON.stringify(input.plugins.map((plugin) => [plugin.name.toLowerCase(), plugin.parameters]))
  )
  input.files.length = 0
  const bootstrap = String.raw`
    "use strict";
    const __files = new Map(JSON.parse(__filesJson));
    delete globalThis.__filesJson;
    const __folded = new Map();
    for (const name of __files.keys()) {
      const key = name.normalize("NFC").toLowerCase();
      const previous = __folded.get(key);
      __folded.set(key, previous === undefined ? name : null);
    }
    const __plugins = new Map(JSON.parse(__pluginsJson));
    delete globalThis.__pluginsJson;
    const __requests = new Set();
    let __loaded, __captured, __lastError = "", __pending = [];
    globalThis.window = globalThis;
    globalThis.console = {
      log(...args) { __lastError = args.map(String).join(" ").slice(0, 2000); },
      warn(...args) { this.log(...args); },
      error(...args) { this.log(...args); },
    };
    globalThis.PluginManager = {
      parameters(name) { return __plugins.get(String(name).toLowerCase()) ?? {}; }
    };
    globalThis.XMLHttpRequest = class {
      status = 0; responseText = ""; response = null; responseType = "";
      readyState = 0; onload = null; onerror = null; onreadystatechange = null;
      open(method, url, async = true) {
        if (method !== "GET") throw new Error("Only local GET is supported");
        if (typeof url !== "string" || /^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(url)) throw new Error("External or absolute URL is forbidden");
        const decoded = decodeURIComponent(url.split(/[?#]/, 1)[0]);
        if (decoded.startsWith("/") || decoded.includes("\\") || decoded.split("/").includes("..") || decoded.includes("\0")) throw new Error("Unsafe local URL");
        this.url = decoded.replace(/^\.\//, ""); this.async = async; this.readyState = 1;
      }
      overrideMimeType(type) { this.mimeType = String(type); }
      send(body) {
        if (body != null) throw new Error("GET body unsupported");
        const load = () => {
          __requests.add(this.url);
          const actual = __folded.get(this.url.normalize("NFC").toLowerCase());
          this.status = typeof actual === "string" ? 200 : 404;
          this.responseText = this.status === 200 ? __files.get(actual) : "";
          if (this.responseType === "arraybuffer") {
            this.response = new TextEncoder().encode(this.responseText).buffer;
          } else if (this.responseType === "json") {
            this.response = this.status === 200 ? JSON.parse(this.responseText) : null;
          } else if (this.responseType === "" || this.responseType === "text") {
            this.response = this.responseText;
          } else throw new Error("Unsupported XHR response type: " + this.responseType);
          this.readyState = 4;
          if (this.onreadystatechange) this.onreadystatechange();
          if (this.onload) this.onload();
        };
        if (this.async === false) load(); else __pending.push(load);
      }
    };
    globalThis.DataManager = {
      loadDataFile(name, src) {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", "data/" + src);
        xhr.overrideMimeType("application/json");
        xhr.onload = () => {
          if (xhr.status >= 400) throw new Error("Local data file not found: " + src);
          window[name] = JSON.parse(xhr.responseText);
          DataManager.onLoad(window[name]);
        };
        xhr.send();
      },
      onLoad(object) { __loaded = true; __captured = object; }
    };
    String.prototype.contains = String.prototype.includes;
    Array.prototype.contains = Array.prototype.includes;
    function __decode(path) {
      DataManager._errorUrl = null;
      __loaded = false; __captured = undefined; __lastError = ""; __pending = [];
      window.__rmgafData = null;
      DataManager.loadDataFile("__rmgafData", path.slice(5));
    }
    function __compressed(path) {
      if (typeof LZString === "undefined") return false;
      const actual = __folded.get(path.normalize("NFC").toLowerCase());
      const encoded = __files.get(actual);
      if (typeof encoded !== "string") return false;
      const text = LZString.decompressFromBase64(encoded);
      if (typeof text !== "string" || LZString.compressToBase64(text) !== encoded) return false;
      const value = JSON.parse(text);
      if (value === null || typeof value !== "object") return false;
      __requests.add(path);
      __loaded = true; __captured = value;
      return true;
    }
    function __drain() {
      let count = 0;
      while (__pending.length) {
        if (++count > 1000) throw new Error("Too many queued data loads");
        __pending.shift()();
      }
    }
    function __result() {
      if (!__loaded || __captured === null || typeof __captured !== "object") {
        throw new Error(__lastError || "Loader did not return a JSON object/array through DataManager.onLoad");
      }
      return JSON.stringify(__captured);
    }
  `
  await run(bootstrap, "rmgaf:loader-environment", 5000)
  const output: VmOutput = { data: [], errors: [], requests: [], loaders: [], warnings: [] }
  const loaders: { name: string; code: string }[] = []
  const dependencies = new Set<string>()
  for (const script of input.scripts) {
    if (!script.code.includes("DataManager")) continue
    try {
      const extracted = extractLoaders(
        await normalizeLoader(script.code, engine),
        script.name,
        true
      )
      output.warnings.push(...extracted.rejected.map((message) => `Unsupported loader: ${message}`))
      for (const code of extracted.code) loaders.push({ name: script.name, code })
      for (const name of extracted.dependencies) dependencies.add(name)
    } catch (error) {
      output.warnings.push(
        `${script.name}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  // LZ-String is an auxiliary JSON format too, not necessarily a loadDataFile override.
  if (input.scripts.some((script) => script.code.includes("LZString.decompressFromBase64")))
    dependencies.add("LZString")
  for (const name of dependencies) {
    if (await run(`Object.hasOwn(globalThis, ${JSON.stringify(name)})`, "rmgaf:dependency", 1000))
      continue
    for (const script of input.scripts) {
      const code = extractLibrary(script.code, name)
      if (!code) continue
      await run(code, script.name, 2000)
      output.loaders.push(script.name)
      break
    }
  }
  for (const loader of loaders) {
    await run(loader.code, loader.name, 2000)
    output.loaders.push(loader.name)
  }
  output.loaders = [...new Set(output.loaders)]
  for (const path of input.targets) {
    try {
      await run(
        `if (!__compressed(${JSON.stringify(path)})) { __decode(${JSON.stringify(path)}); __drain(); }`,
        path,
        5000
      )
      const serialized = await run("__drain(); __result();", path, 5000)
      if (typeof serialized !== "string") throw new Error("Loader returned no JSON")
      output.data.push([path, JSON.parse(serialized)])
    } catch (error) {
      await runtime.clearInterrupt()
      output.errors.push([path, error instanceof Error ? error.message : String(error)])
    }
  }
  const serializedRequests = await run("JSON.stringify([...__requests])", "rmgaf:requests", 1000)
  if (typeof serializedRequests !== "string") throw new Error("Loader returned no request list")
  output.requests = VmOutput.shape.requests.parse(JSON.parse(serializedRequests))
  return output
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
