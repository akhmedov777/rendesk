import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLocalService } from "./service"

const createdDirs: string[] = []

const createTempDir = async (prefix: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  createdDirs.push(directory)
  return directory
}

const rpc = async (serviceUrl: string, action: string, input?: unknown, directory?: string) => {
  const response = await fetch(`${serviceUrl}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      action,
      input,
      directory,
    }),
  })
  return {
    status: response.status,
    payload: (await response.json()) as Record<string, any>,
  }
}

const waitFor = async <T>(callback: () => Promise<T | undefined>, timeoutMs = 7000, intervalMs = 60) => {
  const started = Date.now()
  for (;;) {
    const value = await callback()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition")
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
}

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("desktop service automations", () => {
  test("enforces minimum schedule frequency and computes timezone-aware nextRunAt", async () => {
    const userDataPath = await createTempDir("rendesk-automation-state-")
    const workspace = await createTempDir("rendesk-automation-workspace-")
    await mkdir(workspace, { recursive: true })

    const service = await createLocalService({ userDataPath })
    try {
      const tooFrequent = await rpc(
        service.url,
        "automation.create",
        {
          name: "Too Frequent",
          prompt: "ping",
          cron: "*/10 * * * *",
          timezone: "UTC",
        },
        workspace,
      )
      expect(tooFrequent.status).toBeGreaterThanOrEqual(400)
      expect(String(tooFrequent.payload.error?.message ?? "")).toContain("15 minutes")

      const created = await rpc(
        service.url,
        "automation.create",
        {
          name: "Quarter-hour",
          prompt: "ping",
          cron: "*/15 * * * *",
          timezone: "UTC",
        },
        workspace,
      )
      expect(created.status).toBe(200)
      expect(typeof created.payload.data?.nextRunAt).toBe("number")
      expect(created.payload.data?.nextRunAt).toBeGreaterThan(Date.now())
    } finally {
      await service.close()
    }
  })

  test("runs startup catch-up at most once per automation and advances nextRunAt", async () => {
    const userDataPath = await createTempDir("rendesk-automation-catchup-state-")
    const workspace = await createTempDir("rendesk-automation-catchup-workspace-")
    await mkdir(workspace, { recursive: true })

    const now = Date.now()
    await writeFile(
      join(userDataPath, "backoffice-state.json"),
      JSON.stringify(
        {
          automations: {
            [workspace]: [
              {
                id: "automation_seed",
                directory: workspace,
                name: "Startup catch-up",
                prompt: "Summarize workspace status.",
                cron: "*/15 * * * *",
                timezone: "UTC",
                status: "active",
                time: {
                  created: now - 2_000,
                  updated: now - 1_000,
                },
                nextRunAt: now - 60 * 60_000,
              },
            ],
          },
          automationRuns: {},
        },
        null,
        2,
      ),
      "utf8",
    )

    const firstService = await createLocalService({ userDataPath })
    try {
      const runs = await waitFor(async () => {
        const result = await rpc(
          firstService.url,
          "automation.run.list",
          {
            automationID: "automation_seed",
            limit: 10,
          },
          workspace,
        )
        const data = Array.isArray(result.payload.data) ? result.payload.data : []
        if (data.length === 0) return undefined
        return data
      })
      expect(runs.length).toBe(1)

      const automationResult = await rpc(
        firstService.url,
        "automation.get",
        {
          automationID: "automation_seed",
        },
        workspace,
      )
      expect(automationResult.status).toBe(200)
      expect(automationResult.payload.data?.nextRunAt).toBeGreaterThan(Date.now())
    } finally {
      await firstService.close()
    }

    const secondService = await createLocalService({ userDataPath })
    try {
      const result = await rpc(
        secondService.url,
        "automation.run.list",
        {
          automationID: "automation_seed",
          limit: 10,
        },
        workspace,
      )
      const runs = Array.isArray(result.payload.data) ? result.payload.data : []
      expect(runs.length).toBe(1)
    } finally {
      await secondService.close()
    }
  })

  test("marks concurrent run triggers with skipped_lock", async () => {
    const userDataPath = await createTempDir("rendesk-automation-lock-state-")
    const workspace = await createTempDir("rendesk-automation-lock-workspace-")
    await mkdir(workspace, { recursive: true })
    const service = await createLocalService({ userDataPath })

    try {
      const created = await rpc(
        service.url,
        "automation.create",
        {
          name: "Lock test",
          prompt: "Output a single line and stop.",
          cron: "*/15 * * * *",
          timezone: "UTC",
        },
        workspace,
      )
      expect(created.status).toBe(200)
      const automationID = String(created.payload.data?.id)

      await Promise.all([
        rpc(service.url, "automation.run", { automationID }, workspace),
        rpc(service.url, "automation.run", { automationID }, workspace),
      ])

      const runs = await waitFor(async () => {
        const result = await rpc(
          service.url,
          "automation.run.list",
          {
            automationID,
            limit: 10,
          },
          workspace,
        )
        const data = Array.isArray(result.payload.data) ? result.payload.data : []
        if (data.length < 2) return undefined
        return data
      })

      const statuses = runs.map((run) => run.status)
      expect(statuses).toContain("skipped_lock")
      expect(statuses.some((status) => status !== "skipped_lock")).toBe(true)
    } finally {
      await service.close()
    }
  })

  test("supports automation CRUD and run history retrieval RPC flows", async () => {
    const userDataPath = await createTempDir("rendesk-automation-crud-state-")
    const workspace = await createTempDir("rendesk-automation-crud-workspace-")
    await mkdir(workspace, { recursive: true })
    const service = await createLocalService({ userDataPath })

    try {
      const createResponse = await rpc(
        service.url,
        "automation.create",
        {
          name: "RPC flow",
          prompt: "Summarize files.",
          cron: "*/15 * * * *",
          timezone: "UTC",
          status: "paused",
        },
        workspace,
      )
      expect(createResponse.status).toBe(200)
      const automationID = String(createResponse.payload.data?.id)

      const listResponse = await rpc(service.url, "automation.list", {}, workspace)
      expect(listResponse.status).toBe(200)
      expect(Array.isArray(listResponse.payload.data?.automations)).toBe(true)
      expect(listResponse.payload.data.automations.length).toBe(1)

      const getResponse = await rpc(service.url, "automation.get", { automationID }, workspace)
      expect(getResponse.status).toBe(200)
      expect(getResponse.payload.data?.id).toBe(automationID)

      const updateResponse = await rpc(
        service.url,
        "automation.update",
        {
          automationID,
          status: "active",
          name: "RPC flow updated",
        },
        workspace,
      )
      expect(updateResponse.status).toBe(200)
      expect(updateResponse.payload.data?.name).toBe("RPC flow updated")

      const runListResponse = await rpc(
        service.url,
        "automation.run.list",
        {
          automationID,
          limit: 10,
        },
        workspace,
      )
      expect(runListResponse.status).toBe(200)
      expect(Array.isArray(runListResponse.payload.data)).toBe(true)

      const deleteResponse = await rpc(service.url, "automation.delete", { automationID }, workspace)
      expect(deleteResponse.status).toBe(200)
      expect(deleteResponse.payload.data).toBe(true)
    } finally {
      await service.close()
    }
  })
})
