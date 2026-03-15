import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOnlyOfficeApiHandlers } from "./http-handlers"
import { signEditorJwt } from "./config"
import type { EditorIntegrationConfig } from "./types"

type StartedServer = {
  url: string
  close: () => Promise<void>
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void,
): Promise<StartedServer> {
  const server = createServer(handler)
  const address = await new Promise<{ port: number }>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const value = server.address()
      if (!value || typeof value === "string") {
        reject(new Error("Could not resolve server address"))
        return
      }
      resolve({ port: value.port })
    })
    server.on("error", reject)
  })

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      }),
  }
}

describe("onlyoffice http handlers", () => {
  let tempDir = ""
  let integration: EditorIntegrationConfig

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "onlyoffice-handlers-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = await mkdtemp(join(tmpdir(), "onlyoffice-handlers-"))
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  const createHandlers = () => {
    integration = {
      enabled: true,
      documentServerUrl: "https://docs.example.com",
      jwtSecret: "secret",
      callbackBaseUrl: "https://callback.example.com",
      autoTunnelEnabled: true,
    }

    return createOnlyOfficeApiHandlers({
      getConfig: () => integration,
      getIngressPort: () => 31339,
      ensureTunnelReady: async () => ({ baseUrl: "https://tunnel.example.com" }),
      getTunnelState: () => ({ status: "idle" }),
      reconnectTunnel: async () => ({ baseUrl: "https://tunnel.example.com" }),
      fetchExternal: async () =>
        new Response(Uint8Array.from([0x50]), {
          status: 206,
          headers: {
            "content-type": "application/octet-stream",
            "content-range": "bytes 0-0/1",
          },
        }),
    })
  }

  test("returns pdf configs in view mode", async () => {
    const filePath = join(tempDir, "report.pdf")
    await writeFile(filePath, "pdf-data", "utf8")
    const handlers = createHandlers()
    const server = await startServer((request, response) => {
      if ((request.url ?? "").startsWith("/api/editor/config")) {
        return handlers.handleConfig(request, response)
      }
      response.writeHead(404)
      response.end()
    })

    try {
      const response = await fetch(`${server.url}/api/editor/config?filePath=${encodeURIComponent(filePath)}`)
      const payload = (await response.json()) as Record<string, any>

      expect(response.ok).toBe(true)
      expect(payload.docServerUrl).toBe("https://docs.example.com")
      expect(payload.transportMode).toBe("manual")
      expect(payload.config.documentType).toBe("pdf")
      expect(payload.config.editorConfig.mode).toBe("view")
    } finally {
      await server.close()
    }
  })

  test("rejects invalid download tokens", async () => {
    const filePath = join(tempDir, "report.docx")
    await writeFile(filePath, "content", "utf8")
    const handlers = createHandlers()
    const server = await startServer((request, response) => {
      if ((request.url ?? "").startsWith("/api/editor/download")) {
        return handlers.handleDownload(request, response)
      }
      response.writeHead(404)
      response.end()
    })

    try {
      const response = await fetch(
        `${server.url}/api/editor/download?filePath=${encodeURIComponent(filePath)}&token=bad`,
      )
      expect(response.status).toBe(403)
    } finally {
      await server.close()
    }
  })

  test("supports HEAD requests for document downloads", async () => {
    const filePath = join(tempDir, "report.docx")
    await writeFile(filePath, "content", "utf8")
    const handlers = createHandlers()
    const server = await startServer((request, response) => {
      if ((request.url ?? "").startsWith("/api/editor/download")) {
        return handlers.handleDownload(request, response)
      }
      response.writeHead(404)
      response.end()
    })

    try {
      const token = signEditorJwt({ filePath, action: "download" }, integration.jwtSecret)
      const response = await fetch(`${server.url}/api/editor/download?filePath=${encodeURIComponent(filePath)}&token=${token}`, {
        method: "HEAD",
      })

      expect(response.ok).toBe(true)
      expect(response.headers.get("accept-ranges")).toBe("bytes")
      expect(response.headers.get("content-length")).toBe(String("content".length))
      expect(await response.text()).toBe("")
    } finally {
      await server.close()
    }
  })

  test("supports byte-range requests for document downloads", async () => {
    const filePath = join(tempDir, "report.docx")
    await writeFile(filePath, "content", "utf8")
    const handlers = createHandlers()
    const server = await startServer((request, response) => {
      if ((request.url ?? "").startsWith("/api/editor/download")) {
        return handlers.handleDownload(request, response)
      }
      response.writeHead(404)
      response.end()
    })

    try {
      const token = signEditorJwt({ filePath, action: "download" }, integration.jwtSecret)
      const response = await fetch(`${server.url}/api/editor/download?filePath=${encodeURIComponent(filePath)}&token=${token}`, {
        headers: {
          range: "bytes=1-3",
        },
      })

      expect(response.status).toBe(206)
      expect(response.headers.get("content-range")).toBe("bytes 1-3/7")
      expect(await response.text()).toBe("ont")
    } finally {
      await server.close()
    }
  })

  test("writes callback downloads back to the local file", async () => {
    const filePath = join(tempDir, "report.docx")
    await writeFile(filePath, "before", "utf8")
    const handlers = createHandlers()
    const downloadServer = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" })
      response.end("after")
    })
    const callbackServer = await startServer((request, response) => {
      if ((request.url ?? "").startsWith("/api/editor/callback")) {
        return handlers.handleCallbackPost(request, response)
      }
      response.writeHead(404)
      response.end()
    })

    try {
      const token = signEditorJwt({ filePath, action: "callback" }, integration.jwtSecret)
      const response = await fetch(`${callbackServer.url}/api/editor/callback?token=${token}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status: 2,
          url: `${downloadServer.url}/updated`,
        }),
      })

      expect(response.ok).toBe(true)
      expect(await readFile(filePath, "utf8")).toBe("after")
    } finally {
      await callbackServer.close()
      await downloadServer.close()
    }
  })

  test("serves downloads for non-ascii filenames without invalid header errors", async () => {
    const filePath = join(tempDir, "Книга1_PRICED.xlsx")
    await writeFile(filePath, "sheet-data", "utf8")
    const handlers = createHandlers()
    const server = await startServer((request, response) => {
      if ((request.url ?? "").startsWith("/api/editor/download")) {
        return handlers.handleDownload(request, response)
      }
      response.writeHead(404)
      response.end()
    })

    try {
      const token = signEditorJwt({ filePath, action: "download" }, integration.jwtSecret)
      const response = await fetch(
        `${server.url}/api/editor/download?filePath=${encodeURIComponent(filePath)}&token=${token}`,
      )

      expect(response.ok).toBe(true)
      expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''")
      expect(await response.text()).toBe("sheet-data")
    } finally {
      await server.close()
    }
  })

  test("fails config early when the hosted download endpoint cannot be verified", async () => {
    const filePath = join(tempDir, "report.docx")
    await writeFile(filePath, "content", "utf8")
    const handlers = createOnlyOfficeApiHandlers({
      getConfig: () => ({
        enabled: true,
        documentServerUrl: "https://docs.example.com",
        jwtSecret: "secret",
        callbackBaseUrl: "https://callback.example.com",
        autoTunnelEnabled: true,
      }),
      getIngressPort: () => 31339,
      ensureTunnelReady: async () => ({ baseUrl: "https://tunnel.example.com" }),
      getTunnelState: () => ({ status: "idle" }),
      reconnectTunnel: async () => ({ baseUrl: "https://tunnel.example.com" }),
      fetchExternal: async () =>
        new Response("<html>blocked</html>", {
          status: 200,
          headers: {
            "content-type": "text/html",
          },
        }),
    })
    const server = await startServer((request, response) => {
      if ((request.url ?? "").startsWith("/api/editor/config")) {
        return handlers.handleConfig(request, response)
      }
      response.writeHead(404)
      response.end()
    })

    try {
      const response = await fetch(`${server.url}/api/editor/config?filePath=${encodeURIComponent(filePath)}`)
      const payload = (await response.json()) as Record<string, unknown>

      expect(response.status).toBe(503)
      expect(payload.code).toBe("EDITOR_DOWNLOAD_UNREACHABLE")
    } finally {
      await server.close()
    }
  })
})
