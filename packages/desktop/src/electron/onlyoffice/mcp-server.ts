import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

export const EDITOR_TOOL_NAMES = [
  "editor_read_content",
  "editor_edit_document",
  "editor_get_structure",
  "editor_get_form_fields",
  "editor_fill_form_field",
  "editor_read_cells",
  "editor_write_cells",
  "editor_get_sheets",
  "editor_get_active_cell",
  "editor_get_selection_info",
] as const

export type EditorToolName = (typeof EDITOR_TOOL_NAMES)[number]

export function createOnlyOfficeMcpServer(sendEditorToolRequest: (toolName: string, toolInput: Record<string, unknown>) => Promise<string>) {
  const invoke = async (toolName: EditorToolName, args: Record<string, unknown>) => {
    try {
      return {
        content: [{ type: "text" as const, text: await sendEditorToolRequest(toolName, args) }],
      }
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      }
    }
  }

  return createSdkMcpServer({
    name: "editor",
    version: "1.0.0",
    tools: [
      tool(
        "editor_read_content",
        "Read the text content of the currently open document. Optionally filter by a section heading.",
        { section: z.string().optional() },
        (args) => invoke("editor_read_content", args as Record<string, unknown>),
      ),
      tool(
        "editor_edit_document",
        "Edit the open document by inserting, replacing, deleting text, or applying formatting.",
        {
          action: z.enum(["insert_text", "replace_text", "delete_text", "set_formatting"]),
          text: z.string().optional(),
          position: z.enum(["cursor", "start", "end"]).optional(),
          search_text: z.string().optional(),
          replace_text: z.string().optional(),
          match_case: z.boolean().optional(),
          target: z.enum(["selection", "all"]).optional(),
          bold: z.boolean().optional(),
          italic: z.boolean().optional(),
          font_size: z.number().optional(),
        },
        (args) => invoke("editor_edit_document", args as Record<string, unknown>),
      ),
      tool("editor_get_structure", "Get the outline/headings of the open document.", {}, (args) =>
        invoke("editor_get_structure", args as Record<string, unknown>),
      ),
      tool("editor_get_form_fields", "List form fields/content controls in the open document.", {}, (args) =>
        invoke("editor_get_form_fields", args as Record<string, unknown>),
      ),
      tool(
        "editor_fill_form_field",
        "Set a specific form field/content control value in the open document.",
        {
          field_id: z.string(),
          value: z.string(),
        },
        (args) => invoke("editor_fill_form_field", args as Record<string, unknown>),
      ),
      tool(
        "editor_read_cells",
        "Read spreadsheet cells from the active spreadsheet document.",
        {
          range: z.string(),
          sheet_name: z.string().optional(),
        },
        (args) => invoke("editor_read_cells", args as Record<string, unknown>),
      ),
      tool(
        "editor_write_cells",
        "Write spreadsheet cell values into the active spreadsheet document.",
        {
          start_cell: z.string(),
          values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
          sheet_name: z.string().optional(),
        },
        (args) => invoke("editor_write_cells", args as Record<string, unknown>),
      ),
      tool("editor_get_sheets", "List sheet names in the active spreadsheet document.", {}, (args) =>
        invoke("editor_get_sheets", args as Record<string, unknown>),
      ),
      tool("editor_get_active_cell", "Get the active cell in the spreadsheet editor.", {}, (args) =>
        invoke("editor_get_active_cell", args as Record<string, unknown>),
      ),
      tool("editor_get_selection_info", "Get the current text or spreadsheet selection from the open editor.", {}, (args) =>
        invoke("editor_get_selection_info", args as Record<string, unknown>),
      ),
    ],
  })
}
