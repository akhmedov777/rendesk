import { Component, For, Show } from "solid-js"
import { FileIcon } from "@rendesk/ui/file-icon"
import { IconButton } from "@rendesk/ui/icon-button"
import { Tooltip } from "@rendesk/ui/tooltip"
import { getDirectory, getFilename, getFilenameTruncated } from "@rendesk/util/path"
import type { ContextItem } from "@/context/prompt"

type PromptContextItem = ContextItem & { key: string }

type ContextItemsProps = {
  items: PromptContextItem[]
  active: (item: PromptContextItem) => boolean
  openComment: (item: Extract<PromptContextItem, { type: "file" }>) => void
  remove: (item: PromptContextItem) => void
  t: (key: string) => string
}

export const PromptContextItems: Component<ContextItemsProps> = (props) => {
  return (
    <Show when={props.items.length > 0}>
      <div class="flex flex-nowrap items-start gap-2 p-2 overflow-x-auto no-scrollbar">
        <For each={props.items}>
          {(item) => {
            const path = item.type === "file" ? item.path : item.filePath
            const directory = getDirectory(path)
            const filename = getFilename(path)
            const label = getFilenameTruncated(path, 14)
            const selected = props.active(item)
            const detail =
              item.type === "file"
                ? item.comment
                : item.selectionRange
                  ? `${item.selectionRange.range} (${item.selectionRange.sheetName || "active"})`
                  : "Editor selection"

            return (
              <Tooltip
                value={
                  <span class="flex max-w-[300px]">
                    <span class="text-text-invert-base truncate-start [unicode-bidi:plaintext] min-w-0">
                      {directory}
                    </span>
                    <span class="shrink-0">{filename}</span>
                  </span>
                }
                placement="top"
                openDelay={2000}
              >
                <div
                  classList={{
                    "group shrink-0 flex flex-col rounded-[6px] pl-2 pr-1 py-1 max-w-[200px] h-12 cursor-default transition-all transition-transform shadow-xs-border hover:shadow-xs-border-hover": true,
                    "hover:bg-surface-interactive-weak": item.type === "file" && !!item.commentID && !selected,
                    "bg-surface-interactive-hover hover:bg-surface-interactive-hover shadow-xs-border-hover": selected,
                    "bg-background-stronger": !selected,
                  }}
                  onClick={() => {
                    if (item.type === "file") props.openComment(item)
                  }}
                >
                  <div class="flex items-center gap-1.5">
                    <FileIcon node={{ path, type: "file" }} class="shrink-0 size-3.5" />
                    <div class="flex items-center text-11-regular min-w-0 font-medium">
                      <span class="text-text-strong whitespace-nowrap">{label}</span>
                      <Show when={item.type === "file" ? item.selection : undefined}>
                        {(sel) => (
                          <span class="text-text-weak whitespace-nowrap shrink-0">
                            {sel().startLine === sel().endLine
                              ? `:${sel().startLine}`
                              : `:${sel().startLine}-${sel().endLine}`}
                          </span>
                        )}
                      </Show>
                    </div>
                    <IconButton
                      type="button"
                      icon="close-small"
                      variant="ghost"
                      class="ml-auto size-3.5 text-text-weak hover:text-text-strong transition-all"
                      onClick={(e) => {
                        e.stopPropagation()
                        props.remove(item)
                      }}
                      aria-label={props.t("prompt.context.removeFile")}
                    />
                  </div>
                  <Show when={detail}>
                    {(value) => <div class="text-12-regular text-text-strong ml-5 pr-1 truncate">{value()}</div>}
                  </Show>
                </div>
              </Tooltip>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
