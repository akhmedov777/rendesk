import type { EditorIntegrationConfig } from "./types.js"

export const REDACTED_EDITOR_SECRET = "••••••••"
export const DEFAULT_EDITOR_INTEGRATION_CONFIG: EditorIntegrationConfig = {
  enabled: false,
  documentServerUrl: "",
  jwtSecret: "",
  callbackBaseUrl: "",
  autoTunnelEnabled: true,
}

export const defaultEditorIntegrationConfig = (): EditorIntegrationConfig => ({ ...DEFAULT_EDITOR_INTEGRATION_CONFIG })

const envBool = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false
  return fallback
}

export const applyEditorEnvOverrides = (
  current: EditorIntegrationConfig,
  env: Record<string, string | undefined> = process.env,
): EditorIntegrationConfig => {
  const next = { ...current }
  const documentServerUrl = env.ONLYOFFICE_DOCUMENT_SERVER_URL?.trim()
  const jwtSecret = env.ONLYOFFICE_JWT_SECRET?.trim()

  if (documentServerUrl) {
    next.documentServerUrl = documentServerUrl
  }
  if (jwtSecret) {
    next.jwtSecret = jwtSecret
  }

  if (env.ONLYOFFICE_ENABLED !== undefined) {
    next.enabled = envBool(env.ONLYOFFICE_ENABLED, next.enabled)
  } else if (documentServerUrl && jwtSecret) {
    next.enabled = true
  }

  if (env.ONLYOFFICE_CALLBACK_BASE_URL !== undefined) {
    next.callbackBaseUrl = env.ONLYOFFICE_CALLBACK_BASE_URL.trim()
  }
  if (env.ONLYOFFICE_AUTO_TUNNEL_ENABLED !== undefined) {
    next.autoTunnelEnabled = envBool(env.ONLYOFFICE_AUTO_TUNNEL_ENABLED, next.autoTunnelEnabled)
  }
  return next
}

export const resolveEditorIntegrationConfig = (current: EditorIntegrationConfig): EditorIntegrationConfig => {
  return {
    enabled: current.enabled,
    documentServerUrl: current.documentServerUrl.trim(),
    jwtSecret: current.jwtSecret.trim(),
    callbackBaseUrl: current.callbackBaseUrl.trim(),
    autoTunnelEnabled: current.autoTunnelEnabled,
  }
}

export const redactEditorIntegrationConfig = (config: EditorIntegrationConfig): EditorIntegrationConfig => ({
  ...config,
  jwtSecret: config.jwtSecret ? REDACTED_EDITOR_SECRET : "",
})

export const coerceEditorIntegrationUpdate = (
  current: EditorIntegrationConfig,
  value: Partial<EditorIntegrationConfig>,
): EditorIntegrationConfig => ({
  enabled: typeof value.enabled === "boolean" ? value.enabled : current.enabled,
  documentServerUrl:
    typeof value.documentServerUrl === "string" ? value.documentServerUrl.trim() : current.documentServerUrl,
  jwtSecret:
    typeof value.jwtSecret === "string"
      ? value.jwtSecret === REDACTED_EDITOR_SECRET
        ? current.jwtSecret
        : value.jwtSecret.trim()
      : current.jwtSecret,
  callbackBaseUrl: typeof value.callbackBaseUrl === "string" ? value.callbackBaseUrl.trim() : current.callbackBaseUrl,
  autoTunnelEnabled: typeof value.autoTunnelEnabled === "boolean" ? value.autoTunnelEnabled : current.autoTunnelEnabled,
})
