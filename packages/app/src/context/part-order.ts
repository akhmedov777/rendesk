import type { Part } from "@rendesk/sdk/v2/client"

const PART_PRIORITY: Record<Part["type"], number> = {
  "step-start": 0,
  reasoning: 10,
  tool: 20,
  subtask: 24,
  agent: 25,
  file: 26,
  snapshot: 27,
  patch: 28,
  text: 30,
  retry: 40,
  "step-finish": 50,
  compaction: 60,
}

function partStart(part: Part) {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.time?.start
    case "tool":
      if (part.state.status === "pending") return
      return part.state.time.start
    default:
      return
  }
}

export function compareMessageParts(a: Part, b: Part) {
  const startA = partStart(a)
  const startB = partStart(b)

  if (startA !== undefined && startB !== undefined && startA !== startB) {
    return startA - startB
  }

  const priority = PART_PRIORITY[a.type] - PART_PRIORITY[b.type]
  if (priority !== 0) return priority

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function sortMessageParts(parts: Part[]) {
  return parts.filter((part): part is Part => !!part?.id).slice().sort(compareMessageParts)
}

export function upsertMessagePart(parts: Part[] | undefined, part: Part) {
  const next = (parts ?? []).filter((item) => item.id !== part.id)
  next.push(part)
  return sortMessageParts(next)
}
