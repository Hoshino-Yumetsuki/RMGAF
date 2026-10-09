import { z } from "zod"

export const maxVmBytes = 64 * 1024 * 1024

export const VmInput = z.object({
  files: z.array(z.tuple([z.string(), z.string()])),
  targets: z.array(z.string()),
  plugins: z.array(z.object({ name: z.string(), parameters: z.record(z.string(), z.unknown()) })),
  loaders: z.array(z.object({ name: z.string(), code: z.string() }))
})
export type VmInput = z.infer<typeof VmInput>

export const VmOutput = z.object({
  data: z.array(z.tuple([z.string(), z.unknown()])),
  errors: z.array(z.tuple([z.string(), z.string()])),
  requests: z.array(z.string())
})
export type VmOutput = z.infer<typeof VmOutput>
