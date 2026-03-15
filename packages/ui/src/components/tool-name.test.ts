import { describe, expect, test } from "bun:test"
import { normalizeToolName } from "./tool-name"

describe("normalizeToolName", () => {
  test("strips the visualization MCP prefix for chat renderers", () => {
    expect(normalizeToolName("mcp__visualization__visualize_data")).toBe("visualize_data")
    expect(normalizeToolName("mcp__visualization__display_metrics")).toBe("display_metrics")
    expect(normalizeToolName("mcp__visualization__analytics.query_workspace")).toBe("analytics_query_workspace")
  })
})
