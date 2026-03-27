import { app, BrowserWindow, Menu, Tray, clipboard, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, screen, shell } from "electron"
import { autoUpdater } from "electron-updater"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { bootstrapDesktopEnv } from "./env.js"
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

const IS_MAC = process.platform === "darwin"

// Overlay mode constants
const NORMAL_WIDTH = 1460
const NORMAL_HEIGHT = 980
const OVERLAY_WIDTH = 1040
const OVERLAY_HEIGHT = 720

let mainWindow: any
let tray: Tray | null = null
let isOverlayMode = false
let dragStartPos: { x: number; y: number } | null = null
let currentOverlayShortcut: string | null = null
let localService: Awaited<ReturnType<typeof createLocalService>> | undefined
let editorToolCounter = 0
let pyodideRequestCounter = 0

const pendingEditorToolRequests = new Map<
  string,
  {
    resolve: (result: string) => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }
>()

type PyodideExecuteResult = {
  success: boolean
  result?: string
  stdout: string
  stderr: string
  images: string[]
}

const pendingPyodideRequests = new Map<
  string,
  {
    resolve: (result: PyodideExecuteResult) => void
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

const sendPyodideRequest = (code: string, options?: { globals?: Record<string, unknown> }) =>
  new Promise<PyodideExecuteResult>((resolve, reject) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      reject(new Error("Main window is not available"))
      return
    }

    const requestId = `pyodide-${++pyodideRequestCounter}-${Date.now()}`
    const timeout = setTimeout(() => {
      pendingPyodideRequests.delete(requestId)
      reject(new Error("Pyodide execution timed out"))
    }, 120_000)

    pendingPyodideRequests.set(requestId, {
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

    mainWindow.webContents.send("pyodide:execute", { requestId, code, globals: options?.globals })
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
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        {
          label: "Overlay Mode",
          type: "checkbox",
          checked: isOverlayMode,
          click: (item: any) => applyOverlayMode(item.checked),
        },
      ],
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
          label: "Check for Updates...",
          click: () => {
            void autoUpdater.checkForUpdates().then((result) => {
              if (!result || !result.updateInfo) {
                void dialog.showMessageBox(mainWindow, {
                  type: "info",
                  title: "Updates",
                  message: "You are running the latest version.",
                })
              }
            }).catch(() => {
              void dialog.showMessageBox(mainWindow, {
                type: "info",
                title: "Updates",
                message: "Unable to check for updates right now.",
              })
            })
          },
        },
        {
          label: "Renvel AI Docs",
          click: () => {
            void shell.openExternal("https://renvel.ai")
          },
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template as any))
}

const ensureLocalService = async () => {
  if (localService) return localService

  localService = await createLocalService({
    userDataPath: app.getPath("userData"),
    packaged: app.isPackaged,
    sendEditorToolRequest,
    sendPyodideRequest,
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
    overlayShortcut: service.getPreferences().overlayShortcut ?? null,
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

ipcMain.handle("pyodide:execute-result", async (_event: unknown, payload: { requestId: string; result: PyodideExecuteResult }) => {
  const pending = pendingPyodideRequests.get(payload.requestId)
  if (!pending) return
  pendingPyodideRequests.delete(payload.requestId)
  pending.resolve(payload.result)
})

ipcMain.handle("editor:state/update", async (_event: unknown, payload: ActiveEditorState) => {
  await localService?.setEditorState(payload)
})

ipcMain.handle("editor:state/clear", async (_event: unknown, payload: { sessionID: string }) => {
  await localService?.clearEditorState(payload.sessionID)
})

ipcMain.handle("backoffice:update:check", async () => {
  try {
    const result = await autoUpdater.checkForUpdates()
    if (result && result.updateInfo) {
      return { updateAvailable: true, version: result.updateInfo.version }
    }
    return { updateAvailable: false }
  } catch {
    return { updateAvailable: false }
  }
})

ipcMain.handle("backoffice:update:install", async () => {
  console.log("[updater] Install requested via IPC")
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
})

// --- Overlay mode ---

const broadcast = (channel: string, ...args: unknown[]) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(channel, ...args)
}

function showWindow(source = "unknown") {
  if (!mainWindow) return

  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { width: sw, height: sh } = display.workAreaSize
  const { x: dx, y: dy } = display.workArea

  if (isOverlayMode) {
    const x = dx + Math.round((sw - OVERLAY_WIDTH) / 2)
    const y = dy + sh - OVERLAY_HEIGHT
    mainWindow.setBounds({ x, y, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT })
  }

  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  mainWindow.show()
  mainWindow.webContents.focus()
  broadcast("backoffice:overlay:windowShown")
}

function toggleWindow(source = "unknown") {
  if (!mainWindow) return
  if (mainWindow.isVisible()) {
    mainWindow.hide()
  } else {
    showWindow(source)
  }
}

function applyOverlayMode(enabled: boolean) {
  if (!mainWindow || mainWindow.isDestroyed()) return

  isOverlayMode = enabled

  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { width: sw, height: sh } = display.workAreaSize
  const { x: dx, y: dy } = display.workArea

  if (enabled) {
    const x = dx + Math.round((sw - OVERLAY_WIDTH) / 2)
    const y = dy + sh - OVERLAY_HEIGHT

    mainWindow.setAlwaysOnTop(true, "screen-saver")
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    mainWindow.setSkipTaskbar(true)
    mainWindow.setHasShadow(false)

    if (IS_MAC) {
      mainWindow.setWindowButtonVisibility(false)
    }

    mainWindow.setBounds({ x, y, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT })
    mainWindow.setMinimumSize(400, 300)
    mainWindow.setBackgroundColor("#00000000")

    // Enable click-through for transparent areas
    mainWindow.setIgnoreMouseEvents(true, { forward: true })
  } else {
    mainWindow.setAlwaysOnTop(false)
    mainWindow.setSkipTaskbar(false)
    mainWindow.setHasShadow(true)

    if (IS_MAC) {
      mainWindow.setWindowButtonVisibility(true)
    }

    const x = dx + Math.round((sw - NORMAL_WIDTH) / 2)
    const y = dy + Math.round((sh - NORMAL_HEIGHT) / 2)
    mainWindow.setBounds({ x, y, width: NORMAL_WIDTH, height: NORMAL_HEIGHT })
    mainWindow.setMinimumSize(1080, 720)
    mainWindow.setBackgroundColor("#f4f2ed")

    mainWindow.setIgnoreMouseEvents(false)
  }

  broadcast("backoffice:overlay:modeChanged", enabled)
}

function registerOverlayShortcut(shortcut: string | null) {
  // Unregister previous shortcut
  if (currentOverlayShortcut) {
    try {
      globalShortcut.unregister(currentOverlayShortcut)
    } catch {}
    currentOverlayShortcut = null
  }

  if (!shortcut) return

  try {
    const success = globalShortcut.register(shortcut, () => {
      if (isOverlayMode) {
        toggleWindow("shortcut")
      } else {
        applyOverlayMode(true)
        showWindow("shortcut")
      }
    })
    if (success) {
      currentOverlayShortcut = shortcut
    }
  } catch (err) {
    console.error("Failed to register overlay shortcut:", err)
  }
}

ipcMain.handle("backoffice:settings:overlayShortcut", async (_event: unknown, shortcut: string | null) => {
  registerOverlayShortcut(shortcut)
  await localService?.setPreferences({ overlayShortcut: shortcut })
})

ipcMain.handle("backoffice:overlay:set", (_event: unknown, enabled: boolean) => {
  applyOverlayMode(enabled)
})

ipcMain.handle("backoffice:overlay:get", () => {
  return isOverlayMode
})

ipcMain.on("backoffice:overlay:ignoreMouseEvents", (event, ignore: boolean, options?: { forward?: boolean }) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(ignore, options || {})
  }
})

ipcMain.on("backoffice:overlay:startDrag", (_event, screenX: number, screenY: number) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const [winX, winY] = mainWindow.getPosition()
  dragStartPos = { x: screenX - winX, y: screenY - winY }
})

ipcMain.on("backoffice:overlay:drag", (_event, screenX: number, screenY: number) => {
  if (!mainWindow || mainWindow.isDestroyed() || !dragStartPos) return
  mainWindow.setPosition(screenX - dragStartPos.x, screenY - dragStartPos.y)
})

// --- Tray icon ---

function createTray() {
  try {
    const iconPath = join(currentDir, "..", "..", "build", "icon.png")
    const icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) return

    const trayIcon = IS_MAC ? icon.resize({ width: 18, height: 18 }) : icon.resize({ width: 18, height: 18 })
    tray = new Tray(trayIcon)
    tray.setToolTip(APP_NAME)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Show ${APP_NAME}`, click: () => showWindow("tray") },
        { type: "separator" },
        {
          label: "Overlay Mode",
          type: "checkbox",
          checked: isOverlayMode,
          click: (item) => applyOverlayMode(item.checked),
        },
        { type: "separator" },
        { label: "Quit", click: () => app.quit() },
      ]),
    )
    tray.on("click", () => toggleWindow("tray-click"))
  } catch {}
}

app.whenReady().then(async () => {
  createMenu()
  await createWindow()
  createTray()

  // Register overlay shortcut from preferences (default: none — user must set it)
  const savedShortcut = localService?.getPreferences().overlayShortcut
  if (savedShortcut) {
    registerOverlayShortcut(savedShortcut)
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = {
    info: (msg: unknown) => console.log("[updater]", msg),
    warn: (msg: unknown) => console.warn("[updater]", msg),
    error: (msg: unknown) => console.error("[updater]", msg),
    debug: (msg: unknown) => console.log("[updater:debug]", msg),
  }

  let updateDialogShown = false

  autoUpdater.on("checking-for-update", () => {
    console.log("[updater] Checking for update...")
  })

  autoUpdater.on("update-available", (info) => {
    console.log("[updater] Update available:", info.version)
  })

  autoUpdater.on("update-not-available", (info) => {
    console.log("[updater] No update available. Current:", app.getVersion(), "Latest:", info.version)
  })

  autoUpdater.on("download-progress", (progress) => {
    console.log(`[updater] Download: ${Math.round(progress.percent)}%`)
  })

  autoUpdater.on("error", (err) => {
    console.error("[updater] Error:", err.message)
  })

  autoUpdater.on("update-downloaded", (info) => {
    console.log("[updater] Update downloaded:", info.version)
    if (updateDialogShown) return
    updateDialogShown = true
    void dialog
      .showMessageBox(mainWindow, {
        type: "info",
        title: "Update Ready",
        message: `Version ${info.version} has been downloaded. Restart to apply the update?`,
        buttons: ["Restart Now", "Later"],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) {
          setImmediate(() => autoUpdater.quitAndInstall(false, true))
        } else {
          updateDialogShown = false
        }
      })
  })

  void autoUpdater.checkForUpdates().catch((err) => {
    console.error("[updater] Initial check failed:", err?.message)
  })

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

app.on("will-quit", () => {
  globalShortcut.unregisterAll()
  tray?.destroy()
})

app.on("before-quit", async () => {
  for (const [requestId, pending] of pendingEditorToolRequests) {
    pendingEditorToolRequests.delete(requestId)
    clearTimeout(pending.timeout)
    pending.reject(new Error("Application is quitting"))
  }
  for (const [requestId, pending] of pendingPyodideRequests) {
    pendingPyodideRequests.delete(requestId)
    clearTimeout(pending.timeout)
    pending.reject(new Error("Application is quitting"))
  }
  await localService?.close()
})
