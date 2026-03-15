import type {
  VisualizationChartSeries,
  VisualizationChartType,
  VisualizationMetricItem,
  VisualizationPayload,
  VisualizationTableColumn,
  VisualizationTableRow,
  VisualizationValueFormat,
} from "./dashboard.js"

const VISUALIZATION_TOOL_IDS = [
  "analytics_query_workspace",
  "visualize_data",
  "display_metrics",
  "display_table",
] as const

const VISUALIZATION_VALUE_FORMATS = new Set<VisualizationValueFormat>([
  "number",
  "integer",
  "currency_usd",
  "percentage",
  "tokens",
  "duration_ms",
  "compact",
])

function canonicalToolName(toolName: string | null | undefined) {
  return (toolName ?? "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isChartType(value: unknown): value is VisualizationChartType {
  return value === "line" || value === "bar" || value === "area" || value === "donut" || value === "combo"
}

function visualizationValueFormat(value: unknown): VisualizationValueFormat | undefined {
  return typeof value === "string" && VISUALIZATION_VALUE_FORMATS.has(value as VisualizationValueFormat)
    ? (value as VisualizationValueFormat)
    : undefined
}

function chartSeries(value: unknown): VisualizationChartSeries[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): VisualizationChartSeries[] => {
    if (!isPlainObject(item) || typeof item.key !== "string" || typeof item.label !== "string") return []
    if (!Array.isArray(item.values)) return []
    const values = item.values.map((entry) => {
      if (typeof entry === "number" && Number.isFinite(entry)) return entry
      if (entry === null) return null
      return null
    })

    return [
      {
        key: item.key,
        label: item.label,
        values,
        type: item.type === "line" || item.type === "bar" || item.type === "area" ? item.type : undefined,
        axis: item.axis === "left" || item.axis === "right" ? item.axis : undefined,
        stack: typeof item.stack === "string" ? item.stack : undefined,
        color: typeof item.color === "string" ? item.color : undefined,
      },
    ]
  })
}

function metricItems(value: unknown): VisualizationMetricItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): VisualizationMetricItem[] => {
    if (!isPlainObject(item) || typeof item.key !== "string" || typeof item.label !== "string") return []
    if (typeof item.value !== "number" && typeof item.value !== "string") return []

    return [
      {
        key: item.key,
        label: item.label,
        value: item.value,
        previousValue:
          typeof item.previousValue === "number" || typeof item.previousValue === "string" ? item.previousValue : undefined,
        change: typeof item.change === "number" && Number.isFinite(item.change) ? item.change : undefined,
        trend: item.trend === "up" || item.trend === "down" || item.trend === "flat" ? item.trend : undefined,
        format: visualizationValueFormat(item.format),
        note: typeof item.note === "string" ? item.note : undefined,
      },
    ]
  })
}

function tableColumns(value: unknown): VisualizationTableColumn[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): VisualizationTableColumn[] => {
    if (!isPlainObject(item) || typeof item.key !== "string" || typeof item.label !== "string") return []
    return [
      {
        key: item.key,
        label: item.label,
        align: item.align === "left" || item.align === "center" || item.align === "right" ? item.align : undefined,
        format: visualizationValueFormat(item.format),
      },
    ]
  })
}

function tableRows(value: unknown): VisualizationTableRow[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): VisualizationTableRow[] => {
    if (!isPlainObject(item)) return []
    const row: VisualizationTableRow = {}
    for (const [key, cell] of Object.entries(item)) {
      if (typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean" || cell === null) {
        row[key] = cell
      }
    }
    return [row]
  })
}

export function normalizeVisualizationToolName(toolName: string | null | undefined) {
  const canonical = canonicalToolName(toolName)
  if (!canonical) return ""

  for (const toolID of VISUALIZATION_TOOL_IDS) {
    if (canonical === toolID || canonical.endsWith(`_${toolID}`)) {
      return toolID
    }
  }

  return canonical
}

export function isVisualizationToolName(toolName: string | null | undefined) {
  return VISUALIZATION_TOOL_IDS.includes(
    normalizeVisualizationToolName(toolName) as (typeof VISUALIZATION_TOOL_IDS)[number],
  )
}

export function parseVisualizationToolInput(toolName: string | null | undefined, input: unknown): VisualizationPayload | undefined {
  if (!isPlainObject(input)) return

  const normalized = normalizeVisualizationToolName(toolName)

  if (normalized === "visualize_data") {
    const title = typeof input.title === "string" ? input.title : undefined
    const chartType = isChartType(input.chart_type) ? input.chart_type : undefined
    const categories = Array.isArray(input.categories) ? input.categories.filter((item): item is string => typeof item === "string") : []
    const series = chartSeries(input.series)

    if (!title || !chartType || categories.length === 0 || series.length === 0) return

    return {
      kind: "chart",
      title,
      description: typeof input.description === "string" ? input.description : undefined,
      chartType,
      categories,
      series,
      valueFormat: visualizationValueFormat(input.value_format),
      secondaryValueFormat: visualizationValueFormat(input.secondary_value_format),
    }
  }

  if (normalized === "display_metrics") {
    const title = typeof input.title === "string" ? input.title : undefined
    const items = metricItems(input.metrics)
    if (!title || items.length === 0) return

    return {
      kind: "metrics",
      title,
      description: typeof input.description === "string" ? input.description : undefined,
      items,
    }
  }

  if (normalized === "display_table") {
    const title = typeof input.title === "string" ? input.title : undefined
    const columns = tableColumns(input.columns)
    const rows = tableRows(input.rows)
    if (!title || columns.length === 0) return

    return {
      kind: "table",
      title,
      description: typeof input.description === "string" ? input.description : undefined,
      columns,
      rows,
    }
  }
}
