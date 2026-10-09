import fs from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { homedir } from "node:os"
import { parse } from "acorn"
import { discoverData } from "./data.js"
import { discoverText, discoverPluginParameters, parsePlugins, parseImageIgnores } from "./text.js"
import { reference, type Decoder, type Engine, type Plugin, type Reference } from "./references.js"

export const DATABASES = [
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
  "MapInfos"
]
export interface Issue {
  kind: "missing" | "error" | "unsafe" | "conflict"
  path: string
  detail: string
  source: string
}
export interface Change {
  old: string
  new: string
  source: string
}
export interface Report {
  root: string
  engine: Engine
  files: number
  documents: number
  references: number
  changes: Change[]
  issues: Issue[]
  decoded: number
  loaders: string[]
  warnings: string[]
}
export function isBlocked(report: Report): boolean {
  return report.issues.some((issue) => issue.kind !== "missing")
}

// Case-fold expansions not covered by JavaScript's Unicode lowercasing.
const foldExpansions: Record<string, string> = {
  ß: "ss",
  ς: "σ",
  ſ: "s",
  ﬀ: "ff",
  ﬁ: "fi",
  ﬂ: "fl",
  ﬃ: "ffi",
  ﬄ: "ffl",
  ﬅ: "st",
  ﬆ: "st"
}
const utf8 = new TextDecoder("utf-8", { fatal: true })
function key(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[ßςſﬀ-ﬆ]/g, (character) => foldExpansions[character]!)
}
function cleanPath(value: string): string {
  const normalized = value.replaceAll("\\", "/")
  if (normalized.includes("\0") || normalized.startsWith("/") || normalized.includes(":"))
    throw new Error(`Not a relative resource path: ${JSON.stringify(value)}`)
  const result = path.posix.normalize(normalized)
  if (result === "." || result === ".." || result.startsWith("../"))
    throw new Error(`Resource escapes the game directory: ${JSON.stringify(value)}`)
  return result
}

export class FileIndex {
  readonly entries = new Map<string, boolean>()
  readonly folded = new Map<string, string[]>()
  readonly links = new Set<string>()
  constructor(readonly root: string) {
    const excluded: Record<string, true> = {
      ".git": true,
      ".venv": true,
      ".yarn": true,
      node_modules: true,
      save: true,
      saves: true
    }
    const walk = (directory: string, prefix: string): void => {
      for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix + child.name
        if (child.isSymbolicLink()) {
          this.links.add(key(relative))
          continue
        }
        const isDirectory = child.isDirectory()
        if (
          (isDirectory && Object.hasOwn(excluded, key(child.name))) ||
          (!isDirectory && !child.isFile())
        )
          continue
        this.entries.set(relative, isDirectory)
        const folded = key(relative)
        const peers = this.folded.get(folded)
        if (peers) peers.push(relative)
        else this.folded.set(folded, [relative])
        if (isDirectory) walk(path.join(directory, child.name), relative + "/")
      }
    }
    walk(root, "")
  }
  matches(value: string, directory = false): string[] {
    return (this.folded.get(key(value)) ?? []).filter(
      (entry) => this.entries.get(entry) === directory
    )
  }
  one(value: string): string | undefined {
    const matches = this.matches(value)
    return matches.length === 1 ? matches[0] : undefined
  }
  read(value: string): string {
    const bytes = fs.readFileSync(path.join(this.root, value))
    try {
      return utf8.decode(bytes)
    } catch (error) {
      if (path.extname(value).toLowerCase() !== ".js") throw error
      let text = new TextDecoder().decode(bytes)
      const comments: [number, number][] = []
      parse(text, {
        ecmaVersion: "latest",
        onComment: (_block, comment, start, end) => {
          if (comment.includes("\ufffd") && !/^(?::|~struct~)/.test(comment))
            comments.push([start, end])
        }
      })
      // Ordinary comments have no resource semantics. Never guess an encoding
      // for executable text, resource strings, or RPG Maker plugin metadata.
      for (const [start, end] of comments)
        text =
          text.slice(0, start) + text.slice(start, end).replace(/[^\r\n]/g, " ") + text.slice(end)
      if (text.includes("\ufffd")) throw error
      return text
    }
  }
}

export async function inspectGame(
  directory: string,
  options: { progress?: (label: string) => void; decode?: Decoder } = {}
): Promise<Report> {
  const expanded =
    directory === "~"
      ? homedir()
      : directory.startsWith("~/")
        ? path.join(homedir(), directory.slice(2))
        : directory
  const root = fs.realpathSync(path.resolve(expanded))
  if (!fs.statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`)
  const progress = options.progress ?? (() => {})
  progress("Indexing resource filenames")
  const index = new FileIndex(root)
  const entry = index.one("index.html")
  if (!entry)
    throw new Error("Expected a unique index.html here. Pass its directory (MV usually: www).")
  const engines = (["MV", "MZ"] as const).filter(
    (engine) => index.matches(engine === "MV" ? "js/rpg_core.js" : "js/rmmz_core.js").length > 0
  )
  if (engines.length !== 1)
    throw new Error("Cannot identify a unique MV/MZ engine (js/rpg_core.js or js/rmmz_core.js).")
  const engine = engines[0]!
  const report: Report = {
    root,
    engine,
    files: 0,
    documents: 0,
    references: 0,
    changes: [],
    issues: [],
    decoded: 0,
    loaders: [],
    warnings: []
  }
  for (const directoryEntry of index.entries.values()) if (!directoryEntry) report.files++
  const references = new Map<string, Reference>()
  const add = (refs: Reference[]): void => {
    for (const ref of refs) {
      let paths: string[]
      try {
        paths = ref.paths.map(cleanPath)
      } catch (error) {
        if (ref.required)
          report.issues.push({
            kind: "unsafe",
            path: JSON.stringify(ref.paths),
            detail: String(error),
            source: ref.source
          })
        continue
      }
      const identity = JSON.stringify([paths, ref.encrypted])
      const previous = references.get(identity)
      if (!previous || (ref.required && !previous.required))
        references.set(identity, { ...ref, paths })
    }
  }
  const values = new Map<string, unknown>()
  const failures = new Map<string, string>()
  for (const [name, isDirectory] of [...index.entries].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )) {
    if (isDirectory || !key(name).startsWith("data/") || !key(name).endsWith(".json")) continue
    progress(`Reading ${name}`)
    try {
      values.set(name, JSON.parse(index.read(name)) as unknown)
    } catch (error) {
      failures.set(
        name,
        `Cannot read JSON: ${String(error)}. Custom encrypted/compressed databases need a decoded copy.`
      )
    }
  }
  if (options.decode && failures.size > 0) {
    try {
      const decoded = await options.decode(root, [...failures.keys()])
      report.loaders = [...decoded.loaders]
      report.warnings = [...(decoded.warnings ?? [])]
      const recoveredStandard: string[] = []
      add(decoded.requests.map((name) => reference([name], "runtime data request")))
      for (const name of failures.keys()) {
        if (decoded.data.has(name)) {
          values.set(name, decoded.data.get(name))
          failures.delete(name)
          report.decoded++
          const stem = path.posix.parse(name).name.toLowerCase()
          if (
            DATABASES.some((database) => database.toLowerCase() === stem) ||
            /^map\d+$/.test(stem)
          )
            recoveredStandard.push(name)
        } else if (decoded.errors.has(name)) failures.set(name, decoded.errors.get(name)!)
      }
      if (recoveredStandard.length > 0 && failures.size > 0) {
        const canonicalBytes = recoveredStandard.map((name) => ({
          name,
          bytes: fs.readFileSync(path.join(root, name))
        }))
        for (const name of failures.keys()) {
          const stem = path.posix.parse(name).name.toLowerCase()
          if (
            DATABASES.some((database) => database.toLowerCase() === stem) ||
            /^map\d+$/.test(stem)
          )
            continue
          try {
            const bytes = fs.readFileSync(path.join(root, name))
            const canonical = canonicalBytes.find((candidate) => candidate.bytes.equals(bytes))
            if (canonical) {
              failures.delete(name)
              report.warnings.push(
                `Duplicate unrecognized database ${name} matches ${canonical.name}; scanning canonical data`
              )
            }
          } catch {
            /* Unreadable files retain their original blocking error. */
          }
        }
      }
    } catch (error) {
      for (const name of failures.keys()) failures.set(name, `Cannot decode data: ${String(error)}`)
    }
  }
  for (const [name, detail] of failures)
    report.issues.push({ kind: "error", path: name, detail, source: "" })
  const systemPath = index.one("data/System.json")
  let system: Record<string, unknown> = {}
  if (!systemPath)
    report.issues.push({
      kind: "error",
      path: "data/System.json",
      detail: "Cannot determine encryption settings without a unique System.json",
      source: ""
    })
  else if (values.has(systemPath)) {
    const value = values.get(systemPath)
    if (typeof value === "object" && value !== null && !Array.isArray(value))
      system = value as Record<string, unknown>
    else
      report.issues.push({
        kind: "error",
        path: systemPath,
        detail: "Expected a JSON object",
        source: ""
      })
  }
  add([
    reference(["index.html"], "game entry"),
    ...DATABASES.map((name) => reference([`data/${name}.json`], `${engine} database`))
  ])
  for (const [name, value] of values) {
    report.documents++
    add(discoverData(value, name, engine, system))
    if (key(name) === "data/mapinfos.json" && Array.isArray(value)) {
      for (const item of value as unknown[]) {
        if (
          typeof item === "object" &&
          item !== null &&
          "id" in item &&
          typeof item.id === "number" &&
          Number.isInteger(item.id) &&
          item.id > 0
        )
          add([reference([`data/Map${String(item.id).padStart(3, "0")}.json`], name)])
      }
    }
  }
  const queue: [string, string][] = [[entry, "index.html"]]
  const pluginPath = index.one("js/plugins.js")
  if (pluginPath) {
    add([reference(["js/plugins.js"], `${engine} plugin registry`)])
    queue.push([pluginPath, "js/plugins.js"])
  }
  const seen = new Set<string>()
  let ignores = new Set(engine === "MV" ? ["img/system/Window.png"] : [])
  const settings = new Map<string, Plugin>()
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const [name, requested] = queue[cursor]!
    if (seen.has(name)) continue
    seen.add(name)
    const suffix = path.posix.extname(name).toLowerCase()
    if (![".html", ".css", ".js"].includes(suffix) || key(name).startsWith("js/libs/")) continue
    progress(`Reading ${name}`)
    try {
      const text = index.read(name)
      const refs =
        key(name) === "js/plugins.js"
          ? []
          : discoverText(text, suffix.slice(1) as "html" | "css" | "js", requested)
      report.documents++
      if (key(name) === "js/plugins.js") {
        for (const plugin of parsePlugins(text)) {
          if (!plugin.status) continue
          const wanted = `js/plugins/${plugin.name}.js`
          refs.push(reference([wanted], name))
          settings.set(key(wanted), plugin)
        }
      }
      const plugin = settings.get(key(name))
      if (plugin) refs.push(...discoverPluginParameters(plugin, text, "js/plugins.js"))
      if (engine === "MV" && text.includes("_ignoreList")) {
        const custom = parseImageIgnores(text)
        if (custom !== undefined) ignores = new Set(custom)
      }
      add(refs)
      for (const ref of refs)
        for (const wanted of ref.paths) {
          let cleaned: string
          try {
            cleaned = cleanPath(wanted)
          } catch {
            continue
          }
          const actual = index.one(cleaned)
          if (actual && [".js", ".css"].includes(path.posix.extname(actual).toLowerCase()))
            queue.push([actual, cleaned])
        }
    } catch (error) {
      report.issues.push({
        kind: "error",
        path: name,
        detail: `Cannot inspect source: ${String(error)}`,
        source: ""
      })
    }
  }
  const physical = (name: string): string => {
    const extension = path.posix.extname(name).toLowerCase()
    const encrypted =
      (extension === ".png" && system.hasEncryptedImages && !ignores.has(name)) ||
      ([".ogg", ".m4a"].includes(extension) && system.hasEncryptedAudio)
    if (!encrypted) return name
    if (engine === "MZ") return name + "_"
    return (
      name.slice(0, -extension.length) +
      ({ ".png": ".rpgmvp", ".ogg": ".rpgmvo", ".m4a": ".rpgmvm" } as Record<string, string>)[
        extension
      ]
    )
  }
  progress("Resolving resource paths")
  const demands = new Map<string, Map<string, string>>()
  const seenIssues = new Set<string>()
  const issue = (kind: Issue["kind"], name: string, detail: string, source: string): void => {
    const identity = JSON.stringify([kind, name])
    if (!seenIssues.has(identity)) {
      seenIssues.add(identity)
      report.issues.push({ kind, path: name, detail, source })
    }
  }
  for (const ref of references.values()) {
    const paths = ref.encrypted ? ref.paths.map(physical) : ref.paths
    let matched = false
    for (const wanted of paths) {
      const matches = index.matches(wanted)
      if (!matches.length) continue
      matched = true
      report.references++
      if (matches.length > 1) {
        issue("conflict", wanted, "Case-colliding files: " + matches.sort().join(", "), ref.source)
        continue
      }
      const actual = matches[0]!
      const actualParts = actual.split("/")
      const wantedParts = wanted.split("/")
      let existing = ""
      for (let depth = 0; depth < wantedParts.length; depth++) {
        existing += (depth === 0 ? "" : "/") + actualParts[depth]!
        const peers = index.folded.get(key(existing))!
        if (peers.length > 1)
          issue(
            "conflict",
            existing,
            "Case-colliding entries: " + [...peers].sort().join(", "),
            ref.source
          )
        let name = wantedParts[depth]!
        if (name.normalize("NFC") === actualParts[depth]!.normalize("NFC"))
          name = actualParts[depth]!
        let names = demands.get(existing)
        if (!names) {
          names = new Map()
          demands.set(existing, names)
        }
        if (!names.has(name)) names.set(name, ref.source)
      }
    }
    if (!matched && ref.required) {
      report.references++
      let unsafe = false
      for (const wanted of paths) {
        let prefix = ""
        for (const part of wanted.split("/")) {
          prefix += (prefix ? "/" : "") + part
          if (index.links.has(key(prefix))) unsafe = true
        }
      }
      issue(
        unsafe ? "unsafe" : "missing",
        paths.join(" | "),
        unsafe
          ? "Symlink resources are not followed"
          : "No matching file (not a case-only mismatch)",
        ref.source
      )
    }
  }
  for (const [actual, names] of demands) {
    if (names.size > 1)
      issue(
        "conflict",
        actual,
        "References require different spellings: " +
          [...names]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([name, source]) => `${name} (${source})`)
            .join("; "),
        ""
      )
    else {
      const [name, source] = names.entries().next().value!
      const desired = path.posix.join(path.posix.dirname(actual), name)
      if (desired !== actual) report.changes.push({ old: actual, new: desired, source })
    }
  }
  report.changes.sort(
    (a, b) =>
      b.old.split("/").length - a.old.split("/").length ||
      (a.old < b.old ? -1 : a.old > b.old ? 1 : 0)
  )
  report.issues.sort((a, b) =>
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  )
  return report
}

function existingStat(name: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}
function renameCase(source: string, destination: string): void {
  const sourceStat = fs.lstatSync(source)
  if (sourceStat.isSymbolicLink()) throw new Error(`Refusing to rename a symlink: ${source}`)
  const destinationStat = existingStat(destination)
  if (
    destinationStat &&
    (destinationStat.dev !== sourceStat.dev || destinationStat.ino !== sourceStat.ino)
  )
    throw new Error(`Destination already exists: ${destination}`)
  const temporary = path.join(path.dirname(source), `.rmgaf-${randomUUID()}`)
  if (existingStat(temporary)) throw new Error(`Temporary destination already exists: ${temporary}`)
  fs.renameSync(source, temporary)
  try {
    if (existingStat(destination))
      throw new Error(`Destination appeared during rename: ${destination}`)
    fs.renameSync(temporary, destination)
  } catch (error) {
    if (!existingStat(source)) fs.renameSync(temporary, source)
    throw error
  }
}
export function applyChanges(report: Report): number {
  if (isBlocked(report))
    throw new Error("Repair blocked by conflicts or unreadable/unsafe sources; no files changed.")
  if (fs.lstatSync(report.root).isSymbolicLink() || fs.realpathSync(report.root) !== report.root)
    throw new Error("Game directory changed since scan")
  for (const change of report.changes) {
    if (
      cleanPath(change.old) !== change.old ||
      cleanPath(change.new) !== change.new ||
      path.posix.dirname(change.old) !== path.posix.dirname(change.new) ||
      key(change.old) !== key(change.new)
    )
      throw new Error(`Unsafe rename plan: ${change.old}`)
    let parent = report.root
    const parts = change.old.split("/")
    for (const part of parts) {
      if (!fs.readdirSync(parent).includes(part))
        throw new Error(`Source changed since scan: ${change.old}`)
      parent = path.join(parent, part)
      if (fs.lstatSync(parent).isSymbolicLink())
        throw new Error(`Source became a symlink: ${change.old}`)
    }
    const source = fs.lstatSync(parent)
    const destination = existingStat(path.join(report.root, change.new))
    if (destination && (destination.dev !== source.dev || destination.ino !== source.ino))
      throw new Error(`Destination already exists: ${change.new}`)
  }
  const completed: Change[] = []
  try {
    for (const change of report.changes) {
      renameCase(path.join(report.root, change.old), path.join(report.root, change.new))
      completed.push(change)
    }
  } catch (error) {
    const failures: string[] = []
    for (let index = completed.length - 1; index >= 0; index--) {
      const change = completed[index]!
      try {
        renameCase(path.join(report.root, change.new), path.join(report.root, change.old))
      } catch (rollbackError) {
        failures.push(`${change.new}: ${String(rollbackError)}`)
      }
    }
    if (failures.length)
      throw new Error("Repair failed; rollback incomplete: " + failures.join("; "), {
        cause: error
      })
    throw error
  }
  return completed.length
}
