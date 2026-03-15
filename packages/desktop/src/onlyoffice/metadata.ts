import type { EditorDocumentType } from "../electron/onlyoffice/types"

const EXT_TO_DOC_TYPE: Record<string, EditorDocumentType> = {
  doc: "word",
  docx: "word",
  odt: "word",
  rtf: "word",
  xls: "cell",
  xlsx: "cell",
  ods: "cell",
  csv: "cell",
  ppt: "slide",
  pptx: "slide",
  odp: "slide",
  pdf: "pdf",
}

export const ONLYOFFICE_SUPPORTED_EXTENSIONS = new Set(Object.keys(EXT_TO_DOC_TYPE))

export function getEditorDocumentType(ext: string): EditorDocumentType {
  return EXT_TO_DOC_TYPE[ext.toLowerCase().replace(/^\./, "")] ?? "unknown"
}

export function isOnlyOfficeExtension(ext: string): boolean {
  return ONLYOFFICE_SUPPORTED_EXTENSIONS.has(ext.toLowerCase().replace(/^\./, ""))
}
