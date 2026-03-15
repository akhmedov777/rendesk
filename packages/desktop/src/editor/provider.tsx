import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  useContext,
  type ParentProps,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { ActiveEditorState, EditorDocumentType } from "../electron/onlyoffice/types"
import { executeEditorToolCall, isEditorToolName } from "./tool-executor"
import type { EditorController } from "./types"

type EditorRecord = ActiveEditorState & {
  id: string
  controller: EditorController
}

type RegisterEditorInput = Omit<EditorRecord, "selectedText" | "selectionRange" | "updatedAt" | "ready" | "modified">

type DesktopEditorContextValue = {
  registerEditor: (input: RegisterEditorInput) => void
  updateEditor: (
    id: string,
    next: Partial<Pick<EditorRecord, "documentType" | "selectedText" | "selectionRange" | "ready" | "modified">>,
  ) => void
  unregisterEditor: (id: string) => void
  setActive: (id: string, active: boolean) => void
}

const DesktopEditorContext = createContext<DesktopEditorContextValue>()
const [desktopActiveEditorState, setDesktopActiveEditorState] = createSignal<ActiveEditorState | null>(null)

function bridge() {
  return window.__BACKOFFICE__
}

export function DesktopEditorProvider(props: ParentProps) {
  const [state, setState] = createStore({
    activeEditorID: null as string | null,
    editors: {} as Record<string, EditorRecord>,
  })

  const activeEditor = createMemo(() => {
    const id = state.activeEditorID
    if (!id) return undefined
    return state.editors[id]
  })

  const activeSnapshot = createMemo<ActiveEditorState | undefined>(() => {
    const editor = activeEditor()
    if (!editor) return undefined
    return {
      sessionID: editor.sessionID,
      filePath: editor.filePath,
      fileName: editor.fileName,
      fileExt: editor.fileExt,
      documentType: editor.documentType,
      selectedText: editor.selectedText,
      selectionRange: editor.selectionRange,
      ready: editor.ready,
      modified: editor.modified,
      updatedAt: editor.updatedAt,
    }
  })

  let lastSyncedSessionID: string | null = null

  createEffect(() => {
    const api = bridge()
    if (!api?.updateEditorState || !api?.clearEditorState) return

    const editor = activeSnapshot()
    setDesktopActiveEditorState(editor ?? null)
    if (!editor) {
      if (lastSyncedSessionID) {
        void api.clearEditorState(lastSyncedSessionID).catch(() => undefined)
        lastSyncedSessionID = null
      }
      return
    }

    lastSyncedSessionID = editor.sessionID
    void api.updateEditorState(editor).catch(() => undefined)
  })

  onMount(() => {
    const api = bridge()
    if (!api?.onEditorToolRequest || !api?.sendEditorToolResult) return

    return api.onEditorToolRequest(async (payload) => {
      const editor = activeEditor()

      let result: string
      try {
        if (!editor || !editor.controller || !editor.ready) {
          result = JSON.stringify({ success: false, message: "Editor not ready" })
        } else if (!isEditorToolName(payload.toolName)) {
          result = JSON.stringify({ success: false, message: `Unknown editor tool: ${payload.toolName}` })
        } else {
          result = await executeEditorToolCall({
            controller: editor.controller,
            documentType: editor.documentType,
            toolName: payload.toolName,
            toolInput: payload.toolInput,
          })
        }
      } catch (error) {
        result = JSON.stringify({
          success: false,
          message: error instanceof Error ? error.message : String(error),
        })
      }

      await api.sendEditorToolResult(payload.requestId, result).catch(() => undefined)
    })
  })

  onCleanup(() => {
    setDesktopActiveEditorState(null)
    const api = bridge()
    if (!api?.clearEditorState || !lastSyncedSessionID) return
    void api.clearEditorState(lastSyncedSessionID).catch(() => undefined)
  })

  const value: DesktopEditorContextValue = {
    registerEditor(input) {
      setState("editors", input.id, {
        ...input,
        selectedText: "",
        selectionRange: null,
        ready: false,
        modified: false,
        updatedAt: Date.now(),
      })
    },
    updateEditor(id, next) {
      if (!state.editors[id]) return
      setState(
        "editors",
        id,
        produce((draft) => {
          Object.assign(draft, next)
          draft.updatedAt = Date.now()
        }),
      )
    },
    unregisterEditor(id) {
      if (!state.editors[id]) return
      setState(
        produce((draft) => {
          delete draft.editors[id]
          if (draft.activeEditorID === id) {
            draft.activeEditorID = null
          }
        }),
      )
    },
    setActive(id, active) {
      if (active) {
        setState("activeEditorID", id)
        return
      }
      if (state.activeEditorID === id) {
        setState("activeEditorID", null)
      }
    },
  }

  return <DesktopEditorContext.Provider value={value}>{props.children}</DesktopEditorContext.Provider>
}

export function useDesktopEditor() {
  const value = useContext(DesktopEditorContext)
  if (!value) {
    throw new Error("useDesktopEditor must be used within DesktopEditorProvider")
  }
  return value
}

export function createEditorRecord(input: {
  id: string
  sessionID: string
  filePath: string
  fileName: string
  fileExt: string
  documentType: EditorDocumentType
  controller: EditorController
}): RegisterEditorInput {
  return {
    id: input.id,
    sessionID: input.sessionID,
    filePath: input.filePath,
    fileName: input.fileName,
    fileExt: input.fileExt,
    documentType: input.documentType,
    controller: input.controller,
  }
}

export function getDesktopActiveEditorState() {
  return desktopActiveEditorState()
}
