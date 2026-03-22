import { contextBridge, ipcRenderer } from "electron"
import type { BackofficeBridge } from "./bridge.js"

const bridge: BackofficeBridge = {
  bootstrap: () => ipcRenderer.invoke("backoffice:bootstrap"),
  openDirectoryPicker: (options) => ipcRenderer.invoke("backoffice:dialog:directory", options),
  openFilePicker: (options) => ipcRenderer.invoke("backoffice:dialog:file", options),
  saveFilePicker: (options) => ipcRenderer.invoke("backoffice:dialog:save", options),
  openExternal: (url) => ipcRenderer.invoke("backoffice:shell:openExternal", url),
  openPath: (path, app) => ipcRenderer.invoke("backoffice:shell:openPath", { path, app }),
  checkAppExists: (appName) => ipcRenderer.invoke("backoffice:shell:checkAppExists", appName),
  restart: () => ipcRenderer.invoke("backoffice:app:restart"),
  setDefaultServerUrl: (url) => ipcRenderer.invoke("backoffice:settings:defaultServerUrl", url),
  setDisplayBackend: (backend) => ipcRenderer.invoke("backoffice:settings:displayBackend", backend),
  setTheme: (theme) => ipcRenderer.invoke("backoffice:window:theme", theme),
  toggleMaximize: () => ipcRenderer.invoke("backoffice:window:toggleMaximize"),
  minimize: () => ipcRenderer.invoke("backoffice:window:minimize"),
  close: () => ipcRenderer.invoke("backoffice:window:close"),
  readClipboardImage: () => ipcRenderer.invoke("backoffice:clipboard:image"),
  updateEditorState: (state) => ipcRenderer.invoke("editor:state/update", state),
  clearEditorState: (sessionID) => ipcRenderer.invoke("editor:state/clear", { sessionID }),
  sendEditorToolResult: (requestId, result) => ipcRenderer.invoke("editor:tool-result", { requestId, result }),
  onEditorToolRequest(callback) {
    const handler = (_event: unknown, payload: { requestId: string; toolName: string; toolInput: Record<string, unknown> }) => {
      void callback(payload)
    }
    ipcRenderer.on("editor:tool-request", handler)
    return () => {
      ipcRenderer.removeListener("editor:tool-request", handler)
    }
  },
  onPyodideExecute(callback) {
    const handler = (_event: unknown, payload: { requestId: string; code: string; globals?: Record<string, unknown> }) => {
      void callback(payload)
    }
    ipcRenderer.on("pyodide:execute", handler)
    return () => {
      ipcRenderer.removeListener("pyodide:execute", handler)
    }
  },
  sendPyodideResult: (requestId, result) => ipcRenderer.invoke("pyodide:execute-result", { requestId, result }),
  onMenuCommand(callback) {
    const handler = (_event: unknown, id: string) => callback(id)
    ipcRenderer.on("backoffice:menu-command", handler)
    return () => {
      ipcRenderer.removeListener("backoffice:menu-command", handler)
    }
  },
}

contextBridge.exposeInMainWorld("__BACKOFFICE__", bridge)
