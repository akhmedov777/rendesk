import type { VisualizationPayload } from "@rendesk/sdk/v2/client"
import { Dialog } from "@rendesk/ui/dialog"
import { VisualizationCard } from "@rendesk/ui/visualization"
import { Show, type JSX } from "solid-js"

export function VisualizationPreviewDialog(props: {
  visualization: VisualizationPayload
  meta?: JSX.Element
  actions?: JSX.Element
}) {
  return (
    <Dialog title={props.visualization.title || "Visualization"} description={props.visualization.description} size="x-large">
      <div class="flex h-full min-h-0 flex-col gap-4 px-5 pb-5">
        <Show when={props.meta || props.actions}>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <Show when={props.meta}>
              <div class="flex flex-wrap items-center gap-2">{props.meta}</div>
            </Show>
            <Show when={props.actions}>
              <div class="flex flex-wrap items-center gap-2">{props.actions}</div>
            </Show>
          </div>
        </Show>
        <VisualizationCard visualization={props.visualization} hideHeader mode="expanded" class="min-h-0 flex-1" />
      </div>
    </Dialog>
  )
}
