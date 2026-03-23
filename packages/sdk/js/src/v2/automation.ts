export type AutomationStatus = "active" | "paused"
export type AutomationTrigger = "schedule" | "manual" | "catchup"
export type AutomationRunStatus = "queued" | "running" | "success" | "failed" | "skipped_lock"

export type AutomationTemplateID = "workspace_summary" | "todo_cleanup" | "dependency_scan" | "release_notes" | (string & {})

export type Automation = {
  id: string
  directory: string
  name: string
  prompt: string
  cron: string
  timezone: string
  status: AutomationStatus
  templateID?: AutomationTemplateID
  time: {
    created: number
    updated: number
  }
  lastRunAt?: number
  nextRunAt: number
}

export type AutomationToolCall = {
  id: string
  tool: string
  input: Record<string, unknown>
  status: "running" | "completed" | "failed"
  output?: string
  error?: string
  startedAt: number
  finishedAt?: number
}

export type AutomationRun = {
  id: string
  automationID: string
  directory: string
  trigger: AutomationTrigger
  status: AutomationRunStatus
  time: {
    created: number
    started?: number
    finished?: number
  }
  scheduledFor?: number
  summary?: string
  output?: string
  error?: string
  logs: string[]
  toolCalls: AutomationToolCall[]
}

export type AutomationListResult = {
  automations: Automation[]
}
