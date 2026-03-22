import { GenericTool } from "@rendesk/ui/basic-tool"
import { type ToolProps, ToolRegistry } from "@rendesk/ui/message-part"
import { createMemo, For, Show, type Component } from "solid-js"

function PythonToolResult(props: ToolProps) {
  const output = createMemo(() => {
    if (!props.output) return null
    try {
      return typeof props.output === "string" ? JSON.parse(props.output) : props.output
    } catch {
      return { text: props.output }
    }
  })

  const code = createMemo(() => {
    if (typeof props.input?.code === "string") return props.input.code
    return null
  })

  const images = createMemo(() => {
    const o = output()
    if (!o) return []
    // Images may be in content array or at top level
    if (Array.isArray(o?.content)) {
      return o.content.filter((c: { type: string }) => c.type === "image")
    }
    if (Array.isArray(o?.images)) {
      return o.images.map((data: string) => ({ data, mimeType: "image/png" }))
    }
    return []
  })

  const textContent = createMemo(() => {
    const o = output()
    if (!o) return ""
    if (typeof o === "string") return o
    if (typeof o.text === "string") return o.text
    if (Array.isArray(o.content)) {
      return o.content
        .filter((c: { type: string }) => c.type === "text")
        .map((c: { text: string }) => c.text)
        .join("\n")
    }
    return ""
  })

  const hasError = createMemo(() => props.status === "error" || output()?.isError === true)

  return (
    <div class="flex flex-col gap-2">
      <Show when={code()}>
        <details class="group" open={props.defaultOpen}>
          <summary class="cursor-pointer select-none text-xs font-medium text-content-secondary group-open:mb-1">
            Python code{props.input?.description ? `: ${props.input.description}` : ""}
          </summary>
          <pre class="overflow-x-auto rounded-md bg-background-secondary p-3 text-xs leading-relaxed">
            <code>{code()}</code>
          </pre>
        </details>
      </Show>

      <Show when={textContent()}>
        <pre
          class="overflow-x-auto rounded-md p-3 text-xs leading-relaxed"
          classList={{
            "bg-background-error/10 text-content-error": hasError(),
            "bg-background-secondary text-content-primary": !hasError(),
          }}
        >
          {textContent()}
        </pre>
      </Show>

      <Show when={images().length > 0}>
        <div class="flex flex-col gap-2">
          <For each={images()}>
            {(img: { data: string; mimeType?: string }) => (
              <img
                src={`data:${img.mimeType || "image/png"};base64,${img.data}`}
                alt="Python output"
                class="max-w-full rounded-md border border-border-base"
              />
            )}
          </For>
        </div>
      </Show>

      <Show when={!code() && !textContent() && images().length === 0}>
        <GenericTool {...props} />
      </Show>
    </div>
  )
}

function SpreadsheetLoadResult(props: ToolProps) {
  const textContent = createMemo(() => {
    if (!props.output) return ""
    try {
      const parsed = typeof props.output === "string" ? JSON.parse(props.output) : props.output
      if (Array.isArray(parsed?.content)) {
        return parsed.content
          .filter((c: { type: string }) => c.type === "text")
          .map((c: { text: string }) => c.text)
          .join("\n")
      }
      if (typeof parsed === "string") return parsed
      if (typeof parsed?.text === "string") return parsed.text
      return ""
    } catch {
      return String(props.output)
    }
  })

  return (
    <div class="flex flex-col gap-2">
      <div class="text-xs font-medium text-content-secondary">
        Load spreadsheet data
        <Show when={props.input?.range}>
          <span class="ml-1 text-content-tertiary">({props.input?.range})</span>
        </Show>
        <Show when={props.input?.variable_name && props.input?.variable_name !== "df"}>
          <span class="ml-1 text-content-tertiary">→ {props.input?.variable_name}</span>
        </Show>
      </div>
      <Show when={textContent()}>
        <pre class="overflow-x-auto rounded-md bg-background-secondary p-3 text-xs leading-relaxed">{textContent()}</pre>
      </Show>
    </div>
  )
}

const pythonRenderer = PythonToolResult as Component<ToolProps>
const loadRenderer = SpreadsheetLoadResult as Component<ToolProps>

ToolRegistry.register({
  name: "execute_python",
  render: pythonRenderer,
})

ToolRegistry.register({
  name: "python_load_spreadsheet",
  render: loadRenderer,
})
