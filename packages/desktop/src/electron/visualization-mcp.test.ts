import { describe, expect, test } from "bun:test"
import { createVisualizationMcpServer } from "./visualization-mcp"

describe("createVisualizationMcpServer", () => {
  test("returns structuredContent as an object for MCP validation", async () => {
    const server = createVisualizationMcpServer(() => ({
      directory: "/tmp/demo",
      sessions: [],
      messages: [],
      events: [],
    })) as any

    const result = await server.instance._registeredTools["visualize_data"].handler(
      {
        title: "Demo",
        chart_type: "bar",
        categories: ["A", "B"],
        series: [{ key: "runs", label: "Runs", values: [1, 2] }],
      },
      {},
    )

    expect(Array.isArray(result.content)).toBe(true)
    expect(result.structuredContent).toEqual(
      expect.objectContaining({
        type: "visualization_result",
        visualization: expect.objectContaining({
          kind: "chart",
          chartType: "bar",
        }),
      }),
    )
    expect(Array.isArray(result.structuredContent)).toBe(false)
  })
})
