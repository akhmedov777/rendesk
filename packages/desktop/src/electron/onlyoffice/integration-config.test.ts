import { describe, expect, test } from "bun:test"
import { defaultEditorConfig } from "./integration-config"

describe("editor integration config", () => {
  test("default config has editor enabled", () => {
    const config = defaultEditorConfig()
    expect(config).toEqual({ enabled: true })
  })
})
