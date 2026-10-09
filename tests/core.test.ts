import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test, type TestContext } from "node:test"
import { applyChanges, DATABASES, FileIndex, inspectGame, isBlocked } from "../src/core.js"
import type { Engine } from "../src/references.js"

function put(root: string, name: string, content: string | Buffer = "asset bytes"): string {
  const filename = path.join(root, name)
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, content)
  return filename
}
function database(root: string, name: string, value: unknown): void {
  put(root, `data/${name}.json`, JSON.stringify(value))
}
function game(context: TestContext, engine: Engine = "MV", encrypted = false): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rmgaf-core-"))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const core = engine === "MV" ? "rpg_core" : "rmmz_core"
  put(
    root,
    "index.html",
    `<script src="js/${core}.js"></script><link rel="icon" href="icon/icon.png">`
  )
  put(root, `js/${core}.js`, "")
  put(root, "icon/icon.png")
  for (const name of DATABASES) database(root, name, [])
  database(root, "System", { hasEncryptedImages: encrypted, hasEncryptedAudio: encrypted })
  return fs.realpathSync(root)
}
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {}
  const index = new FileIndex(root)
  for (const [name, directory] of index.entries)
    if (!directory) result[name] = fs.readFileSync(path.join(root, name)).toString("base64")
  return result
}

for (const [engine, imageExtension, audioExtension] of [
  ["MV", ".rpgmvp", ".rpgmvo"],
  ["MZ", ".png_", ".ogg_"]
] as const) {
  void test(`${engine} encrypted assets and directory casing preserve bytes`, async (context) => {
    const root = game(context, engine, true)
    database(root, "Actors", [null, { characterName: "Hero" }])
    database(root, "System", {
      hasEncryptedImages: true,
      hasEncryptedAudio: true,
      titleBgm: { name: "Theme" }
    })
    put(root, "IMG/Characters/hero" + imageExtension.toUpperCase(), "encrypted-image")
    put(root, "audio/bgm/theme" + audioExtension.toUpperCase(), "encrypted-audio")
    const before = snapshot(root)
    const report = await inspectGame(root)
    assert.deepEqual(snapshot(root), before)
    assert.deepEqual(report.issues, [])
    assert.ok(applyChanges(report) > 0)
    assert.equal(
      fs.readFileSync(path.join(root, "img/characters/Hero" + imageExtension), "utf8"),
      "encrypted-image"
    )
    assert.equal(
      fs.readFileSync(path.join(root, "audio/bgm/Theme" + audioExtension), "utf8"),
      "encrypted-audio"
    )
    assert.ok(!fs.readdirSync(root).includes("IMG"))
    assert.equal(snapshot(root)["icon/icon.png"], before["icon/icon.png"])
    assert.deepEqual((await inspectGame(root)).changes, [])
  })
}

void test("conflicting consumers abort every repair", async (context) => {
  const root = game(context)
  database(root, "Actors", [null, { characterName: "Hero" }, { characterName: "hero" }])
  database(root, "CommonEvents", [null, { list: [{ code: 101, parameters: ["Face"] }] }])
  put(root, "img/characters/HERO.png")
  put(root, "img/faces/face.png")
  const before = snapshot(root)
  const report = await inspectGame(root)
  assert.ok(
    report.issues.some((issue) => issue.kind === "conflict" && issue.path.endsWith("HERO.png"))
  )
  assert.ok(report.changes.some((change) => change.new.endsWith("Face.png")))
  assert.throws(() => applyChanges(report), /blocked/)
  assert.deepEqual(snapshot(root), before)
})

void test("directory component spelling conflicts abort unrelated repairs", async (context) => {
  const root = game(context)
  put(
    root,
    "index.html",
    '<script src="js/rpg_core.js"></script><img src="IMG/characters/Hero.png">'
  )
  database(root, "Actors", [null, { characterName: "Hero", faceName: "Face" }])
  put(root, "img/characters/Hero.png")
  put(root, "img/faces/face.png")
  const report = await inspectGame(root)
  assert.ok(report.issues.some((issue) => issue.kind === "conflict" && issue.path === "img"))
  const before = snapshot(root)
  assert.throws(() => applyChanges(report), /blocked/)
  assert.deepEqual(snapshot(root), before)
})

void test("missing resources do not hide safe repairs", async (context) => {
  const root = game(context)
  database(root, "Actors", [null, { characterName: "Hero", faceName: "Absent" }])
  put(root, "img/characters/hero.png")
  const report = await inspectGame(root)
  assert.deepEqual(
    report.issues.map((issue) => [issue.kind, issue.path]),
    [["missing", "img/faces/Absent.png"]]
  )
  assert.equal(isBlocked(report), false)
  applyChanges(report)
  assert.equal(fs.readFileSync(path.join(root, "img/characters/Hero.png"), "utf8"), "asset bytes")
  assert.equal(fs.existsSync(path.join(root, "img/faces/Absent.png")), false)
})

void test("MZ maps effects fonts and enabled plugin parameters are discovered", async (context) => {
  const root = game(context, "MZ")
  database(root, "MapInfos", [null, { id: 2 }])
  database(root, "map002", {
    events: [null, { pages: [{ list: [{ code: 231, parameters: [1, "MapArt"] }] }] }]
  })
  database(root, "Animations", [null, { effectName: "Spark" }])
  database(root, "System", { advanced: { mainFontFilename: "Main.ttf" } })
  put(root, "effects/spark.efkefc")
  put(root, "fonts/main.ttf")
  put(root, "img/pictures/mapart.png")
  put(root, "img/pictures/extra.png")
  put(
    root,
    "js/plugins.js",
    'var $plugins = [{"name":"Show","status":true,"parameters":{"Picture":"Extra"}},{"name":"Disabled","status":false,"parameters":{"Picture":"img/pictures/EXTRA.png"}}];'
  )
  put(
    root,
    "js/plugins/show.js",
    "/*:\n * @param Picture\n * @type file\n * @dir img/pictures/\n */"
  )
  put(root, "js/plugins/Disabled.js", 'ImageManager.loadPicture("Missing");')
  const report = await inspectGame(root)
  assert.deepEqual(report.issues, [])
  applyChanges(report)
  const files = snapshot(root)
  for (const name of [
    "data/Map002.json",
    "effects/Spark.efkefc",
    "fonts/Main.ttf",
    "js/plugins/Show.js",
    "img/pictures/MapArt.png",
    "img/pictures/Extra.png"
  ])
    assert.ok(Object.hasOwn(files, name), name)
  assert.deepEqual((await inspectGame(root)).changes, [])
})

void test("requested CSS directory spelling controls relative URL discovery", async (context) => {
  const root = game(context)
  put(
    root,
    "index.html",
    '<script src="js/rpg_core.js"></script><link rel="stylesheet" href="fonts/Game.css">'
  )
  put(root, "Fonts/game.css", '@font-face { src: url("Main.ttf"); }')
  put(root, "Fonts/main.TTF", "font")
  const report = await inspectGame(root)
  assert.deepEqual(report.issues, [])
  applyChanges(report)
  assert.equal(fs.readFileSync(path.join(root, "fonts/Main.ttf"), "utf8"), "font")
  assert.ok(fs.readdirSync(path.join(root, "fonts")).includes("Game.css"))
})

void test("browser images and MV ignored images bypass encryption", async (context) => {
  const root = game(context, "MV", true)
  put(root, "index.html", '<script src="js/rpg_core.js"></script><img src="img/ui/Browser.png">')
  put(root, "img/ui/browser.PNG")
  put(
    root,
    "js/rpg_core.js",
    'Decrypter._ignoreList = ["img/system/Window.png"]; ImageManager.loadSystem("Window");'
  )
  put(root, "img/system/window.PNG")
  const report = await inspectGame(root)
  assert.deepEqual(report.issues, [])
  applyChanges(report)
  assert.ok(Object.hasOwn(snapshot(root), "img/ui/Browser.png"))
  assert.ok(Object.hasOwn(snapshot(root), "img/system/Window.png"))
})

void test("symlink resources and invalid JSON prevent writes", async (context) => {
  const root = game(context)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rmgaf-outside-"))
  context.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  put(outside, "hero.png", "untouched")
  fs.mkdirSync(path.join(root, "img"))
  fs.symlinkSync(outside, path.join(root, "img/characters"), "dir")
  database(root, "Actors", [null, { characterName: "Hero" }])
  put(root, "data/Map001.json", "not JSON")
  const report = await inspectGame(root)
  assert.deepEqual(new Set(report.issues.map((issue) => issue.kind)), new Set(["unsafe", "error"]))
  assert.throws(() => applyChanges(report), /blocked/)
  assert.equal(fs.readFileSync(path.join(outside, "hero.png"), "utf8"), "untouched")
})

void test("failure on destination hop rolls back completed operations and temporary files", async (context) => {
  const root = game(context)
  database(root, "Actors", [null, { characterName: "Hero", faceName: "Face" }])
  put(root, "img/characters/hero.png", "hero")
  put(root, "img/faces/face.png", "face")
  const report = await inspectGame(root)
  const before = snapshot(root)
  const rename = fs.renameSync
  let calls = 0
  const mock = context.mock.method(
    fs,
    "renameSync",
    (source: fs.PathLike, destination: fs.PathLike) => {
      calls++
      if (calls === 4) throw new Error("filesystem refused rename")
      rename(source, destination)
    }
  )
  assert.throws(() => applyChanges(report), /filesystem refused rename/)
  mock.mock.restore()
  assert.deepEqual(snapshot(root), before)
  assert.ok(![...new FileIndex(root).entries.keys()].some((name) => name.includes(".rmgaf-")))
})

void test("preflight rejects changed sources and destination collisions before writes", async (context) => {
  const root = game(context)
  database(root, "Actors", [null, { characterName: "Hero", faceName: "Face" }])
  put(root, "img/characters/hero.png")
  put(root, "img/faces/face.png")
  const report = await inspectGame(root)
  fs.unlinkSync(path.join(root, "img/faces/face.png"))
  const before = snapshot(root)
  assert.throws(() => applyChanges(report), /Source changed/)
  assert.deepEqual(snapshot(root), before)
})

void test("case-colliding files never overwrite either entry on sensitive hosts", async (context) => {
  const root = game(context)
  database(root, "Actors", [null, { characterName: "Hero" }])
  put(root, "img/characters/Hero.png", "one")
  if (fs.existsSync(path.join(root, "img/characters/hero.png"))) {
    context.skip("requires case-sensitive filesystem")
    return
  }
  put(root, "img/characters/hero.png", "two")
  const before = snapshot(root)
  const report = await inspectGame(root)
  assert.ok(isBlocked(report))
  assert.throws(() => applyChanges(report), /blocked/)
  assert.deepEqual(snapshot(root), before)
})

void test("decoder recovers unknown objects before System-dependent discovery in one call", async (context) => {
  const root = game(context, "MZ")
  for (const name of ["System", "Actors", "CommonEvents"])
    put(root, `data/${name}.json`, `compressed-${name}`)
  put(root, "data/extradb.json", "{}")
  put(root, "img/characters/hero.PNG_")
  put(root, "img/pictures/bonus.PNG_")
  let calls = 0
  const before = snapshot(root)
  const report = await inspectGame(root, {
    decode: async (directory, files) => {
      calls++
      assert.equal(directory, root)
      assert.deepEqual([...files].sort(), [
        "data/Actors.json",
        "data/CommonEvents.json",
        "data/System.json"
      ])
      return {
        data: new Map<string, unknown>([
          ["data/System.json", { hasEncryptedImages: true }],
          ["data/Actors.json", [null, { characterName: "Hero" }]],
          ["data/CommonEvents.json", [null, { list: [{ code: 231, parameters: [1, "Bonus"] }] }]]
        ]),
        errors: new Map(),
        loaders: ["js/plugins/Decode.js"],
        requests: ["data/ExtraDB.json"]
      }
    }
  })
  assert.equal(calls, 1)
  assert.equal(report.decoded, 3)
  assert.deepEqual(report.loaders, ["js/plugins/Decode.js"])
  assert.deepEqual(report.issues, [])
  assert.ok(report.changes.some((change) => change.new === "data/ExtraDB.json"))
  assert.ok(report.changes.some((change) => change.new.endsWith("Hero.png_")))
  assert.ok(report.changes.some((change) => change.new.endsWith("Bonus.png_")))
  assert.deepEqual(snapshot(root), before)
  applyChanges(report)
  assert.equal(
    fs.readFileSync(path.join(root, "data/CommonEvents.json"), "utf8"),
    "compressed-CommonEvents"
  )
})

void test("partial decoder errors are preserved and prevent repair", async (context) => {
  const root = game(context)
  put(root, "data/Actors.json", "packed actors")
  put(root, "data/System.json", "packed system")
  put(root, "img/characters/hero.png")
  const report = await inspectGame(root, {
    decode: async () => ({
      data: new Map<string, unknown>([["data/Actors.json", [null, { characterName: "Hero" }]]]),
      errors: new Map([["data/System.json", "loader rejected System"]]),
      loaders: ["decode.js"],
      requests: []
    })
  })
  assert.equal(report.decoded, 1)
  assert.ok(
    report.issues.some(
      (issue) => issue.path === "data/System.json" && issue.detail === "loader rejected System"
    )
  )
  assert.ok(report.changes.some((change) => change.new.endsWith("Hero.png")))
  assert.throws(() => applyChanges(report), /blocked/)
})

void test("decoder throw leaves unreadable inputs as errors rather than success", async (context) => {
  const root = game(context)
  put(root, "data/Actors.json", "packed actors")
  const report = await inspectGame(root, {
    decode: async () => {
      throw new Error("decoder exploded")
    }
  })
  assert.equal(report.decoded, 0)
  assert.ok(
    report.issues.some(
      (issue) =>
        issue.kind === "error" &&
        issue.path === "data/Actors.json" &&
        issue.detail.includes("decoder exploded")
    )
  )
  assert.throws(() => applyChanges(report), /blocked/)
})

void test("plaintext-only games do not invoke decoder and bootstrap libraries are not parsed", async (context) => {
  const root = game(context)
  put(
    root,
    "index.html",
    '<script src="js/libs/Library.js"></script><script src="js/rpg_core.js"></script>'
  )
  put(root, "js/libs/library.js", 'ImageManager.loadPicture("NotAResource");')
  put(root, "node_modules/dependency/data/Actors.json", "bad JSON")
  put(root, ".yarn/cache/data/System.json", "bad JSON")
  const report = await inspectGame(root, {
    decode: async () => {
      throw new Error("unexpected decoder invocation")
    }
  })
  assert.deepEqual(report.issues, [])
  assert.equal(report.decoded, 0)
  assert.ok(report.changes.some((change) => change.new === "js/libs/Library.js"))
})

void test("byte-identical unknown backup warns without claiming a recovered file", async (context) => {
  const root = game(context)
  put(root, "data/Actors.json", "packed actors")
  put(root, "data/Actors..json", "packed actors")
  put(root, "img/characters/hero.png")
  const report = await inspectGame(root, {
    decode: async () => ({
      data: new Map<string, unknown>([["data/Actors.json", [null, { characterName: "Hero" }]]]),
      errors: new Map([["data/Actors..json", "unknown schema"]]),
      loaders: [],
      requests: [],
      warnings: ["unsupported loader hook"]
    })
  })
  assert.equal(report.decoded, 1)
  assert.deepEqual(report.issues, [])
  assert.deepEqual(report.warnings, [
    "unsupported loader hook",
    "Duplicate unrecognized database data/Actors..json matches data/Actors.json; scanning canonical data"
  ])
  applyChanges(report)
  assert.equal(fs.readFileSync(path.join(root, "data/Actors..json"), "utf8"), "packed actors")
})

void test("known databases and nonidentical backups retain decoder failures", async (context) => {
  const root = game(context)
  put(root, "data/Actors.json", "packed actors")
  put(root, "data/Classes.json", "packed actors")
  put(root, "data/Actors..json", "packed actors ")
  const report = await inspectGame(root, {
    decode: async () => ({
      data: new Map<string, unknown>([["data/Actors.json", [null, { characterName: "Hero" }]]]),
      errors: new Map([
        ["data/Classes.json", "known database failed"],
        ["data/Actors..json", "different bytes"]
      ]),
      loaders: [],
      requests: []
    })
  })
  assert.equal(report.decoded, 1)
  assert.deepEqual(report.warnings, [])
  assert.ok(
    report.issues.some(
      (issue) => issue.path === "data/Classes.json" && issue.detail === "known database failed"
    )
  )
  assert.ok(
    report.issues.some(
      (issue) => issue.path === "data/Actors..json" && issue.detail === "different bytes"
    )
  )
  assert.throws(() => applyChanges(report), /blocked/)
})

void test("preflight refuses a source directory replaced by an external symlink", async (context) => {
  const root = game(context)
  database(root, "Actors", [null, { characterName: "Hero" }])
  put(root, "img/characters/hero.png", "original")
  const report = await inspectGame(root)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rmgaf-preflight-"))
  context.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  put(outside, "hero.png", "external")
  fs.rmSync(path.join(root, "img/characters"), { recursive: true })
  fs.symlinkSync(outside, path.join(root, "img/characters"), "dir")
  assert.throws(() => applyChanges(report), /symlink/)
  assert.equal(fs.readFileSync(path.join(outside, "hero.png"), "utf8"), "external")
})

void test("invalid UTF-8 remains unreadable instead of silently replacing asset names", async (context) => {
  const root = game(context)
  put(
    root,
    "data/Actors.json",
    Buffer.concat([
      Buffer.from('[null,{"characterName":"'),
      Buffer.from([0xff]),
      Buffer.from('"}]')
    ])
  )
  const report = await inspectGame(root)
  assert.ok(
    report.issues.some((issue) => issue.kind === "error" && issue.path === "data/Actors.json")
  )
  assert.throws(() => applyChanges(report), /blocked/)
})

void test("decoded System still must be a JSON object", async (context) => {
  const root = game(context)
  put(root, "data/System.json", "packed system")
  const report = await inspectGame(root, {
    decode: async () => ({
      data: new Map<string, unknown>([["data/System.json", []]]),
      errors: new Map(),
      loaders: [],
      requests: []
    })
  })
  assert.equal(report.decoded, 1)
  assert.ok(
    report.issues.some(
      (issue) => issue.path === "data/System.json" && issue.detail === "Expected a JSON object"
    )
  )
  assert.throws(() => applyChanges(report), /blocked/)
})

void test("legacy JS comments do not hide resources or change source bytes", async (context) => {
  const root = game(context)
  const source = Buffer.concat([
    Buffer.from("// "),
    Buffer.from([0x82, 0xa0]),
    Buffer.from('\nImageManager.loadCharacter("Hero");')
  ])
  const filename = put(root, "js/rpg_core.js", source)
  put(root, "img/characters/hero.png")
  const report = await inspectGame(root)
  assert.deepEqual(report.issues, [])
  assert.deepEqual(
    report.changes.map(({ old, new: target }) => [old, target]),
    [["img/characters/hero.png", "img/characters/Hero.png"]]
  )
  applyChanges(report)
  assert.equal(fs.readFileSync(path.join(root, "img/characters/Hero.png"), "utf8"), "asset bytes")
  assert.deepEqual(fs.readFileSync(filename), source)
})

void test("invalid UTF-8 in JS resource names or plugin metadata still blocks repairs", async (context) => {
  for (const [prefix, suffix] of [
    ['ImageManager.loadCharacter("', '");'],
    ["/*:\n * @param ", "\n * @type file\n */"],
    ["/*~struct~Asset:\n * @param ", "\n * @type file\n */"]
  ]) {
    const root = game(context)
    put(
      root,
      "js/rpg_core.js",
      Buffer.concat([Buffer.from(prefix), Buffer.from([0xff]), Buffer.from(suffix)])
    )
    const before = snapshot(root)
    const report = await inspectGame(root)
    assert.ok(
      report.issues.some((issue) => issue.kind === "error" && issue.path === "js/rpg_core.js")
    )
    assert.throws(() => applyChanges(report), /blocked/)
    assert.deepEqual(snapshot(root), before)
  }
})
