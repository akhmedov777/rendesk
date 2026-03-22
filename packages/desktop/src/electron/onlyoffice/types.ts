export type EditorDocumentType = "word" | "cell" | "slide" | "pdf" | "unknown"

export type SpreadsheetSelection = {
  range: string
  sheetName: string
  preview: string
  cellCount: number
}

export type ActiveEditorState = {
  sessionID: string
  filePath: string
  fileName: string
  fileExt: string
  documentType: EditorDocumentType
  selectedText: string
  selectionRange: SpreadsheetSelection | null
  ready: boolean
  modified: boolean
  updatedAt: number
}
