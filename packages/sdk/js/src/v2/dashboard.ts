export type VisualizationValueFormat =
  | "number"
  | "integer"
  | "currency_usd"
  | "percentage"
  | "tokens"
  | "duration_ms"
  | "compact"

export type VisualizationChartType = "line" | "bar" | "area" | "donut" | "combo"

export type VisualizationSeriesType = "line" | "bar" | "area"

export type VisualizationAxis = "left" | "right"

export type VisualizationChartSeries = {
  key: string
  label: string
  values: Array<number | null>
  type?: VisualizationSeriesType
  axis?: VisualizationAxis
  stack?: string
  color?: string
}

export type VisualizationChartSpec = {
  kind: "chart"
  title?: string
  description?: string
  chartType: VisualizationChartType
  categories: string[]
  series: VisualizationChartSeries[]
  valueFormat?: VisualizationValueFormat
  secondaryValueFormat?: VisualizationValueFormat
  emptyState?: string
}

export type VisualizationMetricItem = {
  key: string
  label: string
  value: number | string
  previousValue?: number | string
  change?: number
  trend?: "up" | "down" | "flat"
  format?: VisualizationValueFormat
  note?: string
}

export type VisualizationMetricSpec = {
  kind: "metrics"
  title?: string
  description?: string
  items: VisualizationMetricItem[]
}

export type VisualizationTableColumn = {
  key: string
  label: string
  align?: "left" | "center" | "right"
  format?: VisualizationValueFormat
}

export type VisualizationTableRow = Record<string, string | number | boolean | null>

export type VisualizationTableSpec = {
  kind: "table"
  title?: string
  description?: string
  columns: VisualizationTableColumn[]
  rows: VisualizationTableRow[]
  emptyState?: string
}

export type VisualizationPayload = VisualizationChartSpec | VisualizationMetricSpec | VisualizationTableSpec

export type AnalyticsDataset =
  | "session_activity"
  | "tool_usage"
  | "token_and_cost_trend"
  | "model_provider_breakdown"
  | "diff_volume"
  | "permission_or_question_load"

export type DashboardDatePreset = "24h" | "7d" | "30d" | "90d" | "all"

export type DashboardFilterState = {
  datePreset?: DashboardDatePreset
  from?: number
  to?: number
  agent?: string | null
  providerID?: string | null
  modelID?: string | null
  workspace?: string | null
  branch?: string | null
}

export type AnalyticsWorkspaceQuery = {
  dataset: AnalyticsDataset
  title?: string
  description?: string
  renderAs?: "auto" | "chart" | "metrics" | "table"
  chartType?: VisualizationChartType
  groupBy?: string
  limit?: number
  filters?: DashboardFilterState
}

export type AnalyticsQueryResult = {
  title: string
  description?: string
  generatedAt: number
  query: AnalyticsWorkspaceQuery
  columns: VisualizationTableColumn[]
  rows: VisualizationTableRow[]
  metrics?: VisualizationMetricItem[]
  visualization?: VisualizationPayload
  dashboardSource?: WidgetSource
}

export type WidgetSourceOrigin = {
  sessionID: string
  messageID: string
  partID?: string
  toolName?: string
}

export type WidgetSource =
  | {
      mode: "snapshot"
      origin?: WidgetSourceOrigin
    }
  | {
      mode: "workspace_query"
      query: AnalyticsWorkspaceQuery
      origin?: WidgetSourceOrigin
    }
  | {
      mode: "connector_query"
      connectorID?: string
      connectorQuery?: string
      origin?: WidgetSourceOrigin
    }

export type DashboardLayoutPreset = "compact" | "wide" | "hero" | "tall"

export type DashboardLayoutItem = {
  preset: DashboardLayoutPreset
  colSpan: number
  rowSpan: number
  minHeight: number
}

export type DashboardWidget = {
  id: string
  dashboardID: string
  title: string
  description?: string
  visualization: VisualizationPayload
  source: WidgetSource
  layout: DashboardLayoutItem
  time: {
    created: number
    updated: number
    refreshed?: number
  }
  refreshStatus?: "idle" | "refreshing" | "error"
  refreshError?: string
}

export type Dashboard = {
  id: string
  directory: string
  title: string
  description?: string
  filters: DashboardFilterState
  widgets: DashboardWidget[]
  time: {
    created: number
    updated: number
  }
}

export type DashboardListResult = {
  dashboards: Dashboard[]
  lastUsedDashboardID?: string
}
