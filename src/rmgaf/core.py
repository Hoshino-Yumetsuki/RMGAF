"""JSON-first RPG Maker inspection. Game scripts are parsed, never executed."""

from __future__ import annotations

import json
import os
import posixpath
import unicodedata
import uuid
from collections import defaultdict, deque
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .data import discover_data
from .references import Reference
from .text import discover_plugin_parameters, discover_text, parse_plugins

DATABASES = (
    "Actors",
    "Classes",
    "Skills",
    "Items",
    "Weapons",
    "Armors",
    "Enemies",
    "Troops",
    "States",
    "Animations",
    "Tilesets",
    "CommonEvents",
    "System",
    "MapInfos",
)


def key(path: str) -> str:
    return unicodedata.normalize("NFC", path).casefold()


def clean_path(path: str) -> str:
    # References are local URL paths already decoded by the text parser.
    path = path.replace("\\", "/")
    if "\x00" in path or path.startswith("/") or ":" in path:
        raise ValueError(f"Not a relative resource path: {path!r}")
    path = posixpath.normpath(path)
    if path in (".", "..") or path.startswith("../"):
        raise ValueError(f"Resource escapes the game directory: {path!r}")
    return path


@dataclass(frozen=True)
class Issue:
    kind: str
    path: str
    detail: str
    source: str = ""


@dataclass(frozen=True)
class Change:
    old: str
    new: str
    source: str


@dataclass
class Report:
    root: Path
    engine: str
    files: int = 0
    documents: int = 0
    references: int = 0
    changes: list[Change] = field(default_factory=list)
    issues: list[Issue] = field(default_factory=list)

    @property
    def blocked(self) -> bool:
        return any(issue.kind != "missing" for issue in self.issues)


class FileIndex:
    def __init__(self, root: Path):
        self.root = root
        self.entries: dict[str, bool] = {}
        self.folded: dict[str, list[str]] = defaultdict(list)
        self.links: set[str] = set()

        def walk(directory: Path) -> None:
            with os.scandir(directory) as children:
                for child in children:
                    relative = Path(child.path).relative_to(root).as_posix()
                    if child.is_symlink():
                        self.links.add(key(relative))
                        continue
                    is_dir = child.is_dir(follow_symlinks=False)
                    if is_dir and child.name.casefold() in {
                        ".git",
                        ".venv",
                        "node_modules",
                        "save",
                        "saves",
                    }:
                        continue
                    if not is_dir and not child.is_file(follow_symlinks=False):
                        continue
                    self.entries[relative] = is_dir
                    self.folded[key(relative)].append(relative)
                    if is_dir:
                        walk(Path(child.path))

        walk(root)

    def matches(self, path: str, directory: bool = False) -> list[str]:
        return [
            p for p in self.folded.get(key(path), ()) if self.entries[p] == directory
        ]

    def one(self, path: str) -> str | None:
        matches = self.matches(path)
        return matches[0] if len(matches) == 1 else None

    def read(self, path: str) -> str:
        return (self.root / path).read_text(encoding="utf-8-sig")


def inspect_game(
    directory: Path, progress: Callable[[str], None] = lambda _: None
) -> Report:
    root = directory.expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"Not a directory: {root}")
    progress("Indexing resource filenames")
    index = FileIndex(root)
    entry = index.one("index.html")
    if entry is None:
        raise ValueError(
            "Expected a unique index.html here. Pass its directory (MV usually: www)."
        )
    engines = [
        engine
        for engine, core in (("MV", "js/rpg_core.js"), ("MZ", "js/rmmz_core.js"))
        if index.matches(core)
    ]
    if len(engines) != 1:
        raise ValueError(
            "Cannot identify a unique MV/MZ engine (js/rpg_core.js or js/rmmz_core.js)."
        )
    engine = engines[0]
    report = Report(
        root, engine, files=sum(not is_dir for is_dir in index.entries.values())
    )
    references: dict[tuple[tuple[str, ...], bool], Reference] = {}

    def add(refs: list[Reference]) -> None:
        for ref in refs:
            try:
                paths = tuple(clean_path(path) for path in ref.paths)
            except ValueError as error:
                if ref.required:
                    report.issues.append(
                        Issue("unsafe", str(ref.paths), str(error), ref.source)
                    )
                continue
            identity = (paths, ref.encrypted)
            previous = references.get(identity)
            if previous is None or (ref.required and not previous.required):
                references[identity] = Reference(
                    paths, ref.source, ref.required, ref.encrypted
                )

    def load_json(path: str) -> object | None:
        try:
            return json.loads(index.read(path))
        except (OSError, UnicodeError, ValueError) as error:
            detail = f"Cannot read JSON: {error}. Custom encrypted/compressed databases need a decoded copy."
            report.issues.append(Issue("error", path, detail))
            return None

    system_path = index.one("data/System.json")
    system = load_json(system_path) if system_path else {}
    if system_path is None:
        report.issues.append(
            Issue(
                "error",
                "data/System.json",
                "Cannot determine encryption settings without a unique System.json",
            )
        )
    if not isinstance(system, dict):
        report.issues.append(
            Issue("error", "data/System.json", "Expected a JSON object")
        )
        system = {}
    add([Reference(("index.html",), "game entry")])
    add([Reference((f"data/{name}.json",), f"{engine} database") for name in DATABASES])

    # Direct JSON scan is the primary discovery path, independent of HTML/script order.
    for path, is_dir in sorted(index.entries.items()):
        if (
            is_dir
            or not key(path).startswith("data/")
            or not key(path).endswith(".json")
        ):
            continue
        progress(f"Reading {path}")
        value = system if path == system_path else load_json(path)
        if value is None:
            continue
        report.documents += 1
        add(discover_data(value, path, engine, system))
        if key(path) == "data/mapinfos.json" and isinstance(value, list):
            for item in value:
                if (
                    isinstance(item, dict)
                    and isinstance(item.get("id"), int)
                    and item["id"] > 0
                ):
                    add([Reference((f"data/Map{item['id']:03d}.json",), path)])

    # Bootstrap and enabled plugins supplement database discovery. Never inspect disabled plugins.
    queue = deque([(entry, "index.html")])
    plugin_path = index.one("js/plugins.js")
    if plugin_path:
        add([Reference(("js/plugins.js",), f"{engine} plugin registry")])
        queue.append((plugin_path, "js/plugins.js"))
    seen: set[str] = set()
    ignores = {"img/system/Window.png"} if engine == "MV" else set()
    plugin_settings: dict[str, dict] = {}
    while queue:
        path, requested = queue.popleft()
        if path in seen:
            continue
        seen.add(path)
        suffix = Path(path).suffix.casefold()
        if suffix not in {".html", ".css", ".js"} or key(path).startswith("js/libs/"):
            continue
        progress(f"Reading {path}")
        try:
            text = index.read(path)
            refs = (
                []
                if key(path) == "js/plugins.js"
                else discover_text(text, suffix[1:], requested)
            )
            report.documents += 1
            if key(path) == "js/plugins.js":
                for plugin in parse_plugins(text):
                    if plugin.get("status") is not True or not isinstance(
                        plugin.get("name"), str
                    ):
                        continue
                    wanted = f"js/plugins/{plugin['name']}.js"
                    refs.append(Reference((wanted,), path))
                    plugin_settings[key(wanted)] = plugin
            if key(path) in plugin_settings:
                refs.extend(
                    discover_plugin_parameters(
                        plugin_settings[key(path)], text, "js/plugins.js"
                    )
                )
            # Custom MV ignore lists determine whether images bypass encryption.
            if engine == "MV" and "_ignoreList" in text:
                from .text import parse_image_ignores

                custom_ignores = parse_image_ignores(text)
                if custom_ignores is not None:
                    ignores = set(custom_ignores)
            add(refs)
            for ref in refs:
                for wanted in ref.paths:
                    try:
                        actual = index.one(clean_path(wanted))
                    except ValueError:
                        continue
                    if actual and Path(actual).suffix.casefold() in {".js", ".css"}:
                        queue.append((actual, clean_path(wanted)))
        except (OSError, UnicodeError, ValueError) as error:
            report.issues.append(
                Issue("error", path, f"Cannot inspect source: {error}")
            )

    def physical(path: str) -> str:
        extension = posixpath.splitext(path)[1].lower()
        encrypted = (
            extension == ".png"
            and system.get("hasEncryptedImages")
            and path not in ignores
        ) or (extension in {".ogg", ".m4a"} and system.get("hasEncryptedAudio"))
        if encrypted:
            if engine == "MZ":
                return path + "_"
            return (
                posixpath.splitext(path)[0]
                + {".png": ".rpgmvp", ".ogg": ".rpgmvo", ".m4a": ".rpgmvm"}[extension]
            )
        return path

    progress("Resolving resource paths")
    # Each actual directory/file collects every spelling requested by its consumers.
    demands: dict[str, dict[str, str]] = defaultdict(dict)
    seen_issues: set[tuple[str, str]] = set()

    def issue(kind: str, path: str, detail: str, source: str) -> None:
        if (kind, path) not in seen_issues:
            seen_issues.add((kind, path))
            report.issues.append(Issue(kind, path, detail, source))

    for ref in references.values():
        paths = tuple(physical(path) if ref.encrypted else path for path in ref.paths)
        matched = False
        for wanted in paths:
            matches = index.matches(wanted)
            if not matches:
                continue
            matched = True
            report.references += 1
            if len(matches) > 1:
                issue(
                    "conflict",
                    wanted,
                    "Case-colliding files: " + ", ".join(sorted(matches)),
                    ref.source,
                )
                continue
            actual = matches[0]
            actual_parts = actual.split("/")
            wanted_parts = wanted.split("/")
            for depth, name in enumerate(wanted_parts, 1):
                existing = "/".join(actual_parts[:depth])
                peers = index.folded[key(existing)]
                if len(peers) > 1:
                    issue(
                        "conflict",
                        existing,
                        "Case-colliding entries: " + ", ".join(sorted(peers)),
                        ref.source,
                    )
                # Do not rewrite decomposed Unicode solely to change normalization.
                if unicodedata.normalize("NFC", name) == unicodedata.normalize(
                    "NFC", actual_parts[depth - 1]
                ):
                    name = actual_parts[depth - 1]
                demands[existing].setdefault(name, ref.source)
        if not matched and ref.required:
            report.references += 1
            unsafe = any(
                key("/".join(path.split("/")[:depth])) in index.links
                for path in paths
                for depth in range(1, len(path.split("/")) + 1)
            )
            issue(
                "unsafe" if unsafe else "missing",
                " | ".join(paths),
                "Symlink resources are not followed"
                if unsafe
                else "No matching file (not a case-only mismatch)",
                ref.source,
            )

    for actual, names in demands.items():
        if len(names) > 1:
            detail = "; ".join(
                f"{name} ({source})" for name, source in sorted(names.items())
            )
            issue(
                "conflict",
                actual,
                "References require different spellings: " + detail,
                "",
            )
        else:
            name, source = next(iter(names.items()))
            desired = posixpath.join(posixpath.dirname(actual), name)
            if desired != actual:
                report.changes.append(Change(actual, desired, source))
    report.changes.sort(key=lambda change: (-change.old.count("/"), change.old))
    report.issues.sort(key=lambda item: (item.kind, item.path))
    return report


def _rename_case(source: Path, destination: Path) -> None:
    """Two hops make case-only renames work on case-insensitive filesystems too."""
    if source.is_symlink():
        raise OSError(f"Refusing to rename a symlink: {source}")
    if os.path.lexists(destination) and not os.path.samefile(source, destination):
        raise FileExistsError(f"Destination already exists: {destination}")
    temporary = source.with_name(f".rmgaf-{uuid.uuid4().hex}")
    source.rename(temporary)
    try:
        if os.path.lexists(destination):
            raise FileExistsError(f"Destination appeared during rename: {destination}")
        temporary.rename(destination)
    except BaseException:
        if not os.path.lexists(source):
            temporary.rename(source)
        raise


def apply_changes(report: Report) -> int:
    """Refuse ambiguous plans; roll completed operations back on ordinary failures."""
    if report.blocked:
        raise ValueError(
            "Repair blocked by conflicts or unreadable/unsafe sources; no files changed."
        )
    # Preflight before the first write, including exact directory entries on macOS/Windows.
    for change in report.changes:
        for parent in (report.root / change.old).parents:
            if parent == report.root:
                break
            if parent.is_symlink():
                raise OSError(f"Source parent became a symlink: {parent}")
        source = report.root / change.old
        if source.name not in os.listdir(source.parent) or source.is_symlink():
            raise OSError(f"Source changed since scan: {change.old}")
        destination = report.root / change.new
        if os.path.lexists(destination) and not os.path.samefile(source, destination):
            raise FileExistsError(f"Destination already exists: {change.new}")
    completed: list[Change] = []
    try:
        for change in report.changes:
            _rename_case(report.root / change.old, report.root / change.new)
            completed.append(change)
    except BaseException as error:
        failures = []
        for change in reversed(completed):
            try:
                _rename_case(report.root / change.new, report.root / change.old)
            except OSError as rollback_error:
                failures.append(f"{change.new}: {rollback_error}")
        if failures:
            raise OSError(
                "Repair failed; rollback incomplete: " + "; ".join(failures)
            ) from error
        raise
    return len(completed)
