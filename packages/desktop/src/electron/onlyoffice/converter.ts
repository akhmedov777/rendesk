import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, statSync, writeFileSync, rmSync, readdirSync } from "node:fs"
import { join, extname, dirname } from "node:path"
import { tmpdir } from "node:os"

const FORMAT_CODES: Record<string, number> = {
  // Binary editor format
  bin: 8192,
  // Word
  docx: 65,
  doc: 69,
  odt: 67,
  rtf: 66,
  // Cell
  xlsx: 257,
  xls: 261,
  ods: 259,
  csv: 260,
  // Slide
  pptx: 129,
  ppt: 133,
  odp: 131,
  // PDF
  pdf: 513,
}

export function getFormatCode(ext: string): number | undefined {
  return FORMAT_CODES[ext.toLowerCase().replace(/^\./, "")]
}

export function getX2tPath(converterDir: string): string {
  if (process.platform === "win32") {
    return join(converterDir, "x2t.exe")
  }
  return join(converterDir, "x2t")
}

function getCacheDir(cachePath: string, filePath: string): string {
  const hash = createHash("md5").update(filePath).digest("hex")
  return join(cachePath, hash)
}

function isCacheValid(cacheDir: string, sourceFilePath: string): boolean {
  const binPath = join(cacheDir, "Editor.bin")
  if (!existsSync(binPath)) return false

  try {
    const sourceStat = statSync(sourceFilePath)
    const binStat = statSync(binPath)
    return binStat.mtimeMs >= sourceStat.mtimeMs
  } catch {
    return false
  }
}

function runX2t(
  x2tPath: string,
  inputPath: string,
  outputPath: string,
  fontSelectionPath?: string,
): Promise<{ success: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env }
    if (process.platform === "darwin") {
      const frameworksPath = dirname(x2tPath)
      env.DYLD_FRAMEWORK_PATH = frameworksPath
      env.DYLD_LIBRARY_PATH = frameworksPath
    }

    const args = [inputPath, outputPath]
    if (fontSelectionPath && existsSync(fontSelectionPath)) {
      args.push(fontSelectionPath)
    }

    const child = spawn(x2tPath, args, {
      cwd: dirname(x2tPath),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on("close", (code) => {
      resolve({ success: code === 0, stderr })
    })

    child.on("error", (error) => {
      resolve({ success: false, stderr: error.message })
    })
  })
}

export async function convertToBinary(input: {
  filePath: string
  converterPath: string
  cachePath: string
  fontSelectionPath?: string
}): Promise<{ binPath: string; cached: boolean }> {
  const cacheDir = getCacheDir(input.cachePath, input.filePath)

  if (isCacheValid(cacheDir, input.filePath)) {
    return { binPath: join(cacheDir, "Editor.bin"), cached: true }
  }

  mkdirSync(cacheDir, { recursive: true })

  const x2tPath = getX2tPath(input.converterPath)
  const outputPath = join(cacheDir, "Editor.bin")

  const result = await runX2t(x2tPath, input.filePath, outputPath, input.fontSelectionPath)

  if (!result.success || !existsSync(outputPath)) {
    throw new Error(`x2t conversion failed: ${result.stderr || "unknown error"}`)
  }

  return { binPath: outputPath, cached: false }
}

export async function convertFromBinary(input: {
  binData: Buffer
  outputPath: string
  converterPath: string
  cachePath: string
  fontSelectionPath?: string
}): Promise<void> {
  const ext = extname(input.outputPath).replace(/^\./, "").toLowerCase()
  const outputFormat = getFormatCode(ext)

  if (outputFormat === undefined) {
    throw new Error(`Unsupported output format: .${ext}`)
  }

  const tempDir = join(tmpdir(), `x2t-save-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tempDir, { recursive: true })

  const tempBinPath = join(tempDir, "Editor.bin")
  writeFileSync(tempBinPath, input.binData)

  const x2tPath = getX2tPath(input.converterPath)

  try {
    const result = await runX2t(x2tPath, tempBinPath, input.outputPath, input.fontSelectionPath)

    if (!result.success) {
      throw new Error(`x2t save conversion failed: ${result.stderr || "unknown error"}`)
    }
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  }
}

export function clearConversionCache(cachePath: string): void {
  if (existsSync(cachePath)) {
    rmSync(cachePath, { recursive: true, force: true })
    mkdirSync(cachePath, { recursive: true })
  }
}

export function getConversionCacheSize(cachePath: string): number {
  if (!existsSync(cachePath)) return 0

  let totalSize = 0

  try {
    const entries = readdirSync(cachePath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const binPath = join(cachePath, entry.name, "Editor.bin")
        if (existsSync(binPath)) {
          totalSize += statSync(binPath).size
        }
      }
    }
  } catch {
    // Ignore errors
  }

  return totalSize
}
