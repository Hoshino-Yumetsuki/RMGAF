import { posix } from "node:path"
import { audio, image, reference, type Engine, type Reference } from "./references.js"
import { discoverText } from "./text.js"

const eventImages: Record<number, readonly (readonly [string, number])[]> = {
  101: [["faces", 0]],
  231: [["pictures", 1]],
  283: [
    ["battlebacks1", 0],
    ["battlebacks2", 1]
  ],
  284: [["parallaxes", 0]],
  322: [
    ["characters", 1],
    ["faces", 3],
    ["sv_actors", 5]
  ],
  323: [["characters", 1]]
}
const eventAudio: Record<number, readonly [string, number]> = {
  132: ["bgm", 0],
  133: ["me", 0],
  139: ["me", 0],
  140: ["bgm", 1],
  241: ["bgm", 0],
  245: ["bgs", 0],
  249: ["me", 0],
  250: ["se", 0]
}
const databases: Record<string, true> = {
  actors: true,
  classes: true,
  skills: true,
  items: true,
  weapons: true,
  armors: true,
  enemies: true,
  troops: true,
  states: true,
  animations: true,
  tilesets: true,
  commonevents: true
}

function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function at(value: unknown, index: number): unknown {
  return Array.isArray(value) ? value[index] : undefined
}

/** Read only concrete stock database fields; source is relative to the game root. */
export function discoverData(
  value: unknown,
  source: string,
  engine: Engine,
  system: Record<string, unknown>
): Reference[] {
  const result: Reference[] = []
  const stem = posix.parse(source).name.toLowerCase()

  function images(
    record: Record<string, unknown>,
    fields: Record<string, string>,
    label: string
  ): void {
    for (const [field, folder] of Object.entries(fields)) {
      result.push(...image(folder, record[field], `${label}.${field}`))
    }
  }

  function sounds(
    record: Record<string, unknown>,
    fields: Record<string, string>,
    label: string
  ): void {
    for (const [field, folder] of Object.entries(fields)) {
      result.push(...audio(folder, record[field], `${label}.${field}`))
    }
  }

  function script(text: unknown, label: string): void {
    if (typeof text === "string" && text) result.push(...discoverText(text, "js", label))
  }

  function hint(text: unknown, label: string): void {
    // Bare note/plugin argument names have no dependable folder semantics.
    if (typeof text === "string" && text) script(JSON.stringify(text), label)
  }

  function route(value: unknown, label: string): void {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return
    const route = value as Record<string, unknown>
    for (const [index, entry] of items(route.list).entries()) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue
      const command = entry as Record<string, unknown>
      const where = `${label}.list[${index}].parameters[0]`
      if (command.code === 41) result.push(...image("characters", at(command.parameters, 0), where))
      else if (command.code === 44) result.push(...audio("se", at(command.parameters, 0), where))
      else if (command.code === 45) script(at(command.parameters, 0), where)
    }
  }

  function commands(value: unknown, label: string): void {
    if (!Array.isArray(value)) return
    let index = 0
    while (index < value.length) {
      const entry: unknown = value[index]
      const where = `${label}[${index}]`
      index += 1
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue
      const command = entry as Record<string, unknown>
      const code = command.code
      if (typeof code !== "number" || !Number.isInteger(code)) continue
      const params = command.parameters
      for (const [folder, position] of eventImages[code] ?? []) {
        result.push(...image(folder, at(params, position), `${where}.parameters[${position}]`))
      }
      const sound = eventAudio[code]
      if (sound) {
        const [folder, position] = sound
        result.push(...audio(folder, at(params, position), `${where}.parameters[${position}]`))
      }
      if (code === 205) route(at(params, 1), `${where}.parameters[1]`)
      else if (code === 261) {
        const name = at(params, 0)
        if (typeof name === "string" && name) {
          result.push(
            reference([`movies/${name}.webm`, `movies/${name}.mp4`], `${where}.parameters[0]`)
          )
        }
      } else if (code === 355 || code === 655) {
        const lines = [at(params, 0)]
        while (index < value.length) {
          const continuation: unknown = value[index]
          if (
            typeof continuation !== "object" ||
            continuation === null ||
            Array.isArray(continuation)
          )
            break
          const next = continuation as Record<string, unknown>
          if (next.code !== 655) break
          lines.push(at(next.parameters, 0))
          index += 1
        }
        script(
          lines.map((line) => (typeof line === "string" ? line : "")).join("\n"),
          `${where}.script`
        )
      } else if (code === 356) hint(at(params, 0), `${where}.parameters[0]`)
      else if (code === 357) {
        const args = at(params, 3)
        if (typeof args === "object" && args !== null && !Array.isArray(args)) {
          for (const [key, text] of Object.entries(args))
            hint(text, `${where}.parameters[3].${key}`)
        }
      }
    }
  }

  function pages(value: unknown, label: string): void {
    for (const [index, entry] of items(value).entries()) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue
      const page = entry as Record<string, unknown>
      const where = `${label}[${index}]`
      const character = page.image
      if (typeof character === "object" && character !== null && !Array.isArray(character)) {
        images(
          character as Record<string, unknown>,
          { characterName: "characters" },
          `${where}.image`
        )
      }
      route(page.moveRoute, `${where}.moveRoute`)
      commands(page.list, `${where}.list`)
    }
  }

  if (stem === "system" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    images(
      record,
      {
        title1Name: "titles1",
        title2Name: "titles2",
        battleback1Name: "battlebacks1",
        battleback2Name: "battlebacks2"
      },
      source
    )
    sounds(
      record,
      {
        battleBgm: "bgm",
        titleBgm: "bgm",
        defeatMe: "me",
        victoryMe: "me",
        gameoverMe: "me"
      },
      source
    )
    for (const [index, sound] of items(record.sounds).entries()) {
      result.push(...audio("se", sound, `${source}.sounds[${index}]`))
    }
    for (const field of ["boat", "ship", "airship"]) {
      const vehicle = record[field]
      if (typeof vehicle !== "object" || vehicle === null || Array.isArray(vehicle)) continue
      images(
        vehicle as Record<string, unknown>,
        { characterName: "characters" },
        `${source}.${field}`
      )
      sounds(vehicle as Record<string, unknown>, { bgm: "bgm" }, `${source}.${field}`)
    }
    const advanced = record.advanced
    if (
      engine === "MZ" &&
      typeof advanced === "object" &&
      advanced !== null &&
      !Array.isArray(advanced)
    ) {
      const fonts = advanced as Record<string, unknown>
      for (const field of ["mainFontFilename", "numberFontFilename"]) {
        const name = fonts[field]
        if (typeof name === "string" && name)
          result.push(reference([`fonts/${name}`], `${source}.advanced.${field}`))
      }
    }
  } else if (
    /^map\d+$/.test(stem) &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const map = value as Record<string, unknown>
    images(map, { parallaxName: "parallaxes" }, source)
    if (map.specifyBattleback !== false) {
      images(map, { battleback1Name: "battlebacks1", battleback2Name: "battlebacks2" }, source)
    }
    for (const [field, flag] of [
      ["bgm", "autoplayBgm"],
      ["bgs", "autoplayBgs"]
    ] as const) {
      if (map[flag] !== false) sounds(map, { [field]: field }, source)
    }
    hint(map.note, `${source}.note`)
    for (const [index, entry] of items(map.events).entries()) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue
      const event = entry as Record<string, unknown>
      const where = `${source}.events[${index}]`
      hint(event.note, `${where}.note`)
      pages(event.pages, `${where}.pages`)
    }
  } else if (Object.hasOwn(databases, stem)) {
    for (const [index, entry] of items(value).entries()) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue
      const record = entry as Record<string, unknown>
      const where = `${source}[${index}]`
      hint(record.note, `${where}.note`)
      if (stem === "actors") {
        images(
          record,
          { characterName: "characters", faceName: "faces", battlerName: "sv_actors" },
          where
        )
      } else if (stem === "enemies") {
        images(record, { battlerName: system.optSideView ? "sv_enemies" : "enemies" }, where)
      } else if (stem === "tilesets") {
        for (const [tileIndex, name] of items(record.tilesetNames).entries()) {
          result.push(...image("tilesets", name, `${where}.tilesetNames[${tileIndex}]`))
        }
      } else if (stem === "animations") {
        images(record, { animation1Name: "animations", animation2Name: "animations" }, where)
        for (const [timingIndex, timing] of items(record.timings).entries()) {
          if (typeof timing === "object" && timing !== null && !Array.isArray(timing)) {
            sounds(
              timing as Record<string, unknown>,
              { se: "se" },
              `${where}.timings[${timingIndex}]`
            )
          }
        }
        if (engine === "MZ") {
          const name = record.effectName
          if (typeof name === "string" && name)
            result.push(reference([`effects/${name}.efkefc`], `${where}.effectName`))
          for (const [timingIndex, timing] of items(record.soundTimings).entries()) {
            if (typeof timing === "object" && timing !== null && !Array.isArray(timing)) {
              sounds(
                timing as Record<string, unknown>,
                { se: "se" },
                `${where}.soundTimings[${timingIndex}]`
              )
            }
          }
        }
      } else if (stem === "commonevents") commands(record.list, `${where}.list`)
      else if (stem === "troops") pages(record.pages, `${where}.pages`)
    }
  }
  return result
}
