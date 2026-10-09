import assert from "node:assert/strict"
import test from "node:test"
import { discoverData } from "../src/data.js"
import type { Engine } from "../src/references.js"

function paths(
  value: unknown,
  source: string,
  engine: Engine = "MV",
  system: Record<string, unknown> = {}
): Set<string> {
  return new Set(discoverData(value, source, engine, system).flatMap((ref) => ref.paths))
}

function command(code: number, ...parameters: unknown[]): { code: number; parameters: unknown[] } {
  return { code, parameters }
}

function audioPaths(folder: string, ...names: string[]): string[] {
  return names.flatMap((name) => [`audio/${folder}/${name}.ogg`, `audio/${folder}/${name}.m4a`])
}

void test("actors and enemies use their stock image folders, independent of filename case", () => {
  assert.deepEqual(
    paths(
      [null, { characterName: "Hero", faceName: "Portrait", battlerName: "Fighter" }],
      "data/ACTORS.JSON"
    ),
    new Set(["img/characters/Hero.png", "img/faces/Portrait.png", "img/sv_actors/Fighter.png"])
  )
  const enemies = [null, { battlerName: "Slime" }]
  assert.deepEqual(paths(enemies, "data/Enemies.json"), new Set(["img/enemies/Slime.png"]))
  assert.deepEqual(
    paths(enemies, "data/Enemies.json", "MV", { optSideView: true }),
    new Set(["img/sv_enemies/Slime.png"])
  )
})

void test("system resources include alternative audio formats and only MZ fonts", () => {
  const system = {
    title1Name: "Sky",
    title2Name: "Logo",
    battleback1Name: "Grass",
    battleback2Name: "Forest",
    battleBgm: { name: "Battle" },
    titleBgm: { name: "Title" },
    defeatMe: { name: "Defeat" },
    victoryMe: { name: "Victory" },
    gameoverMe: { name: "Gameover" },
    sounds: [null, { name: "Cursor" }, { name: "" }],
    boat: { characterName: "Vehicle", bgm: { name: "Sailing" } },
    ship: null,
    airship: {},
    advanced: { mainFontFilename: "Main.ttf", numberFontFilename: "Digits.woff" }
  }
  const refs = discoverData(system, "data/System.json", "MZ", system)
  assert.deepEqual(
    new Set(refs.flatMap((ref) => ref.paths)),
    new Set([
      "img/titles1/Sky.png",
      "img/titles2/Logo.png",
      "img/battlebacks1/Grass.png",
      "img/battlebacks2/Forest.png",
      "img/characters/Vehicle.png",
      "fonts/Main.ttf",
      "fonts/Digits.woff",
      ...audioPaths("bgm", "Battle", "Title", "Sailing"),
      ...audioPaths("me", "Defeat", "Victory", "Gameover"),
      ...audioPaths("se", "Cursor")
    ])
  )
  assert.deepEqual(
    refs.find((ref) => ref.paths.includes("audio/bgm/Battle.ogg")),
    {
      paths: audioPaths("bgm", "Battle"),
      source: "data/System.json.battleBgm",
      required: true,
      encrypted: true
    }
  )
  assert.equal(paths(system, "data/System.json").has("fonts/Main.ttf"), false)
})

void test("tilesets and both animation formats retain MV fallback resources in MZ", () => {
  assert.deepEqual(
    paths([null, { tilesetNames: ["", "Outdoor", null] }], "data/Tilesets.json"),
    new Set(["img/tilesets/Outdoor.png"])
  )
  const animations = [
    null,
    {
      animation1Name: "Flash",
      animation2Name: "",
      effectName: "Burst",
      timings: [null, { se: { name: "OldSound" } }],
      soundTimings: [null, { se: { name: "NewSound" } }]
    }
  ]
  const mv = new Set(["img/animations/Flash.png", ...audioPaths("se", "OldSound")])
  assert.deepEqual(paths(animations, "data/Animations.json"), mv)
  assert.deepEqual(
    paths(animations, "data/Animations.json", "MZ"),
    new Set([...mv, "effects/Burst.efkefc", ...audioPaths("se", "NewSound")])
  )
})

void test("nested map pages and routes use exact event parameter indexes", () => {
  const route = {
    list: [
      null,
      command(41, "Walker", 2),
      command(44, { name: "Step" }),
      command(231, 1, "NotARoutePicture")
    ]
  }
  const events = [
    command(101, "TalkFace", 0),
    command(231, 7, "Portrait", 0),
    command(322, 1, "NewHero", 2, "NewFace", 3, "NewBattler"),
    command(323, 2, "NewBoat", 1),
    command(283, "Floor", "Wall"),
    command(284, "Clouds", true),
    command(261, "Intro"),
    command(205, -1, route),
    command(41, "NotAnEventCharacter"),
    command(44, { name: "NotAnEventSound" })
  ]
  const map = {
    parallaxName: "Stars",
    battleback1Name: "Base",
    battleback2Name: "Back",
    bgm: { name: "MapTheme" },
    bgs: { name: "Wind" },
    events: [
      null,
      { pages: [null, { image: { characterName: "Guard" }, moveRoute: route, list: events }] }
    ]
  }
  const refs = discoverData(map, "data/Map012.json", "MV", {})
  assert.deepEqual(
    new Set(refs.flatMap((ref) => ref.paths)),
    new Set([
      "img/parallaxes/Stars.png",
      "img/parallaxes/Clouds.png",
      "img/battlebacks1/Base.png",
      "img/battlebacks1/Floor.png",
      "img/battlebacks2/Back.png",
      "img/battlebacks2/Wall.png",
      "img/faces/TalkFace.png",
      "img/faces/NewFace.png",
      "img/pictures/Portrait.png",
      "img/characters/Guard.png",
      "img/characters/Walker.png",
      "img/characters/NewHero.png",
      "img/characters/NewBoat.png",
      "img/sv_actors/NewBattler.png",
      ...audioPaths("se", "Step"),
      ...audioPaths("bgm", "MapTheme"),
      ...audioPaths("bgs", "Wind"),
      "movies/Intro.webm",
      "movies/Intro.mp4"
    ])
  )
  assert.deepEqual(
    refs.find((ref) => ref.paths.includes("movies/Intro.webm")),
    {
      paths: ["movies/Intro.webm", "movies/Intro.mp4"],
      source: "data/Map012.json.events[1].pages[1].list[6].parameters[0]",
      required: true,
      encrypted: false
    }
  )
  const filtered = paths(
    { ...map, specifyBattleback: false, autoplayBgm: false, autoplayBgs: false },
    "data/mAp012.JSON"
  )
  for (const path of [
    "img/battlebacks1/Base.png",
    "img/battlebacks2/Back.png",
    "audio/bgm/MapTheme.ogg",
    "audio/bgs/Wind.ogg"
  ]) {
    assert.equal(filtered.has(path), false)
  }
  assert.equal(filtered.has("img/battlebacks1/Floor.png"), true)
})

void test("common events and troop pages share the full event audio opcode table", () => {
  const opcodes: readonly (readonly [number, string])[] = [
    [132, "bgm"],
    [133, "me"],
    [139, "me"],
    [241, "bgm"],
    [245, "bgs"],
    [249, "me"],
    [250, "se"]
  ]
  const events = opcodes.map(([code]) => command(code, { name: `Sound${code}` }))
  events.push(command(140, 2, { name: "VehicleBgm" }))
  const expected = new Set([
    ...opcodes.flatMap(([code, folder]) => audioPaths(folder, `Sound${code}`)),
    ...audioPaths("bgm", "VehicleBgm")
  ])
  assert.deepEqual(paths([null, { list: events }], "data/CommonEvents.json"), expected)
  assert.deepEqual(paths([null, { pages: [{ list: events }] }], "data/Troops.json"), expected)
})

void test("joined 355/655 lines and move-route scripts discover actual resources", () => {
  const events = [
    command(355, "ImageManager.loadPicture("),
    command(655, "'Static');"),
    command(205, -1, { list: [command(45, "AudioManager.playSe({name:'Step'});")] }),
    command(655, "ImageManager.loadFace('Standalone');")
  ]
  const refs = discoverData([null, { list: events }], "data/CommonEvents.json", "MV", {})
  assert.deepEqual(
    new Set(refs.flatMap((ref) => ref.paths)),
    new Set(["img/pictures/Static.png", "img/faces/Standalone.png", ...audioPaths("se", "Step")])
  )
  assert.ok(
    refs
      .find((ref) => ref.paths.includes("img/pictures/Static.png"))
      ?.source.startsWith("data/CommonEvents.json[1].list[0].script")
  )
})

void test("notes and plugin commands accept explicit paths but never infer bare names", () => {
  const common = [
    null,
    {
      note: "img/pictures/Note.png",
      list: [
        command(356, "img/pictures/Legacy.png"),
        command(356, "ShowPicture Bare"),
        command(357, "Plugin", "Command", "Label", {
          path: "img/pictures/Modern.png",
          bare: "Guess"
        })
      ]
    }
  ]
  assert.deepEqual(
    paths(common, "data/CommonEvents.json"),
    new Set(["img/pictures/Note.png", "img/pictures/Legacy.png", "img/pictures/Modern.png"])
  )
  assert.deepEqual(
    paths(
      { note: "img/pictures/Map.png", events: [null, { note: "img/pictures/Event.png" }] },
      "data/Map001.json"
    ),
    new Set(["img/pictures/Map.png", "img/pictures/Event.png"])
  )
})

void test("malformed/null values and unknown schemas are ignored without filename inference", () => {
  for (const value of [
    null,
    "text",
    {},
    [
      null,
      1,
      {
        list: [null, {}, command(322), { code: [], parameters: [] }, { code: true, parameters: [] }]
      }
    ]
  ]) {
    assert.deepEqual(paths(value, "data/CommonEvents.json"), new Set())
  }
  const arbitrary = [
    {
      characterName: "NotAnActor",
      battlerName: "NotAnEnemy",
      bgm: { name: "NotMusic" },
      note: "img/pictures/Unrelated.png"
    }
  ]
  for (const source of [
    "data/PluginSettings.json",
    "data/MapInfos.json",
    "data/MyActors.json",
    "data/MapCustom.json",
    "data/toString.json"
  ]) {
    assert.deepEqual(paths(arbitrary, source), new Set())
  }
  assert.deepEqual(paths([{ ...arbitrary[0], note: "" }], "data/Items.json"), new Set())
  assert.deepEqual(
    paths([null, { characterName: "", faceName: null, battlerName: 4 }], "data/Actors.json"),
    new Set()
  )
  assert.deepEqual(
    paths(
      {
        events: [
          null,
          {
            pages: [
              null,
              4,
              { image: null, moveRoute: [], list: [null, [], command(357, "p", "c", "l", [])] }
            ]
          }
        ]
      },
      "data/Map001.json"
    ),
    new Set()
  )
})
