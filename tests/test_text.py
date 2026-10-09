import json

import pytest

from rmgaf.text import (
    discover_plugin_parameters,
    discover_text,
    parse_image_ignores,
    parse_plugins,
)


def paths(references):
    return {path for reference in references for path in reference.paths}


def test_javascript_literals_and_static_image_loads():
    references = discover_text(
        r"""
        ImageManager.loadPicture("魔法\u5c11\u5973");
        ImageManager.reserveCharacter('Hero' + '\x41');
        ImageManager.requestSvActor(`Actor`);
        ImageManager.loadBitmap('img/system/', 'Window');
        ImageManager.loadBitmapFromUrl('img/pictures/\u{1f600}.png');
        const path = ('img/pictures/' + '雪.png');
        const paired = 'img/pictures/\uD83D\uDE00.png';
    """,
        "js",
        "js/plugins/Test.js",
    )
    assert paths(references) == {
        "img/pictures/魔法少女.png",
        "img/characters/HeroA.png",
        "img/sv_actors/Actor.png",
        "img/system/Window.png",
        "img/pictures/😀.png",
        "img/pictures/雪.png",
    }
    assert all(not reference.required for reference in references)
    assert all("js/plugins/Test.js:" in reference.source for reference in references)


def test_javascript_comments_regex_and_dynamic_expressions_are_not_references():
    references = discover_text(
        r"""
        // ImageManager.loadPicture("Comment");
        /* const path = "img/pictures/Comment.png"; */
        const regex = /ImageManager.loadPicture("Regex")/;
        const dynamic = "img/pictures/Prefix.png" + name;
        const template = `img/pictures/${"img/pictures/Nested.png"}.png`;
        ImageManager.loadPicture("Prefix" + name);
        ImageManager.loadPicture(`Dynamic${name}`);
        ImageManager.loadPicture(name);
    """,
        "js",
        "js/Test.js",
    )
    assert references == []


def test_audio_video_font_loads():
    references = discover_text(
        """
        AudioManager.createBuffer("bgm", "Theme");
        AudioManager.playSe({name: "Hit", volume: 90});
        AudioManager.playBgm({"name": "Town"});
        AudioManager.playBgs({name: "Rain"});
        AudioManager.playMe({name: "Win"});
        AudioManager.playStaticSe({name: "Click"});
        AudioManager.playSe({name: "NotStatic", ...other});
        Graphics.playVideo("movies/Intro.webm");
        Video.play("movies/Ending.mp4");
        FontManager.load("main", "Main.ttf");
        Graphics.loadFont("extra", "fonts/Extra.otf");
    """,
        "js",
        "js/main.js",
    )
    assert paths(references) == {
        *(
            f"audio/{folder}/{name}{ext}"
            for folder, name in [
                ("bgm", "Theme"),
                ("se", "Hit"),
                ("bgm", "Town"),
                ("bgs", "Rain"),
                ("me", "Win"),
                ("se", "Click"),
            ]
            for ext in (".ogg", ".m4a")
        ),
        "movies/Intro.webm",
        "movies/Ending.mp4",
        "fonts/Main.ttf",
        "fonts/Extra.otf",
    }


def test_html_resolves_local_resources_and_ignores_nonresource_links():
    references = discover_text(
        """
        <!-- <script src="Wrong.js"></script> -->
        <script src="../js/Main.js?v=1"></script>
        <link rel="stylesheet" href="styles/Game.css">
        <link rel="icon" href="../img/Icon%20One.png">
        <a href="help.html">Help</a>
        <img src="https://example.com/External.png">
        <script>ImageManager.loadPicture("Title");</script>
    """,
        "html",
        "web/index.html",
    )
    assert paths(references) == {
        "js/Main.js",
        "web/styles/Game.css",
        "img/Icon One.png",
        "img/pictures/Title.png",
    }
    assert all(
        reference.required
        for reference in references
        if reference.paths != ("img/pictures/Title.png",)
    )


def test_css_urls_imports_and_escape_resolution():
    references = discover_text(
        r"""
        /* url("Missing.png") */
        @import "./Theme.css";
        @import url('../Base.css');
        .hero { background: url('../../img/pictures/雪.png?v=2'); }
        .escaped { background: url("../../img/pictures/\96ea .png"); }
        .text { content: "url(Missing.png)"; }
        .remote { background: url(data:image/png;base64,AAA); }
        .dynamic { background: url(var(--image)); }
    """,
        "css",
        "css/themes/Game.css",
    )
    assert paths(references) == {
        "css/themes/Theme.css",
        "css/Base.css",
        "img/pictures/雪.png",
    }
    assert all(reference.required for reference in references)


def test_plugin_assignment_json_preserves_activation_and_rejects_malformed_data():
    plugins = [
        {"name": "Active", "status": True, "parameters": {}},
        {"name": "Disabled", "status": False},
    ]
    assert (
        parse_plugins("// generated\nvar $plugins = " + json.dumps(plugins) + ";")
        == plugins
    )
    assert parse_plugins('// $plugins = broken;\nconst text = "$plugins = []";') == []
    for text in [
        "var $plugins = [oops];",
        "var $plugins = {};",
        'var $plugins = [{"name": "A",}];',
        "var $plugins = [] + dynamic;",
    ]:
        with pytest.raises(ValueError):
            parse_plugins(text)


def test_plugin_file_metadata_and_nested_structs():
    metadata = """/*:
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
     * @command Run
     * @arg Sound
     * @type file
     * @dir audio/bgm/
     */
    /*~struct~Entry:
     * @param Face
     * @type file
     * @dir img/faces/
     */"""
    plugin = {
        "parameters": {
            "Portrait": "魔法",
            "Sounds": json.dumps(["Hit", "Click"]),
            "Entries": json.dumps([json.dumps({"Face": "Actor1"})]),
            "Bare": "Unrelated",
            "Explicit": "img/system/Window.png",
        }
    }
    references = discover_plugin_parameters(plugin, metadata, "js/plugins/Example.js")
    assert paths(references) == {
        "img/pictures/魔法.png",
        "audio/se/Hit.ogg",
        "audio/se/Hit.m4a",
        "audio/se/Click.ogg",
        "audio/se/Click.m4a",
        "img/faces/Actor1.png",
        "img/system/Window.png",
    }
    assert all(not reference.required for reference in references)
    assert all("parameter" in reference.source for reference in references)
    assert (
        discover_plugin_parameters(
            {"parameters": {"Portrait": ""}}, metadata, "js/P.js"
        )
        == []
    )


def test_literal_encryption_ignore_list():
    assert parse_image_ignores(
        'Decrypter._ignoreList = ["img/system/Window.png", "img/Foo.png"];'
    ) == [
        "img/system/Window.png",
        "img/Foo.png",
    ]
    assert parse_image_ignores('// Decrypter._ignoreList = ["img/Wrong.png"];') is None
    assert parse_image_ignores('Decrypter._ignoreList = ["img/" + dynamic];') is None
    assert parse_image_ignores("Decrypter._ignoreList = [];") == []
