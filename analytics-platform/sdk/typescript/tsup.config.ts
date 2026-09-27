import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  // tsup's declaration bundler sets `baseUrl`, which TypeScript 6 flags as deprecated.
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  sourcemap: true,
  clean: true,
  target: "es2022",
  platform: "neutral",
  treeshake: true,
});
