import { spawn } from "node:child_process"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { homedir } from "node:os"
import { dirname, extname, join, resolve, sep } from "node:path"
import { promises as fs } from "node:fs"
import { fileURLToPath } from "node:url"
import type {
  CanUseTool,
  Options as AgentOptions,
  PermissionResult,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
  Query as AnthropicQuery,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk"
import {
  isVisualizationToolName,
  normalizeVisualizationToolName,
  parseVisualizationToolInput,
  type AnalyticsQueryResult,
  type AnalyticsWorkspaceQuery,
  type Dashboard,
  type DashboardFilterState,
  type DashboardLayoutItem,
  type DashboardLayoutPreset,
  type DashboardListResult,
  type DashboardWidget,
  type VisualizationChartSpec,
  type VisualizationPayload,
  type WidgetSource,
} from "@rendesk/sdk/v2/client"
import { queryWorkspaceAnalytics, type AnalyticsSnapshot } from "./analytics.js"
import { createOnlyOfficeApiHandlers } from "./onlyoffice/http-handlers.js"
import {
  applyEditorEnvOverrides,
  coerceEditorIntegrationUpdate,
  defaultEditorIntegrationConfig,
  redactEditorIntegrationConfig,
  resolveEditorIntegrationConfig,
} from "./onlyoffice/integration-config.js"
import { createOnlyOfficeMcpServer } from "./onlyoffice/mcp-server.js"
import { getEditorIngressPort, startEditorIngressServer, stopEditorIngressServer } from "./onlyoffice/ingress-server.js"
import {
  ensureEditorTunnelReady,
  getEditorTunnelState,
  reconnectEditorTunnel,
  setEditorTunnelIngressPort,
  shutdownEditorTunnelManager,
} from "./onlyoffice/tunnel-manager.js"
import type { ActiveEditorState, EditorIntegrationConfig } from "./onlyoffice/types.js"
import type { ProviderAuthStore } from "./provider-auth-store.js"
import { createVisualizationMcpServer } from "./visualization-mcp.js"

type ProviderListResponse = {
  all: Array<{
    id: string
    name: string
    source?: "env" | "config" | "custom" | "api"
    env: string[]
    models: Record<
      string,
      {
        id: string
        name: string
        family?: string
        release_date: string
        attachment: boolean
        reasoning: boolean
        temperature: boolean
        tool_call: boolean
        limit: {
          context: number
          output: number
        }
        modalities?: {
          input: string[]
          output: string[]
        }
        options: Record<string, unknown>
      }
    >
  }>
  connected: string[]
  default: Record<string, string>
}

type PathPayload = {
  state: string
  config: string
  worktree: string
  directory: string
  home: string
}

type Project = {
  id: string
  worktree: string
  vcs?: "git"
  name?: string
  icon?: {
    url?: string
    override?: string
    color?: string
  }
  commands?: {
    start?: string
  }
  time: {
    created: number
    updated: number
    initialized?: number
  }
  sandboxes: string[]
}

type Session = {
  id: string
  slug: string
  projectID: string
  directory: string
  anthropicSessionID?: string
  parentID?: string
  title: string
  version: string
  summary?: {
    additions: number
    deletions: number
    files: number
    diffs?: Array<{
      file: string
      before: string
      after: string
      additions: number
      deletions: number
      status?: "added" | "deleted" | "modified"
    }>
  }
  share?: {
    url: string
  }
  time: {
    created: number
    updated: number
    archived?: number
  }
  permission?: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>
  revert?: {
    messageID: string
  }
}

type UserMessage = {
  id: string
  sessionID: string
  role: "user"
  time: {
    created: number
  }
  agent: string
  model: {
    providerID: string
    modelID: string
  }
  variant?: string
  summary?: {
    title?: string
    body?: string
    diffs: Array<{
      file: string
      before: string
      after: string
      additions: number
      deletions: number
      status?: "added" | "deleted" | "modified"
    }>
  }
}

type AssistantMessage = {
  id: string
  sessionID: string
  role: "assistant"
  time: {
    created: number
    completed?: number
  }
  parentID: string
  modelID: string
  providerID: string
  mode: string
  agent: string
  path: {
    cwd: string
    root: string
  }
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
  variant?: string
  finish?: string
  error?: {
    name: string
    data: {
      message: string
    }
  }
}

type Message = UserMessage | AssistantMessage

type TextPart = {
  id: string
  sessionID: string
  messageID: string
  type: "text"
  text: string
  synthetic?: boolean
  ignored?: boolean
  metadata?: Record<string, unknown>
}

type FilePart = {
  id: string
  sessionID: string
  messageID: string
  type: "file"
  mime: string
  filename?: string
  url: string
  source?: {
    type: "file"
    path: string
    text?: {
      value: string
      start: number
      end: number
    }
  }
}

type ToolPart = {
  id: string
  sessionID: string
  messageID: string
  type: "tool"
  callID: string
  tool: string
  state:
    | {
        status: "running"
        input: Record<string, unknown>
        time: { start: number }
        metadata?: Record<string, unknown>
        title?: string
      }
    | {
        status: "completed"
        input: Record<string, unknown>
        output: string
        title: string
        time: { start: number; end: number }
        metadata: Record<string, unknown>
      }
}

type Part = TextPart | FilePart | ToolPart

type Todo = {
  id: string
  content: string
  status: string
  priority: string
}

type PermissionRequest = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: {
    messageID: string
    callID: string
  }
}

const ANTHROPIC_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk"
const CLAUDE_CODE_CLI_RELATIVE_PATH = join("node_modules", "@anthropic-ai", "claude-agent-sdk", "cli.js")

const toUnpackedAsarPath = (value: string) => value.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)

const pathExists = async (value: string) => {
  try {
    await fs.access(value)
    return true
  } catch {
    return false
  }
}

type QuestionOption = {
  label: string
  description: string
}

type QuestionRequest = {
  id: string
  sessionID: string
  questions: Array<{
    question: string
    header: string
    options: QuestionOption[]
    multiple?: boolean
    custom?: boolean
  }>
  tool?: {
    messageID: string
    callID: string
  }
}

type DashboardDirectoryState = {
  dashboards: Dashboard[]
  lastUsedDashboardID?: string
}

type AnalyticsEvent = {
  id: string
  directory: string
  sessionID: string
  type: "permission_asked" | "question_asked"
  createdAt: number
}

type PersistedState = {
  config: {
    model: string
    share: "disabled"
    snapshot: false
    permission: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>
    provider: Record<string, unknown>
    disabled_providers: string[]
    plugin: string[]
  }
  preferences: {
    defaultServerUrl: string | null
    displayBackend: "auto" | "wayland" | null
  }
  integrations: {
    editor: EditorIntegrationConfig
  }
  projects: Project[]
  sessions: Session[]
  messages: Array<{
    info: Message
    parts: Part[]
  }>
  todos: Record<string, Todo[]>
  permissions: Record<string, PermissionRequest[]>
  questions: Record<string, QuestionRequest[]>
  dashboards: Record<string, DashboardDirectoryState>
  analyticsEvents: AnalyticsEvent[]
}

type RpcRequest = {
  action: string
  input?: any
  directory?: string
}

type ServiceEvent = {
  directory?: string
  payload: {
    type: string
    properties?: unknown
  }
}

type ActiveRun = {
  controller: AbortController
  query?: AnthropicQuery
  directory: string
  sessionID: string
  messageID: string
  assistantMessageID: string
}

type AnthropicModelDefinition = {
  id: string
  name: string
  family: string
  release_date: string
  limit: {
    context: number
    output: number
  }
}

type ResolvedProviderCredential = {
  key: string
  source: "env" | "api"
}

const ANTHROPIC_PROVIDER_ID = "anthropic"
const DEFAULT_ANTHROPIC_MODEL_ID = "claude-sonnet-4-5-20250929"
const ANTHROPIC_MODEL_CATALOG: AnthropicModelDefinition[] = [
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    family: "claude-opus",
    release_date: "2025-10-01",
    limit: {
      context: 200_000,
      output: 8_192,
    },
  },
  {
    id: DEFAULT_ANTHROPIC_MODEL_ID,
    name: "Claude Sonnet 4.5",
    family: "claude-sonnet",
    release_date: "2025-09-29",
    limit: {
      context: 200_000,
      output: 8_192,
    },
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    family: "claude-haiku",
    release_date: "2025-10-01",
    limit: {
      context: 200_000,
      output: 8_192,
    },
  },
]

const providerList = (anthropicCredential: ResolvedProviderCredential | null): ProviderListResponse => ({
  all: [
    {
      id: ANTHROPIC_PROVIDER_ID,
      name: "Anthropic",
      source: anthropicCredential?.source,
      env: ["ANTHROPIC_API_KEY"],
      models: Object.fromEntries(
        ANTHROPIC_MODEL_CATALOG.map((model) => [
          model.id,
          {
            id: model.id,
            name: model.name,
            family: model.family,
            release_date: model.release_date,
            attachment: true,
            reasoning: true,
            temperature: true,
            tool_call: true,
            limit: model.limit,
            modalities: {
              input: ["text", "image", "pdf"],
              output: ["text"],
            },
            options: {},
          },
        ]),
      ),
    },
  ],
  connected: anthropicCredential ? [ANTHROPIC_PROVIDER_ID] : [],
  default: {
    [ANTHROPIC_PROVIDER_ID]: DEFAULT_ANTHROPIC_MODEL_ID,
  },
})

const agentList = () => [
  {
    name: "Rendesk",
    description: "Desktop coding agent for local workspaces, documents, spreadsheets, and PDF workflows.",
    mode: "primary",
    permission: [] as Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>,
    model: {
      providerID: ANTHROPIC_PROVIDER_ID,
      modelID: DEFAULT_ANTHROPIC_MODEL_ID,
    },
    options: {},
  },
]

const defaultState = (): PersistedState => ({
  config: {
    model: `${ANTHROPIC_PROVIDER_ID}/${DEFAULT_ANTHROPIC_MODEL_ID}`,
    share: "disabled",
    snapshot: false,
    permission: [],
    provider: {},
    disabled_providers: [],
    plugin: [],
  },
  preferences: {
    defaultServerUrl: null,
    displayBackend: null,
  },
  integrations: {
    editor: defaultEditorIntegrationConfig(),
  },
  projects: [],
  sessions: [],
  messages: [],
  todos: {},
  permissions: {},
  questions: {},
  dashboards: {},
  analyticsEvents: [],
})

const now = () => Date.now()

const isoTitle = (prefix: string) => `${prefix} - ${new Date().toISOString()}`
const DEFAULT_SESSION_TITLE_PATTERN = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const isDefaultSessionTitle = (title?: string) => !!title && DEFAULT_SESSION_TITLE_PATTERN.test(title)

const checksum = (value: string) => createHash("sha1").update(value).digest("hex").slice(0, 12)

const SORTABLE_ID_PREFIX = {
  message: "msg",
  part: "prt",
} as const
const SORTABLE_ID_LENGTH = 26
let sortableLastTimestamp = 0
let sortableCounter = 0

const randomBase62 = (length: number) => {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  const bytes = randomBytes(length)
  let result = ""
  for (let index = 0; index < length; index += 1) {
    result += chars[bytes[index] % 62]
  }
  return result
}

const createSortableID = (prefix: keyof typeof SORTABLE_ID_PREFIX, timestamp = now()) => {
  if (timestamp !== sortableLastTimestamp) {
    sortableLastTimestamp = timestamp
    sortableCounter = 0
  }
  sortableCounter += 1

  const encoded = BigInt(timestamp) * BigInt(0x1000) + BigInt(sortableCounter)
  const timeBytes = Buffer.alloc(6)
  for (let index = 0; index < 6; index += 1) {
    timeBytes[index] = Number((encoded >> BigInt(40 - 8 * index)) & BigInt(0xff))
  }

  return `${SORTABLE_ID_PREFIX[prefix]}_${timeBytes.toString("hex")}${randomBase62(SORTABLE_ID_LENGTH - 12)}`
}

const relativePath = (root: string, absolute: string) => {
  if (absolute === root) return ""
  return absolute.startsWith(root) ? absolute.slice(root.length).replace(/^[/\\]+/, "") : absolute
}

const fileMime = (path: string) => {
  const ext = extname(path).toLowerCase()
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  if (ext === ".doc") return "application/msword"
  if (ext === ".odt") return "application/vnd.oasis.opendocument.text"
  if (ext === ".rtf") return "application/rtf"
  if (ext === ".pdf") return "application/pdf"
  if (ext === ".csv") return "text/csv"
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  if (ext === ".xls") return "application/vnd.ms-excel"
  if (ext === ".ods") return "application/vnd.oasis.opendocument.spreadsheet"
  if (ext === ".pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  if (ext === ".ppt") return "application/vnd.ms-powerpoint"
  if (ext === ".odp") return "application/vnd.oasis.opendocument.presentation"
  if (ext === ".png") return "image/png"
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg"
  return "text/plain"
}

const readJson = async <T>(path: string, fallback: T) => {
  const raw = await fs.readFile(path, "utf8").catch(() => "")
  if (!raw) return fallback
  try {
    return { ...fallback, ...(JSON.parse(raw) as Record<string, unknown>) } as T
  } catch {
    return fallback
  }
}

const writeJson = async (path: string, value: unknown) => {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, JSON.stringify(value, null, 2), "utf8")
}

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let body = ""
    request.on("data", (chunk) => {
      body += chunk.toString()
    })
    request.on("end", () => resolve(body))
    request.on("error", reject)
  })

const sendJson = (response: ServerResponse, status: number, payload: unknown) => {
  response.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers": "content-type",
  })
  response.end(JSON.stringify(payload))
}

const sendSse = (response: ServerResponse, payload: ServiceEvent) => {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

const isTextLike = (buffer: Buffer) => {
  const sample = buffer.subarray(0, Math.min(buffer.length, 512))
  for (const value of sample) {
    if (value === 9 || value === 10 || value === 13) continue
    if (value < 32) return false
  }
  return true
}

const summaryFromText = (text: string) => {
  const cleaned = text.replace(/\s+/g, " ").trim()
  if (!cleaned) return undefined
  return cleaned.slice(0, 72)
}

const serializePrompt = (parts: any[]) => {
  return parts
    .map((part) => {
      if (part.type === "text") return part.text ?? ""
      if (part.type === "agent") return `Agent context: ${part.name ?? ""}\n${part.source?.value ?? ""}`.trim()
      if (part.type === "file") {
        const sourceText = part.source?.text?.value
        if (typeof sourceText === "string" && sourceText.trim()) {
          return `File: ${part.filename ?? part.source?.path ?? part.url}\n${sourceText}`
        }
        return `Attachment: ${part.filename ?? part.url}`
      }
      return ""
    })
    .filter(Boolean)
    .join("\n\n")
}

const serializeEditorContext = (state: ActiveEditorState) => {
  const lines = [
    "App context:",
    "- active_surface: document_editor",
    `- open_file_path: ${state.filePath}`,
    `- open_file_name: ${state.fileName}`,
    `- open_file_extension: ${state.fileExt}`,
    `- document_type: ${state.documentType}`,
    `- editor_ready: ${state.ready}`,
    `- editor_modified: ${state.modified}`,
  ]

  if (state.selectionRange) {
    lines.push(`- spreadsheet_selection_range: ${state.selectionRange.range}`)
    lines.push(`- spreadsheet_selection_sheet: ${state.selectionRange.sheetName}`)
    lines.push(`- spreadsheet_selection_cells: ${state.selectionRange.cellCount}`)
    if (state.selectionRange.preview.trim()) {
      lines.push(`- spreadsheet_selection_preview: ${state.selectionRange.preview.trim()}`)
    }
  } else if (state.selectedText.trim()) {
    lines.push(`- selected_text: ${state.selectedText.trim()}`)
  }

  return lines.join("\n")
}

const serializeEditorToolGuidance = (state: ActiveEditorState) => {
  const lines = [
    "Document editor tools:",
    "- Use editor_read_content to read the open document text or the current spreadsheet preview.",
    "- Use editor_get_selection_info to inspect the current text selection or spreadsheet range.",
  ]

  if (state.documentType === "cell") {
    lines.push("- Use editor_read_cells to read ranges from the active spreadsheet.")
    lines.push("- Use editor_write_cells to write spreadsheet values.")
    lines.push("- Use editor_get_sheets and editor_get_active_cell for sheet-aware spreadsheet work.")
    return lines.join("\n")
  }

  lines.push("- Use editor_edit_document to insert, replace, delete, or format text in the open document.")
  lines.push("- Use editor_get_structure to inspect document headings.")
  lines.push("- Use editor_get_form_fields and editor_fill_form_field for fillable forms.")
  return lines.join("\n")
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const coerceRecord = (value: unknown): Record<string, unknown> => (isPlainObject(value) ? { ...value } : {})

const extractAssistantText = (value: SDKAssistantMessage["message"] | unknown): string => {
  if (!isPlainObject(value)) return ""
  const content = Array.isArray(value.content) ? value.content : []
  return content
    .map((block) => {
      if (!isPlainObject(block)) return ""
      if (block.type === "text" && typeof block.text === "string") return block.text
      return ""
    })
    .join("")
}

type ExtractedStreamEvent = {
  eventType: string
  contentBlockType?: string
  textDelta?: string
  toolUse?: {
    id: string
    name: string
    input: Record<string, unknown>
  }
}

const extractStreamEvent = (message: SDKMessage): ExtractedStreamEvent | null => {
  if (message.type !== "stream_event" || !isPlainObject(message.event) || typeof message.event.type !== "string") {
    return null
  }

  const event = message.event
  if (event.type === "content_block_delta") {
    const delta = isPlainObject(event.delta) ? event.delta : null
    if (!delta || typeof delta.type !== "string") return null
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      return {
        eventType: event.type,
        contentBlockType: "text",
        textDelta: delta.text,
      }
    }
    return {
      eventType: event.type,
      contentBlockType: delta.type,
    }
  }

  if (event.type === "content_block_start") {
    const block = isPlainObject(event.content_block) ? event.content_block : null
    if (!block || typeof block.type !== "string") return null
    if (block.type === "text" && typeof block.text === "string") {
      return {
        eventType: event.type,
        contentBlockType: "text",
        textDelta: block.text,
      }
    }
    if (block.type === "tool_use" && typeof block.id === "string") {
      return {
        eventType: event.type,
        contentBlockType: "tool_use",
        toolUse: {
          id: block.id,
          name: typeof block.name === "string" && block.name.trim() ? block.name : "Tool",
          input: coerceRecord(block.input),
        },
      }
    }
    return {
      eventType: event.type,
      contentBlockType: block.type,
    }
  }

  return {
    eventType: String(event.type),
  }
}

const normalizeToolName = (toolName: string) =>
  normalizeVisualizationToolName(
    toolName
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase(),
  )

const permissionNameForTool = (toolName: string) => {
  const normalized = normalizeToolName(toolName)
  if (normalized === "write" || normalized === "multiedit" || normalized === "filewrite") return "edit"
  if (normalized === "ls" || normalized === "listfiles") return "list"
  if (normalized === "agent") return "task"
  return normalized || "tool"
}

const permissionPatternsForTool = (input: Record<string, unknown>, blockedPath?: string) => {
  const values = new Set<string>()
  if (typeof blockedPath === "string" && blockedPath.trim()) values.add(blockedPath.trim())

  for (const key of ["file_path", "path", "target", "outputFile", "url", "command"]) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) values.add(value.trim())
  }

  const paths = input.paths
  if (Array.isArray(paths)) {
    for (const value of paths) {
      if (typeof value === "string" && value.trim()) values.add(value.trim())
    }
  }

  return [...values]
}

const serializeToolOutput = (value: unknown) => {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const normalizeTodos = (value: unknown): Todo[] => {
  const todos = isPlainObject(value) && Array.isArray(value.todos) ? value.todos : Array.isArray(value) ? value : null
  if (!todos) return []

  return todos.flatMap((item, index) => {
    if (!isPlainObject(item) || typeof item.content !== "string") return []
    return [
      {
        id:
          typeof item.id === "string" && item.id
            ? item.id
            : `todo_${checksum(`${index}:${item.content}:${item.status ?? "pending"}`)}`,
        content: item.content,
        status: typeof item.status === "string" ? item.status : "pending",
        priority: typeof item.priority === "string" ? item.priority : "medium",
      },
    ]
  })
}

const usageNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)

const mapPlatform = (value: NodeJS.Platform): "macos" | "windows" | "linux" => {
  if (value === "darwin") return "macos"
  if (value === "win32") return "windows"
  return "linux"
}

const DASHBOARD_LAYOUT_PRESETS: Record<DashboardLayoutPreset, DashboardLayoutItem> = {
  compact: { preset: "compact", colSpan: 4, rowSpan: 1, minHeight: 180 },
  wide: { preset: "wide", colSpan: 6, rowSpan: 2, minHeight: 260 },
  hero: { preset: "hero", colSpan: 12, rowSpan: 2, minHeight: 320 },
  tall: { preset: "tall", colSpan: 6, rowSpan: 3, minHeight: 360 },
}

const dashboardFilters = (value: unknown): DashboardFilterState => {
  if (!isPlainObject(value)) return {}
  return {
    datePreset: typeof value.datePreset === "string" ? (value.datePreset as DashboardFilterState["datePreset"]) : undefined,
    from: typeof value.from === "number" ? value.from : undefined,
    to: typeof value.to === "number" ? value.to : undefined,
    agent: typeof value.agent === "string" ? value.agent : value.agent === null ? null : undefined,
    providerID:
      typeof value.providerID === "string" ? value.providerID : value.providerID === null ? null : undefined,
    modelID: typeof value.modelID === "string" ? value.modelID : value.modelID === null ? null : undefined,
    workspace:
      typeof value.workspace === "string" ? value.workspace : value.workspace === null ? null : undefined,
    branch: typeof value.branch === "string" ? value.branch : value.branch === null ? null : undefined,
  }
}

const analyticsQuery = (value: unknown): AnalyticsWorkspaceQuery | undefined => {
  if (!isPlainObject(value) || typeof value.dataset !== "string") return
  return {
    dataset: value.dataset as AnalyticsWorkspaceQuery["dataset"],
    title: typeof value.title === "string" ? value.title : undefined,
    description: typeof value.description === "string" ? value.description : undefined,
    renderAs: typeof value.renderAs === "string" ? (value.renderAs as AnalyticsWorkspaceQuery["renderAs"]) : undefined,
    chartType: typeof value.chartType === "string" ? (value.chartType as AnalyticsWorkspaceQuery["chartType"]) : undefined,
    groupBy: typeof value.groupBy === "string" ? value.groupBy : undefined,
    limit: typeof value.limit === "number" ? value.limit : undefined,
    filters: dashboardFilters(value.filters),
  }
}

const widgetSource = (value: unknown): WidgetSource | undefined => {
  if (!isPlainObject(value) || typeof value.mode !== "string") return
  const origin =
    isPlainObject(value.origin) && typeof value.origin.sessionID === "string" && typeof value.origin.messageID === "string"
      ? {
          sessionID: value.origin.sessionID,
          messageID: value.origin.messageID,
          partID: typeof value.origin.partID === "string" ? value.origin.partID : undefined,
          toolName: typeof value.origin.toolName === "string" ? value.origin.toolName : undefined,
        }
      : undefined
  if (value.mode === "snapshot") {
    return { mode: "snapshot", origin }
  }
  if (value.mode === "workspace_query") {
    const query = analyticsQuery(value.query)
    if (!query) return
    return {
      mode: "workspace_query",
      query,
      origin,
    }
  }
  if (value.mode === "connector_query") {
    return {
      mode: "connector_query",
      connectorID: typeof value.connectorID === "string" ? value.connectorID : undefined,
      connectorQuery: typeof value.connectorQuery === "string" ? value.connectorQuery : undefined,
      origin,
    }
  }
}

const tableColumns = (value: unknown) => {
  if (!Array.isArray(value)) return
  const columns = value.flatMap((item) => {
    if (!isPlainObject(item) || typeof item.key !== "string" || typeof item.label !== "string") return []
    return [
      {
        key: item.key,
        label: item.label,
        align: typeof item.align === "string" ? item.align : undefined,
        format: typeof item.format === "string" ? item.format : undefined,
      },
    ]
  })
  return columns.length ? columns : undefined
}

const isVisualizationPayload = (value: unknown): value is VisualizationPayload => {
  if (!isPlainObject(value) || typeof value.kind !== "string") return false
  if (value.kind === "metrics") return Array.isArray(value.items)
  if (value.kind === "table") return Array.isArray(value.columns) && Array.isArray(value.rows)
  if (value.kind === "chart") return typeof value.chartType === "string" && Array.isArray(value.categories) && Array.isArray(value.series)
  return false
}

const cloneVisualizationPayload = (value: VisualizationPayload): VisualizationPayload => JSON.parse(JSON.stringify(value))

const widgetLayout = (value: unknown): DashboardLayoutItem | undefined => {
  if (!isPlainObject(value) || typeof value.preset !== "string") return
  const preset = value.preset as DashboardLayoutPreset
  if (!(preset in DASHBOARD_LAYOUT_PRESETS)) return
  const base = DASHBOARD_LAYOUT_PRESETS[preset]
  return {
    preset,
    colSpan: typeof value.colSpan === "number" ? value.colSpan : base.colSpan,
    rowSpan: typeof value.rowSpan === "number" ? value.rowSpan : base.rowSpan,
    minHeight: typeof value.minHeight === "number" ? value.minHeight : base.minHeight,
  }
}

const defaultWidgetLayout = (visualization: VisualizationPayload): DashboardLayoutItem => {
  if (visualization.kind === "metrics") return { ...DASHBOARD_LAYOUT_PRESETS.compact }
  if (visualization.kind === "table") return { ...DASHBOARD_LAYOUT_PRESETS.wide }
  if (visualization.chartType === "combo") return { ...DASHBOARD_LAYOUT_PRESETS.hero }
  if (visualization.chartType === "donut") return { ...DASHBOARD_LAYOUT_PRESETS.compact }
  if (visualization.chartType === "area") return { ...DASHBOARD_LAYOUT_PRESETS.wide }
  return { ...DASHBOARD_LAYOUT_PRESETS.wide }
}

const withSourceOrigin = (source: WidgetSource, origin: { sessionID: string; messageID: string; partID: string; toolName: string }) => ({
  ...source,
  origin: {
    sessionID: origin.sessionID,
    messageID: origin.messageID,
    partID: origin.partID,
    toolName: origin.toolName,
  },
})

const mergeDashboardFilters = (base: DashboardFilterState | undefined, override: DashboardFilterState | undefined) => ({
  ...dashboardFilters(base),
  ...dashboardFilters(override),
})

const dashboardListResult = (value: DashboardDirectoryState): DashboardListResult => ({
  dashboards: value.dashboards.slice().sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created)),
  lastUsedDashboardID: value.lastUsedDashboardID,
})

const parseJsonString = (value: string) => {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

const extractVisualizationMetadata = (toolResponse: unknown): { visualization?: VisualizationPayload; dashboardSource?: WidgetSource } => {
  if (typeof toolResponse === "string") {
    const parsed = parseJsonString(toolResponse)
    if (parsed !== undefined) return extractVisualizationMetadata(parsed)
    return {}
  }

  const structured = (() => {
    if (isPlainObject(toolResponse) && Array.isArray(toolResponse.structuredContent)) return toolResponse.structuredContent
    if (isPlainObject(toolResponse) && isPlainObject(toolResponse.structuredContent)) return [toolResponse.structuredContent]
    if (Array.isArray(toolResponse)) return toolResponse
    if (isPlainObject(toolResponse)) return [toolResponse]
    return []
  })()

  for (const item of structured) {
    if (!isPlainObject(item)) continue
    const directVisualization = isVisualizationPayload(item.visualization) ? item.visualization : undefined
    if (directVisualization) {
      return {
        visualization: cloneVisualizationPayload(directVisualization),
        dashboardSource: widgetSource(item.dashboardSource),
      }
    }
    if (isVisualizationPayload(item)) {
      return {
        visualization: cloneVisualizationPayload(item),
      }
    }
  }

  return {}
}

const toolInputVisualization = (tool: string, input: unknown): VisualizationPayload | undefined =>
  parseVisualizationToolInput(tool, input)

export async function createLocalService(input: {
  userDataPath: string
  authStore: ProviderAuthStore
  sendEditorToolRequest?: (toolName: string, toolInput: Record<string, unknown>) => Promise<string>
}) {
  const statePath = join(input.userDataPath, "backoffice-state.json")
  const defaults = defaultState()
  const initial = await readJson(statePath, defaults)
  const state: PersistedState = {
    ...defaults,
    ...initial,
    config: {
      ...defaults.config,
      ...(isPlainObject(initial.config) ? initial.config : {}),
    },
    preferences: {
      ...defaults.preferences,
      ...(isPlainObject(initial.preferences) ? initial.preferences : {}),
    },
    integrations: {
      editor: applyEditorEnvOverrides(
        resolveEditorIntegrationConfig(
          coerceEditorIntegrationUpdate(
            defaults.integrations.editor,
            isPlainObject(initial.integrations?.editor)
              ? (initial.integrations.editor as Partial<EditorIntegrationConfig>)
              : {},
          ),
        ),
      ),
    },
    projects: Array.isArray(initial.projects) ? initial.projects : [],
    sessions: Array.isArray(initial.sessions) ? initial.sessions : [],
    messages: Array.isArray(initial.messages) ? initial.messages : [],
    todos: initial.todos ?? {},
    permissions: initial.permissions ?? {},
    questions: initial.questions ?? {},
    dashboards: initial.dashboards ?? {},
    analyticsEvents: Array.isArray(initial.analyticsEvents) ? initial.analyticsEvents : [],
  }

  const migrateLegacyMessageIDs = () => {
    const remapped = new Map<string, string>()
    const sorted = state.messages
      .slice()
      .sort((a, b) => (a.info.time.created ?? 0) - (b.info.time.created ?? 0) || a.info.id.localeCompare(b.info.id))

    for (const entry of sorted) {
      if (entry.info.id.startsWith("msg_")) continue
      const createdAt = entry.info.time.created ?? now()
      const nextID = createSortableID("message", createdAt)
      remapped.set(entry.info.id, nextID)
      entry.info.id = nextID
      for (const part of entry.parts) {
        part.messageID = nextID
        if (!part.id.startsWith("prt_")) {
          part.id = createSortableID("part", createdAt)
        }
      }
    }

    if (remapped.size === 0) return false

    for (const entry of state.messages) {
      if (entry.info.role === "assistant" && remapped.has(entry.info.parentID)) {
        entry.info.parentID = remapped.get(entry.info.parentID)!
      }
    }

    for (const session of state.sessions) {
      if (session.revert?.messageID && remapped.has(session.revert.messageID)) {
        session.revert.messageID = remapped.get(session.revert.messageID)!
      }
    }

    return true
  }

  const migrateVisualizationToolParts = () => {
    let changed = false

    for (const entry of state.messages) {
      for (const part of entry.parts) {
        if (part.type !== "tool" || part.state.status !== "completed") continue
        const metadata = isPlainObject(part.state.metadata) ? { ...part.state.metadata } : {}
        if (metadata.visualization && metadata.dashboardSource) continue

        const extracted = extractVisualizationMetadata(part.state.output)
        const visualization = extracted.visualization ?? metadata.visualization ?? toolInputVisualization(part.tool, part.state.input)
        const dashboardSource = extracted.dashboardSource ?? metadata.dashboardSource

        if (!visualization && !dashboardSource) continue

        part.state.metadata = {
          ...metadata,
          ...(visualization ? { visualization } : {}),
          ...(dashboardSource ? { dashboardSource } : {}),
        }
        changed = true
      }
    }

    return changed
  }

  const migrateVisualizationToolTitles = () => {
    let changed = false

    for (const entry of state.messages) {
      for (const part of entry.parts) {
        if (part.type !== "tool") continue
        const normalized = normalizeToolName(part.tool)
        if (part.state.title === part.tool && normalized !== part.tool) {
          part.state.title = normalized
          changed = true
        }
        const metadata = isPlainObject(part.state.metadata) ? part.state.metadata : undefined
        if (metadata && isPlainObject(metadata.dashboardSource) && isPlainObject(metadata.dashboardSource.origin)) {
          const originToolName = metadata.dashboardSource.origin.toolName
          if (typeof originToolName === "string") {
            const nextToolName = normalizeToolName(originToolName)
            if (nextToolName !== originToolName) {
              metadata.dashboardSource.origin.toolName = nextToolName
              changed = true
            }
          }
        }
      }
    }

    return changed
  }

  if (migrateLegacyMessageIDs() || migrateVisualizationToolParts() || migrateVisualizationToolTitles()) {
    await writeJson(statePath, state)
  }

  const eventClients = new Set<ServerResponse>()
  const activeRuns = new Map<string, ActiveRun>()
  const activeEditorStates = new Map<string, ActiveEditorState>()
  const pendingPermissionReplies = new Map<
    string,
    {
      sessionID: string
      resolve: (response: "once" | "always" | "reject") => void
      reject: (error: Error) => void
    }
  >()
  const editorMcpServer = input.sendEditorToolRequest
    ? createOnlyOfficeMcpServer(input.sendEditorToolRequest)
    : undefined
  let savePending: Promise<void> | undefined

  const scheduleSave = () => {
    if (savePending) return savePending
    savePending = writeJson(statePath, state).finally(() => {
      savePending = undefined
    })
    return savePending
  }

  const emit = (directory: string | undefined, payload: ServiceEvent["payload"]) => {
    const event: ServiceEvent = { directory, payload }
    for (const client of eventClients) {
      sendSse(client, event)
    }
  }

  const resolveAnthropicCredential = async (): Promise<ResolvedProviderCredential | null> => {
    const storedKey = await input.authStore.getApiKey(ANTHROPIC_PROVIDER_ID)
    if (storedKey) {
      return {
        key: storedKey,
        source: "api",
      }
    }

    const envKey = process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim()
    if (!envKey) return null

    return {
      key: envKey,
      source: "env",
    }
  }

  const resolveClaudeCodeExecutablePath = async () => {
    const sdkEntryUrl = await import.meta.resolve(ANTHROPIC_SDK_PACKAGE)
    const sdkEntryPath = fileURLToPath(sdkEntryUrl)
    const resolvedCliPath = join(dirname(sdkEntryPath), "cli.js")
    const candidates = Array.from(
      new Set([
        toUnpackedAsarPath(resolvedCliPath),
        join(process.resourcesPath, "app.asar.unpacked", CLAUDE_CODE_CLI_RELATIVE_PATH),
        resolvedCliPath,
      ]),
    )

    for (const candidate of candidates) {
      if (await pathExists(candidate)) return candidate
    }

    throw new Error(`Claude Code executable could not be found. Checked: ${candidates.join(", ")}`)
  }

  const dashboardStateFor = (directory: string): DashboardDirectoryState => {
    const existing = state.dashboards[directory]
    if (existing) return existing
    const created: DashboardDirectoryState = {
      dashboards: [],
    }
    state.dashboards[directory] = created
    return created
  }

  const findDashboard = (directory: string, dashboardID?: string) => {
    const scoped = dashboardStateFor(directory)
    const targetID = dashboardID ?? scoped.lastUsedDashboardID
    if (!targetID) return
    return scoped.dashboards.find((dashboard) => dashboard.id === targetID)
  }

  const createDashboard = (directory: string, input: { title?: string; description?: string; filters?: DashboardFilterState }) => {
    const createdAt = now()
    const dashboard: Dashboard = {
      id: `dashboard_${randomUUID()}`,
      directory,
      title: input.title?.trim() || `Workspace overview`,
      description: input.description?.trim() || undefined,
      filters: dashboardFilters(input.filters),
      widgets: [],
      time: {
        created: createdAt,
        updated: createdAt,
      },
    }
    const scoped = dashboardStateFor(directory)
    scoped.dashboards.unshift(dashboard)
    scoped.lastUsedDashboardID = dashboard.id
    return dashboard
  }

  const buildAnalyticsSnapshot = (directory: string): AnalyticsSnapshot => {
    const sessionIDs = new Set(
      state.sessions.filter((session) => session.directory === directory).map((session) => session.id),
    )
    return {
      directory,
      sessions: state.sessions.filter((session) => session.directory === directory),
      messages: state.messages.filter((message) => sessionIDs.has(message.info.sessionID)),
      events: state.analyticsEvents.filter((event) => event.directory === directory),
    }
  }

  const runAnalyticsQuery = (directory: string, input: unknown): AnalyticsQueryResult => {
    const query = analyticsQuery(input)
    if (!query) {
      throw new Error("Invalid analytics query")
    }
    return queryWorkspaceAnalytics(buildAnalyticsSnapshot(directory), query)
  }

  const recordAnalyticsEvent = async (event: AnalyticsEvent) => {
    state.analyticsEvents.push(event)
    if (state.analyticsEvents.length > 5000) {
      state.analyticsEvents.splice(0, state.analyticsEvents.length - 5000)
    }
    await scheduleSave()
  }

  const updateEditorIntegration = async (next: Partial<EditorIntegrationConfig>) => {
    state.integrations.editor = applyEditorEnvOverrides(
      resolveEditorIntegrationConfig(coerceEditorIntegrationUpdate(state.integrations.editor, next)),
    )
    await shutdownEditorTunnelManager()
    await scheduleSave()
  }

  const onlyOfficeHandlers = createOnlyOfficeApiHandlers({
    getConfig: () => state.integrations.editor,
    getIngressPort: () => getEditorIngressPort(),
    ensureTunnelReady: ensureEditorTunnelReady,
    getTunnelState: getEditorTunnelState,
    reconnectTunnel: reconnectEditorTunnel,
  })

  const ingressPort = await startEditorIngressServer({
    handleDownload: onlyOfficeHandlers.handleDownload,
    handleCallbackGet: onlyOfficeHandlers.handleCallbackGet,
    handleCallbackPost: onlyOfficeHandlers.handleCallbackPost,
  })
  setEditorTunnelIngressPort(ingressPort)

  const ensureProject = async (directory: string) => {
    const existing = state.projects.find((project) => project.worktree === directory)
    if (existing) return existing
    const createdAt = now()
    const project: Project = {
      id: `project_${checksum(directory)}`,
      worktree: directory,
      vcs: (await fs
        .stat(join(directory, ".git"))
        .then(() => true)
        .catch(() => false))
        ? "git"
        : undefined,
      time: {
        created: createdAt,
        updated: createdAt,
        initialized: createdAt,
      },
      sandboxes: [],
    }
    state.projects.push(project)
    await scheduleSave()
    emit(undefined, { type: "project.updated", properties: project })
    return project
  }

  const pathPayload = (directory = ""): PathPayload => ({
    state: input.userDataPath,
    config: statePath,
    worktree: directory,
    directory,
    home: homedir(),
  })

  const sessionStatus = (directory: string) =>
    Object.fromEntries(
      state.sessions
        .filter((session) => session.directory === directory && !session.time.archived)
        .map((session) => {
          const active = activeRuns.get(session.id)
          return [session.id, active ? ({ type: "busy" } as const) : ({ type: "idle" } as const)]
        }),
    )

  const getSession = (sessionID: string) => state.sessions.find((session) => session.id === sessionID)
  const getMessages = (sessionID: string) => state.messages.filter((message) => message.info.sessionID === sessionID)
  const buildRunPrompt = (sessionID: string, prompt: string) => {
    const editor = activeEditorStates.get(sessionID)
    if (!editor || !state.integrations.editor.enabled) return prompt
    return `${serializeEditorContext(editor)}\n\n${serializeEditorToolGuidance(editor)}\n\nUser message:\n${prompt}`
  }

  const upsertMessage = (info: Message, parts: Part[]) => {
    const index = state.messages.findIndex((entry) => entry.info.id === info.id)
    if (index === -1) {
      state.messages.push({ info, parts })
      return
    }
    state.messages[index] = { info, parts }
  }

  const findToolPart = (messageID: string, callID: string) => {
    const entry = state.messages.find((message) => message.info.id === messageID)
    if (!entry) return undefined
    return entry.parts.find((part) => part.type === "tool" && part.callID === callID) as ToolPart | undefined
  }

  const ensureToolPart = async (input: {
    sessionID: string
    directory: string
    messageID: string
    callID: string
    tool: string
    toolInput: Record<string, unknown>
    metadata?: Record<string, unknown>
  }) => {
    const existing = findToolPart(input.messageID, input.callID)
    if (existing) return existing

    const entry = state.messages.find((message) => message.info.id === input.messageID)
    if (!entry) return undefined

    const createdAt = now()
    const part: ToolPart = {
      id: createSortableID("part", createdAt),
      sessionID: input.sessionID,
      messageID: input.messageID,
      type: "tool",
      callID: input.callID,
      tool: input.tool,
      state: {
        status: "running",
        input: input.toolInput,
        time: { start: createdAt },
        metadata: input.metadata,
        title: input.tool,
      },
    }
    entry.parts.push(part)
    await scheduleSave()
    emit(input.directory, { type: "message.part.updated", properties: { part } })
    return part
  }

  const completeToolPart = async (input: {
    sessionID: string
    directory: string
    messageID: string
    callID: string
    tool: string
    toolInput: Record<string, unknown>
    output: unknown
    metadata?: Record<string, unknown>
  }) => {
    const existing = await ensureToolPart({
      sessionID: input.sessionID,
      directory: input.directory,
      messageID: input.messageID,
      callID: input.callID,
      tool: input.tool,
      toolInput: input.toolInput,
      metadata: input.metadata,
    })
    if (!existing) return

    const start = existing.state.time.start
    const metadata = { ...(input.metadata ?? {}) }
    if (metadata.dashboardSource) {
      const source = widgetSource(metadata.dashboardSource)
      if (source) {
        metadata.dashboardSource = withSourceOrigin(source, {
          sessionID: input.sessionID,
          messageID: input.messageID,
          partID: existing.id,
          toolName: normalizeToolName(input.tool),
        })
      } else {
        delete metadata.dashboardSource
      }
    }
    existing.state = {
      status: "completed",
      input: input.toolInput,
      output: serializeToolOutput(input.output),
      title: input.tool,
      time: {
        start,
        end: now(),
      },
      metadata,
    }
    await scheduleSave()
    emit(input.directory, { type: "message.part.updated", properties: { part: existing } })
  }

  const upsertPendingPermission = async (request: PermissionRequest) => {
    const list = state.permissions[request.sessionID] ?? []
    const index = list.findIndex((item) => item.id === request.id)
    if (index === -1) {
      list.push(request)
      list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      state.permissions[request.sessionID] = list
      const session = getSession(request.sessionID)
      if (session) {
        await recordAnalyticsEvent({
          id: `analytics_${randomUUID()}`,
          directory: session.directory,
          sessionID: request.sessionID,
          type: "permission_asked",
          createdAt: now(),
        })
      }
    } else {
      list[index] = request
    }
    await scheduleSave()
    const session = getSession(request.sessionID)
    emit(session?.directory, { type: "permission.asked", properties: request })
  }

  const clearPendingPermission = async (input: {
    sessionID: string
    requestID: string
    reply: "once" | "always" | "reject"
  }) => {
    const list = state.permissions[input.sessionID]
    if (list) {
      state.permissions[input.sessionID] = list.filter((item) => item.id !== input.requestID)
    }
    await scheduleSave()
    const session = getSession(input.sessionID)
    emit(session?.directory, {
      type: "permission.replied",
      properties: {
        sessionID: input.sessionID,
        requestID: input.requestID,
        reply: input.reply,
      },
    })
  }

  const updateSession = async (session: Session) => {
    session.time.updated = now()
    const index = state.sessions.findIndex((item) => item.id === session.id)
    if (index === -1) {
      state.sessions.push(session)
    } else {
      state.sessions[index] = session
    }
    await scheduleSave()
    emit(session.directory, { type: "session.updated", properties: { info: session } })
  }

  const ensureAssistantMessage = async (input: {
    session: Session
    userMessage: UserMessage
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
  }) => {
    const createdAt = Math.max(now(), (input.userMessage.time.created ?? 0) + 1)
    const assistantMessageID = createSortableID("message", createdAt)
    const assistantTextPartID = createSortableID("part", createdAt)
    const assistant: AssistantMessage = {
      id: assistantMessageID,
      sessionID: input.session.id,
      role: "assistant",
      time: {
        created: createdAt,
      },
      parentID: input.userMessage.id,
      modelID: input.model.modelID,
      providerID: input.model.providerID,
      mode: "chat",
      agent: input.agent,
      path: {
        cwd: input.session.directory,
        root: input.session.directory,
      },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
      variant: input.variant,
    }
    const textPart: TextPart = {
      id: assistantTextPartID,
      sessionID: input.session.id,
      messageID: assistantMessageID,
      type: "text",
      text: "",
    }
    upsertMessage(assistant, [textPart])
    await scheduleSave()
    emit(input.session.directory, { type: "message.updated", properties: { info: assistant } })
    emit(input.session.directory, { type: "message.part.updated", properties: { part: textPart } })
    return { assistant, textPart }
  }

  const setTodos = async (sessionID: string, todos: Todo[]) => {
    state.todos[sessionID] = todos
    await scheduleSave()
    const session = getSession(sessionID)
    emit(session?.directory, { type: "todo.updated", properties: { sessionID, todos } })
  }

  const streamWithAnthropic = async (input: {
    prompt: string
    session: Session
    directory: string
    controller: AbortController
    run: ActiveRun
    assistantMessageID: string
    onText: (value: string) => Promise<void> | void
    modelID: string
  }): Promise<SDKResultMessage | undefined> => {
    const anthropicCredential = await resolveAnthropicCredential()
    if (!anthropicCredential) {
      throw new Error("Anthropic API key is not configured. Connect Anthropic in Settings > Providers to continue.")
    }

    const sdk = await import("@anthropic-ai/claude-agent-sdk")
    const pathToClaudeCodeExecutable = await resolveClaudeCodeExecutablePath()
    const claudeRuntimeEnv = {
      ...process.env,
      ANTHROPIC_API_KEY: anthropicCredential.key,
    }
    const spawnClaudeCodeProcess: AgentOptions["spawnClaudeCodeProcess"] = ({ args, cwd, env, signal }) => {
      const { CLAUDECODE: _drop, ...cleanEnv } = env as Record<string, string | undefined>
      const child = spawn(process.execPath, args, {
        cwd,
        env: {
          ...cleanEnv,
          ELECTRON_RUN_AS_NODE: "1",
        },
        signal,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      })

      return {
        stdin: child.stdin,
        stdout: child.stdout,
        get killed() {
          return child.killed
        },
        get exitCode() {
          return child.exitCode
        },
        kill: child.kill.bind(child),
        on: child.on.bind(child),
        once: child.once.bind(child),
        off: child.off.bind(child),
      }
    }

    const waitForPermissionDecision = async (request: PermissionRequest, signal: AbortSignal) =>
      new Promise<"once" | "always" | "reject">((resolve, reject) => {
        const cleanup = () => {
          signal.removeEventListener("abort", onAbort)
          input.controller.signal.removeEventListener("abort", onAbort)
        }

        const onAbort = () => {
          pendingPermissionReplies.delete(request.id)
          cleanup()
          reject(new Error("Permission request cancelled"))
        }

        pendingPermissionReplies.set(request.id, {
          sessionID: request.sessionID,
          resolve: (response) => {
            pendingPermissionReplies.delete(request.id)
            cleanup()
            resolve(response)
          },
          reject: (error) => {
            pendingPermissionReplies.delete(request.id)
            cleanup()
            reject(error)
          },
        })

        signal.addEventListener("abort", onAbort, { once: true })
        input.controller.signal.addEventListener("abort", onAbort, { once: true })
      })

    const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
      const normalizedInput = coerceRecord(toolInput)
      if (isVisualizationToolName(toolName)) {
        await ensureToolPart({
          sessionID: input.session.id,
          directory: input.directory,
          messageID: input.assistantMessageID,
          callID: options.toolUseID,
          tool: toolName,
          toolInput: normalizedInput,
        })
        return {
          behavior: "allow",
          updatedInput: normalizedInput,
          toolUseID: options.toolUseID,
        } satisfies PermissionResult
      }
      const permissionRequest: PermissionRequest = {
        id: `permission_${randomUUID()}`,
        sessionID: input.session.id,
        permission: permissionNameForTool(toolName),
        patterns: permissionPatternsForTool(normalizedInput, options.blockedPath),
        metadata: {
          toolName,
          toolInput: normalizedInput,
          suggestions: options.suggestions ?? [],
          blockedPath: options.blockedPath,
          decisionReason: options.decisionReason,
          agentID: options.agentID,
        },
        always: options.suggestions?.length ? ["session"] : [],
        tool: {
          messageID: input.assistantMessageID,
          callID: options.toolUseID,
        },
      }

      await ensureToolPart({
        sessionID: input.session.id,
        directory: input.directory,
        messageID: input.assistantMessageID,
        callID: options.toolUseID,
        tool: toolName,
        toolInput: normalizedInput,
      })
      await upsertPendingPermission(permissionRequest)

      let reply: "once" | "always" | "reject" = "reject"
      try {
        reply = await waitForPermissionDecision(permissionRequest, options.signal)
      } catch (error) {
        await clearPendingPermission({
          sessionID: input.session.id,
          requestID: permissionRequest.id,
          reply: "reject",
        })
        await completeToolPart({
          sessionID: input.session.id,
          directory: input.directory,
          messageID: input.assistantMessageID,
          callID: options.toolUseID,
          tool: toolName,
          toolInput: normalizedInput,
          output: error instanceof Error ? error.message : String(error),
        })
        return {
          behavior: "deny",
          message: error instanceof Error ? error.message : String(error),
          interrupt: true,
          toolUseID: options.toolUseID,
        } satisfies PermissionResult
      }

      await clearPendingPermission({
        sessionID: input.session.id,
        requestID: permissionRequest.id,
        reply,
      })

      if (reply === "reject") {
        await completeToolPart({
          sessionID: input.session.id,
          directory: input.directory,
          messageID: input.assistantMessageID,
          callID: options.toolUseID,
          tool: toolName,
          toolInput: normalizedInput,
          output: "Permission rejected",
        })
        return {
          behavior: "deny",
          message: "Permission rejected",
          interrupt: true,
          toolUseID: options.toolUseID,
        } satisfies PermissionResult
      }

      return {
        behavior: "allow",
        updatedInput: normalizedInput,
        updatedPermissions: reply === "always" ? options.suggestions : undefined,
        toolUseID: options.toolUseID,
      } satisfies PermissionResult
    }

    const hooks: NonNullable<AgentOptions["hooks"]> = {
      PreToolUse: [
        {
          hooks: [
            async (hookInput, toolUseID) => {
              if (!toolUseID) return { continue: true }
              const inputRecord = hookInput as PreToolUseHookInput
              await ensureToolPart({
                sessionID: input.session.id,
                directory: input.directory,
                messageID: input.assistantMessageID,
                callID: toolUseID,
                tool: inputRecord.tool_name,
                toolInput: coerceRecord(inputRecord.tool_input),
              })
              return { continue: true }
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            async (hookInput, toolUseID) => {
              if (!toolUseID) return { continue: true }
              const resultInput = hookInput as PostToolUseHookInput
              const normalizedInput = coerceRecord(resultInput.tool_input)
              const visualizationMetadata = extractVisualizationMetadata(resultInput.tool_response)
              await completeToolPart({
                sessionID: input.session.id,
                directory: input.directory,
                messageID: input.assistantMessageID,
                callID: toolUseID,
                tool: resultInput.tool_name,
                toolInput: normalizedInput,
                output: resultInput.tool_response,
                metadata:
                  visualizationMetadata.visualization || visualizationMetadata.dashboardSource
                    ? {
                        ...(visualizationMetadata.visualization
                          ? { visualization: visualizationMetadata.visualization }
                          : {}),
                        ...(visualizationMetadata.dashboardSource
                          ? { dashboardSource: visualizationMetadata.dashboardSource }
                          : {}),
                      }
                    : undefined,
              })

              const normalizedTool = normalizeToolName(resultInput.tool_name)
              if (normalizedTool === "todowrite" || normalizedTool === "todo_write" || normalizedTool === "todo") {
                const nextTodos =
                  isPlainObject(resultInput.tool_response) && Array.isArray(resultInput.tool_response.newTodos)
                    ? normalizeTodos(resultInput.tool_response.newTodos)
                    : normalizeTodos(normalizedInput)
                await setTodos(input.session.id, nextTodos)
              }

              if (normalizedTool === "question" || normalizedTool === "ask_user_question") {
                await recordAnalyticsEvent({
                  id: `analytics_${randomUUID()}`,
                  directory: input.directory,
                  sessionID: input.session.id,
                  type: "question_asked",
                  createdAt: now(),
                })
              }

              return { continue: true }
            },
          ],
        },
      ],
      PostToolUseFailure: [
        {
          hooks: [
            async (hookInput, toolUseID) => {
              if (!toolUseID) return { continue: true }
              const failureInput = hookInput as PostToolUseFailureHookInput
              await completeToolPart({
                sessionID: input.session.id,
                directory: input.directory,
                messageID: input.assistantMessageID,
                callID: toolUseID,
                tool: failureInput.tool_name,
                toolInput: coerceRecord(failureInput.tool_input),
                output: failureInput.error,
              })
              return { continue: true }
            },
          ],
        },
      ],
    }

    const editorState = activeEditorStates.get(input.session.id)
    const includeEditorMcp = Boolean(editorState && state.integrations.editor.enabled && editorMcpServer)
    const visualizationMcpServer = createVisualizationMcpServer(() => buildAnalyticsSnapshot(input.directory))
    const mcpServers = {
      ...(includeEditorMcp && editorMcpServer ? { editor: editorMcpServer } : {}),
      visualization: visualizationMcpServer,
    }

    const iterator = sdk.query({
      prompt: input.prompt,
      options: {
        abortController: input.controller,
        canUseTool,
        cwd: input.directory,
        env: claudeRuntimeEnv,
        hooks,
        includePartialMessages: true,
        mcpServers,
        model: input.modelID,
        pathToClaudeCodeExecutable,
        permissionMode: "default",
        resume: input.session.anthropicSessionID,
        settingSources: [],
        spawnClaudeCodeProcess,
      },
    })
    input.run.query = iterator

    let result: SDKResultMessage | undefined
    let appendedPartialText = false

    let pendingSessionID: string | undefined

    for await (const item of iterator) {
      if (item.type === "system" && item.subtype === "init" && input.session.anthropicSessionID !== item.session_id) {
        pendingSessionID = item.session_id
        continue
      }

      if (item.type === "result" && pendingSessionID) {
        if (item.subtype === "success") {
          input.session.anthropicSessionID = pendingSessionID
          await scheduleSave()
          emit(input.directory, { type: "session.updated", properties: { info: input.session } })
        }
        pendingSessionID = undefined
      }

      const streamEvent = extractStreamEvent(item)
      if (streamEvent?.textDelta) {
        appendedPartialText = true
        await input.onText(streamEvent.textDelta)
        continue
      }

      if (streamEvent?.toolUse) {
        await ensureToolPart({
          sessionID: input.session.id,
          directory: input.directory,
          messageID: input.assistantMessageID,
          callID: streamEvent.toolUse.id,
          tool: streamEvent.toolUse.name,
          toolInput: streamEvent.toolUse.input,
        })
        continue
      }

      if (item.type === "assistant") {
        if (!appendedPartialText) {
          const text = extractAssistantText(item.message)
          if (text) {
            appendedPartialText = true
            await input.onText(text)
          }
        }
        continue
      }

      if (item.type === "system" && item.subtype === "local_command_output" && item.content) {
        await input.onText(item.content)
        continue
      }

      if (item.type === "result") {
        result = item
      }
    }

    return result
  }

  const runPrompt = async (input: {
    directory: string
    session: Session
    userMessage: UserMessage
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
    prompt: string
  }) => {
    const controller = new AbortController()
    const active: ActiveRun = {
      controller,
      directory: input.directory,
      sessionID: input.session.id,
      messageID: input.userMessage.id,
      assistantMessageID: "",
    }
    activeRuns.set(input.session.id, active)
    emit(input.directory, {
      type: "session.status",
      properties: { sessionID: input.session.id, status: { type: "busy" } },
    })

    const { assistant, textPart } = await ensureAssistantMessage(input)
    active.assistantMessageID = assistant.id

    const appendText = async (value: string) => {
      const entry = state.messages.find((message) => message.info.id === assistant.id)
      if (!entry) return
      const target = entry.parts.find((part) => part.id === textPart.id && part.type === "text") as TextPart | undefined
      if (!target) return
      target.text += value
      await scheduleSave()
      emit(input.directory, {
        type: "message.part.delta",
        properties: {
          sessionID: input.session.id,
          messageID: assistant.id,
          partID: textPart.id,
          field: "text",
          delta: value,
        },
      })
    }

    try {
      let result = await streamWithAnthropic({
        prompt: input.prompt,
        session: input.session,
        directory: input.directory,
        controller,
        run: active,
        assistantMessageID: assistant.id,
        onText: appendText,
        modelID: input.model.modelID,
      })

      // If resume failed with "No conversation found", retry as new session
      if (
        result?.subtype !== "success" &&
        input.session.anthropicSessionID &&
        result?.errors?.some((e: string) => /no conversation found/i.test(e))
      ) {
        input.session.anthropicSessionID = undefined
        await scheduleSave()
        result = await streamWithAnthropic({
          prompt: input.prompt,
          session: input.session,
          directory: input.directory,
          controller,
          run: active,
          assistantMessageID: assistant.id,
          onText: appendText,
          modelID: input.model.modelID,
        })
      }

      if (result) {
        assistant.cost = usageNumber(result.total_cost_usd)
        assistant.tokens.input = usageNumber(result.usage.input_tokens)
        assistant.tokens.output = usageNumber(result.usage.output_tokens)
        assistant.tokens.reasoning = 0
        assistant.tokens.cache.read = usageNumber(result.usage.cache_read_input_tokens)
        assistant.tokens.cache.write = usageNumber(result.usage.cache_creation_input_tokens)
        assistant.finish = result.stop_reason ?? (result.subtype === "success" ? "stop" : "error")

        if (result.subtype !== "success") {
          assistant.error = {
            name: result.subtype,
            data: {
              message: result.errors.join("\n") || "Anthropic Agent SDK execution failed.",
            },
          }
        }

        // If the SDK reported "success" but the assistant text indicates an API error
        // (e.g. auth failure), clear the session ID so we don't try to resume a broken session.
        const assistantEntry = state.messages.find((m) => m.info.id === assistant.id)
        const assistantText = assistantEntry?.parts.find((p) => p.type === "text") as TextPart | undefined
        if (assistantText?.text && /failed to authenticate|API Error:\s*4\d\d/i.test(assistantText.text)) {
          input.session.anthropicSessionID = undefined
        }
      }

      assistant.time.completed = now()
      if (!assistant.finish) assistant.finish = "stop"
      input.session.title = input.session.title || isoTitle("New session")
      input.session.time.updated = now()
      if (!input.userMessage.summary?.title) {
        input.userMessage.summary = {
          title: summaryFromText(input.prompt),
          body: undefined,
          diffs: [],
        }
      }
      upsertMessage(
        input.userMessage,
        getMessages(input.userMessage.sessionID).find((item) => item.info.id === input.userMessage.id)?.parts ?? [],
      )
      await scheduleSave()
      emit(input.directory, { type: "message.updated", properties: { info: assistant } })
      emit(input.directory, { type: "message.updated", properties: { info: input.userMessage } })
      emit(input.directory, { type: "session.updated", properties: { info: input.session } })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      assistant.time.completed = now()

      // Clear session ID on crash — the session is broken and shouldn't be resumed.
      // But preserve it on abort — the session was working fine, just interrupted.
      if (!controller.signal.aborted) {
        input.session.anthropicSessionID = undefined
      }

      // Write error text into the message part so the user sees it
      const entry = state.messages.find((m) => m.info.id === assistant.id)
      const target = entry?.parts.find((p): p is TextPart => p.id === textPart.id && p.type === "text")
      if (target && !target.text) {
        target.text = errorMessage
        emit(input.directory, {
          type: "message.part.delta",
          properties: {
            sessionID: input.session.id,
            messageID: assistant.id,
            partID: textPart.id,
            field: "text",
            delta: errorMessage,
          },
        })
      }

      assistant.error = {
        name: controller.signal.aborted ? "MessageAbortedError" : "UnknownError",
        data: { message: errorMessage },
      }
      await scheduleSave()
      emit(input.directory, { type: "message.updated", properties: { info: assistant } })
      emit(input.directory, { type: "session.updated", properties: { info: input.session } })
    } finally {
      try {
        active.query?.close()
      } catch {
        // Ignore shutdown errors during abort/cleanup.
      }
      activeRuns.delete(input.session.id)
      emit(input.directory, {
        type: "session.status",
        properties: { sessionID: input.session.id, status: { type: "idle" } },
      })
    }
  }

  const handlePromptAsync = async (directory: string, input: any) => {
    const session = getSession(input.sessionID)
    if (!session) throw new Error(`Unknown session ${input.sessionID}`)
    const createdAt = now()
    const userMessage: UserMessage = {
      id: input.messageID ?? createSortableID("message", createdAt),
      sessionID: session.id,
      role: "user",
      time: {
        created: createdAt,
      },
      agent: input.agent ?? "Rendesk",
      model: input.model ?? {
        providerID: ANTHROPIC_PROVIDER_ID,
        modelID: DEFAULT_ANTHROPIC_MODEL_ID,
      },
      variant: input.variant,
      summary: {
        title: summaryFromText(serializePrompt(input.parts ?? [])),
        body: undefined,
        diffs: [],
      },
    }
    const parts = (input.parts ?? []).map((part: any): Part => {
      if (part.type === "text") {
        return {
          id: part.id ?? createSortableID("part", createdAt),
          sessionID: session.id,
          messageID: userMessage.id,
          type: "text",
          text: part.text ?? "",
          synthetic: part.synthetic,
          ignored: part.ignored,
          metadata: part.metadata,
        }
      }
      return {
        id: part.id ?? createSortableID("part", createdAt),
        sessionID: session.id,
        messageID: userMessage.id,
        type: "file",
        mime: part.mime ?? fileMime(part.filename ?? ""),
        filename: part.filename,
        url: part.url,
        source: part.source,
      }
    })
    upsertMessage(userMessage, parts)
    session.time.updated = now()
    if (userMessage.summary?.title && (!session.title || isDefaultSessionTitle(session.title))) {
      session.title = userMessage.summary.title
    }
    if (!session.title) {
      session.title = isoTitle("New session")
    }
    await scheduleSave()
    emit(directory, { type: "message.updated", properties: { info: userMessage } })
    for (const part of parts) {
      emit(directory, { type: "message.part.updated", properties: { part } })
    }
    emit(directory, { type: "session.updated", properties: { info: session } })

    void runPrompt({
      directory,
      session,
      userMessage,
      agent: input.agent ?? "Rendesk",
      model: input.model ?? { providerID: ANTHROPIC_PROVIDER_ID, modelID: DEFAULT_ANTHROPIC_MODEL_ID },
      variant: input.variant,
      prompt: buildRunPrompt(session.id, serializePrompt(input.parts ?? [])),
    })
  }

  const fileList = async (directory: string, path: string) => {
    const root = resolve(directory, path || ".")
    const items = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    return items
      .map((item) => {
        const absolute = join(root, item.name)
        return {
          name: item.name,
          path: relativePath(directory, absolute),
          absolute,
          type: item.isDirectory() ? "directory" : "file",
          ignored: false,
        }
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1
        return a.name.localeCompare(b.name)
      })
  }

  const fileRead = async (directory: string, path: string) => {
    const absolute = resolve(directory, path)
    const buffer = await fs.readFile(absolute)
    if (!isTextLike(buffer)) {
      return {
        type: "binary",
        content: buffer.toString("base64"),
        encoding: "base64",
        mimeType: fileMime(absolute),
      }
    }
    return {
      type: "text",
      content: buffer.toString("utf8"),
      mimeType: fileMime(absolute),
    }
  }

  const findFiles = async (directory: string, query: string) => {
    const matches: string[] = []
    const lowered = query.toLowerCase()
    const walk = async (current: string) => {
      if (matches.length >= 100) return
      const items = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
      for (const item of items) {
        if (matches.length >= 100) return
        const absolute = join(current, item.name)
        if (item.isDirectory()) {
          if (item.name === ".git" || item.name === "node_modules") continue
          await walk(absolute)
          continue
        }
        if (item.name.toLowerCase().includes(lowered)) {
          matches.push(relativePath(directory, absolute))
        }
      }
    }
    await walk(directory)
    return matches
  }

  const resolveDashboard = (directory: string, input: { dashboardID?: string; createTitle?: string; description?: string }) => {
    let dashboard = findDashboard(directory, input.dashboardID)
    if (!dashboard && input.createTitle) {
      dashboard = createDashboard(directory, {
        title: input.createTitle,
        description: input.description,
      })
    }
    return dashboard
  }

  const refreshWidget = (directory: string, dashboard: Dashboard, widget: DashboardWidget, filters?: DashboardFilterState) => {
    if (widget.source.mode === "snapshot") {
      widget.refreshStatus = "idle"
      return widget
    }

    if (widget.source.mode === "connector_query") {
      widget.refreshStatus = "error"
      widget.refreshError = "Connector-backed widgets are not enabled in this desktop build."
      widget.time.updated = now()
      return widget
    }

    widget.refreshStatus = "refreshing"
    const result = queryWorkspaceAnalytics(buildAnalyticsSnapshot(directory), {
      ...widget.source.query,
      filters: mergeDashboardFilters(dashboard.filters, filters),
    })
    if (result.visualization) {
      widget.visualization = cloneVisualizationPayload(result.visualization)
      widget.refreshStatus = "idle"
      widget.refreshError = undefined
      widget.time.refreshed = result.generatedAt
      widget.time.updated = result.generatedAt
    }
    return widget
  }

  const handleRpc = async (request: RpcRequest) => {
    const directory = request.directory ?? ""

    switch (request.action) {
      case "global.health":
        return { data: { healthy: true, provider: "anthropic" } }
      case "global.dispose":
        emit(undefined, { type: "global.disposed", properties: {} })
        return { data: null }
      case "global.config.get":
      case "config.get":
        return { data: state.config }
      case "global.config.update":
        state.config = { ...state.config, ...(request.input ?? {}) }
        await scheduleSave()
        return { data: state.config }
      case "path.get":
        return { data: pathPayload(directory) }
      case "project.list":
        return {
          data: state.projects
            .slice()
            .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created)),
        }
      case "project.current":
        return { data: directory ? await ensureProject(directory) : undefined }
      case "project.update": {
        const project = await ensureProject(request.input?.directory ?? directory)
        Object.assign(project, {
          name: request.input?.name ?? project.name,
          icon: request.input?.icon ?? project.icon,
        })
        project.time.updated = now()
        await scheduleSave()
        emit(undefined, { type: "project.updated", properties: project })
        return { data: project }
      }
      case "project.initGit": {
        const project = await ensureProject(request.input?.directory ?? directory)
        project.vcs = "git"
        await scheduleSave()
        emit(undefined, { type: "project.updated", properties: project })
        return { data: project }
      }
      case "provider.list":
        return { data: providerList(await resolveAnthropicCredential()) }
      case "provider.auth":
        return {
          data: {
            [ANTHROPIC_PROVIDER_ID]: [{ type: "api", label: "Anthropic API key" }],
          },
        }
      case "provider.oauth.authorize":
      case "provider.oauth.callback":
        return { error: { message: "OAuth is not available in the desktop build" } }
      case "app.agents":
        return { data: agentList() }
      case "command.list":
        return { data: [] }
      case "session.status":
        return { data: directory ? sessionStatus(directory) : {} }
      case "session.list": {
        if (!directory) return { data: [], limit: request.input?.limit ?? 0, limited: false }
        await ensureProject(directory)
        const all = state.sessions
          .filter((session) => session.directory === directory && !session.time.archived)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        const limit = Number(request.input?.limit ?? all.length)
        const data = all.slice(-limit)
        return { data, limit, limited: all.length > data.length }
      }
      case "session.create": {
        if (!directory) throw new Error("Missing directory for session.create")
        const project = await ensureProject(directory)
        const createdAt = now()
        const session: Session = {
          id: `session_${randomUUID()}`,
          slug: randomUUID(),
          projectID: project.id,
          directory,
          parentID: request.input?.parentID,
          title: isoTitle(request.input?.parentID ? "Child session" : "New session"),
          version: "v1",
          time: {
            created: createdAt,
            updated: createdAt,
          },
          summary: {
            additions: 0,
            deletions: 0,
            files: 0,
            diffs: [],
          },
        }
        state.sessions.push(session)
        project.time.updated = createdAt
        await scheduleSave()
        emit(directory, { type: "session.created", properties: { info: session } })
        return { data: session }
      }
      case "session.get":
        return { data: getSession(request.input?.sessionID) }
      case "session.messages": {
        const all = getMessages(request.input?.sessionID ?? "")
          .slice()
          .sort((a, b) => (a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0))
        const limit = Number(request.input?.limit ?? all.length)
        return { data: all.slice(-limit) }
      }
      case "session.update": {
        const session = getSession(request.input?.sessionID)
        if (!session) throw new Error(`Unknown session ${request.input?.sessionID}`)
        if (request.input?.time?.archived) session.time.archived = request.input.time.archived
        if (typeof request.input?.title === "string") session.title = request.input.title
        await updateSession(session)
        return { data: session }
      }
      case "session.fork": {
        const source = getSession(request.input?.sessionID)
        if (!source) throw new Error(`Unknown session ${request.input?.sessionID}`)
        const createdAt = now()
        const session: Session = {
          ...source,
          id: `session_${randomUUID()}`,
          slug: randomUUID(),
          anthropicSessionID: undefined,
          parentID: source.id,
          title: isoTitle("Child session"),
          time: {
            created: createdAt,
            updated: createdAt,
          },
        }
        state.sessions.push(session)
        await scheduleSave()
        emit(directory, { type: "session.created", properties: { info: session } })
        return { data: session }
      }
      case "session.delete": {
        const session = getSession(request.input?.sessionID)
        if (!session) return { data: false }
        session.time.archived = now()
        await updateSession(session)
        emit(directory, { type: "session.deleted", properties: { info: session } })
        return { data: true }
      }
      case "session.promptAsync":
        await handlePromptAsync(directory, request.input)
        return { data: null }
      case "session.command": {
        const createdAt = now()
        await handlePromptAsync(directory, {
          ...request.input,
          messageID: request.input?.messageID ?? createSortableID("message", createdAt),
          parts: [
            {
              id: createSortableID("part", createdAt),
              type: "text",
              text: `/${request.input?.command ?? "command"} ${request.input?.arguments ?? ""}`.trim(),
            },
            ...(request.input?.parts ?? []),
          ],
          model: (() => {
            const [providerID, modelID] = String(
              request.input?.model ?? `${ANTHROPIC_PROVIDER_ID}/${DEFAULT_ANTHROPIC_MODEL_ID}`,
            ).split("/")
            return { providerID, modelID }
          })(),
        })
        return { data: null }
      }
      case "session.shell": {
        const createdAt = now()
        await handlePromptAsync(directory, {
          ...request.input,
          messageID: request.input?.messageID ?? createSortableID("message", createdAt),
          parts: [
            {
              id: createSortableID("part", createdAt),
              type: "text",
              text: String(request.input?.command ?? ""),
            },
          ],
        })
        return { data: null }
      }
      case "session.diff":
        return { data: [] }
      case "session.todo":
        return { data: state.todos[request.input?.sessionID ?? ""] ?? [] }
      case "session.abort": {
        const run = activeRuns.get(request.input?.sessionID)
        await run?.query?.interrupt().catch(() => undefined)
        run?.controller.abort()
        return { data: null }
      }
      case "session.revert":
      case "session.unrevert":
      case "session.summarize":
        return { data: getSession(request.input?.sessionID) }
      case "session.share":
      case "session.unshare":
        return { data: getSession(request.input?.sessionID) }
      case "permission.list": {
        const visibleSessionIDs = new Set(
          state.sessions
            .filter((session) => !directory || session.directory === directory)
            .map((session) => session.id),
        )
        return {
          data: Object.values(state.permissions)
            .flat()
            .filter((permission) => visibleSessionIDs.has(permission.sessionID)),
        }
      }
      case "permission.respond": {
        const permissionID = String(request.input?.permissionID ?? "")
        const response = (request.input?.response ?? "reject") as "once" | "always" | "reject"
        const pending = pendingPermissionReplies.get(permissionID)
        pending?.resolve(response)
        return { data: null }
      }
      case "question.list": {
        const visibleSessionIDs = new Set(
          state.sessions
            .filter((session) => !directory || session.directory === directory)
            .map((session) => session.id),
        )
        return {
          data: Object.values(state.questions)
            .flat()
            .filter((question) => visibleSessionIDs.has(question.sessionID)),
        }
      }
      case "question.reply":
      case "question.reject":
        return { data: null }
      case "mcp.status":
        return { data: {} }
      case "mcp.connect":
      case "mcp.disconnect":
        return { data: null }
      case "lsp.status":
        return { data: [] }
      case "analytics.query": {
        if (!directory) throw new Error("Missing directory for analytics.query")
        return { data: runAnalyticsQuery(directory, request.input) }
      }
      case "dashboard.list": {
        if (!directory) return { data: { dashboards: [] } satisfies DashboardListResult }
        return { data: dashboardListResult(dashboardStateFor(directory)) }
      }
      case "dashboard.get": {
        if (!directory) return { data: undefined }
        const dashboard = findDashboard(directory, request.input?.dashboardID)
        if (dashboard) {
          const scoped = dashboardStateFor(directory)
          if (scoped.lastUsedDashboardID !== dashboard.id) {
            scoped.lastUsedDashboardID = dashboard.id
            await scheduleSave()
          }
        }
        return { data: dashboard }
      }
      case "dashboard.create": {
        if (!directory) throw new Error("Missing directory for dashboard.create")
        const dashboard = createDashboard(directory, {
          title: request.input?.title,
          description: request.input?.description,
          filters: request.input?.filters,
        })
        await scheduleSave()
        return { data: dashboard }
      }
      case "dashboard.update": {
        if (!directory) throw new Error("Missing directory for dashboard.update")
        const dashboard = findDashboard(directory, request.input?.dashboardID)
        if (!dashboard) throw new Error(`Unknown dashboard ${request.input?.dashboardID}`)
        if (typeof request.input?.title === "string" && request.input.title.trim()) {
          dashboard.title = request.input.title.trim()
        }
        if ("description" in (request.input ?? {})) {
          dashboard.description = typeof request.input?.description === "string" ? request.input.description.trim() || undefined : undefined
        }
        if (request.input?.filters) {
          dashboard.filters = dashboardFilters(request.input.filters)
        }
        dashboard.time.updated = now()
        dashboardStateFor(directory).lastUsedDashboardID = dashboard.id
        await scheduleSave()
        return { data: dashboard }
      }
      case "dashboard.delete": {
        if (!directory) throw new Error("Missing directory for dashboard.delete")
        const scoped = dashboardStateFor(directory)
        const dashboardID = String(request.input?.dashboardID ?? "")
        scoped.dashboards = scoped.dashboards.filter((dashboard) => dashboard.id !== dashboardID)
        if (scoped.lastUsedDashboardID === dashboardID) {
          scoped.lastUsedDashboardID = scoped.dashboards[0]?.id
        }
        await scheduleSave()
        return { data: true }
      }
      case "dashboard.widget.add": {
        if (!directory) throw new Error("Missing directory for dashboard.widget.add")
        const dashboard = resolveDashboard(directory, {
          dashboardID: request.input?.dashboardID,
          createTitle: request.input?.createTitle,
          description: request.input?.description,
        })
        if (!dashboard) throw new Error("Dashboard is required to save a visualization")
        const visualization = isVisualizationPayload(request.input?.visualization)
          ? cloneVisualizationPayload(request.input.visualization)
          : undefined
        if (!visualization) throw new Error("Visualization payload is required")
        const source = widgetSource(request.input?.source) ?? { mode: "snapshot" as const }
        const createdAt = now()
        const widget: DashboardWidget = {
          id: `widget_${randomUUID()}`,
          dashboardID: dashboard.id,
          title:
            (typeof request.input?.title === "string" && request.input.title.trim()) ||
            visualization.title ||
            dashboard.title,
          description:
            typeof request.input?.description === "string" && request.input.description.trim()
              ? request.input.description.trim()
              : undefined,
          visualization,
          source,
          layout: widgetLayout(request.input?.layout) ?? defaultWidgetLayout(visualization),
          time: {
            created: createdAt,
            updated: createdAt,
            refreshed: source.mode === "snapshot" ? createdAt : undefined,
          },
          refreshStatus: "idle",
        }
        dashboard.widgets.unshift(widget)
        dashboard.time.updated = createdAt
        dashboardStateFor(directory).lastUsedDashboardID = dashboard.id
        await scheduleSave()
        return { data: { dashboard, widget } }
      }
      case "dashboard.widget.update": {
        if (!directory) throw new Error("Missing directory for dashboard.widget.update")
        const dashboard = findDashboard(directory, request.input?.dashboardID)
        if (!dashboard) throw new Error(`Unknown dashboard ${request.input?.dashboardID}`)
        const widget = dashboard.widgets.find((item) => item.id === request.input?.widgetID)
        if (!widget) throw new Error(`Unknown widget ${request.input?.widgetID}`)
        if (typeof request.input?.title === "string" && request.input.title.trim()) {
          widget.title = request.input.title.trim()
        }
        if ("description" in (request.input ?? {})) {
          widget.description = typeof request.input?.description === "string" ? request.input.description.trim() || undefined : undefined
        }
        if (isVisualizationPayload(request.input?.visualization)) {
          widget.visualization = cloneVisualizationPayload(request.input.visualization)
        }
        if (request.input?.layout) {
          const nextLayout = widgetLayout(request.input.layout)
          if (nextLayout) widget.layout = nextLayout
        }
        if (request.input?.source) {
          const nextSource = widgetSource(request.input.source)
          if (nextSource) widget.source = nextSource
        }
        widget.time.updated = now()
        dashboard.time.updated = widget.time.updated
        dashboardStateFor(directory).lastUsedDashboardID = dashboard.id
        await scheduleSave()
        return { data: widget }
      }
      case "dashboard.widget.remove": {
        if (!directory) throw new Error("Missing directory for dashboard.widget.remove")
        const dashboard = findDashboard(directory, request.input?.dashboardID)
        if (!dashboard) throw new Error(`Unknown dashboard ${request.input?.dashboardID}`)
        dashboard.widgets = dashboard.widgets.filter((item) => item.id !== request.input?.widgetID)
        dashboard.time.updated = now()
        await scheduleSave()
        return { data: true }
      }
      case "dashboard.widget.reorder": {
        if (!directory) throw new Error("Missing directory for dashboard.widget.reorder")
        const dashboard = findDashboard(directory, request.input?.dashboardID)
        if (!dashboard) throw new Error(`Unknown dashboard ${request.input?.dashboardID}`)
        const order = Array.isArray(request.input?.widgetIDs)
          ? request.input.widgetIDs.filter((item: unknown): item is string => typeof item === "string")
          : []
        if (order.length > 0) {
          const byID = new Map(dashboard.widgets.map((widget) => [widget.id, widget]))
          const ordered: DashboardWidget[] = order
            .map((id: string) => byID.get(id))
            .filter((item: DashboardWidget | undefined): item is DashboardWidget => !!item)
          const seen = new Set(ordered.map((item) => item.id))
          dashboard.widgets = [...ordered, ...dashboard.widgets.filter((item: DashboardWidget) => !seen.has(item.id))]
        }
        dashboard.time.updated = now()
        await scheduleSave()
        return { data: dashboard.widgets }
      }
      case "dashboard.widget.refresh": {
        if (!directory) throw new Error("Missing directory for dashboard.widget.refresh")
        const dashboard = findDashboard(directory, request.input?.dashboardID)
        if (!dashboard) throw new Error(`Unknown dashboard ${request.input?.dashboardID}`)
        const widget = dashboard.widgets.find((item) => item.id === request.input?.widgetID)
        if (!widget) throw new Error(`Unknown widget ${request.input?.widgetID}`)
        const next = refreshWidget(directory, dashboard, widget, dashboardFilters(request.input?.filters))
        dashboard.time.updated = now()
        dashboardStateFor(directory).lastUsedDashboardID = dashboard.id
        await scheduleSave()
        return { data: next }
      }
      case "vcs.get":
        return { data: undefined }
      case "file.list":
        return { data: directory ? await fileList(directory, request.input?.path ?? "") : [] }
      case "file.read":
        return { data: directory ? await fileRead(directory, request.input?.path ?? "") : undefined }
      case "file.status":
        return { data: [] }
      case "find.files":
        return { data: directory ? await findFiles(directory, request.input?.query ?? "") : [] }
      case "worktree.list":
        return { data: directory ? [directory] : [] }
      case "worktree.create":
        return { data: { directory } }
      case "worktree.remove":
      case "worktree.reset":
      case "instance.dispose":
      case "pty.create":
      case "pty.write":
      case "pty.close":
      case "pty.update":
      case "pty.remove":
        return { data: null }
      case "auth.set": {
        const providerID = String(request.input?.providerID ?? "")
        const key = typeof request.input?.auth?.key === "string" ? request.input.auth.key : undefined
        const type = request.input?.auth?.type

        if (!providerID || type !== "api" || !key?.trim()) {
          return { error: { message: "Only API key authentication is supported in the desktop build" } }
        }

        await input.authStore.setApiKey(providerID, key)
        return { data: true }
      }
      case "auth.remove": {
        const providerID = String(request.input?.providerID ?? "")
        if (!providerID) return { error: { message: "Provider ID is required" } }
        await input.authStore.remove(providerID)
        return { data: true }
      }
      case "pty.list":
        return { data: [] }
      default:
        return { error: { message: `Unsupported action: ${request.action}` } }
    }
  }

  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method === "OPTIONS") {
          sendJson(response, 200, {})
          return
        }

        const url = new URL(request.url ?? "/", "http://127.0.0.1")

        if (url.pathname === "/events" && request.method === "GET") {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "access-control-allow-origin": "*",
          })
          eventClients.add(response)
          sendSse(response, { payload: { type: "server.connected", properties: {} } })
          request.on("close", () => {
            eventClients.delete(response)
          })
          return
        }

        if (url.pathname === "/rpc" && request.method === "POST") {
          try {
            const raw = await readBody(request)
            const payload = (raw ? JSON.parse(raw) : {}) as RpcRequest
            const result = await handleRpc(payload)
            sendJson(response, result.error ? 400 : 200, result)
          } catch (error) {
            sendJson(response, 500, {
              error: {
                message: error instanceof Error ? error.message : String(error),
              },
            })
          }
          return
        }

        if (url.pathname === "/api/editor/config" && request.method === "GET") {
          await onlyOfficeHandlers.handleConfig(request, response)
          return
        }

        if (url.pathname === "/api/editor/file-mtime" && request.method === "GET") {
          await onlyOfficeHandlers.handleFileMtime(request, response)
          return
        }

        if (url.pathname === "/api/editor/download" && ["GET", "HEAD"].includes(request.method ?? "GET")) {
          await onlyOfficeHandlers.handleDownload(request, response)
          return
        }

        if (url.pathname === "/api/editor/callback" && request.method === "GET") {
          await onlyOfficeHandlers.handleCallbackGet(request, response)
          return
        }

        if (url.pathname === "/api/editor/callback" && request.method === "POST") {
          await onlyOfficeHandlers.handleCallbackPost(request, response)
          return
        }

        if (url.pathname === "/api/editor/tunnel/status" && request.method === "GET") {
          await onlyOfficeHandlers.handleTunnelStatus(request, response)
          return
        }

        if (url.pathname === "/api/editor/tunnel/reconnect" && request.method === "POST") {
          await onlyOfficeHandlers.handleTunnelReconnect(request, response)
          return
        }

        if (url.pathname === "/api/integrations" && request.method === "GET") {
          sendJson(response, 200, {
            editor: redactEditorIntegrationConfig(state.integrations.editor),
          })
          return
        }

        if (url.pathname === "/api/integrations/editor" && request.method === "PUT") {
          await onlyOfficeHandlers.handleEditorIntegrationUpdate(request, response, updateEditorIntegration)
          return
        }

        if (url.pathname === "/api/integrations/editor/test" && request.method === "POST") {
          await onlyOfficeHandlers.handleEditorIntegrationTest(request, response)
          return
        }

        if (url.pathname === "/health") {
          sendJson(response, 200, { healthy: true })
          return
        }

        sendJson(response, 404, { error: { message: "Not found" } })
      } catch (error) {
        console.error("[desktop-service] request failed:", error)
        if (response.headersSent) {
          response.end()
          return
        }
        sendJson(response, 500, {
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        })
      }
    })()
  })

  const address = await new Promise<{ port: number }>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const value = server.address()
      if (!value || typeof value === "string") {
        reject(new Error("Failed to determine local service address"))
        return
      }
      resolve({ port: value.port })
    })
    server.on("error", reject)
  })

  const serviceUrl = `http://127.0.0.1:${address.port}`

  return {
    url: serviceUrl,
    getPreferences() {
      return state.preferences
    },
    setPreferences(next: Partial<PersistedState["preferences"]>) {
      state.preferences = { ...state.preferences, ...next }
      return scheduleSave()
    },
    async setEditorState(next: ActiveEditorState) {
      activeEditorStates.set(next.sessionID, next)
    },
    async clearEditorState(sessionID: string) {
      activeEditorStates.delete(sessionID)
    },
    bootstrap() {
      return {
        serviceUrl,
        version: "",
        os: mapPlatform(process.platform),
        defaultServerUrl: state.preferences.defaultServerUrl,
        displayBackend: state.preferences.displayBackend,
      }
    },
    async close() {
      for (const run of activeRuns.values()) {
        run.controller.abort()
      }
      activeEditorStates.clear()
      await shutdownEditorTunnelManager()
      await stopEditorIngressServer()
      await scheduleSave()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    },
  }
}
