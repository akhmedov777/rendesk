import { describe, expect, test } from "bun:test"
import { buildOnlyOfficeConfig, getEditorDocumentType, isOnlyOfficeExtension, signEditorJwt, verifyEditorJwt } from "./config"

describe("onlyoffice config helpers", () => {
  test("recognizes supported extensions", () => {
    expect(isOnlyOfficeExtension("docx")).toBe(true)
    expect(isOnlyOfficeExtension(".xlsx")).toBe(true)
    expect(isOnlyOfficeExtension("pdf")).toBe(true)
    expect(isOnlyOfficeExtension("txt")).toBe(false)
    expect(getEditorDocumentType("pptx")).toBe("slide")
  })

  test("signs and verifies JWT payloads", () => {
    const token = signEditorJwt({ filePath: "/tmp/report.docx", action: "download" }, "secret")
    expect(verifyEditorJwt(token, "secret")).toMatchObject({
      filePath: "/tmp/report.docx",
      action: "download",
    })
    expect(verifyEditorJwt(`${token}x`, "secret")).toBeNull()
  })

  test("builds view-mode configs for pdf files", () => {
    const config = buildOnlyOfficeConfig({
      filePath: "/tmp/report.pdf",
      fileName: "report.pdf",
      fileExt: "pdf",
      fileMtimeMs: 1_717_171,
      baseUrl: "https://callback.example.com",
      jwtSecret: "secret",
    }) as Record<string, any>

    expect(config.documentType).toBe("pdf")
    expect(config.document).toMatchObject({
      fileType: "pdf",
      title: "report.pdf",
    })
    expect(config.document.url).toContain("https://callback.example.com/api/editor/download")
    expect(config.editorConfig.mode).toBe("view")
    expect(config.editorConfig.callbackUrl).toContain(
      "https://callback.example.com/api/editor/callback",
    )
    expect(typeof config.token).toBe("string")
  })
})
