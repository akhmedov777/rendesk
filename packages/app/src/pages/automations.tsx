import type { Automation, AutomationRun, AutomationStatus } from "@rendesk/sdk/v2/client"
import { Button } from "@rendesk/ui/button"
import { Dialog } from "@rendesk/ui/dialog"
import { Tag } from "@rendesk/ui/tag"
import { TextField } from "@rendesk/ui/text-field"
import { showToast } from "@rendesk/ui/toast"
import { Navigate, useLocation, useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@rendesk/ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import {
  automationsHref,
  automationRunStatusLabel,
  automationStatusLabel,
  dateTimeLabel,
  relativeTimeLabel,
} from "@/features/automations/helpers"
import { AUTOMATION_TEMPLATES } from "@/features/automations/templates"

type AutomationEditorInput = {
  name: string
  prompt: string
  cron: string
  timezone: string
  status: AutomationStatus
  templateID?: string
}

function AutomationEditorDialog(props: {
  mode: "create" | "edit"
  initial: AutomationEditorInput
  onSave: (input: AutomationEditorInput) => Promise<void>
}) {
  const dialog = useDialog()
  const [templateID, setTemplateID] = createSignal(props.initial.templateID ?? AUTOMATION_TEMPLATES[0]?.id ?? "")
  const [name, setName] = createSignal(props.initial.name)
  const [prompt, setPrompt] = createSignal(props.initial.prompt)
  const [cron, setCron] = createSignal(props.initial.cron)
  const [timezone, setTimezone] = createSignal(props.initial.timezone)
  const [status, setStatus] = createSignal<AutomationStatus>(props.initial.status)
  const [saving, setSaving] = createSignal(false)

  const title = createMemo(() => (props.mode === "create" ? "Create automation" : "Edit automation"))

  const applyTemplate = (nextTemplateID: string) => {
    setTemplateID(nextTemplateID)
    if (props.mode !== "create") return
    const template = AUTOMATION_TEMPLATES.find((entry) => entry.id === nextTemplateID)
    if (!template) return
    setName(template.name)
    setPrompt(template.prompt)
    setCron(template.cron)
  }

  const save = async () => {
    if (saving()) return
    setSaving(true)
    try {
      await props.onSave({
        name: name().trim(),
        prompt: prompt().trim(),
        cron: cron().trim(),
        timezone: timezone().trim(),
        status: status(),
        templateID: templateID() || undefined,
      })
      dialog.close()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title={title()}>
      <div class="flex max-w-2xl flex-col gap-4">
        <Show when={props.mode === "create"}>
          <label class="flex flex-col gap-1 text-12-medium text-text-weak">
            Template
            <select
              class="h-9 rounded-lg border border-border-weak-base bg-background-base px-3 text-13-regular text-text-strong"
              value={templateID()}
              onChange={(event) => applyTemplate(event.currentTarget.value)}
            >
              <For each={AUTOMATION_TEMPLATES}>
                {(template) => <option value={template.id}>{template.name}</option>}
              </For>
            </select>
          </label>
        </Show>

        <TextField label="Name" value={name()} onInput={(event) => setName(event.currentTarget.value)} autofocus />

        <label class="flex flex-col gap-1 text-12-medium text-text-weak">
          Prompt
          <textarea
            rows={6}
            class="rounded-lg border border-border-weak-base bg-background-base px-3 py-2 text-13-regular text-text-strong"
            value={prompt()}
            onInput={(event) => setPrompt(event.currentTarget.value)}
          />
        </label>

        <div class="grid gap-3 sm:grid-cols-2">
          <TextField label="Cron" value={cron()} onInput={(event) => setCron(event.currentTarget.value)} />
          <TextField label="Timezone" value={timezone()} onInput={(event) => setTimezone(event.currentTarget.value)} />
        </div>

        <label class="flex flex-col gap-1 text-12-medium text-text-weak">
          Status
          <select
            class="h-9 rounded-lg border border-border-weak-base bg-background-base px-3 text-13-regular text-text-strong"
            value={status()}
            onChange={(event) => setStatus(event.currentTarget.value as AutomationStatus)}
          >
            <option value="active">Active</option>
            <option value="paused">Paused</option>
          </select>
        </label>

        <div class="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name().trim() || !prompt().trim() || !cron().trim() || !timezone().trim() || saving()}
            onClick={() => void save()}
          >
            {saving() ? "Saving…" : props.mode === "create" ? "Create" : "Save"}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

const runStatusClass = (status: AutomationRun["status"]) => {
  if (status === "success") return "text-icon-success"
  if (status === "failed") return "text-icon-danger"
  if (status === "running") return "text-icon-info"
  if (status === "skipped_lock") return "text-icon-warning"
  return "text-text-weak"
}

export default function AutomationsPage() {
  const sdk = useSDK()
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const navigate = useNavigate()
  const params = useParams()
  const location = useLocation()
  const dialog = useDialog()

  const [state, setState] = createStore({
    status: "loading" as "loading" | "ready" | "error",
    error: "",
    loadingRuns: false,
    automations: [] as Automation[],
    runs: [] as AutomationRun[],
    selectedAutomation: undefined as Automation | undefined,
    selectedRun: undefined as AutomationRun | undefined,
    search: "",
    statusFilter: "all" as AutomationStatus | "all",
  })

  const supported = createMemo(() => platform.platform === "desktop" && platform.capabilities?.automations !== false)
  const selectedRunFromQuery = createMemo(() => new URLSearchParams(location.search).get("run") ?? "")

  if (!supported()) {
    return <Navigate href={`/${params.dir}/session`} />
  }

  const loadRuns = async (automationID: string) => {
    setState("loadingRuns", true)
    try {
      const response = (await sdk.client.automation.runList({
        directory: sdk.directory,
        automationID,
        limit: 200,
      })) as { data?: AutomationRun[] }
      const runs = response.data ?? []
      setState("runs", runs)
      const selected = selectedRunFromQuery() ? runs.find((run) => run.id === selectedRunFromQuery()) : undefined
      setState("selectedRun", selected ?? runs[0])
    } finally {
      setState("loadingRuns", false)
    }
  }

  const loadAutomations = async () => {
    setState("status", "loading")
    try {
      const response = (await sdk.client.automation.list({
        directory: sdk.directory,
        search: state.search || undefined,
        status: state.statusFilter,
      })) as { data?: { automations?: Automation[] } }
      const automations = response.data?.automations ?? []
      setState("automations", automations)

      const routeAutomationID = params.automationId
      const current = routeAutomationID ? automations.find((automation) => automation.id === routeAutomationID) : automations[0]
      if (!routeAutomationID && current) {
        navigate(automationsHref(sdk.directory, current.id), { replace: true })
      }
      if (!current) {
        setState("selectedAutomation", undefined)
        setState("runs", [])
        setState("selectedRun", undefined)
        setState("status", "ready")
        return
      }

      setState("selectedAutomation", current)
      await loadRuns(current.id)
      setState("status", "ready")
    } catch (error) {
      setState("status", "error")
      setState("error", error instanceof Error ? error.message : String(error))
    }
  }

  const openCreateDialog = () => {
    const fallbackTemplate = AUTOMATION_TEMPLATES[0]
    dialog.show(() => (
      <AutomationEditorDialog
        mode="create"
        initial={{
          name: fallbackTemplate?.name ?? "Automation",
          prompt: fallbackTemplate?.prompt ?? "",
          cron: fallbackTemplate?.cron ?? "0 * * * *",
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          status: "active",
          templateID: fallbackTemplate?.id,
        }}
        onSave={async (input) => {
          const response = (await sdk.client.automation.create({
            directory: sdk.directory,
            ...input,
          })) as { data?: Automation }
          const created = response.data
          await loadAutomations()
          if (created) {
            navigate(automationsHref(sdk.directory, created.id))
          }
          showToast({ title: "Automation created" })
        }}
      />
    ))
  }

  const openEditDialog = () => {
    const automation = state.selectedAutomation
    if (!automation) return
    dialog.show(() => (
      <AutomationEditorDialog
        mode="edit"
        initial={{
          name: automation.name,
          prompt: automation.prompt,
          cron: automation.cron,
          timezone: automation.timezone,
          status: automation.status,
          templateID: automation.templateID,
        }}
        onSave={async (input) => {
          await sdk.client.automation.update({
            directory: sdk.directory,
            automationID: automation.id,
            ...input,
          })
          await loadAutomations()
          showToast({ title: "Automation updated" })
        }}
      />
    ))
  }

  const togglePauseResume = async () => {
    const automation = state.selectedAutomation
    if (!automation) return
    await sdk.client.automation.update({
      directory: sdk.directory,
      automationID: automation.id,
      status: automation.status === "active" ? "paused" : "active",
    })
    await loadAutomations()
    showToast({ title: automation.status === "active" ? "Automation paused" : "Automation resumed" })
  }

  const runNow = async () => {
    const automation = state.selectedAutomation
    if (!automation) return
    await sdk.client.automation.run({
      directory: sdk.directory,
      automationID: automation.id,
    })
    await loadAutomations()
    showToast({ title: "Automation run queued" })
  }

  const deleteAutomation = async () => {
    const automation = state.selectedAutomation
    if (!automation) return
    if (!window.confirm(`Delete automation "${automation.name}"?`)) return
    await sdk.client.automation.delete({
      directory: sdk.directory,
      automationID: automation.id,
    })
    navigate(automationsHref(sdk.directory), { replace: true })
    await loadAutomations()
    showToast({ title: "Automation deleted" })
  }

  const selectAutomation = (automation: Automation) => {
    navigate(automationsHref(sdk.directory, automation.id))
  }

  const selectRun = (run: AutomationRun) => {
    const automation = state.selectedAutomation
    if (!automation) return
    setState("selectedRun", run)
    navigate(automationsHref(sdk.directory, automation.id, run.id), { replace: true })
  }

  createEffect(() => {
    sdk.directory
    params.automationId
    selectedRunFromQuery()
    void loadAutomations()
  })

  createEffect(() => {
    const unsub = globalSDK.event.on(sdk.directory, (event: any) => {
      if (typeof event?.type !== "string") return
      if (!event.type.startsWith("automation.")) return
      void loadAutomations()
    })
    onCleanup(unsub)
  })

  return (
    <Switch>
      <Match when={state.status === "loading"}>
        <div class="flex size-full items-center justify-center text-14-regular text-text-weak">Loading automations…</div>
      </Match>
      <Match when={state.status === "error"}>
        <div class="flex size-full items-center justify-center text-14-regular text-text-weak">{state.error}</div>
      </Match>
      <Match when={state.automations.length === 0}>
        <div class="flex size-full flex-col items-center justify-center gap-4 px-6 text-center">
          <div class="text-28-semibold text-text-strong">No automations yet</div>
          <div class="max-w-xl text-14-regular text-text-weak">
            Create a scheduled automation to run prompts for this workspace and track results in the feed.
          </div>
          <Button variant="primary" onClick={openCreateDialog}>
            Create automation
          </Button>
        </div>
      </Match>
      <Match when={true}>
        <div class="flex size-full min-h-0">
          <aside class="hidden w-[320px] shrink-0 border-r border-border-weak-base bg-background-stronger px-4 py-5 lg:flex lg:flex-col">
            <div class="flex items-center justify-between">
              <div class="text-12-medium uppercase tracking-[0.08em] text-text-weak">Automations</div>
              <Button size="small" variant="primary" onClick={openCreateDialog}>
                New
              </Button>
            </div>
            <div class="mt-4 grid gap-2">
              <input
                value={state.search}
                onInput={(event) => setState("search", event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void loadAutomations()
                }}
                placeholder="Search automations"
                class="h-9 rounded-lg border border-border-weak-base bg-background-base px-3 text-13-regular text-text-strong"
              />
              <select
                value={state.statusFilter}
                onChange={(event) => {
                  setState("statusFilter", event.currentTarget.value as AutomationStatus | "all")
                  void loadAutomations()
                }}
                class="h-9 rounded-lg border border-border-weak-base bg-background-base px-3 text-13-regular text-text-strong"
              >
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
              </select>
            </div>
            <div class="mt-4 flex-1 space-y-2 overflow-y-auto">
              <For each={state.automations}>
                {(automation) => (
                  <button
                    class="w-full rounded-2xl border px-3 py-3 text-left transition-colors"
                    classList={{
                      "border-border-strong-base bg-background-base": state.selectedAutomation?.id === automation.id,
                      "border-border-weak-base bg-background-base hover:bg-background-stronger": state.selectedAutomation?.id !== automation.id,
                    }}
                    onClick={() => selectAutomation(automation)}
                  >
                    <div class="flex items-center justify-between gap-2">
                      <div class="truncate text-14-medium text-text-strong">{automation.name}</div>
                      <Tag>{automationStatusLabel(automation.status)}</Tag>
                    </div>
                    <div class="pt-1 text-12-regular text-text-weak">Next: {dateTimeLabel(automation.nextRunAt)}</div>
                  </button>
                )}
              </For>
            </div>
          </aside>

          <div class="flex min-h-0 flex-1 flex-col">
            <Show when={state.selectedAutomation} fallback={<div class="p-6 text-14-regular text-text-weak">Select an automation.</div>}>
              {(automation) => (
                <>
                  <div class="border-b border-border-weak-base px-6 py-5">
                    <div class="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <div class="text-30-semibold text-text-strong">{automation().name}</div>
                        <div class="pt-2 text-13-regular text-text-weak">
                          Last run: {relativeTimeLabel(automation().lastRunAt)} · Next run: {dateTimeLabel(automation().nextRunAt)}
                        </div>
                      </div>
                      <div class="flex flex-wrap items-center gap-2">
                        <Button variant="secondary" onClick={openEditDialog}>
                          Edit
                        </Button>
                        <Button variant="secondary" onClick={() => void togglePauseResume()}>
                          {automation().status === "active" ? "Pause" : "Resume"}
                        </Button>
                        <Button variant="secondary" onClick={() => void runNow()}>
                          Run now
                        </Button>
                        <Button variant="secondary" onClick={() => void deleteAutomation()}>
                          Delete
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div class="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_380px]">
                    <div class="min-h-0 overflow-y-auto p-6">
                      <div class="rounded-2xl border border-border-weak-base bg-background-stronger p-4">
                        <div class="text-12-medium uppercase tracking-[0.08em] text-text-weak">Schedule</div>
                        <div class="pt-3 text-13-regular text-text-strong">Cron: {automation().cron}</div>
                        <div class="pt-1 text-13-regular text-text-strong">Timezone: {automation().timezone}</div>
                        <div class="pt-1 text-13-regular text-text-strong">Status: {automationStatusLabel(automation().status)}</div>
                      </div>
                      <div class="mt-4 rounded-2xl border border-border-weak-base bg-background-stronger p-4">
                        <div class="text-12-medium uppercase tracking-[0.08em] text-text-weak">Prompt</div>
                        <pre class="mt-3 whitespace-pre-wrap text-13-regular text-text-strong">{automation().prompt}</pre>
                      </div>
                    </div>

                    <div class="min-h-0 border-l border-border-weak-base bg-background-stronger">
                      <div class="border-b border-border-weak-base px-4 py-4">
                        <div class="text-12-medium uppercase tracking-[0.08em] text-text-weak">Run Feed</div>
                      </div>
                      <div class="h-[40%] overflow-y-auto border-b border-border-weak-base px-3 py-3">
                        <Show when={!state.loadingRuns} fallback={<div class="px-2 text-12-regular text-text-weak">Loading runs…</div>}>
                          <For each={state.runs}>
                            {(run) => (
                              <button
                                class="mb-2 w-full rounded-xl border px-3 py-2 text-left"
                                classList={{
                                  "border-border-strong-base bg-background-base": state.selectedRun?.id === run.id,
                                  "border-border-weak-base bg-background-base hover:bg-background-stronger": state.selectedRun?.id !== run.id,
                                }}
                                onClick={() => selectRun(run)}
                              >
                                <div class="flex items-center justify-between gap-2">
                                  <div class={`text-12-medium ${runStatusClass(run.status)}`}>{automationRunStatusLabel(run.status)}</div>
                                  <div class="text-11-regular text-text-weak">{relativeTimeLabel(run.time.created)}</div>
                                </div>
                                <div class="pt-1 text-12-regular text-text-strong">{run.summary ?? "No summary"}</div>
                              </button>
                            )}
                          </For>
                        </Show>
                      </div>
                      <div class="h-[60%] overflow-y-auto px-4 py-4">
                        <Show when={state.selectedRun} fallback={<div class="text-12-regular text-text-weak">Select a run.</div>}>
                          {(run) => (
                            <div class="space-y-3">
                              <div class="flex items-center justify-between">
                                <div class={`text-13-medium ${runStatusClass(run().status)}`}>{automationRunStatusLabel(run().status)}</div>
                                <div class="text-11-regular text-text-weak">{dateTimeLabel(run().time.created)}</div>
                              </div>
                              <Show when={run().error}>
                                {(error) => <div class="rounded-lg border border-border-weak-base px-3 py-2 text-12-regular text-icon-danger">{error()}</div>}
                              </Show>
                              <div class="text-12-regular text-text-strong">{run().summary ?? "No summary"}</div>
                              <Show when={run().output}>
                                {(output) => (
                                  <div class="rounded-lg border border-border-weak-base bg-background-base p-3">
                                    <div class="pb-2 text-11-medium uppercase tracking-[0.08em] text-text-weak">Output</div>
                                    <pre class="max-h-[220px] overflow-auto whitespace-pre-wrap text-12-regular text-text-strong">{output()}</pre>
                                  </div>
                                )}
                              </Show>
                              <Show when={run().logs.length > 0}>
                                <div class="rounded-lg border border-border-weak-base bg-background-base p-3">
                                  <div class="pb-2 text-11-medium uppercase tracking-[0.08em] text-text-weak">Logs</div>
                                  <div class="space-y-1">
                                    <For each={run().logs}>
                                      {(line) => <div class="text-11-regular text-text-weak">{line}</div>}
                                    </For>
                                  </div>
                                </div>
                              </Show>
                            </div>
                          )}
                        </Show>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </Show>
          </div>
        </div>
      </Match>
    </Switch>
  )
}
