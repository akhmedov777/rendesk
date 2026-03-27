import type { Automation, AutomationRun, AutomationStatus, AutomationToolCall } from "@rendesk/sdk/v2/client"
import { Button } from "@rendesk/ui/button"
import { useDialog } from "@rendesk/ui/context/dialog"
import { Dialog } from "@rendesk/ui/dialog"
import { Icon } from "@rendesk/ui/icon"
import { Tag } from "@rendesk/ui/tag"
import { TextField } from "@rendesk/ui/text-field"
import { showToast } from "@rendesk/ui/toast"
import { Navigate, useLocation, useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import {
  automationsHref,
  automationRunStatusLabel,
  automationStatusLabel,
  automationTriggerLabel,
  dateTimeLabel,
  durationLabel,
  relativeTimeLabel,
  workspaceLabel,
} from "@/features/automations/helpers"
import {
  AUTOMATION_TEMPLATE_CATEGORY_LABELS,
  AUTOMATION_TEMPLATES,
  getAutomationTemplate,
  type AutomationTemplate,
  type AutomationTemplateCategory,
} from "@/features/automations/templates"

type AutomationEditorInput = {
  name: string
  prompt: string
  cron: string
  timezone: string
  status: AutomationStatus
  templateID?: string
}

type SchedulePreset = {
  id: string
  label: string
  detail: string
  cron: string
}

const SCHEDULE_PRESETS: SchedulePreset[] = [
  {
    id: "weekday-morning",
    label: "Weekdays 09:00",
    detail: "Good default for a morning summary or release check.",
    cron: "0 9 * * 1-5",
  },
  {
    id: "weekday-afternoon",
    label: "Weekdays 15:00",
    detail: "Useful for ship-readiness and late-day review passes.",
    cron: "0 15 * * 1-5",
  },
  {
    id: "twice-daily",
    label: "Every 12 hours",
    detail: "Balanced monitoring cadence without excessive churn.",
    cron: "0 */12 * * *",
  },
  {
    id: "weekly-monday",
    label: "Mondays 11:00",
    detail: "Best for weekly release notes and summary generation.",
    cron: "0 11 * * 1",
  },
]

const RECOMMENDED_TEMPLATES = AUTOMATION_TEMPLATES.slice(0, 3)
const PAGE_HEADER_CLASS = "border-b border-border-weaker-base px-6 py-4"
const PANEL_CLASS = "rounded-[18px] border border-border-weaker-base bg-background-base"
const PANEL_MUTED_CLASS = "rounded-[20px] border border-border-weaker-base bg-background-stronger/40"
const PANEL_INSET_CLASS = "rounded-[14px] border border-border-weaker-base/80 bg-background-base"
const LIST_CARD_CLASS = "w-full rounded-[18px] border px-4 py-4 text-left transition-colors"
const PANEL_LABEL_CLASS = "text-11-medium uppercase tracking-[0.08em] text-text-weak"

function truncateText(value: string, max = 180) {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (!normalized) return ""
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 1)}…`
}

function stringifyValue(value: unknown) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function runSummaryText(run: AutomationRun) {
  const summary = run.summary?.trim()
  if (summary) return summary
  const output = run.output?.trim()
  if (output) return truncateText(output, 160)
  const error = run.error?.trim()
  if (error) return truncateText(error, 160)
  return "No summary yet"
}

function runStatusClass(status: AutomationRun["status"]) {
  if (status === "success") return "text-icon-success"
  if (status === "failed") return "text-icon-danger"
  if (status === "running") return "text-icon-info"
  if (status === "skipped_lock") return "text-icon-warning"
  return "text-text-weak"
}

function toolCallStatusClass(status: AutomationToolCall["status"]) {
  if (status === "completed") return "text-icon-success"
  if (status === "failed") return "text-icon-danger"
  return "text-icon-info"
}

function TemplateStarterCard(props: { template: AutomationTemplate; onSelect: () => void }) {
  return (
    <button
      class={`${PANEL_MUTED_CLASS} px-4 py-4 text-left transition-colors hover:border-border-weak-base hover:bg-background-stronger/55`}
      onClick={props.onSelect}
    >
      <div class="flex items-start gap-3">
        <div class="flex size-10 items-center justify-center rounded-[14px] border border-border-weaker-base/80 bg-background-base text-text-strong">
          <Icon name={props.template.icon} />
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-14-medium text-text-strong">{props.template.name}</div>
          <div class="pt-1.5 text-12-regular leading-5 text-text-weak">{truncateText(props.template.description, 110)}</div>
        </div>
      </div>
      <div class="mt-4 flex flex-wrap gap-2">
        <Tag>{AUTOMATION_TEMPLATE_CATEGORY_LABELS[props.template.category]}</Tag>
        <Tag>{props.template.cadenceLabel}</Tag>
      </div>
    </button>
  )
}

function TemplatePickerCard(props: {
  template: AutomationTemplate
  selected?: boolean
  onSelect: () => void
}) {
  return (
    <button
      class={`${LIST_CARD_CLASS} min-h-[152px]`}
      classList={{
        "border-border-weak-base bg-background-stronger/55 shadow-[0_10px_24px_rgba(0,0,0,0.12)]": !!props.selected,
        "border-border-weaker-base bg-background-base hover:border-border-weak-base hover:bg-background-stronger/35": !props.selected,
      }}
      onClick={props.onSelect}
    >
      <div class="flex items-start gap-3">
        <div class="flex size-9 shrink-0 items-center justify-center rounded-[12px] border border-border-weaker-base/80 bg-background-stronger/60 text-text-strong">
          <Icon name={props.template.icon} />
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-start justify-between gap-3">
            <div class="truncate text-13-medium text-text-strong">{props.template.name}</div>
            <Show when={props.selected}>
              <Tag>Selected</Tag>
            </Show>
          </div>
          <div class="pt-1.5 text-11-regular leading-5 text-text-weak">{truncateText(props.template.description, 96)}</div>
        </div>
      </div>
      <div class="mt-4 flex flex-wrap gap-2">
        <Tag>{AUTOMATION_TEMPLATE_CATEGORY_LABELS[props.template.category]}</Tag>
        <Tag>{props.template.cadenceLabel}</Tag>
      </div>
    </button>
  )
}

function ToolCallCard(props: { call: AutomationToolCall }) {
  return (
    <div class={`${PANEL_CLASS} p-4`}>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div class="font-mono text-12-medium text-text-strong">{props.call.tool}</div>
          <div class="pt-1 text-11-regular text-text-weak">
            Started {relativeTimeLabel(props.call.startedAt)} · Duration {durationLabel(props.call.startedAt, props.call.finishedAt)}
          </div>
        </div>
        <div class={`text-12-medium ${toolCallStatusClass(props.call.status)}`}>{props.call.status}</div>
      </div>

      <Show when={Object.keys(props.call.input ?? {}).length > 0}>
        <div class={`mt-3 ${PANEL_INSET_CLASS} p-3`}>
          <div class={PANEL_LABEL_CLASS}>Input</div>
          <pre class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-11-regular text-text-strong">
            {stringifyValue(props.call.input)}
          </pre>
        </div>
      </Show>

      <Show when={props.call.output}>
        {(output) => (
          <div class={`mt-3 ${PANEL_INSET_CLASS} p-3`}>
            <div class={PANEL_LABEL_CLASS}>Output</div>
            <pre class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-11-regular text-text-strong">
              {output()}
            </pre>
          </div>
        )}
      </Show>

      <Show when={props.call.error}>
        {(error) => (
          <div class={`mt-3 ${PANEL_INSET_CLASS} p-3 text-12-regular text-icon-danger`}>
            <div class={PANEL_LABEL_CLASS}>Error</div>
            <div class="mt-2 whitespace-pre-wrap">{error()}</div>
          </div>
        )}
      </Show>
    </div>
  )
}

function AutomationEditorDialog(props: {
  directory: string
  mode: "create" | "edit"
  initial: AutomationEditorInput
  onSave: (input: AutomationEditorInput) => Promise<void>
  onSwitchWorkspace: () => void
}) {
  const dialog = useDialog()
  const initialTemplate = getAutomationTemplate(props.initial.templateID) ?? AUTOMATION_TEMPLATES[0]
  const [categoryFilter, setCategoryFilter] = createSignal<AutomationTemplateCategory | "all">(initialTemplate?.category ?? "all")
  const [templateSearch, setTemplateSearch] = createSignal("")
  const [templateID, setTemplateID] = createSignal(props.initial.templateID ?? initialTemplate?.id ?? "")
  const [name, setName] = createSignal(props.initial.name)
  const [prompt, setPrompt] = createSignal(props.initial.prompt)
  const [cron, setCron] = createSignal(props.initial.cron)
  const [timezone, setTimezone] = createSignal(props.initial.timezone)
  const [status, setStatus] = createSignal<AutomationStatus>(props.initial.status)
  const [saving, setSaving] = createSignal(false)

  const title = createMemo(() => (props.mode === "create" ? "Create automation" : "Edit automation"))
  const selectedTemplate = createMemo(() => getAutomationTemplate(templateID()) ?? AUTOMATION_TEMPLATES[0])
  const filteredTemplates = createMemo(() => {
    const query = templateSearch().trim().toLowerCase()
    return AUTOMATION_TEMPLATES.filter((template) => {
      if (categoryFilter() !== "all" && template.category !== categoryFilter()) return false
      if (!query) return true
      return (
        template.name.toLowerCase().includes(query) ||
        template.description.toLowerCase().includes(query) ||
        template.focus.toLowerCase().includes(query)
      )
    })
  })

  const applyTemplate = (nextTemplateID: string) => {
    const template = getAutomationTemplate(nextTemplateID)
    if (!template) return
    const willReplace =
      props.mode === "edit" && (template.name !== name().trim() || template.prompt !== prompt().trim() || template.cron !== cron().trim())
    if (
      willReplace &&
      !window.confirm(`Apply "${template.name}" defaults? This replaces the current name, prompt, and schedule.`)
    ) {
      return
    }
    setTemplateID(template.id)
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

  const switchWorkspace = () => {
    dialog.close()
    props.onSwitchWorkspace()
  }

  return (
    <Dialog
      title={title()}
      description="Scheduled automations only. Runs stay scoped to the current workspace and write only inside that workspace."
      size="form"
      class="w-full max-w-[780px]"
    >
      <div class="flex min-h-0 flex-1 flex-col">
        <div class="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <div class="grid gap-4">
            <div class={`${PANEL_MUTED_CLASS} p-4`}>
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class={PANEL_LABEL_CLASS}>Workspace</div>
                  <div class="pt-2 text-15-medium text-text-strong">{workspaceLabel(props.directory)}</div>
                  <div class="pt-1 break-all font-mono text-11-regular text-text-weak">{props.directory}</div>
                </div>
                <Button size="small" variant="secondary" onClick={switchWorkspace}>
                  Switch workspace
                </Button>
              </div>
            </div>

            <div class={`${PANEL_MUTED_CLASS} p-4`}>
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div class={PANEL_LABEL_CLASS}>Starter templates</div>
                  <div class="pt-2 text-12-regular text-text-weak">
                    Pick a starter, then edit the prompt or schedule if needed.
                  </div>
                </div>
                <Tag>{filteredTemplates().length} shown</Tag>
              </div>

              <div class="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                <input
                  value={templateSearch()}
                  onInput={(event) => setTemplateSearch(event.currentTarget.value)}
                  placeholder="Search templates"
                  class="h-11 rounded-[14px] border border-border-weaker-base bg-background-base px-3.5 text-13-regular text-text-strong"
                />
                <div class="flex flex-wrap gap-2">
                  <button
                    class="rounded-full border px-3 py-1.5 text-12-medium transition-colors"
                    classList={{
                      "border-border-weak-base bg-background-base text-text-strong": categoryFilter() === "all",
                      "border-border-weaker-base text-text-weak hover:border-border-weak-base hover:bg-background-base": categoryFilter() !== "all",
                    }}
                    onClick={() => setCategoryFilter("all")}
                  >
                    All
                  </button>
                  <For each={Object.entries(AUTOMATION_TEMPLATE_CATEGORY_LABELS) as [AutomationTemplateCategory, string][]}>
                    {([category, label]) => (
                      <button
                        class="rounded-full border px-3 py-1.5 text-12-medium transition-colors"
                        classList={{
                          "border-border-weak-base bg-background-base text-text-strong": categoryFilter() === category,
                          "border-border-weaker-base text-text-weak hover:border-border-weak-base hover:bg-background-base":
                            categoryFilter() !== category,
                        }}
                        onClick={() => setCategoryFilter(category)}
                      >
                        {label}
                      </button>
                    )}
                  </For>
                </div>
              </div>

              <Show
                when={filteredTemplates().length > 0}
                fallback={
                  <div class="mt-4 rounded-[14px] border border-dashed border-border-weaker-base px-3 py-4 text-12-regular text-text-weak">
                    No templates match this search.
                  </div>
                }
              >
                <div class="mt-4 grid gap-2 sm:grid-cols-2">
                  <For each={filteredTemplates()}>
                    {(template) => (
                      <TemplatePickerCard template={template} selected={templateID() === template.id} onSelect={() => applyTemplate(template.id)} />
                    )}
                  </For>
                </div>
              </Show>
            </div>

            <Show when={selectedTemplate()}>
              {(template) => (
                <div class={`${PANEL_CLASS} p-4`}>
                  <div class="flex items-start gap-3">
                    <div class="flex size-10 items-center justify-center rounded-[14px] border border-border-weaker-base/80 bg-background-stronger/50 text-text-strong">
                      <Icon name={template().icon} />
                    </div>
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <div class="text-14-medium text-text-strong">{template().name}</div>
                        <Tag>{template().cadenceLabel}</Tag>
                      </div>
                      <div class="pt-2 text-12-regular text-text-weak">{template().description}</div>
                      <div class="grid gap-3 pt-3 sm:grid-cols-2">
                        <div>
                          <div class={PANEL_LABEL_CLASS}>Focus</div>
                          <div class="pt-1 text-12-regular text-text-strong">{template().focus}</div>
                        </div>
                        <div>
                          <div class={PANEL_LABEL_CLASS}>Expected output</div>
                          <div class="pt-1 text-12-regular text-text-strong">{template().outcome}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </Show>

            <TextField label="Name" value={name()} onInput={(event) => setName(event.currentTarget.value)} autofocus />

            <label class="flex flex-col gap-1 text-12-medium text-text-weak">
              Prompt
              <textarea
                rows={8}
                class="min-h-[180px] rounded-[16px] border border-border-weaker-base bg-background-base px-4 py-3 text-13-regular leading-6 text-text-strong"
                value={prompt()}
                onInput={(event) => setPrompt(event.currentTarget.value)}
              />
            </label>

            <div class={`${PANEL_MUTED_CLASS} p-4`}>
              <div class={PANEL_LABEL_CLASS}>Schedule</div>
              <div class="pt-2 text-12-regular text-text-weak">
                Choose a preset or enter cron directly. The backend enforces a minimum frequency of 15 minutes.
              </div>
              <div class="mt-4 grid gap-2 sm:grid-cols-2">
                <For each={SCHEDULE_PRESETS}>
                  {(preset) => (
                    <button
                      class="rounded-[16px] border px-4 py-3 text-left transition-colors"
                      classList={{
                        "border-border-weak-base bg-background-base": cron() === preset.cron,
                        "border-border-weaker-base bg-background-base hover:border-border-weak-base hover:bg-background-stronger/35":
                          cron() !== preset.cron,
                      }}
                      onClick={() => setCron(preset.cron)}
                    >
                      <div class="text-13-medium text-text-strong">{preset.label}</div>
                      <div class="pt-1 text-11-regular text-text-weak">{preset.detail}</div>
                    </button>
                  )}
                </For>
              </div>
              <div class="mt-4">
                <TextField label="Cron schedule" value={cron()} onInput={(event) => setCron(event.currentTarget.value)} />
              </div>
            </div>

            <div class="grid gap-4 sm:grid-cols-2">
              <TextField label="Timezone" value={timezone()} onInput={(event) => setTimezone(event.currentTarget.value)} />
              <label class="flex flex-col gap-1 text-12-medium text-text-weak">
                Status
                <select
                  class="h-9 rounded-[12px] border border-border-weaker-base bg-background-base px-3 text-13-regular text-text-strong"
                  value={status()}
                  onChange={(event) => setStatus(event.currentTarget.value as AutomationStatus)}
                >
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                </select>
              </label>
            </div>

            <div class={`${PANEL_CLASS} px-4 py-3 text-12-regular text-text-weak`}>
              Auto-approved writes stay inside this workspace only. Results land in the feed and raise a desktop notification when the run completes.
            </div>
          </div>
        </div>

        <div class="flex flex-col gap-3 border-t border-border-weaker-base px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="text-12-regular text-text-weak">Current workspace only. Scheduled automations only. Feed history is the v1 inbox.</div>
          <div class="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => dialog.close()}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!name().trim() || !prompt().trim() || !cron().trim() || !timezone().trim() || saving()}
              onClick={() => void save()}
            >
              {saving() ? "Saving…" : props.mode === "create" ? "Create automation" : "Save changes"}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

export default function AutomationsPage() {
  const sdk = useSDK()
  const globalSDK = useGlobalSDK()
  const layout = useLayout()
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
    searchDraft: "",
    search: "",
    statusFilter: "all" as AutomationStatus | "all",
  })

  const supported = createMemo(() => platform.platform === "desktop" && platform.capabilities?.automations !== false)
  const selectedRunFromQuery = createMemo(() => new URLSearchParams(location.search).get("run") ?? "")
  const workspaceName = createMemo(() => workspaceLabel(sdk.directory))
  const activeAutomationCount = createMemo(() => state.automations.filter((automation) => automation.status === "active").length)
  const pausedAutomationCount = createMemo(() => state.automations.filter((automation) => automation.status === "paused").length)
  const selectedTemplate = createMemo(() => getAutomationTemplate(state.selectedAutomation?.templateID))
  const hasFilters = createMemo(() => !!state.search || state.statusFilter !== "all")

  if (!supported()) {
    return <Navigate href={`/${params.dir}/session`} />
  }

  const switchWorkspace = () => {
    const resolve = (result: string | string[] | null) => {
      const directory = Array.isArray(result) ? result[0] : result
      if (!directory || directory === sdk.directory) return
      layout.projects.open(directory)
      navigate(automationsHref(directory))
    }

    queueMicrotask(() => {
      dialog.show(() => <DialogSelectDirectory onSelect={resolve} />, () => resolve(null))
    })
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

  const openCreateDialog = (templateID?: string) => {
    const fallbackTemplate = getAutomationTemplate(templateID) ?? AUTOMATION_TEMPLATES[0]
    dialog.show(() => (
      <AutomationEditorDialog
        directory={sdk.directory}
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
        onSwitchWorkspace={switchWorkspace}
      />
    ))
  }

  const openEditDialog = () => {
    const automation = state.selectedAutomation
    if (!automation) return
    dialog.show(() => (
      <AutomationEditorDialog
        directory={automation.directory}
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
        onSwitchWorkspace={switchWorkspace}
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

  const applyFilters = () => {
    setState("search", state.searchDraft.trim())
  }

  const clearFilters = () => {
    setState("searchDraft", "")
    setState("search", "")
    setState("statusFilter", "all")
  }

  createEffect(() => {
    sdk.directory
    params.automationId
    selectedRunFromQuery()
    state.search
    state.statusFilter
    void loadAutomations()
  })

  createEffect(() => {
    const directory = sdk.directory
    const unsub = globalSDK.event.on(directory, (event: any) => {
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
        <div class="flex size-full min-h-0 flex-col bg-background-base">
          <div class={PAGE_HEADER_CLASS}>
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div class="text-24-semibold text-text-strong">
                  {hasFilters() ? "No automations match these filters" : "Automations"}
                </div>
                <div class="pt-2 text-13-regular text-text-weak">
                  {hasFilters()
                    ? "Reset the filters or create a new automation."
                    : `Scheduled agents for ${workspaceName()}. Create one to get started.`}
                </div>
              </div>
              <div class="flex items-center gap-2">
                <Show when={hasFilters()}>
                  <Button variant="secondary" onClick={clearFilters}>
                    Reset filters
                  </Button>
                </Show>
                <Button variant="primary" onClick={() => openCreateDialog()}>
                  New automation
                </Button>
              </div>
            </div>
          </div>

          <div class="flex-1 overflow-y-auto px-6 py-6">
            <div class="mb-4 max-w-2xl text-12-regular text-text-weak">
              Start from a template and then refine the prompt, schedule, and workspace scope in the editor.
            </div>
            <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <For each={RECOMMENDED_TEMPLATES}>
                {(template) => <TemplateStarterCard template={template} onSelect={() => openCreateDialog(template.id)} />}
              </For>
            </div>
          </div>
        </div>
      </Match>
      <Match when={true}>
        <div class="flex size-full min-h-0 flex-col overflow-hidden bg-background-base">
          <div class={PAGE_HEADER_CLASS}>
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div class="text-24-semibold text-text-strong">Automations</div>
                <div class="pt-2 text-13-regular text-text-weak">
                  Scheduled agents for <span class="text-text-strong">{workspaceName()}</span>
                </div>
              </div>
              <div class="flex flex-wrap items-center justify-end gap-3">
                <div class="text-12-regular text-text-weak">
                  {activeAutomationCount()} active
                  <Show when={pausedAutomationCount() > 0}> · {pausedAutomationCount()} paused</Show>
                </div>
                <Button variant="primary" onClick={() => openCreateDialog()}>
                  New automation
                </Button>
              </div>
            </div>
          </div>

          <div class="grid min-h-0 flex-1 lg:grid-cols-[336px_minmax(0,1fr)]">
            <aside class="min-h-0 border-b border-border-weaker-base lg:border-b-0 lg:border-r">
              <div class="flex h-full min-h-0 flex-col">
                <div class="border-b border-border-weaker-base px-4 py-4">
                  <div class="grid gap-3">
                    <div class="flex items-center justify-between">
                      <div class={PANEL_LABEL_CLASS}>Library</div>
                      <div class="text-11-regular text-text-weak">{state.automations.length} total</div>
                    </div>
                    <input
                      value={state.searchDraft}
                      onInput={(event) => setState("searchDraft", event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") applyFilters()
                      }}
                      placeholder="Search automations"
                      class="h-11 rounded-[14px] border border-border-weaker-base bg-background-base px-3.5 text-13-regular text-text-strong"
                    />
                    <div class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] lg:grid-cols-1 xl:grid-cols-[minmax(0,1fr)_auto_auto]">
                      <select
                        value={state.statusFilter}
                        onChange={(event) => setState("statusFilter", event.currentTarget.value as AutomationStatus | "all")}
                        class="h-11 rounded-[14px] border border-border-weaker-base bg-background-base px-3.5 text-13-regular text-text-strong"
                      >
                        <option value="all">All statuses</option>
                        <option value="active">Active</option>
                        <option value="paused">Paused</option>
                      </select>
                      <Button size="small" variant="secondary" onClick={applyFilters}>
                        Search
                      </Button>
                      <Button size="small" variant="secondary" disabled={!hasFilters()} onClick={clearFilters}>
                        Reset
                      </Button>
                    </div>
                  </div>
                </div>

                <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
                  <div class="space-y-2.5">
                    <For each={state.automations}>
                      {(automation) => {
                        const template = createMemo(() => getAutomationTemplate(automation.templateID))
                        return (
                          <button
                            class={LIST_CARD_CLASS}
                            classList={{
                              "border-border-weak-base bg-background-stronger/55 shadow-[0_10px_24px_rgba(0,0,0,0.12)]":
                                state.selectedAutomation?.id === automation.id,
                              "border-border-weaker-base bg-background-base hover:border-border-weak-base hover:bg-background-stronger/35":
                                state.selectedAutomation?.id !== automation.id,
                            }}
                            onClick={() => selectAutomation(automation)}
                          >
                            <div class="flex items-start justify-between gap-3">
                              <div class="flex min-w-0 flex-1 items-start gap-3">
                                <div class="flex size-9 shrink-0 items-center justify-center rounded-[12px] border border-border-weaker-base/80 bg-background-stronger/60 text-text-strong">
                                  <Icon name={template()?.icon ?? "brain"} />
                                </div>
                                <div class="min-w-0 flex-1">
                                  <div class="truncate text-14-medium text-text-strong">{automation.name}</div>
                                  <div class="pt-1 text-11-regular text-text-weak">
                                    {template()?.name ?? "Custom automation"} · {automation.timezone}
                                  </div>
                                </div>
                              </div>
                              <Tag>{automationStatusLabel(automation.status)}</Tag>
                            </div>
                            <div class="pt-3 text-12-regular leading-5 text-text-weak">
                              {truncateText(automation.prompt, 96) || "No prompt preview"}
                            </div>
                            <div class="pt-3 flex flex-wrap items-center gap-2 text-11-regular text-text-weak">
                              <Show when={template()}>
                                {(selected) => <Tag>{selected().cadenceLabel}</Tag>}
                              </Show>
                              <div>Next {dateTimeLabel(automation.nextRunAt)}</div>
                              <div>Last {relativeTimeLabel(automation.lastRunAt)}</div>
                            </div>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                </div>
              </div>
            </aside>

            <div class="min-h-0 overflow-hidden">
              <Show
                when={state.selectedAutomation}
                fallback={<div class="p-6 text-14-regular text-text-weak">Select an automation.</div>}
              >
                {(automation) => (
                  <div class="grid h-full min-h-0 lg:grid-cols-[minmax(0,1fr)_minmax(340px,400px)]">
                    <div class="min-h-0 overflow-y-auto px-6 py-6">
                      <div class="grid gap-5 pb-6">
                        <div class="flex flex-wrap items-start justify-between gap-4">
                          <div class="min-w-0 flex-1">
                            <div class="flex flex-wrap items-center gap-2">
                              <Show when={selectedTemplate()}>
                                {(template) => (
                                  <div class="flex size-10 items-center justify-center rounded-[14px] border border-border-weaker-base/80 bg-background-stronger/50 text-text-strong">
                                    <Icon name={template().icon} />
                                  </div>
                                )}
                              </Show>
                              <div class="min-w-0">
                                <div class="text-26-semibold text-text-strong">{automation().name}</div>
                                <div class="pt-2 text-13-regular text-text-weak">
                                  {selectedTemplate()?.description ?? "Custom scheduled automation for this workspace."}
                                </div>
                              </div>
                            </div>
                            <div class="mt-4 flex flex-wrap gap-2">
                              <Tag>{automationStatusLabel(automation().status)}</Tag>
                              <Show when={selectedTemplate()}>
                                {(template) => <Tag>{template().name}</Tag>}
                              </Show>
                              <Tag>{automation().timezone}</Tag>
                            </div>
                          </div>
                          <div class="flex flex-wrap gap-2">
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

                        <div class="grid gap-3 md:grid-cols-3">
                          <div class={`${PANEL_MUTED_CLASS} p-4`}>
                            <div class={PANEL_LABEL_CLASS}>Workspace</div>
                            <div class="pt-2 text-15-medium text-text-strong">{workspaceLabel(automation().directory)}</div>
                            <div class="pt-1 break-all font-mono text-11-regular text-text-weak">{automation().directory}</div>
                          </div>
                          <div class={`${PANEL_MUTED_CLASS} p-4`}>
                            <div class={PANEL_LABEL_CLASS}>Next run</div>
                            <div class="pt-2 text-15-medium text-text-strong">{dateTimeLabel(automation().nextRunAt)}</div>
                            <div class="pt-1 font-mono text-11-regular text-text-weak">{automation().cron}</div>
                          </div>
                          <div class={`${PANEL_MUTED_CLASS} p-4`}>
                            <div class={PANEL_LABEL_CLASS}>Recent activity</div>
                            <div class="pt-2 text-15-medium text-text-strong">{relativeTimeLabel(automation().lastRunAt)}</div>
                            <div class="pt-1 text-11-regular text-text-weak">{state.runs.length} runs retained</div>
                          </div>
                        </div>

                        <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
                          <div class={`${PANEL_CLASS} p-5`}>
                            <div class={PANEL_LABEL_CLASS}>Prompt</div>
                            <pre class="mt-4 whitespace-pre-wrap text-13-regular leading-6 text-text-strong">{automation().prompt}</pre>
                          </div>

                          <div class="grid gap-4">
                            <div class={`${PANEL_CLASS} p-5`}>
                              <div class={PANEL_LABEL_CLASS}>Delivery and guardrails</div>
                              <div class="mt-3 space-y-3 text-12-regular leading-5 text-text-weak">
                                <div>Feed history is the v1 inbox for this automation.</div>
                                <div>Completed runs raise a desktop notification with a deep link back here.</div>
                                <div>Auto-approved writes remain inside the workspace root. Out-of-root operations are denied.</div>
                              </div>
                            </div>

                            <Show when={selectedTemplate()}>
                              {(template) => (
                                <div class={`${PANEL_CLASS} p-5`}>
                                  <div class={PANEL_LABEL_CLASS}>Template</div>
                                  <div class="pt-2 text-14-medium text-text-strong">{template().name}</div>
                                  <div class="pt-2 text-12-regular text-text-weak">{template().focus}</div>
                                  <div class="pt-3 text-12-regular leading-5 text-text-strong">{template().outcome}</div>
                                </div>
                              )}
                            </Show>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div class="min-h-0 border-t border-border-weaker-base lg:border-l lg:border-t-0">
                      <div class="flex h-full min-h-0 flex-col">
                        <div class="border-b border-border-weaker-base px-4 py-4">
                          <div class="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <div class={PANEL_LABEL_CLASS}>Run feed</div>
                              <div class="pt-2 text-13-regular text-text-weak">
                                Latest 200 runs for this automation. Feed history is the inbox in v1.
                              </div>
                            </div>
                            <Tag>{state.runs.length} runs</Tag>
                          </div>
                        </div>

                        <div class="grid min-h-0 flex-1 xl:grid-rows-[minmax(240px,0.8fr)_minmax(0,1.2fr)]">
                          <div class="min-h-0 overflow-y-auto border-b border-border-weaker-base p-3">
                            <Show when={!state.loadingRuns} fallback={<div class="px-2 text-12-regular text-text-weak">Loading runs…</div>}>
                              <Show
                                when={state.runs.length > 0}
                                fallback={
                                  <div class="rounded-[16px] border border-dashed border-border-weaker-base px-4 py-6 text-center text-12-regular text-text-weak">
                                    No runs yet. Trigger a manual run to validate the prompt and schedule.
                                  </div>
                                }
                              >
                                <div class="space-y-2">
                                  <For each={state.runs}>
                                    {(run) => (
                                      <button
                                        class={LIST_CARD_CLASS}
                                        classList={{
                                          "border-border-weak-base bg-background-stronger/55 shadow-[0_10px_24px_rgba(0,0,0,0.12)]":
                                            state.selectedRun?.id === run.id,
                                          "border-border-weaker-base bg-background-base hover:border-border-weak-base hover:bg-background-stronger/35":
                                            state.selectedRun?.id !== run.id,
                                        }}
                                        onClick={() => selectRun(run)}
                                      >
                                        <div class="flex items-start justify-between gap-3">
                                          <div class="min-w-0 flex-1">
                                            <div class={`text-12-medium ${runStatusClass(run.status)}`}>
                                              {automationRunStatusLabel(run.status)}
                                            </div>
                                            <div class="pt-1 text-11-regular text-text-weak">{automationTriggerLabel(run.trigger)}</div>
                                          </div>
                                          <div class="shrink-0 text-11-regular text-text-weak">{relativeTimeLabel(run.time.created)}</div>
                                        </div>
                                        <div class="pt-3 text-12-regular text-text-strong">{runSummaryText(run)}</div>
                                      </button>
                                    )}
                                  </For>
                                </div>
                              </Show>
                            </Show>
                          </div>

                          <div class="min-h-0 overflow-y-auto p-4">
                            <Show when={state.selectedRun} fallback={<div class="text-12-regular text-text-weak">Select a run.</div>}>
                              {(run) => (
                                <div class="space-y-4">
                                  <div class={`${PANEL_CLASS} p-4`}>
                                    <div class="flex flex-wrap items-start justify-between gap-3">
                                      <div>
                                        <div class={`text-14-medium ${runStatusClass(run().status)}`}>
                                          {automationRunStatusLabel(run().status)}
                                        </div>
                                        <div class="pt-1 text-12-regular text-text-weak">{automationTriggerLabel(run().trigger)}</div>
                                      </div>
                                      <div class="text-right text-11-regular text-text-weak">
                                        <div>{dateTimeLabel(run().time.created)}</div>
                                        <div class="pt-1">Duration {durationLabel(run().time.started, run().time.finished)}</div>
                                      </div>
                                    </div>
                                    <div class="mt-4 grid gap-3 sm:grid-cols-2">
                                      <div class={`${PANEL_INSET_CLASS} px-3 py-3`}>
                                        <div class={PANEL_LABEL_CLASS}>Scheduled for</div>
                                        <div class="pt-2 text-12-regular text-text-strong">{dateTimeLabel(run().scheduledFor)}</div>
                                      </div>
                                      <div class={`${PANEL_INSET_CLASS} px-3 py-3`}>
                                        <div class={PANEL_LABEL_CLASS}>Started</div>
                                        <div class="pt-2 text-12-regular text-text-strong">{dateTimeLabel(run().time.started)}</div>
                                      </div>
                                      <div class={`${PANEL_INSET_CLASS} px-3 py-3`}>
                                        <div class={PANEL_LABEL_CLASS}>Finished</div>
                                        <div class="pt-2 text-12-regular text-text-strong">{dateTimeLabel(run().time.finished)}</div>
                                      </div>
                                      <div class={`${PANEL_INSET_CLASS} px-3 py-3`}>
                                        <div class={PANEL_LABEL_CLASS}>Tool calls</div>
                                        <div class="pt-2 text-12-regular text-text-strong">{run().toolCalls.length}</div>
                                      </div>
                                    </div>
                                  </div>

                                  <Show when={run().error}>
                                    {(error) => (
                                      <div class={`${PANEL_CLASS} px-4 py-4 text-icon-danger`}>
                                        <div class={PANEL_LABEL_CLASS}>Error</div>
                                        <div class="mt-2 whitespace-pre-wrap text-12-regular">{error()}</div>
                                      </div>
                                    )}
                                  </Show>

                                  <div class={`${PANEL_CLASS} p-4`}>
                                    <div class={PANEL_LABEL_CLASS}>Summary</div>
                                    <div class="mt-2 whitespace-pre-wrap text-12-regular text-text-strong">{runSummaryText(run())}</div>
                                  </div>

                                  <Show when={run().output}>
                                    {(output) => (
                                      <div class={`${PANEL_CLASS} p-4`}>
                                        <div class={PANEL_LABEL_CLASS}>Output</div>
                                        <pre class="mt-2 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-11-regular text-text-strong">
                                          {output()}
                                        </pre>
                                      </div>
                                    )}
                                  </Show>

                                  <div class={`${PANEL_CLASS} p-4`}>
                                    <div class={PANEL_LABEL_CLASS}>Tool calls</div>
                                    <Show
                                      when={run().toolCalls.length > 0}
                                      fallback={<div class="mt-2 text-12-regular text-text-weak">No tool calls recorded for this run.</div>}
                                    >
                                      <div class="mt-3 space-y-3">
                                        <For each={run().toolCalls}>{(call) => <ToolCallCard call={call} />}</For>
                                      </div>
                                    </Show>
                                  </div>

                                  <Show when={run().logs.length > 0}>
                                    <div class={`${PANEL_CLASS} p-4`}>
                                      <div class={PANEL_LABEL_CLASS}>Logs</div>
                                      <pre class="mt-2 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-11-regular text-text-strong">
                                        {run().logs.join("\n")}
                                      </pre>
                                    </div>
                                  </Show>
                                </div>
                              )}
                            </Show>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </Show>
            </div>
          </div>
        </div>
      </Match>
    </Switch>
  )
}
