export type Engine = "MV" | "MZ"

export interface Reference {
  paths: string[]
  source: string
  required: boolean
  encrypted: boolean
}

export function reference(
  paths: string[],
  source: string,
  required = true,
  encrypted = false
): Reference {
  return { paths, source, required, encrypted }
}

export function image(folder: string, name: unknown, source: string, required = true): Reference[] {
  return typeof name === "string" && name
    ? [reference([`img/${folder}/${name}.png`], source, required, true)]
    : []
}

export function audio(
  folder: string,
  value: unknown,
  source: string,
  required = true
): Reference[] {
  const name = typeof value === "object" && value !== null && "name" in value ? value.name : value
  return typeof name === "string" && name
    ? [
        reference(
          [`audio/${folder}/${name}.ogg`, `audio/${folder}/${name}.m4a`],
          source,
          required,
          true
        )
      ]
    : []
}

export interface Plugin {
  name: string
  status: boolean
  parameters?: Record<string, unknown>
}

export interface DecodeResult {
  data: Map<string, unknown>
  errors: Map<string, string>
  loaders: string[]
  requests: string[]
  warnings?: string[]
}

export type Decoder = (root: string, files: readonly string[]) => Promise<DecodeResult>
