"""Resource references in stock MV/MZ database and event schemas."""

import json
import re
from pathlib import PurePosixPath

from .references import Reference, audio, image

_EVENT_IMAGES = {
    101: (("faces", 0),),
    231: (("pictures", 1),),
    283: (("battlebacks1", 0), ("battlebacks2", 1)),
    284: (("parallaxes", 0),),
    322: (("characters", 1), ("faces", 3), ("sv_actors", 5)),
    323: (("characters", 1),),
}
_EVENT_AUDIO = {
    132: ("bgm", 0),
    133: ("me", 0),
    139: ("me", 0),
    140: ("bgm", 1),
    241: ("bgm", 0),
    245: ("bgs", 0),
    249: ("me", 0),
    250: ("se", 0),
}
_DATABASES = {
    "actors",
    "classes",
    "skills",
    "items",
    "weapons",
    "armors",
    "enemies",
    "troops",
    "states",
    "animations",
    "tilesets",
    "commonevents",
}


def _items(value: object):
    if isinstance(value, list):
        return enumerate(value)
    return ()


def _at(values: object, index: int) -> object:
    return values[index] if isinstance(values, list) and index < len(values) else None


def discover_data(
    value: object, source: str, engine: str, system: dict
) -> list[Reference]:
    """Read concrete stock fields only; source is relative to the game root."""
    result: list[Reference] = []
    stem = PurePosixPath(source).stem.lower()

    def images(record: dict, fields: dict[str, str], label: str) -> None:
        for field, folder in fields.items():
            result.extend(image(folder, record.get(field), f"{label}.{field}"))

    def sounds(record: dict, fields: dict[str, str], label: str) -> None:
        for field, folder in fields.items():
            result.extend(audio(folder, record.get(field), f"{label}.{field}"))

    def script(text: object, label: str) -> None:
        if isinstance(text, str) and text:
            from .text import discover_text

            result.extend(discover_text(text, "js", label))

    def hint(text: object, label: str) -> None:
        # Bare names in notes/plugin arguments have no dependable folder semantics.
        if isinstance(text, str) and text:
            script(json.dumps(text), label)

    def route(value: object, label: str) -> None:
        if not isinstance(value, dict):
            return
        for index, command in _items(value.get("list")):
            if not isinstance(command, dict):
                continue
            where = f"{label}.list[{index}]"
            params = command.get("parameters")
            code = command.get("code")
            if code == 41:
                result.extend(
                    image("characters", _at(params, 0), where + ".parameters[0]")
                )
            elif code == 44:
                result.extend(audio("se", _at(params, 0), where + ".parameters[0]"))
            elif code == 45:
                script(_at(params, 0), where + ".parameters[0]")

    def commands(value: object, label: str) -> None:
        if not isinstance(value, list):
            return
        index = 0
        while index < len(value):
            command = value[index]
            where = f"{label}[{index}]"
            index += 1
            if not isinstance(command, dict):
                continue
            code = command.get("code")
            if not isinstance(code, int) or isinstance(code, bool):
                continue
            params = command.get("parameters")
            for folder, position in _EVENT_IMAGES.get(code, ()):
                result.extend(
                    image(
                        folder, _at(params, position), f"{where}.parameters[{position}]"
                    )
                )
            sound = _EVENT_AUDIO.get(code)
            if sound:
                folder, position = sound
                result.extend(
                    audio(
                        folder, _at(params, position), f"{where}.parameters[{position}]"
                    )
                )
            if code == 205:
                route(_at(params, 1), where + ".parameters[1]")
            elif code == 261:
                name = _at(params, 0)
                if isinstance(name, str) and name:
                    result.append(
                        Reference(
                            tuple(f"movies/{name}{ext}" for ext in (".webm", ".mp4")),
                            where + ".parameters[0]",
                        )
                    )
            elif code in (355, 655):
                lines = [_at(params, 0)]
                while index < len(value):
                    continuation = value[index]
                    if (
                        not isinstance(continuation, dict)
                        or continuation.get("code") != 655
                    ):
                        break
                    lines.append(_at(continuation.get("parameters"), 0))
                    index += 1
                script(
                    "\n".join(line if isinstance(line, str) else "" for line in lines),
                    where + ".script",
                )
            elif code == 356:
                # An entire explicit path is safe; plugin-specific bare arguments are not.
                hint(_at(params, 0), where + ".parameters[0]")
            elif code == 357:
                args = _at(params, 3)
                if isinstance(args, dict):
                    for key, text in args.items():
                        hint(text, f"{where}.parameters[3].{key}")

    def pages(value: object, label: str) -> None:
        for index, page in _items(value):
            if not isinstance(page, dict):
                continue
            where = f"{label}[{index}]"
            character = page.get("image")
            if isinstance(character, dict):
                images(character, {"characterName": "characters"}, where + ".image")
            route(page.get("moveRoute"), where + ".moveRoute")
            commands(page.get("list"), where + ".list")

    if stem == "system" and isinstance(value, dict):
        images(
            value,
            {
                "title1Name": "titles1",
                "title2Name": "titles2",
                "battleback1Name": "battlebacks1",
                "battleback2Name": "battlebacks2",
            },
            source,
        )
        sounds(
            value,
            {
                "battleBgm": "bgm",
                "titleBgm": "bgm",
                "defeatMe": "me",
                "victoryMe": "me",
                "gameoverMe": "me",
            },
            source,
        )
        for index, sound in _items(value.get("sounds")):
            result.extend(audio("se", sound, f"{source}.sounds[{index}]"))
        for field in ("boat", "ship", "airship"):
            vehicle = value.get(field)
            if isinstance(vehicle, dict):
                images(vehicle, {"characterName": "characters"}, f"{source}.{field}")
                sounds(vehicle, {"bgm": "bgm"}, f"{source}.{field}")
        advanced = value.get("advanced")
        if engine == "MZ" and isinstance(advanced, dict):
            for field in ("mainFontFilename", "numberFontFilename"):
                name = advanced.get(field)
                if isinstance(name, str) and name:
                    result.append(
                        Reference((f"fonts/{name}",), f"{source}.advanced.{field}")
                    )
    elif re.fullmatch(r"map\d+", stem) and isinstance(value, dict):
        images(value, {"parallaxName": "parallaxes"}, source)
        if value.get("specifyBattleback") is not False:
            images(
                value,
                {"battleback1Name": "battlebacks1", "battleback2Name": "battlebacks2"},
                source,
            )
        for field, flag in (("bgm", "autoplayBgm"), ("bgs", "autoplayBgs")):
            if value.get(flag) is not False:
                sounds(value, {field: field}, source)
        hint(value.get("note"), source + ".note")
        for index, event in _items(value.get("events")):
            if isinstance(event, dict):
                where = f"{source}.events[{index}]"
                hint(event.get("note"), where + ".note")
                pages(event.get("pages"), where + ".pages")
    elif stem in _DATABASES:
        for index, record in _items(value):
            if not isinstance(record, dict):
                continue
            where = f"{source}[{index}]"
            hint(record.get("note"), where + ".note")
            if stem == "actors":
                images(
                    record,
                    {
                        "characterName": "characters",
                        "faceName": "faces",
                        "battlerName": "sv_actors",
                    },
                    where,
                )
            elif stem == "enemies":
                folder = (
                    "sv_enemies"
                    if isinstance(system, dict) and system.get("optSideView")
                    else "enemies"
                )
                images(record, {"battlerName": folder}, where)
            elif stem == "tilesets":
                for tile_index, name in _items(record.get("tilesetNames")):
                    result.extend(
                        image("tilesets", name, f"{where}.tilesetNames[{tile_index}]")
                    )
            elif stem == "animations":
                images(
                    record,
                    {"animation1Name": "animations", "animation2Name": "animations"},
                    where,
                )
                for timing_index, timing in _items(record.get("timings")):
                    if isinstance(timing, dict):
                        sounds(timing, {"se": "se"}, f"{where}.timings[{timing_index}]")
                if engine == "MZ":
                    name = record.get("effectName")
                    if isinstance(name, str) and name:
                        result.append(
                            Reference(
                                (f"effects/{name}.efkefc",), where + ".effectName"
                            )
                        )
                    for timing_index, timing in _items(record.get("soundTimings")):
                        if isinstance(timing, dict):
                            sounds(
                                timing,
                                {"se": "se"},
                                f"{where}.soundTimings[{timing_index}]",
                            )
            elif stem == "commonevents":
                commands(record.get("list"), where + ".list")
            elif stem == "troops":
                pages(record.get("pages"), where + ".pages")
    return result
