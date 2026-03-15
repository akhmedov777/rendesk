import { describe, expect, test } from "bun:test"
import { getOnlyOfficeLoadTimeoutMs, getOnlyOfficeSlowLoadMessage } from "./load-policy"

describe("onlyoffice load policy", () => {
  test("increases timeout for remote transports and larger files", () => {
    expect(getOnlyOfficeLoadTimeoutMs("local", 0)).toBe(25_000)
    expect(getOnlyOfficeLoadTimeoutMs("manual", 0)).toBe(60_000)
    expect(getOnlyOfficeLoadTimeoutMs("auto-tunnel", 0)).toBe(90_000)
    expect(getOnlyOfficeLoadTimeoutMs("auto-tunnel", 25 * 1024 * 1024)).toBeGreaterThan(90_000)
  })

  test("describes slow remote spreadsheet loads without treating them as hard failures", () => {
    expect(getOnlyOfficeSlowLoadMessage("cell", "auto-tunnel")).toContain("spreadsheet")
    expect(getOnlyOfficeSlowLoadMessage("cell", "auto-tunnel")).toContain("desktop bridge")
    expect(getOnlyOfficeSlowLoadMessage("word", "manual")).toContain("hosted Document Server")
  })
})
