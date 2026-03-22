import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEditorApiHandlers } from "./http-handlers"

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

describe("editor http handlers", () => {
  let tempDir = ""
  let resourcesDir = ""
  let cacheDir = ""
  let fontsDir = ""

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "editor-handlers-"))
    resourcesDir = join(tempDir, "editors")
    cacheDir = join(tempDir, "cache")
    fontsDir = join(tempDir, "fonts")
    mkdirSync(resourcesDir, { recursive: true })
    mkdirSync(cacheDir, { recursive: true })
    mkdirSync(fontsDir, { recursive: true })

    // Create a minimal offline-loader.html
    writeFileSync(
      join(resourcesDir, "offline-loader.html"),
      "<html><body>loader</body></html>",
      "utf8",
    )

    // Create a minimal AllFonts.js
    writeFileSync(join(fontsDir, "AllFonts.js"), "window.__AllFonts__=[];", "utf8")
  })

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
    mkdirSync(cacheDir, { recursive: true })
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  const createHandlers = () =>
    createEditorApiHandlers({
      getResourcesPath: () => resourcesDir,
      getConverterPath: () => join(tempDir, "converter"),
      getCachePath: () => cacheDir,
      getFontDataPath: () => fontsDir,
      getFontSelectionPath: () => join(fontsDir, "font_selection.bin"),
    })

  test("handleEditorOpen serves offline-loader HTML for valid file", async () => {
    const filePath = join(tempDir, "report.docx")
    await writeFile(filePath, "content", "utf8")
    const handlers = createHandlers()
    const server = await startServer((request, response) => {
      if ((request.url ?? "").startsWith("/api/editor/open")) {
        return handlers.handleEditorOpen(request, response)
      }
      response.writeHead(404)
      response.end()
    })

    try {
      const response = await fetch(`${server.url}/api/editor/open?filePath=${encodeURIComponent(filePath)}`)
      expect(response.ok).toBe(true)
      expect(response.headers.get("content-type")).toContain("text/html")
      const body = await response.text()
      expect(body).toContain("loader")
    } finally {
      await server.close()
    }
  })

  test("handleEditorOpen rejects unsupported file types", async () => {
    const filePath = join(tempDir, "readme.txt")
    await writeFile(filePath, "hello", "utf8")
    const handlers = createHandlers()
    const server = await startServer((request, response) => {
      return handlers.handleEditorOpen(request, response)
    })

    try {
      const response = await fetch(`${server.url}/api/editor/open?filePath=${encodeURIComponent(filePath)}`)
      expect(response.status).toBe(400)
      const payload = (await response.json()) as { code?: string }
      expect(payload.code).toBe("EDITOR_FILE_TYPE_UNSUPPORTED")
    } finally {
      await server.close()
    }
  })

  test("handleEditorOpen returns 400 when filePath is missing", async () => {
    const handlers = createHandlers()
    const server = await startServer((request, response) => {
      return handlers.handleEditorOpen(request, response)
    })

    try {
      const response = await fetch(`${server.url}/api/editor/open`)
      expect(response.status).toBe(400)
    } finally {
      await server.close()
    }
  })

  test("handleEditorOpen returns 404 when file does not exist", async () => {
    const handlers = createHandlers()
    const server = await startServer((request, response) => {
      return handlers.handleEditorOpen(request, response)
    })

    try {
      const response = await fetch(`${server.url}/api/editor/open?filePath=${encodeURIComponent("/nonexistent/file.docx")}`)
      expect(response.status).toBe(404)
    } finally {
      await server.close()
    }
  })

  test("handleFileMtime returns file modification time", async () => {
    const filePath = join(tempDir, "test.xlsx")
    await writeFile(filePath, "data", "utf8")
    const handlers = createHandlers()
    const server = await startServer((request, response) => {
      return handlers.handleFileMtime(request, response)
    })

    try {
      const response = await fetch(`${server.url}/?filePath=${encodeURIComponent(filePath)}`)
      const payload = (await response.json()) as { mtimeMs?: number }
      expect(response.ok).toBe(true)
      expect(typeof payload.mtimeMs).toBe("number")
      expect(payload.mtimeMs).toBeGreaterThan(0)
    } finally {
      await server.close()
    }
  })

  test("handleFileMtime returns 404 for missing file", async () => {
    const handlers = createHandlers()
    const server = await startServer((request, response) => {
      return handlers.handleFileMtime(request, response)
    })

    try {
      const response = await fetch(`${server.url}/?filePath=${encodeURIComponent("/nonexistent/file.docx")}`)
      expect(response.status).toBe(404)
    } finally {
      await server.close()
    }
  })

  test("handleFonts serves font metadata files", async () => {
    const handlers = createHandlers()
    const server = await startServer((request, response) => {
      return handlers.handleFonts(request, response)
    })

    try {
      const response = await fetch(`${server.url}/api/editor/fonts/AllFonts.js`)
      expect(response.ok).toBe(true)
      const body = await response.text()
      expect(body).toContain("__AllFonts__")
    } finally {
      await server.close()
    }
  })

  test("handleStatic serves editor resource files", async () => {
    // Create a static file
    const staticDir = join(resourcesDir, "sdkjs")
    mkdirSync(staticDir, { recursive: true })
    writeFileSync(join(staticDir, "test.js"), "console.log('sdk');", "utf8")

    const handlers = createHandlers()
    const server = await startServer((request, response) => {
      return handlers.handleStatic(request, response)
    })

    try {
      const response = await fetch(`${server.url}/api/editor/static/sdkjs/test.js`)
      expect(response.ok).toBe(true)
      expect(response.headers.get("content-type")).toContain("javascript")
      const body = await response.text()
      expect(body).toContain("console.log")
    } finally {
      await server.close()
    }
  })

  test("handleStatic returns 404 for non-existent files", async () => {
    const handlers = createHandlers()
    const server = await startServer((request, response) => {
      return handlers.handleStatic(request, response)
    })

    try {
      const response = await fetch(`${server.url}/api/editor/static/nonexistent.js`)
      expect(response.status).toBe(404)
    } finally {
      await server.close()
    }
  })

  test("handleEditorSave returns 400 for missing filePath", async () => {
    const handlers = createHandlers()
    const server = await startServer((request, response) => {
      return handlers.handleEditorSave(request, response)
    })

    try {
      const response = await fetch(`${server.url}/api/editor/save`, {
        method: "POST",
        body: "data",
      })
      expect(response.status).toBe(400)
    } finally {
      await server.close()
    }
  })

  test("handleEditorSave returns 400 for empty body", async () => {
    const filePath = join(tempDir, "save-test.xlsx")
    await writeFile(filePath, "original", "utf8")
    const handlers = createHandlers()
    const server = await startServer((request, response) => {
      return handlers.handleEditorSave(request, response)
    })

    try {
      const response = await fetch(`${server.url}/api/editor/save?filePath=${encodeURIComponent(filePath)}`, {
        method: "POST",
        body: "",
      })
      expect(response.status).toBe(400)
    } finally {
      await server.close()
    }
  })
})
