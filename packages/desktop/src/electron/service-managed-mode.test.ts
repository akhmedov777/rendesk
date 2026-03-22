import { afterEach, describe, expect, test } from "bun:test"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLocalService } from "./service"

const createdDirs: string[] = []
const envSnapshot = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
}

const createTempDir = async () => {
  const directory = await mkdtemp(join(tmpdir(), "rendesk-service-managed-"))
  createdDirs.push(directory)
  return directory
}

const setManagedEnv = () => {
  process.env.ANTHROPIC_API_KEY = "managed-anthropic-key"
}

const rpc = async (serviceUrl: string, action: string, input?: unknown) => {
  const response = await fetch(`${serviceUrl}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ action, input }),
  })
  return {
    status: response.status,
    payload: (await response.json()) as Record<string, unknown>,
  }
}

afterEach(async () => {
  process.env.ANTHROPIC_API_KEY = envSnapshot.ANTHROPIC_API_KEY
  await Promise.all(createdDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("desktop service managed mode", () => {
  test("rejects provider auth mutation RPCs", async () => {
    setManagedEnv()
    const userDataPath = await createTempDir()
    const service = await createLocalService({ userDataPath })

    try {
      const authSet = await rpc(service.url, "auth.set", {
        providerID: "anthropic",
        auth: { type: "api", key: "user-supplied-key" },
      })
      expect(authSet.status).toBe(400)
      expect(String((authSet.payload.error as { message?: string }).message)).toContain("managed by infrastructure")

      const authRemove = await rpc(service.url, "auth.remove", { providerID: "anthropic" })
      expect(authRemove.status).toBe(400)
      expect(String((authRemove.payload.error as { message?: string }).message)).toContain("managed by infrastructure")

      const providerAuth = await rpc(service.url, "provider.auth")
      expect(providerAuth.status).toBe(200)
      expect(providerAuth.payload.data).toEqual({})

      const providerList = await rpc(service.url, "provider.list")
      expect(providerList.status).toBe(200)
      const providerPayload = providerList.payload.data as { connected?: string[]; all?: Array<{ id: string; source?: string }> }
      expect(providerPayload.connected).toEqual(["anthropic"])
      expect(providerPayload.all?.[0]?.id).toBe("anthropic")
      expect(providerPayload.all?.[0]?.source).toBe("config")
    } finally {
      await service.close()
    }
  })

  test("integrations endpoint returns editor enabled status", async () => {
    setManagedEnv()
    const userDataPath = await createTempDir()
    const service = await createLocalService({ userDataPath })

    try {
      const response = await fetch(`${service.url}/api/integrations`)
      expect(response.ok).toBe(true)
      const payload = (await response.json()) as { editor?: { enabled?: boolean } }
      expect(payload.editor?.enabled).toBe(true)
    } finally {
      await service.close()
    }
  })

  test("removes legacy provider-auth file during startup", async () => {
    setManagedEnv()
    const userDataPath = await createTempDir()
    const legacyAuthPath = join(userDataPath, "provider-auth.json")
    await writeFile(legacyAuthPath, JSON.stringify({ anthropic: { type: "api", key: "stale-key" } }), "utf8")

    const service = await createLocalService({ userDataPath })
    await service.close()

    const exists = await access(legacyAuthPath)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })
})
