import { useDialog } from "@rendesk/ui/context/dialog"
import { Dialog } from "@rendesk/ui/dialog"
import { List, type ListRef } from "@rendesk/ui/list"
import { Tag } from "@rendesk/ui/tag"
import { Tooltip } from "@rendesk/ui/tooltip"
import { type Component, Show } from "solid-js"
import { useLocal } from "@/context/local"
import { ModelTooltip } from "./model-tooltip"
import { useLanguage } from "@/context/language"

export const DialogSelectModelUnpaid: Component = () => {
  const local = useLocal()
  const dialog = useDialog()
  const language = useLanguage()

  let listRef: ListRef | undefined
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") return
    listRef?.onKeyDown(e)
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      class="overflow-y-auto [&_[data-slot=dialog-body]]:overflow-visible [&_[data-slot=dialog-body]]:flex-none"
    >
      <div class="flex flex-col gap-3 px-2.5" onKeyDown={handleKeyDown}>
        <div class="text-14-medium text-text-base px-2.5">{language.t("dialog.model.unpaid.freeModels.title")}</div>
        <List
          class="[&_[data-slot=list-scroll]]:overflow-visible"
          ref={(ref) => (listRef = ref)}
          items={local.model.list}
          current={local.model.current()}
          key={(x) => `${x.provider.id}:${x.id}`}
          itemWrapper={(item, node) => (
            <Tooltip
              class="w-full"
              placement="right-start"
              gutter={12}
              value={
                <ModelTooltip
                  model={item}
                  latest={item.latest}
                  free={false}
                />
              }
            >
              {node}
            </Tooltip>
          )}
          onSelect={(x) => {
            local.model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
              recent: true,
            })
            dialog.close()
          }}
        >
          {(i) => (
            <div class="w-full flex items-center gap-x-2.5">
              <span>{i.name}</span>
              <Show when={i.latest}>
                <Tag>{language.t("model.tag.latest")}</Tag>
              </Show>
            </div>
          )}
        </List>
      </div>
    </Dialog>
  )
}
