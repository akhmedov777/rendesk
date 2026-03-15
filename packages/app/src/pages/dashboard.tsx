import type { Dashboard, DashboardFilterState, DashboardWidget } from "@rendesk/sdk/v2/client"
import { Button } from "@rendesk/ui/button"
import { Dialog } from "@rendesk/ui/dialog"
import { IconButton } from "@rendesk/ui/icon-button"
import { Select } from "@rendesk/ui/select"
import { Tag } from "@rendesk/ui/tag"
import { TextField } from "@rendesk/ui/text-field"
import { VisualizationCard } from "@rendesk/ui/visualization"
import { useNavigate, useParams, Navigate } from "@solidjs/router"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter, createSortable } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@rendesk/ui/context/dialog"
import { showToast } from "@rendesk/ui/toast"
import { useData } from "@rendesk/ui/context"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { VisualizationPreviewDialog } from "@/features/dashboard/dialog-visualization-preview"
import {
  branchValueForDirectory,
  DASHBOARD_PRESET_LABELS,
  dashboardHref,
  relativeTimeLabel,
  reorderIds,
  sourceMessageHref,
  sourceModeLabel,
} from "@/features/dashboard/helpers"

type Option = {
  value: string
  label: string
}

function DashboardTitleDialog(props: { title: string; actionLabel: string; onSave: (title: string) => Promise<void> }) {
  const dialog = useDialog()
  const [value, setValue] = createSignal(props.title)
  const [saving, setSaving] = createSignal(false)

  const save = async () => {
    if (!value().trim() || saving()) return
    setSaving(true)
    try {
      await props.onSave(value().trim())
      dialog.close()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title={props.actionLabel}>
      <div class="flex flex-col gap-4">
        <TextField label="Dashboard name" value={value()} onInput={(event) => setValue(event.currentTarget.value)} autofocus />
        <div class="flex justify-end">
          <Button variant="primary" disabled={!value().trim() || saving()} onClick={() => void save()}>
            {saving() ? "Saving…" : props.actionLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function SortableDashboardWidget(props: {
  directory: string
  widget: DashboardWidget
  onRefresh: (widgetID: string) => Promise<void>
  onRemove: (widgetID: string) => Promise<void>
  onPresetChange: (widgetID: string, preset: string) => Promise<void>
  onOpenSource: (href: string) => void
  onExpand: (widget: DashboardWidget) => void
}) {
  const sortable = createSortable(props.widget.id)
  const presetOptions: Option[] = Object.entries(DASHBOARD_PRESET_LABELS).map(([value, label]) => ({ value, label }))
  const currentPreset = createMemo(() => presetOptions.find((option) => option.value === props.widget.layout.preset))
  const sourceHref = () => sourceMessageHref(props.directory, props.widget.source.origin)

  return (
    <div
      // @ts-ignore
      use:sortable
      class="min-w-0"
      classList={{
        "opacity-50": sortable.isActiveDraggable,
      }}
      style={{
        "grid-column": `span ${props.widget.layout.colSpan} / span ${props.widget.layout.colSpan}`,
      }}
    >
      <VisualizationCard
        visualization={props.widget.visualization}
        meta={
          <>
            <Tag>{sourceModeLabel(props.widget.source)}</Tag>
            <Tag>{relativeTimeLabel(props.widget.time.refreshed)}</Tag>
            <Show when={props.widget.refreshStatus === "error" && props.widget.refreshError}>
              <Tag>{props.widget.refreshError}</Tag>
            </Show>
          </>
        }
        actions={
          <>
            <Select
              options={presetOptions}
              current={currentPreset()}
              value={(item) => item.value}
              label={(item) => item.label}
              onSelect={(item) => item && void props.onPresetChange(props.widget.id, item.value)}
              size="small"
              variant="secondary"
              placeholder="Size"
            />
            <IconButton
              icon="expand"
              variant="secondary"
              aria-label="Expand visualization"
              onClick={() => props.onExpand(props.widget)}
            />
            <Show when={props.widget.source.mode === "workspace_query"}>
              <Button size="small" variant="secondary" onClick={() => void props.onRefresh(props.widget.id)}>
                Refresh
              </Button>
            </Show>
            <Show when={sourceHref()}>
              {(href) => (
                <Button size="small" variant="secondary" onClick={() => props.onOpenSource(href())}>
                  Source
                </Button>
              )}
            </Show>
            <IconButton icon="trash" variant="ghost" onClick={() => void props.onRemove(props.widget.id)} />
          </>
        }
      />
    </div>
  )
}

export default function DashboardPage() {
  const platform = usePlatform()
  const sdk = useSDK()
  const data = useData()
  const dialog = useDialog()
  const navigate = useNavigate()
  const params = useParams()
  const [activeWidgetID, setActiveWidgetID] = createSignal<string>()
  const [store, setStore] = createStore({
    status: "loading" as "loading" | "ready" | "error",
    error: "",
    dashboards: [] as Dashboard[],
    current: undefined as Dashboard | undefined,
    lastUsedDashboardID: undefined as string | undefined,
    refreshing: false,
  })

  const supported = createMemo(() => platform.platform === "desktop" && platform.capabilities?.dashboard === true)

  if (!supported()) {
    return <Navigate href={`/${params.dir}/session`} />
  }

  const listResult = async () => {
    const result = (await sdk.client.dashboard.list({ directory: sdk.directory })) as {
      data?: { dashboards?: Dashboard[]; lastUsedDashboardID?: string }
    }
    return result.data ?? { dashboards: [] }
  }

  const loadDashboards = async () => {
    setStore("status", "loading")
    try {
      const result = await listResult()
      setStore("dashboards", result.dashboards ?? [])
      setStore("lastUsedDashboardID", result.lastUsedDashboardID)
      if (!params.dashboardId) {
        const first = result.dashboards?.[0]
        if (first) {
          navigate(dashboardHref(sdk.directory, first.id), { replace: true })
          return
        }
        setStore("current", undefined)
        setStore("status", "ready")
        return
      }
      const current = result.dashboards?.find((dashboard) => dashboard.id === params.dashboardId)
      if (!current) {
        const first = result.dashboards?.[0]
        if (first) {
          navigate(dashboardHref(sdk.directory, first.id), { replace: true })
          return
        }
        setStore("current", undefined)
        setStore("status", "ready")
        return
      }
      setStore("current", current)
      setStore("status", "ready")
      void refreshLiveWidgets(current)
    } catch (error) {
      setStore("status", "error")
      setStore("error", error instanceof Error ? error.message : String(error))
    }
  }

  const createDashboard = () => {
    dialog.show(() => (
      <DashboardTitleDialog
        title="Workspace overview"
        actionLabel="Create dashboard"
        onSave={async (title) => {
          const result = (await sdk.client.dashboard.create({ directory: sdk.directory, title })) as { data?: Dashboard }
          const dashboard = result.data
          if (!dashboard) return
          await loadDashboards()
          navigate(dashboardHref(sdk.directory, dashboard.id))
        }}
      />
    ))
  }

  const renameDashboard = () => {
    const dashboard = store.current
    if (!dashboard) return
    dialog.show(() => (
      <DashboardTitleDialog
        title={dashboard.title}
        actionLabel="Rename dashboard"
        onSave={async (title) => {
          await sdk.client.dashboard.update({
            directory: sdk.directory,
            dashboardID: dashboard.id,
            title,
          })
          await loadDashboards()
        }}
      />
    ))
  }

  const deleteDashboard = async () => {
    const dashboard = store.current
    if (!dashboard) return
    if (!window.confirm(`Delete "${dashboard.title}"?`)) return
    await sdk.client.dashboard.delete({
      directory: sdk.directory,
      dashboardID: dashboard.id,
    })
    await loadDashboards()
    navigate(dashboardHref(sdk.directory))
  }

  const refreshWidget = async (widgetID: string) => {
    const dashboard = store.current
    if (!dashboard) return
    const result = (await sdk.client.dashboard.widget.refresh({
      directory: sdk.directory,
      dashboardID: dashboard.id,
      widgetID,
      filters: dashboard.filters,
    })) as { data?: DashboardWidget }
    if (!result.data) return
    setStore("current", "widgets", (widgets) => widgets.map((widget) => (widget.id === widgetID ? result.data! : widget)))
  }

  const refreshLiveWidgets = async (dashboard: Dashboard) => {
    const live = dashboard.widgets.filter((widget) => widget.source.mode === "workspace_query")
    if (live.length === 0) return
    setStore("refreshing", true)
    try {
      await Promise.all(live.map((widget) => refreshWidget(widget.id)))
    } finally {
      setStore("refreshing", false)
    }
  }

  const updateFilters = async (patch: Partial<DashboardFilterState>) => {
    const dashboard = store.current
    if (!dashboard) return
    const next = { ...dashboard.filters, ...patch }
    setStore("current", "filters", next)
    await sdk.client.dashboard.update({
      directory: sdk.directory,
      dashboardID: dashboard.id,
      filters: next,
    })
    await refreshLiveWidgets({ ...dashboard, filters: next })
  }

  const removeWidget = async (widgetID: string) => {
    const dashboard = store.current
    if (!dashboard) return
    await sdk.client.dashboard.widget.remove({
      directory: sdk.directory,
      dashboardID: dashboard.id,
      widgetID,
    })
    setStore("current", "widgets", (widgets) => widgets.filter((widget) => widget.id !== widgetID))
    showToast({ title: "Widget removed" })
  }

  const updateWidgetPreset = async (widgetID: string, preset: string) => {
    const dashboard = store.current
    if (!dashboard) return
    await sdk.client.dashboard.widget.update({
      directory: sdk.directory,
      dashboardID: dashboard.id,
      widgetID,
      layout: { preset },
    })
    await loadDashboards()
  }

  const openSource = (href: string) => {
    navigate(href)
  }

  const openWidgetPreview = (widget: DashboardWidget) => {
    const sourceHref = sourceMessageHref(sdk.directory, widget.source.origin)
    dialog.show(() => (
      <VisualizationPreviewDialog
        visualization={widget.visualization}
        meta={
          <>
            <Tag>{sourceModeLabel(widget.source)}</Tag>
            <Tag>{relativeTimeLabel(widget.time.refreshed)}</Tag>
            <Show when={widget.refreshStatus === "error" && widget.refreshError}>
              <Tag>{widget.refreshError}</Tag>
            </Show>
          </>
        }
        actions={
          <>
            <Show when={widget.source.mode === "workspace_query"}>
              <Button size="small" variant="secondary" onClick={() => void refreshWidget(widget.id)}>
                Refresh
              </Button>
            </Show>
            <Show when={sourceHref}>
              {(href) => (
                <Button size="small" variant="secondary" onClick={() => openSource(href())}>
                  Source
                </Button>
              )}
            </Show>
          </>
        }
      />
    ))
  }

  const handleDragEnd = async (event: DragEvent) => {
    const dashboard = store.current
    if (!dashboard) return
    const from = typeof event.draggable.id === "string" ? event.draggable.id : undefined
    const to = typeof event.droppable?.id === "string" ? event.droppable.id : undefined
    setActiveWidgetID(undefined)
    if (!from || !to || from === to) return
    const nextIDs = reorderIds(
      dashboard.widgets.map((widget) => widget.id),
      from,
      to,
    )
    setStore("current", "widgets", (widgets) =>
      nextIDs
        .map((id) => widgets.find((widget) => widget.id === id))
        .filter((widget): widget is DashboardWidget => !!widget),
    )
    await sdk.client.dashboard.widget.reorder({
      directory: sdk.directory,
      dashboardID: dashboard.id,
      widgetIDs: nextIDs,
    })
  }

  const workspaceOptions = createMemo<Option[]>(() => {
    const dirs = [...new Set(data.store.session.map((session) => session.directory))]
    return [{ value: "", label: "All workspaces" }, ...dirs.map((directory) => ({ value: directory, label: directory }))]
  })

  const branchOptions = createMemo<Option[]>(() => {
    const branches = [...new Set(data.store.session.map((session) => branchValueForDirectory(session.directory)))]
    return [{ value: "", label: "All branches" }, ...branches.map((value) => ({ value, label: value }))]
  })

  const agentOptions = createMemo<Option[]>(() => {
    const agents = new Set<string>()
    for (const messages of Object.values(data.store.message)) {
      for (const message of messages ?? []) {
        if (message.role === "user" && message.agent) agents.add(message.agent)
        if (message.role === "assistant" && message.agent) agents.add(message.agent)
      }
    }
    return [{ value: "", label: "All agents" }, ...[...agents].sort().map((value) => ({ value, label: value }))]
  })

  const providerOptions = createMemo<Option[]>(() => {
    const providers = new Set<string>()
    for (const messages of Object.values(data.store.message)) {
      for (const message of messages ?? []) {
        if (message.role === "assistant" && message.providerID) providers.add(message.providerID)
      }
    }
    return [{ value: "", label: "All providers" }, ...[...providers].sort().map((value) => ({ value, label: value }))]
  })

  const modelOptions = createMemo<Option[]>(() => {
    const models = new Set<string>()
    for (const messages of Object.values(data.store.message)) {
      for (const message of messages ?? []) {
        if (message.role === "assistant" && message.modelID) models.add(message.modelID)
      }
    }
    return [{ value: "", label: "All models" }, ...[...models].sort().map((value) => ({ value, label: value }))]
  })

  const dateOptions: Option[] = [
    { value: "24h", label: "24h" },
    { value: "7d", label: "7d" },
    { value: "30d", label: "30d" },
    { value: "90d", label: "90d" },
    { value: "all", label: "All" },
  ]

  const currentWorkspace = createMemo(() => workspaceOptions().find((option) => option.value === (store.current?.filters.workspace ?? "")))
  const currentBranch = createMemo(() => branchOptions().find((option) => option.value === (store.current?.filters.branch ?? "")))
  const currentAgent = createMemo(() => agentOptions().find((option) => option.value === (store.current?.filters.agent ?? "")))
  const currentProvider = createMemo(() =>
    providerOptions().find((option) => option.value === (store.current?.filters.providerID ?? "")),
  )
  const currentModel = createMemo(() => modelOptions().find((option) => option.value === (store.current?.filters.modelID ?? "")))
  const currentDate = createMemo(() => dateOptions.find((option) => option.value === (store.current?.filters.datePreset ?? "30d")))

  createEffect(() => {
    sdk.directory
    params.dashboardId
    void loadDashboards()
  })

  return (
    <Switch>
      <Match when={store.status === "loading"}>
        <div class="flex size-full items-center justify-center text-14-regular text-text-weak">Loading dashboard…</div>
      </Match>
      <Match when={store.status === "error"}>
        <div class="flex size-full items-center justify-center text-14-regular text-text-weak">{store.error}</div>
      </Match>
      <Match when={!store.current && store.dashboards.length === 0}>
        <div class="flex size-full flex-col items-center justify-center gap-4 px-6 text-center">
          <div class="text-28-semibold text-text-strong">No dashboards yet</div>
          <div class="max-w-xl text-14-regular text-text-weak">
            Save a visualization from chat or create a dashboard now to start tracking workspace telemetry.
          </div>
          <Button variant="primary" onClick={createDashboard}>
            Create dashboard
          </Button>
        </div>
      </Match>
      <Match when={true}>
        <div class="flex size-full min-h-0">
          <aside class="hidden w-[280px] shrink-0 border-r border-border-weak-base bg-background-stronger px-4 py-5 lg:flex lg:flex-col">
            <div class="flex items-center justify-between">
              <div class="text-12-medium uppercase tracking-[0.08em] text-text-weak">Dashboards</div>
              <Button size="small" variant="primary" onClick={createDashboard}>
                New
              </Button>
            </div>
            <div class="mt-4 flex flex-1 flex-col gap-2 overflow-y-auto">
              <For each={store.dashboards}>
                {(dashboard) => (
                  <button
                    class="rounded-2xl border px-3 py-3 text-left transition-colors"
                    classList={{
                      "border-border-weak-base bg-background-base hover:bg-background-stronger": store.current?.id !== dashboard.id,
                      "border-border-strong-base bg-background-base": store.current?.id === dashboard.id,
                    }}
                    onClick={() => navigate(dashboardHref(sdk.directory, dashboard.id))}
                  >
                    <div class="truncate text-14-medium text-text-strong">{dashboard.title}</div>
                    <div class="pt-1 text-12-regular text-text-weak">{dashboard.widgets.length} widgets</div>
                  </button>
                )}
              </For>
            </div>
          </aside>

          <div class="flex min-h-0 flex-1 flex-col">
            <div class="border-b border-border-weak-base px-6 py-5">
              <div class="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div class="text-30-semibold text-text-strong">{store.current?.title ?? "Dashboard"}</div>
                  <div class="pt-2 text-13-regular text-text-weak">
                    {store.current?.widgets.length ?? 0} widgets · {store.refreshing ? "Refreshing live data" : "Ready"}
                  </div>
                </div>
                <div class="flex items-center gap-2">
                  <Button variant="secondary" onClick={renameDashboard}>
                    Rename
                  </Button>
                  <Button variant="secondary" onClick={() => store.current && void refreshLiveWidgets(store.current)}>
                    Refresh live widgets
                  </Button>
                  <Button variant="secondary" onClick={() => void deleteDashboard()}>
                    Delete
                  </Button>
                </div>
              </div>
            </div>

            <div class="sticky top-0 z-10 border-b border-border-weaker-base bg-background-base/95 px-6 py-4 backdrop-blur">
              <div class="grid gap-3 lg:grid-cols-6">
                <Select
                  options={dateOptions}
                  current={currentDate()}
                  value={(item) => item.value}
                  label={(item) => item.label}
                  onSelect={(item) => item && void updateFilters({ datePreset: item.value as DashboardFilterState["datePreset"] })}
                  size="large"
                  variant="secondary"
                />
                <Select
                  options={agentOptions()}
                  current={currentAgent()}
                  value={(item) => item.value}
                  label={(item) => item.label}
                  onSelect={(item) => void updateFilters({ agent: item?.value ?? null })}
                  size="large"
                  variant="secondary"
                  placeholder="All agents"
                />
                <Select
                  options={providerOptions()}
                  current={currentProvider()}
                  value={(item) => item.value}
                  label={(item) => item.label}
                  onSelect={(item) => void updateFilters({ providerID: item?.value ?? null })}
                  size="large"
                  variant="secondary"
                  placeholder="All providers"
                />
                <Select
                  options={modelOptions()}
                  current={currentModel()}
                  value={(item) => item.value}
                  label={(item) => item.label}
                  onSelect={(item) => void updateFilters({ modelID: item?.value ?? null })}
                  size="large"
                  variant="secondary"
                  placeholder="All models"
                />
                <Select
                  options={workspaceOptions()}
                  current={currentWorkspace()}
                  value={(item) => item.value}
                  label={(item) => item.label}
                  onSelect={(item) => void updateFilters({ workspace: item?.value ?? null })}
                  size="large"
                  variant="secondary"
                  placeholder="Workspace scope"
                />
                <Select
                  options={branchOptions()}
                  current={currentBranch()}
                  value={(item) => item.value}
                  label={(item) => item.label}
                  onSelect={(item) => void updateFilters({ branch: item?.value ?? null })}
                  size="large"
                  variant="secondary"
                  placeholder="Branch scope"
                />
              </div>
            </div>

            <div class="flex-1 overflow-y-auto px-6 py-6">
              <Show
                when={store.current}
                fallback={<div class="text-14-regular text-text-weak">Choose a dashboard.</div>}
              >
                {(dashboard) => (
                  <Show
                    when={dashboard().widgets.length > 0}
                    fallback={
                      <div class="rounded-[28px] border border-dashed border-border-weak-base bg-background-stronger px-6 py-10 text-center text-14-regular text-text-weak">
                        This dashboard is empty. Save a visualization from chat to start populating it.
                      </div>
                    }
                  >
                    <DragDropProvider
                      collisionDetector={closestCenter}
                      onDragStart={(event) => {
                        if (typeof event.draggable.id === "string") setActiveWidgetID(event.draggable.id)
                      }}
                      onDragEnd={(event) => void handleDragEnd(event)}
                    >
                      <DragDropSensors />
                      <div class="grid grid-cols-12 gap-4">
                        <SortableProvider ids={dashboard().widgets.map((widget) => widget.id)}>
                          <For each={dashboard().widgets}>
                            {(widget) => (
                              <SortableDashboardWidget
                                directory={sdk.directory}
                                widget={widget}
                              onRefresh={refreshWidget}
                              onRemove={removeWidget}
                              onPresetChange={updateWidgetPreset}
                              onOpenSource={openSource}
                              onExpand={openWidgetPreview}
                            />
                          )}
                        </For>
                        </SortableProvider>
                      </div>
                      <DragOverlay>
                        <Show when={activeWidgetID()}>
                          {(widgetID) => {
                            const widget = dashboard().widgets.find((item) => item.id === widgetID())
                            return widget ? <VisualizationCard visualization={widget.visualization} /> : null
                          }}
                        </Show>
                      </DragOverlay>
                    </DragDropProvider>
                  </Show>
                )}
              </Show>
            </div>
          </div>
        </div>
      </Match>
    </Switch>
  )
}
