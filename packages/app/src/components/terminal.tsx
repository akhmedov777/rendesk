import type { ComponentProps } from "solid-js"
import type { LocalPTY } from "@/context/terminal"

export interface TerminalProps extends ComponentProps<"div"> {
  pty: LocalPTY
  onSubmit?: () => void
  onCleanup?: (pty: Partial<LocalPTY> & { id: string }) => void
  onConnect?: () => void
  onConnectError?: (error: unknown) => void
}

export function Terminal(_props: TerminalProps) {
  return null
}
