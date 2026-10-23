#!/usr/bin/env node
const fs = require("fs")
const path = require("path")
const os = require("os")

const SRC = path.join(__dirname, "..")
const DST = path.join(os.homedir(), ".config", "opencode")
const PLUGIN_REL = path.join("plugins", "vision-helper.ts")
const LEGACY_TOOL_REL = path.join("tools", "vision.ts")
const isWin = process.platform === "win32"

const ENV_VARS = [
  { name: "VISION_API_KEY", desc: "视觉 API 密钥 / Vision API key", example: "sk-your-api-key" },
  { name: "VISION_API_URL", desc: "视觉 API 地址 / Vision API base URL（MiniMax 也可用）", example: "https://api.minimax.chat（MiniMax 官方）" },
  { name: "VISION_MODEL", desc: "视觉模型名称 / Vision model name（MiniMax 无需此项）", example: "your-vision-model" },
]

function log(msg, ok = true) {
  const prefix = ok ? "\x1b[32m ✓\x1b[0m" : "\x1b[31m ✗\x1b[0m"
  console.log(`${prefix} ${msg}`)
}

function title(msg) {
  console.log(`\n\x1b[36m═══ ${msg} \x1b[0m\n`)
}

function printEnvGuide() {
  console.log("\n  你需要设置以下环境变量才能使用视觉识别功能：")
  console.log()

  for (const v of ENV_VARS) {
    console.log(`    \x1b[33m${v.name}\x1b[0m`)
    console.log(`    → ${v.desc}`)
    console.log(`    → 示例: ${v.example}`)
    console.log()
  }

  console.log("  \x1b[36mMiniMax 用户注意：\x1b[0m")
  console.log("  VISION_API_URL 设为你的 MiniMax API 基础地址即可。")
  console.log("  工具自动检测 MiniMax 并使用 VLM 接口，不需要 VISION_MODEL。")
  console.log("  也可显式设置 VISION_API_TYPE=minimax。")
  console.log()

  if (isWin) {
    console.log("  \x1b[36mWindows 系统级配置（管理员 PowerShell）：\x1b[0m")
    console.log()
    for (const v of ENV_VARS) {
      console.log(`    [System.Environment]::SetEnvironmentVariable('${v.name}', '${v.example}', 'User')`)
    }
    console.log()
    console.log("  设置后重启终端生效。")
  } else {
    console.log("  \x1b[36mmacOS / Linux 配置（添加到 ~/.zshrc 或 ~/.bashrc）：\x1b[0m")
    console.log()
    for (const v of ENV_VARS) {
      console.log(`    export ${v.name}="${v.example}"`)
    }
    console.log()
    console.log("  然后执行 source ~/.zshrc 或重启终端。")
  }
}

async function checkVars() {
  let missing = 0
  for (const v of ENV_VARS) {
    const val = process.env[v.name]
    if (val) {
      const masked = v.name === "VISION_API_KEY" ? val.slice(0, 6) + "****" : val
      log(`${v.name} = ${masked}`)
    } else {
      log(`${v.name} 未设置`, false)
      missing++
    }
  }
  return missing
}

/** 删除 1.x 安装到 tools/ 的 vision.ts（只在确认是本项目的文件时）。 */
function removeLegacyTool() {
  const legacy = path.join(DST, LEGACY_TOOL_REL)
  if (!fs.existsSync(legacy)) return

  try {
    const content = fs.readFileSync(legacy, "utf8")
    if (!content.includes("opencode-vision")) return
    fs.unlinkSync(legacy)
    log(`已清理 1.x 遗留文件 ${LEGACY_TOOL_REL}`)

    const dir = path.dirname(legacy)
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir)
      log(`已清理空目录 ${path.relative(os.homedir(), dir)}`)
    }
  } catch (err) {
    log(`清理 ${LEGACY_TOOL_REL} 失败: ${err.message}`, false)
  }
}

async function doInstall() {
  title("opencode-vision 安装 (OpenCode v2)")

  // ── 文件复制 ──
  const srcPlugin = path.join(SRC, PLUGIN_REL)
  const dstPlugin = path.join(DST, PLUGIN_REL)
  if (!fs.existsSync(srcPlugin)) {
    log(`源文件不存在: ${PLUGIN_REL}`, false)
  } else {
    fs.mkdirSync(path.dirname(dstPlugin), { recursive: true })
    fs.copyFileSync(srcPlugin, dstPlugin)
    log(`安装 ${PLUGIN_REL}`)
  }

  // ── 清理 1.x 遗留文件 ──
  removeLegacyTool()

  // ── 环境变量检查 ──
  title("环境变量检查")
  const missing = await checkVars()

  if (missing > 0) {
    console.log(`\n  \x1b[33m⚠ 有 ${missing} 个环境变量未设置。\x1b[0m`)
    printEnvGuide()
  }

  // ── OpenCode 检测 ──
  title("OpenCode 检测")
  try {
    const { execSync } = require("child_process")
    const ver = execSync("opencode --version 2>/dev/null", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim()
    const major = Number((ver.match(/[v]?(\d+)\./) || [])[1] || 0)
    if (major >= 2) {
      log(`OpenCode ${ver}`)
    } else {
      log(`检测到 OpenCode ${ver || "未知版本"} — opencode-vision 2.x 需要 OpenCode 2.x`, false)
      console.log("     OpenCode 1.x 请使用 1.8.3：npx @jochenyang/opencode-vision@1.8.3")
    }
  } catch {
    log("未检测到 OpenCode — 请先安装 https://opencode.ai", false)
  }

  title("安装完成")
  console.log("  ✅ 插件已安装到 ~/.config/opencode/plugins/vision-helper.ts")
  console.log("     OpenCode 2.x 会自动发现该目录，无需修改 opencode.json。")
  console.log("  🔄 重启 OpenCode 使插件生效（opencode service restart）。")
  if (missing > 0) {
    console.log("  ⚠ 环境变量未配置完整：api 模式需要 VISION_API_KEY / VISION_API_URL。")
    console.log("     未配置密钥时自动使用 subagent 模式（需要配置多模态子代理）。")
  }
  console.log("  📝 使用方式：粘贴一张图片并提问")
  console.log('     "[图片] 这是什么？"')
}

async function doUninstall() {
  title("opencode-vision 卸载")

  const targets = [PLUGIN_REL, LEGACY_TOOL_REL]
  let removed = 0

  for (const rel of targets) {
    const dst = path.join(DST, rel)
    if (!fs.existsSync(dst)) {
      if (rel === LEGACY_TOOL_REL) continue
      log(`未安装: ${rel}`)
      continue
    }
    fs.unlinkSync(dst)
    log(`已删除 ${rel}`)
    removed++

    const dir = path.dirname(dst)
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir)
      log(`已清理空目录 ${path.relative(os.tmpdir(), dir)}`)
    }
  }

  // 清理缓存图片（用户隐私）
  const tmpDir = path.join(os.tmpdir(), "opencode-vision")
  if (fs.existsSync(tmpDir)) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      log(`已清理临时目录 ${path.relative(os.tmpdir(), tmpDir)}/* (含缓存图片)`)
    } catch (err) {
      log(`清理临时目录失败: ${err.message}`, false)
    }
  }

  title("卸载完成")
  if (removed > 0) {
    console.log("  已删除 opencode-vision 相关文件。")
    console.log("  重启 OpenCode 即可生效。")
  } else {
    console.log("  没有找到已安装的文件。")
  }
}

async function main() {
  const isUninstall = process.argv.includes("--uninstall") || process.argv.includes("uninstall")
  if (isUninstall) {
    await doUninstall()
  } else {
    await doInstall()
  }
  console.log()
}

main().catch((err) => {
  console.error("\x1b[31m操作失败:\x1b[0m", errmessage)
  process.exit(1)
})

