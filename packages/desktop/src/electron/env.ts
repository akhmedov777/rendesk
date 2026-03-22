import { promises as fs } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { assertManagedDesktopConfig, missingManagedDesktopConfigKeys } from "./managed-config.js"

const currentDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(currentDir, "../../../../")
const envLocalPath = join(repoRoot, ".env.local")

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/

function parseEnvValue(raw: string) {
  const value = raw.trim()
  if (!value) return ""

  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string
    } catch {
      return value.slice(1, -1)
    }
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1)
  }

  const inlineCommentIndex = value.indexOf(" #")
  return inlineCommentIndex >= 0 ? value.slice(0, inlineCommentIndex).trim() : value
}

function parseEnvFile(raw: string) {
  const entries: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(ENV_LINE)
    if (!match) continue
    entries[match[1]] = parseEnvValue(match[2] ?? "")
  }
  return entries
}

function applyEnv(entries: Record<string, string>) {
  for (const [key, value] of Object.entries(entries)) {
    if (process.env[key] !== undefined) continue
    process.env[key] = value
  }
}

export async function bootstrapDesktopEnv(input: { packaged?: boolean } = {}) {
  const packaged = Boolean(input.packaged)

  if (!packaged) {
    const envLocal = await fs.readFile(envLocalPath, "utf8").catch(() => "")
    applyEnv(parseEnvFile(envLocal))
  }

  const managed = assertManagedDesktopConfig({ packaged })
  const missing = missingManagedDesktopConfigKeys(managed)

  return {
    repoRoot,
    envLocalPath,
    managed,
    missing,
  } as const
}
