import { Button } from "@rendesk/ui/button"
import { useCommand, usePlatform } from "@rendesk/app"
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import type { EditorDocumentType, EditorTransportMode, SpreadsheetSelection } from "../electron/onlyoffice/types"
import { createEditorRecord, useDesktopEditor } from "../editor/provider"
import type { DocumentHeading, EditorController, FormField } from "../editor/types"
import { getOnlyOfficeLoadTimeoutMs } from "../onlyoffice/load-policy"
import { ensureOnlyOfficeApiScript } from "../onlyoffice/script-loader"

type OnlyOfficeEditorProps = {
  editorID: string
  active: boolean
  sessionID: string
  filePath: string
  fileName: string
  fileExt: string
  initialDocumentType: EditorDocumentType
}

type EditorErrorState = {
  message: string
  code?: string
  details?: string
}

type OOConnector = {
  executeMethod: (method: string, args: unknown[], callback: (result: unknown) => void) => void
  callCommand: (fn: () => void, callback: (result: unknown) => void) => void
}

type OOEditorInstance = {
  createConnector: () => OOConnector
  destroyEditor: () => void
}

type OOEditorConfig = Record<string, unknown> & {
  documentType?: EditorDocumentType
  events?: Record<string, (event?: unknown) => void>
}

declare global {
  interface Window {
    DocsAPI?: {
      DocEditor: new (elementID: string, config: OOEditorConfig) => OOEditorInstance
    }
  }
}

function normalizeDocumentType(value: unknown, fallback: EditorDocumentType): EditorDocumentType {
  return value === "word" || value === "cell" || value === "slide" || value === "pdf" ? value : fallback
}

function normalizeTransportMode(value: unknown): EditorTransportMode {
  return value === "manual" || value === "auto-tunnel" ? value : "local"
}

export function OnlyOfficeEditor(props: OnlyOfficeEditorProps) {
  const platform = usePlatform()
  const command = useCommand()
  const editorBridge = useDesktopEditor()
  const [isLoading, setIsLoading] = createSignal(true)
  const [error, setError] = createSignal<EditorErrorState | null>(null)
  const [reloadNonce, setReloadNonce] = createSignal(0)

  let editorInstance: OOEditorInstance | null = null
  let connector: OOConnector | null = null
  let documentType = props.initialDocumentType
  let selectionInterval: ReturnType<typeof setInterval> | null = null
  let readyTimeout: ReturnType<typeof setTimeout> | null = null
  let containerElement: HTMLDivElement | undefined
  let iframeObserver: MutationObserver | null = null
  let fileWatchInterval: ReturnType<typeof setInterval> | null = null
  let knownMtimeMs: number | null = null

  const containerID = `onlyoffice-${props.editorID.replace(/[^a-zA-Z0-9_-]/g, "-")}`

  const clearReadyTimeout = () => {
    if (!readyTimeout) return
    clearTimeout(readyTimeout)
    readyTimeout = null
  }

  const clearSelectionInterval = () => {
    if (!selectionInterval) return
    clearInterval(selectionInterval)
    selectionInterval = null
  }

  const clearIframeObserver = () => {
    if (!iframeObserver) return
    iframeObserver.disconnect()
    iframeObserver = null
  }

  const clearFileWatchInterval = () => {
    if (!fileWatchInterval) return
    clearInterval(fileWatchInterval)
    fileWatchInterval = null
  }

  const dismissLoading = () => {
    clearReadyTimeout()
    clearIframeObserver()
    setIsLoading(false)
  }

  const attachIframeReadyFallback = () => {
    clearIframeObserver()
    if (!containerElement) return

    const tryDismissFromIframe = () => {
      if (!containerElement?.querySelector("iframe")) return false
      dismissLoading()
      return true
    }

    if (tryDismissFromIframe()) return

    iframeObserver = new MutationObserver(() => {
      if (tryDismissFromIframe()) {
        clearIframeObserver()
      }
    })
    iframeObserver.observe(containerElement, {
      childList: true,
      subtree: true,
    })
  }

  const callConnectorMethod = <T,>(method: string, args: unknown[] = []) =>
    new Promise<T>((resolve, reject) => {
      if (!connector) {
        reject(new Error("Editor not ready"))
        return
      }
      try {
        connector.executeMethod(method, args, (result) => resolve(result as T))
      } catch (error) {
        reject(error)
      }
    })

  const callCommand = <T,>(fn: () => void) =>
    new Promise<T>((resolve, reject) => {
      if (!connector) {
        reject(new Error("Editor not ready"))
        return
      }
      try {
        connector.callCommand(fn, (result) => resolve(result as T))
      } catch (error) {
        reject(error)
      }
    })

  const getSelectionRange = async (): Promise<SpreadsheetSelection | null> => {
    try {
      const result = await callCommand<string>(function () {
        var Api = (globalThis as Record<string, unknown>).Api as {
          GetActiveSheet: () => {
            GetName: () => string
            GetSelection: () => {
              GetAddress: (row: boolean, col: boolean) => string
              GetRowCount: () => number
              GetColCount: () => number
              GetCell: (row: number, col: number) => { GetValue: () => string } | null
            }
          }
        }
        var ws = Api.GetActiveSheet()
        var selection = ws.GetSelection()
        var rows = selection.GetRowCount()
        var cols = selection.GetColCount()
        var preview = []
        for (var row = 0; row < Math.min(rows, 5); row++) {
          var parts = []
          for (var col = 0; col < Math.min(cols, 5); col++) {
            var cell = selection.GetCell(row, col)
            parts.push(cell ? String(cell.GetValue()) : "")
          }
          preview.push(parts.join("\t"))
        }
        return JSON.stringify({
          range: selection.GetAddress(false, false),
          sheetName: ws.GetName(),
          preview: preview.join("\n"),
          cellCount: rows * cols,
        }) as unknown as void
      } as () => void)
      return result ? (JSON.parse(result) as SpreadsheetSelection) : null
    } catch {
      return null
    }
  }

  const insertText = async (text: string, position: "cursor" | "start" | "end" = "cursor") => {
    if (position === "cursor") {
      await callConnectorMethod("InsertTextToCursor", [text])
      return { success: true, message: "Text inserted at cursor" }
    }

    if (documentType === "pdf") {
      return { success: false, message: "Editing is unavailable for PDF documents in view mode." }
    }

    await callConnectorMethod(position === "start" ? "MoveCursorToStart" : "MoveCursorToEnd", [true])
    await callConnectorMethod("InsertTextToCursor", [text])
    return {
      success: true,
      message: position === "start" ? "Text inserted at document start" : "Text inserted at document end",
    }
  }

  const applyFormatting = async (
    command: Extract<Parameters<EditorController["executeCommand"]>[0], { type: "set_formatting" }>,
  ) => {
    const operations: string[] = []
    if (typeof command.bold === "boolean") operations.push(`range.SetBold(${command.bold});`)
    if (typeof command.italic === "boolean") operations.push(`range.SetItalic(${command.italic});`)
    if (typeof command.fontSize === "number") operations.push(`range.SetFontSize(${command.fontSize});`)

    if (operations.length === 0) {
      return { success: false, message: "Formatting requires at least one of bold, italic, or font size." }
    }

    if (documentType === "pdf") {
      return { success: false, message: "Formatting is unavailable for PDF documents in view mode." }
    }

    if (command.target !== "all") {
      const selectedText = await controller.getSelection()
      if (!selectedText.trim()) {
        return { success: false, message: "Select text before applying formatting." }
      }
    }

    const targetExpression = command.target === "all" ? "doc.GetRange()" : "doc.GetRangeBySelect()"
    const result = await callCommand<string>(
      new Function(`
        var Api = globalThis.Api;
        var doc = Api.GetDocument();
        var range = ${targetExpression};
        if (!range) {
          return JSON.stringify({
            success: false,
            message: ${JSON.stringify(
              command.target === "all"
                ? "Unable to resolve the document range."
                : "Unable to resolve the selected range.",
            )},
          });
        }
        ${operations.join("\n")}
        return JSON.stringify({
          success: true,
          message: ${JSON.stringify(
            command.target === "all" ? "Formatting applied to the document." : "Formatting applied to the selection.",
          )},
        });
      `) as () => void,
    )

    if (!result) {
      return { success: false, message: "OnlyOffice did not return a formatting result." }
    }

    return JSON.parse(result) as { success: boolean; message: string }
  }

  const controller: EditorController = {
    getDocumentType: () => documentType,
    async executeCommand(command) {
      if (!connector) {
        return { success: false, message: "Editor not ready" }
      }

      try {
        switch (command.type) {
          case "insert_text":
            return insertText(command.text, command.position)
          case "replace_text":
            await callConnectorMethod("SearchAndReplace", [
              {
                searchString: command.searchText,
                replaceString: command.replaceText,
                matchCase: command.matchCase ?? false,
              },
            ])
            return { success: true, message: `Replaced "${command.searchText}" with "${command.replaceText}"` }
          case "delete_text":
            await callConnectorMethod("SearchAndReplace", [{ searchString: command.searchText, replaceString: "" }])
            return { success: true, message: `Deleted "${command.searchText}"` }
          case "fill_form_field":
            return controller.fillFormField(command.fieldId, command.value)
          case "set_formatting":
            return applyFormatting(command)
        }
      } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
    async readContent() {
      try {
        if (documentType === "cell") {
          const selection = await getSelectionRange()
          return selection?.preview ?? ""
        }
        return (
          (await callCommand<string>(function () {
            const Api = (globalThis as Record<string, unknown>).Api as {
              GetDocument: () => {
                GetElementsCount: () => number
                GetElement: (index: number) => { GetText?: () => string }
              }
            }
            const document = Api.GetDocument()
            const items: string[] = []
            for (let index = 0; index < document.GetElementsCount(); index += 1) {
              const element = document.GetElement(index)
              if (element.GetText) {
                items.push(element.GetText())
              }
            }
            return items.join("\n") as unknown as void
          } as () => void)) ?? ""
        )
      } catch {
        return ""
      }
    },
    async getSelection() {
      try {
        return (await callConnectorMethod<string>("GetSelectedText")) ?? ""
      } catch {
        return ""
      }
    },
    async getStructure() {
      try {
        const result = await callConnectorMethod<Array<{ level: number; text: string }>>("GetDocumentStructure")
        return Array.isArray(result) ? result.map((item) => ({ level: item.level ?? 1, text: item.text ?? "" })) : []
      } catch {
        return [] satisfies DocumentHeading[]
      }
    },
    async getFormFields() {
      try {
        const result =
          await callConnectorMethod<Array<{ InternalId: string; Tag: string; Value: string }>>("GetAllContentControls")
        return Array.isArray(result)
          ? result.map((item) => ({
              id: item.InternalId,
              tag: item.Tag ?? "",
              type: "text",
              value: item.Value ?? "",
            }))
          : []
      } catch {
        return [] satisfies FormField[]
      }
    },
    async fillFormField(fieldId, value) {
      try {
        await callConnectorMethod("SetFormValue", [fieldId, value])
        return { success: true, message: `Set field ${fieldId}` }
      } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
    async readCells(range, sheetName) {
      try {
        const targetSheet = sheetName ? JSON.stringify(sheetName) : undefined
        const result = await callCommand<string>(
          new Function(`
            var Api = globalThis.Api;
            var sheet = ${targetSheet ? `Api.GetSheet(${targetSheet})` : "Api.GetActiveSheet()"};
            var rangeRef = sheet.GetRange(${JSON.stringify(range)});
            var rows = rangeRef.GetRowCount();
            var cols = rangeRef.GetColCount();
            var values = [];
            for (var row = 0; row < rows; row++) {
              var items = [];
              for (var col = 0; col < cols; col++) {
                var cell = rangeRef.GetCell(row, col);
                items.push(cell ? String(cell.GetValue()) : "");
              }
              values.push(items);
            }
            return JSON.stringify(values);
          `) as () => void,
        )
        return result ? (JSON.parse(result) as string[][]) : []
      } catch {
        return []
      }
    },
    async writeCells(startCell, values, sheetName) {
      try {
        const targetSheet = sheetName ? JSON.stringify(sheetName) : undefined
        await callCommand<string>(
          new Function(`
            var Api = globalThis.Api;
            var sheet = ${targetSheet ? `Api.GetSheet(${targetSheet})` : "Api.GetActiveSheet()"};
            var values = ${JSON.stringify(values)};
            var startRange = sheet.GetRange(${JSON.stringify(startCell)});
            var startRow = startRange.GetRow() - 1;
            var startCol = startRange.GetCol() - 1;
            for (var row = 0; row < values.length; row++) {
              for (var col = 0; col < values[row].length; col++) {
                var cell = sheet.GetRangeByNumber(startRow + row, startCol + col);
                cell.SetValue(values[row][col] != null ? String(values[row][col]) : "");
              }
            }
            return "ok";
          `) as () => void,
        )
        return { success: true, message: `Wrote ${values.length} row(s) starting at ${startCell}` }
      } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
    async getSheetNames() {
      try {
        const result = await callCommand<string>(function () {
          var Api = (globalThis as Record<string, unknown>).Api as {
            GetSheets: () => Array<{ GetName: () => string }>
          }
          var sheets = Api.GetSheets()
          var names: string[] = []
          for (var index = 0; index < sheets.length; index += 1) {
            names.push(sheets[index].GetName())
          }
          return JSON.stringify(names) as unknown as void
        } as () => void)
        return result ? (JSON.parse(result) as string[]) : []
      } catch {
        return []
      }
    },
    async getActiveCell() {
      try {
        const result = await callCommand<string>(function () {
          var Api = (globalThis as Record<string, unknown>).Api as {
            GetActiveSheet: () => {
              GetName: () => string
              GetActiveCell: () => { GetAddress: (row: boolean, col: boolean) => string; GetValue: () => string }
            }
          }
          var sheet = Api.GetActiveSheet()
          var cell = sheet.GetActiveCell()
          return JSON.stringify({
            cell: cell.GetAddress(false, false),
            sheetName: sheet.GetName(),
            value: String(cell.GetValue()),
          }) as unknown as void
        } as () => void)
        return result
          ? (JSON.parse(result) as { cell: string; sheetName: string; value: string })
          : { cell: "A1", sheetName: "Sheet1", value: "" }
      } catch {
        return { cell: "A1", sheetName: "Sheet1", value: "" }
      }
    },
    getSelectionRange,
  }

  editorBridge.registerEditor(
    createEditorRecord({
      id: props.editorID,
      sessionID: props.sessionID,
      filePath: props.filePath,
      fileName: props.fileName,
      fileExt: props.fileExt,
      documentType,
      controller,
    }),
  )

  createEffect(() => {
    editorBridge.setActive(props.editorID, props.active)
  })

  onCleanup(() => {
    editorBridge.unregisterEditor(props.editorID)
  })

  onMount(() => {
    createEffect(() => {
      reloadNonce()
      let disposed = false

      const resetEditor = () => {
        clearReadyTimeout()
        clearSelectionInterval()
        clearIframeObserver()
        clearFileWatchInterval()
        knownMtimeMs = null
        connector = null
        if (editorInstance) {
          try {
            editorInstance.destroyEditor()
          } catch {
            // Ignore editor shutdown errors.
          }
          editorInstance = null
        }
        editorBridge.updateEditor(props.editorID, {
          ready: false,
          modified: false,
          selectedText: "",
          selectionRange: null,
        })
      }

      const syncSelection = async () => {
        if (documentType === "cell") {
          const selection = await controller.getSelectionRange()
          editorBridge.updateEditor(props.editorID, {
            selectedText: selection?.preview ?? "",
            selectionRange: selection,
          })
          return
        }

        const selectedText = await controller.getSelection()
        editorBridge.updateEditor(props.editorID, {
          selectedText,
          selectionRange: null,
        })
      }

      const init = async () => {
        resetEditor()
        setError(null)
        setIsLoading(true)

        if (!platform.serviceUrl) {
          setError({ message: "Desktop service URL is unavailable." })
          setIsLoading(false)
          return
        }

        try {
          const response = await (platform.fetch ?? window.fetch)(
            `${platform.serviceUrl}/api/editor/config?filePath=${encodeURIComponent(props.filePath)}`,
          )
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) {
            throw Object.assign(
              new Error(typeof payload.error === "string" ? payload.error : "Failed to load editor"),
              {
                code: typeof payload.code === "string" ? payload.code : undefined,
                details: typeof payload.details === "string" ? payload.details : undefined,
              },
            )
          }

          if (disposed) return

          const docServerUrl = String(payload.docServerUrl ?? "").replace(/\/+$/, "")
          const config = (payload.config ?? {}) as OOEditorConfig
          documentType = normalizeDocumentType(config.documentType, props.initialDocumentType)
          const transportMode = normalizeTransportMode(payload.transportMode)
          const documentSize =
            typeof payload.documentSize === "number" && Number.isFinite(payload.documentSize) ? payload.documentSize : 0

          await ensureOnlyOfficeApiScript(docServerUrl)
          if (disposed) return
          if (!window.DocsAPI?.DocEditor) {
            throw new Error("OnlyOffice API not available")
          }

          const editorConfig: OOEditorConfig = {
            ...config,
            events: {
              onAppReady: () => {
                // OnlyOffice shows its own loading UI inside the iframe once the app shell is mounted.
                dismissLoading()
              },
              onDocumentReady: () => {
                dismissLoading()

                try {
                  connector = typeof editorInstance?.createConnector === "function" ? editorInstance.createConnector() : null
                } catch (error) {
                  connector = null
                  console.warn("[OnlyOffice] Connector unavailable:", error)
                }

                editorBridge.updateEditor(props.editorID, {
                  documentType,
                  ready: Boolean(connector),
                  modified: false,
                })

                if (!connector) return

                void syncSelection()
                clearSelectionInterval()
                selectionInterval = setInterval(() => {
                  void syncSelection()
                }, 700)
              },
              onDocumentStateChange: (event) => {
                const modified =
                  typeof (event as { data?: unknown })?.data === "boolean"
                    ? Boolean((event as { data?: unknown }).data)
                    : false
                editorBridge.updateEditor(props.editorID, { modified })
              },
              onError: (event) => {
                const data = (event as { data?: { errorDescription?: string } })?.data
                clearReadyTimeout()
                clearSelectionInterval()
                setError({
                  message: data?.errorDescription || "Editor error",
                })
                setIsLoading(false)
                editorBridge.updateEditor(props.editorID, { ready: false })
              },
              onRequestClose: () => {
                clearSelectionInterval()
                editorBridge.updateEditor(props.editorID, { ready: false })
              },
            },
          }

          editorInstance = new window.DocsAPI.DocEditor(containerID, editorConfig)
          attachIframeReadyFallback()

          // Poll the file's modification time to detect external changes on disk.
          // When the file is modified outside the editor, auto-reload.
          clearFileWatchInterval()
          const fetchFn = platform.fetch ?? window.fetch
          const mtimeUrl = `${platform.serviceUrl}/api/editor/file-mtime?filePath=${encodeURIComponent(props.filePath)}`
          fetchFn(mtimeUrl)
            .then((r) => r.json())
            .then((data: { mtimeMs?: number }) => {
              if (disposed) return
              knownMtimeMs = data.mtimeMs ?? null
            })
            .catch(() => {})
          fileWatchInterval = setInterval(async () => {
            if (disposed || knownMtimeMs === null) return
            try {
              const r = await fetchFn(mtimeUrl)
              const data = (await r.json()) as { mtimeMs?: number }
              if (disposed || typeof data.mtimeMs !== "number") return
              if (data.mtimeMs !== knownMtimeMs) {
                clearFileWatchInterval()
                setReloadNonce((v) => v + 1)
              }
            } catch {
              // Ignore fetch errors — the service may be temporarily unavailable.
            }
          }, 2000)

          readyTimeout = setTimeout(() => {
            if (disposed) return
            clearSelectionInterval()
            editorBridge.updateEditor(props.editorID, { ready: false })
            setError({
              message:
                "Editor is taking too long to load. The Document Server likely cannot reach desktop callback/download endpoints.",
              code: "EDITOR_LOAD_TIMEOUT",
            })
            setIsLoading(false)
          }, getOnlyOfficeLoadTimeoutMs(transportMode, documentSize))
        } catch (cause) {
          if (disposed) return
          const error = cause as Error & { code?: string; details?: string }
          setError({
            message: error.message || "Failed to initialize editor",
            code: error.code,
            details: error.details,
          })
          setIsLoading(false)
        }
      }

      void init()

      onCleanup(() => {
        disposed = true
        resetEditor()
      })
    })
  })

  const retry = () => {
    setReloadNonce((value) => value + 1)
  }

  const openSettings = () => {
    command.trigger("settings.open")
  }

  return (
    <div class="relative h-full min-h-0 w-full min-w-0 overflow-hidden bg-surface-base">
      <Show when={error()}>
        {(details) => (
          <div class="flex h-full items-center justify-center p-8">
            <div class="max-w-xl space-y-4 text-center">
              <div class="space-y-1">
                <p class="text-14-medium text-text-danger">{details().message}</p>
                <Show when={details().details}>
                  <p class="text-12-regular text-text-weak">{details().details}</p>
                </Show>
                <p class="text-12-regular text-text-weak">
                  Make sure the hosted OnlyOffice Document Server and the desktop callback endpoint are both reachable.
                </p>
              </div>
              <div class="flex items-center justify-center gap-2">
                <Button size="small" variant="secondary" onClick={retry}>
                  Retry
                </Button>
                <Button size="small" variant="ghost" onClick={openSettings}>
                  Open Settings
                </Button>
              </div>
            </div>
          </div>
        )}
      </Show>

      <Show when={!error()}>
        <div class="relative h-full min-h-0 w-full min-w-0">
          <Show when={isLoading()}>
            <div class="absolute inset-0 z-10 flex items-center justify-center bg-background-base/90">
              <div class="flex flex-col items-center gap-3 text-text-weak">
                <div class="h-8 w-8 animate-spin rounded-full border-2 border-border-weak-base border-t-text-strong" />
                <span class="text-12-medium">Loading document editor…</span>
              </div>
            </div>
          </Show>
          <div id={containerID} ref={containerElement} class="h-full min-h-[480px] w-full min-w-0" />
        </div>
      </Show>
    </div>
  )
}
