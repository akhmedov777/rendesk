import type { AutomationRunStatus, AutomationStatus } from "@rendesk/sdk/v2/client"
import { base64Encode } from "@rendesk/util/encode"

export function automationsHref(directory: string, automationID?: string, runID?: string) {
  const slug = base64Encode(directory)
  const base = automationID ? `/${slug}/automations/${automationID}` : `/${slug}/automations`
  if (!runID) return base
  const params = new URLSearchParams({ run: runID })
  return `${base}?${params.toString()}`
}

export function automationStatusLabel(status: AutomationStatus) {
  if (status === "paused") return "Paused"
  return "Active"
}

export function automationRunStatusLabel(status: AutomationRunStatus) {
  if (status === "running") return "Running"
  if (status === "queued") return "Queued"
  if (status === "failed") return "Failed"
  if (status === "skipped_lock") return "Skipped (Lock)"
  return "Success"
}

export function relativeTimeLabel(timestamp?: number) {
  if (!timestamp) return "Never"
  const diff = Date.now() - timestamp
  if (diff < 60_000) return "Just now"
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / (60 * 60_000))}h ago`
  return `${Math.round(diff / (24 * 60 * 60_000))}d ago`
}

export function dateTimeLabel(timestamp?: number) {
  if (!timestamp) return "Never"
  try {
    return new Date(timestamp).toLocaleString()
  } catch {
    return String(timestamp)
  }
}
