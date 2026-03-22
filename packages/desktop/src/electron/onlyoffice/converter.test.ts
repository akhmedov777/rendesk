import { describe, expect, test } from "bun:test"
import { getFormatCode, getX2tPath, clearConversionCache, getConversionCacheSize } from "./converter"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdirSync, existsSync, writeFileSync } from "node:fs"

describe("converter utilities", () => {
  test("getFormatCode returns correct codes for known extensions", () => {
    expect(getFormatCode("docx")).toBe(65)
    expect(getFormatCode("xlsx")).toBe(257)
    expect(getFormatCode("pptx")).toBe(129)
    expect(getFormatCode("pdf")).toBe(513)
    expect(getFormatCode("csv")).toBe(260)
    expect(getFormatCode("bin")).toBe(8192)
  })

  test("getFormatCode returns undefined for unknown extensions", () => {
    expect(getFormatCode("txt")).toBeUndefined()
    expect(getFormatCode("png")).toBeUndefined()
  })

  test("getFormatCode strips leading dot", () => {
    expect(getFormatCode(".docx")).toBe(65)
    expect(getFormatCode(".PDF")).toBe(513)
  })

  test("getX2tPath returns platform-appropriate path", () => {
    const converterDir = "/fake/resources/converter"
    const result = getX2tPath(converterDir)
    if (process.platform === "win32") {
      expect(result).toBe(join(converterDir, "x2t.exe"))
    } else {
      expect(result).toBe(join(converterDir, "x2t"))
    }
  })

  test("clearConversionCache creates empty directory", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "converter-cache-"))
    const cacheDir = join(tempDir, "cache")
    mkdirSync(cacheDir, { recursive: true })

    // Create some fake cache content
    const subDir = join(cacheDir, "abc123")
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(subDir, "Editor.bin"), "fake-binary-data")

    expect(existsSync(join(subDir, "Editor.bin"))).toBe(true)

    clearConversionCache(cacheDir)

    expect(existsSync(cacheDir)).toBe(true)
    // The old content should be gone
    expect(existsSync(join(subDir, "Editor.bin"))).toBe(false)

    await rm(tempDir, { recursive: true, force: true })
  })

  test("getConversionCacheSize calculates total size of cached binaries", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "converter-cache-"))
    const cacheDir = join(tempDir, "cache")
    mkdirSync(cacheDir, { recursive: true })

    // Create fake cache entries
    const sub1 = join(cacheDir, "entry1")
    const sub2 = join(cacheDir, "entry2")
    mkdirSync(sub1)
    mkdirSync(sub2)
    writeFileSync(join(sub1, "Editor.bin"), "a".repeat(100))
    writeFileSync(join(sub2, "Editor.bin"), "b".repeat(200))

    const size = getConversionCacheSize(cacheDir)
    expect(size).toBe(300)

    await rm(tempDir, { recursive: true, force: true })
  })

  test("getConversionCacheSize returns 0 for non-existent directory", () => {
    expect(getConversionCacheSize("/non/existent/path")).toBe(0)
  })
})
