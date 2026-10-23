import { beforeEach, describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import plugin, { HINT_PREFIX, VISION_TMP_DIR } from "../plugins/vision-helper"

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

interface FakeWorld {
  ctx: any
  tools: any[]
  toolHooks: Record<string, (event: any) => any>
  sessionHooks: Record<string, (event: any) => any>
}

function fakeContext(options: { models?: any[]; durable?: any[] } = {}): FakeWorld {
  const tools: any[] = []
  const toolHooks: Record<string, (event: any) => any> = {}
  const sessionHooks: Record<string, (event: any) => any> = {}
  const models = options.models ?? []

  const ctx = {
    app: { version: "2.1.3" },
    location: {
      directory: process.cwd(),
      project: { id: "proj", directory: process.cwd(), canonical: process.cwd() },
    },
    options: {},
    model: { list: async () => ({ location: {}, data: models }) },
    tool: {
      transform: async (callback: any) => {
        callback({
          add: (tool: any) => tools.push(tool),
          update: () => {},
          get: () => undefined,
          list: () => tools,
          remove: () => {},
          namespace: () => {},
        })
        return { dispose: async () => {} }
      },
      hook: async (name: string, callback: any) => {
        toolHooks[name] = callback
        return { dispose: async () => {} }
      },
      list: async () => tools,
      reload: async () => {},
    },
    session: {
      hook: async (name: string, callback: any) => {
        sessionHooks[name] = callback
        return { dispose: async () => {} }
      },
      context: async () => options.durable ?? [],
    },
    event: {
      subscribe: async function* () {
        // no events in tests
      },
    },
  }

  return { ctx, tools, toolHooks, sessionHooks }
}

const textOnlyModel = [{ providerID: "acme", modelID: "text", id: "text", capabilities: { input: ["text"] } }]
const nativeModel = [{ providerID: "acme", modelID: "vision", id: "vision", capabilities: { input: ["text", "image"] } }]

function userMessage(parts: any[]) {
  return { role: "user", content: parts }
}

function imagePart() {
  return {
    type: "media",
    media: {
      kind: "image",
      mediaType: "image/png",
      source: { type: "base64", data: PNG_BASE64, mediaType: "image/png" },
    },
  }
}

function contextEvent(sessionID: string, modelID: string, messages: any[]) {
  return {
    sessionID,
    model: { providerID: "acme", id: modelID },
    agent: "build",
    system: [] as any[],
    messages,
    options: {},
    tools: {},
  }
}

async function start(options: { models?: any[]; durable?: any[] } = {}) {
  const world = fakeContext(options)
  const cleanup = await (plugin as any).setup(world.ctx)
  return { world, cleanup }
}

beforeEach(async () => {
  delete process.env["VISION_MODE"]
  delete process.env["VISION_API_KEY"]
  delete process.env["VISION_SUBAGENT_NAME"]
  await fs.rm(VISION_TMP_DIR, { recursive: true, force: true })
})

describe("plugin shape", () => {
  test("is a v2 plugin definition", () => {
    expect((plugin as any).id).toBe("opencode-vision")
    expect(typeof (plugin as any).setup).toBe("function")
  })
})

describe("setup(ctx)", () => {
  test("registers the vision tool with codemode disabled", async () => {
    const { world, cleanup } = await start({ models: textOnlyModel })
    const tool = world.tools.find((entry) => entry.name === "vision")
    expect(tool).toBeDefined()
    expect(tool.options).toEqual({ codemode: false })
    expect(tool.input.type).toBe("object")
    expect(typeof tool.execute).toBe("function")
    cleanup()
  })

  test("replaces image parts with hints for text-only models", async () => {
    process.env["VISION_MODE"] = "api"
    const { world, cleanup } = await start({ models: textOnlyModel })

    const message = userMessage([{ type: "text", text: "what is this?" }, imagePart()])
    await world.sessionHooks["context"](contextEvent("s1", "text", [message]))

    expect(message.content).toHaveLength(2)
    const hint = message.content[1]
    expect(hint.type).toBe("text")
    expect(hint.text.startsWith(HINT_PREFIX)).toBe(true)
    expect(hint.text).toContain("vision tool")

    const filePath = /saved to (.+?) —/.exec(hint.text)?.[1]
    expect(filePath).toBeDefined()
    expect((await fs.stat(filePath as string)).isFile()).toBe(true)
    cleanup()
  })

  test("leaves media alone and warns native-vision models", async () => {
    const { world, cleanup } = await start({ models: nativeModel })
    const message = userMessage([imagePart()])
    const event = contextEvent("s2", "vision", [message])

    await world.sessionHooks["context"](event)

    expect(message.content[0].type).toBe("media")
    expect(event.system[0].text).toContain("native image input")
    cleanup()
  })

  test("blocks the vision tool for native-vision sessions", async () => {
    const { world, cleanup } = await start({ models: nativeModel })
    await world.sessionHooks["context"](contextEvent("s3", "vision", [userMessage([imagePart()])]))

    const call: any = { tool: "vision", sessionID: "s3", agent: "build", messageID: "m", id: "c", input: { paths: ["/tmp/a.png"] } }
    await world.toolHooks["execute.before"](call)
    expect(call.input.__nativeVisionBlocked).toBe(true)
    cleanup()
  })

  test("leaves unrelated tool calls untouched", async () => {
    const { world, cleanup } = await start({ models: nativeModel })
    await world.sessionHooks["context"](contextEvent("s6", "vision", [userMessage([imagePart()])]))

    const call: any = { tool: "read", sessionID: "s6", agent: "build", messageID: "m", id: "c", input: { path: "/tmp/a.png" } }
    await world.toolHooks["execute.before"](call)
    expect(call.input).toEqual({ path: "/tmp/a.png" })
    cleanup()
  })

  test("falls back to durable attachments when media is stripped", async () => {
    process.env["VISION_MODE"] = "api"
    const durable = [{ type: "user", files: [{ mime: "image/png", data: PNG_BASE64, name: "shot.png" }] }]
    const { world, cleanup } = await start({ models: textOnlyModel, durable })

    const message = userMessage([{ type: "text", text: "look" }])
    await world.sessionHooks["context"](contextEvent("s4", "text", [message]))

    expect(message.content).toHaveLength(2)
    expect(message.content[1].text.startsWith(HINT_PREFIX)).toBe(true)
    cleanup()
  })

  test("removes hints injected on an earlier pass", async () => {
    process.env["VISION_MODE"] = "api"
    const { world, cleanup } = await start({ models: textOnlyModel })

    const stale = `${HINT_PREFIX} stale hint]`
    const message = userMessage([{ type: "text", text: "look" }, { type: "text", text: stale }])
    await world.sessionHooks["context"](contextEvent("s5", "text", [message]))

    expect(message.content.some((part: any) => part.text === stale)).toBe(false)
    cleanup()
  })
})
