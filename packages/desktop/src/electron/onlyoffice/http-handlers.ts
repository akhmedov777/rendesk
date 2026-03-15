import { createWriteStream, createReadStream, existsSync, statSync } from "node:fs"
import { IncomingMessage, ServerResponse } from "node:http"
import { basename, extname } from "node:path"
import { buildOnlyOfficeConfig, isOnlyOfficeExtension, verifyEditorJwt } from "./config"
import { probeCallbackEndpoint, probeDownloadEndpoint } from "./connectivity"
import {
  getDocumentServerHost,
  isLocalDocumentServerHost,
  isLoopbackHost,
  resolveEditorBaseUrl,
  tryParseUrl,
} from "./base-url"
import type { EditorIntegrationConfig } from "./types"

const MIME_MAP: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pdf": "application/pdf",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".rtf": "application/rtf",
  ".csv": "text/csv",
}

export type EditorApiDeps = {
  getConfig: () => EditorIntegrationConfig
  getIngressPort: () => number | null
  ensureTunnelReady: () => Promise<{ baseUrl?: string; error?: string }>
  getTunnelState: () => unknown
  reconnectTunnel: () => Promise<{ baseUrl?: string; error?: string }>
  fetchExternal?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
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

async function readJsonBody(request: IncomingMessage) {
  let body = ""
  for await (const chunk of request) {
    body += chunk.toString()
  }
  if (!body.trim()) return {}
  return JSON.parse(body) as Record<string, unknown>
}

function getTransportMode(config: EditorIntegrationConfig) {
  const docHost = getDocumentServerHost(config.documentServerUrl)
  const isRemoteDocumentServer = !isLocalDocumentServerHost(docHost)
  const manualCallback = config.callbackBaseUrl.trim()
  const mode = !isRemoteDocumentServer
    ? "local"
    : manualCallback
      ? "manual"
      : config.autoTunnelEnabled === false
        ? "disabled"
        : "auto"

  return {
    docHost,
    isRemoteDocumentServer,
    manualCallback,
    mode,
  }
}

function getMimeType(filePath: string) {
  return MIME_MAP[extname(filePath).toLowerCase()] ?? "application/octet-stream"
}

type ByteRange = {
  start: number
  end: number
}

function parseByteRange(header: string | undefined, size: number): ByteRange | null {
  if (!header) return null
  const match = header.match(/^bytes=(\d*)-(\d*)$/i)
  if (!match) return null

  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return null

  if (!rawStart) {
    const suffixLength = Number(rawEnd)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null
    const start = Math.max(size - suffixLength, 0)
    return { start, end: size - 1 }
  }

  const start = Number(rawStart)
  const end = rawEnd ? Number(rawEnd) : size - 1
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start < 0 || start >= size || end < start) return null
  return { start, end: Math.min(end, size - 1) }
}

function asciiFilenameFallback(filename: string) {
  const normalized = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]+/g, "_")
    .replace(/["\\]/g, "_")
    .trim()
  return normalized || "document"
}

function encodeDispositionFilename(filename: string) {
  return encodeURIComponent(filename)
    .replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A")
    .replace(/%(7C|60|5E)/g, (match) => String.fromCharCode(Number.parseInt(match.slice(1), 16)))
}

function contentDispositionHeader(filename: string) {
  const fallback = asciiFilenameFallback(filename)
  const encoded = encodeDispositionFilename(filename)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

function verifyToken(token: string, config: EditorIntegrationConfig) {
  return verifyEditorJwt(token, config.jwtSecret)
}

export function createOnlyOfficeApiHandlers(deps: EditorApiDeps) {
  return {
    async handleConfig(request: IncomingMessage, response: ServerResponse) {
      const filePath = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("filePath")
      if (!filePath) {
        sendJson(response, 400, { error: "filePath is required", code: "EDITOR_FILE_PATH_REQUIRED" })
        return
      }

      const config = deps.getConfig()
      if (!config.enabled || !config.documentServerUrl || !config.jwtSecret) {
        sendJson(response, 400, { error: "Document editor not configured", code: "EDITOR_NOT_CONFIGURED" })
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

      const resolution = await resolveEditorBaseUrl(
        {
          callbackBaseUrl: config.callbackBaseUrl,
          documentServerUrl: config.documentServerUrl,
          localPort: deps.getIngressPort() ?? undefined,
          autoTunnelEnabled: config.autoTunnelEnabled,
        },
        { ensureTunnelReady: deps.ensureTunnelReady },
      )

      if (!resolution.ok) {
        sendJson(response, resolution.status, {
          error: resolution.error,
          code: resolution.code,
          details: resolution.details,
          docHost: resolution.docHost,
        })
        return
      }

      const stat = statSync(filePath)
      const editorConfig = buildOnlyOfficeConfig({
        filePath,
        fileName: basename(filePath),
        fileExt,
        fileMtimeMs: stat.mtimeMs,
        baseUrl: resolution.baseUrl,
        jwtSecret: config.jwtSecret,
      })

      if (resolution.mode !== "local") {
        const downloadProbe = await probeDownloadEndpoint(
          String((editorConfig as { document?: { url?: string } }).document?.url ?? ""),
          getMimeType(filePath),
          deps.fetchExternal,
        )

        if (!downloadProbe.ok) {
          sendJson(response, 503, {
            error: "The hosted document download endpoint is not reachable.",
            code: "EDITOR_DOWNLOAD_UNREACHABLE",
            details: downloadProbe.error,
            docHost: resolution.docHost,
          })
          return
        }
      }

      sendJson(response, 200, {
        config: editorConfig,
        docServerUrl: config.documentServerUrl,
        transportMode: resolution.mode,
        callbackBaseUrl: resolution.baseUrl,
        documentSize: stat.size,
      })
    },

    async handleDownload(request: IncomingMessage, response: ServerResponse) {
      const method = (request.method ?? "GET").toUpperCase()
      if (!["GET", "HEAD"].includes(method)) {
        response.writeHead(405, { allow: "GET, HEAD" })
        response.end()
        return
      }

      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      const filePath = url.searchParams.get("filePath")
      const token = url.searchParams.get("token")
      if (!filePath || !token) {
        sendJson(response, 400, { error: "filePath and token are required" })
        return
      }

      const config = deps.getConfig()
      const payload = verifyToken(token, config)
      if (!payload || payload.action !== "download" || payload.filePath !== filePath) {
        sendJson(response, 403, { error: "Invalid or expired token" })
        return
      }

      if (!existsSync(filePath)) {
        sendJson(response, 404, { error: "File not found" })
        return
      }

      const stat = statSync(filePath)
      const range = parseByteRange(request.headers.range, stat.size)
      if (request.headers.range && !range) {
        response.writeHead(416, {
          "content-range": `bytes */${stat.size}`,
          "accept-ranges": "bytes",
          "access-control-allow-origin": "*",
        })
        response.end()
        return
      }

      const headers: Record<string, string | number> = {
        "content-type": getMimeType(filePath),
        "content-disposition": contentDispositionHeader(basename(filePath)),
        "accept-ranges": "bytes",
        "access-control-allow-origin": "*",
      }

      if (range) {
        headers["content-length"] = range.end - range.start + 1
        headers["content-range"] = `bytes ${range.start}-${range.end}/${stat.size}`
        response.writeHead(206, headers)
        if (method === "HEAD") {
          response.end()
          return
        }
        createReadStream(filePath, { start: range.start, end: range.end }).pipe(response)
        return
      }

      headers["content-length"] = stat.size
      response.writeHead(200, headers)
      if (method === "HEAD") {
        response.end()
        return
      }
      createReadStream(filePath).pipe(response)
    },

    async handleCallbackGet(_request: IncomingMessage, response: ServerResponse) {
      sendJson(response, 200, { status: "ok" })
    },

    async handleCallbackPost(request: IncomingMessage, response: ServerResponse) {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      const token = url.searchParams.get("token")
      if (!token) {
        sendJson(response, 200, { error: 0 })
        return
      }

      const config = deps.getConfig()
      const payload = verifyToken(token, config)
      if (!payload || payload.action !== "callback") {
        sendJson(response, 200, { error: 0 })
        return
      }

      const body = await readJsonBody(request).catch(() => null)
      if (!body) {
        sendJson(response, 200, { error: 0 })
        return
      }

      const status = typeof body.status === "number" ? body.status : -1
      const savedUrl = typeof body.url === "string" ? body.url : ""
      const filePath = typeof payload.filePath === "string" ? payload.filePath : ""

      if ((status === 2 || status === 6) && savedUrl && filePath) {
        try {
          await downloadAndSave(savedUrl, filePath)
        } catch (error) {
          console.error("[onlyoffice] Failed to save callback file:", error)
        }
      }

      sendJson(response, 200, { error: 0 })
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

    async handleTunnelStatus(_request: IncomingMessage, response: ServerResponse) {
      const config = deps.getConfig()
      const status = getTransportMode(config)
      sendJson(response, 200, {
        mode: status.mode,
        docHost: status.docHost,
        isRemoteDocumentServer: status.isRemoteDocumentServer,
        callbackBaseUrl: status.manualCallback || null,
        autoTunnelEnabled: config.autoTunnelEnabled,
        tunnel: deps.getTunnelState(),
      })
    },

    async handleTunnelReconnect(_request: IncomingMessage, response: ServerResponse) {
      const config = deps.getConfig()
      const status = getTransportMode(config)

      if (!status.isRemoteDocumentServer) {
        sendJson(response, 400, {
          error: "Reconnect is only needed for remote Document Server mode.",
          code: "EDITOR_TUNNEL_NOT_REQUIRED",
        })
        return
      }

      if (status.manualCallback) {
        sendJson(response, 400, {
          error: "Manual Callback Base URL is configured. Clear it to use auto tunnel.",
          code: "EDITOR_TUNNEL_MANUAL_OVERRIDE",
        })
        return
      }

      if (config.autoTunnelEnabled === false) {
        sendJson(response, 400, {
          error: "Auto Tunnel is disabled. Enable it in settings.",
          code: "EDITOR_TUNNEL_DISABLED",
        })
        return
      }

      const reconnect = await deps.reconnectTunnel()
      if (!reconnect.baseUrl) {
        sendJson(response, 503, {
          error: "Failed to reconnect auto tunnel.",
          code: "EDITOR_TUNNEL_UNAVAILABLE",
          details: reconnect.error,
          tunnel: deps.getTunnelState(),
        })
        return
      }

      sendJson(response, 200, {
        success: true,
        callbackBaseUrl: reconnect.baseUrl,
        tunnel: deps.getTunnelState(),
      })
    },

    async handleEditorIntegrationUpdate(
      request: IncomingMessage,
      response: ServerResponse,
      updateConfig: (next: Partial<EditorIntegrationConfig>) => Promise<void>,
    ) {
      const body = await readJsonBody(request).catch(() => ({}))
      await updateConfig(body as Partial<EditorIntegrationConfig>)
      sendJson(response, 200, { success: true })
    },

    async handleEditorIntegrationTest(_request: IncomingMessage, response: ServerResponse) {
      const config = deps.getConfig()
      if (!config.documentServerUrl) {
        sendJson(response, 200, { success: false, message: "Document Server URL is required" })
        return
      }
      if (!config.jwtSecret) {
        sendJson(response, 200, { success: false, message: "JWT Secret is required" })
        return
      }

      const parsedDocServer = tryParseUrl(config.documentServerUrl)
      if (!parsedDocServer || !["http:", "https:"].includes(parsedDocServer.protocol)) {
        sendJson(response, 200, { success: false, message: "Document Server URL must be a valid http(s) URL" })
        return
      }

      const status = getTransportMode(config)
      if (!status.manualCallback && status.isRemoteDocumentServer && config.autoTunnelEnabled === false) {
        sendJson(response, 200, {
          success: false,
          message:
            `Callback Base URL is required for remote Document Server (${status.docHost}). ` +
            "Set it manually or enable Auto Tunnel.",
        })
        return
      }

      if (status.manualCallback) {
        const parsedCallback = tryParseUrl(status.manualCallback)
        if (!parsedCallback || !["http:", "https:"].includes(parsedCallback.protocol)) {
          sendJson(response, 200, { success: false, message: "Callback Base URL must be a valid http(s) URL" })
          return
        }
        if (!isLocalDocumentServerHost(status.docHost) && isLoopbackHost(parsedCallback.hostname)) {
          sendJson(response, 200, {
            success: false,
            message: `Callback Base URL host (${parsedCallback.hostname}) is local-only and not reachable from ${status.docHost}.`,
          })
          return
        }
      }

      try {
        const health = await fetch(`${config.documentServerUrl.replace(/\/+$/, "")}/healthcheck`, {
          signal: AbortSignal.timeout(10000),
        })
        const body = await health.text()
        if (!(body === "true" || health.ok)) {
          sendJson(response, 200, { success: false, message: `Server returned: ${body}` })
          return
        }

        if (status.manualCallback) {
          const probe = await probeCallbackEndpoint(status.manualCallback, deps.fetchExternal)
          if (!probe.ok) {
            sendJson(response, 200, {
              success: false,
              message: `Document Server reachable; callback probe failed: ${probe.error}`,
            })
            return
          }
          sendJson(response, 200, { success: true, message: "Document Server reachable; callback verified" })
          return
        }

        if (status.isRemoteDocumentServer && config.autoTunnelEnabled !== false) {
          const tunnel = await deps.ensureTunnelReady()
          if (!tunnel.baseUrl) {
            sendJson(response, 200, {
              success: false,
              message: `Document Server reachable, but auto tunnel failed. ${tunnel.error ?? "Unknown tunnel error"}`,
            })
            return
          }
          const probe = await probeCallbackEndpoint(tunnel.baseUrl, deps.fetchExternal)
          if (!probe.ok) {
            sendJson(response, 200, {
              success: false,
              message: `Auto tunnel probe failed: ${probe.error}`,
            })
            return
          }
          sendJson(response, 200, {
            success: true,
            message: `Document Server reachable; auto tunnel ready (${tunnel.baseUrl})`,
          })
          return
        }

        sendJson(response, 200, { success: true, message: "Document Server reachable" })
      } catch (error) {
        sendJson(response, 200, {
          success: false,
          message: `Cannot reach Document Server: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    },
  }
}

function downloadAndSave(url: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? import("node:https") : import("node:http")
    void client.then(({ get }) => {
      get(url, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirect = response.headers.location
          if (redirect) {
            downloadAndSave(redirect, destination).then(resolve).catch(reject)
            return
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Download failed with status ${response.statusCode}`))
          return
        }

        const stream = createWriteStream(destination)
        response.pipe(stream)
        stream.on("finish", () => {
          stream.close()
          resolve()
        })
        stream.on("error", reject)
      }).on("error", reject)
    }, reject)
  })
}
