import type { AutomationTemplateID } from "@rendesk/sdk/v2/client"

export type AutomationTemplate = {
  id: AutomationTemplateID
  name: string
  description: string
  cron: string
  prompt: string
}

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: "workspace_summary",
    name: "Daily Workspace Summary",
    description: "Summarize code changes, risks, and next actions for the workspace.",
    cron: "0 9 * * 1-5",
    prompt:
      "Review recent workspace changes and produce a concise daily summary with completed work, open risks, and top 3 priorities for today.",
  },
  {
    id: "todo_cleanup",
    name: "TODO Sweep",
    description: "Find stale TODO/FIXME items and suggest cleanup actions.",
    cron: "30 10 * * 1-5",
    prompt:
      "Scan the workspace for TODO/FIXME comments older than active work and return a prioritized cleanup list with file paths and suggested edits.",
  },
  {
    id: "dependency_scan",
    name: "Dependency Health Check",
    description: "Inspect dependency drift and high-impact upgrade opportunities.",
    cron: "0 */12 * * *",
    prompt:
      "Inspect project dependencies and summarize outdated or risky packages, upgrade candidates, and any required follow-up tasks.",
  },
  {
    id: "release_notes",
    name: "Weekly Release Draft",
    description: "Prepare weekly release-note highlights from workspace activity.",
    cron: "0 11 * * 1",
    prompt:
      "Draft release notes from recent workspace changes with highlights, notable fixes, and developer-facing breaking changes if any.",
  },
]
