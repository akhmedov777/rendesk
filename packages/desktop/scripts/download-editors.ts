#!/usr/bin/env bun
/**
 * Downloads the OnlyOffice editor SDK assets (sdkjs, web-apps) from the
 * ONLYOFFICE/DesktopEditors GitHub release.
 *
 * Usage:
 *   bun scripts/download-editors.ts [--platform darwin|win32] [--arch arm64|x64]
 *
 * Outputs to: packages/desktop/resources/editors/
 */

import { existsSync, mkdirSync, chmodSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"
import { tmpdir } from "node:os"
import { rmSync, cpSync, readdirSync, statSync } from "node:fs"

const RELEASE_TAG = process.env.ONLYOFFICE_DESKTOP_EDITORS_TAG?.trim() || "v9.3.1"
const GITHUB_BASE = `https://github.com/ONLYOFFICE/DesktopEditors/releases/download/${RELEASE_TAG}`

const __dirname = dirname(fileURLToPath(import.meta.url))
const EDITORS_DIR = join(__dirname, "..", "resources", "editors")

function parseArgs() {
  const args = process.argv.slice(2)
  let platform = process.platform as string
  let arch = process.arch as string

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--platform" && args[i + 1]) {
      platform = args[i + 1]
      i++
    }
    if (args[i] === "--arch" && args[i + 1]) {
      arch = args[i + 1]
      i++
    }
  }

  return { platform, arch }
}

async function downloadFile(url: string, outputPath: string): Promise<void> {
  console.log(`Downloading: ${url}`)
  const response = await fetch(url, { redirect: "follow" })
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} for ${url}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  const { writeFileSync } = await import("node:fs")
  writeFileSync(outputPath, buffer)
  console.log(`Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB`)
}

function extractFromDmg(dmgPath: string, outputDir: string) {
  const mountPoint = join(tmpdir(), `editors-mount-${Date.now()}`)
  mkdirSync(mountPoint, { recursive: true })

  try {
    console.log("Mounting DMG...")
    execSync(`hdiutil attach "${dmgPath}" -mountpoint "${mountPoint}" -nobrowse -quiet`, {
      stdio: "pipe",
    })

    const apps = readdirSync(mountPoint).filter((f) => f.endsWith(".app"))
    if (apps.length === 0) {
      throw new Error("No .app bundle found in DMG")
    }

    const appPath = join(mountPoint, apps[0])
    const resourcesPath = join(appPath, "Contents", "Resources")

    // The DesktopEditors app nests editor assets under Resources/editors/
    const editorsBase = existsSync(join(resourcesPath, "editors"))
      ? join(resourcesPath, "editors")
      : resourcesPath

    console.log("\nAvailable in editors base:", editorsBase)
    if (existsSync(editorsBase)) {
      const entries = readdirSync(editorsBase)
      for (const e of entries) {
        const stat = statSync(join(editorsBase, e))
        console.log(`  ${stat.isDirectory() ? "[dir]" : "[file]"} ${e}`)
      }
    }

    // Search order for web-apps/sdkjs: editors/ first, then top-level Resources
    const searchPaths = [editorsBase, resourcesPath]

    // Copy web-apps directory
    let copiedWebApps = false
    for (const base of searchPaths) {
      const webAppsDir = join(base, "web-apps")
      if (existsSync(webAppsDir)) {
        console.log("\nCopying web-apps/...")
        cpSync(webAppsDir, join(outputDir, "web-apps"), { recursive: true })
        console.log("Copied web-apps/")
        copiedWebApps = true
        break
      }
    }
    if (!copiedWebApps) console.warn("web-apps/ not found in app bundle")

    // Copy sdkjs directory
    let copiedSdkjs = false
    for (const base of searchPaths) {
      const sdkjsDir = join(base, "sdkjs")
      if (existsSync(sdkjsDir)) {
        console.log("Copying sdkjs/...")
        cpSync(sdkjsDir, join(outputDir, "sdkjs"), { recursive: true })
        console.log("Copied sdkjs/")
        copiedSdkjs = true
        break
      }
    }
    if (!copiedSdkjs) console.warn("sdkjs/ not found in app bundle")

    // Copy sdkjs-plugins if available
    for (const base of searchPaths) {
      const pluginsDir = join(base, "sdkjs-plugins")
      if (existsSync(pluginsDir)) {
        console.log("Copying sdkjs-plugins/...")
        cpSync(pluginsDir, join(outputDir, "sdkjs-plugins"), { recursive: true })
        console.log("Copied sdkjs-plugins/")
        break
      }
    }

    // Look for desktop API stubs
    for (const candidate of ["desktop-stub.js", "desktop-stub-utils.js", "desktopEditorApi.js"]) {
      for (const base of [...searchPaths, join(editorsBase, "web-apps"), join(editorsBase, "web-apps", "apps", "api")]) {
        const src = join(base, candidate)
        if (existsSync(src)) {
          cpSync(src, join(outputDir, candidate))
          console.log(`Copied ${candidate}`)
          break
        }
      }
    }

    // Copy plugins.json if available
    for (const base of searchPaths) {
      const pluginsJson = join(base, "plugins.json")
      if (existsSync(pluginsJson)) {
        cpSync(pluginsJson, join(outputDir, "plugins.json"))
        console.log("Copied plugins.json")
        break
      }
    }

  } finally {
    try {
      execSync(`hdiutil detach "${mountPoint}" -quiet -force`, { stdio: "pipe" })
    } catch {
      // Ignore unmount errors
    }
    try {
      rmSync(mountPoint, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  }
}

function extractFromZip(zipPath: string, outputDir: string) {
  const extractDir = join(tmpdir(), `editors-extract-${Date.now()}`)
  mkdirSync(extractDir, { recursive: true })

  try {
    console.log("Extracting ZIP...")
    execSync(`unzip -q "${zipPath}" -d "${extractDir}"`, { stdio: "pipe" })

    // Find web-apps and sdkjs directories
    const findDir = (root: string, name: string): string | null => {
      const entries = readdirSync(root, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === name && entry.isDirectory()) {
          return join(root, entry.name)
        }
        if (entry.isDirectory()) {
          const found = findDir(join(root, entry.name), name)
          if (found) return found
        }
      }
      return null
    }

    const webAppsDir = findDir(extractDir, "web-apps")
    if (webAppsDir) {
      console.log("Copying web-apps/...")
      cpSync(webAppsDir, join(outputDir, "web-apps"), { recursive: true })
      console.log("Copied web-apps/")
    } else {
      console.warn("web-apps/ not found in ZIP")
    }

    const sdkjsDir = findDir(extractDir, "sdkjs")
    if (sdkjsDir) {
      console.log("Copying sdkjs/...")
      cpSync(sdkjsDir, join(outputDir, "sdkjs"), { recursive: true })
      console.log("Copied sdkjs/")
    } else {
      console.warn("sdkjs/ not found in ZIP")
    }
  } finally {
    try {
      rmSync(extractDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  }
}

function getDownloadUrl(platform: string, arch: string): string {
  if (platform === "darwin" && arch === "arm64") return `${GITHUB_BASE}/ONLYOFFICE-arm.dmg`
  if (platform === "darwin" && arch === "x64") return `${GITHUB_BASE}/ONLYOFFICE-x86_64.dmg`
  if (platform === "win32" && arch === "x64") return `${GITHUB_BASE}/DesktopEditors_x64.zip`
  if (platform === "win32" && arch === "arm64") return `${GITHUB_BASE}/DesktopEditors_arm64.zip`
  throw new Error(`Unsupported platform/arch: ${platform}/${arch}`)
}

async function main() {
  const { platform, arch } = parseArgs()
  console.log(`Platform: ${platform}, Arch: ${arch}`)

  const url = getDownloadUrl(platform, arch)

  mkdirSync(EDITORS_DIR, { recursive: true })

  const ext = url.endsWith(".dmg") ? "dmg" : "zip"
  const downloadPath = join(tmpdir(), `editors-download-${Date.now()}.${ext}`)

  try {
    await downloadFile(url, downloadPath)

    if (ext === "dmg") {
      extractFromDmg(downloadPath, EDITORS_DIR)
    } else {
      extractFromZip(downloadPath, EDITORS_DIR)
    }

    // Verify
    console.log("\nEditor assets installed to:", EDITORS_DIR)
    const contents = readdirSync(EDITORS_DIR)
    console.log("Contents:", contents.join(", "))

    if (existsSync(join(EDITORS_DIR, "sdkjs"))) {
      console.log("Verification: sdkjs/ exists")
    } else {
      console.warn("WARNING: sdkjs/ not found")
    }

    if (existsSync(join(EDITORS_DIR, "web-apps"))) {
      console.log("Verification: web-apps/ exists")
    } else {
      console.warn("WARNING: web-apps/ not found")
    }
  } finally {
    try {
      rmSync(downloadPath, { force: true })
    } catch {
      // Ignore cleanup errors
    }
  }
}

main().catch((error) => {
  console.error("Error:", error instanceof Error ? error.message : error)
  process.exit(1)
})
