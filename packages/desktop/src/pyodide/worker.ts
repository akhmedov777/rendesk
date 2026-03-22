/**
 * Pyodide Web Worker — runs Python code in an isolated WebAssembly sandbox.
 *
 * Loaded lazily from the renderer process. Communicates via postMessage.
 */

// Worker globals — pyodide.js adds loadPyodide to the global scope via importScripts
/* eslint-disable no-var */
declare function importScripts(...urls: string[]): void
declare function postMessage(message: unknown): void
declare var loadPyodide: ((config: { indexURL: string }) => Promise<PyodideInterface>) | undefined

interface PyodideInterface {
  loadPackagesFromImports(code: string, options?: { messageCallback?: (msg: string) => void }): Promise<void>
  loadPackage(names: string | string[], options?: { messageCallback?: (msg: string) => void }): Promise<void>
  runPythonAsync(code: string, options?: { globals?: unknown }): Promise<unknown>
  globals: { get(key: string): unknown; set(key: string, value: unknown): void; delete(key: string): void }
  toPy(value: unknown): unknown
  isPyProxy(value: unknown): boolean
  FS: { readFile(path: string, options?: { encoding?: string }): string | Uint8Array }
  setStdout(options: { batched: (text: string) => void }): void
  setStderr(options: { batched: (text: string) => void }): void
}

type ExecuteRequest = {
  type: "execute"
  id: string
  code: string
  globals?: Record<string, unknown>
}

type InitRequest = {
  type: "init"
  assetsUrl: string
}

type WorkerRequest = ExecuteRequest | InitRequest

type ExecuteResult = {
  type: "result"
  id: string
  success: boolean
  result?: string
  stdout: string
  stderr: string
  images: string[]
}

type InitResult = {
  type: "init-result"
  success: boolean
  error?: string
}

type WorkerResponse = ExecuteResult | InitResult

let pyodide: PyodideInterface | null = null

async function initPyodide(assetsUrl: string): Promise<void> {
  // Import Pyodide loader from the served assets URL
  importScripts(`${assetsUrl}/pyodide.js`)

  if (!loadPyodide) {
    throw new Error("Pyodide loader not available after script import")
  }

  const instance = await loadPyodide({ indexURL: assetsUrl })
  pyodide = instance

  // Pre-load data analytics packages
  await instance.loadPackage(["numpy", "pandas", "scipy", "matplotlib", "micropip"], {
    messageCallback: (msg: string) => console.log("[pyodide]", msg),
  })

  // Configure matplotlib for headless rendering
  await instance.runPythonAsync(`
import matplotlib
matplotlib.use('agg')
import matplotlib.pyplot as plt
import io, base64, sys, json
`)
}

async function executePython(request: ExecuteRequest): Promise<ExecuteResult> {
  const py = pyodide
  if (!py) {
    return {
      type: "result",
      id: request.id,
      success: false,
      stdout: "",
      stderr: "Pyodide is not initialized",
      images: [],
    }
  }

  let stdout = ""
  let stderr = ""
  const images: string[] = []

  py.setStdout({ batched: (text: string) => { stdout += text + "\n" } })
  py.setStderr({ batched: (text: string) => { stderr += text + "\n" } })

  try {
    // Set any provided globals
    if (request.globals) {
      for (const [key, value] of Object.entries(request.globals)) {
        py.globals.set(key, py.toPy(value))
      }
    }

    // Auto-install any missing packages from imports
    await py.loadPackagesFromImports(request.code, {
      messageCallback: (msg: string) => console.log("[pyodide]", msg),
    })

    const rawResult = await py.runPythonAsync(request.code)

    // Check for matplotlib figures and capture them
    const figCount = await py.runPythonAsync(`
import matplotlib.pyplot as plt
len(plt.get_fignums())
`)

    if (typeof figCount === "number" && figCount > 0) {
      const capturedImages = await py.runPythonAsync(`
import matplotlib.pyplot as plt
import io, base64

_images = []
for _fig_num in plt.get_fignums():
    _fig = plt.figure(_fig_num)
    _buf = io.BytesIO()
    _fig.savefig(_buf, format='png', dpi=150, bbox_inches='tight')
    _buf.seek(0)
    _images.append(base64.b64encode(_buf.read()).decode('utf-8'))
    _buf.close()
plt.close('all')
_images
`)

      if (capturedImages && typeof capturedImages === "object" && "toJs" in (capturedImages as object)) {
        const jsImages = (capturedImages as { toJs: () => string[] }).toJs()
        images.push(...jsImages)
      }
    }

    // Convert result to string
    let resultStr: string | undefined
    if (rawResult !== undefined && rawResult !== null) {
      if (py.isPyProxy(rawResult)) {
        const reprResult = await py.runPythonAsync(`repr(_)`)
        resultStr = String(reprResult)
      } else {
        resultStr = String(rawResult)
      }
    }

    return {
      type: "result",
      id: request.id,
      success: true,
      result: resultStr,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      images,
    }
  } catch (error) {
    return {
      type: "result",
      id: request.id,
      success: false,
      result: undefined,
      stdout: stdout.trim(),
      stderr: stderr.trim() + "\n" + (error instanceof Error ? error.message : String(error)),
      images,
    }
  } finally {
    // Clean up injected globals
    if (request.globals) {
      for (const key of Object.keys(request.globals)) {
        try {
          py.globals.delete(key)
        } catch {
          // Ignore
        }
      }
    }
  }
}

onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data

  if (request.type === "init") {
    try {
      await initPyodide(request.assetsUrl)
      postMessage({ type: "init-result", success: true } satisfies InitResult)
    } catch (error) {
      postMessage({
        type: "init-result",
        success: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies InitResult)
    }
    return
  }

  if (request.type === "execute") {
    // Execution timeout
    const timeoutMs = 120_000
    const timeout = setTimeout(() => {
      postMessage({
        type: "result",
        id: request.id,
        success: false,
        stdout: "",
        stderr: "Execution timed out after 120 seconds",
        images: [],
      } satisfies ExecuteResult)
    }, timeoutMs)

    try {
      const result = await executePython(request)
      clearTimeout(timeout)
      postMessage(result)
    } catch (error) {
      clearTimeout(timeout)
      postMessage({
        type: "result",
        id: request.id,
        success: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        images: [],
      } satisfies ExecuteResult)
    }
  }
}
