import unittest

from rmgaf.data import discover_data


def paths(value, source, engine="MV", system=None):
    return {
        path
        for ref in discover_data(value, source, engine, system or {})
        for path in ref.paths
    }


def command(code, *parameters):
    return {"code": code, "parameters": list(parameters)}


class DataDiscoveryTests(unittest.TestCase):
    def test_actor_and_enemy_image_folders(self):
        actors = [
            None,
            {"characterName": "Hero", "faceName": "Portrait", "battlerName": "Fighter"},
        ]
        self.assertEqual(
            paths(actors, "data/ACTORS.json"),
            {
                "img/characters/Hero.png",
                "img/faces/Portrait.png",
                "img/sv_actors/Fighter.png",
            },
        )
        enemies = [None, {"battlerName": "Slime"}]
        self.assertEqual(paths(enemies, "data/Enemies.json"), {"img/enemies/Slime.png"})
        self.assertEqual(
            paths(enemies, "data/Enemies.json", system={"optSideView": True}),
            {"img/sv_enemies/Slime.png"},
        )

    def test_system_resources_and_mz_fonts(self):
        system = {
            "title1Name": "Sky",
            "title2Name": "Logo",
            "battleback1Name": "Grass",
            "battleback2Name": "Forest",
            "battleBgm": {"name": "Battle"},
            "titleBgm": {"name": "Title"},
            "defeatMe": {"name": "Defeat"},
            "victoryMe": {"name": "Victory"},
            "gameoverMe": {"name": "Gameover"},
            "sounds": [None, {"name": "Cursor"}, {"name": ""}],
            "boat": {"characterName": "Vehicle", "bgm": {"name": "Sailing"}},
            "ship": None,
            "airship": {},
            "advanced": {
                "mainFontFilename": "Main.ttf",
                "numberFontFilename": "Digits.woff",
            },
        }
        refs = discover_data(system, "data/System.json", "MZ", system)
        found = {path for ref in refs for path in ref.paths}
        self.assertEqual(
            found,
            {
                "img/titles1/Sky.png",
                "img/titles2/Logo.png",
                "img/battlebacks1/Grass.png",
                "img/battlebacks2/Forest.png",
                "img/characters/Vehicle.png",
                "fonts/Main.ttf",
                "fonts/Digits.woff",
                *(
                    f"audio/bgm/{name}{ext}"
                    for name in ("Battle", "Title", "Sailing")
                    for ext in (".ogg", ".m4a")
                ),
                *(
                    f"audio/me/{name}{ext}"
                    for name in ("Defeat", "Victory", "Gameover")
                    for ext in (".ogg", ".m4a")
                ),
                "audio/se/Cursor.ogg",
                "audio/se/Cursor.m4a",
            },
        )
        battle = next(ref for ref in refs if "audio/bgm/Battle.ogg" in ref.paths)
        self.assertEqual(battle.paths, ("audio/bgm/Battle.ogg", "audio/bgm/Battle.m4a"))
        self.assertIn("battleBgm", battle.source)
        self.assertNotIn("fonts/Main.ttf", paths(system, "data/System.json"))

    def test_tilesets_and_animation_formats(self):
        self.assertEqual(
            paths(
                [None, {"tilesetNames": ["", "Outdoor", None]}], "data/Tilesets.json"
            ),
            {"img/tilesets/Outdoor.png"},
        )
        animations = [
            None,
            {
                "animation1Name": "Flash",
                "animation2Name": "",
                "effectName": "Burst",
                "timings": [None, {"se": {"name": "OldSound"}}],
                "soundTimings": [None, {"se": {"name": "NewSound"}}],
            },
        ]
        mv = paths(animations, "data/Animations.json")
        self.assertEqual(
            mv,
            {
                "img/animations/Flash.png",
                "audio/se/OldSound.ogg",
                "audio/se/OldSound.m4a",
            },
        )
        self.assertEqual(
            paths(animations, "data/Animations.json", "MZ"),
            mv
            | {
                "effects/Burst.efkefc",
                "audio/se/NewSound.ogg",
                "audio/se/NewSound.m4a",
            },
        )

    def test_nested_map_pages_routes_and_event_indexes(self):
        route = {
            "list": [
                None,
                command(41, "Walker", 2),
                command(44, {"name": "Step"}),
                command(231, 1, "NotARoutePicture"),
            ]
        }
        events = [
            command(101, "TalkFace", 0),
            command(231, 7, "Portrait", 0),
            command(322, 1, "NewHero", 2, "NewFace", 3, "NewBattler"),
            command(323, 2, "NewBoat", 1),
            command(283, "Floor", "Wall"),
            command(284, "Clouds", True),
            command(261, "Intro"),
            command(205, -1, route),
            command(41, "NotAnEventCharacter"),
            command(44, {"name": "NotAnEventSound"}),
        ]
        data = {
            "parallaxName": "Stars",
            "battleback1Name": "Base",
            "battleback2Name": "Back",
            "bgm": {"name": "MapTheme"},
            "bgs": {"name": "Wind"},
            "events": [
                None,
                {
                    "pages": [
                        None,
                        {
                            "image": {"characterName": "Guard"},
                            "moveRoute": route,
                            "list": events,
                        },
                    ]
                },
            ],
        }
        refs = discover_data(data, "data/Map012.json", "MV", {})
        found = {path for ref in refs for path in ref.paths}
        self.assertEqual(
            found,
            {
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
                "audio/se/Step.ogg",
                "audio/se/Step.m4a",
                "audio/bgm/MapTheme.ogg",
                "audio/bgm/MapTheme.m4a",
                "audio/bgs/Wind.ogg",
                "audio/bgs/Wind.m4a",
                "movies/Intro.webm",
                "movies/Intro.mp4",
            },
        )
        movie = next(ref for ref in refs if "movies/Intro.webm" in ref.paths)
        self.assertEqual(movie.paths, ("movies/Intro.webm", "movies/Intro.mp4"))
        self.assertIn("events[1].pages[1].list[6]", movie.source)
        data.update(specifyBattleback=False, autoplayBgm=False, autoplayBgs=False)
        filtered = paths(data, "data/Map012.json")
        self.assertNotIn("img/battlebacks1/Base.png", filtered)
        self.assertNotIn("audio/bgm/MapTheme.ogg", filtered)

    def test_event_audio_commands_in_common_events_and_troops(self):
        events = [
            command(code, {"name": f"Sound{code}"})
            for code in (132, 133, 139, 241, 245, 249, 250)
        ]
        events.append(command(140, 2, {"name": "VehicleBgm"}))
        common = [None, {"list": events}]
        expected = {
            *(
                f"audio/{folder}/Sound{code}{ext}"
                for code, folder in (
                    (132, "bgm"),
                    (133, "me"),
                    (139, "me"),
                    (241, "bgm"),
                    (245, "bgs"),
                    (249, "me"),
                    (250, "se"),
                )
                for ext in (".ogg", ".m4a")
            ),
            "audio/bgm/VehicleBgm.ogg",
            "audio/bgm/VehicleBgm.m4a",
        }
        self.assertEqual(paths(common, "data/CommonEvents.json"), expected)
        self.assertEqual(
            paths([None, {"pages": [{"list": events}]}], "data/Troops.json"), expected
        )

    def test_multiline_and_route_scripts_find_actual_resources(self):
        events = [
            command(355, "ImageManager.loadPicture("),
            command(655, "'Static');"),
            command(
                205, -1, {"list": [command(45, "AudioManager.playSe({name:'Step'});")]}
            ),
        ]
        self.assertEqual(
            paths([None, {"list": events}], "data/CommonEvents.json"),
            {
                "img/pictures/Static.png",
                "audio/se/Step.ogg",
                "audio/se/Step.m4a",
            },
        )

    def test_malformed_values_and_unrelated_fields_are_ignored(self):
        for value in (
            None,
            "text",
            {},
            [
                None,
                1,
                {"list": [None, {}, command(322), {"code": [], "parameters": []}]},
            ],
        ):
            self.assertEqual(paths(value, "data/CommonEvents.json"), set())
        arbitrary = [
            {
                "characterName": "NotAnActor",
                "battlerName": "NotAnEnemy",
                "bgm": {"name": "NotMusic"},
            }
        ]
        self.assertEqual(paths(arbitrary, "data/PluginSettings.json"), set())
        self.assertEqual(paths(arbitrary, "data/Items.json"), set())
        self.assertEqual(
            paths(
                [None, {"characterName": "", "faceName": None, "battlerName": 4}],
                "data/Actors.json",
            ),
            set(),
        )


if __name__ == "__main__":
    unittest.main()
