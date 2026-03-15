import type { EditorDocumentType, SpreadsheetSelection } from "../electron/onlyoffice/types"

export type EditorCommand =
  | {
      type: "insert_text"
      text: string
      position?: "cursor" | "start" | "end"
    }
  | {
      type: "replace_text"
      searchText: string
      replaceText: string
      matchCase?: boolean
    }
  | {
      type: "delete_text"
      searchText: string
    }
  | {
      type: "set_formatting"
      target?: "selection" | "all"
      bold?: boolean
      italic?: boolean
      fontSize?: number
    }
  | {
      type: "fill_form_field"
      fieldId: string
      value: string
    }

export type EditorCommandResult = {
  success: boolean
  message: string
}

export type DocumentHeading = {
  level: number
  text: string
}

export type FormField = {
  id: string
  tag: string
  type: string
  value: string
}

export type EditorController = {
  getDocumentType: () => EditorDocumentType
  executeCommand: (command: EditorCommand) => Promise<EditorCommandResult>
  readContent: () => Promise<string>
  getSelection: () => Promise<string>
  getStructure: () => Promise<DocumentHeading[]>
  getFormFields: () => Promise<FormField[]>
  fillFormField: (fieldId: string, value: string) => Promise<EditorCommandResult>
  readCells: (range: string, sheetName?: string) => Promise<string[][]>
  writeCells: (
    startCell: string,
    values: (string | number | boolean | null)[][],
    sheetName?: string,
  ) => Promise<EditorCommandResult>
  getSheetNames: () => Promise<string[]>
  getActiveCell: () => Promise<{ cell: string; sheetName: string; value: string }>
  getSelectionRange: () => Promise<SpreadsheetSelection | null>
}
