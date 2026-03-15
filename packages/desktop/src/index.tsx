// @refresh reload

import {
  AppBaseProviders,
  AppInterface,
  handleNotificationClick,
  type Platform,
  PlatformProvider,
  ServerConnection,
  useCommand,
} from "@rendesk/app"
import { Splash } from "@rendesk/ui/logo"
import { createResource, onCleanup, onMount, Show } from "solid-js"
import { render } from "solid-js/web"
import pkg from "../package.json"
import { DesktopFile } from "./components/desktop-file"
import { SettingsDocumentEditor } from "./components/settings-document-editor"
import { DesktopRouter } from "./desktop-router"
import { DesktopEditorProvider, getDesktopActiveEditorState } from "./editor/provider"
import { initI18n, t } from "./i18n"
import type { BackofficeBridge, DesktopOs } from "./electron/bridge"
import "./styles.css"

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(t("error.dev.rootNotFound"))
}

void initI18n()

declare global {
  interface Window {
    __BACKOFFICE__?: BackofficeBridge
    __RENDESK__?: {
      updaterEnabled?: boolean
      deepLinks?: string[]
      wsl?: boolean
    }
    __OPENCODE__?: {
      updaterEnabled?: boolean
      deepLinks?: string[]
      wsl?: boolean
    }
  }
}

const bridge = () => {
  const api = window.__BACKOFFICE__
  if (!api) throw new Error("Electron preload bridge is not available")
  return api
}

const dataUrlToFile = async (dataUrl: string, filename: string) => {
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  return new File([blob], filename, { type: blob.type || "image/png" })
}

const createPlatform = (bootstrap: { os: DesktopOs; serviceUrl: string }): Platform => {
  const boundFetch = window.fetch.bind(window)
  return {
    platform: "desktop",
    capabilities: {
      dashboard: true,
      visualization: true,
    },
    os: bootstrap.os,
    version: pkg.version,
    serviceUrl: bootstrap.serviceUrl,
    fetch: boundFetch,
    openLink(url: string) {
      void bridge()
        .openExternal(url)
        .catch(() => undefined)
    },
    async openPath(path: string, app?: string) {
      await bridge().openPath(path, app ?? null)
    },
    async checkAppExists(appName: string) {
      return bridge().checkAppExists(appName)
    },
    async openDirectoryPickerDialog(opts) {
      return bridge().openDirectoryPicker({
        title: opts?.title,
        multiple: opts?.multiple,
      })
    },
    async openFilePickerDialog(opts) {
      return bridge().openFilePicker({
        title: opts?.title,
        multiple: opts?.multiple,
      })
    },
    async saveFilePickerDialog(opts) {
      return bridge().saveFilePicker({
        title: opts?.title,
        defaultPath: opts?.defaultPath,
      })
    },
    async restart() {
      await bridge().restart()
    },
    back() {
      window.history.back()
    },
    forward() {
      window.history.forward()
    },
    async notify(title, description, href) {
      if (document.hasFocus()) return
      if (!("Notification" in window)) return
      const permission =
        Notification.permission === "granted" ? "granted" : await Notification.requestPermission().catch(() => "denied")
      if (permission !== "granted") return
      const notification = new Notification(title, {
        body: description ?? "",
        icon: new URL("./favicon-96x96-v3.png", window.location.href).toString(),
      })
      notification.onclick = () => {
        window.focus()
        handleNotificationClick(href)
        notification.close()
      }
    },
    async getDefaultServerUrl() {
      const current = await bridge().bootstrap()
      return current.defaultServerUrl
    },
    async setDefaultServerUrl(url) {
      await bridge().setDefaultServerUrl(url)
    },
    async getDisplayBackend() {
      const current = await bridge().bootstrap()
      return current.displayBackend
    },
    async setDisplayBackend(backend) {
      await bridge().setDisplayBackend(backend)
    },
    async readClipboardImage() {
      const image = await bridge()
        .readClipboardImage()
        .catch(() => null)
      if (!image) return null
      return dataUrlToFile(image.dataUrl, image.filename)
    },
    activeEditorContext: () => {
      const editor = getDesktopActiveEditorState()
      if (!editor) return null
      return {
        filePath: editor.filePath,
        fileName: editor.fileName,
        fileExt: editor.fileExt,
        documentType: editor.documentType,
        selectedText: editor.selectedText,
        selectionRange: editor.selectionRange,
        ready: editor.ready,
        modified: editor.modified,
      }
    },
  }
}

render(() => {
  const [bootstrap] = createResource(async () => {
    const value = await bridge().bootstrap()
    const runtimeFlags = {
      updaterEnabled: false,
      deepLinks: [],
      wsl: false,
    }
    window.__RENDESK__ = runtimeFlags
    window.__OPENCODE__ = runtimeFlags
    return value
  })

  const handleClick = (event: MouseEvent) => {
    const link = (event.target as HTMLElement).closest("a.external-link") as HTMLAnchorElement | null
    if (!link?.href) return
    event.preventDefault()
    void bridge()
      .openExternal(link.href)
      .catch(() => undefined)
  }

  onMount(() => {
    document.addEventListener("click", handleClick)
    onCleanup(() => {
      document.removeEventListener("click", handleClick)
    })
  })

  return (
    <Show
      when={bootstrap()}
      fallback={
        <div class="h-screen w-screen flex flex-col items-center justify-center bg-background-base">
          <Splash class="w-16 h-20 opacity-50 animate-pulse" />
        </div>
      }
    >
      {(value) => {
        const platform = createPlatform(value())
        const server: ServerConnection.Any = {
          displayName: "Local back office",
          type: "sidecar",
          variant: "base",
          http: {
            url: value().serviceUrl,
          },
        }

        function MenuBridge() {
          const command = useCommand()
          onMount(() => {
            return bridge().onMenuCommand((id) => {
              command.trigger(id)
            })
          })
          return null
        }

        return (
          <PlatformProvider value={platform}>
            <DesktopEditorProvider>
              <AppBaseProviders
                fileComponent={DesktopFile}
                settingsTabs={[
                  {
                    value: "document-editor",
                    label: "Document Editor",
                    component: SettingsDocumentEditor,
                  },
                ]}
              >
                <AppInterface defaultServer={ServerConnection.key(server)} servers={[server]} router={DesktopRouter}>
                  <MenuBridge />
                </AppInterface>
              </AppBaseProviders>
            </DesktopEditorProvider>
          </PlatformProvider>
        )
      }}
    </Show>
  )
}, root!)
