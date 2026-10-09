import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from rmgaf import core


def put(root: Path, name: str, content=b"asset bytes"):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content.encode() if isinstance(content, str) else content)
    return path


def database(root, name, value):
    return put(root, f"data/{name}.json", json.dumps(value, ensure_ascii=False))


def game(root, engine="MV", encrypted=False):
    core_name = "rpg_core" if engine == "MV" else "rmmz_core"
    put(
        root,
        "index.html",
        f'<script src="js/{core_name}.js"></script><link rel="icon" href="icon/icon.png">',
    )
    put(root, f"js/{core_name}.js", "")
    put(root, "icon/icon.png")
    for name in core.DATABASES:
        database(root, name, [])
    database(
        root,
        "System",
        {"hasEncryptedImages": encrypted, "hasEncryptedAudio": encrypted},
    )
    return root


def snapshot(root):
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in root.rglob("*")
        if path.is_file()
    }


@pytest.mark.parametrize(
    ("engine", "image_ext", "audio_ext"),
    [("MV", ".rpgmvp", ".rpgmvo"), ("MZ", ".png_", ".ogg_")],
)
def test_encrypted_assets_and_directory_casing_are_repaired_without_changing_content(
    tmp_path, engine, image_ext, audio_ext
):
    root = game(tmp_path, engine, True)
    database(root, "Actors", [None, {"characterName": "Hero"}])
    database(
        root,
        "System",
        {
            "hasEncryptedImages": True,
            "hasEncryptedAudio": True,
            "titleBgm": {"name": "Theme"},
        },
    )
    put(root, "IMG/Characters/hero" + image_ext.upper(), b"encrypted-image")
    put(root, "audio/bgm/theme" + audio_ext.upper(), b"encrypted-audio")
    before = snapshot(root)
    report = core.inspect_game(root)
    assert snapshot(root) == before
    assert not report.issues
    core.apply_changes(report)
    assert (
        root / ("img/characters/Hero" + image_ext)
    ).read_bytes() == b"encrypted-image"
    assert (root / ("audio/bgm/Theme" + audio_ext)).read_bytes() == b"encrypted-audio"
    assert "IMG" not in {p.name for p in root.iterdir()}
    assert (root / "icon/icon.png").read_bytes() == before["icon/icon.png"]
    assert not core.inspect_game(root).changes


def test_conflicting_consumers_block_all_changes(tmp_path):
    root = game(tmp_path)
    database(
        root, "Actors", [None, {"characterName": "Hero"}, {"characterName": "hero"}]
    )
    put(root, "img/characters/HERO.png")
    put(root, "img/faces/face.png")
    database(
        root, "CommonEvents", [None, {"list": [{"code": 101, "parameters": ["Face"]}]}]
    )
    before = snapshot(root)
    report = core.inspect_game(root)
    assert any(
        issue.kind == "conflict" and issue.path.endswith("HERO.png")
        for issue in report.issues
    )
    with pytest.raises(ValueError):
        core.apply_changes(report)
    assert snapshot(root) == before


def test_missing_asset_is_not_a_case_fix_and_does_not_hide_safe_repairs(tmp_path):
    root = game(tmp_path)
    database(root, "Actors", [None, {"characterName": "Hero", "faceName": "Absent"}])
    put(root, "img/characters/hero.png")
    report = core.inspect_game(root)
    assert [(issue.kind, issue.path) for issue in report.issues] == [
        ("missing", "img/faces/Absent.png")
    ]
    core.apply_changes(report)
    assert (root / "img/characters/Hero.png").read_bytes() == b"asset bytes"
    assert not (root / "img/faces/Absent.png").exists()


def test_mz_json_finds_effects_fonts_maps_and_plugins(tmp_path):
    root = game(tmp_path, "MZ")
    database(root, "MapInfos", [None, {"id": 2}])
    database(
        root,
        "map002",
        {
            "events": [
                None,
                {"pages": [{"list": [{"code": 231, "parameters": [1, "MapArt"]}]}]},
            ]
        },
    )
    database(root, "Animations", [None, {"effectName": "Spark"}])
    database(root, "System", {"advanced": {"mainFontFilename": "Main.ttf"}})
    put(root, "effects/spark.efkefc")
    put(root, "fonts/main.ttf")
    put(root, "img/pictures/mapart.png")
    put(root, "img/pictures/extra.png")
    put(
        root,
        "js/plugins.js",
        'var $plugins = [{"name":"Show","status":true,"parameters":{"Picture":"Extra"}},{"name":"Disabled","status":false,"parameters":{"Picture":"img/pictures/EXTRA.png"}}];',
    )
    put(
        root,
        "js/plugins/show.js",
        "/*:\n * @param Picture\n * @type file\n * @dir img/pictures/\n */",
    )
    report = core.inspect_game(root)
    assert not report.issues
    core.apply_changes(report)
    expected = {
        "data/Map002.json",
        "effects/Spark.efkefc",
        "fonts/Main.ttf",
        "js/plugins/Show.js",
        "img/pictures/MapArt.png",
        "img/pictures/Extra.png",
    }
    assert expected <= snapshot(root).keys()
    assert not core.inspect_game(root).changes


def test_symlinks_and_invalid_json_prevent_writes(tmp_path):
    root = game(tmp_path / "game")
    outside = put(tmp_path, "outside/hero.png", b"untouched")
    (root / "img").mkdir()
    (root / "img/characters").symlink_to(outside.parent, target_is_directory=True)
    database(root, "Actors", [None, {"characterName": "Hero"}])
    put(root, "data/Map001.json", "not JSON")
    report = core.inspect_game(root)
    assert {issue.kind for issue in report.issues} == {"unsafe", "error"}
    with pytest.raises(ValueError):
        core.apply_changes(report)
    assert outside.read_bytes() == b"untouched"


def test_io_failure_rolls_back_completed_renames(tmp_path):
    root = game(tmp_path)
    database(root, "Actors", [None, {"characterName": "Hero", "faceName": "Face"}])
    put(root, "img/characters/hero.png", b"hero")
    put(root, "img/faces/face.png", b"face")
    report = core.inspect_game(root)
    before = snapshot(root)
    real_rename = core._rename_case
    calls = 0

    def fail_second(source, destination):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise PermissionError("filesystem refused rename")
        real_rename(source, destination)

    with (
        patch("rmgaf.core._rename_case", side_effect=fail_second),
        pytest.raises(PermissionError),
    ):
        core.apply_changes(report)
    assert snapshot(root) == before
    assert not list(root.rglob(".rmgaf-*"))


def test_cli_check_is_read_only_then_repair_is_idempotent(tmp_path):
    root = game(tmp_path)
    database(root, "Actors", [None, {"characterName": "Hero"}])
    put(root, "img/characters/hero.PNG")
    before = snapshot(root)
    command = [sys.executable, "-m", "rmgaf", str(root), "--no-color"]
    checked = subprocess.run(
        [*command, "--check"], capture_output=True, text=True, check=False
    )
    assert checked.returncode == 1, checked.stderr
    assert snapshot(root) == before
    assert "hero.PNG" in checked.stdout and "Hero.png" in checked.stdout
    assert "\x1b" not in checked.stdout
    repaired = subprocess.run(command, capture_output=True, text=True, check=False)
    assert repaired.returncode == 0, repaired.stdout + repaired.stderr
    assert "Hero.png" in {p.name for p in (root / "img/characters").iterdir()}
    clean = subprocess.run(
        [*command, "--check"], capture_output=True, text=True, check=False
    )
    assert clean.returncode == 0, clean.stdout + clean.stderr


def test_plain_browser_images_are_not_mapped_to_engine_encryption(tmp_path):
    root = game(tmp_path, encrypted=True)
    put(
        root,
        "index.html",
        '<script src="js/rpg_core.js"></script><img src="img/ui/Browser.png">',
    )
    put(root, "img/ui/browser.PNG")
    put(
        root,
        "js/rpg_core.js",
        'Decrypter._ignoreList = ["img/system/Window.png"]; ImageManager.loadSystem("Window");',
    )
    put(root, "img/system/window.PNG")
    report = core.inspect_game(root)
    assert not report.issues
    core.apply_changes(report)
    assert {"img/ui/Browser.png", "img/system/Window.png"} <= snapshot(root).keys()


def test_case_collisions_never_overwrite_files(tmp_path):
    root = game(tmp_path)
    database(root, "Actors", [None, {"characterName": "Hero"}])
    put(root, "img/characters/Hero.png", b"one")
    alternative = root / "img/characters/hero.png"
    if alternative.exists():
        pytest.skip("requires a case-sensitive filesystem")
    put(root, "img/characters/hero.png", b"two")
    before = snapshot(root)
    report = core.inspect_game(root)
    assert report.blocked
    with pytest.raises(ValueError):
        core.apply_changes(report)
    assert snapshot(root) == before


def test_stylesheet_relative_urls_use_requested_directory_casing(tmp_path):
    root = game(tmp_path)
    put(
        root,
        "index.html",
        '<script src="js/rpg_core.js"></script><link rel="stylesheet" href="fonts/Game.css">',
    )
    put(root, "Fonts/game.css", '@font-face { src: url("Main.ttf"); }')
    put(root, "Fonts/main.TTF", b"font")
    report = core.inspect_game(root)
    assert not report.issues
    core.apply_changes(report)
    assert {"fonts/Game.css", "fonts/Main.ttf"} <= snapshot(root).keys()
