import { fileURLToPath } from "node:url"

const buildOptions = {
  entrypoints: [fileURLToPath(new URL("../src/electron/main.ts", import.meta.url)), fileURLToPath(new URL("../src/electron/preload.ts", import.meta.url))],
  outdir: fileURLToPath(new URL("../dist/electron", import.meta.url)),
  target: "node" as const,
  format: "esm" as const,
  external: ["electron", "@anthropic-ai/claude-agent-sdk", "zod"],
  sourcemap: "external" as const,
}

export async function buildElectron() {
  const result = await Bun.build(buildOptions)

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log)
    }
    throw new Error("Electron build failed")
  }
}

if (import.meta.main) {
  try {
    await buildElectron()
  } catch {
    process.exit(1)
  }
}
