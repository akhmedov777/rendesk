import type { ToolPart } from "@rendesk/sdk/v2"
import { isVisualizationToolName } from "@rendesk/sdk/v2/client"

export function isStandaloneToolPart(part: ToolPart) {
  return isVisualizationToolName(part.tool)
}

export function isActionGroupToolPart(part: ToolPart) {
  return !isStandaloneToolPart(part)
}
