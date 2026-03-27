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
import { createEditorApiHandlers, wasRecentlySaved } from "./onlyoffice/http-handlers.js"
import { createOnlyOfficeMcpServer } from "./onlyoffice/mcp-server.js"
import type { ActiveEditorState } from "./onlyoffice/types.js"
import { watchFile, stopWatching, stopAllWatchers } from "./onlyoffice/file-watcher.js"
import { missingManagedDesktopConfigKeys, readManagedDesktopConfig } from "./managed-config.js"
import { createVisualizationMcpServer } from "./visualization-mcp.js"
import { createPyodideMcpServer, type SendPyodideRequest } from "./pyodide-mcp.js"

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

/** Strip SDK-internal branding from user-visible error messages. */
const sanitizeErrorMessage = (text: string) => text.replace(/Claude\s*Code/gi, "Rendesk")

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

type AutomationStatus = "active" | "paused"
type AutomationTrigger = "schedule" | "manual" | "catchup"
type AutomationRunStatus = "queued" | "running" | "success" | "failed" | "skipped_lock"

type AutomationTemplateID =
  | "workspace_summary"
  | "todo_cleanup"
  | "dependency_scan"
  | "release_notes"
  | (string & {})

type Automation = {
  id: string
  directory: string
  name: string
  prompt: string
  cron: string
  timezone: string
  status: AutomationStatus
  templateID?: AutomationTemplateID
  time: {
    created: number
    updated: number
  }
  lastRunAt?: number
  nextRunAt: number
}

type AutomationToolCall = {
  id: string
  tool: string
  input: Record<string, unknown>
  status: "running" | "completed" | "failed"
  output?: string
  error?: string
  startedAt: number
  finishedAt?: number
}

type AutomationRun = {
  id: string
  automationID: string
  directory: string
  trigger: AutomationTrigger
  status: AutomationRunStatus
  time: {
    created: number
    started?: number
    finished?: number
  }
  scheduledFor?: number
  summary?: string
  output?: string
  error?: string
  logs: string[]
  toolCalls: AutomationToolCall[]
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
    overlayShortcut: string | null
  }
  integrations: {
    editor: { enabled: boolean }
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
  automations: Record<string, Automation[]>
  automationRuns: Record<string, AutomationRun[]>
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

type AutomationQueueItem = {
  runID: string
  automationID: string
  directory: string
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
  source: "config"
}

const RENVEL_AI_SYSTEM_PROMPT = `You are Renvel AI, the intelligent assistant built into Rendesk — a back-office automation platform by Renvel Co.

Your role is to help users automate and augment repetitive business workflows. You specialize in:
- Analyzing, editing, and generating business documents, spreadsheets, and PDFs
- Writing, reviewing, and debugging code across all major languages and frameworks
- Automating data processing, reporting, and file management tasks
- Providing structured analysis and actionable recommendations

Identity rules:
- You are Renvel AI. When asked your name, identity, or what model you are, always respond that you are Renvel AI.
- You are made by Renvel Co. Never reference any other company as your creator or provider.
- Never disclose the name of your underlying model, architecture, training process, or any third-party AI provider.
- If pressed about technical details of your model, explain that you are a proprietary system developed by Renvel Co.

Communication style:
- Be professional, concise, and action-oriented
- Lead with solutions, not caveats
- Confirm before making destructive file changes
- Maintain context across the conversation

1C:Enterprise OData Integration (Musaffo.uz / Milk House dairy factory):
You have access to a 1C:Enterprise 8.3 database via OData REST API. Use this to answer questions about sales, purchases, inventory, production, cash, employees, counterparties, and any business data.

Connection:
- Base URL: http://82.215.79.35:19969/milkhouse/odata/standard.odata/
- Auth: Basic HTTP (SH-AKHMEDOV:CO3ta3cy)
- Organization: СП ООО MILK HOUSE (ИНН: 303783550)
- Always add $format=json. Always use $top (default 100). Filter Posted eq true for documents, IsFolder eq false for catalogs, DeletionMark eq false.

Query via curl with Basic auth. OData params: $filter, $select, $top, $skip, $orderby, $expand.
Filter syntax: eq, ge, le, and, substringof('text', Field), guid'...', datetime'YYYY-MM-DDTHH:MM:SS'.

Key entities:
- Catalog_Контрагенты: clients/suppliers (Ref_Key, Code, Description, ИНН, НаименованиеПолное, Parent_Key for groups: 003=Buyers, 004=Suppliers)
- Catalog_Номенклатура: products/materials (Ref_Key, Code, Description, Артикул, groups: D-Group=Milk, F-Group=Ingredients, P-Group=Packaging, Готовая продукция=Finished goods)
- Catalog_Склады: warehouses
- Catalog_Организации: our company info
- Catalog_Сотрудники: employees
- Catalog_КассыОрганизаций: cash registers (Головная касса UZS/EUR/RUB/USD)
- Catalog_ДоговорыКонтрагентов: contracts (ВидДоговора: СПоставщиком/СПокупателем)
- Document_РеализацияТоваровУслуг: sales (Number, Date, Контрагент_Key, СуммаДокумента, Склад_Key; line items: Document_РеализацияТоваровУслуг_Товары)
- Document_ПоступлениеТоваровУслуг: purchases (same pattern; line items: _Товары)
- Document_ВыпускПродукции / Document_НеСтандартноеПроизводство: production output
- Document_ПриходныйКассовыйОрдер: cash receipts (ПКО)
- Document_РасходныйКассовыйОрдер: cash expenses (РКО)
- Document_ПлатежноеПоручение: bank payments
- Document_СписаниеТоваров: write-offs
- Document_НачислениеЗарплаты: salary accrual
- AccumulationRegister_ТоварыНаСкладах: inventory movements (Номенклатура_Key, Склад_Key, Количество, RecordType: Receipt/Expense)
- ChartOfAccounts_Хозрасчетный: chart of accounts (Uzbekistan НСБУ)

Key GUIDs: Organization=bb573ed3-e8d5-11ed-9df1-b8975ae92311, Main cash (UZS)=1f6d8b6e-f93c-11ed-a1b2-f4b520313230

Reference fields (_Key suffix) are GUIDs — resolve by querying the catalog. Document numbers prefixed "MS00-". Amounts in document currency (usually UZS). OData has no GROUP BY — aggregate client-side. Line items are separate entities (Document_XXX_Товары).`

const ANTHROPIC_PROVIDER_ID = "anthropic"
const DEFAULT_ANTHROPIC_MODEL_ID = "claude-sonnet-4-6"
const AUTOMATION_SCHEDULER_TICK_MS = 30_000
const AUTOMATION_MIN_INTERVAL_MS = 15 * 60 * 1000
const AUTOMATION_RUN_RETENTION = 200
const ANTHROPIC_MODEL_CATALOG: AnthropicModelDefinition[] = [
  {
    id: "claude-opus-4-6",
    name: "Renvel Ultra",
    family: "renvel-ultra",
    release_date: "2025-10-01",
    limit: {
      context: 200_000,
      output: 8_192,
    },
  },
  {
    id: DEFAULT_ANTHROPIC_MODEL_ID,
    name: "Renvel Medium",
    family: "renvel-medium",
    release_date: "2025-10-15",
    limit: {
      context: 200_000,
      output: 16_384,
    },
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Renvel Fast",
    family: "renvel-fast",
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
      name: "Renvel AI",
      source: anthropicCredential?.source,
      env: [],
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
    overlayShortcut: null,
  },
  integrations: {
    editor: { enabled: true },
  },
  projects: [],
  sessions: [],
  messages: [],
  todos: {},
  permissions: {},
  questions: {},
  dashboards: {},
  automations: {},
  automationRuns: {},
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

type CronField = {
  all: boolean
  values: Set<number>
}

type ParsedCronExpression = {
  raw: string
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
}

type ZonedDateParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: number
}

const ZONED_WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

const timezoneFormatterCache = new Map<string, Intl.DateTimeFormat>()
const parsedCronCache = new Map<string, ParsedCronExpression>()

const cronParseInteger = (value: string, label: string) => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid cron ${label}: "${value}"`)
  }
  return parsed
}

const parseCronField = (input: string, min: number, max: number, label: string, options?: { normalizeSevenToZero?: boolean }) => {
  const normalized = input.trim()
  if (!normalized) {
    throw new Error(`Invalid cron ${label}: missing value`)
  }

  if (normalized === "*") {
    return {
      all: true,
      values: new Set<number>(),
    } satisfies CronField
  }

  const values = new Set<number>()
  const addRange = (start: number, end: number, step: number) => {
    if (step <= 0) throw new Error(`Invalid cron ${label}: step must be positive`)
    if (start < min || end > max || start > end) {
      throw new Error(`Invalid cron ${label}: range ${start}-${end} is out of bounds (${min}-${max})`)
    }
    for (let value = start; value <= end; value += step) {
      values.add(options?.normalizeSevenToZero && value === 7 ? 0 : value)
    }
  }

  for (const token of normalized.split(",")) {
    const part = token.trim()
    if (!part) continue

    const [base, stepRaw] = part.split("/")
    const step = stepRaw ? cronParseInteger(stepRaw, label) : 1

    if (base === "*") {
      addRange(min, max, step)
      continue
    }

    if (base.includes("-")) {
      const [startRaw, endRaw] = base.split("-")
      const start = cronParseInteger(startRaw, label)
      const end = cronParseInteger(endRaw, label)
      addRange(start, end, step)
      continue
    }

    const value = cronParseInteger(base, label)
    if (value < min || value > max) {
      throw new Error(`Invalid cron ${label}: ${value} is out of bounds (${min}-${max})`)
    }
    values.add(options?.normalizeSevenToZero && value === 7 ? 0 : value)
  }

  if (values.size === 0) {
    throw new Error(`Invalid cron ${label}: no values resolved`)
  }

  return {
    all: false,
    values,
  } satisfies CronField
}

const parseCronExpression = (expression: string): ParsedCronExpression => {
  const normalized = expression.trim().replace(/\s+/g, " ")
  const cached = parsedCronCache.get(normalized)
  if (cached) return cached

  const parts = normalized.split(" ")
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression "${expression}". Expected five fields (minute hour day month weekday).`)
  }

  const parsed: ParsedCronExpression = {
    raw: normalized,
    minute: parseCronField(parts[0], 0, 59, "minute"),
    hour: parseCronField(parts[1], 0, 23, "hour"),
    dayOfMonth: parseCronField(parts[2], 1, 31, "day-of-month"),
    month: parseCronField(parts[3], 1, 12, "month"),
    dayOfWeek: parseCronField(parts[4], 0, 7, "day-of-week", { normalizeSevenToZero: true }),
  }
  parsedCronCache.set(normalized, parsed)
  return parsed
}

const cronMatchesField = (field: CronField, value: number) => field.all || field.values.has(value)

const timezoneFormatter = (timezone: string) => {
  const cached = timezoneFormatterCache.get(timezone)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
    hourCycle: "h23",
  })
  timezoneFormatterCache.set(timezone, formatter)
  return formatter
}

const validateTimezone = (timezone: string) => {
  try {
    timezoneFormatter(timezone)
    return true
  } catch {
    return false
  }
}

const zonedDateParts = (timestamp: number, timezone: string): ZonedDateParts => {
  const parts = timezoneFormatter(timezone).formatToParts(new Date(timestamp))
  let year = 0
  let month = 0
  let day = 0
  let hour = 0
  let minute = 0
  let second = 0
  let weekday = 0

  for (const part of parts) {
    if (part.type === "year") year = Number(part.value)
    else if (part.type === "month") month = Number(part.value)
    else if (part.type === "day") day = Number(part.value)
    else if (part.type === "hour") hour = Number(part.value)
    else if (part.type === "minute") minute = Number(part.value)
    else if (part.type === "second") second = Number(part.value)
    else if (part.type === "weekday") weekday = ZONED_WEEKDAY[part.value] ?? 0
  }

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday,
  }
}

const cronMatchesTimestamp = (cron: ParsedCronExpression, timezone: string, timestamp: number) => {
  const zoned = zonedDateParts(timestamp, timezone)
  if (!cronMatchesField(cron.minute, zoned.minute)) return false
  if (!cronMatchesField(cron.hour, zoned.hour)) return false
  if (!cronMatchesField(cron.month, zoned.month)) return false

  const dayOfMonthMatches = cronMatchesField(cron.dayOfMonth, zoned.day)
  const dayOfWeekMatches = cronMatchesField(cron.dayOfWeek, zoned.weekday)

  if (!cron.dayOfMonth.all && !cron.dayOfWeek.all) {
    return dayOfMonthMatches || dayOfWeekMatches
  }
  if (!cron.dayOfMonth.all) return dayOfMonthMatches
  if (!cron.dayOfWeek.all) return dayOfWeekMatches
  return true
}

const nextCronOccurrence = (cron: ParsedCronExpression, timezone: string, afterTimestamp: number) => {
  const start = Math.floor(afterTimestamp / 60_000) * 60_000 + 60_000
  const limit = start + 366 * 24 * 60 * 60_000 * 2
  for (let cursor = start; cursor <= limit; cursor += 60_000) {
    if (cronMatchesTimestamp(cron, timezone, cursor)) {
      return cursor
    }
  }
  return undefined
}

const minimumCronInterval = (cron: ParsedCronExpression, timezone: string, reference: number) => {
  const first = nextCronOccurrence(cron, timezone, reference - 60_000)
  if (first === undefined) {
    throw new Error(`Unable to compute next run for cron "${cron.raw}" in timezone "${timezone}"`)
  }
  const second = nextCronOccurrence(cron, timezone, first)
  if (second === undefined) {
    throw new Error(`Unable to compute recurring schedule for cron "${cron.raw}" in timezone "${timezone}"`)
  }
  return second - first
}

const validateAutomationSchedule = (cron: string, timezone: string, reference = Date.now()) => {
  const trimmedTimezone = timezone.trim()
  if (!trimmedTimezone) {
    throw new Error("Automation timezone is required")
  }
  if (!validateTimezone(trimmedTimezone)) {
    throw new Error(`Invalid automation timezone "${timezone}"`)
  }

  const parsedCron = parseCronExpression(cron)
  const interval = minimumCronInterval(parsedCron, trimmedTimezone, reference)
  if (interval < AUTOMATION_MIN_INTERVAL_MS) {
    throw new Error("Automation schedule must run no more frequently than every 15 minutes")
  }

  const nextRunAt = nextCronOccurrence(parsedCron, trimmedTimezone, reference)
  if (nextRunAt === undefined) {
    throw new Error(`Unable to compute next run for cron "${cron}" in timezone "${timezone}"`)
  }

  return {
    parsedCron,
    timezone: trimmedTimezone,
    nextRunAt,
  }
}

const normalizeWorkspaceRoot = (directory: string) => resolve(directory)
const toComparablePath = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)

const resolvePathCandidate = (workspaceRoot: string, candidate: string) => {
  const trimmed = candidate.trim()
  if (!trimmed || /^[a-z][a-z0-9+\-.]*:\/\//i.test(trimmed)) return
  if (trimmed === "~") return resolve(homedir())
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2))
  if (trimmed.startsWith("~\\")) return resolve(homedir(), trimmed.slice(2))
  return resolve(workspaceRoot, trimmed)
}

const isPathInsideWorkspace = (workspaceRoot: string, candidatePath: string) => {
  const root = toComparablePath(workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`)
  const candidate = toComparablePath(candidatePath)
  return candidate === toComparablePath(workspaceRoot) || candidate.startsWith(root)
}

const commandPathCandidates = (command: string) => {
  const results: string[] = []
  const matcher = /"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s]+)/g
  let match: RegExpExecArray | null = null
  while ((match = matcher.exec(command))) {
    const token = match[1] ?? match[2] ?? match[3] ?? match[4] ?? ""
    if (!token) continue
    if (token.startsWith("-")) continue
    if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(token)) continue
    const looksLikePath =
      token.startsWith("/") ||
      token.startsWith("./") ||
      token.startsWith("../") ||
      token.startsWith("~/") ||
      token.startsWith("~\\") ||
      token.includes("/") ||
      token.includes("\\")
    if (!looksLikePath) continue
    results.push(token)
  }
  return results
}

const collectPathCandidates = (value: unknown, key = "", maxDepth = 4, depth = 0): string[] => {
  if (depth > maxDepth) return []
  if (typeof value === "string") {
    if (key.toLowerCase() === "command") {
      return commandPathCandidates(value)
    }
    const looksLikePathKey = /(path|file|target|output|destination|directory|dir|cwd|root)$/i.test(key)
    const looksLikePathValue =
      value.startsWith("/") ||
      value.startsWith("./") ||
      value.startsWith("../") ||
      value.startsWith("~/") ||
      value.startsWith("~\\") ||
      value.includes("/") ||
      value.includes("\\")
    if (looksLikePathKey || looksLikePathValue) return [value]
    return []
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectPathCandidates(entry, key, maxDepth, depth + 1))
  }
  if (!isPlainObject(value)) return []
  return Object.entries(value).flatMap(([nextKey, entry]) => collectPathCandidates(entry, nextKey, maxDepth, depth + 1))
}

const firstPathOutsideWorkspace = (workspaceDirectory: string, input: Record<string, unknown>, blockedPath?: string) => {
  const workspaceRoot = normalizeWorkspaceRoot(workspaceDirectory)
  const candidates = new Set<string>()

  for (const pattern of permissionPatternsForTool(input, blockedPath)) {
    if (pattern.trim()) candidates.add(pattern.trim())
  }
  for (const candidate of collectPathCandidates(input)) {
    if (candidate.trim()) candidates.add(candidate.trim())
  }
  if (typeof blockedPath === "string" && blockedPath.trim()) {
    candidates.add(blockedPath.trim())
  }

  for (const candidate of candidates) {
    const resolvedPath = resolvePathCandidate(workspaceRoot, candidate)
    if (!resolvedPath) continue
    if (!isPathInsideWorkspace(workspaceRoot, resolvedPath)) {
      return { candidate, resolvedPath, workspaceRoot }
    }
  }

  return undefined
}

const defaultAutomationTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

const coerceAutomationStatus = (value: unknown): AutomationStatus => (value === "paused" ? "paused" : "active")

const coerceAutomationTrigger = (value: unknown): AutomationTrigger => {
  if (value === "manual" || value === "catchup") return value
  return "schedule"
}

const coerceAutomationRunStatus = (value: unknown): AutomationRunStatus => {
  if (value === "queued" || value === "running" || value === "success" || value === "failed" || value === "skipped_lock") {
    return value
  }
  return "failed"
}

const coerceAutomation = (value: unknown, directory: string): Automation | undefined => {
  if (!isPlainObject(value)) return
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : undefined
  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : undefined
  const prompt = typeof value.prompt === "string" && value.prompt.trim() ? value.prompt.trim() : undefined
  if (!id || !name || !prompt) return

  const fallbackTimezone = defaultAutomationTimezone()
  let cron = typeof value.cron === "string" && value.cron.trim() ? value.cron.trim() : "0 * * * *"
  let timezone = typeof value.timezone === "string" && value.timezone.trim() ? value.timezone.trim() : fallbackTimezone
  let nextRunAt = typeof value.nextRunAt === "number" && Number.isFinite(value.nextRunAt) ? value.nextRunAt : undefined
  let status = coerceAutomationStatus(value.status)

  try {
    const validated = validateAutomationSchedule(cron, timezone)
    if (nextRunAt === undefined) nextRunAt = validated.nextRunAt
  } catch {
    cron = "0 * * * *"
    timezone = fallbackTimezone
    const validated = validateAutomationSchedule(cron, timezone)
    nextRunAt = validated.nextRunAt
    status = "paused"
  }

  const createdAt =
    isPlainObject(value.time) && typeof value.time.created === "number" && Number.isFinite(value.time.created)
      ? value.time.created
      : Date.now()
  const updatedAt =
    isPlainObject(value.time) && typeof value.time.updated === "number" && Number.isFinite(value.time.updated)
      ? value.time.updated
      : createdAt

  return {
    id,
    directory: typeof value.directory === "string" && value.directory.trim() ? value.directory : directory,
    name,
    prompt,
    cron,
    timezone,
    status,
    templateID: typeof value.templateID === "string" ? value.templateID : undefined,
    time: {
      created: createdAt,
      updated: updatedAt,
    },
    lastRunAt: typeof value.lastRunAt === "number" && Number.isFinite(value.lastRunAt) ? value.lastRunAt : undefined,
    nextRunAt: nextRunAt!,
  }
}

const coerceAutomationToolCall = (value: unknown): AutomationToolCall | undefined => {
  if (!isPlainObject(value)) return
  const id = typeof value.id === "string" && value.id.trim() ? value.id : undefined
  const tool = typeof value.tool === "string" && value.tool.trim() ? value.tool : undefined
  const startedAt = typeof value.startedAt === "number" && Number.isFinite(value.startedAt) ? value.startedAt : undefined
  if (!id || !tool || startedAt === undefined) return

  const status = (() => {
    if (value.status === "running" || value.status === "completed" || value.status === "failed") return value.status
    return "failed"
  })()

  return {
    id,
    tool,
    input: coerceRecord(value.input),
    status,
    output: typeof value.output === "string" ? value.output : undefined,
    error: typeof value.error === "string" ? value.error : undefined,
    startedAt,
    finishedAt: typeof value.finishedAt === "number" && Number.isFinite(value.finishedAt) ? value.finishedAt : undefined,
  }
}

const coerceAutomationRun = (value: unknown, fallbackAutomationID: string, fallbackDirectory: string): AutomationRun | undefined => {
  if (!isPlainObject(value)) return
  const id = typeof value.id === "string" && value.id.trim() ? value.id : undefined
  if (!id) return

  const createdAt =
    isPlainObject(value.time) && typeof value.time.created === "number" && Number.isFinite(value.time.created)
      ? value.time.created
      : Date.now()

  const logs = Array.isArray(value.logs)
    ? value.logs.filter((entry): entry is string => typeof entry === "string").slice(-500)
    : []

  const toolCalls = Array.isArray(value.toolCalls)
    ? value.toolCalls
        .map((entry) => coerceAutomationToolCall(entry))
        .filter((entry): entry is AutomationToolCall => !!entry)
        .slice(-500)
    : []

  return {
    id,
    automationID:
      typeof value.automationID === "string" && value.automationID.trim() ? value.automationID : fallbackAutomationID,
    directory: typeof value.directory === "string" && value.directory.trim() ? value.directory : fallbackDirectory,
    trigger: coerceAutomationTrigger(value.trigger),
    status: coerceAutomationRunStatus(value.status),
    time: {
      created: createdAt,
      started:
        isPlainObject(value.time) && typeof value.time.started === "number" && Number.isFinite(value.time.started)
          ? value.time.started
          : undefined,
      finished:
        isPlainObject(value.time) && typeof value.time.finished === "number" && Number.isFinite(value.time.finished)
          ? value.time.finished
          : undefined,
    },
    scheduledFor: typeof value.scheduledFor === "number" && Number.isFinite(value.scheduledFor) ? value.scheduledFor : undefined,
    summary: typeof value.summary === "string" ? value.summary : undefined,
    output: typeof value.output === "string" ? value.output : undefined,
    error: typeof value.error === "string" ? value.error : undefined,
    logs,
    toolCalls,
  }
}

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
  packaged?: boolean
  sendEditorToolRequest?: (toolName: string, toolInput: Record<string, unknown>) => Promise<string>
  sendPyodideRequest?: SendPyodideRequest
}) {
  const managedConfig = readManagedDesktopConfig()
  const missingManaged = missingManagedDesktopConfigKeys(managedConfig)
  if (input.packaged && missingManaged.length > 0) {
    throw new Error(
      `Managed infrastructure keys are missing in packaged desktop runtime: ${missingManaged.join(
        ", ",
      )}. Rebuild with internal CI/package-time env injection.`,
    )
  }

  const claudeCliConfigDir = join(input.userDataPath, "claude-cli")
  const legacyProviderAuthPath = join(input.userDataPath, "provider-auth.json")
  await fs.rm(legacyProviderAuthPath, { force: true }).catch(() => undefined)

  const statePath = join(input.userDataPath, "backoffice-state.json")
  const defaults = defaultState()
  const initial = await readJson(statePath, defaults)
  const initialAutomations = (() => {
    if (!isPlainObject(initial.automations)) return {}
    const next: Record<string, Automation[]> = {}
    for (const [directory, value] of Object.entries(initial.automations)) {
      if (!Array.isArray(value)) continue
      const automations = value
        .map((entry) => coerceAutomation(entry, directory))
        .filter((entry): entry is Automation => !!entry)
        .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      next[directory] = automations
    }
    return next
  })()
  const initialAutomationRuns = (() => {
    if (!isPlainObject(initial.automationRuns)) return {}
    const next: Record<string, AutomationRun[]> = {}
    for (const [automationID, value] of Object.entries(initial.automationRuns)) {
      if (!Array.isArray(value)) continue
      const fallbackDirectory =
        Object.values(initialAutomations)
          .flat()
          .find((automation) => automation.id === automationID)?.directory ?? ""
      const runs = value
        .map((entry) => coerceAutomationRun(entry, automationID, fallbackDirectory))
        .filter((entry): entry is AutomationRun => !!entry)
        .sort((a, b) => (b.time.created ?? 0) - (a.time.created ?? 0))
        .slice(0, AUTOMATION_RUN_RETENTION)
      next[automationID] = runs
    }
    return next
  })()
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
      editor: { enabled: true },
    },
    projects: Array.isArray(initial.projects) ? initial.projects : [],
    sessions: Array.isArray(initial.sessions) ? initial.sessions : [],
    messages: Array.isArray(initial.messages) ? initial.messages : [],
    todos: initial.todos ?? {},
    permissions: initial.permissions ?? {},
    questions: initial.questions ?? {},
    dashboards: initial.dashboards ?? {},
    automations: initialAutomations,
    automationRuns: initialAutomationRuns,
    analyticsEvents: Array.isArray(initial.analyticsEvents) ? initial.analyticsEvents : [],
  }

  const enforceManagedConfigState = () => {
    let changed = false

    if (typeof state.config.model !== "string" || !state.config.model.startsWith(`${ANTHROPIC_PROVIDER_ID}/`)) {
      state.config.model = `${ANTHROPIC_PROVIDER_ID}/${DEFAULT_ANTHROPIC_MODEL_ID}`
      changed = true
    }

    if (Object.keys(state.config.provider ?? {}).length > 0) {
      state.config.provider = {}
      changed = true
    }

    if ((state.config.disabled_providers ?? []).length > 0) {
      state.config.disabled_providers = []
      changed = true
    }

    return changed
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

  if (
    migrateLegacyMessageIDs() ||
    migrateVisualizationToolParts() ||
    migrateVisualizationToolTitles() ||
    enforceManagedConfigState()
  ) {
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
  const pyodideMcpServer = input.sendPyodideRequest
    ? createPyodideMcpServer(input.sendPyodideRequest, input.sendEditorToolRequest)
    : undefined
  const automationQueue: AutomationQueueItem[] = []
  const queuedAutomationIDs = new Set<string>()
  const activeAutomationLocks = new Set<string>()
  const activeAutomationControllers = new Map<string, AbortController>()
  let activeGlobalAutomationRunID: string | undefined
  let automationProcessorRunning = false
  let automationSchedulerInterval: ReturnType<typeof setInterval> | undefined
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
    const key = managedConfig.anthropicApiKey.trim()
    if (!key) return null

    return {
      key,
      source: "config",
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

    throw new Error(`Rendesk agent executable could not be found. Checked: ${candidates.join(", ")}`)
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

  const automationStateFor = (directory: string) => {
    const existing = state.automations[directory]
    if (existing) return existing
    const created: Automation[] = []
    state.automations[directory] = created
    return created
  }

  const automationRunsFor = (automationID: string) => {
    const existing = state.automationRuns[automationID]
    if (existing) return existing
    const created: AutomationRun[] = []
    state.automationRuns[automationID] = created
    return created
  }

  const trimAutomationRuns = (automationID: string) => {
    const runs = automationRunsFor(automationID)
    if (runs.length <= AUTOMATION_RUN_RETENTION) return
    runs.splice(AUTOMATION_RUN_RETENTION)
  }

  const listAutomations = (directory: string, options?: { search?: string; status?: AutomationStatus | "all" }) => {
    const search = options?.search?.trim().toLowerCase()
    return automationStateFor(directory)
      .filter((automation) => {
        if (!search) return true
        return (
          automation.name.toLowerCase().includes(search) ||
          automation.prompt.toLowerCase().includes(search) ||
          automation.cron.toLowerCase().includes(search)
        )
      })
      .filter((automation) => {
        if (!options?.status || options.status === "all") return true
        return automation.status === options.status
      })
      .slice()
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
  }

  const findAutomation = (directory: string, automationID?: string) => {
    if (!automationID) return undefined
    return automationStateFor(directory).find((automation) => automation.id === automationID)
  }

  const findAutomationByID = (automationID: string) => {
    for (const [directory, automations] of Object.entries(state.automations)) {
      const automation = automations.find((entry) => entry.id === automationID)
      if (automation) return { directory, automation }
    }
    return undefined
  }

  const findAutomationRun = (automationID: string, runID?: string) => {
    if (!runID) return undefined
    return automationRunsFor(automationID).find((run) => run.id === runID)
  }

  const createAutomationRecord = (directory: string, input: {
    name: string
    prompt: string
    cron: string
    timezone?: string
    status?: AutomationStatus
    templateID?: string
  }) => {
    const name = input.name.trim()
    const prompt = input.prompt.trim()
    if (!name) throw new Error("Automation name is required")
    if (!prompt) throw new Error("Automation prompt is required")

    const timezone = input.timezone?.trim() || defaultAutomationTimezone()
    const validated = validateAutomationSchedule(input.cron, timezone, now())
    const createdAt = now()
    const automation: Automation = {
      id: `automation_${randomUUID()}`,
      directory,
      name,
      prompt,
      cron: input.cron.trim(),
      timezone: validated.timezone,
      status: input.status === "paused" ? "paused" : "active",
      templateID: input.templateID,
      time: {
        created: createdAt,
        updated: createdAt,
      },
      lastRunAt: undefined,
      nextRunAt: validated.nextRunAt,
    }
    automationStateFor(directory).unshift(automation)
    return automation
  }

  const updateAutomationRecord = (automation: Automation, patch: {
    name?: string
    prompt?: string
    cron?: string
    timezone?: string
    status?: AutomationStatus
    templateID?: string | null
  }) => {
    const nextName = patch.name === undefined ? automation.name : patch.name.trim()
    const nextPrompt = patch.prompt === undefined ? automation.prompt : patch.prompt.trim()
    if (!nextName) throw new Error("Automation name is required")
    if (!nextPrompt) throw new Error("Automation prompt is required")

    const nextCron = patch.cron === undefined ? automation.cron : patch.cron.trim()
    const nextTimezone = patch.timezone === undefined ? automation.timezone : patch.timezone.trim() || defaultAutomationTimezone()
    const scheduleChanged = nextCron !== automation.cron || nextTimezone !== automation.timezone
    const statusChanged = patch.status !== undefined && patch.status !== automation.status

    automation.name = nextName
    automation.prompt = nextPrompt
    automation.cron = nextCron
    automation.timezone = nextTimezone
    if (patch.status) {
      automation.status = patch.status
    }
    if (patch.templateID !== undefined) {
      automation.templateID = patch.templateID ?? undefined
    }

    if (scheduleChanged || (statusChanged && automation.status === "active")) {
      const validated = validateAutomationSchedule(automation.cron, automation.timezone, now())
      if (automation.status === "active") {
        automation.nextRunAt = validated.nextRunAt
      }
    }
    automation.time.updated = now()
    return automation
  }

  const appendAutomationRunLog = (run: AutomationRun, line: string) => {
    const cleaned = line.trim()
    if (!cleaned) return
    run.logs.push(cleaned)
    if (run.logs.length > 500) {
      run.logs.splice(0, run.logs.length - 500)
    }
  }

  const createQueuedAutomationRun = (automation: Automation, trigger: AutomationTrigger, scheduledFor?: number) => {
    const createdAt = now()
    const run: AutomationRun = {
      id: `automation_run_${randomUUID()}`,
      automationID: automation.id,
      directory: automation.directory,
      trigger,
      status: "queued",
      time: {
        created: createdAt,
      },
      scheduledFor,
      logs: [],
      toolCalls: [],
    }
    const runs = automationRunsFor(automation.id)
    runs.unshift(run)
    trimAutomationRuns(automation.id)
    return run
  }

  const createSkippedLockRun = (automation: Automation, trigger: AutomationTrigger, scheduledFor?: number) => {
    const createdAt = now()
    const run: AutomationRun = {
      id: `automation_run_${randomUUID()}`,
      automationID: automation.id,
      directory: automation.directory,
      trigger,
      status: "skipped_lock",
      time: {
        created: createdAt,
        started: createdAt,
        finished: createdAt,
      },
      scheduledFor,
      summary: "Skipped because another run for this automation is active",
      logs: ["Skipped due to active automation lock"],
      toolCalls: [],
    }
    const runs = automationRunsFor(automation.id)
    runs.unshift(run)
    trimAutomationRuns(automation.id)
    return run
  }

  const emitAutomationUpdated = (automation: Automation, reason?: string) => {
    emit(automation.directory, {
      type: "automation.updated",
      properties: {
        automation,
        ...(reason ? { reason } : {}),
      },
    })
  }

  const markAutomationNextRun = (automation: Automation, reference = now()) => {
    const validated = validateAutomationSchedule(automation.cron, automation.timezone, reference)
    automation.nextRunAt = validated.nextRunAt
    automation.time.updated = now()
  }

  const emitAutomationRunStarted = (automation: Automation, run: AutomationRun) => {
    emit(automation.directory, {
      type: "automation.run.started",
      properties: {
        automation,
        run,
      },
    })
  }

  const emitAutomationRunFinished = (automation: Automation, run: AutomationRun) => {
    emit(automation.directory, {
      type: "automation.run.finished",
      properties: {
        automation,
        run,
      },
    })
  }

  const executeAutomationRun = async (automation: Automation, run: AutomationRun) => {
    const anthropicCredential = await resolveAnthropicCredential()
    if (!anthropicCredential) {
      throw new Error(
        "Renvel AI is unavailable because managed infrastructure credentials are missing. Contact your administrator.",
      )
    }

    const sdk = await import("@anthropic-ai/claude-agent-sdk")
    const pathToClaudeCodeExecutable = await resolveClaudeCodeExecutablePath()
    const claudeRuntimeEnv: Record<string, string | undefined> = {
      ...process.env,
      ANTHROPIC_API_KEY: anthropicCredential.key,
      CLAUDE_CONFIG_DIR: claudeCliConfigDir,
    }
    delete claudeRuntimeEnv.ANTHROPIC_AUTH_TOKEN
    delete claudeRuntimeEnv.CLAUDE_CODE_OAUTH_TOKEN
    delete claudeRuntimeEnv.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
    delete claudeRuntimeEnv.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
    const spawnClaudeCodeProcess: AgentOptions["spawnClaudeCodeProcess"] = ({ args, cwd, env, signal }) => {
      const { CLAUDECODE: _drop, ...cleanEnv } = env as Record<string, string | undefined>
      console.log("[rendesk:sdk] Spawning CLI:", process.execPath, args.slice(0, 3).join(" "), "...")
      console.log("[rendesk:sdk] ANTHROPIC_API_KEY present:", !!(cleanEnv as Record<string, string | undefined>).ANTHROPIC_API_KEY)
      console.log("[rendesk:sdk] ANTHROPIC_AUTH_TOKEN present:", !!(cleanEnv as Record<string, string | undefined>).ANTHROPIC_AUTH_TOKEN)
      console.log("[rendesk:sdk] CLAUDE_CONFIG_DIR:", (cleanEnv as Record<string, string | undefined>).CLAUDE_CONFIG_DIR)
      const child = spawn(process.execPath, args, {
        cwd,
        env: {
          ...cleanEnv,
          ELECTRON_RUN_AS_NODE: "1",
        },
        signal,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        console.error("[rendesk:sdk:stderr]", chunk.toString())
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

    const getOrCreateToolCall = (toolUseID: string, toolName: string, toolInput: Record<string, unknown>) => {
      const existing = run.toolCalls.find((entry) => entry.id === toolUseID)
      if (existing) return existing
      const created: AutomationToolCall = {
        id: toolUseID,
        tool: toolName,
        input: toolInput,
        status: "running",
        startedAt: now(),
      }
      run.toolCalls.push(created)
      appendAutomationRunLog(run, `Tool started: ${normalizeToolName(toolName)}`)
      void scheduleSave()
      return created
    }

    const completeToolCall = (toolUseID: string, update: Partial<AutomationToolCall>) => {
      const existing = run.toolCalls.find((entry) => entry.id === toolUseID)
      if (!existing) return
      if (update.status) existing.status = update.status
      if (update.output !== undefined) existing.output = update.output
      if (update.error !== undefined) existing.error = update.error
      existing.finishedAt = now()
      if (existing.status === "completed") {
        appendAutomationRunLog(run, `Tool completed: ${normalizeToolName(existing.tool)}`)
      } else if (existing.status === "failed") {
        appendAutomationRunLog(run, `Tool failed: ${normalizeToolName(existing.tool)}`)
      }
      void scheduleSave()
    }

    const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
      const normalizedInput = coerceRecord(toolInput)
      getOrCreateToolCall(options.toolUseID, toolName, normalizedInput)

      const violation = firstPathOutsideWorkspace(automation.directory, normalizedInput, options.blockedPath)
      if (violation) {
        const message = `Denied tool ${toolName}: path "${violation.candidate}" resolves outside workspace`
        appendAutomationRunLog(run, message)
        completeToolCall(options.toolUseID, {
          status: "failed",
          error: message,
        })
        return {
          behavior: "deny",
          message,
          interrupt: true,
          toolUseID: options.toolUseID,
        } satisfies PermissionResult
      }

      return {
        behavior: "allow",
        updatedInput: normalizedInput,
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
              getOrCreateToolCall(toolUseID, inputRecord.tool_name, coerceRecord(inputRecord.tool_input))
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
              completeToolCall(toolUseID, {
                status: "completed",
                output: serializeToolOutput(resultInput.tool_response),
              })
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
              completeToolCall(toolUseID, {
                status: "failed",
                error: failureInput.error,
              })
              return { continue: true }
            },
          ],
        },
      ],
    }

    const modelID = (() => {
      if (typeof state.config.model !== "string") return DEFAULT_ANTHROPIC_MODEL_ID
      const [, configuredModelID] = state.config.model.split("/")
      return configuredModelID || DEFAULT_ANTHROPIC_MODEL_ID
    })()

    const controller = new AbortController()
    activeAutomationControllers.set(run.id, controller)
    const visualizationMcpServer = createVisualizationMcpServer(() => buildAnalyticsSnapshot(automation.directory))

    const iterator = sdk.query({
      prompt: automation.prompt,
      options: {
        abortController: controller,
        canUseTool,
        cwd: automation.directory,
        env: claudeRuntimeEnv,
        hooks,
        includePartialMessages: true,
        mcpServers: {
          visualization: visualizationMcpServer,
        },
        model: modelID,
        pathToClaudeCodeExecutable,
        permissionMode: "default",
        settingSources: [],
        spawnClaudeCodeProcess,
        systemPrompt: `${RENVEL_AI_SYSTEM_PROMPT}

Automation execution mode:
- You are running inside a scheduled desktop automation.
- Complete the task end-to-end without asking the user follow-up questions.
- Keep output concise and actionable.
- Stay strictly within the workspace directory for any file or system operation.`,
      },
    })

    let result: SDKResultMessage | undefined
    let output = ""
    let hasStreamDelta = false

    try {
      for await (const item of iterator) {
        const streamEvent = extractStreamEvent(item)
        if (streamEvent?.textDelta) {
          hasStreamDelta = true
          output += streamEvent.textDelta
          run.output = output
          void scheduleSave()
          continue
        }

        if (item.type === "assistant" && !hasStreamDelta) {
          const text = extractAssistantText(item.message)
          if (text) {
            output += text
            run.output = output
            void scheduleSave()
          }
          continue
        }

        if (item.type === "system" && item.subtype === "local_command_output" && item.content) {
          appendAutomationRunLog(run, item.content)
          continue
        }

        if (item.type === "result") {
          result = item
        }
      }
    } finally {
      activeAutomationControllers.delete(run.id)
      try {
        iterator.close()
      } catch {
        // Ignore cleanup errors during shutdown.
      }
    }

    if (result?.subtype !== "success") {
      const errorMessage = sanitizeErrorMessage(result?.errors?.join("\n") || "Automation execution failed")
      return {
        status: "failed" as const,
        output,
        error: errorMessage,
      }
    }

    return {
      status: "success" as const,
      output,
      error: undefined,
    }
  }

  const finalizeAutomationRun = async (automation: Automation, run: AutomationRun, result: {
    status: "success" | "failed"
    output: string
    error?: string
  }) => {
    run.status = result.status
    run.time.finished = now()
    run.output = result.output
    run.error = result.error
    run.summary =
      summaryFromText(result.status === "failed" ? result.error || result.output : result.output) ||
      (result.status === "failed" ? "Automation run failed" : "Automation run completed")

    automation.lastRunAt = run.time.started ?? run.time.finished
    if (automation.status === "active") {
      markAutomationNextRun(automation, now())
    }
    automation.time.updated = now()

    trimAutomationRuns(automation.id)
    await scheduleSave()
    emitAutomationRunFinished(automation, run)
    emitAutomationUpdated(automation, "run_finished")
  }

  const processAutomationQueue = async () => {
    if (automationProcessorRunning) return
    automationProcessorRunning = true

    try {
      while (automationQueue.length > 0) {
        if (activeGlobalAutomationRunID) return
        const next = automationQueue.shift()
        if (!next) continue
        queuedAutomationIDs.delete(next.automationID)

        const located = findAutomationByID(next.automationID)
        if (!located) continue
        const automation = located.automation
        const run = findAutomationRun(next.automationID, next.runID)
        if (!run) continue

        if (activeAutomationLocks.has(automation.id)) {
          run.status = "skipped_lock"
          const completedAt = now()
          run.time.started = run.time.started ?? completedAt
          run.time.finished = completedAt
          run.summary = "Skipped because another run for this automation is active"
          appendAutomationRunLog(run, "Skipped due to active automation lock")
          await scheduleSave()
          emitAutomationRunFinished(automation, run)
          emitAutomationUpdated(automation, "run_skipped_lock")
          continue
        }

        activeAutomationLocks.add(automation.id)
        activeGlobalAutomationRunID = run.id
        run.status = "running"
        run.time.started = now()
        appendAutomationRunLog(run, `Run started (${run.trigger})`)
        await scheduleSave()
        emitAutomationRunStarted(automation, run)

        try {
          const result = await executeAutomationRun(automation, run)
          await finalizeAutomationRun(automation, run, result)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          appendAutomationRunLog(run, message)
          await finalizeAutomationRun(automation, run, {
            status: "failed",
            output: run.output ?? "",
            error: message,
          })
        } finally {
          activeAutomationLocks.delete(automation.id)
          if (activeGlobalAutomationRunID === run.id) {
            activeGlobalAutomationRunID = undefined
          }
        }
      }
    } finally {
      automationProcessorRunning = false
    }
  }

  const enqueueAutomationRun = async (automation: Automation, trigger: AutomationTrigger, scheduledFor?: number) => {
    if (activeAutomationLocks.has(automation.id) || queuedAutomationIDs.has(automation.id)) {
      const skipped = createSkippedLockRun(automation, trigger, scheduledFor)
      await scheduleSave()
      emitAutomationRunFinished(automation, skipped)
      emitAutomationUpdated(automation, "run_skipped_lock")
      return skipped
    }

    const run = createQueuedAutomationRun(automation, trigger, scheduledFor)
    queuedAutomationIDs.add(automation.id)
    if (trigger !== "manual" && automation.status === "active") {
      markAutomationNextRun(automation, now())
    }
    automation.time.updated = now()
    await scheduleSave()
    emitAutomationUpdated(automation, "run_queued")
    void processAutomationQueue()
    return run
  }

  const schedulerTick = async (trigger: AutomationTrigger = "schedule") => {
    const due: Automation[] = []
    const timestamp = now()
    for (const automations of Object.values(state.automations)) {
      for (const automation of automations) {
        if (automation.status !== "active") continue
        if (automation.nextRunAt > timestamp) continue
        due.push(automation)
      }
    }

    for (const automation of due) {
      await enqueueAutomationRun(automation, trigger, automation.nextRunAt)
    }
  }

  const startupCatchupOnce = async () => {
    await schedulerTick("catchup")
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

  // Resolve resources path: in packaged app use process.resourcesPath, in dev use relative path.
  const resourcesPath = input.packaged
    ? (process.resourcesPath ?? join(dirname(fileURLToPath(import.meta.url)), "..", ".."))
    : join(dirname(fileURLToPath(import.meta.url)), "..", "..", "resources")

  const editorHandlers = createEditorApiHandlers({
    getResourcesPath: () => join(resourcesPath, "editors"),
    getConverterPath: () => join(resourcesPath, "converter"),
    getCachePath: () => join(input.userDataPath, "editor-cache"),
    getFontDataPath: () => join(resourcesPath, "fonts"),
    getFontSelectionPath: () => join(resourcesPath, "fonts", "font_selection.bin"),
  })

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
      throw new Error(
        "Renvel AI is unavailable because managed infrastructure credentials are missing. Contact your administrator.",
      )
    }

    const sdk = await import("@anthropic-ai/claude-agent-sdk")
    const pathToClaudeCodeExecutable = await resolveClaudeCodeExecutablePath()
    const claudeRuntimeEnv: Record<string, string | undefined> = {
      ...process.env,
      ANTHROPIC_API_KEY: anthropicCredential.key,
      CLAUDE_CONFIG_DIR: claudeCliConfigDir,
    }
    delete claudeRuntimeEnv.ANTHROPIC_AUTH_TOKEN
    delete claudeRuntimeEnv.CLAUDE_CODE_OAUTH_TOKEN
    delete claudeRuntimeEnv.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
    delete claudeRuntimeEnv.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
    const spawnClaudeCodeProcess: AgentOptions["spawnClaudeCodeProcess"] = ({ args, cwd, env, signal }) => {
      const { CLAUDECODE: _drop, ...cleanEnv } = env as Record<string, string | undefined>
      console.log("[rendesk:sdk] Spawning CLI:", process.execPath, args.slice(0, 3).join(" "), "...")
      console.log("[rendesk:sdk] ANTHROPIC_API_KEY present:", !!(cleanEnv as Record<string, string | undefined>).ANTHROPIC_API_KEY)
      console.log("[rendesk:sdk] ANTHROPIC_AUTH_TOKEN present:", !!(cleanEnv as Record<string, string | undefined>).ANTHROPIC_AUTH_TOKEN)
      console.log("[rendesk:sdk] CLAUDE_CONFIG_DIR:", (cleanEnv as Record<string, string | undefined>).CLAUDE_CONFIG_DIR)
      const child = spawn(process.execPath, args, {
        cwd,
        env: {
          ...cleanEnv,
          ELECTRON_RUN_AS_NODE: "1",
        },
        signal,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        console.error("[rendesk:sdk:stderr]", chunk.toString())
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
    const includePyodideMcp = Boolean(editorState && pyodideMcpServer)
    const mcpServers = {
      ...(includeEditorMcp && editorMcpServer ? { editor: editorMcpServer } : {}),
      ...(includePyodideMcp && pyodideMcpServer ? { pyodide: pyodideMcpServer } : {}),
      visualization: visualizationMcpServer,
    }

    let systemPrompt = RENVEL_AI_SYSTEM_PROMPT
    if (includePyodideMcp) {
      systemPrompt += `\n\nPython execution:
- You have access to a local Python environment (Pyodide/WebAssembly) with pandas, numpy, scipy, and matplotlib.
- Use python_load_spreadsheet to load data from the open spreadsheet into a pandas DataFrame, then use execute_python to analyze it.
- Matplotlib figures are automatically captured and displayed inline.
- Prefer python_load_spreadsheet + execute_python for data analysis tasks over manually reading cells.`
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
        systemPrompt,
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
              message: sanitizeErrorMessage(result.errors.join("\n")) || "Renvel AI agent execution failed.",
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
      const rawMessage = error instanceof Error ? error.message : String(error)
      const errorMessage = sanitizeErrorMessage(rawMessage)
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
      case "global.config.update": {
        const patch = isPlainObject(request.input) ? { ...request.input } : {}
        delete patch.provider
        delete patch.disabled_providers
        delete patch.enabled_providers

        if (typeof patch.model === "string" && !patch.model.startsWith(`${ANTHROPIC_PROVIDER_ID}/`)) {
          patch.model = `${ANTHROPIC_PROVIDER_ID}/${DEFAULT_ANTHROPIC_MODEL_ID}`
        }

        state.config = { ...state.config, ...patch }
        await scheduleSave()
        return { data: state.config }
      }
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
        return { data: {} }
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
        const rootsOnly = request.input?.roots === true
        const start = typeof request.input?.start === "number" ? request.input.start : undefined
        const search = typeof request.input?.search === "string" ? request.input.search.trim().toLowerCase() : ""
        const all = state.sessions
          .filter((session) => session.directory === directory && !session.time.archived)
          .filter((session) => !rootsOnly || !session.parentID)
          .filter((session) => {
            if (start === undefined) return true
            const updatedAt = session.time.updated ?? session.time.created
            return updatedAt >= start
          })
          .filter((session) => {
            if (!search) return true
            return (session.title ?? "").toLowerCase().includes(search)
          })
          .sort((a, b) => {
            const aUpdated = a.time.updated ?? a.time.created
            const bUpdated = b.time.updated ?? b.time.created
            if (aUpdated !== bUpdated) return bUpdated - aUpdated
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
          })
        const parsedLimit = Number(request.input?.limit ?? all.length)
        const limit = Number.isFinite(parsedLimit) ? Math.max(0, Math.floor(parsedLimit)) : all.length
        const data = all.slice(0, limit)
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
      case "automation.list": {
        if (!directory) return { data: { automations: [] as Automation[] } }
        const search = typeof request.input?.search === "string" ? request.input.search : undefined
        const status =
          request.input?.status === "active" || request.input?.status === "paused" || request.input?.status === "all"
            ? request.input.status
            : undefined
        const automations = listAutomations(directory, {
          search,
          status,
        })
        return { data: { automations } }
      }
      case "automation.get": {
        if (!directory) return { data: undefined }
        const automationID = String(request.input?.automationID ?? "")
        return { data: findAutomation(directory, automationID) }
      }
      case "automation.create": {
        if (!directory) throw new Error("Missing directory for automation.create")
        try {
          const automation = createAutomationRecord(directory, {
            name: String(request.input?.name ?? ""),
            prompt: String(request.input?.prompt ?? ""),
            cron: String(request.input?.cron ?? ""),
            timezone: typeof request.input?.timezone === "string" ? request.input.timezone : defaultAutomationTimezone(),
            status: request.input?.status === "paused" ? "paused" : "active",
            templateID: typeof request.input?.templateID === "string" ? request.input.templateID : undefined,
          })
          await scheduleSave()
          emitAutomationUpdated(automation, "created")
          return { data: automation }
        } catch (error) {
          return {
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          }
        }
      }
      case "automation.update": {
        if (!directory) throw new Error("Missing directory for automation.update")
        const automationID = String(request.input?.automationID ?? "")
        const automation = findAutomation(directory, automationID)
        if (!automation) throw new Error(`Unknown automation ${automationID}`)
        try {
          updateAutomationRecord(automation, {
            name: typeof request.input?.name === "string" ? request.input.name : undefined,
            prompt: typeof request.input?.prompt === "string" ? request.input.prompt : undefined,
            cron: typeof request.input?.cron === "string" ? request.input.cron : undefined,
            timezone: typeof request.input?.timezone === "string" ? request.input.timezone : undefined,
            status: request.input?.status === "paused" ? "paused" : request.input?.status === "active" ? "active" : undefined,
            templateID:
              typeof request.input?.templateID === "string" ? request.input.templateID : request.input?.templateID === null ? null : undefined,
          })

          await scheduleSave()
          emitAutomationUpdated(automation, "updated")
          return { data: automation }
        } catch (error) {
          return {
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          }
        }
      }
      case "automation.delete": {
        if (!directory) throw new Error("Missing directory for automation.delete")
        const automationID = String(request.input?.automationID ?? "")
        const automations = automationStateFor(directory)
        const index = automations.findIndex((automation) => automation.id === automationID)
        if (index === -1) return { data: false }
        if (activeAutomationLocks.has(automationID)) {
          throw new Error("Cannot delete automation while a run is active")
        }

        automations.splice(index, 1)
        delete state.automationRuns[automationID]
        for (let index = automationQueue.length - 1; index >= 0; index -= 1) {
          if (automationQueue[index].automationID === automationID) {
            automationQueue.splice(index, 1)
          }
        }
        queuedAutomationIDs.delete(automationID)

        await scheduleSave()
        emit(directory, {
          type: "automation.updated",
          properties: {
            automationID,
            deleted: true,
          },
        })
        return { data: true }
      }
      case "automation.run": {
        if (!directory) throw new Error("Missing directory for automation.run")
        const automationID = String(request.input?.automationID ?? "")
        const automation = findAutomation(directory, automationID)
        if (!automation) throw new Error(`Unknown automation ${automationID}`)
        const run = await enqueueAutomationRun(automation, "manual")
        return { data: run }
      }
      case "automation.run.list": {
        if (!directory) return { data: [] as AutomationRun[] }
        const automationID = String(request.input?.automationID ?? "")
        const automation = findAutomation(directory, automationID)
        if (!automation) return { data: [] as AutomationRun[] }
        const status =
          request.input?.status === "queued" ||
          request.input?.status === "running" ||
          request.input?.status === "success" ||
          request.input?.status === "failed" ||
          request.input?.status === "skipped_lock"
            ? request.input.status
            : undefined
        const parsedLimit = Number(request.input?.limit ?? AUTOMATION_RUN_RETENTION)
        const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(AUTOMATION_RUN_RETENTION, Math.floor(parsedLimit))) : 50
        const runs = automationRunsFor(automationID)
          .filter((run) => (status ? run.status === status : true))
          .slice(0, limit)
        return { data: runs }
      }
      case "automation.run.get": {
        if (!directory) return { data: undefined }
        const automationID = String(request.input?.automationID ?? "")
        const runID = String(request.input?.runID ?? "")
        const automation = findAutomation(directory, automationID)
        if (automation) {
          return { data: findAutomationRun(automation.id, runID) }
        }
        if (!runID) return { data: undefined }
        const scopedAutomationIDs = new Set(automationStateFor(directory).map((entry) => entry.id))
        for (const [nextAutomationID, runs] of Object.entries(state.automationRuns)) {
          if (!scopedAutomationIDs.has(nextAutomationID)) continue
          const found = runs.find((run) => run.id === runID)
          if (found) return { data: found }
        }
        return { data: undefined }
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
        return {
          error: {
            message: "Provider authentication is managed by infrastructure in this desktop build.",
          },
        }
      }
      case "auth.remove": {
        return {
          error: {
            message: "Provider authentication is managed by infrastructure in this desktop build.",
          },
        }
      }
      case "pty.list":
        return { data: [] }
      default:
        return { error: { message: `Unsupported action: ${request.action}` } }
    }
  }

  await startupCatchupOnce().catch((error) => {
    console.error("[desktop-service] automation startup catch-up failed:", error)
  })
  automationSchedulerInterval = setInterval(() => {
    void schedulerTick("schedule").catch((error) => {
      console.error("[desktop-service] automation scheduler tick failed:", error)
    })
  }, AUTOMATION_SCHEDULER_TICK_MS)

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

        if (url.pathname === "/api/editor/open" && request.method === "GET") {
          await editorHandlers.handleEditorOpen(request, response)
          return
        }

        if (url.pathname === "/api/editor/convert" && request.method === "GET") {
          await editorHandlers.handleEditorConvert(request, response)
          return
        }

        if (url.pathname === "/api/editor/save" && request.method === "POST") {
          await editorHandlers.handleEditorSave(request, response)
          return
        }

        if (url.pathname === "/api/editor/file-mtime" && request.method === "GET") {
          await editorHandlers.handleFileMtime(request, response)
          return
        }

        if (url.pathname.startsWith("/api/editor/fonts/")) {
          await editorHandlers.handleFonts(request, response)
          return
        }

        if (url.pathname.startsWith("/api/editor/static/")) {
          await editorHandlers.handleStatic(request, response)
          return
        }

        // Root-level static routes: the SDK uses absolute paths like /sdkjs/..., /web-apps/...
        if (url.pathname.startsWith("/sdkjs/") || url.pathname.startsWith("/web-apps/")) {
          request.url = "/api/editor/static" + url.pathname + (url.search || "")
          await editorHandlers.handleStatic(request, response)
          return
        }

        // Serve Pyodide assets from resources/pyodide/
        if (url.pathname.startsWith("/pyodide/")) {
          const { existsSync, statSync, createReadStream } = await import("node:fs")
          const restPath = url.pathname.replace(/^\/pyodide\//, "")
          if (!restPath) {
            response.writeHead(400)
            response.end("Path required")
            return
          }
          const pyodidePath = join(resourcesPath, "pyodide")
          const filePath = join(pyodidePath, restPath)
          if (!filePath.startsWith(pyodidePath)) {
            response.writeHead(403)
            response.end("Forbidden")
            return
          }
          if (!existsSync(filePath) || !statSync(filePath).isFile()) {
            response.writeHead(404)
            response.end("Not found")
            return
          }
          const ext = filePath.split(".").pop() ?? ""
          const mimeTypes: Record<string, string> = {
            js: "application/javascript",
            wasm: "application/wasm",
            json: "application/json",
            tar: "application/x-tar",
            zip: "application/zip",
            whl: "application/zip",
            data: "application/octet-stream",
          }
          const contentType = mimeTypes[ext] ?? "application/octet-stream"
          const stat = statSync(filePath)
          response.writeHead(200, {
            "content-type": contentType,
            "content-length": stat.size,
            "access-control-allow-origin": "*",
            "cache-control": "public, max-age=86400",
          })
          createReadStream(filePath).pipe(response)
          return
        }

        if (url.pathname === "/api/integrations" && request.method === "GET") {
          sendJson(response, 200, {
            editor: { enabled: state.integrations.editor.enabled },
          })
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
      watchFile(next.filePath, (filePath, mtimeMs) => {
        // Skip notification if this change was caused by our own save
        if (wasRecentlySaved(filePath)) return
        emit(undefined, {
          type: "editor:file-changed",
          properties: { filePath, mtimeMs },
        })
      })
    },
    async clearEditorState(sessionID: string) {
      const existing = activeEditorStates.get(sessionID)
      if (existing) {
        stopWatching(existing.filePath)
      }
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
      for (const controller of activeAutomationControllers.values()) {
        controller.abort()
      }
      activeAutomationControllers.clear()
      if (automationSchedulerInterval) {
        clearInterval(automationSchedulerInterval)
        automationSchedulerInterval = undefined
      }
      activeEditorStates.clear()
      stopAllWatchers()
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
