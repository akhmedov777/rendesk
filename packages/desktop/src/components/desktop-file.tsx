import { File as SharedFile, type FileProps } from "@rendesk/ui/file"
import { getEditorDocumentType, isOnlyOfficeExtension } from "../electron/onlyoffice/config"
import { OnlyOfficeEditor } from "./onlyoffice-editor"

type DesktopFileProps = FileProps & {
  editor?: {
    active: boolean
    sessionID: string
    path?: string | null
  }
}

export function DesktopFile(props: DesktopFileProps) {
  if (props.mode !== "text") {
    return <SharedFile {...props} />
  }

  const absolutePath = props.editor?.path
  const fileExt = absolutePath?.split(".").pop()?.toLowerCase() ?? ""
  const sessionID = props.editor?.sessionID?.trim() || (absolutePath ? `preview:${absolutePath}` : "")

  if (!absolutePath || !isOnlyOfficeExtension(fileExt)) {
    return <SharedFile {...props} />
  }

  return (
    <OnlyOfficeEditor
      editorID={`${sessionID}:${absolutePath}`}
      active={props.editor?.active ?? false}
      sessionID={sessionID}
      filePath={absolutePath}
      fileName={props.file.name}
      fileExt={fileExt}
      initialDocumentType={getEditorDocumentType(fileExt)}
    />
  )
}
