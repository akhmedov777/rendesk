import { describe, expect, test } from "bun:test"
import type { AnalyticsSnapshot } from "./analytics"
import { queryWorkspaceAnalytics } from "./analytics"

const FIXED_NOW = Date.UTC(2026, 0, 31, 12, 0, 0)

function withMockedNow<T>(fn: () => T): T {
  const originalNow = Date.now
  Date.now = () => FIXED_NOW
  try {
    return fn()
  } finally {
    Date.now = originalNow
  }
}

const session = (id: string, directory: string, created: number) => ({
  id,
  directory,
  time: {
    created,
  },
})

const userMessage = (input: {
  id: string
  sessionID: string
  created: number
  agent?: string
  providerID?: string
  modelID?: string
}) => ({
  info: {
    id: input.id,
    sessionID: input.sessionID,
    role: "user" as const,
    time: {
      created: input.created,
    },
    agent: input.agent,
    model: input.providerID || input.modelID ? { providerID: input.providerID ?? "", modelID: input.modelID ?? "" } : undefined,
  },
  parts: [],
})

const assistantMessage = (input: {
  id: string
  sessionID: string
  created: number
  agent?: string
  providerID?: string
  modelID?: string
  tools?: Array<{ tool: string; start?: number }>
  cost?: number
  inputTokens?: number
  outputTokens?: number
}) => ({
  info: {
    id: input.id,
    sessionID: input.sessionID,
    role: "assistant" as const,
    time: {
      created: input.created,
      completed: input.created,
    },
    agent: input.agent,
    providerID: input.providerID,
    modelID: input.modelID,
    cost: input.cost,
    tokens: {
      input: input.inputTokens,
      output: input.outputTokens,
    },
  },
  parts: (input.tools ?? []).map((item) => ({
    type: "tool" as const,
    tool: item.tool,
    state: {
      time: {
        start: item.start ?? input.created,
      },
    },
  })),
})

describe("queryWorkspaceAnalytics", () => {
  test("normalizes tool names and applies workspace/provider/agent filters", () => {
    const snapshot = {
      directory: "/repo/main",
      sessions: [
        session("session-main", "/repo/main", FIXED_NOW - 60 * 60 * 1000),
        session("session-feature", "/repo/feature", FIXED_NOW - 60 * 60 * 1000),
      ],
      messages: [
        assistantMessage({
          id: "assistant-main",
          sessionID: "session-main",
          created: FIXED_NOW - 50 * 60 * 1000,
          agent: "builder",
          providerID: "openai",
          modelID: "gpt-5",
          tools: [{ tool: "ReadFile" }],
        }),
        assistantMessage({
          id: "assistant-feature",
          sessionID: "session-feature",
          created: FIXED_NOW - 45 * 60 * 1000,
          agent: "reviewer",
          providerID: "anthropic",
          modelID: "claude-sonnet-4.5",
          tools: [{ tool: "ReadFile" }],
        }),
      ],
      events: [],
    } satisfies AnalyticsSnapshot

    const result = withMockedNow(() =>
      queryWorkspaceAnalytics(snapshot, {
        dataset: "tool_usage",
        filters: {
          datePreset: "7d",
          workspace: "/repo/main",
          agent: "builder",
          providerID: "openai",
        },
      }),
    )

    expect(result.rows).toEqual([{ tool: "read_file", runs: 1 }])
    expect(result.dashboardSource).toEqual({
      mode: "workspace_query",
      query: {
        dataset: "tool_usage",
        filters: {
          datePreset: "7d",
          workspace: "/repo/main",
          agent: "builder",
          providerID: "openai",
        },
      },
    })
  })

  test("respects branch filters and can render the result as a table", () => {
    const snapshot = {
      directory: "/repo/main",
      sessions: [
        session("session-main", "/repo/main", FIXED_NOW - 2 * 60 * 60 * 1000),
        session("session-feature", "/repo/feature", FIXED_NOW - 2 * 60 * 60 * 1000),
      ],
      messages: [
        userMessage({ id: "user-main", sessionID: "session-main", created: FIXED_NOW - 110 * 60 * 1000, agent: "builder" }),
        assistantMessage({
          id: "assistant-main",
          sessionID: "session-main",
          created: FIXED_NOW - 100 * 60 * 1000,
          agent: "builder",
          providerID: "openai",
          modelID: "gpt-5",
        }),
        userMessage({
          id: "user-feature",
          sessionID: "session-feature",
          created: FIXED_NOW - 110 * 60 * 1000,
          agent: "reviewer",
        }),
        assistantMessage({
          id: "assistant-feature",
          sessionID: "session-feature",
          created: FIXED_NOW - 100 * 60 * 1000,
          agent: "reviewer",
          providerID: "anthropic",
          modelID: "claude-sonnet-4.5",
        }),
      ],
      events: [],
    } satisfies AnalyticsSnapshot

    const result = withMockedNow(() =>
      queryWorkspaceAnalytics(snapshot, {
        dataset: "session_activity",
        renderAs: "table",
        filters: {
          datePreset: "24h",
          branch: "main",
        },
      }),
    )

    expect(result.visualization?.kind).toBe("table")
    const totals = result.rows.reduce<{ sessions: number; prompts: number; responses: number }>(
      (acc, row) => ({
        sessions: acc.sessions + Number(row.sessions ?? 0),
        prompts: acc.prompts + Number(row.prompts ?? 0),
        responses: acc.responses + Number(row.responses ?? 0),
      }),
      { sessions: 0, prompts: 0, responses: 0 },
    )
    expect(totals).toEqual({ sessions: 1, prompts: 1, responses: 1 })
  })

  test("combines interruption events with question tools and can render metrics", () => {
    const snapshot = {
      directory: "/repo/main",
      sessions: [session("session-main", "/repo/main", FIXED_NOW - 3 * 60 * 60 * 1000)],
      messages: [
        assistantMessage({
          id: "assistant-main",
          sessionID: "session-main",
          created: FIXED_NOW - 90 * 60 * 1000,
          agent: "builder",
          providerID: "openai",
          modelID: "gpt-5",
          tools: [{ tool: "askUserQuestion" }],
        }),
      ],
      events: [
        {
          id: "permission-event",
          directory: "/repo/main",
          sessionID: "session-main",
          type: "permission_asked" as const,
          createdAt: FIXED_NOW - 2 * 60 * 60 * 1000,
        },
        {
          id: "question-event",
          directory: "/repo/main",
          sessionID: "session-main",
          type: "question_asked" as const,
          createdAt: FIXED_NOW - 80 * 60 * 1000,
        },
      ],
    } satisfies AnalyticsSnapshot

    const result = withMockedNow(() =>
      queryWorkspaceAnalytics(snapshot, {
        dataset: "permission_or_question_load",
        renderAs: "metrics",
        filters: {
          datePreset: "24h",
          workspace: "/repo/main",
        },
      }),
    )

    expect(result.visualization?.kind).toBe("metrics")
    const items = result.visualization?.kind === "metrics" ? result.visualization.items : []
    expect(items).toEqual([
      expect.objectContaining({ key: "permissions", value: 1 }),
      expect.objectContaining({ key: "questions", value: 2 }),
    ])
  })
})
