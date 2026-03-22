import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const REQUIRED_BUILD_ENV = ["ANTHROPIC_API_KEY"] as const

const trim = (value: string | undefined) => value?.trim() ?? ""

const readManagedBuildEnv = () => {
  const values = {
    ANTHROPIC_API_KEY: trim(process.env.ANTHROPIC_API_KEY),
  }

  const missing = REQUIRED_BUILD_ENV.filter((key) => !values[key])
  if (missing.length > 0) {
    throw new Error(
      `Missing required managed desktop env keys for build-time injection: ${missing.join(", ")}.`,
    )
  }

  return values
}

const validateResources = () => {
  const resourcesDir = fileURLToPath(new URL("../resources", import.meta.url))
  const converterPath = join(resourcesDir, "converter", "x2t")
  const editorsPath = join(resourcesDir, "editors")
  const fontsPath = join(resourcesDir, "fonts")

  const pyodidePath = join(resourcesDir, "pyodide", "pyodide.asm.wasm")

  const missing: string[] = []
  if (!existsSync(converterPath)) missing.push("resources/converter/x2t")
  if (!existsSync(editorsPath)) missing.push("resources/editors/")
  if (!existsSync(fontsPath)) missing.push("resources/fonts/")
  if (!existsSync(pyodidePath)) missing.push("resources/pyodide/pyodide.asm.wasm")

  if (missing.length > 0) {
    throw new Error(
      `Missing required editor resources: ${missing.join(", ")}. Run 'bun scripts/download-x2t.ts', 'bun scripts/generate-fonts.ts', and 'bun scripts/download-pyodide.ts' first.`,
    )
  }
}

const createBuildOptions = (env: ReturnType<typeof readManagedBuildEnv>) => ({
  entrypoints: [
    fileURLToPath(new URL("../src/electron/main.ts", import.meta.url)),
    fileURLToPath(new URL("../src/electron/preload.ts", import.meta.url)),
  ],
  outdir: fileURLToPath(new URL("../dist/electron", import.meta.url)),
  target: "node" as const,
  format: "esm" as const,
  external: ["electron", "@anthropic-ai/claude-agent-sdk", "zod"],
  sourcemap: "external" as const,
  define: {
    "process.env.ANTHROPIC_API_KEY": JSON.stringify(env.ANTHROPIC_API_KEY),
    "process.env.ANTHROPIC_AUTH_TOKEN": JSON.stringify(""),
  },
})

export async function buildElectron() {
  const managedEnv = readManagedBuildEnv()
  validateResources()
  const result = await Bun.build(createBuildOptions(managedEnv))

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
