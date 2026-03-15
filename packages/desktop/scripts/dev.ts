import { spawn, type ChildProcess } from "node:child_process"
import { watch } from "node:fs"
import { bootstrapDesktopEnv } from "../src/electron/env"
import { buildElectron } from "./build-electron"

const cwd = new URL("..", import.meta.url).pathname
const viteUrl = "http://127.0.0.1:1420"
const electronSourcePath = new URL("../src/electron", import.meta.url).pathname

const run = (command: string, args: string[], env?: Record<string, string>) =>
  spawn(command, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      ...env,
    },
  })

const waitForServer = async (url: string) => {
  for (let attempt = 0; attempt < 120; attempt++) {
    const ok = await fetch(url).then(() => true).catch(() => false)
    if (ok) return
    await Bun.sleep(250)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

const stopChild = (child?: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve()
      return
    }

    child.once("exit", () => resolve())
    child.kill("SIGTERM")
  })

await bootstrapDesktopEnv({ packaged: false })
await buildElectron()

const vite = run("bun", ["x", "vite", "--host", "127.0.0.1", "--port", "1420"])
await waitForServer(viteUrl)

let shuttingDown = false
let restartingElectron = false
let electron: ChildProcess | undefined
let rebuildRunning = false
let rebuildQueued = false
let rebuildTimer: ReturnType<typeof setTimeout> | undefined

let resolveExit!: () => void
let rejectExit!: (error: Error) => void

const finished = new Promise<void>((resolve, reject) => {
  resolveExit = resolve
  rejectExit = reject
})

const startElectron = () => {
  const child = run("bun", ["x", "electron", "./dist/electron/main.js"], {
    VITE_DEV_SERVER_URL: viteUrl,
  })

  electron = child
  child.on("exit", (code) => {
    if (restartingElectron || shuttingDown) return
    shuttingDown = true
    clearTimeout(rebuildTimer)
    watcher.close()
    vite.kill("SIGTERM")
    if (code && code !== 0) {
      rejectExit(new Error(`Electron exited with code ${code}`))
      return
    }
    resolveExit()
  })
}

const restartElectron = async () => {
  if (shuttingDown) return
  restartingElectron = true
  await stopChild(electron)
  restartingElectron = false
  if (shuttingDown) return
  startElectron()
}

const rebuildElectron = async () => {
  if (rebuildRunning || shuttingDown) {
    rebuildQueued = true
    return
  }

  rebuildRunning = true
  try {
    await buildElectron()
    await restartElectron()
  } catch (error) {
    console.error(error)
  } finally {
    rebuildRunning = false
    if (rebuildQueued && !shuttingDown) {
      rebuildQueued = false
      void rebuildElectron()
    }
  }
}

const queueRebuild = () => {
  if (shuttingDown) return
  if (rebuildTimer) clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(() => {
    void rebuildElectron()
  }, 150)
}

const watcher = watch(electronSourcePath, { recursive: true }, () => {
  queueRebuild()
})

startElectron()

const stop = () => {
  if (shuttingDown) return
  shuttingDown = true
  clearTimeout(rebuildTimer)
  watcher.close()
  vite.kill("SIGTERM")
  electron?.kill("SIGTERM")
}

process.on("SIGINT", stop)
process.on("SIGTERM", stop)

vite.on("exit", (code) => {
  if (shuttingDown) return
  shuttingDown = true
  clearTimeout(rebuildTimer)
  watcher.close()
  electron?.kill("SIGTERM")
  if (code && code !== 0) {
    rejectExit(new Error(`Vite exited with code ${code}`))
    return
  }
  resolveExit()
})

await finished
