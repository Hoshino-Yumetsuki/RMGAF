import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { extname, posix } from "node:path"
import { DATABASES, FileIndex } from "./core.js"
import { discoverText, parsePlugins } from "./text.js"
import { VmInput, VmOutput, maxVmBytes } from "./vm-protocol.js"
import type { Decoder } from "./references.js"

/** Only call after the user explicitly trusts the game's executable code. */
export const decodeTrustedGame: Decoder = async (root, files) => {
  const index = new FileIndex(root)
  const registry = index.one("js/plugins.js")
  if (!registry) throw new Error("Trusted decoding needs a unique js/plugins.js registry")
  const plugins = parsePlugins(index.read(registry)).filter((plugin) => plugin.status)
  const scripts: VmInput["scripts"] = []
  const names = new Set<string>()
  const entry = index.one("index.html")
  if (entry) {
    for (const ref of discoverText(index.read(entry), "html", "index.html"))
      for (const path of ref.paths)
        if (path.startsWith("js/libs/") && path.endsWith(".js")) names.add(path)
  }
  for (const plugin of plugins) names.add(`js/plugins/${plugin.name}.js`)
  for (const name of names) {
    const path = index.one(name)
    if (path) scripts.push({ name: path, code: index.read(path) })
  }
  const inputs: [string, string][] = []
  let total = 0
  for (const [path, directory] of index.entries) {
    if (
      directory ||
      !path.toLowerCase().startsWith("data/") ||
      extname(path).toLowerCase() !== ".json"
    )
      continue
    const text = index.read(path)
    total += Buffer.byteLength(text)
    if (total > maxVmBytes) throw new Error("VM database input exceeds 64 MiB")
    inputs.push([path, text])
  }
  const input: VmInput = {
    files: inputs,
    targets: files.map((path) => {
      const relative = path.split("/").slice(1).join("/")
      const database = DATABASES.find(
        (name) => `${name}.json`.toLowerCase() === relative.toLowerCase()
      )
      const map = /^map(\d+)\.json$/i.exec(relative)
      // Loaders receive the engine's request, not the misspelled directory entry.
      return "data/" + (database ? `${database}.json` : map ? `Map${map[1]}.json` : relative)
    }),
    plugins: plugins.map((plugin) => ({ name: plugin.name, parameters: plugin.parameters ?? {} })),
    scripts
  }
  const sourceMode = import.meta.url.endsWith(".ts")
  const worker = fileURLToPath(
    new URL(sourceMode ? "./vm-worker.ts" : "./vm-worker.mjs", import.meta.url)
  )
  const serialized = JSON.stringify(input)
  if (Buffer.byteLength(serialized) > maxVmBytes) throw new Error("VM request exceeds 64 MiB")
  const response = await new Promise<VmOutput>((resolve, reject) => {
    const child = spawn(process.execPath, [...(sourceMode ? ["--import", "tsx"] : []), worker], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        // MoeJS threads inherit execArgv, where V8 heap flags are forbidden.
        NODE_OPTIONS: "--max-old-space-size=768",
        PATH: process.env.PATH ?? "",
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {})
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    })
    let stdout = "",
      stderr = "",
      outputBytes = 0
    let failed: Error | undefined
    const abort = () => {
      failed = new Error("Trusted VM decoding interrupted")
      child.kill("SIGKILL")
    }
    process.once("SIGINT", abort)
    const timer = setTimeout(() => {
      failed = new Error("Trusted VM exceeded 30-second process deadline")
      child.kill("SIGKILL")
    }, 30_000)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > maxVmBytes) {
        failed = new Error("Trusted VM exceeded output limit")
        child.kill("SIGKILL")
      } else stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk.slice(0, 4000 - stderr.length)
    })
    child.on("error", (error) => {
      failed = error
    })
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") failed = error
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      process.removeListener("SIGINT", abort)
      if (failed) return reject(failed)
      if (code !== 0)
        return reject(
          new Error(`Trusted VM failed (${signal ?? code}): ${stderr || "no diagnostic"}`)
        )
      try {
        resolve(VmOutput.parse(JSON.parse(stdout)))
      } catch (error) {
        reject(new Error("Invalid result from trusted VM", { cause: error }))
      }
    })
    child.stdin.end(serialized)
  })
  const requested = new Set(input.targets)
  const data = new Map<string, unknown>()
  const errors = new Map<string, string>()
  for (const [path, value] of response.data) {
    if (!requested.has(path)) throw new Error("VM returned an unrequested database")
    const actual = index.one(path)
    if (actual) data.set(actual, value)
  }
  for (const [path, message] of response.errors) {
    const actual = index.one(path)
    if (actual && requested.has(path)) errors.set(actual, message)
  }
  // Unreferenced duplicate files are not fed a guessed name/key. The core still
  // reports them if the game's real loader cannot read that specific filename.
  for (const path of files)
    if (!data.has(path) && !errors.has(path)) errors.set(path, "No decoded result returned")
  const requests = response.requests.map((path) => {
    const normalized = posix.normalize(path)
    if (normalized.startsWith("../") || normalized.startsWith("/") || normalized.includes(":"))
      throw new Error("VM returned an unsafe resource path")
    return normalized
  })
  return {
    data,
    errors,
    requests,
    loaders: response.loaders,
    warnings: response.warnings
  }
}
