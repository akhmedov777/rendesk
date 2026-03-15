import { describe, expect, test } from "bun:test"
import {
  isVisualizationToolName,
  normalizeVisualizationToolName,
  parseVisualizationToolInput,
  type VisualizationPayload,
} from "@rendesk/sdk/v2/client"
import {
  isVisualizationPayload,
  isWidgetSource,
  relativeTimeLabel,
  reorderIds,
  resolveVisualizationPayload,
  snapshotSource,
  sourceModeLabel,
} from "./helpers"

const FIXED_NOW = Date.UTC(2026, 0, 31, 12, 0, 0)

function withMockedNow<T>(fn: () => T): T {
  const originalNow = Date.now
  Date.now = () => FIXED_NOW
  try {
    return fn()
  } finally {
    Date.now = originalNow
  }
}

describe("dashboard helpers", () => {
  test("validates visualization payloads", () => {
    expect(
      isVisualizationPayload({
        kind: "chart",
        chartType: "line",
        categories: ["Mon"],
        series: [{ key: "runs", label: "Runs", values: [4] }],
      }),
    ).toBe(true)

    expect(
      isVisualizationPayload({
        kind: "chart",
        categories: ["Mon"],
      }),
    ).toBe(false)

    expect(
      isVisualizationPayload({
        kind: "metrics",
        items: [{ key: "runs", label: "Runs", value: 12 }],
      }),
    ).toBe(true)
  })

  test("resolves visualization payloads from metadata first, then tool input", () => {
    const metadataPayload: VisualizationPayload = {
      kind: "metrics",
      title: "Saved metrics",
      items: [{ key: "runs", label: "Runs", value: 12 }],
    }

    expect(
      resolveVisualizationPayload("display_metrics", metadataPayload, {
        title: "Ignored fallback",
        metrics: [{ key: "errors", label: "Errors", value: 2 }],
      }),
    ).toEqual(metadataPayload)

    expect(
      resolveVisualizationPayload("mcp__visualization__display_metrics", undefined, {
        title: "Fallback metrics",
        metrics: [{ key: "runs", label: "Runs", value: 12 }],
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "metrics",
        title: "Fallback metrics",
      }),
    )

    expect(
      resolveVisualizationPayload("display_table", undefined, {
        title: "Broken table",
        rows: [],
      }),
    ).toBeUndefined()
  })

  test("normalizes and parses visualization tools across namespaces", () => {
    expect(normalizeVisualizationToolName("mcp__visualization__visualize_data")).toBe("visualize_data")
    expect(normalizeVisualizationToolName("mcp__renvel_interaction__display_metrics")).toBe("display_metrics")
    expect(normalizeVisualizationToolName("analytics.query_workspace")).toBe("analytics_query_workspace")

    expect(isVisualizationToolName("visualize_data")).toBe(true)
    expect(isVisualizationToolName("mcp__renvel-data-analyst__display_table")).toBe(true)
    expect(isVisualizationToolName("analytics.query_workspace")).toBe(true)
    expect(isVisualizationToolName("ToolSearch")).toBe(false)

    expect(
      parseVisualizationToolInput("mcp__visualization__visualize_data", {
        title: "Revenue trend",
        chart_type: "line",
        categories: ["Jan", "Feb"],
        series: [{ key: "revenue", label: "Revenue", values: [1200, 1800] }],
        value_format: "currency_usd",
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "chart",
        title: "Revenue trend",
        chartType: "line",
      }),
    )

    expect(
      parseVisualizationToolInput("display_metrics", {
        title: "KPI snapshot",
        metrics: [{ key: "mrr", label: "MRR", value: 129000, trend: "up", format: "currency_usd" }],
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "metrics",
        title: "KPI snapshot",
      }),
    )

    expect(
      parseVisualizationToolInput("display_table", {
        title: "Top customers",
        columns: [{ key: "name", label: "Name" }],
        rows: [{ name: "Acme" }],
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "table",
        title: "Top customers",
      }),
    )

    expect(
      parseVisualizationToolInput("visualize_data", {
        title: "Broken",
        chart_type: "line",
        categories: [],
        series: [],
      }),
    ).toBeUndefined()
  })

  test("validates widget sources", () => {
    expect(isWidgetSource(snapshotSource())).toBe(true)
    expect(
      isWidgetSource({
        mode: "workspace_query",
        query: {
          dataset: "tool_usage",
        },
      }),
    ).toBe(true)
    expect(
      isWidgetSource({
        mode: "workspace_query",
        query: {},
      }),
    ).toBe(false)
  })

  test("formats source labels and relative times", () => {
    expect(sourceModeLabel(snapshotSource())).toBe("Snapshot")
    expect(
      sourceModeLabel({
        mode: "workspace_query",
        query: {
          dataset: "session_activity",
        },
      }),
    ).toBe("Live workspace")

    expect(withMockedNow(() => relativeTimeLabel(FIXED_NOW - 30_000))).toBe("Just now")
    expect(withMockedNow(() => relativeTimeLabel(FIXED_NOW - 5 * 60_000))).toBe("5m ago")
    expect(withMockedNow(() => relativeTimeLabel(FIXED_NOW - 2 * 60 * 60_000))).toBe("2h ago")
    expect(withMockedNow(() => relativeTimeLabel(FIXED_NOW - 3 * 24 * 60 * 60_000))).toBe("3d ago")
  })

  test("reorders widget ids without losing untouched items", () => {
    expect(reorderIds(["a", "b", "c", "d"], "c", "a")).toEqual(["c", "a", "b", "d"])
    expect(reorderIds(["a", "b", "c"], "x", "b")).toEqual(["a", "b", "c"])
  })
})
