import type { DashboardListResult, Dashboard, VisualizationPayload, WidgetSource } from "@rendesk/sdk/v2/client"
import { Button } from "@rendesk/ui/button"
import { GenericTool } from "@rendesk/ui/basic-tool"
import { useDialog } from "@rendesk/ui/context/dialog"
import { IconButton } from "@rendesk/ui/icon-button"
import { Tag } from "@rendesk/ui/tag"
import { type ToolProps, ToolRegistry } from "@rendesk/ui/message-part"
import { showToast } from "@rendesk/ui/toast"
import { VisualizationCard } from "@rendesk/ui/visualization"
import { useNavigate } from "@solidjs/router"
import { createMemo, type Component, type JSX } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { SaveVisualizationDialog } from "./dialog-save-visualization"
import { VisualizationPreviewDialog } from "./dialog-visualization-preview"
import { dashboardHref, isWidgetSource, resolveVisualizationPayload, snapshotSource, sourceModeLabel } from "./helpers"

function VisualizationToolResult(props: ToolProps) {
  const sdk = useSDK()
  const platform = usePlatform()
  const dialog = useDialog()
  const navigate = useNavigate()
  const visualization = createMemo(() => resolveVisualizationPayload(props.tool, props.metadata.visualization, props.input))
  const source = createMemo<WidgetSource>(() =>
    isWidgetSource(props.metadata.dashboardSource) ? props.metadata.dashboardSource : snapshotSource(),
  )
  const dashboardEnabled = createMemo(() => platform.platform === "desktop" && platform.capabilities?.dashboard === true)

  const loadDashboards = async (): Promise<DashboardListResult> => {
    const result = (await sdk.client.dashboard.list({ directory: sdk.directory })) as { data?: DashboardListResult }
    return result.data ?? { dashboards: [] }
  }

  const saveWidget = async (input: { dashboardID?: string; createTitle?: string; widgetTitle?: string }) => {
    const result = (await sdk.client.dashboard.widget.add({
      directory: sdk.directory,
      dashboardID: input.dashboardID,
      createTitle: input.createTitle,
      title: input.widgetTitle,
      visualization: visualization(),
      source: source(),
    })) as { data?: { dashboard?: Dashboard } }

    const dashboard = result.data?.dashboard
    if (!dashboard) return

    showToast({
      title: "Widget saved",
      description: dashboard.title,
      actions: [
        {
          label: "Open dashboard",
          onClick: () => navigate(dashboardHref(sdk.directory, dashboard.id)),
        },
      ],
    })
  }

  const openSaveDialog = () => {
    dialog.show(() => (
      <SaveVisualizationDialog
        title={visualization()?.title}
        loadDashboards={loadDashboards}
        onSave={async (input) => {
          await saveWidget(input)
          dialog.close()
        }}
      />
    ))
  }

  const quickSave = async () => {
    const dashboards = await loadDashboards()
    if (!dashboards.lastUsedDashboardID) {
      openSaveDialog()
      return
    }
    await saveWidget({
      dashboardID: dashboards.lastUsedDashboardID,
      widgetTitle: visualization()?.title,
    })
  }

  const previewMeta = (): JSX.Element => <Tag>{sourceModeLabel(source())}</Tag>

  const previewActions = (): JSX.Element[] | undefined => {
    if (!dashboardEnabled()) return
    return [
      <Button size="small" variant="primary" onClick={() => void quickSave()}>
        Save
      </Button>,
      <Button size="small" variant="secondary" onClick={openSaveDialog}>
        Choose
      </Button>,
    ]
  }

  const openPreview = () => {
    const payload = visualization()
    if (!payload) return
    dialog.show(() => <VisualizationPreviewDialog visualization={payload} meta={previewMeta()} actions={previewActions()} />)
  }

  if (!visualization()) {
    return <GenericTool {...props} />
  }

  return (
    <VisualizationCard
      visualization={visualization() as VisualizationPayload}
      meta={previewMeta()}
      actions={[
        <IconButton icon="expand" variant="secondary" aria-label="Expand visualization" onClick={openPreview} />,
        ...(previewActions() ?? []),
      ]}
    />
  )
}

const renderer = VisualizationToolResult as Component<ToolProps>

ToolRegistry.register({
  name: "analytics_query_workspace",
  render: renderer,
})

ToolRegistry.register({
  name: "visualize_data",
  render: renderer,
})

ToolRegistry.register({
  name: "display_metrics",
  render: renderer,
})

ToolRegistry.register({
  name: "display_table",
  render: renderer,
})
