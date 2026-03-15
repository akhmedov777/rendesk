import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeTheme, safeStorage, shell } from "electron"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { bootstrapDesktopEnv } from "./env.js"
import { createProviderAuthStore } from "./provider-auth-store.js"
import type { ActiveEditorState } from "./onlyoffice/types.js"
import { createLocalService } from "./service.js"

const APP_NAME = "Rendesk"
const APP_ID = "app.rendesk.desktop"

await bootstrapDesktopEnv({ packaged: app.isPackaged })

app.setName(APP_NAME)
if (process.platform === "win32") {
  app.setAppUserModelId(APP_ID)
}

const currentDir = dirname(fileURLToPath(import.meta.url))
const preloadPath = join(currentDir, "preload.js")
const rendererIndex = join(currentDir, "..", "renderer", "index.html")
const devServerUrl = process.env.VITE_DEV_SERVER_URL

let mainWindow: any
let localService: Awaited<ReturnType<typeof createLocalService>> | undefined
let editorToolCounter = 0
let authStore: ReturnType<typeof createProviderAuthStore> | undefined

const pendingEditorToolRequests = new Map<
  string,
  {
    resolve: (result: string) => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }
>()

const checkAppExists = (appName: string) => {
  const name = appName.trim()
  if (!name) return false

  if (process.platform === "darwin") {
    return spawnSync("osascript", ["-e", `id of app "${name.replaceAll('"', '\\"')}"`], { stdio: "ignore" }).status === 0
  }

  if (process.platform === "win32") {
    return spawnSync("powershell.exe", ["-NoProfile", "-Command", `Get-Command -Name '${name.replaceAll("'", "''")}'`], {
      stdio: "ignore",
    }).status === 0
  }

  return spawnSync("sh", ["-lc", `command -v "${name.replaceAll('"', '\\"')}" >/dev/null 2>&1`], {
    stdio: "ignore",
  }).status === 0
}

const openPathWithApp = (path: string, appName: string) =>
  new Promise<void>((resolve, reject) => {
    const name = appName.trim()
    if (!name) {
      resolve()
      return
    }

    const child =
      process.platform === "darwin"
        ? spawn("open", ["-a", name, path], { detached: true, stdio: "ignore" })
        : spawn(name, [path], { detached: true, stdio: "ignore", shell: true })

    child.once("error", reject)
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  })

const sendMenuCommand = (id: string) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send("backoffice:menu-command", id)
}

const sendEditorToolRequest = (toolName: string, toolInput: Record<string, unknown>) =>
  new Promise<string>((resolve, reject) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      reject(new Error("Main window is not available"))
      return
    }

    const requestId = `editor-tool-${++editorToolCounter}-${Date.now()}`
    const timeout = setTimeout(() => {
      pendingEditorToolRequests.delete(requestId)
      reject(new Error("Editor tool request timed out"))
    }, 30_000)

    pendingEditorToolRequests.set(requestId, {
      resolve: (result) => {
        clearTimeout(timeout)
        resolve(result)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
      timeout,
    })

    mainWindow.webContents.send("editor:tool-request", { requestId, toolName, toolInput })
  })

const createMenu = () => {
  const template = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [{ role: "about" }, { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Workspace",
          accelerator: "CmdOrCtrl+O",
          click: () => sendMenuCommand("project.open"),
        },
        {
          label: "New Session",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => sendMenuCommand("session.new"),
        },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Sidebar",
          accelerator: "CmdOrCtrl+B",
          click: () => sendMenuCommand("sidebar.toggle"),
        },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Settings",
          accelerator: "CmdOrCtrl+,",
          click: () => sendMenuCommand("settings.open"),
        },
        {
          label: "Anthropic Docs",
          click: () => {
            void shell.openExternal("https://docs.anthropic.com")
          },
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template as any))
}

const ensureLocalService = async () => {
  if (localService) return localService

  authStore ??= createProviderAuthStore({
    userDataPath: app.getPath("userData"),
    crypto: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value).toString("base64"),
      decryptString: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
    },
  })

  localService = await createLocalService({
    userDataPath: app.getPath("userData"),
    authStore,
    sendEditorToolRequest,
  })

  return localService
}

const createWindow = async () => {
  await ensureLocalService()

  mainWindow = new BrowserWindow({
    width: 1460,
    height: 980,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#f4f2ed",
    title: APP_NAME,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition: process.platform === "darwin" ? { x: 16, y: 14 } : undefined,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl)
  } else {
    await mainWindow.loadFile(rendererIndex)
  }
}

ipcMain.handle("backoffice:bootstrap", async () => {
  const service = await ensureLocalService()

  return {
    serviceUrl: service.url,
    version: app.getVersion(),
    os: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
    defaultServerUrl: service.getPreferences().defaultServerUrl,
    displayBackend: service.getPreferences().displayBackend,
  }
})

ipcMain.handle("backoffice:dialog:directory", async (_event: unknown, options: { title?: string; multiple?: boolean }) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options?.title,
    properties: options?.multiple ? ["multiSelections", "openDirectory"] : ["openDirectory"],
  })
  if (result.canceled) return null
  if (options?.multiple) return result.filePaths
  return result.filePaths[0] ?? null
})

ipcMain.handle("backoffice:dialog:file", async (_event: unknown, options: { title?: string; multiple?: boolean }) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options?.title,
    properties: options?.multiple ? ["multiSelections", "openFile"] : ["openFile"],
  })
  if (result.canceled) return null
  if (options?.multiple) return result.filePaths
  return result.filePaths[0] ?? null
})

ipcMain.handle("backoffice:dialog:save", async (_event: unknown, options: { title?: string; defaultPath?: string }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options?.title,
    defaultPath: options?.defaultPath,
  })
  if (result.canceled) return null
  return result.filePath ?? null
})

ipcMain.handle("backoffice:shell:openExternal", async (_event: unknown, url: string) => {
  await shell.openExternal(url)
})

ipcMain.handle("backoffice:shell:openPath", async (_event: unknown, payload: { path: string; app?: string | null }) => {
  const appName = payload.app?.trim()
  if (appName) {
    await openPathWithApp(payload.path, appName)
    return
  }
  await shell.openPath(payload.path)
})

ipcMain.handle("backoffice:shell:checkAppExists", async (_event: unknown, appName: string) => {
  return checkAppExists(appName)
})

ipcMain.handle("backoffice:app:restart", async () => {
  app.relaunch()
  app.exit(0)
})

ipcMain.handle("backoffice:settings:defaultServerUrl", async (_event: unknown, url: string | null) => {
  await localService?.setPreferences({ defaultServerUrl: url })
})

ipcMain.handle("backoffice:settings:displayBackend", async (_event: unknown, backend: "auto" | "wayland") => {
  await localService?.setPreferences({ displayBackend: backend })
})

ipcMain.handle("backoffice:window:theme", async (_event: unknown, theme: "light" | "dark" | null) => {
  nativeTheme.themeSource = theme ?? "system"
})

ipcMain.handle("backoffice:window:toggleMaximize", async () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize()
    return
  }
  mainWindow.maximize()
})

ipcMain.handle("backoffice:window:minimize", async () => {
  mainWindow?.minimize()
})

ipcMain.handle("backoffice:window:close", async () => {
  mainWindow?.close()
})

ipcMain.handle("backoffice:clipboard:image", async () => {
  const image = clipboard.readImage()
  if (image.isEmpty()) return null
  return {
    dataUrl: image.toDataURL(),
    filename: `pasted-image-${Date.now()}.png`,
  }
})

ipcMain.handle("editor:tool-result", async (_event: unknown, payload: { requestId: string; result: string }) => {
  const pending = pendingEditorToolRequests.get(payload.requestId)
  if (!pending) return
  pendingEditorToolRequests.delete(payload.requestId)
  pending.resolve(payload.result)
})

ipcMain.handle("editor:state/update", async (_event: unknown, payload: ActiveEditorState) => {
  await localService?.setEditorState(payload)
})

ipcMain.handle("editor:state/clear", async (_event: unknown, payload: { sessionID: string }) => {
  await localService?.clearEditorState(payload.sessionID)
})

app.whenReady().then(async () => {
  createMenu()
  await createWindow()
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow()
    }
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("before-quit", async () => {
  for (const [requestId, pending] of pendingEditorToolRequests) {
    pendingEditorToolRequests.delete(requestId)
    clearTimeout(pending.timeout)
    pending.reject(new Error("Application is quitting"))
  }
  await localService?.close()
})
