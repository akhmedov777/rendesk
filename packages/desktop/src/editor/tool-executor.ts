import type { EditorDocumentType } from "../electron/onlyoffice/types"
import type { EditorCommand, EditorCommandResult, EditorController } from "./types"

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

const SPREADSHEET_ONLY_TOOLS = new Set<string>([
  "editor_read_cells",
  "editor_write_cells",
  "editor_get_sheets",
  "editor_get_active_cell",
])

const DOCUMENT_ONLY_TOOLS = new Set<string>([
  "editor_edit_document",
  "editor_get_structure",
  "editor_get_form_fields",
  "editor_fill_form_field",
])

export function isEditorToolName(name: string): name is EditorToolName {
  return EDITOR_TOOL_NAMES.includes(name as EditorToolName)
}

export async function executeEditorToolCall(input: {
  controller: EditorController
  documentType: EditorDocumentType
  toolName: EditorToolName
  toolInput: Record<string, unknown>
}): Promise<string> {
  const { controller, documentType, toolName, toolInput } = input

  if (SPREADSHEET_ONLY_TOOLS.has(toolName) && documentType !== "cell") {
    return JSON.stringify({
      success: false,
      message: `Tool "${toolName}" is only available for spreadsheets, but the active document is "${documentType}".`,
    })
  }

  if (DOCUMENT_ONLY_TOOLS.has(toolName) && documentType === "cell") {
    return JSON.stringify({
      success: false,
      message: `Tool "${toolName}" is not available for spreadsheets.`,
    })
  }

  switch (toolName) {
    case "editor_read_content": {
      const content = await controller.readContent()
      if (!content) {
        return JSON.stringify({ text: "", message: "Document appears empty or could not be read" })
      }

      const section = typeof toolInput.section === "string" ? toolInput.section : undefined
      if (!section || documentType === "cell") {
        return JSON.stringify({ text: content })
      }

      const headings = await controller.getStructure()
      const lines = content.split("\n")
      const result: string[] = []
      const sectionLower = section.toLowerCase()
      let capturing = false

      for (const line of lines) {
        const isHeading = headings.some((heading) => line.trim().toLowerCase() === heading.text.toLowerCase())
        if (isHeading) {
          if (line.trim().toLowerCase().includes(sectionLower)) {
            capturing = true
            result.push(line)
            continue
          }
          if (capturing) break
        }
        if (capturing) result.push(line)
      }

      if (result.length > 0) {
        return JSON.stringify({ text: result.join("\n"), section })
      }

      return JSON.stringify({ text: content })
    }

    case "editor_edit_document": {
      const action = String(toolInput.action ?? "")
      let command: EditorCommand

      switch (action) {
        case "insert_text":
          command = {
            type: "insert_text",
            text: String(toolInput.text ?? ""),
            position:
              toolInput.position === "start" || toolInput.position === "end" || toolInput.position === "cursor"
                ? toolInput.position
                : "cursor",
          }
          break
        case "replace_text":
          command = {
            type: "replace_text",
            searchText: String(toolInput.search_text ?? ""),
            replaceText: String(toolInput.replace_text ?? ""),
            matchCase: Boolean(toolInput.match_case),
          }
          break
        case "delete_text":
          command = {
            type: "delete_text",
            searchText: String(toolInput.search_text ?? ""),
          }
          break
        case "set_formatting":
          command = {
            type: "set_formatting",
            target: toolInput.target === "all" ? "all" : "selection",
            bold: typeof toolInput.bold === "boolean" ? toolInput.bold : undefined,
            italic: typeof toolInput.italic === "boolean" ? toolInput.italic : undefined,
            fontSize: typeof toolInput.font_size === "number" ? toolInput.font_size : undefined,
          }
          break
        default:
          return JSON.stringify({ success: false, message: `Unknown edit action: ${action}` })
      }

      const result: EditorCommandResult = await controller.executeCommand(command)
      return JSON.stringify(result)
    }

    case "editor_get_structure":
      return JSON.stringify({ headings: await controller.getStructure() })

    case "editor_get_form_fields":
      return JSON.stringify({ fields: await controller.getFormFields() })

    case "editor_fill_form_field": {
      const result = await controller.fillFormField(String(toolInput.field_id ?? ""), String(toolInput.value ?? ""))
      return JSON.stringify(result)
    }

    case "editor_read_cells": {
      const range = String(toolInput.range ?? "")
      const sheetName = typeof toolInput.sheet_name === "string" ? toolInput.sheet_name : undefined
      const values = await controller.readCells(range, sheetName)
      return JSON.stringify({ range, sheetName: sheetName ?? "active", values })
    }

    case "editor_write_cells": {
      const startCell = String(toolInput.start_cell ?? "")
      const rawValues = Array.isArray(toolInput.values) ? toolInput.values : []
      const values = rawValues.map((row) =>
        Array.isArray(row)
          ? row.map((cell) =>
              typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean" || cell === null
                ? cell
                : null,
            )
          : [],
      )
      const sheetName = typeof toolInput.sheet_name === "string" ? toolInput.sheet_name : undefined
      const result = await controller.writeCells(startCell, values, sheetName)
      return JSON.stringify(result)
    }

    case "editor_get_sheets":
      return JSON.stringify({ sheets: await controller.getSheetNames() })

    case "editor_get_active_cell":
      return JSON.stringify(await controller.getActiveCell())

    case "editor_get_selection_info": {
      if (documentType === "cell") {
        const selection = await controller.getSelectionRange()
        if (!selection) {
          return JSON.stringify({ type: "spreadsheet", range: null, message: "No selection" })
        }
        return JSON.stringify({
          type: "spreadsheet",
          range: selection.range,
          sheetName: selection.sheetName,
          preview: selection.preview,
          cellCount: selection.cellCount,
        })
      }
      const selectedText = await controller.getSelection()
      return JSON.stringify({
        type: "document",
        selectedText: selectedText || null,
      })
    }
  }
}
