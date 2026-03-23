export type OpencodeClientConfig = {
  baseUrl?: string
  directory?: string
  headers?: HeadersInit
  fetch?: typeof fetch
  throwOnError?: boolean
  signal?: AbortSignal
}

type RpcEnvelope<T> = {
  data?: T
  error?: {
    message?: string
    code?: string
    data?: unknown
  }
  limit?: number
  limited?: boolean
}

type EventStreamItem = {
  directory?: string
  payload: {
    type: string
    properties?: unknown
  }
}

const joinUrl = (baseUrl: string, path: string) => `${baseUrl.replace(/\/+$/, "")}${path}`

const normalizeHeaders = (headers?: HeadersInit) => {
  const result = new Headers(headers ?? {})
  if (!result.has("content-type")) {
    result.set("content-type", "application/json")
  }
  return result
}

const normalizeError = (payload: RpcEnvelope<unknown>["error"], fallback: string) => {
  const error = new Error(payload?.message || fallback) as Error & {
    code?: string
    data?: unknown
  }
  error.code = payload?.code
  error.data = payload?.data
  return error
}

async function* parseSseStream(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    for (;;) {
      if (signal?.aborted) return
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      for (;;) {
        const index = buffer.indexOf("\n\n")
        if (index === -1) break
        const chunk = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)

        const lines = chunk
          .split("\n")
          .map((line) => line.trimEnd())
          .filter((line) => line.startsWith("data:"))

        if (!lines.length) continue
        const data = lines.map((line) => line.slice(5).trimStart()).join("\n")
        if (!data) continue
        yield JSON.parse(data) as EventStreamItem
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export class OpencodeClient {
  private readonly baseUrl: string
  private readonly fetcher: typeof fetch
  private readonly headers: Headers
  private readonly throwOnError: boolean
  private readonly signal?: AbortSignal
  readonly directory?: string

  constructor(config: OpencodeClientConfig = {}) {
    const fetcher = config.fetch ?? globalThis.fetch
    this.baseUrl = config.baseUrl ?? "http://127.0.0.1:4096"
    this.fetcher = fetcher.bind(globalThis)
    this.headers = normalizeHeaders(config.headers)
    this.throwOnError = config.throwOnError ?? false
    this.signal = config.signal
    this.directory = config.directory
  }

  private async rpc<T>(action: string, input?: unknown, options?: { throwOnError?: boolean }): Promise<RpcEnvelope<T>> {
    const response = await this.fetcher(joinUrl(this.baseUrl, "/rpc"), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        action,
        input,
        directory: this.directory,
      }),
      signal: this.signal,
    })

    const payload = (await response.json().catch(() => ({}))) as RpcEnvelope<T>
    if (!response.ok || payload.error) {
      if (options?.throwOnError ?? this.throwOnError) {
        throw normalizeError(payload.error, `Request failed for ${action}`)
      }
    }
    return payload
  }

  readonly global: any = {
    health: () => this.rpc("global.health"),
    dispose: () => this.rpc("global.dispose"),
    event: async (input?: { signal?: AbortSignal; onSseError?: (error: unknown) => void }) => {
      const response = await this.fetcher(joinUrl(this.baseUrl, "/events"), {
        method: "GET",
        headers: this.headers,
        signal: input?.signal,
      })

      if (!response.ok || !response.body) {
        const error = new Error(`Event stream failed with status ${response.status}`)
        input?.onSseError?.(error)
        throw error
      }

      return {
        stream: parseSseStream(response.body, input?.signal),
      }
    },
    config: {
      get: () => this.rpc("global.config.get"),
      update: (input?: unknown) => this.rpc("global.config.update", input),
    },
  }

  readonly path: any = {
    get: () => this.rpc("path.get"),
  }

  readonly project: any = {
    list: () => this.rpc("project.list"),
    current: () => this.rpc("project.current"),
    update: (...args: any[]) => this.rpc("project.update", args[0], args[1]),
    initGit: (...args: any[]) => this.rpc("project.initGit", args[0], args[1]),
  }

  readonly provider: any = {
    list: () => this.rpc("provider.list"),
    auth: () => this.rpc("provider.auth"),
    oauth: {
      authorize: (...args: any[]) => this.rpc("provider.oauth.authorize", args[0], args[1]),
      callback: (...args: any[]) => this.rpc("provider.oauth.callback", args[0], args[1]),
    },
  }

  readonly app: any = {
    agents: () => this.rpc("app.agents"),
  }

  readonly config: any = {
    get: () => this.rpc("config.get"),
  }

  readonly command: any = {
    list: () => this.rpc("command.list"),
  }

  readonly session: any = {
    status: () => this.rpc("session.status"),
    list: (...args: any[]) => this.rpc("session.list", args[0], args[1]),
    create: (...args: any[]) => this.rpc("session.create", args[0], args[1]),
    get: (...args: any[]) => this.rpc("session.get", args[0], args[1]),
    messages: (...args: any[]) => this.rpc("session.messages", args[0], args[1]),
    update: (...args: any[]) => this.rpc("session.update", args[0], args[1]),
    promptAsync: (...args: any[]) => this.rpc("session.promptAsync", args[0], args[1]),
    command: (...args: any[]) => this.rpc("session.command", args[0], args[1]),
    shell: (...args: any[]) => this.rpc("session.shell", args[0], args[1]),
    diff: (...args: any[]) => this.rpc("session.diff", args[0], args[1]),
    todo: (...args: any[]) => this.rpc("session.todo", args[0], args[1]),
    abort: (...args: any[]) => this.rpc("session.abort", args[0], args[1]),
    revert: (...args: any[]) => this.rpc("session.revert", args[0], args[1]),
    unrevert: (...args: any[]) => this.rpc("session.unrevert", args[0], args[1]),
    summarize: (...args: any[]) => this.rpc("session.summarize", args[0], args[1]),
    share: (...args: any[]) => this.rpc("session.share", args[0], args[1]),
    unshare: (...args: any[]) => this.rpc("session.unshare", args[0], args[1]),
    fork: (...args: any[]) => this.rpc("session.fork", args[0], args[1]),
    delete: (...args: any[]) => this.rpc("session.delete", args[0], args[1]),
  }

  readonly permission: any = {
    list: (...args: any[]) => this.rpc("permission.list", args[0], args[1]),
    respond: (...args: any[]) => this.rpc("permission.respond", args[0], args[1]),
  }

  readonly question: any = {
    list: (...args: any[]) => this.rpc("question.list", args[0], args[1]),
    reply: (...args: any[]) => this.rpc("question.reply", args[0], args[1]),
    reject: (...args: any[]) => this.rpc("question.reject", args[0], args[1]),
  }

  readonly mcp: any = {
    status: (...args: any[]) => this.rpc("mcp.status", args[0], args[1]),
    connect: (...args: any[]) => this.rpc("mcp.connect", args[0], args[1]),
    disconnect: (...args: any[]) => this.rpc("mcp.disconnect", args[0], args[1]),
  }

  readonly lsp: any = {
    status: (...args: any[]) => this.rpc("lsp.status", args[0], args[1]),
  }

  readonly analytics: any = {
    query: (...args: any[]) => this.rpc("analytics.query", args[0], args[1]),
  }

  readonly dashboard: any = {
    list: (...args: any[]) => this.rpc("dashboard.list", args[0], args[1]),
    get: (...args: any[]) => this.rpc("dashboard.get", args[0], args[1]),
    create: (...args: any[]) => this.rpc("dashboard.create", args[0], args[1]),
    update: (...args: any[]) => this.rpc("dashboard.update", args[0], args[1]),
    delete: (...args: any[]) => this.rpc("dashboard.delete", args[0], args[1]),
    widget: {
      add: (...args: any[]) => this.rpc("dashboard.widget.add", args[0], args[1]),
      update: (...args: any[]) => this.rpc("dashboard.widget.update", args[0], args[1]),
      remove: (...args: any[]) => this.rpc("dashboard.widget.remove", args[0], args[1]),
      reorder: (...args: any[]) => this.rpc("dashboard.widget.reorder", args[0], args[1]),
      refresh: (...args: any[]) => this.rpc("dashboard.widget.refresh", args[0], args[1]),
    },
  }

  readonly automation: any = (() => {
    const run: any = (...args: any[]) => this.rpc("automation.run", args[0], args[1])
    run.list = (...args: any[]) => this.rpc("automation.run.list", args[0], args[1])
    run.get = (...args: any[]) => this.rpc("automation.run.get", args[0], args[1])
    return {
      list: (...args: any[]) => this.rpc("automation.list", args[0], args[1]),
      get: (...args: any[]) => this.rpc("automation.get", args[0], args[1]),
      create: (...args: any[]) => this.rpc("automation.create", args[0], args[1]),
      update: (...args: any[]) => this.rpc("automation.update", args[0], args[1]),
      delete: (...args: any[]) => this.rpc("automation.delete", args[0], args[1]),
      run,
      runList: run.list,
      runGet: run.get,
    }
  })()

  readonly vcs: any = {
    get: (...args: any[]) => this.rpc("vcs.get", args[0], args[1]),
  }

  readonly file: any = {
    list: (...args: any[]) => this.rpc("file.list", args[0], args[1]),
    read: (...args: any[]) => this.rpc("file.read", args[0], args[1]),
    status: (...args: any[]) => this.rpc("file.status", args[0], args[1]),
  }

  readonly find: any = {
    files: (...args: any[]) => this.rpc("find.files", args[0], args[1]),
  }

  readonly worktree: any = {
    list: (...args: any[]) => this.rpc("worktree.list", args[0], args[1]),
    create: (...args: any[]) => this.rpc("worktree.create", args[0], args[1]),
    remove: (...args: any[]) => this.rpc("worktree.remove", args[0], args[1]),
    reset: (...args: any[]) => this.rpc("worktree.reset", args[0], args[1]),
  }

  readonly instance: any = {
    dispose: (...args: any[]) => this.rpc("instance.dispose", args[0], args[1]),
  }

  readonly auth: any = {
    set: (...args: any[]) => this.rpc("auth.set", args[0], args[1]),
    remove: (...args: any[]) => this.rpc("auth.remove", args[0], args[1]),
  }

  readonly pty: any = {
    list: (...args: any[]) => this.rpc("pty.list", args[0], args[1]),
    create: (...args: any[]) => this.rpc("pty.create", args[0], args[1]),
    write: (...args: any[]) => this.rpc("pty.write", args[0], args[1]),
    close: (...args: any[]) => this.rpc("pty.close", args[0], args[1]),
    update: (...args: any[]) => this.rpc("pty.update", args[0], args[1]),
    remove: (...args: any[]) => this.rpc("pty.remove", args[0], args[1]),
  }
}

export function createOpencodeClient(config?: OpencodeClientConfig) {
  return new OpencodeClient(config)
}
