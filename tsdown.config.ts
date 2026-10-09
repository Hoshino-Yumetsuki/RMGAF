import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/cli.ts", "src/vm-worker.ts"],
  platform: "node",
  target: "node22",
  format: "esm",
  fixedExtension: true,
  clean: true,
  dts: false,
  sourcemap: true,
  minify: true
})
