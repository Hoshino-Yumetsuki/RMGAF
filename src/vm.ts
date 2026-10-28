import type { Engine, Runtime } from "moejs-wasm"

export function createRuntime(engine: Engine): Promise<Runtime> {
  return engine.newRuntime({
    eventLoop: false,
    mutableIntrinsics: true,
    disableDynamicCode: true,
    memoryLimit: 768 * 1024 * 1024,
    // Node workers enforce wall-clock deadlines without rejecting large decoders by step count.
    maxSteps: 0
  })
}

export async function runScript(
  engine: Engine,
  runtime: Runtime,
  filename: string,
  source: string,
  timeoutMs: number
): Promise<unknown> {
  const script = await engine.compileScript(filename, source, { timeoutMs })
  return runtime.runScript(script, { timeoutMs })
}
