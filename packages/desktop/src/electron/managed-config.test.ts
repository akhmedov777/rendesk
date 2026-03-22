import { afterEach, describe, expect, test } from "bun:test"
import { assertManagedDesktopConfig, missingManagedDesktopConfigKeys, readManagedDesktopConfig } from "./managed-config"

const envSnapshot = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
}

afterEach(() => {
  process.env.ANTHROPIC_API_KEY = envSnapshot.ANTHROPIC_API_KEY
})

describe("managed desktop config", () => {
  test("reads managed credentials", () => {
    process.env.ANTHROPIC_API_KEY = "managed-anthropic-key"

    const config = readManagedDesktopConfig()

    expect(config.anthropicApiKey).toBe("managed-anthropic-key")
  })

  test("reports missing required managed env keys", () => {
    process.env.ANTHROPIC_API_KEY = ""

    const missing = missingManagedDesktopConfigKeys()
    expect(missing).toEqual(["ANTHROPIC_API_KEY"])
  })

  test("fails fast for packaged runtime when required keys are absent", () => {
    process.env.ANTHROPIC_API_KEY = ""

    expect(() => assertManagedDesktopConfig({ packaged: true })).toThrow(
      "Managed infrastructure keys are missing",
    )
  })

  test("does not fail in non-packaged mode with missing keys", () => {
    process.env.ANTHROPIC_API_KEY = ""

    expect(() => assertManagedDesktopConfig({ packaged: false })).not.toThrow()
  })
})
