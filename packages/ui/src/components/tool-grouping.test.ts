import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@rendesk/sdk/v2"
import { isActionGroupToolPart, isStandaloneToolPart } from "./tool-grouping"

const toolPart = (tool: string) =>
  ({
    id: `part:${tool}`,
    callID: `call:${tool}`,
    sessionID: "session_1",
    messageID: "message_1",
    type: "tool",
    tool,
    state: {
      status: "completed",
      input: {},
      output: "",
      title: tool,
      time: { start: 1, end: 2 },
    },
  }) as ToolPart

describe("tool grouping", () => {
  test("keeps visualization tools standalone", () => {
    expect(isStandaloneToolPart(toolPart("mcp__visualization__visualize_data"))).toBe(true)
    expect(isStandaloneToolPart(toolPart("analytics.query_workspace"))).toBe(true)
    expect(isActionGroupToolPart(toolPart("mcp__visualization__display_metrics"))).toBe(false)
  })

  test("still allows non-visual tools in action groups", () => {
    expect(isStandaloneToolPart(toolPart("ToolSearch"))).toBe(false)
    expect(isActionGroupToolPart(toolPart("ToolSearch"))).toBe(true)
  })
})
