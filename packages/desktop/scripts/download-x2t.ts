#!/usr/bin/env bun
/**
 * Downloads the x2t converter binary from ONLYOFFICE/DesktopEditors GitHub releases.
 *
 * Usage:
 *   bun scripts/download-x2t.ts [--platform darwin|win32] [--arch arm64|x64]
 *
 * Outputs to: packages/desktop/resources/converter/
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
const RESOURCES_DIR = join(__dirname, "..", "resources", "converter")

type PlatformConfig = {
  url: string
  extractBinary: (downloadPath: string, outputDir: string) => void
}

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
  const mountPoint = join(tmpdir(), `x2t-mount-${Date.now()}`)
  mkdirSync(mountPoint, { recursive: true })

  try {
    console.log("Mounting DMG...")
    execSync(`hdiutil attach "${dmgPath}" -mountpoint "${mountPoint}" -nobrowse -quiet`, {
      stdio: "pipe",
    })

    // Find the .app bundle
    const apps = readdirSync(mountPoint).filter((f) => f.endsWith(".app"))
    if (apps.length === 0) {
      throw new Error("No .app bundle found in DMG")
    }

    const appPath = join(mountPoint, apps[0])
    const resourcesPath = join(appPath, "Contents", "Resources")
    const converterDir = join(resourcesPath, "converter")

    if (!existsSync(converterDir)) {
      throw new Error(`Converter directory not found at ${converterDir}`)
    }

    // Copy x2t binary
    const x2tSrc = join(converterDir, "x2t")
    if (existsSync(x2tSrc)) {
      cpSync(x2tSrc, join(outputDir, "x2t"))
      chmodSync(join(outputDir, "x2t"), 0o755)
      console.log("Copied x2t binary")
    }

    // Copy frameworks
    const frameworkNames = [
      "DjVuFile.framework",
      "doctrenderer.framework",
      "graphics.framework",
      "HtmlFile2.framework",
      "HtmlRenderer.framework",
      "kernel.framework",
      "kernel_network.framework",
      "PdfFile.framework",
      "UnicodeConverter.framework",
      "XpsFile.framework",
    ]

    const frameworksDir = join(appPath, "Contents", "Frameworks")
    for (const fw of frameworkNames) {
      const fwSrc = join(frameworksDir, fw)
      if (existsSync(fwSrc)) {
        cpSync(fwSrc, join(outputDir, fw), { recursive: true })
        console.log(`Copied ${fw}`)
      }
    }

    // Also check converter directory for additional libs
    const converterFiles = readdirSync(converterDir)
    for (const file of converterFiles) {
      if (file !== "x2t") {
        const src = join(converterDir, file)
        const stat = statSync(src)
        if (stat.isFile()) {
          cpSync(src, join(outputDir, file))
        } else if (stat.isDirectory()) {
          cpSync(src, join(outputDir, file), { recursive: true })
        }
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

function extractFromZip(zipPath: string, outputDir: string, targetPlatform: string) {
  const extractDir = join(tmpdir(), `x2t-extract-${Date.now()}`)
  mkdirSync(extractDir, { recursive: true })

  try {
    console.log("Extracting ZIP...")
    execSync(`unzip -q "${zipPath}" -d "${extractDir}"`, { stdio: "pipe" })

    // Find converter directory (may be nested)
    const findConverter = (dir: string): string | null => {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === "converter" && entry.isDirectory()) {
          return join(dir, entry.name)
        }
        if (entry.isDirectory()) {
          const found = findConverter(join(dir, entry.name))
          if (found) return found
        }
      }
      return null
    }

    const converterDir = findConverter(extractDir)
    if (!converterDir) {
      throw new Error("Converter directory not found in ZIP")
    }

    // Copy x2t binary
    const x2tName = targetPlatform === "win32" ? "x2t.exe" : "x2t"
    const x2tSrc = join(converterDir, x2tName)
    if (existsSync(x2tSrc)) {
      cpSync(x2tSrc, join(outputDir, x2tName))
      if (process.platform !== "win32") {
        chmodSync(join(outputDir, x2tName), 0o755)
      }
      console.log("Copied x2t binary")
    }

    // Copy supporting files
    const entries = readdirSync(converterDir)
    for (const file of entries) {
      if (file === x2tName) continue
      const src = join(converterDir, file)
      const stat = statSync(src)
      if (stat.isFile()) {
        cpSync(src, join(outputDir, file))
      } else if (stat.isDirectory()) {
        cpSync(src, join(outputDir, file), { recursive: true })
      }
    }
  } finally {
    try {
      rmSync(extractDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  }
}

function getPlatformConfig(platform: string, arch: string): PlatformConfig {
  if (platform === "darwin" && arch === "arm64") {
    return {
      url: `${GITHUB_BASE}/ONLYOFFICE-arm.dmg`,
      extractBinary: extractFromDmg,
    }
  }

  if (platform === "darwin" && arch === "x64") {
    return {
      url: `${GITHUB_BASE}/ONLYOFFICE-x86_64.dmg`,
      extractBinary: extractFromDmg,
    }
  }

  if (platform === "win32" && arch === "x64") {
    return {
      url: `${GITHUB_BASE}/DesktopEditors_x64.zip`,
      extractBinary: (downloadPath, outputDir) => extractFromZip(downloadPath, outputDir, platform),
    }
  }

  if (platform === "win32" && arch === "arm64") {
    return {
      url: `${GITHUB_BASE}/DesktopEditors_arm64.zip`,
      extractBinary: (downloadPath, outputDir) => extractFromZip(downloadPath, outputDir, platform),
    }
  }

  throw new Error(`Unsupported platform/arch: ${platform}/${arch}`)
}

async function main() {
  const { platform, arch } = parseArgs()
  console.log(`Platform: ${platform}, Arch: ${arch}`)

  const config = getPlatformConfig(platform, arch)

  mkdirSync(RESOURCES_DIR, { recursive: true })

  const ext = config.url.endsWith(".dmg") ? "dmg" : "zip"
  const downloadPath = join(tmpdir(), `x2t-download-${Date.now()}.${ext}`)

  try {
    await downloadFile(config.url, downloadPath)
    config.extractBinary(downloadPath, RESOURCES_DIR)
    console.log(`\nx2t converter installed to: ${RESOURCES_DIR}`)

    // Verify
    const x2tName = platform === "win32" ? "x2t.exe" : "x2t"
    if (existsSync(join(RESOURCES_DIR, x2tName))) {
      console.log("Verification: x2t binary exists")
    } else {
      throw new Error("x2t binary not found after extraction")
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
