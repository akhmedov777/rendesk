/**
 * Pyodide bridge — manages the Web Worker singleton from the renderer process.
 *
 * Follows the same request-id pattern as pendingEditorToolRequests in main.ts.
 */

export type PyodideResult = {
  success: boolean
  result?: string
  stdout: string
  stderr: string
  images: string[]
}

type PendingRequest = {
  resolve: (result: PyodideResult) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

let worker: Worker | null = null
let initPromise: Promise<void> | null = null
let ready = false
const pendingRequests = new Map<string, PendingRequest>()
let requestCounter = 0

function handleWorkerMessage(event: MessageEvent) {
  const data = event.data

  if (data.type === "init-result") {
    // Handled by the init promise — no pending request for init
    return
  }

  if (data.type === "result") {
    const pending = pendingRequests.get(data.id)
    if (!pending) return
    pendingRequests.delete(data.id)
    clearTimeout(pending.timeout)

    pending.resolve({
      success: data.success,
      result: data.result,
      stdout: data.stdout,
      stderr: data.stderr,
      images: data.images,
    })
  }
}

function handleWorkerError(event: ErrorEvent) {
  console.error("[pyodide-bridge] Worker error:", event.message)
  // Reject all pending requests
  for (const [id, pending] of pendingRequests) {
    pendingRequests.delete(id)
    clearTimeout(pending.timeout)
    pending.reject(new Error(`Worker error: ${event.message}`))
  }
}

export async function initialize(assetsUrl: string): Promise<void> {
  if (ready && worker) return
  if (initPromise) return initPromise

  initPromise = new Promise<void>((resolve, reject) => {
    try {
      worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "classic" })
      worker.onmessage = (event: MessageEvent) => {
        if (event.data.type === "init-result") {
          if (event.data.success) {
            ready = true
            // Switch to the normal message handler
            worker!.onmessage = handleWorkerMessage
            worker!.onerror = handleWorkerError
            resolve()
          } else {
            reject(new Error(event.data.error || "Pyodide initialization failed"))
          }
          return
        }
        handleWorkerMessage(event)
      }
      worker.onerror = (event) => {
        reject(new Error(`Worker failed to load: ${event.message}`))
      }
      worker.postMessage({ type: "init", assetsUrl })
    } catch (error) {
      reject(error)
    }
  }).finally(() => {
    initPromise = null
  })

  return initPromise
}

export async function execute(code: string, globals?: Record<string, unknown>): Promise<PyodideResult> {
  if (!worker || !ready) {
    throw new Error("Pyodide is not initialized. Call initialize() first.")
  }

  const id = `pyodide-${++requestCounter}-${Date.now()}`

  return new Promise<PyodideResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id)
      reject(new Error("Pyodide execution timed out"))
    }, 120_000)

    pendingRequests.set(id, { resolve, reject, timeout })

    worker!.postMessage({
      type: "execute",
      id,
      code,
      globals,
    })
  })
}

export function isReady(): boolean {
  return ready
}

export function terminate(): void {
  if (worker) {
    worker.terminate()
    worker = null
  }
  ready = false
  initPromise = null
  for (const [id, pending] of pendingRequests) {
    pendingRequests.delete(id)
    clearTimeout(pending.timeout)
    pending.reject(new Error("Pyodide worker terminated"))
  }
}
