import { createSimpleContext } from "@rendesk/ui/context"

export type LocalPTY = {
  id: string
  title: string
  titleNumber: number
  rows?: number
  cols?: number
  buffer?: string
  scrollY?: number
  cursor?: number
}

export function getWorkspaceTerminalCacheKey(dir: string) {
  return `${dir}:__workspace__`
}

export function getLegacyTerminalStorageKeys(dir: string, legacySessionID?: string) {
  if (!legacySessionID) return [`${dir}/terminal.v1`]
  return [`${dir}/terminal/${legacySessionID}.v1`, `${dir}/terminal.v1`]
}

export function clearWorkspaceTerminals(_dir: string, _sessionIDs?: string[]) {}

export const { use: useTerminal, provider: TerminalProvider } = createSimpleContext({
  name: "Terminal",
  init: () => {
    const api = {
      ready: () => true,
      active: () => undefined as string | undefined,
      all: () => [] as LocalPTY[],
      new: () => undefined,
      select: (_id: string) => undefined,
      close: (_id: string) => undefined,
      rename: (_id: string, _title: string) => undefined,
      update: (_pty: Partial<LocalPTY> & { id: string }) => undefined,
      clear: () => undefined,
    }
    return api
  },
})
