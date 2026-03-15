import type { ActiveEditorState } from "./onlyoffice/types.js"

export type DesktopOs = "macos" | "windows" | "linux"

export type BackofficeBootstrap = {
  serviceUrl: string
  version: string
  os: DesktopOs
  defaultServerUrl: string | null
  displayBackend: "auto" | "wayland" | null
}

export type BackofficeBridge = {
  bootstrap(): Promise<BackofficeBootstrap>
  openDirectoryPicker(options?: { title?: string; multiple?: boolean }): Promise<string | string[] | null>
  openFilePicker(options?: { title?: string; multiple?: boolean }): Promise<string | string[] | null>
  saveFilePicker(options?: { title?: string; defaultPath?: string }): Promise<string | null>
  openExternal(url: string): Promise<void>
  openPath(path: string, app?: string | null): Promise<void>
  checkAppExists(appName: string): Promise<boolean>
  restart(): Promise<void>
  setDefaultServerUrl(url: string | null): Promise<void>
  setDisplayBackend(backend: "auto" | "wayland"): Promise<void>
  setTheme(theme: "light" | "dark" | null): Promise<void>
  toggleMaximize(): Promise<void>
  minimize(): Promise<void>
  close(): Promise<void>
  readClipboardImage(): Promise<{ dataUrl: string; filename: string } | null>
  updateEditorState(state: ActiveEditorState): Promise<void>
  clearEditorState(sessionID: string): Promise<void>
  onEditorToolRequest(
    callback: (payload: { requestId: string; toolName: string; toolInput: Record<string, unknown> }) => void | Promise<void>,
  ): () => void
  sendEditorToolResult(requestId: string, result: string): Promise<void>
  onMenuCommand(callback: (id: string) => void): () => void
}
