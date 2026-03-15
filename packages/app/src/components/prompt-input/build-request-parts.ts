import { getFilename } from "@rendesk/util/path"
import { type AgentPartInput, type FilePartInput, type Part, type TextPartInput } from "@rendesk/sdk/v2/client"
import type { FileSelection } from "@/context/file"
import { encodeFilePath } from "@/context/file/path"
import type { AgentPart, ContextItem, FileAttachmentPart, ImageAttachmentPart, Prompt } from "@/context/prompt"
import { Identifier } from "@/utils/id"
import { createCommentMetadata, formatCommentNote } from "@/utils/comment-note"

type PromptRequestPart = (TextPartInput | FilePartInput | AgentPartInput) & { id: string }

type BuildRequestPartsInput = {
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  images: ImageAttachmentPart[]
  text: string
  messageID: string
  sessionID: string
  sessionDirectory: string
}

const absolute = (directory: string, path: string) => {
  if (path.startsWith("/")) return path
  if (/^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:$/.test(path)) return path
  if (path.startsWith("\\\\") || path.startsWith("//")) return path
  return `${directory.replace(/[\\/]+$/, "")}/${path}`
}

const fileQuery = (selection: FileSelection | undefined) =>
  selection ? `?start=${selection.startLine}&end=${selection.endLine}` : ""

const isFileAttachment = (part: Prompt[number]): part is FileAttachmentPart => part.type === "file"
const isAgentAttachment = (part: Prompt[number]): part is AgentPart => part.type === "agent"

const formatEditorContextText = (item: Extract<ContextItem, { type: "editor" }>) => {
  if (item.selectionRange) {
    const label = `[Editor Context: ${item.selectionRange.range} on "${item.selectionRange.sheetName || "active sheet"}"]`
    const preview = item.selectionRange.preview.trim()
    return preview ? `${label}\n${preview}` : label
  }

  return `[Editor Selection]\n${item.selectedText.trim()}`
}

const toOptimisticPart = (part: PromptRequestPart, sessionID: string, messageID: string): Part => {
  if (part.type === "text") {
    return {
      id: part.id,
      type: "text",
      text: part.text,
      synthetic: part.synthetic,
      ignored: part.ignored,
      time: part.time,
      metadata: part.metadata,
      sessionID,
      messageID,
    }
  }
  if (part.type === "file") {
    return {
      id: part.id,
      type: "file",
      mime: part.mime,
      filename: part.filename,
      url: part.url,
      source: part.source,
      sessionID,
      messageID,
    }
  }
  return {
    id: part.id,
    type: "agent",
    name: part.name,
    source: part.source,
    sessionID,
    messageID,
  }
}

export function buildRequestParts(input: BuildRequestPartsInput) {
  const requestParts: PromptRequestPart[] = [
    {
      id: Identifier.ascending("part"),
      type: "text",
      text: input.text,
    },
  ]

  const files = input.prompt.filter(isFileAttachment).map((attachment) => {
    const path = absolute(input.sessionDirectory, attachment.path)
    return {
      id: Identifier.ascending("part"),
      type: "file",
      mime: "text/plain",
      url: `file://${encodeFilePath(path)}${fileQuery(attachment.selection)}`,
      filename: getFilename(attachment.path),
      source: {
        type: "file",
        text: {
          value: attachment.content,
          start: attachment.start,
          end: attachment.end,
        },
        path,
      },
    } satisfies PromptRequestPart
  })

  const agents = input.prompt.filter(isAgentAttachment).map((attachment) => {
    return {
      id: Identifier.ascending("part"),
      type: "agent",
      name: attachment.name,
      source: {
        value: attachment.content,
        start: attachment.start,
        end: attachment.end,
      },
    } satisfies PromptRequestPart
  })

  const used = new Set(files.map((part) => part.url))
  const context = input.context.reduce<PromptRequestPart[]>((parts, item) => {
    if (item.type === "editor") {
      parts.push({
        id: Identifier.ascending("part"),
        type: "text",
        text: formatEditorContextText(item),
        synthetic: true,
        metadata: {
          opencodeEditor: {
            filePath: item.filePath,
            fileName: item.fileName,
            fileExt: item.fileExt,
            documentType: item.documentType,
            range: item.selectionRange?.range,
            sheetName: item.selectionRange?.sheetName,
          },
        },
      })
      return parts
    }

    const path = absolute(input.sessionDirectory, item.path)
    const url = `file://${encodeFilePath(path)}${fileQuery(item.selection)}`
    const comment = item.comment?.trim()
    if (!comment && used.has(url)) return parts
    used.add(url)

    const filePart = {
      id: Identifier.ascending("part"),
      type: "file",
      mime: "text/plain",
      url,
      filename: getFilename(item.path),
    } satisfies PromptRequestPart

    if (!comment) {
      parts.push(filePart)
      return parts
    }

    parts.push({
      id: Identifier.ascending("part"),
      type: "text",
      text: formatCommentNote({ path: item.path, selection: item.selection, comment }),
      synthetic: true,
      metadata: createCommentMetadata({
        path: item.path,
        selection: item.selection,
        comment,
        preview: item.preview,
        origin: item.commentOrigin,
      }),
    })
    parts.push(filePart)
    return parts
  }, [])

  const images = input.images.map((attachment) => {
    return {
      id: Identifier.ascending("part"),
      type: "file",
      mime: attachment.mime,
      url: attachment.dataUrl,
      filename: attachment.filename,
    } satisfies PromptRequestPart
  })

  requestParts.push(...files, ...context, ...agents, ...images)

  return {
    requestParts,
    optimisticParts: requestParts.map((part) => toOptimisticPart(part, input.sessionID, input.messageID)),
  }
}
