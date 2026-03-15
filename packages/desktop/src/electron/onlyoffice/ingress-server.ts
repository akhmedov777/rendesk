import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http"
import * as net from "node:net"

export type EditorIngressHandlers = {
  handleDownload: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void
  handleCallbackGet: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void
  handleCallbackPost: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void
}

let ingressPort: number | null = null
let ingressServer: Server | null = null

export function getEditorIngressPort() {
  return ingressPort
}

async function findFreePort(preferred = 31339): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(preferred, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo
      server.close(() => resolve(address.port))
    })
    server.on("error", () => {
      const fallback = net.createServer()
      fallback.listen(0, "127.0.0.1", () => {
        const address = fallback.address() as net.AddressInfo
        fallback.close(() => resolve(address.port))
      })
      fallback.on("error", reject)
    })
  })
}

export async function startEditorIngressServer(handlers: EditorIngressHandlers): Promise<number> {
  if (ingressPort && ingressServer) return ingressPort

  const port = await findFreePort()
  ingressServer = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method === "OPTIONS") {
          response.writeHead(200, {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET,POST,OPTIONS",
            "access-control-allow-headers": "content-type",
          })
          response.end()
          return
        }

        const url = request.url ?? "/"
        if (url.startsWith("/api/editor/download") && ["GET", "HEAD"].includes(request.method ?? "GET")) {
          await handlers.handleDownload(request, response)
          return
        }
        if (url.startsWith("/api/editor/callback") && request.method === "GET") {
          await handlers.handleCallbackGet(request, response)
          return
        }
        if (url.startsWith("/api/editor/callback") && request.method === "POST") {
          await handlers.handleCallbackPost(request, response)
          return
        }

        response.writeHead(404, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: "Not found" }))
      } catch (error) {
        console.error("[onlyoffice-ingress] request failed:", error)
        if (response.headersSent) {
          response.end()
          return
        }
        response.writeHead(500, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: "Internal server error" }))
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    ingressServer!.listen(port, "127.0.0.1", () => {
      ingressPort = port
      resolve()
    })
    ingressServer!.on("error", reject)
  })

  return port
}

export async function stopEditorIngressServer(): Promise<void> {
  if (!ingressServer) return
  const server = ingressServer
  ingressServer = null
  ingressPort = null

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}
