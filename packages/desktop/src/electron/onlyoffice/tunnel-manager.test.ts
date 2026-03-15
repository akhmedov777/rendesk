import { describe, expect, test } from "bun:test"
import { shouldReuseHealthyTunnel, type EditorTunnelState } from "./tunnel-manager"

const baseState = (overrides: Partial<EditorTunnelState> = {}): EditorTunnelState => ({
  status: "ready",
  provider: "localtunnel",
  publicUrl: "https://demo.loca.lt",
  ingressPort: 7777,
  lastError: null,
  lastStartedAt: 1,
  lastCheckedAt: 10_000,
  ...overrides,
})

describe("onlyoffice tunnel manager", () => {
  test("reuses a recently healthy tunnel without probing again", () => {
    expect(shouldReuseHealthyTunnel(baseState(), 20_000)).toBe(true)
  })

  test("does not reuse stale or errored tunnel state", () => {
    expect(shouldReuseHealthyTunnel(baseState({ lastCheckedAt: 0 }), 60_000)).toBe(false)
    expect(shouldReuseHealthyTunnel(baseState({ lastError: "down" }), 20_000)).toBe(false)
    expect(shouldReuseHealthyTunnel(baseState({ status: "error" }), 20_000)).toBe(false)
  })
})
