import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import type {
  AnalyticsQueryResult,
  AnalyticsWorkspaceQuery,
  VisualizationChartSeries,
  VisualizationChartType,
  VisualizationMetricItem,
  VisualizationPayload,
  VisualizationTableColumn,
  VisualizationTableRow,
  VisualizationValueFormat,
  WidgetSource,
} from "@rendesk/sdk/v2/client"
import { z } from "zod"
import {
  buildChartVisualization,
  buildMetricVisualization,
  buildTableVisualization,
  queryResultToText,
  queryWorkspaceAnalytics,
  type AnalyticsSnapshot,
} from "./analytics.js"

const valueFormatSchema = z.enum([
  "number",
  "integer",
  "currency_usd",
  "percentage",
  "tokens",
  "duration_ms",
  "compact",
])

const dashboardSourceSchema = z
  .object({
    mode: z.enum(["snapshot", "workspace_query", "connector_query"]),
    query: z
      .object({
        dataset: z.enum([
          "session_activity",
          "tool_usage",
          "token_and_cost_trend",
          "model_provider_breakdown",
          "diff_volume",
          "permission_or_question_load",
        ]),
        title: z.string().optional(),
        description: z.string().optional(),
        renderAs: z.enum(["auto", "chart", "metrics", "table"]).optional(),
        chartType: z.enum(["line", "bar", "area", "donut", "combo"]).optional(),
        groupBy: z.string().optional(),
        limit: z.number().int().positive().max(100).optional(),
        filters: z
          .object({
            datePreset: z.enum(["24h", "7d", "30d", "90d", "all"]).optional(),
            from: z.number().optional(),
            to: z.number().optional(),
            agent: z.string().nullable().optional(),
            providerID: z.string().nullable().optional(),
            modelID: z.string().nullable().optional(),
            workspace: z.string().nullable().optional(),
            branch: z.string().nullable().optional(),
          })
          .optional(),
      })
      .optional(),
    connectorID: z.string().optional(),
    connectorQuery: z.string().optional(),
  })
  .passthrough()

const analyticsQuerySchema = z.object({
  dataset: z.enum([
    "session_activity",
    "tool_usage",
    "token_and_cost_trend",
    "model_provider_breakdown",
    "diff_volume",
    "permission_or_question_load",
  ]),
  title: z.string().optional(),
  description: z.string().optional(),
  render_as: z.enum(["auto", "chart", "metrics", "table"]).optional(),
  chart_type: z.enum(["line", "bar", "area", "donut", "combo"]).optional(),
  group_by: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
  date_preset: z.enum(["24h", "7d", "30d", "90d", "all"]).optional(),
  from: z.number().optional(),
  to: z.number().optional(),
  agent: z.string().optional(),
  provider_id: z.string().optional(),
  model_id: z.string().optional(),
  workspace: z.string().optional(),
  branch: z.string().optional(),
})

const chartSeriesSchema = z.object({
  key: z.string(),
  label: z.string(),
  values: z.array(z.number().nullable()),
  type: z.enum(["line", "bar", "area"]).optional(),
  axis: z.enum(["left", "right"]).optional(),
  stack: z.string().optional(),
  color: z.string().optional(),
})

const visualizeDataSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  chart_type: z.enum(["line", "bar", "area", "donut", "combo"]),
  categories: z.array(z.string()),
  series: z.array(chartSeriesSchema).min(1),
  value_format: valueFormatSchema.optional(),
  secondary_value_format: valueFormatSchema.optional(),
  dashboard_source: dashboardSourceSchema.optional(),
})

const displayMetricsSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  metrics: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        value: z.union([z.number(), z.string()]),
        previousValue: z.union([z.number(), z.string()]).optional(),
        change: z.number().optional(),
        trend: z.enum(["up", "down", "flat"]).optional(),
        format: valueFormatSchema.optional(),
        note: z.string().optional(),
      }),
    )
    .min(1),
  dashboard_source: dashboardSourceSchema.optional(),
})

const tableCellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])

const displayTableSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  columns: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        align: z.enum(["left", "center", "right"]).optional(),
        format: valueFormatSchema.optional(),
      }),
    )
    .min(1),
  rows: z.array(z.record(z.string(), tableCellSchema)),
  dashboard_source: dashboardSourceSchema.optional(),
})

type VisualizationEnvelope = {
  type: "visualization_result"
  visualization: VisualizationPayload
  dashboardSource?: WidgetSource
  analytics?: AnalyticsQueryResult
}

const serialize = (envelope: VisualizationEnvelope) => ({
  content: [
    {
      type: "text" as const,
      text:
        envelope.analytics && envelope.analytics.visualization
          ? queryResultToText(envelope.analytics)
          : envelope.visualization.title ?? "Generated visualization.",
    },
  ],
  structuredContent: envelope,
})

const coerceSource = (value: unknown): WidgetSource | undefined => {
  const parsed = dashboardSourceSchema.safeParse(value)
  if (!parsed.success) return
  return parsed.data as WidgetSource
}

const coerceQuery = (value: z.infer<typeof analyticsQuerySchema>): AnalyticsWorkspaceQuery => ({
  dataset: value.dataset,
  title: value.title,
  description: value.description,
  renderAs: value.render_as,
  chartType: value.chart_type,
  groupBy: value.group_by,
  limit: value.limit,
  filters: {
    datePreset: value.date_preset,
    from: value.from,
    to: value.to,
    agent: value.agent,
    providerID: value.provider_id,
    modelID: value.model_id,
    workspace: value.workspace,
    branch: value.branch,
  },
})

const chartVisualization = (input: {
  title: string
  description?: string
  chartType: VisualizationChartType
  categories: string[]
  series: VisualizationChartSeries[]
  valueFormat?: VisualizationValueFormat
  secondaryValueFormat?: VisualizationValueFormat
}) =>
  buildChartVisualization({
    title: input.title,
    description: input.description,
    chartType: input.chartType,
    categories: input.categories,
    series: input.series,
    valueFormat: input.valueFormat,
    secondaryValueFormat: input.secondaryValueFormat,
  })

export const VISUALIZATION_TOOL_NAMES = [
  "analytics.query_workspace",
  "visualize_data",
  "display_metrics",
  "display_table",
] as const

export function createVisualizationMcpServer(getSnapshot: () => AnalyticsSnapshot) {
  return createSdkMcpServer({
    name: "visualization",
    version: "1.0.0",
    tools: [
      tool(
        "analytics.query_workspace",
        "Query local workspace telemetry and return a chart, metric strip, or table for dashboard-ready desktop visualizations.",
        analyticsQuerySchema.shape,
        async (args) => {
          const query = coerceQuery(args as z.infer<typeof analyticsQuerySchema>)
          const result = queryWorkspaceAnalytics(getSnapshot(), query)
          return serialize({
            type: "visualization_result",
            visualization: result.visualization ?? buildTableVisualization({ title: result.title, description: result.description, columns: result.columns, rows: result.rows }),
            dashboardSource: result.dashboardSource,
            analytics: result,
          })
        },
      ),
      tool(
        "visualize_data",
        "Render a custom chart from structured categories and numeric series. Use this when you already know the exact chart shape you want.",
        visualizeDataSchema.shape,
        async (args) => {
          const input = args as z.infer<typeof visualizeDataSchema>
          return serialize({
            type: "visualization_result",
            visualization: chartVisualization({
              title: input.title,
              description: input.description,
              chartType: input.chart_type,
              categories: input.categories,
              series: input.series as VisualizationChartSeries[],
              valueFormat: input.value_format,
              secondaryValueFormat: input.secondary_value_format,
            }),
            dashboardSource: coerceSource(input.dashboard_source),
          })
        },
      ),
      tool(
        "display_metrics",
        "Render a metric strip with key values, deltas, and trend indicators.",
        displayMetricsSchema.shape,
        async (args) => {
          const input = args as z.infer<typeof displayMetricsSchema>
          return serialize({
            type: "visualization_result",
            visualization: buildMetricVisualization({
              title: input.title,
              description: input.description,
              metrics: input.metrics as VisualizationMetricItem[],
            }),
            dashboardSource: coerceSource(input.dashboard_source),
          })
        },
      ),
      tool(
        "display_table",
        "Render a structured detail table for the desktop timeline or dashboard.",
        displayTableSchema.shape,
        async (args) => {
          const input = args as z.infer<typeof displayTableSchema>
          return serialize({
            type: "visualization_result",
            visualization: buildTableVisualization({
              title: input.title,
              description: input.description,
              columns: input.columns as VisualizationTableColumn[],
              rows: input.rows as VisualizationTableRow[],
            }),
            dashboardSource: coerceSource(input.dashboard_source),
          })
        },
      ),
    ],
  })
}
