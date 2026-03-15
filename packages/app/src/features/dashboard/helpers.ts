import type {
  DashboardFilterState,
  DashboardLayoutPreset,
  VisualizationPayload,
  WidgetSource,
  WidgetSourceOrigin,
} from "@rendesk/sdk/v2/client"
import { parseVisualizationToolInput } from "@rendesk/sdk/v2/client"
import { base64Encode } from "@rendesk/util/encode"

export const DASHBOARD_PRESET_LABELS: Record<DashboardLayoutPreset, string> = {
  compact: "Compact",
  wide: "Wide",
  hero: "Hero",
  tall: "Tall",
}

export function isVisualizationPayload(value: unknown): value is VisualizationPayload {
  if (!value || typeof value !== "object") return false
  if (!("kind" in value) || typeof value.kind !== "string") return false
  if (value.kind === "metrics") return Array.isArray((value as { items?: unknown[] }).items)
  if (value.kind === "table")
    return Array.isArray((value as { columns?: unknown[] }).columns) && Array.isArray((value as { rows?: unknown[] }).rows)
  if (value.kind === "chart")
    return (
      Array.isArray((value as { categories?: unknown[] }).categories) &&
      Array.isArray((value as { series?: unknown[] }).series) &&
      typeof (value as { chartType?: unknown }).chartType === "string"
    )
  return false
}

export function isWidgetSource(value: unknown): value is WidgetSource {
  if (!value || typeof value !== "object") return false
  if (!("mode" in value) || typeof value.mode !== "string") return false
  if (value.mode === "snapshot") return true
  if (value.mode === "workspace_query") {
    return typeof (value as { query?: { dataset?: unknown } }).query?.dataset === "string"
  }
  if (value.mode === "connector_query") return true
  return false
}

export function resolveVisualizationPayload(tool: string, metadataVisualization: unknown, input: unknown) {
  if (isVisualizationPayload(metadataVisualization)) return metadataVisualization

  const parsed = parseVisualizationToolInput(tool, input)
  if (isVisualizationPayload(parsed)) return parsed
}

export function dashboardHref(directory: string, dashboardID?: string) {
  const slug = base64Encode(directory)
  return dashboardID ? `/${slug}/dashboard/${dashboardID}` : `/${slug}/dashboard`
}

export function sourceMessageHref(directory: string, origin?: WidgetSourceOrigin) {
  if (!origin?.sessionID || !origin.messageID) return
  const slug = base64Encode(directory)
  return `/${slug}/session/${origin.sessionID}#message-${origin.messageID}`
}

export function snapshotSource(origin?: WidgetSourceOrigin): WidgetSource {
  return {
    mode: "snapshot",
    ...(origin ? { origin } : {}),
  }
}

export function sourceModeLabel(source: WidgetSource) {
  if (source.mode === "workspace_query") return "Live workspace"
  if (source.mode === "connector_query") return "Connector"
  return "Snapshot"
}

export function relativeTimeLabel(timestamp?: number) {
  if (!timestamp) return "Never"
  const diff = Date.now() - timestamp
  if (diff < 60_000) return "Just now"
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / (60 * 60_000))}h ago`
  return `${Math.round(diff / (24 * 60 * 60_000))}d ago`
}

export function branchValueForDirectory(directory: string) {
  const parts = directory.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? directory
}

export function filterSignature(filters: DashboardFilterState) {
  return JSON.stringify({
    datePreset: filters.datePreset ?? "30d",
    from: filters.from ?? null,
    to: filters.to ?? null,
    agent: filters.agent ?? null,
    providerID: filters.providerID ?? null,
    modelID: filters.modelID ?? null,
    workspace: filters.workspace ?? null,
    branch: filters.branch ?? null,
  })
}

export function reorderIds(ids: string[], fromID: string, toID: string) {
  const current = ids.slice()
  const fromIndex = current.indexOf(fromID)
  const toIndex = current.indexOf(toID)
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return current
  const [moved] = current.splice(fromIndex, 1)
  current.splice(toIndex, 0, moved)
  return current
}
