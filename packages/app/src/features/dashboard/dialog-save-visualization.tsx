import type { Dashboard, DashboardListResult } from "@rendesk/sdk/v2/client"
import { Button } from "@rendesk/ui/button"
import { Dialog } from "@rendesk/ui/dialog"
import { Select } from "@rendesk/ui/select"
import { TextField } from "@rendesk/ui/text-field"
import { createEffect, createResource, createSignal, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"

type SaveVisualizationDialogProps = {
  title?: string
  loadDashboards: () => Promise<DashboardListResult>
  onSave: (input: { dashboardID?: string; createTitle?: string; widgetTitle?: string }) => Promise<void>
}

type Option = {
  value: string
  label: string
}

export function SaveVisualizationDialog(props: SaveVisualizationDialogProps) {
  const [resource] = createResource(props.loadDashboards)
  const [saving, setSaving] = createSignal(false)
  const [store, setStore] = createStore({
    mode: "select" as "select" | "create",
    dashboardID: "",
    createTitle: "",
    widgetTitle: props.title ?? "",
  })

  const dashboards = () => resource()?.dashboards ?? []
  const options = (): Option[] => dashboards().map((dashboard) => ({ value: dashboard.id, label: dashboard.title }))
  const lastUsed = () => resource()?.lastUsedDashboardID
  const currentDashboard = () => options().find((option) => option.value === store.dashboardID)

  const ensureMode = () => {
    const list = dashboards()
    if (list.length === 0 && store.mode !== "create") {
      setStore("mode", "create")
      return
    }
    if (list.length > 0 && store.mode === "select" && !store.dashboardID) {
      setStore("dashboardID", lastUsed() ?? list[0]!.id)
    }
  }

  createEffect(() => {
    resource()
    ensureMode()
  })

  const save = async () => {
    if (saving()) return
    setSaving(true)
    try {
      await props.onSave({
        dashboardID: store.mode === "select" ? store.dashboardID || undefined : undefined,
        createTitle: store.mode === "create" ? store.createTitle.trim() : undefined,
        widgetTitle: store.widgetTitle.trim() || undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title="Save visualization" size="large">
      <div class="flex flex-col gap-5">
        <div class="grid gap-2 sm:grid-cols-2">
          <Button
            variant={store.mode === "select" ? "primary" : "secondary"}
            disabled={dashboards().length === 0}
            onClick={() => setStore("mode", "select")}
          >
            Add to dashboard
          </Button>
          <Button variant={store.mode === "create" ? "primary" : "secondary"} onClick={() => setStore("mode", "create")}>
            Create dashboard
          </Button>
        </div>

        <Switch>
          <Match when={resource.loading}>
            <div class="text-13-regular text-text-weak">Loading dashboards…</div>
          </Match>
          <Match when={resource.error}>
            <div class="text-13-regular text-text-weak">Failed to load dashboards.</div>
          </Match>
          <Match when={store.mode === "select"}>
            <Show
              when={dashboards().length > 0}
              fallback={<div class="text-13-regular text-text-weak">No dashboards yet. Create one to continue.</div>}
            >
              <Select
                options={options()}
                current={currentDashboard()}
                value={(item) => item.value}
                label={(item) => item.label}
                onSelect={(item) => setStore("dashboardID", item?.value ?? "")}
                size="large"
                variant="secondary"
                placeholder="Choose a dashboard"
              />
            </Show>
          </Match>
          <Match when={true}>
            <TextField
              label="Dashboard name"
              value={store.createTitle}
              onInput={(event) => setStore("createTitle", event.currentTarget.value)}
              placeholder="Revenue board"
              autofocus
            />
          </Match>
        </Switch>

        <TextField
          label="Widget title"
          value={store.widgetTitle}
          onInput={(event) => setStore("widgetTitle", event.currentTarget.value)}
          placeholder={props.title ?? "Optional override"}
        />

        <div class="flex items-center justify-end gap-2">
          <Button
            variant="primary"
            disabled={
              saving() ||
              (store.mode === "select" && !store.dashboardID) ||
              (store.mode === "create" && !store.createTitle.trim())
            }
            onClick={() => void save()}
          >
            {saving() ? "Saving…" : "Save widget"}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
