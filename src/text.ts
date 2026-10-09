import { posix } from "node:path"
import { parse, type Node as AcornNode } from "acorn"
import { parse as parseLoose } from "acorn-loose"
import { fullAncestor } from "acorn-walk"
import type * as ESTree from "estree"
import { Parser } from "htmlparser2"
import postcss from "postcss"
import valueParser from "postcss-value-parser"
import { z } from "zod"
import { audio, image, reference, type Plugin, type Reference } from "./references.js"

type Node = ESTree.Node & { start: number; end: number }
const imageFolders: Record<string, string> = {
  Animation: "animations",
  Battleback1: "battlebacks1",
  Battleback2: "battlebacks2",
  Enemy: "enemies",
  Character: "characters",
  Face: "faces",
  Parallax: "parallaxes",
  Picture: "pictures",
  SvActor: "sv_actors",
  SvEnemy: "sv_enemies",
  System: "system",
  Tileset: "tilesets",
  Title1: "titles1",
  Title2: "titles2"
}
const extensions: Record<string, true> = {
  ".png": true,
  ".jpg": true,
  ".jpeg": true,
  ".webp": true,
  ".svg": true,
  ".gif": true,
  ".ogg": true,
  ".m4a": true,
  ".mp3": true,
  ".wav": true,
  ".webm": true,
  ".mp4": true,
  ".ttf": true,
  ".otf": true,
  ".woff": true,
  ".woff2": true,
  ".json": true,
  ".js": true,
  ".css": true,
  ".rpgmvp": true,
  ".rpgmvo": true,
  ".rpgmvm": true,
  ".png_": true,
  ".ogg_": true,
  ".m4a_": true
}

function tree(text: string, comments?: string[]): AcornNode {
  const options = {
    ecmaVersion: "latest" as const,
    sourceType: "script" as const,
    locations: true,
    allowReturnOutsideFunction: true,
    onComment: comments
      ? (_block: boolean, _value: string, start: number, end: number) =>
          comments.push(text.slice(start, end))
      : undefined
  }
  try {
    return parse(text, options)
  } catch {
    // Plugins sometimes contain syntax newer than Acorn or unrelated damaged code.
    // Recovery is only used for discovery; plugin JSON is validated separately.
    if (comments) comments.length = 0
    return parseLoose(text, options)
  }
}

function literal(node: ESTree.Node | null | undefined, depth = 0): string | undefined {
  if (!node || depth > 64) return undefined
  if (node.type === "Literal" && typeof node.value === "string") {
    // Do not infer legacy octal escapes from sloppy-mode parsing.
    const raw = node.raw ?? ""
    for (let index = 1; index < raw.length - 1; index++) {
      if (raw[index] !== "\\") continue
      const escaped = raw[++index]
      if (
        escaped &&
        (/[1-9]/.test(escaped) || (escaped === "0" && /[0-9]/.test(raw[index + 1] ?? "")))
      )
        return undefined
    }
    return node.value
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = literal(node.left, depth + 1)
    const right = literal(node.right, depth + 1)
    if (left !== undefined && right !== undefined) return left + right
  }
  return undefined
}

function resourcePath(value: string, source: string, relative = false): string | undefined {
  // Do not use URL: it canonicalizes encoded dot segments and decodes differently
  // from the game's filesystem paths. Decode percent escapes exactly once.
  const raw = value.split(/[?#]/, 1)[0] ?? ""
  if (!raw || raw.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return undefined
  let path = raw.replace(/(?:%[0-9a-f]{2})+/gi, (encoded) =>
    Buffer.from(encoded.replaceAll("%", ""), "hex").toString("utf8")
  )
  if (path.includes("\\") || path.includes("\0") || path.startsWith("/")) return undefined
  path = posix.normalize(posix.join(relative ? posix.dirname(source) : "", path))
  return path === ".." || path.startsWith("../") ? undefined : path
}

function url(
  value: string,
  source: string,
  required: boolean,
  relative = false,
  label = source,
  encrypted = false
): Reference[] {
  const path = resourcePath(value, source, relative)
  return path ? [reference([path], label, required, encrypted)] : []
}

function hint(value: string, source: string): Reference[] {
  if (!value.includes("/") && !value.includes("%")) return []
  const path = resourcePath(value, source)
  if (!path) return []
  const folder = path.split("/", 1)[0]!.toLowerCase()
  return ["img", "audio", "movies", "fonts", "data", "js", "effects"].includes(folder) &&
    extensions[posix.extname(path).toLowerCase()]
    ? [reference([path], source, false, folder === "img" || folder === "audio")]
    : []
}

function call(node: ESTree.CallExpression, source: string): Reference[] {
  const fn = node.callee
  if (
    fn.type !== "MemberExpression" ||
    fn.computed ||
    fn.object.type !== "Identifier" ||
    fn.property.type !== "Identifier"
  )
    return []
  const owner = fn.object.name
  const method = fn.property.name
  const args = node.arguments
  const values = args.map((arg) => literal(arg))
  const label = `${source}:${node.loc?.start.line ?? 1} ${owner}.${method}`
  if (owner === "ImageManager") {
    for (const prefix of ["load", "reserve", "request"]) {
      const folder = method.startsWith(prefix)
        ? imageFolders[method.slice(prefix.length)]
        : undefined
      if (folder && values.length) return image(folder, values[0], label, false)
    }
    if (method === "loadBitmap" && values[0] && values[1])
      return url(
        `${values[0].replace(/\/+$/, "")}/${values[1]}.png`,
        label,
        false,
        false,
        label,
        true
      )
    if (method === "loadBitmapFromUrl" && values[0])
      return url(values[0], label, false, false, label, true)
  }
  if (owner === "AudioManager") {
    if (method === "createBuffer" && values[0] && values[1])
      return audio(values[0].replace(/^\/+|\/+$/g, ""), values[1], label, false)
    const folders: Record<string, string> = {
      playBgm: "bgm",
      playBgs: "bgs",
      playMe: "me",
      playSe: "se",
      playStaticSe: "se",
      loadStaticSe: "se"
    }
    const first = args[0]
    if (folders[method] && first?.type === "ObjectExpression") {
      let name: string | undefined
      for (const property of first.properties) {
        if (
          property.type !== "Property" ||
          property.computed ||
          property.shorthand ||
          property.kind !== "init" ||
          property.method
        )
          return []
        const key = property.key.type === "Identifier" ? property.key.name : literal(property.key)
        if (key === "name") name = literal(property.value)
      }
      return audio(folders[method], name, label, false)
    }
  }
  if (
    ((owner === "Graphics" && method === "playVideo") ||
      (owner === "Video" && method === "play")) &&
    values[0]
  )
    return url(values[0], label, false)
  if (
    ((owner === "FontManager" && method === "load") ||
      (owner === "Graphics" && method === "loadFont")) &&
    values[1]
  )
    return url(owner === "FontManager" ? `fonts/${values[1]}` : values[1], label, false)
  return []
}

function javascript(text: string, source: string): Reference[] {
  const references: Reference[] = []
  fullAncestor(tree(text), (node, _state, ancestors) => {
    if (node.type === "CallExpression")
      references.push(...call(node as ESTree.CallExpression, source))
    if (!["Literal", "TemplateLiteral", "BinaryExpression"].includes(node.type)) return
    const parents = ancestors.slice(0, -1)
    if (
      parents.some((parent) => parent.type === "TemplateLiteral") ||
      parents.at(-1)?.type === "BinaryExpression"
    )
      return
    const value = literal(node as ESTree.Node)
    if (value !== undefined)
      references.push(...hint(value, `${source}:${node.loc?.start.line ?? 1}`))
  })
  return references
}

function cssUnescape(value: string): string {
  return value.replace(
    /\\(?:([0-9a-fA-F]{1,6})\s?|([^\r\n])|\r?\n)/g,
    (_match, digits: string | undefined, character: string | undefined) => {
      if (!digits) return character ?? ""
      const number = Number.parseInt(digits, 16)
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
        ? String.fromCodePoint(number)
        : "\ufffd"
    }
  )
}

function css(text: string, source: string): Reference[] {
  const references: Reference[] = []
  const readValue = (value: string, line: number, imported = false) => {
    const parsed = valueParser(value)
    const add = (raw: string, quoted: boolean, offset: number) => {
      const stripped = raw.replace(/\\(?:[0-9a-fA-F]{1,6}\s?|[^\r\n]|\r?\n)/g, "")
      if (!quoted && /[\s()]/.test(stripped)) return
      references.push(
        ...url(
          cssUnescape(raw),
          source,
          true,
          true,
          `${source}:${line + (value.slice(0, offset).match(/\n/g)?.length ?? 0)}`
        )
      )
    }
    if (imported) {
      const first = parsed.nodes.find((node) => node.type !== "space" && node.type !== "comment")
      if (first?.type === "string") add(first.value, true, first.sourceIndex)
    }
    parsed.walk((node) => {
      if (node.type !== "function") return
      if (node.value.toLowerCase() !== "url") return
      if (node.unclosed) return false
      const contents = node.nodes.filter((child) => child.type !== "space")
      if (contents.length === 1 && contents[0]?.type === "string") {
        if (!contents[0].unclosed) add(contents[0].value, true, node.sourceIndex)
      } else {
        add(valueParser.stringify(node.nodes).trim(), false, node.sourceIndex)
      }
      return false
    })
  }
  // Inline style attributes are declaration lists, which PostCSS also accepts.
  const root = postcss.parse(text, { from: source })
  root.walkDecls((decl) => readValue(decl.value, decl.source?.start?.line ?? 1))
  root.walkAtRules((rule) => {
    if (rule.name.toLowerCase() === "import")
      readValue(rule.params, rule.source?.start?.line ?? 1, true)
  })
  return references
}

export function discoverText(
  text: string,
  kind: "html" | "css" | "js",
  source: string
): Reference[] {
  if (kind === "js") return javascript(text, source)
  if (kind === "css") return css(text, source)
  if (kind === "html") return html(text, source)
  if (kind !== "html") throw new Error(`Unsupported text kind: ${String(kind)}`)
  const references: Reference[] = []
  let embedded: "script" | "style" | undefined
  let contents = ""
  const parser = new Parser(
    {
      onopentag(tag, attrs) {
        const line = (text.slice(0, parser.startIndex).match(/\n/g)?.length ?? 0) + 1
        const label = `${source}:${line}`
        if (attrs.src) references.push(...url(attrs.src, source, true, true, label))
        if (
          tag === "link" &&
          attrs.href &&
          (attrs.rel ?? "")
            .toLowerCase()
            .split(/\s+/)
            .some((rel) =>
              ["stylesheet", "icon", "preload", "modulepreload", "manifest"].includes(rel)
            )
        )
          references.push(...url(attrs.href, source, true, true, label))
        if (attrs.style) references.push(...css(attrs.style, source))
        if (
          tag === "style" ||
          (tag === "script" &&
            ["", "module", "text/javascript", "application/javascript"].includes(
              (attrs.type ?? "").toLowerCase()
            ))
        ) {
          embedded = tag
          contents = ""
        }
      },
      ontext(value) {
        if (embedded) contents += value
      },
      onclosetag(tag) {
        if (tag !== embedded) return
        references.push(
          ...(embedded === "script" ? javascript(contents, source) : css(contents, source))
        )
        embedded = undefined
        contents = ""
      }
    },
    { decodeEntities: true }
  )
  parser.end(text)
  return references
}

const pluginSchema = z.array(
  z
    .object({
      name: z.string(),
      status: z.boolean(),
      parameters: z.record(z.string(), z.unknown()).optional()
    })
    .passthrough()
)

export function parsePlugins(text: string): Plugin[] {
  let assignment: Node | undefined
  fullAncestor(tree(text), (current) => {
    const node = current as ESTree.Node
    if (assignment) return
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.id.name === "$plugins"
    )
      assignment = node.id as Node
    if (
      node.type === "AssignmentExpression" &&
      node.operator === "=" &&
      node.left.type === "Identifier" &&
      node.left.name === "$plugins"
    )
      assignment = node.left as Node
  })
  if (!assignment) return []
  const leadingTrivia = /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*/
  let remaining = text.slice(assignment.end).replace(leadingTrivia, "")
  if (!remaining.startsWith("=") || remaining.startsWith("==") || remaining.startsWith("=>"))
    return []
  remaining = remaining.slice(1).trimStart()
  let quoted = false
  let escaped = false
  let depth = 0
  let end = -1
  for (let index = 0; index < remaining.length; index++) {
    const char = remaining[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === "[" || char === "{") depth++
    else if (char === "]" || char === "}") {
      if (--depth === 0) {
        end = index + 1
        break
      }
    } else if (depth === 0 && !/\s/.test(char ?? "")) break
  }
  if (end < 0) throw new Error("Malformed $plugins JSON assignment")
  const tail = remaining.slice(end).replace(leadingTrivia, "")
  if (tail && !tail.startsWith(";")) throw new Error("Malformed $plugins JSON assignment")
  let value: unknown
  try {
    value = JSON.parse(remaining.slice(0, end))
  } catch {
    throw new Error("Malformed $plugins JSON assignment")
  }
  return pluginSchema.parse(value)
}

type Specification = { type?: string; dir?: string }
export function discoverPluginParameters(
  plugin: Plugin,
  pluginText: string,
  source: string
): Reference[] {
  const comments: string[] = []
  tree(pluginText, comments)
  const definitions = new Map<string, Map<string, Specification>>()
  for (const comment of comments) {
    const struct = /^\/\*~struct~([^:]+):/.exec(comment)
    if (!struct && !comment.startsWith("/*:")) continue
    const name = struct?.[1] ?? ""
    let fields = definitions.get(name)
    if (!fields) {
      fields = new Map()
      definitions.set(name, fields)
    }
    let field: Specification | undefined
    for (const line of comment.split(/\r?\n/)) {
      const match = /^\s*\*?\s*@(param|arg|command|type|dir)\s+(.+?)\s*$/.exec(line)
      if (!match) continue
      const key = match[1]
      const value = match[2]!
      if (key === "param") {
        field = fields.get(value) ?? {}
        fields.set(value, field)
      } else if (key === "arg" || key === "command") field = undefined
      else if (field && (key === "type" || key === "dir")) field[key] = value
    }
  }
  const references: Reference[] = []
  const visit = (value: unknown, spec: Specification, label: string, depth = 0): void => {
    if (depth > 12) return
    let decoded = value
    if (typeof value === "string" && /^\s*[[{"]/.test(value)) {
      try {
        decoded = JSON.parse(value) as unknown
      } catch {
        /* Non-JSON filenames remain filenames. */
      }
    }
    const kind = spec.type ?? ""
    if (kind.endsWith("[]")) {
      if (Array.isArray(decoded))
        decoded.forEach((item: unknown, index) =>
          visit(item, { ...spec, type: kind.slice(0, -2) }, `${label}[${index}]`, depth + 1)
        )
      return
    }
    const struct = /^struct<([^>]+)>$/.exec(kind)
    if (struct && typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)) {
      const fields = definitions.get(struct[1]!)
      for (const [key, item] of Object.entries(decoded))
        visit(item, fields?.get(key) ?? {}, `${label}.${key}`, depth + 1)
      return
    }
    if (kind === "file" && typeof decoded === "string" && decoded) {
      const folder = (spec.dir ?? "").replace(/^\/+|\/+$/g, "")
      const path = `${folder}/${decoded}`
      if (!folder) references.push(...hint(decoded, label))
      else if (extensions[posix.extname(decoded).toLowerCase()])
        references.push(
          ...url(
            path,
            label,
            false,
            false,
            label,
            ["img", "audio"].includes(folder.split("/")[0]!.toLowerCase())
          )
        )
      else if (folder.startsWith("img/"))
        references.push(...url(`${path}.png`, label, false, false, label, true))
      else if (folder.startsWith("audio/"))
        references.push(...audio(folder.slice(6), decoded, label, false))
      else if (folder === "movies")
        references.push(reference([`${path}.webm`, `${path}.mp4`], label, false))
      return
    }
    if (typeof decoded === "string") references.push(...hint(decoded, label))
    else if (Array.isArray(decoded))
      decoded.forEach((item: unknown, index) => visit(item, {}, `${label}[${index}]`, depth + 1))
    else if (typeof decoded === "object" && decoded !== null)
      for (const [key, item] of Object.entries(decoded))
        visit(item, {}, `${label}.${key}`, depth + 1)
  }
  for (const [key, value] of Object.entries(plugin.parameters ?? {}))
    visit(value, definitions.get("")?.get(key) ?? {}, `${source}:parameter ${key}`)
  return references
}

export function parseImageIgnores(text: string): string[] | undefined {
  let result: string[] | undefined
  fullAncestor(tree(text), (current) => {
    const node = current as ESTree.Node
    if (result || node.type !== "AssignmentExpression" || node.operator !== "=") return
    const left = node.left
    if (
      left.type !== "MemberExpression" ||
      left.computed ||
      left.object.type !== "Identifier" ||
      left.object.name !== "Decrypter" ||
      left.property.type !== "Identifier" ||
      left.property.name !== "_ignoreList" ||
      node.right.type !== "ArrayExpression"
    )
      return
    const values = node.right.elements.map((element) => literal(element))
    if (values.every((value): value is string => value !== undefined)) result = values
  })
  return result
}
function html(text: string, source: string): Reference[] {
  throw new Error("Function not implemented.")
}

