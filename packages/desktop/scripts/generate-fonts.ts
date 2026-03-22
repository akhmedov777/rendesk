#!/usr/bin/env bun
/**
 * Generates font metadata files (AllFonts.js, font_selection.bin) required by the
 * OnlyOffice editor SDK. This script runs the allfontsgen tool against system fonts.
 *
 * Usage:
 *   bun scripts/generate-fonts.ts
 *
 * Prerequisites:
 *   - x2t converter must be downloaded first (bun scripts/download-x2t.ts)
 *   - allfontsgen binary must exist in resources/converter/ (included with x2t on some platforms)
 *
 * Outputs to: packages/desktop/resources/fonts/
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"
import { homedir } from "node:os"

const __dirname = dirname(fileURLToPath(import.meta.url))
const RESOURCES_DIR = join(__dirname, "..", "resources")
const FONTS_OUTPUT_DIR = join(RESOURCES_DIR, "fonts")
const CONVERTER_DIR = join(RESOURCES_DIR, "converter")

function getSystemFontDirs(): string[] {
  const platform = process.platform
  const dirs: string[] = []

  if (platform === "darwin") {
    dirs.push("/System/Library/Fonts")
    dirs.push("/Library/Fonts")
    dirs.push(join(homedir(), "Library", "Fonts"))
  } else if (platform === "win32") {
    dirs.push("C:\\Windows\\Fonts")
    const localFonts = join(homedir(), "AppData", "Local", "Microsoft", "Windows", "Fonts")
    if (existsSync(localFonts)) dirs.push(localFonts)
  } else {
    dirs.push("/usr/share/fonts")
    dirs.push("/usr/local/share/fonts")
    dirs.push(join(homedir(), ".local", "share", "fonts"))
    dirs.push(join(homedir(), ".fonts"))
  }

  return dirs.filter((dir) => existsSync(dir))
}

function findAllFontsGen(): string | null {
  const names = process.platform === "win32" ? ["allfontsgen.exe"] : ["allfontsgen"]

  for (const name of names) {
    const path = join(CONVERTER_DIR, name)
    if (existsSync(path)) return path
  }

  return null
}

async function main() {
  mkdirSync(FONTS_OUTPUT_DIR, { recursive: true })

  const allFontsGen = findAllFontsGen()

  if (allFontsGen) {
    console.log(`Found allfontsgen at: ${allFontsGen}`)
    const fontDirs = getSystemFontDirs()
    console.log(`System font directories: ${fontDirs.join(", ")}`)

    const fontDirArgs = fontDirs.map((dir) => `--input="${dir}"`).join(" ")
    const cmd = `"${allFontsGen}" ${fontDirArgs} --allfonts="${join(FONTS_OUTPUT_DIR, "AllFonts.js")}" --selection="${join(FONTS_OUTPUT_DIR, "font_selection.bin")}"`

    try {
      console.log("Running allfontsgen...")
      execSync(cmd, { stdio: "pipe" })
      console.log("Font metadata generated successfully")
    } catch (error) {
      console.warn("allfontsgen failed, generating minimal font stubs:", error instanceof Error ? error.message : error)
      generateMinimalFontStubs()
    }
  } else {
    console.log("allfontsgen not found, generating minimal font stubs")
    generateMinimalFontStubs()
  }

  // Verify output
  const allFontsPath = join(FONTS_OUTPUT_DIR, "AllFonts.js")
  const selectionPath = join(FONTS_OUTPUT_DIR, "font_selection.bin")

  if (existsSync(allFontsPath)) {
    console.log(`AllFonts.js: exists`)
  } else {
    console.warn("AllFonts.js was not created")
  }

  if (existsSync(selectionPath)) {
    console.log(`font_selection.bin: exists`)
  } else {
    console.warn("font_selection.bin was not created")
  }

  console.log(`\nFont metadata output: ${FONTS_OUTPUT_DIR}`)
}

function generateMinimalFontStubs() {
  // Generate a minimal AllFonts.js that the SDK can parse.
  // This allows the editor to start even without full font enumeration.
  const allFontsJs = `window["__AllFonts__"] = [];
window["__AllFontsFiles__"] = [];`

  writeFileSync(join(FONTS_OUTPUT_DIR, "AllFonts.js"), allFontsJs, "utf8")

  // Empty font_selection.bin — the editor will fall back to built-in fonts.
  writeFileSync(join(FONTS_OUTPUT_DIR, "font_selection.bin"), Buffer.alloc(0))
}

main().catch((error) => {
  console.error("Error:", error instanceof Error ? error.message : error)
  process.exit(1)
})
