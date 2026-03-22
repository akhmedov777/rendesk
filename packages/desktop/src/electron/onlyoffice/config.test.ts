import { describe, expect, test } from "bun:test"
import { getEditorDocumentType, isOnlyOfficeExtension, ONLYOFFICE_SUPPORTED_EXTENSIONS } from "./config"

describe("onlyoffice config helpers", () => {
  test("recognizes supported extensions", () => {
    expect(isOnlyOfficeExtension("docx")).toBe(true)
    expect(isOnlyOfficeExtension(".xlsx")).toBe(true)
    expect(isOnlyOfficeExtension("pdf")).toBe(true)
    expect(isOnlyOfficeExtension("txt")).toBe(false)
    expect(isOnlyOfficeExtension("png")).toBe(false)
  })

  test("maps extensions to document types", () => {
    expect(getEditorDocumentType("docx")).toBe("word")
    expect(getEditorDocumentType("xlsx")).toBe("cell")
    expect(getEditorDocumentType("pptx")).toBe("slide")
    expect(getEditorDocumentType("pdf")).toBe("pdf")
    expect(getEditorDocumentType("csv")).toBe("cell")
    expect(getEditorDocumentType("odt")).toBe("word")
    expect(getEditorDocumentType("unknown")).toBe("unknown")
  })

  test("strips leading dot from extension", () => {
    expect(getEditorDocumentType(".docx")).toBe("word")
    expect(isOnlyOfficeExtension(".pdf")).toBe(true)
  })

  test("is case insensitive", () => {
    expect(isOnlyOfficeExtension("DOCX")).toBe(true)
    expect(getEditorDocumentType("PDF")).toBe("pdf")
  })

  test("ONLYOFFICE_SUPPORTED_EXTENSIONS contains all expected formats", () => {
    const expected = ["doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp", "pdf"]
    for (const ext of expected) {
      expect(ONLYOFFICE_SUPPORTED_EXTENSIONS.has(ext)).toBe(true)
    }
  })
})
