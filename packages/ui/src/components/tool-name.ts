import { normalizeVisualizationToolName } from "@rendesk/sdk/v2/client"

const TOOL_ALIASES: Record<string, string> = {
  code_search: "codesearch",
  command: "bash",
  execute_command: "bash",
  run_command: "bash",
  shell: "bash",
  shell_command: "bash",
  terminal: "bash",
  todo_read: "todoread",
  todo_write: "todowrite",
  web_fetch: "webfetch",
  web_search: "websearch",
  create_file: "write",
  file_create: "write",
  file_write: "write",
  save_file: "write",
  write_file: "write",
  modify_file: "edit",
  multi_edit: "edit",
  update_file: "edit",
  patch: "apply_patch",
  patch_file: "apply_patch",
}

function canonicalToolName(tool: string) {
  return tool
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
}

export function normalizeToolName(tool: string) {
  const canonical = normalizeVisualizationToolName(canonicalToolName(tool))
  return TOOL_ALIASES[canonical] ?? canonical
}
