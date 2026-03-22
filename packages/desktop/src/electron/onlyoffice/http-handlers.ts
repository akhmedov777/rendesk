import { createReadStream, existsSync, statSync, readFileSync } from "node:fs"
import { IncomingMessage, ServerResponse } from "node:http"
import { basename, extname, join } from "node:path"
import { isOnlyOfficeExtension } from "./config"
import { convertToBinary, convertFromBinary } from "./converter"

const STATIC_MIME_MAP: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".ico": "image/x-icon",
  ".xml": "application/xml",
  ".bin": "application/octet-stream",
  ".wasm": "application/wasm",
}

export type EditorApiDeps = {
  getResourcesPath: () => string
  getConverterPath: () => string
  getCachePath: () => string
  getFontDataPath: () => string
  getFontSelectionPath: () => string
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers": "content-type",
  })
  response.end(JSON.stringify(payload))
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks)
}

function getStaticMimeType(filePath: string): string {
  return STATIC_MIME_MAP[extname(filePath).toLowerCase()] ?? "application/octet-stream"
}

// Suppress file-watcher reload after saves by tracking recent save times.
const recentSaves = new Map<string, number>()
const SAVE_GRACE_MS = 2000

export function wasRecentlySaved(filePath: string): boolean {
  const savedAt = recentSaves.get(filePath)
  if (!savedAt) return false
  if (Date.now() - savedAt > SAVE_GRACE_MS) {
    recentSaves.delete(filePath)
    return false
  }
  return true
}

export function createEditorApiHandlers(deps: EditorApiDeps) {
  return {
    async handleEditorOpen(request: IncomingMessage, response: ServerResponse) {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      const filePath = url.searchParams.get("filePath")
      if (!filePath) {
        sendJson(response, 400, { error: "filePath is required", code: "EDITOR_FILE_PATH_REQUIRED" })
        return
      }

      if (!existsSync(filePath)) {
        sendJson(response, 404, { error: "File not found", code: "EDITOR_FILE_NOT_FOUND" })
        return
      }

      const fileExt = extname(filePath).replace(/^\./, "")
      if (!isOnlyOfficeExtension(fileExt)) {
        sendJson(response, 400, {
          error: `Unsupported file type: .${fileExt}`,
          code: "EDITOR_FILE_TYPE_UNSUPPORTED",
        })
        return
      }

      // Serve the offline-loader HTML
      const loaderPath = join(deps.getResourcesPath(), "offline-loader.html")
      if (!existsSync(loaderPath)) {
        sendJson(response, 500, { error: "Editor loader not found", code: "EDITOR_LOADER_MISSING" })
        return
      }

      const html = readFileSync(loaderPath, "utf8")
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "no-cache, no-store",
      })
      response.end(html)
    },

    async handleEditorConvert(request: IncomingMessage, response: ServerResponse) {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      const filePath = url.searchParams.get("filePath")
      if (!filePath) {
        sendJson(response, 400, { error: "filePath is required" })
        return
      }

      if (!existsSync(filePath)) {
        sendJson(response, 404, { error: "File not found" })
        return
      }

      try {
        const result = await convertToBinary({
          filePath,
          converterPath: deps.getConverterPath(),
          cachePath: deps.getCachePath(),
          fontSelectionPath: deps.getFontSelectionPath(),
        })

        const stat = statSync(result.binPath)
        const fileHash = `${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}`

        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": stat.size,
          "x-file-hash": fileHash,
          "x-cache": result.cached ? "hit" : "miss",
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "x-file-hash, x-cache",
          "cache-control": "no-cache, no-store",
        })

        createReadStream(result.binPath).pipe(response)
      } catch (error) {
        sendJson(response, 500, {
          error: `Conversion failed: ${error instanceof Error ? error.message : String(error)}`,
          code: "EDITOR_CONVERSION_FAILED",
        })
      }
    },

    async handleEditorSave(request: IncomingMessage, response: ServerResponse) {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      const filePath = url.searchParams.get("filePath")
      if (!filePath) {
        sendJson(response, 400, { error: "filePath is required" })
        return
      }

      try {
        const body = await readRawBody(request)

        if (body.length === 0) {
          sendJson(response, 400, { error: "Empty body" })
          return
        }

        // Check if the body is already in the target format (PK signature = ZIP-based formats like xlsx/docx/pptx)
        const ext = extname(filePath).replace(/^\./, "").toLowerCase()
        const isPkSignature = body.length >= 4 && body[0] === 0x50 && body[1] === 0x4b && body[2] === 0x03 && body[3] === 0x04
        const isZipFormat = ["xlsx", "docx", "pptx", "odp", "ods", "odt"].includes(ext)

        if (isPkSignature && isZipFormat) {
          // Already in the target format — write directly
          const { writeFileSync } = await import("node:fs")
          recentSaves.set(filePath, Date.now())
          writeFileSync(filePath, body)
        } else {
          // Convert from binary editor format back to the original format
          recentSaves.set(filePath, Date.now())
          await convertFromBinary({
            binData: body,
            outputPath: filePath,
            converterPath: deps.getConverterPath(),
            cachePath: deps.getCachePath(),
            fontSelectionPath: deps.getFontSelectionPath(),
          })
        }

        sendJson(response, 200, { success: true })
      } catch (error) {
        sendJson(response, 500, {
          error: `Save failed: ${error instanceof Error ? error.message : String(error)}`,
          code: "EDITOR_SAVE_FAILED",
        })
      }
    },

    async handleFileMtime(request: IncomingMessage, response: ServerResponse) {
      const filePath = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("filePath")
      if (!filePath) {
        sendJson(response, 400, { error: "filePath is required" })
        return
      }
      if (!existsSync(filePath)) {
        sendJson(response, 404, { error: "File not found" })
        return
      }
      const stat = statSync(filePath)
      sendJson(response, 200, { mtimeMs: stat.mtimeMs })
    },

    async handleFonts(request: IncomingMessage, response: ServerResponse) {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      // /api/editor/fonts/AllFonts.js → AllFonts.js
      // /api/editor/fonts/file?path=/System/Library/Fonts/Arial.ttf → serves that font file
      const restPath = url.pathname.replace(/^\/api\/editor\/fonts\/?/, "")

      if (restPath === "file") {
        // Serve a font file by absolute path
        const fontPath = url.searchParams.get("path")
        if (!fontPath || !existsSync(fontPath)) {
          response.writeHead(404)
          response.end("Font not found")
          return
        }

        const stat = statSync(fontPath)
        response.writeHead(200, {
          "content-type": getStaticMimeType(fontPath),
          "content-length": stat.size,
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=86400",
        })
        createReadStream(fontPath).pipe(response)
        return
      }

      // Serve font metadata files from resources/fonts/
      const fontDataPath = deps.getFontDataPath()
      const filePath = join(fontDataPath, restPath)

      if (!filePath.startsWith(fontDataPath) || !existsSync(filePath)) {
        response.writeHead(404)
        response.end("Not found")
        return
      }

      const stat = statSync(filePath)
      response.writeHead(200, {
        "content-type": getStaticMimeType(filePath),
        "content-length": stat.size,
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=3600",
      })
      createReadStream(filePath).pipe(response)
    },

    async handleStatic(request: IncomingMessage, response: ServerResponse) {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      // /api/editor/static/sdkjs/cell/sdk-all.js → resources/editors/sdkjs/cell/sdk-all.js
      const restPath = url.pathname.replace(/^\/api\/editor\/static\/?/, "")

      if (!restPath) {
        response.writeHead(400)
        response.end("Path required")
        return
      }

      // Override sdkjs/common/AllFonts.js with the generated font metadata
      if (restPath === "sdkjs/common/AllFonts.js") {
        const allFontsPath = join(deps.getFontDataPath(), "AllFonts.js")
        if (existsSync(allFontsPath)) {
          const stat = statSync(allFontsPath)
          response.writeHead(200, {
            "content-type": "application/javascript; charset=utf-8",
            "content-length": stat.size,
            "access-control-allow-origin": "*",
            "cache-control": "no-cache",
          })
          createReadStream(allFontsPath).pipe(response)
          return
        }
      }

      const resourcesPath = deps.getResourcesPath()
      const filePath = join(resourcesPath, restPath)

      // Prevent directory traversal
      if (!filePath.startsWith(resourcesPath)) {
        response.writeHead(403)
        response.end("Forbidden")
        return
      }

      if (!existsSync(filePath)) {
        response.writeHead(404)
        response.end("Not found")
        return
      }

      const stat = statSync(filePath)
      if (!stat.isFile()) {
        response.writeHead(404)
        response.end("Not found")
        return
      }

      // For HTML files (e.g. editor's index.html loaded in inner iframe),
      // inject the desktop-stub so window.AscDesktopEditor is available.
      const fileName = basename(filePath)
      if (fileName.endsWith(".html")) {
        // Read the original request's query params — the outer iframe passes
        // filePath and serviceUrl that the desktop stub needs.
        const outerUrl = new URL(request.headers.referer ?? "", "http://127.0.0.1")
        const filePathParam = outerUrl.searchParams.get("filePath") ?? ""
        const serviceUrlParam = outerUrl.searchParams.get("serviceUrl") ?? ""

        let html = readFileSync(filePath, "utf8")
        // Inject desktop stub as the first script in <head> (or before first <script>)
        const stubUrl = `/api/editor/static/desktop-stub.js?filePath=${encodeURIComponent(filePathParam)}&serviceUrl=${encodeURIComponent(serviceUrlParam)}`
        const stubTag = `<script src="${stubUrl}"></script>`

        if (html.includes("<head>")) {
          html = html.replace("<head>", `<head>${stubTag}`)
        } else if (html.includes("<HEAD>")) {
          html = html.replace("<HEAD>", `<HEAD>${stubTag}`)
        } else {
          html = stubTag + html
        }

        const buf = Buffer.from(html, "utf8")
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": buf.length,
          "access-control-allow-origin": "*",
          "cache-control": "no-cache",
        })
        response.end(buf)
        return
      }

      response.writeHead(200, {
        "content-type": getStaticMimeType(filePath),
        "content-length": stat.size,
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=3600",
      })
      createReadStream(filePath).pipe(response)
    },
  }
}
