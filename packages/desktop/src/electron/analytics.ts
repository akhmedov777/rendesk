import type {
  AnalyticsQueryResult,
  AnalyticsWorkspaceQuery,
  DashboardDatePreset,
  DashboardFilterState,
  VisualizationChartSeries,
  VisualizationChartSpec,
  VisualizationMetricItem,
  VisualizationPayload,
  VisualizationTableColumn,
  VisualizationTableRow,
  WidgetSource,
} from "@rendesk/sdk/v2/client"

type SessionLike = {
  id: string
  directory: string
  time: {
    created: number
    updated?: number
    archived?: number
  }
  summary?: {
    additions?: number
    deletions?: number
    files?: number
  }
}

type UserMessageLike = {
  id: string
  sessionID: string
  role: "user"
  time: {
    created: number
  }
  agent?: string
  model?: {
    providerID: string
    modelID: string
  }
  summary?: {
    diffs?: Array<{
      additions?: number
      deletions?: number
      file?: string
    }>
  }
}

type AssistantMessageLike = {
  id: string
  sessionID: string
  role: "assistant"
  time: {
    created: number
    completed?: number
  }
  agent?: string
  providerID?: string
  modelID?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: {
      read?: number
      write?: number
    }
  }
}

type ToolPartLike = {
  type: "tool"
  tool: string
  state: {
    status?: string
    time?: {
      start?: number
      end?: number
    }
  }
}

type MessageEntryLike = {
  info: UserMessageLike | AssistantMessageLike
  parts: Array<ToolPartLike | { type: string }>
}

type AnalyticsEvent = {
  id: string
  directory: string
  sessionID: string
  type: "permission_asked" | "question_asked"
  createdAt: number
}

export type AnalyticsSnapshot = {
  directory: string
  sessions: SessionLike[]
  messages: MessageEntryLike[]
  events: AnalyticsEvent[]
}

type TimeGranularity = "hour" | "day"

const DEFAULT_COLORS = ["#0f766e", "#d97706", "#2563eb", "#b91c1c", "#1d4ed8", "#15803d"]

const PRESET_MS: Record<Exclude<DashboardDatePreset, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
}

const numberValue = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)

const canonicalToolName = (tool: string) =>
  tool
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()

const branchOfDirectory = (directory: string) => {
  const parts = directory.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? directory
}

const isoDay = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10)

const isoHour = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 13) + ":00"

const timeLabel = (timestamp: number, granularity: TimeGranularity) =>
  granularity === "hour" ? isoHour(timestamp) : isoDay(timestamp)

const startOfBucket = (timestamp: number, granularity: TimeGranularity) => {
  const date = new Date(timestamp)
  if (granularity === "hour") {
    date.setMinutes(0, 0, 0)
    return date.getTime()
  }
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const nextBucket = (timestamp: number, granularity: TimeGranularity) => {
  const date = new Date(timestamp)
  if (granularity === "hour") {
    date.setHours(date.getHours() + 1)
    return date.getTime()
  }
  date.setDate(date.getDate() + 1)
  return date.getTime()
}

const pickGranularity = (from: number, to: number): TimeGranularity => (to - from <= 48 * 60 * 60 * 1000 ? "hour" : "day")

const rangeFromFilters = (filters: DashboardFilterState | undefined, currentTime: number) => {
  const to = typeof filters?.to === "number" ? filters.to : currentTime
  if (typeof filters?.from === "number") {
    return {
      from: filters.from,
      to,
    }
  }

  const preset = filters?.datePreset ?? "30d"
  if (preset === "all") {
    return {
      from: 0,
      to,
    }
  }

  return {
    from: Math.max(0, to - PRESET_MS[preset]),
    to,
  }
}

const buildBucketOrder = (from: number, to: number, granularity: TimeGranularity) => {
  const values: string[] = []
  for (let cursor = startOfBucket(from, granularity); cursor <= to; cursor = nextBucket(cursor, granularity)) {
    values.push(timeLabel(cursor, granularity))
  }
  return values
}

const eventInRange = (timestamp: number, from: number, to: number) => timestamp >= from && timestamp <= to

type MessageFilterMeta = {
  directory: string
  timestamp: number
  agent?: string
  providerID?: string
  modelID?: string
}

const matchesCommonFilters = (meta: MessageFilterMeta, filters: DashboardFilterState | undefined, from: number, to: number) => {
  if (!eventInRange(meta.timestamp, from, to)) return false
  if (filters?.workspace && filters.workspace !== meta.directory) return false
  if (filters?.branch && filters.branch !== branchOfDirectory(meta.directory)) return false
  if (filters?.agent && filters.agent !== meta.agent) return false
  if (filters?.providerID && filters.providerID !== meta.providerID) return false
  if (filters?.modelID && filters.modelID !== meta.modelID) return false
  return true
}

const isToolPart = (part: MessageEntryLike["parts"][number]): part is ToolPartLike =>
  part.type === "tool" && "tool" in part && "state" in part

const rowsToColumns = (rows: VisualizationTableRow[]): VisualizationTableColumn[] => {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  return keys.map((key) => ({ key, label: key }))
}

const chartSource = (query: AnalyticsWorkspaceQuery): WidgetSource => ({
  mode: "workspace_query",
  query,
})

function buildChartResult(input: {
  title: string
  description?: string
  query: AnalyticsWorkspaceQuery
  rows: VisualizationTableRow[]
  metrics?: VisualizationMetricItem[]
  chart: VisualizationChartSpec
}): AnalyticsQueryResult {
  return {
    title: input.title,
    description: input.description,
    generatedAt: Date.now(),
    query: input.query,
    columns: rowsToColumns(input.rows),
    rows: input.rows,
    metrics: input.metrics,
    visualization: input.chart,
    dashboardSource: chartSource(input.query),
  }
}

function buildMetricResult(input: {
  title: string
  description?: string
  query: AnalyticsWorkspaceQuery
  rows: VisualizationTableRow[]
  metrics: VisualizationMetricItem[]
  visualization: VisualizationPayload
}): AnalyticsQueryResult {
  return {
    title: input.title,
    description: input.description,
    generatedAt: Date.now(),
    query: input.query,
    columns: rowsToColumns(input.rows),
    rows: input.rows,
    metrics: input.metrics,
    visualization: input.visualization,
    dashboardSource: chartSource(input.query),
  }
}

function withRequestedVisualization(result: AnalyticsQueryResult): AnalyticsQueryResult {
  const renderAs = result.query.renderAs ?? "auto"
  if (renderAs === "auto" || renderAs === "chart") return result
  if (renderAs === "metrics" && result.metrics?.length) {
    return {
      ...result,
      visualization: buildMetricVisualization({
        title: result.title,
        description: result.description,
        metrics: result.metrics,
      }),
    }
  }
  if (renderAs === "table") {
    return {
      ...result,
      visualization: buildTableVisualization({
        title: result.title,
        description: result.description,
        columns: result.columns,
        rows: result.rows,
      }),
    }
  }
  return result
}

export function queryWorkspaceAnalytics(snapshot: AnalyticsSnapshot, query: AnalyticsWorkspaceQuery): AnalyticsQueryResult {
  const now = Date.now()
  const filters = query.filters
  const { from, to } = rangeFromFilters(filters, now)
  const granularity = pickGranularity(from, to)
  const sessionByID = new Map(snapshot.sessions.map((session) => [session.id, session]))
  const bucketOrder = buildBucketOrder(from, to, granularity)

  const assistantEntries = snapshot.messages.flatMap((entry) => {
    if (entry.info.role !== "assistant") return []
    const session = sessionByID.get(entry.info.sessionID)
    if (!session) return []
    const assistant = entry.info as AssistantMessageLike
    const timestamp = assistant.time.completed ?? assistant.time.created
    if (
      !matchesCommonFilters(
        {
          directory: session.directory,
          timestamp,
          agent: assistant.agent,
          providerID: assistant.providerID,
          modelID: assistant.modelID,
        },
        filters,
        from,
        to,
      )
    ) {
      return []
    }

    return [
      {
        session,
        assistant,
        entry,
        timestamp,
      },
    ]
  })

  const userEntries = snapshot.messages.flatMap((entry) => {
    if (entry.info.role !== "user") return []
    const session = sessionByID.get(entry.info.sessionID)
    if (!session) return []
    const user = entry.info as UserMessageLike
    if (
      !matchesCommonFilters(
        {
          directory: session.directory,
          timestamp: user.time.created,
          agent: user.agent,
          providerID: user.model?.providerID,
          modelID: user.model?.modelID,
        },
        filters,
        from,
        to,
      )
    ) {
      return []
    }

    return [
      {
        session,
        user,
        entry,
        timestamp: user.time.created,
      },
    ]
  })

  switch (query.dataset) {
    case "session_activity": {
      const byBucket = new Map<string, { sessions: number; prompts: number; responses: number }>()
      for (const label of bucketOrder) {
        byBucket.set(label, { sessions: 0, prompts: 0, responses: 0 })
      }

      for (const session of snapshot.sessions) {
        if (session.time.archived) continue
        if (
          !matchesCommonFilters(
            {
              directory: session.directory,
              timestamp: session.time.created,
            },
            filters,
            from,
            to,
          )
        ) {
          continue
        }
        const label = timeLabel(startOfBucket(session.time.created, granularity), granularity)
        const bucket = byBucket.get(label)
        if (bucket) bucket.sessions += 1
      }

      for (const entry of userEntries) {
        const label = timeLabel(startOfBucket(entry.timestamp, granularity), granularity)
        const bucket = byBucket.get(label)
        if (bucket) bucket.prompts += 1
      }

      for (const entry of assistantEntries) {
        const label = timeLabel(startOfBucket(entry.timestamp, granularity), granularity)
        const bucket = byBucket.get(label)
        if (bucket) bucket.responses += 1
      }

      const rows = bucketOrder.map((bucket) => {
        const value = byBucket.get(bucket) ?? { sessions: 0, prompts: 0, responses: 0 }
        return {
          bucket,
          sessions: value.sessions,
          prompts: value.prompts,
          responses: value.responses,
        }
      })

      return withRequestedVisualization(
        buildChartResult({
        title: query.title ?? "Session activity",
        description: query.description ?? "New sessions, prompts, and assistant responses over time.",
        query,
        rows,
        metrics: [
          { key: "sessions", label: "Sessions", value: rows.reduce((sum, row) => sum + numberValue(row.sessions), 0), format: "integer" },
          { key: "prompts", label: "Prompts", value: rows.reduce((sum, row) => sum + numberValue(row.prompts), 0), format: "integer" },
          {
            key: "responses",
            label: "Responses",
            value: rows.reduce((sum, row) => sum + numberValue(row.responses), 0),
            format: "integer",
          },
        ],
        chart: {
          kind: "chart",
          title: query.title ?? "Session activity",
          description: query.description ?? "New sessions, prompts, and assistant responses over time.",
          chartType: query.chartType ?? "area",
          categories: bucketOrder,
          series: [
            { key: "prompts", label: "Prompts", values: rows.map((row) => numberValue(row.prompts)), type: "area", color: DEFAULT_COLORS[0] },
            { key: "responses", label: "Responses", values: rows.map((row) => numberValue(row.responses)), type: "line", color: DEFAULT_COLORS[1] },
            { key: "sessions", label: "Sessions", values: rows.map((row) => numberValue(row.sessions)), type: "bar", color: DEFAULT_COLORS[2] },
          ],
          valueFormat: "integer",
          emptyState: "No session activity for the selected filters.",
        },
        }),
      )
    }

    case "tool_usage": {
      const counts = new Map<string, number>()
      for (const entry of assistantEntries) {
        for (const part of entry.entry.parts) {
          if (!isToolPart(part)) continue
          const label = canonicalToolName(part.tool)
          counts.set(label, (counts.get(label) ?? 0) + 1)
        }
      }

      const rows = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.max(1, query.limit ?? 12))
        .map(([tool, runs]) => ({ tool, runs }))

      const metrics: VisualizationMetricItem[] = [
        { key: "runs", label: "Runs", value: rows.reduce((sum, row) => sum + numberValue(row.runs), 0), format: "integer" },
        { key: "unique_tools", label: "Tool types", value: rows.length, format: "integer" },
      ]

      return withRequestedVisualization(
        buildChartResult({
        title: query.title ?? "Tool usage",
        description: query.description ?? "Most frequently used tools in the selected range.",
        query,
        rows,
        metrics,
        chart: {
          kind: "chart",
          title: query.title ?? "Tool usage",
          description: query.description ?? "Most frequently used tools in the selected range.",
          chartType: query.chartType ?? (rows.length <= 6 ? "donut" : "bar"),
          categories: rows.map((row) => String(row.tool)),
          series: [{ key: "runs", label: "Runs", values: rows.map((row) => numberValue(row.runs)), type: "bar", color: DEFAULT_COLORS[0] }],
          valueFormat: "integer",
          emptyState: "No tool activity for the selected filters.",
        },
        }),
      )
    }

    case "token_and_cost_trend": {
      const byBucket = new Map<string, { totalTokens: number; costUsd: number }>()
      for (const label of bucketOrder) {
        byBucket.set(label, { totalTokens: 0, costUsd: 0 })
      }

      for (const entry of assistantEntries) {
        const label = timeLabel(startOfBucket(entry.timestamp, granularity), granularity)
        const bucket = byBucket.get(label)
        if (!bucket) continue
        const totalTokens =
          numberValue(entry.assistant.tokens?.input) +
          numberValue(entry.assistant.tokens?.output) +
          numberValue(entry.assistant.tokens?.reasoning)
        bucket.totalTokens += totalTokens
        bucket.costUsd += numberValue(entry.assistant.cost)
      }

      const rows = bucketOrder.map((bucket) => {
        const value = byBucket.get(bucket) ?? { totalTokens: 0, costUsd: 0 }
        return {
          bucket,
          totalTokens: Number(value.totalTokens.toFixed(2)),
          costUsd: Number(value.costUsd.toFixed(4)),
        }
      })

      return withRequestedVisualization(
        buildChartResult({
        title: query.title ?? "Token and cost trend",
        description: query.description ?? "Assistant token volume and spend over time.",
        query,
        rows,
        metrics: [
          {
            key: "total_tokens",
            label: "Total tokens",
            value: rows.reduce((sum, row) => sum + numberValue(row.totalTokens), 0),
            format: "compact",
          },
          {
            key: "total_cost",
            label: "Cost",
            value: rows.reduce((sum, row) => sum + numberValue(row.costUsd), 0),
            format: "currency_usd",
          },
        ],
        chart: {
          kind: "chart",
          title: query.title ?? "Token and cost trend",
          description: query.description ?? "Assistant token volume and spend over time.",
          chartType: query.chartType ?? "combo",
          categories: bucketOrder,
          series: [
            {
              key: "totalTokens",
              label: "Total tokens",
              values: rows.map((row) => numberValue(row.totalTokens)),
              type: "line",
              axis: "left",
              color: DEFAULT_COLORS[2],
            },
            {
              key: "costUsd",
              label: "Cost (USD)",
              values: rows.map((row) => numberValue(row.costUsd)),
              type: "bar",
              axis: "right",
              color: DEFAULT_COLORS[1],
            },
          ],
          valueFormat: "compact",
          secondaryValueFormat: "currency_usd",
          emptyState: "No token or cost data for the selected filters.",
        },
        }),
      )
    }

    case "model_provider_breakdown": {
      const byModel = new Map<string, { provider: string; model: string; responses: number; totalTokens: number; costUsd: number }>()
      const byProvider = new Map<string, number>()

      for (const entry of assistantEntries) {
        const provider = entry.assistant.providerID ?? "unknown"
        const model = entry.assistant.modelID ?? "unknown"
        const key = `${provider}/${model}`
        const current = byModel.get(key) ?? { provider, model, responses: 0, totalTokens: 0, costUsd: 0 }
        current.responses += 1
        current.totalTokens +=
          numberValue(entry.assistant.tokens?.input) +
          numberValue(entry.assistant.tokens?.output) +
          numberValue(entry.assistant.tokens?.reasoning)
        current.costUsd += numberValue(entry.assistant.cost)
        byModel.set(key, current)
        byProvider.set(provider, (byProvider.get(provider) ?? 0) + 1)
      }

      const rows = [...byModel.values()]
        .sort((a, b) => b.responses - a.responses)
        .map((row) => ({
          provider: row.provider,
          model: row.model,
          responses: row.responses,
          totalTokens: row.totalTokens,
          costUsd: Number(row.costUsd.toFixed(4)),
        }))

      const providerRows = [...byProvider.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([provider, responses]) => ({ provider, responses }))

      return withRequestedVisualization(
        buildChartResult({
        title: query.title ?? "Model and provider breakdown",
        description: query.description ?? "Response share by model provider for the selected range.",
        query,
        rows,
        metrics: [
          { key: "responses", label: "Responses", value: rows.reduce((sum, row) => sum + numberValue(row.responses), 0), format: "integer" },
          { key: "providers", label: "Providers", value: providerRows.length, format: "integer" },
          { key: "models", label: "Models", value: rows.length, format: "integer" },
        ],
        chart: {
          kind: "chart",
          title: query.title ?? "Model and provider breakdown",
          description: query.description ?? "Response share by model provider for the selected range.",
          chartType: query.chartType ?? "donut",
          categories: providerRows.map((row) => row.provider),
          series: [
            {
              key: "responses",
              label: "Responses",
              values: providerRows.map((row) => numberValue(row.responses)),
              type: "bar",
              color: DEFAULT_COLORS[0],
            },
          ],
          valueFormat: "integer",
          emptyState: "No model activity for the selected filters.",
        },
        }),
      )
    }

    case "diff_volume": {
      const byBucket = new Map<string, { additions: number; deletions: number; files: number }>()
      for (const label of bucketOrder) {
        byBucket.set(label, { additions: 0, deletions: 0, files: 0 })
      }

      for (const entry of userEntries) {
        const diffs = entry.user.summary?.diffs ?? []
        if (diffs.length === 0) continue
        const label = timeLabel(startOfBucket(entry.timestamp, granularity), granularity)
        const bucket = byBucket.get(label)
        if (!bucket) continue
        bucket.files += diffs.length
        for (const diff of diffs) {
          bucket.additions += numberValue(diff.additions)
          bucket.deletions += numberValue(diff.deletions)
        }
      }

      const rows = bucketOrder.map((bucket) => {
        const value = byBucket.get(bucket) ?? { additions: 0, deletions: 0, files: 0 }
        return {
          bucket,
          additions: value.additions,
          deletions: value.deletions,
          files: value.files,
        }
      })

      return withRequestedVisualization(
        buildChartResult({
        title: query.title ?? "Diff volume",
        description: query.description ?? "Code churn captured in user turn summaries.",
        query,
        rows,
        metrics: [
          {
            key: "additions",
            label: "Additions",
            value: rows.reduce((sum, row) => sum + numberValue(row.additions), 0),
            format: "integer",
          },
          {
            key: "deletions",
            label: "Deletions",
            value: rows.reduce((sum, row) => sum + numberValue(row.deletions), 0),
            format: "integer",
          },
          { key: "files", label: "Files", value: rows.reduce((sum, row) => sum + numberValue(row.files), 0), format: "integer" },
        ],
        chart: {
          kind: "chart",
          title: query.title ?? "Diff volume",
          description: query.description ?? "Code churn captured in user turn summaries.",
          chartType: query.chartType ?? "area",
          categories: bucketOrder,
          series: [
            { key: "additions", label: "Additions", values: rows.map((row) => numberValue(row.additions)), type: "area", color: DEFAULT_COLORS[0] },
            { key: "deletions", label: "Deletions", values: rows.map((row) => numberValue(row.deletions)), type: "line", color: DEFAULT_COLORS[3] },
            { key: "files", label: "Files", values: rows.map((row) => numberValue(row.files)), type: "bar", color: DEFAULT_COLORS[4] },
          ],
          valueFormat: "integer",
          emptyState: "No diff summaries for the selected filters.",
        },
        }),
      )
    }

    case "permission_or_question_load": {
      const byBucket = new Map<string, { permissions: number; questions: number }>()
      for (const label of bucketOrder) {
        byBucket.set(label, { permissions: 0, questions: 0 })
      }

      for (const event of snapshot.events) {
        if (
          !matchesCommonFilters(
            {
              directory: event.directory,
              timestamp: event.createdAt,
            },
            filters,
            from,
            to,
          )
        ) {
          continue
        }
        const label = timeLabel(startOfBucket(event.createdAt, granularity), granularity)
        const bucket = byBucket.get(label)
        if (!bucket) continue
        if (event.type === "permission_asked") bucket.permissions += 1
        if (event.type === "question_asked") bucket.questions += 1
      }

      for (const entry of assistantEntries) {
        for (const part of entry.entry.parts) {
          if (!isToolPart(part)) continue
          const toolName = canonicalToolName(part.tool)
          if (toolName !== "question" && toolName !== "ask_user_question") continue
          const timestamp = part.state.time?.start ?? entry.timestamp
          const label = timeLabel(startOfBucket(timestamp, granularity), granularity)
          const bucket = byBucket.get(label)
          if (bucket) bucket.questions += 1
        }
      }

      const rows = bucketOrder.map((bucket) => {
        const value = byBucket.get(bucket) ?? { permissions: 0, questions: 0 }
        return {
          bucket,
          permissions: value.permissions,
          questions: value.questions,
        }
      })

      return withRequestedVisualization(
        buildChartResult({
        title: query.title ?? "Permission and question load",
        description: query.description ?? "User interruptions triggered by permissions or questions.",
        query,
        rows,
        metrics: [
          {
            key: "permissions",
            label: "Permissions",
            value: rows.reduce((sum, row) => sum + numberValue(row.permissions), 0),
            format: "integer",
          },
          {
            key: "questions",
            label: "Questions",
            value: rows.reduce((sum, row) => sum + numberValue(row.questions), 0),
            format: "integer",
          },
        ],
        chart: {
          kind: "chart",
          title: query.title ?? "Permission and question load",
          description: query.description ?? "User interruptions triggered by permissions or questions.",
          chartType: query.chartType ?? "bar",
          categories: bucketOrder,
          series: [
            { key: "permissions", label: "Permissions", values: rows.map((row) => numberValue(row.permissions)), type: "bar", color: DEFAULT_COLORS[1] },
            { key: "questions", label: "Questions", values: rows.map((row) => numberValue(row.questions)), type: "line", color: DEFAULT_COLORS[2] },
          ],
          valueFormat: "integer",
          emptyState: "No permission or question events for the selected filters.",
        },
        }),
      )
    }
  }
}

export function queryResultToText(result: AnalyticsQueryResult) {
  const metricSummary = result.metrics
    ?.slice(0, 3)
    .map((item) => `${item.label}: ${item.value}`)
    .join(" | ")
  if (metricSummary) {
    return `${result.title}\n${metricSummary}`
  }
  return `${result.title}\nGenerated ${result.rows.length} rows.`
}

export function buildMetricVisualization(input: {
  title: string
  description?: string
  metrics: VisualizationMetricItem[]
}): VisualizationPayload {
  return {
    kind: "metrics",
    title: input.title,
    description: input.description,
    items: input.metrics,
  }
}

export function buildTableVisualization(input: {
  title: string
  description?: string
  columns: VisualizationTableColumn[]
  rows: VisualizationTableRow[]
}): VisualizationPayload {
  return {
    kind: "table",
    title: input.title,
    description: input.description,
    columns: input.columns,
    rows: input.rows,
  }
}

export function buildChartVisualization(input: {
  title: string
  description?: string
  chartType: VisualizationChartSpec["chartType"]
  categories: string[]
  series: VisualizationChartSeries[]
  valueFormat?: VisualizationChartSpec["valueFormat"]
  secondaryValueFormat?: VisualizationChartSpec["secondaryValueFormat"]
}): VisualizationPayload {
  return {
    kind: "chart",
    title: input.title,
    description: input.description,
    chartType: input.chartType,
    categories: input.categories,
    series: input.series,
    valueFormat: input.valueFormat,
    secondaryValueFormat: input.secondaryValueFormat,
  }
}
