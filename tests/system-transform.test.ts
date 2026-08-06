import { expect, test } from "bun:test"

test("merges the subagent instruction into the existing system message", async () => {
  const previousVisionMode = process.env["VISION_MODE"]
  process.env["VISION_MODE"] = "subagent"

  try {
    const { default: createVisionHelper } = await import("../plugins/vision-helper")
    const hooks = await createVisionHelper({} as never)
    const transform = hooks["experimental.chat.system.transform"]
    const originalSystemPrompt = "Original OpenCode system prompt"
    const output = { system: [originalSystemPrompt] }

    await transform?.(
      {
        model: {
          id: "text-only-model",
          capabilities: { input: { image: false } },
        },
        sessionID: "system-transform-test",
      } as never,
      output,
    )

    expect(output.system).toHaveLength(1)
    expect(output.system[0]?.startsWith(`${originalSystemPrompt}\n`)).toBe(true)
    expect(output.system[0]).toContain("IMPORTANT: This model does NOT support image input.")
    expect(output.system[0]).toContain("@image-reader")
  } finally {
    if (previousVisionMode === undefined) {
      delete process.env["VISION_MODE"]
    } else {
      process.env["VISION_MODE"] = previousVisionMode
    }
  }
})
