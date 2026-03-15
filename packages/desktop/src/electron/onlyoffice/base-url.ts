export const LOCAL_DOC_SERVER_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal"])

export type ResolveEditorBaseUrlOptions = {
  callbackBaseUrl: string
  documentServerUrl: string
  localPort: number | undefined
  autoTunnelEnabled: boolean
}

export type ResolveEditorBaseUrlDeps = {
  ensureTunnelReady: () => Promise<{ baseUrl?: string; error?: string }>
}

export type ResolveEditorBaseUrlResult =
  | {
      ok: true
      baseUrl: string
      mode: "local" | "manual" | "auto-tunnel"
      docHost: string | null
    }
  | {
      ok: false
      status: number
      code: string
      error: string
      details?: string
      docHost: string | null
    }

export function tryParseUrl(input: string): URL | null {
  try {
    return new URL(input)
  } catch {
    return null
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1"
}

export function getDocumentServerHost(documentServerUrl: string): string | null {
  return tryParseUrl(documentServerUrl)?.hostname?.toLowerCase() ?? null
}

export function isLocalDocumentServerHost(hostname: string | null): boolean {
  return !!hostname && LOCAL_DOC_SERVER_HOSTS.has(hostname)
}

export async function resolveEditorBaseUrl(
  options: ResolveEditorBaseUrlOptions,
  deps: ResolveEditorBaseUrlDeps,
): Promise<ResolveEditorBaseUrlResult> {
  const docHost = getDocumentServerHost(options.documentServerUrl)
  const hasLocalDocServer = isLocalDocumentServerHost(docHost)

  if (!options.localPort) {
    return {
      ok: false,
      status: 500,
      code: "EDITOR_SERVER_PORT_UNAVAILABLE",
      error: "Editor ingress server port is unavailable.",
      docHost,
    }
  }

  if (options.callbackBaseUrl.trim()) {
    const parsed = tryParseUrl(options.callbackBaseUrl.trim())
    if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
      return {
        ok: false,
        status: 400,
        code: "EDITOR_CALLBACK_INVALID",
        error: "Callback Base URL must be a valid http(s) URL.",
        docHost,
      }
    }

    if (!hasLocalDocServer && isLoopbackHost(parsed.hostname)) {
      return {
        ok: false,
        status: 400,
        code: "EDITOR_CALLBACK_LOOPBACK_FOR_REMOTE",
        error: `Callback Base URL host (${parsed.hostname}) is local-only and not reachable from ${docHost ?? "the Document Server"}.`,
        docHost,
      }
    }

    return {
      ok: true,
      baseUrl: parsed.toString().replace(/\/+$/, ""),
      mode: "manual",
      docHost,
    }
  }

  if (hasLocalDocServer) {
    return {
      ok: true,
      baseUrl: `http://127.0.0.1:${options.localPort}`,
      mode: "local",
      docHost,
    }
  }

  if (!options.autoTunnelEnabled) {
    return {
      ok: false,
      status: 400,
      code: "EDITOR_CALLBACK_REQUIRED",
      error:
        `Callback Base URL is required for remote Document Server ${docHost ?? options.documentServerUrl}. ` +
        "Set Callback Base URL manually or enable Auto Tunnel.",
      docHost,
    }
  }

  const tunnel = await deps.ensureTunnelReady()
  if (!tunnel.baseUrl) {
    return {
      ok: false,
      status: 503,
      code: "EDITOR_TUNNEL_UNAVAILABLE",
      error: "Auto tunnel is unavailable. Document Server cannot reach callback endpoints.",
      details: tunnel.error ?? "Unable to establish callback tunnel.",
      docHost,
    }
  }

  return {
    ok: true,
    baseUrl: tunnel.baseUrl.replace(/\/+$/, ""),
    mode: "auto-tunnel",
    docHost,
  }
}
