import assert from "node:assert/strict"
import test from "node:test"
import {
  discoverText,
  discoverPluginParameters,
  parsePlugins,
  parseImageIgnores
} from "../src/text.js"
import type { Reference } from "../src/references.js"

// Sorting compares actual candidate paths while retaining alternatives in refs.
function paths(references: readonly Reference[]): string[] {
  return [...new Set(references.flatMap((item) => item.paths))].sort()
}

void test("JavaScript strings, static concatenation, templates and Unicode loads", () => {
  const references = discoverText(
    String.raw`
    ImageManager.loadPicture("魔法\u5c11\u5973");
    ImageManager.reserveCharacter('Hero' + '\x41');
    ImageManager.requestSvActor(\`Actor\`);
    ImageManager.loadBitmap('img/system/', 'Window');
    ImageManager.loadBitmapFromUrl('img/pictures/\u{1f600}.png');
    const path = ('img/pictures/' + '雪.png');
    const paired = 'img/pictures/\uD83D\uDE00.png';
  `.replaceAll("\\`", "`"),
    "js",
    "js/plugins/Test.js"
  )
  assert.deepEqual(
    paths(references),
    [
      "img/pictures/魔法少女.png",
      "img/characters/HeroA.png",
      "img/sv_actors/Actor.png",
      "img/system/Window.png",
      "img/pictures/😀.png",
      "img/pictures/雪.png"
    ].sort()
  )
  assert.ok(
    references.every(
      (item) => !item.required && item.encrypted && item.source.includes("js/plugins/Test.js:")
    )
  )
})

void test("comments, regexes and dynamic expressions do not create references", () => {
  assert.deepEqual(
    discoverText(
      String.raw`
    // ImageManager.loadPicture("Comment");
    /* const path = "img/pictures/Comment.png"; */
    const regex = /ImageManager.loadPicture("Regex")/;
    const dynamic = "img/pictures/Prefix.png" + name;
    const template = \`img/pictures/\${"img/pictures/Nested.png"}.png\`;
    ImageManager.loadPicture("Prefix" + name);
    ImageManager.loadPicture(\`Dynamic\${name}\`);
    ImageManager.loadPicture(name);
  `
        .replaceAll("\\`", "`")
        .replaceAll("\\${", "${"),
      "js",
      "js/Test.js"
    ),
    []
  )
})

void test("audio objects, video and font APIs", () => {
  const references = discoverText(
    `
    AudioManager.createBuffer("bgm", "Theme");
    AudioManager.playSe({name: "Hit", volume: 90});
    AudioManager.playBgm({"name": "Town"});
    AudioManager.playBgs({name: "Rain"});
    AudioManager.playMe({name: "Win"});
    AudioManager.playStaticSe({name: "Click"});
    AudioManager.loadStaticSe({name: "Load"});
    AudioManager.playSe({name: "NotStatic", ...other});
    AudioManager.playSe({name: "Computed", [key]: 1});
    AudioManager.playSe({name: "Shorthand", volume});
    Graphics.playVideo("movies/Intro.webm");
    Video.play("movies/Ending.mp4");
    FontManager.load("main", "Main.ttf");
    Graphics.loadFont("extra", "fonts/Extra.otf");
  `,
    "js",
    "js/main.js"
  )
  const expected = [
    ["bgm", "Theme"],
    ["se", "Hit"],
    ["bgm", "Town"],
    ["bgs", "Rain"],
    ["me", "Win"],
    ["se", "Click"],
    ["se", "Load"]
  ].flatMap(([folder, name]) => [`.ogg`, `.m4a`].map((ext) => `audio/${folder}/${name}${ext}`))
  assert.deepEqual(
    paths(references),
    [
      ...expected,
      "movies/Intro.webm",
      "movies/Ending.mp4",
      "fonts/Main.ttf",
      "fonts/Extra.otf"
    ].sort()
  )
  assert.ok(
    references
      .filter((item) => item.paths[0]?.startsWith("audio/"))
      .every((item) => item.encrypted && item.paths.length === 2)
  )
})

void test("HTML relative resources, entities, embedded code and nonresource links", () => {
  const references = discoverText(
    `
    <!-- <script src="Wrong.js"></script> -->
    <script src="../js/Main.js?v=1"></script>
    <link rel="stylesheet" href="styles/Game.css">
    <link rel="icon" href="../img/Icon%20One.png">
    <a href="help.html">Help</a>
    <img src="https://example.com/External.png">
    <script>ImageManager.loadPicture("Title");</script>
    <script type="application/json">"img/Wrong.png"</script>
    <img src="../img/A&amp;B.png">
    <div style="background:url('../img/Inline.png')"></div>
    <style>.x { background:url('../img/Style.png') }</style>
  `,
    "html",
    "web/index.html"
  )
  assert.deepEqual(
    paths(references),
    [
      "js/Main.js",
      "web/styles/Game.css",
      "img/Icon One.png",
      "img/pictures/Title.png",
      "img/A&B.png",
      "img/Inline.png",
      "img/Style.png"
    ].sort()
  )
  assert.ok(
    references
      .filter((item) => item.paths[0] !== "img/pictures/Title.png")
      .every((item) => item.required)
  )
})

void test("CSS imports, URLs and escapes ignore strings, comments and dynamic values", () => {
  const references = discoverText(
    String.raw`
    /* url("Missing.png") */
    @import "./Theme.css";
    @import url('../Base.css');
    .hero { background: url('../../img/pictures/雪.png?v=2'); }
    .escaped { background: url("../../img/pictures/\96ea .png"); }
    .text { content: "url(Missing.png)"; }
    .remote { background: url(data:image/png;base64,AAA); }
    .dynamic { background: url(var(--image)); }
  `,
    "css",
    "css/themes/Game.css"
  )
  assert.deepEqual(
    paths(references),
    ["css/themes/Theme.css", "css/Base.css", "img/pictures/雪.png"].sort()
  )
  assert.ok(references.every((item) => item.required))
})

void test("paths preserve case, decode once and stay within game origin", () => {
  const references = discoverText(
    `
    <img src="../img/Case%2520Name.png?cache=1#fragment">
    <img src="../../Escape.png">
    <img src="%2fAbsolute.png">
    <img src="%5cWindows.png">
    <img src="%00Null.png">
    <img src="//external.test/Image.png">
    <img src="/Absolute.png">
    <img src="file:Relative.png">
  `,
    "html",
    "web/index.html"
  )
  assert.deepEqual(paths(references), ["img/Case%20Name.png"])
  assert.deepEqual(
    paths(
      discoverText(
        `const path = "IMG/System/Window.rpgmvp"; const audio = "audio/Bgm/Theme.ogg_";`,
        "js",
        "js/main.js"
      )
    ),
    ["IMG/System/Window.rpgmvp", "audio/Bgm/Theme.ogg_"]
  )
})

void test("plugin JSON preserves disabled entries and validates the named boundary", () => {
  const plugins = [
    { name: "Active", status: true, parameters: {} },
    { name: "Disabled", status: false }
  ]
  assert.deepEqual(
    parsePlugins(`// generated\nvar $plugins /* header */ = ${JSON.stringify(plugins)};`),
    plugins
  )
  assert.deepEqual(parsePlugins('// $plugins = broken;\nconst text = "$plugins = []";'), [])
  assert.deepEqual(parsePlugins("$plugins = [] /* generated */;"), [])
  for (const source of [
    "var $plugins = [oops];",
    "var $plugins = {};",
    'var $plugins = [{"name":"A",}];',
    "var $plugins = [] + dynamic;",
    "var $plugins = [] /* comment */ + dynamic;",
    "var $plugins = [] // comment\n + dynamic;",
    "var $plugins = [NaN];",
    "var $plugins = [null];",
    'var $plugins = [{"name":1,"status":true}];',
    'var $plugins = [{"name":"A","status":"true"}];',
    'var $plugins = [{"name":"A"}];',
    'var $plugins = [{"name":"A","status":true,"parameters":[]}];'
  ])
    assert.throws(() => parsePlugins(source), source)
})

void test("file metadata, arrays and nested serialized structs", () => {
  const metadata = `/*:
   * @param Portrait
   * @type file
   * @dir img/pictures/
   * @param Sounds
   * @type file[]
   * @dir audio/se/
   * @param Entries
   * @type struct<Entry>[]
   * @param Bare
   * @type string
   * @param Clip
   * @type file
   * @dir movies
   * @command Run
   * @arg Sound
   * @type file
   * @dir audio/bgm/
   */
   /*~struct~Entry:
   * @param Face
   * @type file
   * @dir img/faces/
   */`
  const plugin = {
    name: "Example",
    status: true,
    parameters: {
      Portrait: "魔法",
      Sounds: JSON.stringify(["Hit", "Click"]),
      Entries: JSON.stringify([JSON.stringify({ Face: "Actor1" })]),
      Bare: "Unrelated",
      Explicit: "img/system/Window.png",
      Clip: "Intro"
    }
  }
  const references = discoverPluginParameters(plugin, metadata, "js/plugins/Example.js")
  assert.deepEqual(
    paths(references),
    [
      "img/pictures/魔法.png",
      "audio/se/Hit.ogg",
      "audio/se/Hit.m4a",
      "audio/se/Click.ogg",
      "audio/se/Click.m4a",
      "img/faces/Actor1.png",
      "img/system/Window.png",
      "movies/Intro.webm",
      "movies/Intro.mp4"
    ].sort()
  )
  assert.ok(references.every((item) => !item.required && item.source.includes("parameter")))
  assert.ok(
    references
      .filter((item) => !item.paths[0]?.startsWith("movies/"))
      .every((item) => item.encrypted)
  )
  assert.deepEqual(
    discoverPluginParameters(
      { name: "Empty", status: true, parameters: { Portrait: "" } },
      metadata,
      "js/P.js"
    ),
    []
  )
  assert.deepEqual(
    discoverPluginParameters(
      { name: "Plain", status: true, parameters: { Portrait: "Ignored" } },
      `const fake = ${JSON.stringify(metadata)};`,
      "js/P.js"
    ),
    []
  )
})

void test("literal image encryption ignore lists never execute expressions", () => {
  assert.deepEqual(
    parseImageIgnores('Decrypter._ignoreList = ["img/system/Window.png", "img/Foo.png"];'),
    ["img/system/Window.png", "img/Foo.png"]
  )
  assert.equal(parseImageIgnores('// Decrypter._ignoreList = ["img/Wrong.png"];'), undefined)
  assert.equal(parseImageIgnores('Decrypter._ignoreList = ["img/" + dynamic];'), undefined)
  assert.equal(parseImageIgnores('Decrypter._ignoreList = ["img/Foo.png", ,];'), undefined)
  assert.deepEqual(parseImageIgnores("Decrypter._ignoreList = [];"), [])
})
