import type { AutomationTemplateID } from "@rendesk/sdk/v2/client"
import type { IconProps } from "@rendesk/ui/icon"

export type AutomationTemplateCategory = "reporting" | "monitoring" | "maintenance" | "release"

export type AutomationTemplate = {
  id: AutomationTemplateID
  name: string
  description: string
  category: AutomationTemplateCategory
  icon: IconProps["name"]
  cron: string
  cadenceLabel: string
  focus: string
  delivery: string
  outcome: string
  prompt: string
}

export const AUTOMATION_TEMPLATE_CATEGORY_LABELS: Record<AutomationTemplateCategory, string> = {
  reporting: "Reporting",
  monitoring: "Monitoring",
  maintenance: "Maintenance",
  release: "Release",
}

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: "workspace_summary",
    name: "Daily Workspace Summary",
    description: "Start the day with a concise briefing on what changed, what is risky, and what needs attention next.",
    category: "reporting",
    icon: "brain",
    cron: "0 9 * * 1-5",
    cadenceLabel: "Weekdays at 9:00",
    focus: "Daily workspace briefing",
    delivery: "Feed entry plus desktop completion notification",
    outcome: "Completed work, open risks, blockers, and the top three priorities for the day",
    prompt:
      "Review recent workspace changes and produce a concise daily summary with completed work, open risks, blockers, and the top 3 priorities for today.",
  },
  {
    id: "todo_cleanup",
    name: "TODO Sweep",
    description: "Review stale TODO and FIXME debt before it quietly turns into background noise.",
    category: "maintenance",
    icon: "checklist",
    cron: "30 10 * * 1-5",
    cadenceLabel: "Weekdays at 10:30",
    focus: "Backlog cleanup",
    delivery: "Feed entry with actionable file-level follow-ups",
    outcome: "Prioritized TODO and FIXME list with suggested edits and owners to follow up with",
    prompt:
      "Scan the workspace for TODO and FIXME comments that look stale or risky, then return a prioritized cleanup list with file paths, context, and suggested edits.",
  },
  {
    id: "dependency_scan",
    name: "Dependency Health Check",
    description: "Track dependency drift, vulnerable packages, and upgrade work that is worth planning.",
    category: "monitoring",
    icon: "warning",
    cron: "0 */12 * * *",
    cadenceLabel: "Every 12 hours",
    focus: "Dependency monitoring",
    delivery: "Feed entry with risk ranking and upgrade recommendations",
    outcome: "Outdated packages, risky upgrades, breaking-change warnings, and suggested follow-up work",
    prompt:
      "Inspect project dependencies and summarize outdated or risky packages, high-impact upgrade candidates, likely breaking changes, and the follow-up work required.",
  },
  {
    id: "bug_triage",
    name: "Bug Triage Pulse",
    description: "Keep recent failures visible by turning crash logs, failing tests, and error-heavy files into a triage queue.",
    category: "monitoring",
    icon: "speech-bubble",
    cron: "0 */6 * * 1-5",
    cadenceLabel: "Every 6 hours on weekdays",
    focus: "Triage incoming issues",
    delivery: "Feed entry ordered by severity",
    outcome: "Top failing areas, suspected owners, reproduction hints, and the next best action for each item",
    prompt:
      "Review the workspace for recent failures, unstable tests, error-prone files, or unresolved regressions, then create a triage list ordered by severity with concrete next actions.",
  },
  {
    id: "release_notes",
    name: "Weekly Release Draft",
    description: "Draft release notes from the actual work done in the workspace, not from memory after the fact.",
    category: "release",
    icon: "share",
    cron: "0 11 * * 1",
    cadenceLabel: "Mondays at 11:00",
    focus: "Release communication",
    delivery: "Feed-ready markdown draft",
    outcome: "Highlights, fixes, developer-facing changes, and risks that should be called out before shipping",
    prompt:
      "Draft release notes from recent workspace changes with highlights, notable fixes, developer-facing breaking changes, and any rollout or migration risks.",
  },
  {
    id: "release_readiness",
    name: "Release Readiness Check",
    description: "Run a regular readiness pass so release blockers, missing checks, and documentation gaps surface before the cut.",
    category: "release",
    icon: "circle-check",
    cron: "0 15 * * 1-5",
    cadenceLabel: "Weekdays at 15:00",
    focus: "Ship-blocker review",
    delivery: "Feed entry with pass/fail checkpoints",
    outcome: "Readiness checklist covering tests, docs, risky diffs, unresolved blockers, and recommended next steps",
    prompt:
      "Evaluate release readiness for the current workspace by checking likely ship blockers, missing tests, documentation gaps, risky diffs, and unresolved follow-up work, then report what is ready and what is not.",
  },
]

export function getAutomationTemplate(id?: string) {
  if (!id) return undefined
  return AUTOMATION_TEMPLATES.find((template) => template.id === id)
}
