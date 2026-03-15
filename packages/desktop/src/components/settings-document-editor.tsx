import { Button } from "@rendesk/ui/button"
import { Switch } from "@rendesk/ui/switch"
import { showToast } from "@rendesk/ui/toast"
import { usePlatform } from "@rendesk/app"
import { Match, Show, Switch as SolidSwitch, createEffect, createResource, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import type { EditorIntegrationConfig } from "../electron/onlyoffice/types"

const REDACTED_SECRET = "••••••••"

type TunnelStatus = {
  mode: string
  docHost: string | null
  isRemoteDocumentServer: boolean
  callbackBaseUrl: string | null
  autoTunnelEnabled: boolean
  tunnel?: {
    status?: string
    publicUrl?: string | null
    lastError?: string | null
  }
}

type ServiceTestResult = {
  success: boolean
  message: string
}

const defaultConfig = (): EditorIntegrationConfig => ({
  enabled: false,
  documentServerUrl: "",
  jwtSecret: "",
  callbackBaseUrl: "",
  autoTunnelEnabled: true,
})

function fieldValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback
}

function booleanValue(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback
}

async function parseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

function SettingsRow(props: { title: string; description: string; children: any }) {
  return (
    <div class="flex flex-wrap items-center justify-between gap-4 border-b border-border-weak-base py-3 last:border-none">
      <div class="min-w-0 space-y-0.5">
        <p class="text-14-medium text-text-strong">{props.title}</p>
        <p class="text-12-regular text-text-weak">{props.description}</p>
      </div>
      <div class="flex shrink-0 items-center gap-2">{props.children}</div>
    </div>
  )
}

function TextInput(props: {
  value: string
  type?: "text" | "password"
  placeholder?: string
  onInput: (value: string) => void
}) {
  return (
    <input
      type={props.type ?? "text"}
      value={props.value}
      placeholder={props.placeholder}
      onInput={(event) => props.onInput(event.currentTarget.value)}
      class="w-[24rem] rounded-md border border-border-weak-base bg-surface-raised-base px-3 py-2 text-13-medium text-text-strong outline-none transition focus:border-border-strong-base"
      spellcheck={false}
    />
  )
}

export function SettingsDocumentEditor() {
  const platform = usePlatform()
  const [form, setForm] = createStore(defaultConfig())
  const [saving, setSaving] = createSignal(false)
  const [testing, setTesting] = createSignal(false)
  const [reconnecting, setReconnecting] = createSignal(false)

  const serviceFetch = async (path: string, init?: RequestInit) => {
    if (!platform.serviceUrl) {
      throw new Error("Desktop sidecar URL is unavailable.")
    }

    const url = new URL(path, `${platform.serviceUrl.replace(/\/+$/, "")}/`)
    const response = await (platform.fetch ?? window.fetch)(url, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    })
    return response
  }

  const loadConfig = async () => {
    const response = await serviceFetch("/api/integrations")
    const payload = await parseJson<{ editor?: Partial<EditorIntegrationConfig> }>(response)
    return {
      enabled: booleanValue(payload.editor?.enabled),
      documentServerUrl: fieldValue(payload.editor?.documentServerUrl),
      jwtSecret: fieldValue(payload.editor?.jwtSecret),
      callbackBaseUrl: fieldValue(payload.editor?.callbackBaseUrl),
      autoTunnelEnabled: booleanValue(payload.editor?.autoTunnelEnabled, true),
    } satisfies EditorIntegrationConfig
  }

  const loadTunnelStatus = async () => {
    const response = await serviceFetch("/api/editor/tunnel/status")
    return parseJson<TunnelStatus>(response)
  }

  const [configResource, configActions] = createResource(loadConfig)
  const [statusResource, statusActions] = createResource(loadTunnelStatus)

  createEffect(() => {
    const value = configResource()
    if (!value) return
    setForm(value)
  })

  const persistForm = async (options?: { notify?: boolean }) => {
    setSaving(true)
    try {
      const response = await serviceFetch("/api/integrations/editor", {
        method: "PUT",
        body: JSON.stringify(form),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(typeof payload.error === "string" ? payload.error : "Failed to save settings")
      }
      await configActions.refetch()
      await statusActions.refetch()
      if (options?.notify !== false) {
        showToast({
          variant: "success",
          title: "Document editor settings saved",
        })
      }
      return true
    } catch (error) {
      showToast({
        variant: "error",
        title: "Failed to save settings",
        description: error instanceof Error ? error.message : String(error),
      })
      return false
    } finally {
      setSaving(false)
    }
  }

  const save = async () => {
    await persistForm({ notify: true })
  }

  const testConnection = async () => {
    setTesting(true)
    try {
      const saved = await persistForm({ notify: false })
      if (!saved) return
      const response = await serviceFetch("/api/integrations/editor/test", { method: "POST" })
      const result = await parseJson<ServiceTestResult>(response)
      showToast({
        variant: result.success ? "success" : "error",
        title: result.success ? "Connection verified" : "Connection failed",
        description: result.message,
      })
      await statusActions.refetch()
    } catch (error) {
      showToast({
        variant: "error",
        title: "Connection test failed",
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setTesting(false)
    }
  }

  const reconnectTunnel = async () => {
    setReconnecting(true)
    try {
      const saved = await persistForm({ notify: false })
      if (!saved) return
      const response = await serviceFetch("/api/editor/tunnel/reconnect", { method: "POST" })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(typeof payload.error === "string" ? payload.error : "Failed to reconnect tunnel")
      }
      showToast({
        variant: "success",
        title: "Tunnel reconnected",
        description: typeof payload.callbackBaseUrl === "string" ? payload.callbackBaseUrl : undefined,
      })
      await statusActions.refetch()
    } catch (error) {
      showToast({
        variant: "error",
        title: "Tunnel reconnect failed",
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setReconnecting(false)
    }
  }

  const refreshStatus = () => {
    void configActions.refetch()
    void statusActions.refetch()
  }

  return (
    <div class="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-5">
      <div class="space-y-1">
        <h2 class="text-15-medium text-text-strong">Document Editor</h2>
        <p class="text-12-regular text-text-weak">
          Configure the hosted OnlyOffice Document Server, callback URL, and automatic tunnel used by desktop save
          callbacks.
        </p>
      </div>

      <div class="rounded-xl bg-surface-raised-base px-4">
        <SettingsRow
          title="Enable integration"
          description="Turn the desktop OnlyOffice integration on or off for supported office documents."
        >
          <Switch checked={form.enabled} onChange={(value) => setForm("enabled", value)} />
        </SettingsRow>

        <SettingsRow
          title="Document Server URL"
          description="Base URL of the hosted OnlyOffice Document Server that serves api.js and editor sessions."
        >
          <TextInput
            value={form.documentServerUrl}
            placeholder="https://docs.example.com"
            onInput={(value) => setForm("documentServerUrl", value)}
          />
        </SettingsRow>

        <SettingsRow
          title="JWT secret"
          description="Shared secret used to sign editor config, download, and callback tokens."
        >
          <TextInput
            type="password"
            value={form.jwtSecret}
            placeholder={REDACTED_SECRET}
            onInput={(value) => setForm("jwtSecret", value)}
          />
        </SettingsRow>

        <SettingsRow
          title="Callback Base URL"
          description="Optional public URL that the Document Server can reach for callback and download endpoints."
        >
          <TextInput
            value={form.callbackBaseUrl}
            placeholder="https://desktop-callback.example.com"
            onInput={(value) => setForm("callbackBaseUrl", value)}
          />
        </SettingsRow>

        <SettingsRow
          title="Auto tunnel"
          description="Automatically open a localtunnel callback URL when the Document Server is remote and no manual callback URL is set."
        >
          <Switch checked={form.autoTunnelEnabled} onChange={(value) => setForm("autoTunnelEnabled", value)} />
        </SettingsRow>
      </div>

      <div class="flex flex-wrap gap-2">
        <Button variant="primary" size="small" onClick={save} disabled={saving()}>
          {saving() ? "Saving…" : "Save settings"}
        </Button>
        <Button variant="secondary" size="small" onClick={testConnection} disabled={testing()}>
          {testing() ? "Testing…" : "Test connection"}
        </Button>
        <Button variant="ghost" size="small" onClick={reconnectTunnel} disabled={reconnecting()}>
          {reconnecting() ? "Reconnecting…" : "Reconnect tunnel"}
        </Button>
        <Button variant="ghost" size="small" onClick={refreshStatus}>
          Refresh status
        </Button>
      </div>

      <div class="rounded-xl bg-surface-raised-base px-4">
        <SettingsRow
          title="Transport mode"
          description="Current callback transport selected for the desktop OnlyOffice integration."
        >
          <span class="rounded-md bg-surface-secondary px-3 py-1 text-12-medium text-text-strong">
            {statusResource()?.mode ?? "loading"}
          </span>
        </SettingsRow>

        <SettingsRow
          title="Document Server host"
          description="The host used to decide whether callbacks can stay local or need a public callback URL."
        >
          <span class="max-w-[24rem] truncate text-12-medium text-text-strong">
            {statusResource()?.docHost ?? "Unavailable"}
          </span>
        </SettingsRow>

        <SettingsRow
          title="Callback endpoint"
          description="The callback URL currently configured or generated for OnlyOffice save callbacks."
        >
          <span class="max-w-[24rem] truncate text-12-medium text-text-strong">
            {statusResource()?.callbackBaseUrl ?? statusResource()?.tunnel?.publicUrl ?? "Not configured"}
          </span>
        </SettingsRow>

        <SettingsRow
          title="Tunnel state"
          description="Health of the localtunnel callback bridge used in remote Document Server mode."
        >
          <div class="flex max-w-[24rem] flex-col items-end gap-1 text-right">
            <span class="text-12-medium text-text-strong">{statusResource()?.tunnel?.status ?? "idle"}</span>
            <Show when={statusResource()?.tunnel?.publicUrl}>
              {(url) => <span class="text-11-regular text-text-weak">{url()}</span>}
            </Show>
            <Show when={statusResource()?.tunnel?.lastError}>
              {(message) => <span class="text-11-regular text-text-danger">{message()}</span>}
            </Show>
          </div>
        </SettingsRow>
      </div>

      <SolidSwitch>
        <Match when={configResource.error}>
          <p class="text-12-regular text-text-danger">
            {configResource.error instanceof Error ? configResource.error.message : String(configResource.error)}
          </p>
        </Match>
        <Match when={statusResource.error}>
          <p class="text-12-regular text-text-danger">
            {statusResource.error instanceof Error ? statusResource.error.message : String(statusResource.error)}
          </p>
        </Match>
      </SolidSwitch>
    </div>
  )
}
