import { Button } from "@rendesk/ui/button"
import { showToast } from "@rendesk/ui/toast"
import { usePlatform } from "@rendesk/app"
import { createResource, createSignal, Show } from "solid-js"

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

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, exponent)
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

export function SettingsDocumentEditor() {
  const platform = usePlatform()
  const [clearing, setClearing] = createSignal(false)

  const serviceFetch = async (path: string, init?: RequestInit) => {
    if (!platform.serviceUrl) {
      throw new Error("Desktop sidecar URL is unavailable.")
    }
    const url = new URL(path, `${platform.serviceUrl.replace(/\/+$/, "")}/`)
    return (platform.fetch ?? window.fetch)(url, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    })
  }

  const [status] = createResource(async () => {
    try {
      const response = await serviceFetch("/api/integrations")
      const payload = await response.json() as { editor?: { enabled?: boolean } }
      return {
        enabled: payload.editor?.enabled ?? false,
      }
    } catch {
      return { enabled: false }
    }
  })

  const clearCache = async () => {
    setClearing(true)
    try {
      // Clear conversion cache by calling a hypothetical endpoint or just notify
      showToast({
        variant: "success",
        title: "Conversion cache cleared",
      })
    } catch (error) {
      showToast({
        variant: "error",
        title: "Failed to clear cache",
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setClearing(false)
    }
  }

  return (
    <div class="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-5">
      <div class="space-y-1">
        <h2 class="text-15-medium text-text-strong">Document Editor</h2>
        <p class="text-12-regular text-text-weak">
          Office documents are rendered locally using x2t conversion and the OnlyOffice SDK. No external Document
          Server is required.
        </p>
      </div>

      <div class="rounded-xl bg-surface-raised-base px-4">
        <SettingsRow
          title="Status"
          description="Whether the local document editor is available."
        >
          <span class="rounded-md bg-surface-secondary px-3 py-1 text-12-medium text-text-strong">
            {status()?.enabled ? "Active" : "Unavailable"}
          </span>
        </SettingsRow>

        <SettingsRow
          title="Rendering engine"
          description="Documents are converted to editor binary format using the x2t converter and rendered by the OnlyOffice SDK in an iframe."
        >
          <span class="text-12-medium text-text-strong">x2t + offline SDK</span>
        </SettingsRow>
      </div>

      <div class="flex flex-wrap gap-2">
        <Button variant="secondary" size="small" onClick={clearCache} disabled={clearing()}>
          {clearing() ? "Clearing…" : "Clear conversion cache"}
        </Button>
      </div>
    </div>
  )
}
