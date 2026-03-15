import { promises as fs } from "node:fs"
import { dirname, join } from "node:path"

type ProviderAuthRecord = Record<
  string,
  {
    type: "api"
    key: string
  }
>

type PersistedProviderAuthFile =
  | {
      version: 1
      mode: "plain"
      payload: ProviderAuthRecord
    }
  | {
      version: 1
      mode: "safeStorage"
      payload: string
    }

export type ProviderAuthCrypto = {
  isEncryptionAvailable(): boolean
  encryptString(value: string): string
  decryptString(value: string): string
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const normalizeRecord = (value: unknown): ProviderAuthRecord => {
  if (!isPlainObject(value)) return {}

  const entries = Object.entries(value).flatMap(([providerID, auth]) => {
    if (!isPlainObject(auth) || auth.type !== "api" || typeof auth.key !== "string") return []
    const key = auth.key.trim()
    if (!key) return []
    return [[providerID, { type: "api" as const, key }]]
  })

  return Object.fromEntries(entries)
}

const parsePersistedFile = (raw: string, crypto?: ProviderAuthCrypto): ProviderAuthRecord => {
  if (!raw) return {}

  try {
    const parsed = JSON.parse(raw) as PersistedProviderAuthFile | ProviderAuthRecord

    if (isPlainObject(parsed) && parsed.version === 1 && parsed.mode === "plain") {
      return normalizeRecord(parsed.payload)
    }

    if (isPlainObject(parsed) && parsed.version === 1 && parsed.mode === "safeStorage" && typeof parsed.payload === "string") {
      if (!crypto?.isEncryptionAvailable()) return {}
      const decrypted = crypto.decryptString(parsed.payload)
      return normalizeRecord(JSON.parse(decrypted))
    }

    return normalizeRecord(parsed)
  } catch {
    return {}
  }
}

const serializePersistedFile = (value: ProviderAuthRecord, crypto?: ProviderAuthCrypto): PersistedProviderAuthFile => {
  if (crypto?.isEncryptionAvailable()) {
    return {
      version: 1,
      mode: "safeStorage",
      payload: crypto.encryptString(JSON.stringify(value)),
    }
  }

  return {
    version: 1,
    mode: "plain",
    payload: value,
  }
}

export function createProviderAuthStore(input: { userDataPath: string; crypto?: ProviderAuthCrypto }) {
  const path = join(input.userDataPath, "provider-auth.json")
  let cache: ProviderAuthRecord | undefined

  const read = async () => {
    if (cache) return { ...cache }

    const raw = await fs.readFile(path, "utf8").catch(() => "")
    cache = parsePersistedFile(raw, input.crypto)
    return { ...cache }
  }

  const write = async (next: ProviderAuthRecord) => {
    cache = { ...next }
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, JSON.stringify(serializePersistedFile(cache, input.crypto), null, 2), "utf8")
  }

  return {
    path,
    async getApiKey(providerID: string) {
      const record = await read()
      return record[providerID]?.key ?? null
    },
    async setApiKey(providerID: string, key: string) {
      const trimmed = key.trim()
      if (!trimmed) {
        throw new Error("API key is required")
      }

      const record = await read()
      record[providerID] = {
        type: "api",
        key: trimmed,
      }
      await write(record)
    },
    async remove(providerID: string) {
      const record = await read()
      if (!(providerID in record)) return false
      delete record[providerID]
      await write(record)
      return true
    },
  }
}

export type ProviderAuthStore = ReturnType<typeof createProviderAuthStore>
