import { beforeEach, describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import path from "node:path"
import {
  HINT_PREFIX,
  VISION_TMP_DIR,
  buildImageHint,
  imageExtension,
  isImagePart,
  isPluginInjectedText,
  mediaPayload,
  missingImageHint,
  resolveVisionMode,
  saveImage,
  supportsImageInputs,
  systemInstruction,
  visionSubagentName,
} from "../plugins/vision-helper"

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

beforeEach(async () => {
  await fs.rm(VISION_TMP_DIR, { recursive: true, force: true })
})

describe("isPluginInjectedText", () => {
  test("matches current and legacy hints", () => {
    expect(isPluginInjectedText(buildImageHint("/tmp/a.png", 1, "api"))).toBe(true)
    expect(isPluginInjectedText(missingImageHint())).toBe(true)
    expect(isPluginInjectedText("[Image #1 auto-saved to /tmp/x.png]")).toBe(true)
    expect(isPluginInjectedText("[Images auto-saved to:\n  /tmp/x.png]")).toBe(true)
    expect(isPluginInjectedText("[vision: image1/abc.png]")).toBe(true)
  })

  test("ignores real user text", () => {
    const texts = [
      "",
      "hello",
      "[Image attached: photo.jpg]",
      " [opencode-v2-vision: x]",
      "use [opencode-v2-vision: x] here",
      "[vision: image1/abc]",
    ]
    for (const text of texts) expect(isPluginInjectedText(text)).toBe(false)
  })
})

describe("hints", () => {
  test("api mode points at the vision tool", () => {
    const hint = buildImageHint(path.join(VISION_TMP_DIR, "image3", "abc.png"), 3, "api")
    expect(hint.startsWith(HINT_PREFIX)).toBe(true)
    expect(hint).toContain("vision tool")
    expect(hint).toContain("abc.png")
  })

  test("subagent mode names the subagent tool and agent", () => {
    process.env["VISION_SUBAGENT_NAME"] = "reader"
    try {
      const hint = buildImageHint("/tmp/x.png", 1, "subagent")
      expect(hint).toContain("`subagent` tool")
      expect(hint).toContain('agent "reader"')
    } finally {
      delete process.env["VISION_SUBAGENT_NAME"]
    }
  })
})

describe("systemInstruction", () => {
  test("native models are told not to call vision", () => {
    expect(systemInstruction(true)).toContain("native image input")
  })

  test("subagent mode delegates through the subagent tool", () => {
    const text = systemInstruction(false, "subagent")
    expect(text).toContain("`subagent` tool")
    expect(text).toContain("image-reader")
  })

  test("api mode points at the vision tool", () => {
    const text = systemInstruction(false, "api")
    expect(text).toContain("vision tool")
    expect(text).toContain("read")
  })
})

describe("mode detection", () => {
  test("explicit mode wins", () => {
    expect(resolveVisionMode({ VISION_MODE: "subagent", VISION_API_KEY: "k" })).toBe("subagent")
    expect(resolveVisionMode({ VISION_MODE: "api" })).toBe("api")
  })

  test("falls back to api with a key and subagent without", () => {
    expect(resolveVisionMode({ VISION_API_KEY: "k" })).toBe("api")
    expect(resolveVisionMode({})).toBe("subagent")
  })

  test("subagent name override", () => {
    expect(visionSubagentName({ VISION_SUBAGENT_NAME: "x" })).toBe("x")
    expect(visionSubagentName({})).toBe("image-reader")
  })
})

describe("imageExtension", () => {
  test("maps media types", () => {
    expect(imageExtension("image/png")).toBe("png")
    expect(imageExtension("image/jpeg")).toBe("jpg")
    expect(imageExtension("image/svg+xml")).toBe("svg")
  })

  test("falls back to the filename", () => {
    expect(imageExtension("application/octet-stream", "shot.WEBP")).toBe("webp")
    expect(imageExtension("", undefined)).toBe("png")
  })
})

describe("supportsImageInputs", () => {
  test("detects the image modality", () => {
    expect(supportsImageInputs(["text", "image"])).toBe(true)
    expect(supportsImageInputs(["image/png"])).toBe(true)
    expect(supportsImageInputs(["text"])).toBe(false)
    expect(supportsImageInputs(undefined)).toBe(false)
  })
})

describe("saveImage", () => {
  test("writes one file per unique image", async () => {
    const first = await saveImage(PNG_BASE64, "image/png")
    const second = await saveImage(PNG_BASE64, "image/png")
    expect(first).toBeDefined()
    expect(second?.seq).toBe(first?.seq)
    expect(second?.filePath).toBe(first?.filePath)
    const stat = await fs.stat(first!.filePath)
    expect(stat.isFile()).toBe(true)
  })
})

describe("mediaPayload / isImagePart", () => {
  test("reads base64 sources", () => {
    const part = {
      type: "media",
      media: { kind: "image", mediaType: "image/png", source: { type: "base64", data: PNG_BASE64, mediaType: "image/png" } },
    }
    expect(isImagePart(part)).toBe(true)
    expect(mediaPayload(part as never)?.base64).toBe(PNG_BASE64)
  })

  test("reads byte sources", () => {
    const bytes = Buffer.from(PNG_BASE64, "base64")
    const part = { type: "media", media: { source: { type: "bytes", data: new Uint8Array(bytes), mediaType: "image/jpeg" } } }
    expect(isImagePart(part)).toBe(true)
    const payload = mediaPayload(part as never)
    expect(payload?.mediaType).toBe("image/jpeg")
    expect(payload?.base64).toBe(PNG_BASE64)
  })

  test("prefers the inline view", () => {
    const part = { type: "media", media: { kind: "image", inline: () => ({ mime: "image/webp", base64: "AAAA" }) } }
    expect(mediaPayload(part as never)).toEqual({ base64: "AAAA", mediaType: "image/webp" })
  })

  test("url and ref sources carry no bytes", () => {
    expect(mediaPayload({ media: { source: { type: "url", url: "https://x" } } } as never)).toBeUndefined()
    expect(mediaPayload({ media: { source: { type: "ref", provider: "p", id: "1" } } } as never)).toBeUndefined()
  })

  test("text parts are not images", () => {
    expect(isImagePart({ type: "text", text: "hi" })).toBe(false)
  })
})
