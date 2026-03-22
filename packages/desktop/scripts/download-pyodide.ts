#!/usr/bin/env bun
/**
 * Downloads the Pyodide runtime (Python compiled to WebAssembly) from GitHub releases.
 *
 * Usage:
 *   bun scripts/download-pyodide.ts
 *
 * Outputs to: packages/desktop/resources/pyodide/
 */

import { existsSync, mkdirSync, rmSync, readdirSync, statSync, cpSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { execSync } from "node:child_process"

const PYODIDE_VERSION = process.env.PYODIDE_VERSION?.trim() || "0.27.5"
const GITHUB_BASE = `https://github.com/pyodide/pyodide/releases/download/${PYODIDE_VERSION}`
const TARBALL_NAME = `pyodide-${PYODIDE_VERSION}.tar.bz2`
const TARBALL_URL = `${GITHUB_BASE}/${TARBALL_NAME}`

const __dirname = dirname(fileURLToPath(import.meta.url))
const RESOURCES_DIR = join(__dirname, "..", "resources", "pyodide")

/** Core Pyodide files needed at runtime. */
const CORE_FILES = [
  "pyodide.js",
  "pyodide.asm.js",
  "pyodide.asm.wasm",
  "pyodide_py.tar",
  "pyodide-lock.json",
  "python_stdlib.zip",
  "repodata.json",
]

/** Pre-bundled packages for data analytics. */
const PACKAGES = [
  "pandas",
  "numpy",
  "scipy",
  "matplotlib",
  "micropip",
  "pytz",
  "six",
  "packaging",
  "python-dateutil",
  "cycler",
  "kiwisolver",
  "pillow",
  "fonttools",
  "contourpy",
  "pyparsing",
]

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

function extractTarball(tarPath: string, extractDir: string) {
  console.log("Extracting tarball...")
  mkdirSync(extractDir, { recursive: true })
  execSync(`tar -xjf "${tarPath}" -C "${extractDir}"`, { stdio: "pipe" })
  console.log("Extraction complete")
}

function findPyodideRoot(extractDir: string): string {
  // The tarball usually extracts to a pyodide/ subdirectory
  const entries = readdirSync(extractDir)
  for (const entry of entries) {
    const candidate = join(extractDir, entry)
    if (statSync(candidate).isDirectory() && existsSync(join(candidate, "pyodide.asm.wasm"))) {
      return candidate
    }
  }
  // Maybe it extracted flat
  if (existsSync(join(extractDir, "pyodide.asm.wasm"))) {
    return extractDir
  }
  throw new Error("Could not find Pyodide root in extracted archive")
}

function copyPyodideFiles(pyodideRoot: string, outputDir: string) {
  mkdirSync(outputDir, { recursive: true })

  // Copy core files
  for (const file of CORE_FILES) {
    const src = join(pyodideRoot, file)
    if (existsSync(src)) {
      cpSync(src, join(outputDir, file))
      console.log(`Copied ${file}`)
    } else {
      console.warn(`Warning: core file not found: ${file}`)
    }
  }

  // Copy package .whl files
  const allFiles = readdirSync(pyodideRoot)
  const packageFiles = allFiles.filter((f) => {
    if (!f.endsWith(".whl") && !f.endsWith(".zip") && !f.endsWith(".tar")) return false
    const lower = f.toLowerCase()
    return PACKAGES.some((pkg) => lower.startsWith(pkg.toLowerCase().replace(/-/g, "_")))
  })

  for (const file of packageFiles) {
    cpSync(join(pyodideRoot, file), join(outputDir, file))
    console.log(`Copied package: ${file}`)
  }

  // Also copy any .data files needed by packages (e.g., numpy data)
  const dataFiles = allFiles.filter((f) => f.endsWith(".data"))
  for (const file of dataFiles) {
    cpSync(join(pyodideRoot, file), join(outputDir, file))
    console.log(`Copied data file: ${file}`)
  }
}

async function main() {
  console.log(`Pyodide version: ${PYODIDE_VERSION}`)

  // Clean previous download
  if (existsSync(RESOURCES_DIR)) {
    rmSync(RESOURCES_DIR, { recursive: true, force: true })
  }

  const downloadPath = join(tmpdir(), `pyodide-download-${Date.now()}.tar.bz2`)
  const extractDir = join(tmpdir(), `pyodide-extract-${Date.now()}`)

  try {
    await downloadFile(TARBALL_URL, downloadPath)
    extractTarball(downloadPath, extractDir)

    const pyodideRoot = findPyodideRoot(extractDir)
    copyPyodideFiles(pyodideRoot, RESOURCES_DIR)

    console.log(`\nPyodide installed to: ${RESOURCES_DIR}`)

    // Verify
    if (existsSync(join(RESOURCES_DIR, "pyodide.asm.wasm"))) {
      console.log("Verification: pyodide.asm.wasm exists")
    } else {
      throw new Error("pyodide.asm.wasm not found after extraction")
    }
  } finally {
    try {
      rmSync(downloadPath, { force: true })
    } catch {
      // Ignore cleanup errors
    }
    try {
      rmSync(extractDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  }
}

main().catch((error) => {
  console.error("Error:", error instanceof Error ? error.message : error)
  process.exit(1)
})
