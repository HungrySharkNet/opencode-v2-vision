import { beforeEach, describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import { VISION_TMP_DIR, runVision, saveImage } from "../plugins/vision-helper"

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

beforeEach(async () => {
  await fs.rm(VISION_TMP_DIR, { recursive: true, force: true })
  delete process.env["VISION_API_KEY"]
  delete process.env["VISION_API_URL"]
  delete process.env["VISION_MODEL"]
})

describe("runVision guards", () => {
  test("the native-vision guard wins", async () => {
    const result = await runVision({ __nativeVisionBlocked: true })
    expect(result).toContain("native-vision")
  })

  test("requires at least one path", async () => {
    expect(await runVision({})).toContain("no image path provided")
    expect(await runVision({ paths: [] })).toContain("no image path provided")
  })

  test("rejects paths outside the vision temp dir", async () => {
    const result = await runVision({ paths: ["/etc/passwd"] })
    expect(result).toContain("none of the specified images could be read")
  })

  test("rejects a missing file inside the temp dir", async () => {
    const result = await runVision({ paths: [path.join(VISION_TMP_DIR, "image1", "missing.png")] })
    expect(result).toContain("none of the specified images could be read")
  })

  test("requires API credentials", async () => {
    const saved = await saveImage(PNG_BASE64, "image/png")
    const result = await runVision({ paths: [saved!.filePath] })
    expect(result).toContain("VISION_API_KEY not set")
  })

  test("requires VISION_MODEL for OpenAI-compatible backends", async () => {
    process.env["VISION_API_KEY"] = "test-key"
    process.env["VISION_API_URL"] = "https://example.com/v1"
    const saved = await saveImage(PNG_BASE64, "image/png")
    const result = await runVision({ paths: [saved!.filePath] })
    expect(result).toContain("VISION_MODEL not set")
  })
})
