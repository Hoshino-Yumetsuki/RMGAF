"""Terminal presentation and process exit codes."""

from __future__ import annotations

import argparse
import os
import sys
import time
import unicodedata
from contextlib import nullcontext
from importlib.metadata import version
from pathlib import Path

from rich.console import Console
from rich.text import Text

from .core import apply_changes, inspect_game


def visible(value: object) -> str:
    return "".join(
        char.encode("unicode_escape").decode("ascii")
        if unicodedata.category(char).startswith("C")
        else char
        for char in str(value)
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="rmgaf",
        description="Check and repair RPG Maker MV/MZ resource filename casing. JSON-first; no game code is executed.",
        epilog="Exit codes: 0 clean/repaired, 1 unresolved issues, 2 usage/I/O error. Close the game before repair.",
    )
    parser.add_argument(
        "directory", type=Path, help="directory containing index.html (MV usually: www)"
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="report only; never write to the game directory",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="show every change and issue with its source",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="disable colors and animation (also respects NO_COLOR)",
    )
    parser.add_argument(
        "--version", action="version", version=f"rmgaf {version('rmgaf')}"
    )
    args = parser.parse_args(argv)
    plain = args.no_color or "NO_COLOR" in os.environ
    console = Console(no_color=plain, highlight=False)
    errors = Console(stderr=True, no_color=plain, highlight=False)
    started = time.monotonic()
    console.print(
        Text.assemble(
            ("rmgaf", "bold cyan"), ("  Check" if args.check else "  Repair", "bold")
        )
    )
    console.print(
        Text("  " + visible(args.directory.expanduser().absolute()), style="dim"),
        soft_wrap=True,
    )
    status = (
        console.status(
            "Indexing resource filenames", spinner="dots", spinner_style="cyan"
        )
        if console.is_terminal and not plain and not console.is_dumb_terminal
        else None
    )
    last_update = 0.0

    def progress(message: str) -> None:
        nonlocal last_update
        now = time.monotonic()
        if status and now - last_update > 0.08:
            status.update(Text(visible(message)))
            last_update = now

    try:
        with status if status else nullcontext():
            report = inspect_game(args.directory, progress)
        console.print(
            Text.assemble(
                (f"  {report.engine}", "cyan"),
                (
                    f"  {report.files:,} files · {report.documents:,} sources · {report.references:,} resource requests",
                    "dim",
                ),
            )
        )
        limit = len(report.changes) if args.verbose else 12
        for change in report.changes[:limit]:
            console.print(
                Text.assemble(
                    ("  rename  ", "yellow"),
                    visible(change.old),
                    (" → ", "dim"),
                    (visible(change.new), "green"),
                ),
                soft_wrap=True,
            )
            if args.verbose:
                console.print(
                    Text("          " + visible(change.source), style="dim"),
                    soft_wrap=True,
                )
        if len(report.changes) > limit:
            console.print(
                f"  … {len(report.changes) - limit:,} more renames; use --verbose",
                style="dim",
            )
        issue_limit = len(report.issues) if args.verbose else 8
        for issue in report.issues[:issue_limit]:
            console.print(
                Text.assemble(
                    (
                        f"  {issue.kind}  ",
                        "yellow" if issue.kind == "missing" else "red",
                    ),
                    visible(issue.path),
                ),
                soft_wrap=True,
            )
            console.print(
                Text("          " + visible(issue.detail), style="dim"), soft_wrap=True
            )
            if args.verbose and issue.source:
                console.print(
                    Text("          " + visible(issue.source), style="dim"),
                    soft_wrap=True,
                )
        if len(report.issues) > issue_limit:
            console.print(
                f"  … {len(report.issues) - issue_limit:,} more issues; use --verbose",
                style="dim",
            )
        fixed = 0
        if not args.check and not report.blocked:
            fixed = apply_changes(report)
        elapsed = time.monotonic() - started
        if report.blocked:
            console.print(
                f"Blocked · {len(report.issues):,} issues · no files changed [{elapsed:.2f}s]",
                style="bold red",
            )
        elif args.check and report.changes:
            console.print(
                f"Found {len(report.changes):,} case-only renames · {len(report.issues):,} missing resources [{elapsed:.2f}s]",
                style="bold yellow",
            )
            console.print("Run without --check to apply renames.", style="dim")
        elif report.issues:
            result = (
                "Checked; no files changed"
                if args.check
                else f"Repaired {fixed:,} names"
            )
            console.print(
                f"{result} · {len(report.issues):,} missing resources remain [{elapsed:.2f}s]",
                style="bold yellow",
            )
        else:
            console.print(
                f"{'Repaired ' + str(fixed) + ' names' if fixed else 'No casing issues found'} [{elapsed:.2f}s]",
                style="bold green",
            )
        console.print(
            "Static scan: runtime-generated plugin paths and save files are not covered.",
            style="dim",
        )
        return 1 if report.issues or (args.check and report.changes) else 0
    except BrokenPipeError:
        return 0
    except (OSError, ValueError) as error:
        errors.print(
            Text.assemble(("error: ", "bold red"), visible(error)), soft_wrap=True
        )
        return 2
    except KeyboardInterrupt:
        errors.print("Interrupted.", style="yellow")
        return 130


if __name__ == "__main__":
    sys.exit(main())
