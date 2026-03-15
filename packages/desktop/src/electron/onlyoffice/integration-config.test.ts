import { describe, expect, test } from "bun:test"
import {
  applyEditorEnvOverrides,
  coerceEditorIntegrationUpdate,
  DEFAULT_EDITOR_INTEGRATION_CONFIG,
  defaultEditorIntegrationConfig,
  redactEditorIntegrationConfig,
  REDACTED_EDITOR_SECRET,
  resolveEditorIntegrationConfig,
} from "./integration-config"

describe("onlyoffice integration config helpers", () => {
  test("starts with the editor disabled until it is configured", () => {
    expect(defaultEditorIntegrationConfig()).toEqual(DEFAULT_EDITOR_INTEGRATION_CONFIG)
    expect(DEFAULT_EDITOR_INTEGRATION_CONFIG.documentServerUrl).toBe("")
    expect(DEFAULT_EDITOR_INTEGRATION_CONFIG.enabled).toBe(false)
  })

  test("auto-enables the editor when document server and jwt env vars are provided", () => {
    const result = applyEditorEnvOverrides(defaultEditorIntegrationConfig(), {
      ONLYOFFICE_DOCUMENT_SERVER_URL: "https://docs.example.com",
      ONLYOFFICE_JWT_SECRET: "secret",
    })

    expect(result.enabled).toBe(true)
    expect(result.documentServerUrl).toBe("https://docs.example.com")
    expect(result.jwtSecret).toBe("secret")
  })

  test("respects explicit ONLYOFFICE_ENABLED=false even when env config exists", () => {
    const result = applyEditorEnvOverrides(defaultEditorIntegrationConfig(), {
      ONLYOFFICE_ENABLED: "false",
      ONLYOFFICE_DOCUMENT_SERVER_URL: "https://docs.example.com",
      ONLYOFFICE_JWT_SECRET: "secret",
    })

    expect(result.enabled).toBe(false)
  })

  test("normalizes saved config values without injecting hosted defaults", () => {
    const result = resolveEditorIntegrationConfig({
      enabled: false,
      documentServerUrl: " https://docs.example.com/ ",
      jwtSecret: " secret ",
      callbackBaseUrl: " https://callback.example.com/ ",
      autoTunnelEnabled: true,
    })

    expect(result).toEqual({
      enabled: false,
      documentServerUrl: "https://docs.example.com/",
      jwtSecret: "secret",
      callbackBaseUrl: "https://callback.example.com/",
      autoTunnelEnabled: true,
    })
  })

  test("preserves the stored jwt secret when the redacted placeholder is submitted", () => {
    const current = {
      enabled: true,
      documentServerUrl: "https://docs.example.com",
      jwtSecret: "stored-secret",
      callbackBaseUrl: "",
      autoTunnelEnabled: true,
    }

    const updated = coerceEditorIntegrationUpdate(current, {
      jwtSecret: REDACTED_EDITOR_SECRET,
      callbackBaseUrl: "https://callback.example.com",
    })

    expect(updated.jwtSecret).toBe("stored-secret")
    expect(redactEditorIntegrationConfig(updated).jwtSecret).toBe(REDACTED_EDITOR_SECRET)
  })
})
