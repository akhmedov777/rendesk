import type { EditorDocumentType, EditorTransportMode } from "../electron/onlyoffice/types"

const MIB = 1024 * 1024

function documentLabel(documentType: EditorDocumentType) {
  switch (documentType) {
    case "cell":
      return "spreadsheet"
    case "slide":
      return "presentation"
    case "pdf":
      return "PDF"
    default:
      return "document"
  }
}

export function getOnlyOfficeLoadTimeoutMs(transportMode: EditorTransportMode, fileSize = 0) {
  const baseTimeout =
    transportMode === "local" ? 25_000 : transportMode === "manual" ? 60_000 : 90_000
  const sizePenalty = Math.min(Math.ceil(Math.max(fileSize, 0) / (5 * MIB)) * 5_000, 90_000)
  return Math.min(baseTimeout + sizePenalty, 180_000)
}

export function getOnlyOfficeSlowLoadMessage(documentType: EditorDocumentType, transportMode: EditorTransportMode) {
  const label = documentLabel(documentType)
  if (transportMode === "auto-tunnel") {
    return `This ${label} is still loading over the desktop bridge. Large files can take longer than usual.`
  }
  if (transportMode === "manual") {
    return `This ${label} is still loading from the hosted Document Server.`
  }
  return `This ${label} is still loading.`
}
