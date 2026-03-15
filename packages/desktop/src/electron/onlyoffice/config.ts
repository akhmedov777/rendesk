import { createHash, createHmac } from "node:crypto"
import type { EditorDocumentType } from "./types"

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

type JwtPayload = Record<string, unknown> & {
  iat?: number
  exp?: number
}

const base64url = (value: Buffer) => value.toString("base64url")

export function getEditorDocumentType(ext: string): EditorDocumentType {
  return EXT_TO_DOC_TYPE[ext.toLowerCase().replace(/^\./, "")] ?? "unknown"
}

export function isOnlyOfficeExtension(ext: string): boolean {
  return ONLYOFFICE_SUPPORTED_EXTENSIONS.has(ext.toLowerCase().replace(/^\./, ""))
}

export function signEditorJwt(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" }
  const now = Math.floor(Date.now() / 1000)
  const body: JwtPayload = { ...payload, iat: now, exp: now + 3600 }
  const headerPart = base64url(Buffer.from(JSON.stringify(header)))
  const payloadPart = base64url(Buffer.from(JSON.stringify(body)))
  const signature = createHmac("sha256", secret).update(`${headerPart}.${payloadPart}`).digest()
  return `${headerPart}.${payloadPart}.${base64url(signature)}`
}

export function verifyEditorJwt(token: string, secret: string): JwtPayload | null {
  try {
    const [headerPart, payloadPart, signaturePart] = token.split(".")
    if (!headerPart || !payloadPart || !signaturePart) return null
    const expected = createHmac("sha256", secret).update(`${headerPart}.${payloadPart}`).digest("base64url")
    if (expected !== signaturePart) return null
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString()) as JwtPayload
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

export type BuildEditorConfigInput = {
  filePath: string
  fileName: string
  fileExt: string
  fileMtimeMs: number
  baseUrl: string
  jwtSecret: string
  userId?: string
  userName?: string
}

export function buildOnlyOfficeConfig(input: BuildEditorConfigInput) {
  const ext = input.fileExt.toLowerCase().replace(/^\./, "")
  const documentType = getEditorDocumentType(ext)
  const downloadToken = signEditorJwt({ filePath: input.filePath, action: "download" }, input.jwtSecret)
  const callbackToken = signEditorJwt({ filePath: input.filePath, action: "callback" }, input.jwtSecret)
  const digest = createHash("md5").update(`${input.filePath}:${input.fileMtimeMs}:${ext}`).digest("hex")

  const config: Record<string, unknown> = {
    document: {
      fileType: ext,
      key: `${digest.slice(0, 24)}_${Math.floor(input.fileMtimeMs)}`,
      title: input.fileName,
      url: `${input.baseUrl}/api/editor/download?filePath=${encodeURIComponent(input.filePath)}&token=${downloadToken}`,
      permissions: {
        edit: documentType !== "pdf",
        download: true,
        print: true,
        comment: true,
        review: false,
        fillForms: true,
        modifyContentControl: true,
      },
    },
    documentType,
    editorConfig: {
      mode: documentType === "pdf" ? "view" : "edit",
      callbackUrl: `${input.baseUrl}/api/editor/callback?token=${callbackToken}`,
      user: {
        id: input.userId ?? "opencode-desktop-user",
        name: input.userName ?? "User",
      },
      customization: {
        autosave: false,
        forcesave: true,
        chat: false,
        comments: false,
        help: false,
        hideRightMenu: true,
        compactToolbar: true,
        toolbarNoTabs: true,
        feedback: false,
        goback: false,
      },
      lang: "en",
    },
    type: "desktop",
    height: "100%",
    width: "100%",
  }

  return {
    ...config,
    token: signEditorJwt(config, input.jwtSecret),
  }
}
