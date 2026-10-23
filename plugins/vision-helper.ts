import type { Plugin } from "@opencode/plugin"
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// opencode-v2-vision — OpenCode v2 plugin
//
// OpenCode v2 hands prompt media to the provider unchanged, and text-only models
// reject image input. The plugin therefore rewrites every user image part into a
// text hint pointing at a temp copy on disk, so the model can reach the image
// through the `vision` tool (api mode) or a multimodal subagent (subagent mode).
//
// Native-vision models are left untouched: their media parts reach the model
// directly and the system prompt tells them not to call `vision`.
// ─────────────────────────────────────────────────────────────────────────────

export const PLUGIN_ID = "opencode-v2-vision"
export const VISION_TOOL_NAME = "vision"
export const HINT_PREFIX = "[opencode-v2-vision:"
export const VISION_TMP_DIR = path.join(tmpdir(), "opencode-v2-vision")

const TMP_DIR_RESOLVED = path.resolve(VISION_TMP_DIR)

// Cap each image to prevent malicious large files from exhausting memory.
const MAX_FILE_SIZE = 50 * 1024 * 1024

// Allowlist image extensions accepted by the external VLM path.
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"])

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
}

// How long a durable-attachment lookup result is reused for one session.
const DURABLE_HINT_TTL_MS = 2_000

// LRU eviction: when this many images are stored, the oldest image* dir is deleted.
// Default 200 images; adjustable via VISION_MAX_IMAGES.
const MAX_IMAGES = Number(process.env["VISION_MAX_IMAGES"] || 200)
const LRU_QUEUE: string[] = []

// Map from content hash → global image sequence number, ensuring each unique
// image gets a stable seq across the session.
const imageRegistry = new Map<string, number>()
// Reverse map: seq → hash, used to clean imageRegistry when LRU evicts a dir.
const reverseRegistry = new Map<number, string>()
let nextImageSeq = 1

export type VisionMode = "api" | "subagent"
type Env = Record<string, string | undefined>

/**
 * VISION_MODE controls how non-vision models obtain image descriptions:
 *   "api"      — the vision tool calls an external VLM API (VISION_API_KEY + VISION_API_URL).
 *   "subagent" — the model delegates to a multimodal subagent through the
 *                `subagent` tool. No external API key required.
 *
 * When VISION_MODE is unset the plugin uses "api" if VISION_API_KEY is present
 * and falls back to "subagent" so it works without external credentials.
 */
export function resolveVisionMode(env: Env = process.env): VisionMode {
  const raw = (env["VISION_MODE"] || "").toLowerCase()
  if (raw === "api" || raw === "subagent") return raw
  return env["VISION_API_KEY"] ? "api" : "subagent"
}

/** VISION_SUBAGENT_NAME overrides the subagent identifier (default: image-reader). */
export function visionSubagentName(env: Env = process.env): string {
  return env["VISION_SUBAGENT_NAME"] || "image-reader"
}

/**
 * Record access for LRU eviction. Deduplicates the queue so the same seqDir is
 * never counted twice — prevents queue bloat and accidental eviction of
 * in-use directories when the same image is referenced multiple times.
 */
function touchLRU(seqDir: string) {
  const idx = LRU_QUEUE.indexOf(seqDir)
  if (idx !== -1) LRU_QUEUE.splice(idx, 1)
  LRU_QUEUE.push(seqDir)

  while (LRU_QUEUE.length > MAX_IMAGES) {
    const oldest = LRU_QUEUE.shift()
    if (!oldest) break
    const seqMatch = oldest.match(/image(\d+)$/)
    if (seqMatch) {
      const evictedSeq = Number(seqMatch[1])
      const evictedHash = reverseRegistry.get(evictedSeq)
      if (evictedHash) {
        imageRegistry.delete(evictedHash)
        reverseRegistry.delete(evictedSeq)
      }
    }
    fs.rm(oldest, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Identifies text parts that THIS plugin injected into a message on a previous
 * pass. The context hook runs for every model request, so stale injections must
 * be cleared each time or the hint text accumulates.
 */
export function isPluginInjectedText(text: string): boolean {
  if (!text) return false
  return (
    text.startsWith(HINT_PREFIX) ||
    /^\[Image #\d+ auto-saved to /.test(text) ||
    /^\[Image #\d+ \w+\.\w+ auto-saved to /.test(text) ||
    /^\[Images auto-saved to:/.test(text) ||
    /^\[Images \(\d+\) auto-saved to:/.test(text) ||
    /^\[vision: image\d+\/[\w-]+\.[\w]+]$/.test(text)
  )
}

/** File extension (without dot) derived from a media type, then a filename. */
export function imageExtension(mediaType: string, filename?: string): string {
  const normalized = (mediaType.split(";")[0] || "").trim().toLowerCase()
  if (normalized.startsWith("image/")) {
    const subtype = normalized.slice("image/".length)
    if (subtype === "jpeg") return "jpg"
    if (subtype === "svg+xml") return "svg"
    const clean = subtype.replace(/[^a-z0-9]/g, "")
    if (clean) return clean
  }
  const fromName = filename ? path.extname(filename).replace(/^\./, "").toLowerCase() : ""
  return fromName || "png"
}

/** True when the model's `capabilities.input` includes an image modality. */
export function supportsImageInputs(inputs: readonly string[] | undefined): boolean {
  return Array.isArray(inputs) && inputs.some((modality) => modality === "image" || modality.startsWith("image/"))
}

/** Path hint injected in place of an image part for text-only models. */
export function buildImageHint(filePath: string, seq: number, mode: VisionMode = resolveVisionMode()): string {
  const tail =
    mode === "subagent"
      ? `— delegate to the \`subagent\` tool with agent "${visionSubagentName()}" to analyze it]`
      : "— use the vision tool with this path to analyze it]"
  return `${HINT_PREFIX} image #${seq} saved to ${filePath} ${tail}`
}

/** Hint used when an image part carries no readable inline payload. */
export function missingImageHint(): string {
  return `${HINT_PREFIX} an attached image could not be read — ask the user to re-attach it]`
}

/** System instruction appended for the current model, or undefined when none is needed. */
export function systemInstruction(nativeVision: boolean, mode: VisionMode = resolveVisionMode()): string | undefined {
  if (nativeVision) {
    return "You have native image input capabilities. You can directly view and analyze images attached to user messages. Do NOT call the `vision` tool to read images sent by the user — analyze them natively instead."
  }
  const name = visionSubagentName()
  if (mode !== "subagent") {
    return [
      "This model does NOT support image input.",
      `Image attachments are replaced with a path hint like "${HINT_PREFIX} image #1 saved to /tmp/opencode-v2-vision/image1/<hash>.png — use the vision tool ...]".`,
      "Call the `vision` tool with that exact path to analyze the image.",
      "Do not call the `read` tool on images — it fails for models without image input.",
    ].join(" ")
  }
  return [
    "IMPORTANT: This model does NOT support image input.",
    `Image attachments are replaced with a path hint like "${HINT_PREFIX} image #1 saved to /tmp/opencode-v2-vision/image1/<hash>.png — delegate to the \`subagent\` tool ...]",`,
    `When you see such a hint, call the \`subagent\` tool with agent="${name}", a short description, and a complete prompt asking it to analyze the image at that exact path.`,
    `The "${name}" subagent runs on a multimodal model and can view images.`,
    "Never call the `read` tool on an image yourself — it fails for models without image input.",
  ].join(" ")
}

export interface SavedImage {
  filePath: string
  seq: number
  name: string
}

/**
 * Persist one inline image under <tmp>/opencode-v2-vision/image{N}/<hash>.<ext>.
 * Identical bytes map to the same seq and are written only once.
 * Write failures degrade to undefined instead of breaking the turn.
 */
export async function saveImage(base64: string, mediaType: string, filename?: string): Promise<SavedImage | undefined> {
  if (!base64) return undefined

  // MD5 over the FULL base64 (16 hex chars) to avoid collisions for similar images.
  const hash = createHash("md5").update(base64).digest("hex").slice(0, 16)

  let seq = imageRegistry.get(hash)
  if (!seq) {
    seq = nextImageSeq++
    imageRegistry.set(hash, seq)
    reverseRegistry.set(seq, hash)
  }

  const name = `${hash}.${imageExtension(mediaType, filename)}`
  const seqDir = path.join(VISION_TMP_DIR, `image${seq}`)
  const filePath = path.join(seqDir, name)

  try {
    await fs.mkdir(seqDir, { recursive: true })
    const exists = await fs
      .stat(filePath)
      .then((stat) => stat.isFile())
      .catch(() => false)
    if (!exists) await fs.writeFile(filePath, Buffer.from(base64, "base64"))
  } catch (error) {
    console.error(`[vision-helper] failed to write ${filePath}:`, error)
    return undefined
  }

  touchLRU(seqDir)
  return { filePath, seq, name }
}

interface MediaLike {
  kind?: string
  mediaType?: string
  source?: { type?: string; data?: unknown; mediaType?: string; url?: string }
  inline?: () => { mime?: string; base64?: string } | undefined
}

/**
 * Synchronous base64 view of a v2 `MediaPart`. Handles the `Asset.inline()`
 * helper as well as raw `bytes` and `base64` sources; `url`/`ref` sources carry
 * no local bytes and are reported as unreadable.
 */
export function mediaPayload(part: { media?: MediaLike } | undefined): { base64: string; mediaType: string } | undefined {
  const asset = part?.media
  if (!asset) return undefined

  if (typeof asset.inline === "function") {
    try {
      const inline = asset.inline()
      if (inline && typeof inline.base64 === "string" && inline.base64) {
        return {
          base64: inline.base64,
          mediaType: inline.mime || asset.mediaType || asset.source?.mediaType || "image/png",
        }
      }
    } catch {
      // fall through to the raw source
    }
  }

  const source = asset.source
  if (!source) return undefined
  const mediaType = source.mediaType || asset.mediaType || "image/png"

  if (source.type === "base64" && typeof source.data === "string" && source.data) {
    return { base64: source.data, mediaType }
  }
  if (source.type === "bytes" && source.data) {
    const bytes = source.data instanceof Uint8Array ? source.data : new Uint8Array(source.data as ArrayBufferLike)
    return { base64: Buffer.from(bytes).toString("base64"), mediaType }
  }
  return undefined
}

/**True for v2 content parts that carry an image. */
export function isImagePart(part: unknown): boolean {
  const candidate = part as { type?: string; media?: MediaLike } | undefined
  if (!candidate || candidate.type !== "media") return false
  const kind = candidate.media?.kind
  if (kind) return kind === "image"
  const mediaType = candidate.media?.mediaType || candidate.media?.source?.mediaType || ""
  return mediaType.startsWith("image/")
}

// ─────────────────────────────────────────────────────────────────────────────
// `vision` tool — external VLM fallback
// ─────────────────────────────────────────────────────────────────────────────

export interface VisionToolInput {
  paths?: string[]
  path?: string
  question?: string
  __nativeVisionBlocked?: boolean
}

export const VISION_TOOL_INPUT: Record<string, unknown> = {
  type: "object",
  properties: {
    paths: {
      type: "array",
      items: { type: "string" },
      description: "Absolute path(s) to the image file(s). Pass every image you need described.",
    },
    path: {
      type: "string",
      description: "Deprecated: use 'paths' instead. Absolute path to a single image file.",
    },
    question: {
      type: "string",
      description: "Optional specific question about the image(s).",
    },
    __nativeVisionBlocked: {
      type: "boolean",
      description: "Internal guard set by the plugin when the active model has native image input.",
    },
  },
  additionalProperties: false,
}

export function visionToolDescription(): string {
  return [
    "Reads one or more image files through an external VLM API and returns a textual description.",
    "Use it for images saved by opencode-v2-vision (paths under the opencode-v2-vision temp directory) when the active model has no native image input.",
    "Native-vision models must NOT call this tool: analyze attached images directly or use the built-in `read` tool for local image files.",
    "Requires VISION_API_KEY and VISION_API_URL; VISION_MODEL is required for OpenAI-compatible backends and optional for MiniMax.",
  ].join("\n")
}

/** 60s default fetch timeout to prevent API hangs from freezing OpenCode. */
const FETCH_TIMEOUT_MS = Number(process.env["VISION_FETCH_TIMEOUT_MS"] || 60_000)

/**
 * Path sandbox: only read image files created under the temp dir. This prevents
 * prompt injection from exfiltrating sensitive local files by base64-uploading
 * them to the external VISION_API_URL backend.
 */
function sandboxPath(candidate: string): string | null {
  const resolved = path.resolve(candidate)
  if (!resolved.startsWith(TMP_DIR_RESOLVED + path.sep) && resolved !== TMP_DIR_RESOLVED) return null
  if (!IMAGE_EXTS.has(path.extname(resolved).toLowerCase())) return null
  return resolved
}

function mimeFor(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || "image/png"
}

function truncate(value: string, max = 1024): string {
  return value.length > max ? value.slice(0, max) + `... [truncated, ${value.length} bytes total]` : value
}

async function resolveImages(inputs: string[]): Promise<{ resolved: string[]; rejected: string[] }> {
  const resolved: string[] = []
  const rejected: string[] = []

  for (const input of inputs) {
    const candidates = [input, path.join(VISION_TMP_DIR, input), path.join(VISION_TMP_DIR, path.basename(input))]
    let found: string | undefined

    for (const candidate of candidates) {
      const safe = sandboxPath(candidate)
      if (!safe) continue
      const stat = await fs.stat(safe).catch(() => undefined)
      if (!stat || !stat.isFile()) continue
      if (stat.size > MAX_FILE_SIZE) {
        rejected.push(`${safe} (too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB > ${MAX_FILE_SIZE / 1024 / 1024}MB)`)
        found = undefined
        break
      }
      found = safe
      break
    }

    if (found) resolved.push(found)
    else rejected.push(input)
  }

  return { resolved, rejected }
}

/** Execute the `vision` tool and return the text the model should see. */
export async function runVision(args: VisionToolInput, signal?: AbortSignal): Promise<string> {
  if (args?.__nativeVisionBlocked) {
    return "Error: vision is disabled for the current native-vision model. Analyze the attached image directly, or use the built-in read tool for local image files. The external vision API is only for text-only models."
  }

  const requested: string[] = []
  if (Array.isArray(args?.paths) && args.paths.length > 0) requested.push(...args.paths)
  else if (typeof args?.path === "string" && args.path) requested.push(args.path)

  const inputs = requested.filter((value): value is string => typeof value === "string" && value.length > 0)
  if (inputs.length === 0) return "Error: no image path provided"

  const { resolved, rejected } = await resolveImages(inputs)
  if (resolved.length === 0) {
    const reasons = rejected.length > 0 ? `\nRejected paths (not in the vision temp dir, not an image, or too large):\n  ${rejected.join("\n  ")}` : ""
    return `Error: none of the specified images could be read.${reasons}\nTip: paths must point to images in ${TMP_DIR_RESOLVED} (e.g. ${TMP_DIR_RESOLVED}/image1/abc123.png).`
  }

  const apiKey = process.env["VISION_API_KEY"]
  const baseUrl = process.env["VISION_API_URL"]
  if (!apiKey) return "Error: VISION_API_KEY not set"
  if (!baseUrl) return "Error: VISION_API_URL not set"

  const apiType = (process.env["VISION_API_TYPE"] || "").toLowerCase()
  const isMiniMax = apiType === "minimax" || (!apiType && /minimax/i.test(baseUrl))

  if (isMiniMax) return callMiniMax(apiKey, baseUrl, resolved, args.question, signal)
  return callOpenAI(apiKey, baseUrl, resolved, args.question, signal)
}

interface FetchGuard {
  signal: AbortSignal
  timedOut: () => boolean
  abortReason: () => string | undefined
  dispose: () => void
}

/** Combine the tool cancellation signal with the plugin's fetch timeout. */
function fetchGuard(signal?: AbortSignal): FetchGuard {
  const controller = new AbortController()
  let timedOut = false
  let abortReason: string | undefined

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, FETCH_TIMEOUT_MS)

  const onAbort = () => {
    abortReason = "request aborted by OpenCode"
    controller.abort()
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    abortReason: () => abortReason,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    },
  }
}

function failure(guard: FetchGuard, error: unknown): string {
  if (guard.timedOut()) return `Vision API error: request timed out after ${FETCH_TIMEOUT_MS}ms`
  const reason = guard.abortReason()
  if (reason) return `Vision API error: ${reason}`
  const message = (error as Error | undefined)?.message
  return `Vision API error: ${message || "network request failed"}`
}

async function callOpenAI(apiKey: string, baseUrl: string, resolved: string[], question?: string, signal?: AbortSignal): Promise<string> {
  const model = process.env["VISION_MODEL"]
  if (!model) return "Error: VISION_MODEL not set (required for OpenAI-compatible backends)"

  const maxTokens = Number(process.env["VISION_MAX_TOKENS"] || 4096)
  const apiUrl = `${baseUrl.replace(/\/+$/, "")}/chat/completions`

  const content: Record<string, unknown>[] = []
  if (question) content.push({ type: "text", text: question })
  else if (resolved.length > 1) {
    content.push({
      type: "text",
      text: `Describe each of these ${resolved.length} images in detail, labeling which description corresponds to which file.`,
    })
  } else content.push({ type: "text", text: "Please describe this image in detail" })

  for (const filePath of resolved) {
    const base64 = (await fs.readFile(filePath)).toString("base64")
    content.push({ type: "image_url", image_url: { url: `data:${mimeFor(filePath)};base64,${base64}` } })
  }

  const guard = fetchGuard(signal)
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content }], max_tokens: maxTokens }),
      signal: guard.signal,
    })

    if (!response.ok) return `Vision API error (${response.status}): ${truncate(await response.text())}`

    let data: { choices?: { message?: { content?: string } }[] }
    try {
      data = (await response.json()) as typeof data
    } catch {
      return `Vision API error: response is not valid JSON — ${truncate(await response.text().catch(() => "(unreadable body)"))}`
    }
    return data.choices?.[0]?.message?.content ?? "No description returned."
  } catch (error) {
    return failure(guard, error)
  } finally {
    guard.dispose()
  }
}

interface MiniMaxBaseResp {
  status_code?: number
  status_msg?: string
}

interface MiniMaxVlmResponse {
  base_resp?: MiniMaxBaseResp
  content?: string
}

async function callMiniMax(apiKey: string, baseUrl: string, resolved: string[], question?: string, signal?: AbortSignal): Promise<string> {
  const apiUrl = `${baseUrl.replace(/\/+$/, "")}/v1/coding_plan/vlm`
  const descriptions: string[] = []

  for (const filePath of resolved) {
    const base64 = (await fs.readFile(filePath)).toString("base64")
    const imageUrl = `data:${mimeFor(filePath)};base64,${base64}`
    const prompt = question || "Please describe this image in detail"

    const guard = fetchGuard(signal)
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ prompt, image_url: imageUrl }),
        signal: guard.signal,
      })

      if (!response.ok) {
        descriptions.push(`[Error for ${path.basename(filePath)}]: API ${response.status} — ${truncate(await response.text())}`)
        continue
      }

      let data: MiniMaxVlmResponse
      try {
        data = (await response.json()) as MiniMaxVlmResponse
      } catch {
        descriptions.push(`[Error for ${path.basename(filePath)}]: response is not valid JSON`)
        continue
      }

      if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
        descriptions.push(`[Error for ${path.basename(filePath)}]: ${data.base_resp.status_msg || `status_code ${data.base_resp.status_code}`}`)
        continue
      }

      descriptions.push(data.content || "No description returned.")
    } catch (error) {
      descriptions.push(`[Error for ${path.basename(filePath)}]: ${failure(guard, error).replace(/^Vision API error: /, "")}`)
    } finally {
      guard.dispose()
    }
  }

  if (descriptions.length === 0) return "Error: no images were processed."
  if (descriptions.length === 1) return descriptions[0] ?? ""
  return descriptions.map((description, index) => `--- Image ${index + 1} ---\n${description}`).join("\n\n")
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin entrypoint
// ─────────────────────────────────────────────────────────────────────────────

interface ModelRef {
  providerID: string
  id: string
}

interface ModelEntry {
  providerID?: string
  id?: string
  modelID?: string
  capabilities?: { input?: string[] }
}

interface MessageLike {
  role?: string
  content?: unknown
}

interface DurableMessage {
  type?: string
  files?: Array<{ mime?: string; data?: string; name?: string }>
}

/**
 * OpenCode v2 plugin. `Plugin.define` is an identity helper, so a plain
 * `{ id, setup }` object is the complete definition; the type-only import keeps
 * the plugin free of runtime dependencies, which matters for loose `.ts` files
 * installed into ~/.config/opencode/plugins/.
 */
export default {
  id: PLUGIN_ID,
  async setup(ctx: Plugin.Context): Promise<() => void> {
    await fs.mkdir(VISION_TMP_DIR, { recursive: true }).catch(() => {})

    // providerID/modelID → model accepts image input
    const modelSupport = new Map<string, boolean>()
    // sessionID → active model accepts image input (used by execute.before)
    const sessionSupport = new Map<string, boolean>()
    // sessionID → cached durable-attachment hints
    const durableHints = new Map<string, { at: number; hints: string[] }>()

    const refreshModels = async () => {
      const result = (await ctx.model.list()) as unknown as { data?: unknown }
      const models = Array.isArray(result?.data) ? (result.data as ModelEntry[]) : []
      modelSupport.clear()
      for (const model of models) {
        if (!model || typeof model.providerID !== "string") continue
        const supports = supportsImageInputs(model.capabilities?.input)
        for (const id of [model.modelID, model.id]) {
          if (typeof id === "string") modelSupport.set(`${model.providerID}/${id}`, supports)
        }
      }
    }

    const modelSupportsImages = async (ref: ModelRef | undefined): Promise<boolean> => {
      if (!ref || typeof ref.providerID !== "string" || typeof ref.id !== "string") return false
      const key = `${ref.providerID}/${ref.id}`
      if (!modelSupport.has(key)) await refreshModels().catch(() => {})
      return modelSupport.get(key) ?? false
    }

    await refreshModels().catch(() => {})

    // `vision` tool. `codemode: false` is required: without it the tool is only
    // reachable through the `execute` code-mode tool and a direct call fails.
    await ctx.tool.transform((editor) => {
      editor.add({
        name: VISION_TOOL_NAME,
        description: visionToolDescription(),
        input: VISION_TOOL_INPUT as never,
        options: { codemode: false },
        async execute(input: unknown, context: { signal?: AbortSignal }) {
          return { content: await runVision(input as VisionToolInput, context?.signal) }
        },
      } as never)
    })

    // Native-vision guard: never burn external VLM calls when the model can see.
    await ctx.tool.hook("execute.before", (event) => {
      if (event.tool !== VISION_TOOL_NAME) return
      if (!sessionSupport.get(event.sessionID)) return
      event.input = { paths: [], __nativeVisionBlocked: true }
    })

    // Durable attachments of the session, used when the host already stripped
    // unsupported media before this hook ran.
    const readDurableHints = async (sessionID: string, mode: VisionMode): Promise<string[]> => {
      const cached = durableHints.get(sessionID)
      if (cached && Date.now() - cached.at < DURABLE_HINT_TTL_MS) return cached.hints

      const hints: string[] = []
      try {
        const messages = (await ctx.session.context({ sessionID })) as unknown
        for (const message of Array.isArray(messages) ? (messages as DurableMessage[]) : []) {
          if (message?.type !== "user" || !Array.isArray(message.files)) continue
          for (const file of message.files) {
            if (!file || typeof file.mime !== "string" || !file.mime.startsWith("image/")) continue
            if (typeof file.data !== "string" || !file.data) continue
            const saved = await saveImage(file.data, file.mime, file.name)
            if (saved) hints.push(buildImageHint(saved.filePath, saved.seq, mode))
          }
        }
      } catch {
        // Best effort: the primary path already replaced media parts above.
      }

      durableHints.set(sessionID, { at: Date.now(), hints })
      return hints
    }

    await ctx.session.hook("context", async (event) => {
      const mode = resolveVisionMode()
      const nativeVision = await modelSupportsImages(event.model)
      sessionSupport.set(event.sessionID, nativeVision)

      const instruction = systemInstruction(nativeVision, mode)
      if (instruction) event.system.push({ type: "text", text: instruction })

      let replaced = false
      let lastUser: MessageLike | undefined

      for (const message of event.messages as MessageLike[]) {
        if (message?.role !== "user") continue
        lastUser = message

        const content = message.content as unknown
        if (!Array.isArray(content)) continue
        const parts = content as Array<Record<string, unknown>>

        // Drop hints injected on an earlier pass so they never accumulate.
        for (let index = parts.length - 1; index >= 0; index--) {
          const part = parts[index]
          if (part?.["type"] === "text" && isPluginInjectedText(String(part["text"] ?? ""))) parts.splice(index, 1)
        }

        if (nativeVision) continue

        // Text-only model: OpenCode forwards media to the provider, which
        // rejects it, so every image part becomes a path hint instead.
        for (let index = 0; index < parts.length; index++) {
          const part = parts[index]
          if (!isImagePart(part)) continue
          const payload = mediaPayload(part as { media?: MediaLike })
          const filename = typeof part?.["filename"] === "string" ? (part["filename"] as string) : undefined
          const saved = payload ? await saveImage(payload.base64, payload.mediaType, filename) : undefined
          parts[index] = { type: "text", text: saved ? buildImageHint(saved.filePath, saved.seq, mode) : missingImageHint() }
          replaced = true
        }
      }

      if (nativeVision || replaced || !lastUser) return

      const hints = await readDurableHints(event.sessionID, mode)
      if (hints.length === 0) return
      const content = lastUser.content as unknown
      if (Array.isArray(content)) (content as Array<Record<string, unknown>>).push({ type: "text", text: hints.join("\n") })
    })

    // Model capabilities change when providers or models reload; drop the cache.
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const type = (event as { type?: string }).type
          if (type === "model.updated" || type === "models-dev.refreshed") modelSupport.clear()
        }
      } catch {
        // The stream closes when OpenCode shuts the plugin down.
      }
    })()

    return () => controller.abort()
  },
} satisfies Plugin.Plugin
