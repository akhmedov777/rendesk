import { watch, statSync, type FSWatcher } from "node:fs"

export type FileChangeCallback = (filePath: string, mtimeMs: number) => void

type WatchEntry = {
  watcher: FSWatcher
  debounceTimer: ReturnType<typeof setTimeout> | null
}

const watchers = new Map<string, WatchEntry>()

const DEBOUNCE_MS = 500

export function watchFile(filePath: string, onChange: FileChangeCallback): void {
  stopWatching(filePath)

  try {
    const watcher = watch(filePath, { persistent: false }, (_eventType) => {
      const entry = watchers.get(filePath)
      if (!entry) return

      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer)
      }

      entry.debounceTimer = setTimeout(() => {
        entry.debounceTimer = null
        try {
          const stat = statSync(filePath)
          onChange(filePath, stat.mtimeMs)
        } catch {
          // File may have been deleted — ignore.
        }
      }, DEBOUNCE_MS)
    })

    watcher.on("error", () => {
      stopWatching(filePath)
    })

    watchers.set(filePath, { watcher, debounceTimer: null })
  } catch {
    // If watch fails (e.g. file doesn't exist), silently ignore.
  }
}

export function stopWatching(filePath: string): void {
  const entry = watchers.get(filePath)
  if (!entry) return

  if (entry.debounceTimer) {
    clearTimeout(entry.debounceTimer)
  }
  try {
    entry.watcher.close()
  } catch {
    // Ignore close errors.
  }
  watchers.delete(filePath)
}

export function stopAllWatchers(): void {
  for (const filePath of watchers.keys()) {
    stopWatching(filePath)
  }
}
