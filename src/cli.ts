#!/usr/bin/env node
import { parseArgs, styleText } from "node:util"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"
import manifest from "../package.json" with { type: "json" }
import { applyChanges, inspectGame, isBlocked } from "./core.js"
import { decodeTrustedGame } from "./runtime.js"

const { version } = manifest

function visible(value: unknown): string {
  return String(value).replace(
    /[\p{Cc}\p{Cf}]/gu,
    (char) => `\\u${char.codePointAt(0)!.toString(16).padStart(4, "0")}`
  )
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      check: { type: "boolean" },
      verbose: { type: "boolean", short: "v" },
      "no-color": { type: "boolean" },
      trust: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" }
    }
  })
  if (values.help) {
    process.stdout.write(
      `rmgaf ${version} — RPG Maker MV/MZ resource filename alignment\n\nUsage: rmgaf <directory> [options]\n\n  <directory>        Directory containing index.html (MV usually: www)\n  --check            Report without renaming game files\n  --trust  Execute trusted data-loader closures in a child MoeJS WASM runtime\n  -v, --verbose      Show every issue and its source\n  --no-color         Disable colors and animation (also respects NO_COLOR)\n  --version          Print version\n  -h, --help         Print help\n\nDefault: JSON-first static scan; no game code is executed.\nVM decoding is opt-in even with --check. It does not run the entire game.\nExit codes: 0 clean/repaired, 1 unresolved issues, 2 usage/I/O error, 130 interrupted.\nClose the game and back it up before repair.\n`
    )
    return 0
  }
  if (values.version) {
    process.stdout.write(`rmgaf ${version}\n`)
    return 0
  }
  if (positionals.length !== 1)
    throw new Error("Expected one directory containing index.html. See rmgaf --help.")
  const plain =
    values["no-color"] ||
    "NO_COLOR" in process.env ||
    !process.stdout.isTTY ||
    process.env.TERM === "dumb"
  const paint = (style: Parameters<typeof styleText>[0], value: string) =>
    plain ? value : styleText(style, value, { validateStream: false })
  const directory = resolve(positionals[0])
  const started = performance.now()
  process.stdout.write(
    `${paint(["bold", "cyan"], "rmgaf")}  ${values.check ? "Check" : "Repair"}\n${paint("dim", "  " + visible(directory))}\n`
  )
  if (values["trust"])
    process.stderr.write("warning: trusted game JavaScript execution enabled in moejs-wasm\n")
  let active = false,
    frame = 0,
    updated = 0,
    interrupted = false
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  const interrupt = () => {
    interrupted = true
  }
  process.once("SIGINT", interrupt)
  const progress = (message: string) => {
    if (plain || performance.now() - updated < 75) return
    updated = performance.now()
    active = true
    const text = Array.from(visible(message))
      .slice(0, Math.max(16, (process.stdout.columns || 80) - 4))
      .join("")
    process.stdout.write(`\r\x1b[2K${paint("cyan", frames[frame++ % frames.length])} ${text}`)
  }
  try {
    const report = await inspectGame(directory, {
      progress,
      ...(values["trust"] ? { decode: decodeTrustedGame } : {})
    })
    if (active) {
      process.stdout.write("\r\x1b[2K")
      active = false
    }
    if (interrupted) return 130
    process.stdout.write(
      `  ${paint("cyan", report.engine)}  ${paint("dim", `${report.files.toLocaleString("en-US")} files · ${report.documents.toLocaleString("en-US")} sources · ${report.references.toLocaleString("en-US")} resource requests`)}\n`
    )
    if (report.decoded)
      process.stdout.write(
        `  ${paint("cyan", "VM")}  decoded ${report.decoded} databases using ${report.loaders.length} data loader(s)\n`
      )
    if (values.verbose)
      for (const loader of report.loaders)
        process.stdout.write(paint("dim", `          ${visible(loader)}`) + "\n")
    const limit = values.verbose ? Infinity : 12
    for (const change of report.changes.slice(0, limit)) {
      process.stdout.write(
        `${paint("yellow", "  rename  ")}${visible(change.old)} ${paint("dim", "→")} ${paint("green", visible(change.new))}\n`
      )
      if (values.verbose)
        process.stdout.write(paint("dim", `          ${visible(change.source)}`) + "\n")
    }
    if (report.changes.length > limit)
      process.stdout.write(
        paint("dim", `  … ${report.changes.length - limit} more renames; use --verbose`) + "\n"
      )
    const issueLimit = values.verbose ? Infinity : 8
    for (const issue of report.issues.slice(0, issueLimit)) {
      process.stdout.write(
        `${paint(issue.kind === "missing" ? "yellow" : "red", `  ${issue.kind}  `)}${visible(issue.path)}\n${paint("dim", "          " + visible(issue.detail))}\n`
      )
      if (values.verbose && issue.source)
        process.stdout.write(paint("dim", `          ${visible(issue.source)}`) + "\n")
    }
    if (report.issues.length > issueLimit)
      process.stdout.write(
        paint("dim", `  … ${report.issues.length - issueLimit} more issues; use --verbose`) + "\n"
      )
    for (const warning of report.warnings)
      process.stdout.write(paint("yellow", "  warning  " + visible(warning)) + "\n")
    const blocked = isBlocked(report)
    const fixed = !values.check && !blocked ? applyChanges(report) : 0
    const elapsed = ((performance.now() - started) / 1000).toFixed(2)
    if (blocked) {
      process.stdout.write(
        paint(
          ["bold", "red"],
          `Blocked · ${report.issues.length} issues · no files renamed [${elapsed}s]`
        ) + "\n"
      )
      if (
        !values["trust"] &&
        report.issues.some((issue) => issue.kind === "error" && issue.path.endsWith(".json"))
      )
        process.stdout.write(
          "Custom database encoding? Only for trusted games, opt in with --trust.\n"
        )
    } else if (values.check && report.changes.length) {
      process.stdout.write(
        paint(
          ["bold", "yellow"],
          `Found ${report.changes.length} case-only renames · ${report.issues.length} missing resources [${elapsed}s]`
        ) + "\nRun without --check to apply renames.\n"
      )
    } else if (report.issues.length) {
      process.stdout.write(
        paint(
          ["bold", "yellow"],
          `${values.check ? "Checked; no files renamed" : `Repaired ${fixed} names`} · ${report.issues.length} missing resources remain [${elapsed}s]`
        ) + "\n"
      )
    } else {
      process.stdout.write(
        paint(
          ["bold", "green"],
          `${fixed ? `Repaired ${fixed} names` : "No casing issues found"} [${elapsed}s]`
        ) + "\n"
      )
    }
    return blocked || (values.check && report.changes.length) ? 1 : 0
  } finally {
    if (active) process.stdout.write("\r\x1b[2K")
    process.removeListener("SIGINT", interrupt)
  }
}

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0)
  throw error
})
main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`error: ${visible(error instanceof Error ? error.message : error)}\n`)
    process.exitCode = 2
  })
