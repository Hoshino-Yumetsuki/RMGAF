"""Conservative resource discovery; JavaScript is parsed, never executed."""

import json
import posixpath
import re
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit

import tree_sitter_javascript
from tree_sitter import Language, Node, Parser, Tree

from .references import Reference, audio, image

_LANGUAGE = Language(tree_sitter_javascript.language())
_IMAGE_FOLDERS = {
    "Animation": "animations",
    "Battleback1": "battlebacks1",
    "Battleback2": "battlebacks2",
    "Enemy": "enemies",
    "Character": "characters",
    "Face": "faces",
    "Parallax": "parallaxes",
    "Picture": "pictures",
    "SvActor": "sv_actors",
    "SvEnemy": "sv_enemies",
    "System": "system",
    "Tileset": "tilesets",
    "Title1": "titles1",
    "Title2": "titles2",
}
_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".svg",
    ".gif",
    ".ogg",
    ".m4a",
    ".mp3",
    ".wav",
    ".webm",
    ".mp4",
    ".ttf",
    ".otf",
    ".woff",
    ".woff2",
    ".json",
    ".js",
    ".css",
    ".rpgmvp",
    ".rpgmvo",
    ".rpgmvm",
    ".png_",
    ".ogg_",
    ".m4a_",
}


def _tree(text: str) -> Tree:
    return Parser(_LANGUAGE).parse(text.encode("utf-8", errors="surrogatepass"))


def _nodes(tree: Tree):
    stack = [tree.root_node]
    while stack:
        node = stack.pop()
        yield node
        stack.extend(reversed(node.named_children))


def _text(node: Node) -> str:
    assert node.text is not None
    return node.text.decode("utf-8", errors="surrogatepass")


def _js_string(raw: str) -> str | None:
    """Decode JS string escapes without treating source as Python or JavaScript."""
    result = []
    index = 0
    escapes = {
        "n": "\n",
        "r": "\r",
        "t": "\t",
        "b": "\b",
        "f": "\f",
        "v": "\v",
        "0": "\0",
    }
    while index < len(raw):
        char = raw[index]
        index += 1
        if char != "\\":
            result.append(char)
            continue
        if index == len(raw):
            return None
        char = raw[index]
        index += 1
        if char in "\r\n":
            if char == "\r" and raw[index : index + 1] == "\n":
                index += 1
            continue
        if char in "xu":
            length = 2 if char == "x" else 4
            if char == "u" and raw[index : index + 1] == "{":
                end = raw.find("}", index + 1)
                if end < 0:
                    return None
                digits = raw[index + 1 : end]
                index = end + 1
            else:
                digits = raw[index : index + length]
                index += length
                if len(digits) != length:
                    return None
            try:
                result.append(chr(int(digits, 16)))
            except (ValueError, OverflowError):
                return None
        elif char.isdigit() and (char != "0" or raw[index : index + 1].isdigit()):
            # Legacy octal is deliberately not guessed.
            return None
        else:
            result.append(escapes.get(char, char))
    value = "".join(result)
    # Combine UTF-16 surrogate escape pairs while retaining normal Unicode.
    return value.encode("utf-16", errors="surrogatepass").decode(
        "utf-16", errors="surrogatepass"
    )


def _literal(node: Node | None, depth: int = 0) -> str | None:
    if node is None or node.has_error or depth > 64:
        return None
    if node.type == "string":
        return _js_string(_text(node)[1:-1])
    if node.type == "template_string":
        if any(child.type == "template_substitution" for child in node.named_children):
            return None
        return _js_string(_text(node)[1:-1])
    if node.type == "parenthesized_expression":
        children = [child for child in node.named_children if child.type != "comment"]
        return _literal(children[0], depth + 1) if len(children) == 1 else None
    if node.type == "binary_expression":
        operator = node.child_by_field_name("operator")
        if operator is not None and _text(operator) == "+":
            left = _literal(node.child_by_field_name("left"), depth + 1)
            right = _literal(node.child_by_field_name("right"), depth + 1)
            if left is not None and right is not None:
                return left + right
    return None


def _path(value: str, source: str, relative: bool = False) -> str | None:
    try:
        url = urlsplit(value)
    except ValueError:
        return None
    if url.scheme or url.netloc or not url.path or url.path.startswith("/"):
        return None
    path = unquote(url.path)
    if "\\" in path or "\0" in path:
        return None
    path = posixpath.normpath(
        posixpath.join(posixpath.dirname(source) if relative else "", path)
    )
    if path == ".." or path.startswith("../"):
        return None
    return path


def _url(
    value: str,
    source: str,
    required: bool,
    relative: bool = False,
    label: str | None = None,
    encrypted: bool = False,
) -> list[Reference]:
    path = _path(value, source, relative)
    return [Reference((path,), label or source, required, encrypted)] if path else []


def _hint(value: str, source: str) -> list[Reference]:
    if "/" not in value and "%" not in value:
        return []
    path = _path(value, source)
    if (
        path
        and path.split("/", 1)[0].lower()
        in {
            "img",
            "audio",
            "movies",
            "fonts",
            "data",
            "js",
            "effects",
        }
        and posixpath.splitext(path)[1].lower() in _EXTENSIONS
    ):
        return [
            Reference(
                (path,),
                source,
                False,
                path.split("/", 1)[0].lower() in {"img", "audio"},
            )
        ]
    return []


def _call(node: Node, source: str) -> list[Reference]:
    function = node.child_by_field_name("function")
    arguments = node.child_by_field_name("arguments")
    if function is None or function.type != "member_expression" or arguments is None:
        return []
    owner = function.child_by_field_name("object")
    method = function.child_by_field_name("property")
    if owner is None or method is None:
        return []
    owner, method = _text(owner), _text(method)
    args = [arg for arg in arguments.named_children if arg.type != "comment"]
    values = [_literal(arg) for arg in args]
    label = f"{source}:{node.start_point.row + 1} {owner}.{method}"
    if owner == "ImageManager":
        for prefix in ("load", "reserve", "request"):
            folder = (
                _IMAGE_FOLDERS.get(method.removeprefix(prefix))
                if method.startswith(prefix)
                else None
            )
            if folder and values:
                return image(folder, values[0], label, False)
        if method == "loadBitmap" and len(values) >= 2 and values[0] and values[1]:
            return _url(
                values[0].rstrip("/") + "/" + values[1] + ".png",
                label,
                False,
                encrypted=True,
            )
        if method == "loadBitmapFromUrl" and values and values[0]:
            return _url(values[0], label, False, encrypted=True)
    if owner == "AudioManager":
        if method == "createBuffer" and len(values) >= 2 and values[0] and values[1]:
            return audio(values[0].strip("/"), values[1], label, False)
        folder = {
            "playBgm": "bgm",
            "playBgs": "bgs",
            "playMe": "me",
            "playSe": "se",
            "playStaticSe": "se",
            "loadStaticSe": "se",
        }.get(method)
        if folder and args and args[0].type == "object":
            name = None
            for pair in args[0].named_children:
                if pair.type != "pair":
                    continue
                key = pair.child_by_field_name("key")
                if key is not None and (_literal(key) or _text(key)) == "name":
                    name = _literal(pair.child_by_field_name("value"))
                elif key is not None and key.type == "computed_property_name":
                    return []
            if any(
                child.type in {"spread_element", "shorthand_property_identifier"}
                for child in args[0].named_children
            ):
                return []
            return audio(folder, name, label, False)
    if (
        (owner, method) in {("Graphics", "playVideo"), ("Video", "play")}
        and values
        and values[0]
    ):
        return _url(values[0], label, False)
    if (
        (owner, method) in {("FontManager", "load"), ("Graphics", "loadFont")}
        and len(values) >= 2
        and values[1]
    ):
        path = "fonts/" + values[1] if owner == "FontManager" else values[1]
        return _url(path, label, False)
    return []


def _javascript(text: str, source: str) -> list[Reference]:
    references = []
    for node in _nodes(_tree(text)):
        if node.type == "call_expression" and not node.has_error:
            references.extend(_call(node, source))
        if node.type not in {
            "string",
            "template_string",
            "binary_expression",
            "parenthesized_expression",
        }:
            continue
        parent = node.parent
        # Only the complete expression is a hint: never a prefix of dynamic concatenation.
        if parent is not None and parent.type in {
            "binary_expression",
            "template_string",
            "template_substitution",
            "parenthesized_expression",
        }:
            continue
        value = _literal(node)
        if value is not None:
            references.extend(_hint(value, f"{source}:{node.start_point.row + 1}"))
    return references


_CSS_TOKENS = re.compile(
    r'/\*.*?\*/|url\(\s*(?:"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|(?:\\.|[^)\\])*)\s*\)|@import\s+(?:"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\')|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'',
    re.IGNORECASE | re.DOTALL,
)


def _css_unescape(value: str) -> str:
    def replace(match):
        if match.group(1):
            number = int(match.group(1), 16)
            return chr(number) if 0 < number <= 0x10FFFF else "\ufffd"
        return match.group(2) or ""

    return re.sub(r"\\(?:([0-9a-fA-F]{1,6})\s?|([^\r\n])|\r?\n)", replace, value)


def _css(text: str, source: str) -> list[Reference]:
    references = []
    for match in _CSS_TOKENS.finditer(text):
        token = match.group()
        if token.lower().startswith("url("):
            value = token[4:-1].strip()
        elif token.lower().startswith("@import"):
            value = token[7:].strip()
        else:
            continue
        unescaped_tokens = re.sub(r"\\(?:[0-9a-fA-F]{1,6}\s?|[^\r\n]|\r?\n)", "", value)
        if value[:1] not in {"'", '"'} and re.search(r"[\s()]", unescaped_tokens):
            continue
        if value[:1] in {"'", '"'}:
            value = value[1:-1]
        label = f"{source}:{text.count(chr(10), 0, match.start()) + 1}"
        references.extend(_url(_css_unescape(value), source, True, True, label))
    return references


class _HTML(HTMLParser):
    def __init__(self, source: str):
        super().__init__(convert_charrefs=True)
        self.source = source
        self.references = []
        self.embedded = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        label = f"{self.source}:{self.getpos()[0]}"
        src = attrs.get("src")
        if src:
            self.references.extend(_url(src, self.source, True, True, label))
        href = attrs.get("href")
        if tag == "link" and href:
            rel = set((attrs.get("rel") or "").lower().split())
            if rel & {"stylesheet", "icon", "preload", "modulepreload", "manifest"}:
                self.references.extend(_url(href, self.source, True, True, label))
        style = attrs.get("style")
        if style:
            self.references.extend(_css(style, self.source))
        if tag in {"script", "style"}:
            script_type = (attrs.get("type") or "").lower()
            if tag == "style" or script_type in {
                "",
                "module",
                "text/javascript",
                "application/javascript",
            }:
                self.embedded = tag

    def handle_endtag(self, tag):
        if tag == self.embedded:
            self.embedded = None

    def handle_data(self, data):
        if self.embedded == "script":
            self.references.extend(_javascript(data, self.source))
        elif self.embedded == "style":
            self.references.extend(_css(data, self.source))


def discover_text(text: str, kind: str, source: str) -> list[Reference]:
    """Find static URLs and optional JS loads, with game-root-relative paths."""
    if kind == "js":
        return _javascript(text, source)
    if kind == "css":
        return _css(text, source)
    if kind == "html":
        parser = _HTML(source)
        parser.feed(text)
        return parser.references
    raise ValueError(f"Unsupported text kind: {kind}")


def _invalid_json_constant(value: str):
    raise ValueError(f"Invalid JSON constant: {value}")


def parse_plugins(text: str) -> list[dict]:
    """Read the generated $plugins JSON assignment, without executing the file."""
    raw = text.encode("utf-8", errors="surrogatepass")
    for node in _nodes(_tree(text)):
        if node.type != "identifier" or _text(node) != "$plugins":
            continue
        remaining = raw[node.end_byte :].decode("utf-8", errors="surrogatepass")
        remaining = re.sub(
            r"^(?:\s|/\*.*?\*/|//[^\n]*(?:\n|$))*", "", remaining, flags=re.DOTALL
        )
        if not remaining.startswith("=") or remaining.startswith(("==", "=>")):
            continue
        try:
            value, end = json.JSONDecoder(
                parse_constant=_invalid_json_constant
            ).raw_decode(remaining[1:].lstrip())
        except (ValueError, RecursionError) as error:
            raise ValueError("Malformed $plugins JSON assignment") from error
        tail = remaining[1:].lstrip()[end:].lstrip()
        if tail and not tail.startswith((";", "//", "/*")):
            raise ValueError("Malformed $plugins JSON assignment")
        if not isinstance(value, list) or not all(
            isinstance(plugin, dict) for plugin in value
        ):
            raise ValueError("$plugins must be a JSON array of objects")
        return value
    return []


def _metadata(plugin_text: str) -> dict[str, dict[str, dict[str, str]]]:
    definitions = {}
    for node in _nodes(_tree(plugin_text)):
        if node.type != "comment":
            continue
        comment = _text(node)
        struct = re.match(r"/\*~struct~([^:]+):", comment)
        if not struct and not comment.startswith("/*:"):
            continue
        fields = definitions.setdefault(struct.group(1) if struct else "", {})
        field = None
        for line in comment.splitlines():
            match = re.match(
                r"\s*\*?\s*@(param|arg|command|type|dir)\s+(.+?)\s*$", line
            )
            if not match:
                continue
            key, value = match.groups()
            if key == "param":
                field = fields.setdefault(value, {})
            elif key in {"arg", "command"}:
                field = None
            elif field is not None:
                field[key] = value
    return definitions


def _decode_parameter(value):
    if isinstance(value, str) and value.lstrip().startswith(("{", "[", '"')):
        try:
            return json.loads(value)
        except (ValueError, RecursionError):
            pass
    return value


def discover_plugin_parameters(
    plugin: dict, plugin_text: str, source: str
) -> list[Reference]:
    """Use file/struct metadata, not filename guesses, to interpret parameters."""
    definitions = _metadata(plugin_text)
    references = []

    def visit(value, spec, label, depth=0):
        if depth > 12:
            return
        kind = spec.get("type", "")
        decoded = _decode_parameter(value)
        if kind.endswith("[]"):
            if isinstance(decoded, list):
                for index, item in enumerate(decoded):
                    visit(
                        item,
                        {**spec, "type": kind[:-2]},
                        f"{label}[{index}]",
                        depth + 1,
                    )
            return
        struct = re.fullmatch(r"struct<([^>]+)>", kind)
        if struct and isinstance(decoded, dict):
            fields = definitions.get(struct.group(1), {})
            for key, item in decoded.items():
                visit(item, fields.get(key, {}), f"{label}.{key}", depth + 1)
            return
        if kind == "file" and isinstance(decoded, str) and decoded:
            folder = spec.get("dir", "").strip("/")
            if folder:
                path = folder + "/" + decoded
                if posixpath.splitext(decoded)[1].lower() in _EXTENSIONS:
                    references.extend(
                        _url(
                            path,
                            label,
                            False,
                            encrypted=folder.split("/", 1)[0].lower()
                            in {"img", "audio"},
                        )
                    )
                elif folder.startswith("img/"):
                    references.extend(_url(path + ".png", label, False, encrypted=True))
                elif folder.startswith("audio/"):
                    references.extend(audio(folder[6:], decoded, label, False))
                elif folder == "movies":
                    references.append(
                        Reference((path + ".webm", path + ".mp4"), label, False)
                    )
            else:
                references.extend(_hint(decoded, label))
            return
        if isinstance(decoded, str):
            references.extend(_hint(decoded, label))
        elif isinstance(decoded, dict):
            for key, item in decoded.items():
                visit(item, {}, f"{label}.{key}", depth + 1)
        elif isinstance(decoded, list):
            for index, item in enumerate(decoded):
                visit(item, {}, f"{label}[{index}]", depth + 1)

    parameters = plugin.get("parameters", {})
    if isinstance(parameters, dict):
        for key, value in parameters.items():
            visit(
                value, definitions.get("", {}).get(key, {}), f"{source}:parameter {key}"
            )
    return references


def parse_image_ignores(text: str) -> list[str] | None:
    """Return a static ignore list, or None when no static assignment exists."""
    for node in _nodes(_tree(text)):
        if node.type != "assignment_expression" or node.has_error:
            continue
        left = node.child_by_field_name("left")
        right = node.child_by_field_name("right")
        if (
            left is None
            or left.type != "member_expression"
            or right is None
            or right.type != "array"
        ):
            continue
        owner = left.child_by_field_name("object")
        member = left.child_by_field_name("property")
        if (
            owner is None
            or member is None
            or _text(owner) != "Decrypter"
            or _text(member) != "_ignoreList"
        ):
            continue
        values = [
            _literal(child) for child in right.named_children if child.type != "comment"
        ]
        if all(value is not None for value in values):
            return [value for value in values if value is not None]
    return None
