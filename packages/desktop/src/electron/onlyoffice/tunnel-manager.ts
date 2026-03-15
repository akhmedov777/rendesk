import localtunnel from "localtunnel"
import { probeCallbackEndpoint } from "./connectivity"

type TunnelStatus = "idle" | "starting" | "ready" | "error"
const TUNNEL_HEALTH_TTL_MS = 45_000

type LocalTunnelHandle = {
  url: string
  close: () => void | Promise<void>
  on?: (event: "error" | "close", listener: (...args: any[]) => void) => void
  off?: (event: "error" | "close", listener: (...args: any[]) => void) => void
  removeListener?: (event: "error" | "close", listener: (...args: any[]) => void) => void
}

export type EditorTunnelState = {
  status: TunnelStatus
  provider: "localtunnel"
  publicUrl: string | null
  ingressPort: number | null
  lastError: string | null
  lastStartedAt: number | null
  lastCheckedAt: number | null
}

let ingressPort: number | null = null
let tunnelHandle: LocalTunnelHandle | null = null
let pendingStart: Promise<string> | null = null
let tunnelErrorListener: ((error: unknown) => void) | null = null
let tunnelCloseListener: (() => void) | null = null

const state: EditorTunnelState = {
  status: "idle",
  provider: "localtunnel",
  publicUrl: null,
  ingressPort: null,
  lastError: null,
  lastStartedAt: null,
  lastCheckedAt: null,
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function setEditorTunnelIngressPort(port: number | null) {
  ingressPort = port
  state.ingressPort = port
}

export function getEditorTunnelState(): EditorTunnelState {
  return { ...state }
}

export function shouldReuseHealthyTunnel(current: EditorTunnelState, now = Date.now()) {
  return (
    current.status === "ready" &&
    !!current.publicUrl &&
    current.lastError === null &&
    current.lastCheckedAt !== null &&
    now - current.lastCheckedAt < TUNNEL_HEALTH_TTL_MS
  )
}

export async function ensureEditorTunnelReady(): Promise<{ baseUrl?: string; error?: string }> {
  if (!ingressPort) {
    const error = "Editor ingress server is not running."
    state.status = "error"
    state.lastError = error
    return { error }
  }

  if (pendingStart) {
    try {
      return { baseUrl: await pendingStart }
    } catch (error) {
      return { error: getErrorMessage(error) }
    }
  }

  if (state.status === "ready" && state.publicUrl && tunnelHandle) {
    if (shouldReuseHealthyTunnel(state)) {
      return { baseUrl: state.publicUrl }
    }

    const healthy = await probeTunnel(state.publicUrl)
    if (healthy) return { baseUrl: state.publicUrl }
    await closeCurrentTunnel()
  }

  pendingStart = startTunnelInternal(ingressPort)
  try {
    return { baseUrl: await pendingStart }
  } catch (error) {
    const message = getErrorMessage(error)
    state.status = "error"
    state.lastError = message
    return { error: message }
  } finally {
    pendingStart = null
  }
}

export async function reconnectEditorTunnel(): Promise<{ baseUrl?: string; error?: string }> {
  await closeCurrentTunnel()
  return ensureEditorTunnelReady()
}

export async function shutdownEditorTunnelManager(): Promise<void> {
  pendingStart = null
  await closeCurrentTunnel()
  state.status = "idle"
  state.publicUrl = null
  state.lastError = null
}

async function startTunnelInternal(port: number): Promise<string> {
  state.status = "starting"
  state.lastError = null

  const tunnel = (await localtunnel({
    port,
    local_host: "127.0.0.1",
  })) as unknown as LocalTunnelHandle

  if (!tunnel.url) throw new Error("Tunnel started without a public URL.")

  tunnelHandle = tunnel
  attachTunnelListeners(tunnel)
  state.status = "ready"
  state.publicUrl = tunnel.url.replace(/\/+$/, "")
  state.lastStartedAt = Date.now()

  const healthy = await probeTunnel(state.publicUrl)
  if (!healthy) {
    await closeCurrentTunnel()
    throw new Error("Tunnel endpoint is not reachable.")
  }

  return state.publicUrl
}

async function closeCurrentTunnel(): Promise<void> {
  if (!tunnelHandle) return
  detachTunnelListeners(tunnelHandle)
  try {
    await tunnelHandle.close()
  } catch (error) {
    console.error("[onlyoffice-tunnel] Failed to close tunnel:", error)
  } finally {
    tunnelHandle = null
    state.publicUrl = null
  }
}

async function probeTunnel(baseUrl: string): Promise<boolean> {
  const result = await probeCallbackEndpoint(baseUrl)
  state.lastCheckedAt = Date.now()
  if (!result.ok) {
    state.status = "error"
    state.lastError = result.error
    return false
  }
  state.status = "ready"
  state.lastError = null
  return true
}

function attachTunnelListeners(tunnel: LocalTunnelHandle) {
  tunnelErrorListener = (error: unknown) => {
    state.status = "error"
    state.lastError = getErrorMessage(error)
    console.error("[onlyoffice-tunnel] runtime error:", state.lastError)
  }
  tunnelCloseListener = () => {
    if (tunnelHandle === tunnel) {
      tunnelHandle = null
      state.publicUrl = null
      state.status = "error"
      state.lastError = "Tunnel connection closed."
      state.lastCheckedAt = Date.now()
    }
  }
  tunnel.on?.("error", tunnelErrorListener)
  tunnel.on?.("close", tunnelCloseListener)
}

function detachTunnelListeners(tunnel: LocalTunnelHandle) {
  if (tunnelErrorListener) {
    tunnel.off?.("error", tunnelErrorListener)
    tunnel.removeListener?.("error", tunnelErrorListener)
  }
  if (tunnelCloseListener) {
    tunnel.off?.("close", tunnelCloseListener)
    tunnel.removeListener?.("close", tunnelCloseListener)
  }
  tunnelErrorListener = null
  tunnelCloseListener = null
}
