<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo.svg">
    <img src="assets/logo.svg" width="64" alt="opencode-v2-vision logo">
  </picture>
</p>
<h1 align="center">opencode-v2-vision</h1>
<p align="center">
  Let non-vision OpenCode models "see" pasted images — <strong>OpenCode v2 fork</strong>
  <br />
  Auto-saves images → guides the model to the `vision` tool → returns a description
</p>
<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="MIT License">
  </a>
  <a href="https://github.com/HungrySharkNet/opencode-vision">
    <img src="https://img.shields.io/github/stars/HungrySharkNet/opencode-vision?style=flat-square" alt="GitHub stars">
  </a>
</p>

> **Fork notice.** This repository is a fork of the original plugin
> [JochenYang/opencode-vision](https://github.com/JochenYang/opencode-vision).
> It was created because the original project is not being updated (it still
> targets the OpenCode v1 plugin API). The fork ports the plugin to OpenCode v2
> and is not published to npm, so it is installed manually from this repository.

---

### ✨ Install (manual)

This fork is not published to npm — install it from a clone:

```bash
git clone https://github.com/HungrySharkNet/opencode-vision
mkdir -p ~/.config/opencode/plugins
cp opencode-vision/plugins/vision-helper.ts ~/.config/opencode/plugins/
opencode service restart
```

Uninstall:

```bash
rm ~/.config/opencode/plugins/vision-helper.ts
opencode service restart
```

> Using OpenCode 1.x? This fork targets v2 only — use the upstream plugin `npx @jochenyang/opencode-vision@1.8.3`.

---

## How It Works

```
User pastes image + "What is this?"
  ↓
vision-helper plugin (OpenCode v2 session.hook("context"))
  ├─ Look up the active model's capabilities.input (ctx.model.list)
  ├─ Native vision → leave the media part untouched, tell the model not to call `vision`
  ├─ Text-only → save the image to the temp dir, replace the media part with a path hint
  └─ Clear hints injected on the previous pass (no accumulation)
  ↓
Model sees the path hint → calls the vision tool (api mode) or the subagent tool (subagent mode)
  ↓
vision tool calls the vision API → returns the image description
```

- **Single image** → the model calls `vision(paths=["..."])` to read one image
- **Multiple images** → the model calls `vision(paths=[...])` once for all images
- **Native-vision models** → media reaches the model unchanged: no hints, no external calls
- **Text-only models** → the image part is replaced, so the provider never receives unsupported media

Requires OpenCode 2.x: the plugin uses the v2 `@opencode/plugin` API (`id` + `setup(ctx)`) and v2 media parts.

## Prerequisites

- [OpenCode](https://opencode.ai) **2.x** installed — the fork targets the v2 plugin API only
- A vision-capable API (OpenAI Chat Completions format or MiniMax VLM)
- Environment variables configured (recommended system-wide)

## Environment Variables

| Variable                | Description                                                        | Example                         |
| ----------------------- | ------------------------------------------------------------------ | ------------------------------- |
| `VISION_MODE`           | Delegation mode: `api` (default) or `subagent`. Auto-detects if unset — uses `api` when `VISION_API_KEY` is set, otherwise falls back to `subagent`. | `subagent` |
| `VISION_API_KEY`        | Vision API key (required for `api` mode)                           | `sk-your-api-key`               |
| `VISION_API_URL`        | Vision API base URL (required for `api` mode)                      | `https://your-api-endpoint/v1`  |
| `VISION_MODEL`          | Vision model name (required for OpenAI-compatible backends; not needed for MiniMax) | `your-vision-model`             |
| `VISION_API_TYPE`       | Optional, force API type `openai` / `minimax`                      | `minimax`                       |
| `VISION_SUBAGENT_NAME`  | Subagent identifier for `subagent` mode (default: `image-reader`)  | `image-reader`                  |
| `VISION_MAX_TOKENS`     | Vision API max response tokens (default: 4096)                     | `4096`                          |
| `VISION_FETCH_TIMEOUT_MS` | Fetch timeout in ms (default: 60000)                             | `60000`                         |
| `VISION_MAX_IMAGES`     | LRU image cache cap (default: 200)                                 | `200`                           |

### Delegation Modes

The plugin supports two modes for obtaining image descriptions when the active model lacks vision:

#### `api` mode (default, original behaviour)

The `vision` tool calls an external VLM API directly. Requires `VISION_API_KEY` and `VISION_API_URL`. Supports OpenAI-compatible backends and MiniMax VLM.

```bash
export VISION_MODE=api
export VISION_API_KEY="sk-your-api-key"
export VISION_API_URL="https://your-api-endpoint/v1"
export VISION_MODEL="your-vision-model"
```

#### `subagent` mode (new)

The plugin instructs the LLM to delegate image analysis to a vision-capable subagent through the built-in `subagent` tool. No external API key required — the subagent runs on whatever multimodal model is configured in OpenCode (e.g. `opencode-go/minimax-m3`).

```bash
export VISION_MODE=subagent
# Optional: override the subagent name (default: image-reader)
# export VISION_SUBAGENT_NAME=image-reader
```

**Setup for subagent mode:**

1. Create a subagent definition at `~/.config/opencode/agents/image-reader.md`:

```markdown
---
description: Analyze images and screenshots with a multimodal model. Use when the active model cannot view images itself.
mode: subagent
model: opencode-go/minimax-m3
permissions:
  - action: read
    resource: "*"
    effect: allow
  - action: glob
    resource: "*"
    effect: allow
  - action: shell
    resource: "*"
    effect: deny
  - action: edit
    resource: "*"
    effect: deny
---

You are a vision analyst. Read the image at the given path using the `read` tool and describe what you see.
```

2. Restart OpenCode. The plugin will automatically:
   - Save pasted images to `/tmp/opencode-v2-vision/image{N}/`
   - Inject a system prompt telling the text-only model to delegate
   - Replace each image part with a path hint naming the subagent

> The subagent is launched through the built-in `subagent` tool (v1 called it `task`).

#### Auto-fallback

When `VISION_MODE` is unset, the plugin uses:
- `api` mode if `VISION_API_KEY` is present
- `subagent` mode otherwise

This means the plugin works out-of-the-box without any external credentials, as long as a vision-capable subagent is configured.

> `VISION_API_URL`: OpenAI-compatible backends auto-append `/chat/completions`; MiniMax auto-detects and uses `/v1/coding_plan/vlm`.
>
> `VISION_API_TYPE`: Auto-detected by default (URL containing `minimax` triggers MiniMax mode). Can be explicitly set.

### Example 1: OpenAI-compatible (e.g., Aliyun DashScope)

**Windows:**
```powershell
[System.Environment]::SetEnvironmentVariable('VISION_API_KEY', 'sk-your-api-key', 'User')
[System.Environment]::SetEnvironmentVariable('VISION_API_URL', 'https://your-api-endpoint/v1', 'User')
[System.Environment]::SetEnvironmentVariable('VISION_MODEL', 'your-vision-model', 'User')
```

**macOS / Linux:**
```bash
export VISION_API_KEY="sk-your-api-key"
export VISION_API_URL="https://your-api-endpoint/v1"
export VISION_MODEL="your-vision-model"
```

### Example 2: MiniMax VLM

MiniMax's VLM endpoint is part of the **Token Plan** service and requires a Group API Key with Token Plan access — a regular Chat API Key won't work.

> How to get one: Login to [MiniMax platform](https://platform.minimaxi.com) → Token Plan → Create/view Group API Key.

**Windows:**
```powershell
[System.Environment]::SetEnvironmentVariable('VISION_API_KEY', 'your-minimax-group-api-key', 'User')
[System.Environment]::SetEnvironmentVariable('VISION_API_URL', 'https://api.minimax.chat', 'User')
REM VISION_MODEL is not needed — MiniMax auto-detected
```

**macOS / Linux:**
```bash
export VISION_API_KEY="your-minimax-group-api-key"
export VISION_API_URL="https://api.minimax.chat"
# VISION_MODEL is not needed — MiniMax auto-detected
```

> Note: The MiniMax VLM endpoint uses a different base URL from the Chat API. Use `https://api.minimax.chat`.

**Restart your terminal** after setting.

## Installation

### Manual

Copy the single plugin file to OpenCode's global config directory:

```bash
git clone https://github.com/HungrySharkNet/opencode-vision
mkdir -p ~/.config/opencode/plugins
cp opencode-vision/plugins/vision-helper.ts ~/.config/opencode/plugins/
```

OpenCode 2.x auto-discovers `.ts` files under `~/.config/opencode/plugins/` — **no need to modify `opencode.json`**. The `vision` tool is registered by the plugin itself.

### With the helper script

The bundled installer copies the plugin, checks the OpenCode version, and cleans up 1.x leftovers:

```bash
git clone https://github.com/HungrySharkNet/opencode-vision
cd opencode-vision
node bin/install.js              # install
node bin/install.js --uninstall  # uninstall
```

## Verification

Start OpenCode:

```bash
opencode
```

Paste an image and ask:

```
[Image] What is this?
```

Expected behavior:

1. The plugin checks the active model's image capability
2. For a text-only model it saves the image to temp and replaces the image part with a path hint
3. The model calls the `vision` tool (api mode) or the `subagent` tool (subagent mode)
4. The model returns an image description based on that result

## Project Structure

```
opencode-v2-vision/
├── plugins/
│   └── vision-helper.ts   # v2 plugin: image handling + `vision` tool registration
├── agents/
│   └── image-reader.md    # Optional multimodal subagent for subagent mode
├── bin/
│   └── install.js         # CLI install/uninstall script
├── tests/                 # bun tests (helpers, plugin context hook, vision tool)
├── package.json
├── tsconfig.json
├── README.md
└── LICENSE
```

### Plugin: `plugins/vision-helper.ts`

- v2 entrypoint: `{ id: "opencode-v2-vision", setup(ctx) }` (only a type import from `@opencode/plugin`, no runtime dependency)
- Hook: `ctx.session.hook("context")` — runs before every agent model request
- Reads the model's capabilities from `ctx.model.list()` to tell native-vision models from text-only ones
- Saves images to `os.tmpdir()/opencode-v2-vision/` and replaces each image part with a path hint
- Clears hints injected on earlier passes so they never accumulate
- Registers the `vision` tool through `ctx.tool.transform` with `options.codemode: false`
- Blocks `vision` for native-vision models through `ctx.tool.hook("execute.before")`

### Tool: `vision`

- Reads local image files and describes them via an external vision API
- Accepts `paths` (multiple) and the deprecated `path` (single)
- Supports two backends: OpenAI Chat Completions / MiniMax VLM (auto-detected)
- Sandboxes reads to the plugin temp directory

## Notes

- Images are saved to the system temp directory `os.tmpdir()/opencode-v2-vision/image{N}/{hash}.{ext}`
- The same image content is written once per session (MD5 dedupe)
- **LRU cleanup**: the most recent 200 images are kept (adjust with `VISION_MAX_IMAGES`)
- Vision API calls use `max_tokens: 4096` (adjust with `VISION_MAX_TOKENS`)
- Vision API fetch has a 60s timeout (adjust with `VISION_FETCH_TIMEOUT_MS`)
- Native multimodal models bypass the plugin entirely; no external API key is needed for `subagent` mode

## Custom Vision API

The tool supports two backends with auto-detection or explicit override.

### OpenAI Chat Completions Format

Works with any OpenAI Chat Completions vision API:

```bash
export VISION_API_KEY="sk-your-api-key"
export VISION_API_URL="https://your-api-endpoint/v1"
export VISION_MODEL="your-vision-model"
```

### MiniMax VLM

Auto-detected when the URL contains `minimax`/`minimaxi`. Can also be forced with `VISION_API_TYPE=minimax`.

> ⚠️ Requires a **Group API Key** with Token Plan access. Regular Chat API Keys won't work.

```bash
export VISION_API_KEY="your-minimax-group-api-key"
export VISION_API_URL="https://api.minimax.chat"
# VISION_MODEL is not needed
```

## Development

```bash
bun install        # dev dependencies (@opencode/plugin types, typescript)
bun test           # unit + plugin tests
bunx tsc --noEmit  # type check
```

The plugin itself has no runtime dependencies: `@opencode/plugin` is imported with `import type` only.

## Copyright

Copyright (c) 2026 Jochen Yang
Copyright (c) 2026 Balashov Alexandr

## License

[MIT](LICENSE)
