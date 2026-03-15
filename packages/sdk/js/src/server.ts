export type ServerOptions = {
  hostname?: string
  port?: number
  signal?: AbortSignal
  timeout?: number
  config?: Record<string, unknown>
}

export type TuiOptions = {
  project?: string
  model?: string
  session?: string
  agent?: string
  signal?: AbortSignal
  config?: Record<string, unknown>
}

const unsupported = (name: string) => {
  throw new Error(`${name} is not supported in the Electron desktop build`)
}

export async function createOpencodeServer(_options?: ServerOptions) {
  unsupported("createOpencodeServer")
  return {
    url: "",
    close() {},
  }
}

export function createOpencodeTui(_options?: TuiOptions) {
  unsupported("createOpencodeTui")
  return {
    close() {},
  }
}
