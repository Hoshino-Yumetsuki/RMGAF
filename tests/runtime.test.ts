import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { test, type TestContext } from "node:test"
import { DATABASES, FileIndex, inspectGame, applyChanges, isBlocked } from "../src/core.js"
import { decodeTrustedGame } from "../src/runtime.js"
import { extractLoaders } from "../src/loader.js"

function fixture(t: TestContext, code: string, encoded: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rmgaf-vm-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const folder of ["data", "js/plugins", "img/characters"])
    fs.mkdirSync(path.join(root, folder), { recursive: true })
  fs.writeFileSync(
    path.join(root, "index.html"),
    '<script src="js/rpg_core.js"></script><script src="js/plugins.js"></script>'
  )
  fs.writeFileSync(path.join(root, "js/rpg_core.js"), "")
  fs.writeFileSync(
    path.join(root, "js/plugins.js"),
    'var $plugins = [{"name":"Decoder","status":true,"parameters":{}}];'
  )
  fs.writeFileSync(path.join(root, "js/plugins/Decoder.js"), code)
  for (const name of DATABASES)
    fs.writeFileSync(
      path.join(root, `data/${name}.json`),
      JSON.stringify(name === "System" ? {} : [])
    )
  fs.writeFileSync(path.join(root, "data/Actors.json"), encoded)
  fs.writeFileSync(path.join(root, "img/characters/hero.PNG"), "original image")
  return fs.realpathSync(root)
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const [name, directory] of new FileIndex(root).entries)
    if (!directory) files[name] = fs.readFileSync(path.join(root, name), "base64")
  return files
}

function encryptedLoader(): { code: string; encoded: string } {
  const secret = randomBytes(6).toString("hex")
  const bytes = Buffer.from(JSON.stringify([null, { characterName: "Hero" }]))
  const encoded = Buffer.from(
    bytes.map((byte, i) => byte ^ secret.charCodeAt(i % secret.length))
  ).toString("base64")
  const code = `
    (() => {
      const key = ${JSON.stringify(secret)};
      const previous = DataManager.loadDataFile;
      function decode(text) {
        const bytes = atob(text);
        let result = "";
        for (let i = 0; i < bytes.length; i++) result += String.fromCharCode(bytes.charCodeAt(i) ^ key.charCodeAt(i % key.length));
        return JSON.parse(decodeURIComponent(escape(result)));
      }
      DataManager['loadDataFile'] = function(name, file) {
        if (file !== 'Actors.json') return previous.call(this, name, file);
        const xhr = new XMLHttpRequest();
        xhr.open('GET', 'data/' + file);
        xhr.overrideMimeType('text/plain');
        xhr.onload = function() { window[name] = decode(xhr.responseText); DataManager.onLoad(window[name]); };
        xhr.send();
      };
      throw new Error('unrelated gameplay initialization must not run');
    })();`
  return { code, encoded }
}

void test("trusted VM runs real closure and helper with a per-fixture key, preserving encrypted files", async (t) => {
  const { code, encoded } = encryptedLoader()
  const root = fixture(t, code, encoded)
  const before = snapshot(root)
  const report = await inspectGame(root, { decode: decodeTrustedGame })
  assert.equal(report.decoded, 1)
  assert.deepEqual(report.issues, [])
  assert.deepEqual(
    report.changes.map(({ old, new: target }) => [old, target]),
    [["img/characters/hero.PNG", "img/characters/Hero.png"]]
  )
  assert.deepEqual(snapshot(root), before)
  applyChanges(report)
  assert.equal(fs.readFileSync(path.join(root, "data/Actors.json"), "utf8"), encoded)
  assert.equal(
    fs.readFileSync(path.join(root, "img/characters/Hero.png"), "utf8"),
    "original image"
  )
  assert.deepEqual((await inspectGame(root, { decode: decodeTrustedGame })).changes, [])
})

void test("trusted decoding uses engine-requested database spelling before repairing disk casing", async (t) => {
  const { code, encoded } = encryptedLoader()
  const root = fixture(t, code, encoded)
  fs.renameSync(path.join(root, "data/Actors.json"), path.join(root, "data/aCTORS.JSON"))
  fs.renameSync(path.join(root, "data"), path.join(root, "DATA"))
  const before = snapshot(root)
  const report = await inspectGame(root, { decode: decodeTrustedGame })
  assert.deepEqual(report.issues, [])
  assert.equal(report.decoded, 1)
  assert.deepEqual(snapshot(root), before)
  applyChanges(report)
  assert.equal(snapshot(root)["data/Actors.json"], Buffer.from(encoded).toString("base64"))
  assert.equal(
    snapshot(root)["img/characters/Hero.png"],
    Buffer.from("original image").toString("base64")
  )
  const clean = await inspectGame(root, { decode: decodeTrustedGame })
  assert.deepEqual(clean.issues, [])
  assert.deepEqual(clean.changes, [])
})

void test("implicit arguments remain local through helpers and nested arrows", async (t) => {
  const code = `
    function restore() { return (() => JSON.parse(atob(arguments[0])))(); }
    DataManager.loadDataFile = function(name, src) {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', 'data/' + arguments[1]);
      xhr.onload = function() { DataManager.onLoad(restore(xhr.responseText)); };
      xhr.send();
    };`
  const encoded = Buffer.from(JSON.stringify([null, { characterName: "Hero" }])).toString("base64")
  const root = fixture(t, code, encoded)
  const report = await inspectGame(root, { decode: decodeTrustedGame })
  assert.deepEqual(report.issues, [])
  assert.deepEqual(report.warnings, [])
  applyChanges(report)
  assert.equal(
    snapshot(root)["img/characters/Hero.png"],
    Buffer.from("original image").toString("base64")
  )
  assert.equal(fs.readFileSync(path.join(root, "data/Actors.json"), "utf8"), encoded)
})

void test("static filename initialization survives extraction without unrelated plugin setup", async (t) => {
  const code = `
    function Resources() { this.initialize.apply(this, arguments); }
    Resources.prototype.initialize = function() { throw new Error('gameplay constructor'); };
    Resources.rendering = unavailableRenderer;
    DataManager._databaseFiles.push({ name: '$extra', src: Resources.PATH });
    (function() {
      const previous = DataManager.loadDataFile;
      DataManager.loadDataFile = function(name, src) {
        if (src === 'Actors.json') src = Resources.PATH;
        previous.call(this, name, src);
      };
    })();
    Resources['PATH'] = 'Actual.json';`
  const root = fixture(t, code, "redirected database")
  fs.writeFileSync(
    path.join(root, "data/Actual.json"),
    JSON.stringify([null, { characterName: "Hero" }])
  )
  const before = snapshot(root)
  const report = await inspectGame(root, { decode: decodeTrustedGame })
  assert.deepEqual(report.issues, [])
  assert.deepEqual(report.warnings, [])
  assert.equal(report.decoded, 1)
  assert.deepEqual(snapshot(root), before)
  applyChanges(report)
  assert.equal(
    snapshot(root)["img/characters/Hero.png"],
    Buffer.from("original image").toString("base64")
  )
  assert.equal(fs.readFileSync(path.join(root, "data/Actors.json"), "utf8"), "redirected database")
})

void test("ambiguous static state and outer arguments cannot silently change decoded resources", async (t) => {
  const loader = `DataManager.loadDataFile = function() { DataManager.onLoad([{characterName: Resources.PATH}]); };`
  for (const setup of [
    `Resources.PATH = 'Hero'; Resources.PATH = 'Wrong';`,
    `if (true) Resources.PATH = 'Hero';`,
    `Resources.PATH = 'Hero'; Resources[key] = 'Wrong';`,
    `Resources.PATH = 'Hero'; delete Resources.PATH;`,
    `Resources.PATH = 'Hero'; Resources.PATH += 'Wrong';`,
    `Resources.PATH = 'Hero'; const alias = Resources; alias.PATH = 'Wrong';`,
    `Resources.PATH = 'Hero'; Object.defineProperty(Resources, 'PATH', {value:'Wrong'});`,
    `Resources.PATH = 'Hero'; Resources.configure();`,
    `Resources.PATH = {name:'Hero'};`,
    `function configure() { Resources.PATH = 'Hero'; } configure();`
  ]) {
    const root = fixture(t, `function Resources(){} ${setup} ${loader}`, "encoded")
    const before = snapshot(root)
    const report = await inspectGame(root, { decode: decodeTrustedGame })
    assert.equal(report.decoded, 0, setup)
    assert.equal(isBlocked(report), true, setup)
    assert.throws(() => applyChanges(report), /blocked/)
    assert.deepEqual(snapshot(root), before)
  }
  for (const code of [
    `DataManager.loadDataFile = () => DataManager.onLoad(arguments[0]);`,
    `(function(){ DataManager.loadDataFile = () => DataManager.onLoad(arguments[0]); })();`
  ]) {
    const root = fixture(t, code, "encoded")
    const report = await inspectGame(root, { decode: decodeTrustedGame })
    assert.equal(report.decoded, 0)
    assert.equal(isBlocked(report), true)
  }
})

void test("CLI does not execute loaders without explicit trusted-code authorization", (t) => {
  const { code, encoded } = encryptedLoader()
  const root = fixture(t, code, encoded)
  const command = ["--import", "tsx", "src/cli.ts", root, "--check", "--no-color"]
  const before = snapshot(root)
  const ordinary = spawnSync(process.execPath, command, { encoding: "utf8" })
  assert.equal(ordinary.status, 1, ordinary.stderr)
  assert.ok(!ordinary.stdout.includes("hero.PNG →"))
  const trusted = spawnSync(process.execPath, [...command, "--trust"], {
    encoding: "utf8"
  })
  assert.equal(trusted.status, 1, trusted.stderr)
  assert.match(trusted.stdout, /hero\.PNG.*Hero\.png/)
  assert.match(trusted.stderr, /NOT a security sandbox/)
  assert.ok(!trusted.stdout.includes("\x1b"))
  assert.deepEqual(snapshot(root), before)
  const repaired = spawnSync(
    process.execPath,
    command.filter((arg) => arg !== "--check").concat("--trust"),
    { encoding: "utf8" }
  )
  assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr)
  const clean = spawnSync(process.execPath, [...command, "--trust"], {
    encoding: "utf8"
  })
  assert.equal(clean.status, 0, clean.stdout + clean.stderr)
})

void test("trusted CLI repair waits for readable HTML then renames actual files", (t) => {
  const { code, encoded } = encryptedLoader()
  const root = fixture(t, code, encoded)
  const entry = path.join(root, "index.html")
  const html = fs.readFileSync(entry, "utf8") + '<link rel="stylesheet" href="styles/Game.css">'
  fs.mkdirSync(path.join(root, "styles"))
  fs.writeFileSync(path.join(root, "styles/game.CSS"), "body { color: red; }")
  fs.writeFileSync(entry, html + "<style>.broken {</style>")
  const before = snapshot(root)
  const command = ["--import", "tsx", "src/cli.ts", root, "--trust", "--no-color"]
  const blocked = spawnSync(process.execPath, command, { encoding: "utf8" })
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr)
  assert.deepEqual(snapshot(root), before)

  fs.writeFileSync(entry, html)
  const expected = snapshot(root)
  for (const [old, target] of [
    ["img/characters/hero.PNG", "img/characters/Hero.png"],
    ["styles/game.CSS", "styles/Game.css"]
  ]) {
    expected[target] = expected[old]
    delete expected[old]
  }
  const repaired = spawnSync(process.execPath, command, { encoding: "utf8" })
  assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr)
  assert.deepEqual(snapshot(root), expected)
  const clean = spawnSync(process.execPath, [...command, "--check"], { encoding: "utf8" })
  assert.equal(clean.status, 0, clean.stdout + clean.stderr)
  assert.deepEqual(snapshot(root), expected)
})

void test("unsupported mutable dependencies are rejected instead of guessing decryption", async (t) => {
  const code = `(function(){ let key='a'; key='b'; DataManager.loadDataFile=function(name){ DataManager.onLoad(JSON.parse(key)); }; })();`
  const root = fixture(t, code, "encrypted")
  const before = snapshot(root)
  const report = await inspectGame(root, { decode: decodeTrustedGame })
  assert.equal(isBlocked(report), true)
  assert.ok(report.issues.some((issue) => issue.detail.includes("mutable external dependency")))
  assert.throws(() => applyChanges(report), /blocked/)
  assert.deepEqual(snapshot(root), before)
})

void test("VM data reads reject traversal instead of exposing files outside game input", async (t) => {
  const code = `DataManager.loadDataFile=function(name){ const xhr=new XMLHttpRequest(); xhr.open('GET','../outside.json'); xhr.onload=()=>DataManager.onLoad(JSON.parse(xhr.responseText)); xhr.send(); };`
  const root = fixture(t, code, "encrypted")
  const report = await inspectGame(root, { decode: decodeTrustedGame })
  assert.equal(report.decoded, 0)
  assert.ok(report.issues.some((issue) => /Unsafe local URL/.test(issue.detail)))
})

void test(
  "VM initialization timeout becomes a blocking diagnostic and leaves bytes unchanged",
  { timeout: 15_000 },
  async (t) => {
    const code = `(() => { const key=(()=>{while(true) {}})(); DataManager.loadDataFile=function(){ DataManager.onLoad(key); }; })();`
    const root = fixture(t, code, "encrypted")
    const before = snapshot(root)
    const report = await inspectGame(root, { decode: decodeTrustedGame })
    assert.equal(isBlocked(report), true)
    assert.ok(report.issues.some((issue) => /timed out/.test(issue.detail)))
    assert.deepEqual(snapshot(root), before)
  }
)

void test("conditional and parameter-dependent loader registration is not silently flattened", () => {
  for (const code of [
    `if (enabled) DataManager.loadDataFile=function(){};`,
    `(function(key){DataManager.loadDataFile=function(){return key};})('a');`
  ]) {
    const result = extractLoaders(code, "plugin.js")
    assert.deepEqual(result.code, [])
    assert.equal(result.rejected.length, 1)
  }
})
