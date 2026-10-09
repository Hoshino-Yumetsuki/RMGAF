from dataclasses import dataclass


@dataclass(frozen=True)
class Reference:
    """One load request; paths are alternative formats, relative to index.html."""

    paths: tuple[str, ...]
    source: str
    required: bool = True
    encrypted: bool = False


def image(
    folder: str, name: object, source: str, required: bool = True
) -> list[Reference]:
    if not isinstance(name, str) or not name:
        return []
    return [Reference((f"img/{folder}/{name}.png",), source, required, True)]


def audio(
    folder: str, name: object, source: str, required: bool = True
) -> list[Reference]:
    if isinstance(name, dict):
        name = name.get("name")
    if not isinstance(name, str) or not name:
        return []
    return [
        Reference(
            tuple(f"audio/{folder}/{name}{ext}" for ext in (".ogg", ".m4a")),
            source,
            required,
            True,
        )
    ]
