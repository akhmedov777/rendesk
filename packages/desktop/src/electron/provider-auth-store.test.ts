import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProviderAuthStore } from "./provider-auth-store"

const createdDirs: string[] = []

const createTempDir = async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-desktop-auth-"))
  createdDirs.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("createProviderAuthStore", () => {
  test("persists API keys in plain mode when encryption is unavailable", async () => {
    const userDataPath = await createTempDir()
    const store = createProviderAuthStore({ userDataPath })

    await store.setApiKey("anthropic", " test-key ")

    expect(await store.getApiKey("anthropic")).toBe("test-key")

    const raw = await readFile(join(userDataPath, "provider-auth.json"), "utf8")
    expect(raw).toContain('"mode": "plain"')
    expect(raw).toContain('"key": "test-key"')
  })

  test("encrypts persisted credentials when safe storage is available", async () => {
    const userDataPath = await createTempDir()
    const crypto = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`enc:${value}`, "utf8").toString("base64"),
      decryptString: (value: string) => {
        const decoded = Buffer.from(value, "base64").toString("utf8")
        if (!decoded.startsWith("enc:")) throw new Error("Invalid payload")
        return decoded.slice(4)
      },
    }

    const store = createProviderAuthStore({ userDataPath, crypto })
    await store.setApiKey("anthropic", "encrypted-key")

    const raw = await readFile(join(userDataPath, "provider-auth.json"), "utf8")
    expect(raw).toContain('"mode": "safeStorage"')
    expect(raw).not.toContain("encrypted-key")

    const reopened = createProviderAuthStore({ userDataPath, crypto })
    expect(await reopened.getApiKey("anthropic")).toBe("encrypted-key")
  })

  test("removes persisted credentials", async () => {
    const userDataPath = await createTempDir()
    const store = createProviderAuthStore({ userDataPath })

    await store.setApiKey("anthropic", "test-key")
    expect(await store.remove("anthropic")).toBe(true)
    expect(await store.getApiKey("anthropic")).toBeNull()
    expect(await store.remove("anthropic")).toBe(false)
  })
})
