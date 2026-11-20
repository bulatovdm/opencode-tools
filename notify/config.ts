/**
 * Настройки уведомлений на телефон.
 *
 * Формат общий с Claude Code и codex-tools: буквальные `KEY=value`,
 * комментарии, кавычки и `export`. Shell-подстановки не исполняются.
 * Топик ntfy и токены Telegram нигде не печатаются.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type Env = Record<string, string | undefined>

export type NtfyChannel = {
  topic: string
  server: string
}

export type TelegramChannel = {
  token: string
  chatID: string
}

export type NotifyConfig = {
  ntfy?: NtfyChannel
  telegram?: TelegramChannel
  /** Пауза после конца хода перед «жду ответа». */
  idleSeconds: number
  /** Пауза перед уведомлением о запросе разрешения или вопроса. */
  inputSeconds: number
  /** Сколько ждать фоновую задачу, прежде чем всё равно уведомить. */
  backgroundLimitSeconds: number
}

export const DEFAULT_NTFY_SERVER = "https://ntfy.sh"
export const DEFAULT_IDLE_SECONDS = 30
export const DEFAULT_INPUT_SECONDS = 0
export const DEFAULT_BACKGROUND_LIMIT_SECONDS = 900

function text(value: string | undefined): string {
  return (value ?? "").trim()
}

function unquote(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  if (first === last && (first === '"' || first === "'")) {
    const inner = value.slice(1, -1)
    return first === '"' ? inner.replace(/\\(["\\])/g, "$1") : inner
  }
  return value
}

/**
 * Разбирает файл настроек. Значения читаются буквально: `$HOME`, `$(...)`
 * и backticks остаются текстом и не исполняются.
 */
export function parseEnvFile(source: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const raw of source.split(/\r?\n/)) {
    let line = raw.trim()
    if (!line || line.startsWith("#")) continue
    if (line.startsWith("export ")) line = line.slice("export ".length).trim()

    const equals = line.indexOf("=")
    if (equals <= 0) continue
    const key = line.slice(0, equals).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

    let value = line.slice(equals + 1).trim()
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const comment = value.search(/\s#/)
      if (comment >= 0) value = value.slice(0, comment).trim()
    }
    values.set(key, unquote(value))
  }
  return values
}

function seconds(value: string | undefined, fallback: number): number {
  const raw = text(value)
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function configFromText(source: string): NotifyConfig | null {
  const values = parseEnvFile(source)
  const topic = text(values.get("NTFY_TOPIC"))
  const server = text(values.get("NTFY_SERVER")) || DEFAULT_NTFY_SERVER
  const token = text(values.get("TELEGRAM_BOT_TOKEN"))
  const chatID = text(values.get("TELEGRAM_CHAT_ID"))

  const ntfy = topic ? { topic, server } : undefined
  const telegram = token && chatID ? { token, chatID } : undefined
  if (!ntfy && !telegram) return null

  return {
    ntfy,
    telegram,
    idleSeconds: seconds(values.get("IDLE_NOTIFY_SECONDS"), DEFAULT_IDLE_SECONDS),
    inputSeconds: seconds(values.get("INPUT_NOTIFY_SECONDS"), DEFAULT_INPUT_SECONDS),
    backgroundLimitSeconds: seconds(
      values.get("BACKGROUND_WAIT_LIMIT_SECONDS"),
      DEFAULT_BACKGROUND_LIMIT_SECONDS,
    ),
  }
}

/**
 * `OPENCODE_NOTIFY_CONFIG` → `~/.config/opencode/notify.env` →
 * `$CODEX_HOME/notify.env` (обычно `~/.codex/notify.env`) →
 * `~/.claude/notify.env`. Явно заданный, но отсутствующий файл отключает
 * уведомления; конфиги не объединяются.
 */
export function configPath(
  env: Env = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const explicit = env.OPENCODE_NOTIFY_CONFIG
  if (explicit !== undefined) return text(explicit) || null

  const home = env.HOME || homedir()
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config")
  const own = join(configHome, "opencode", "notify.env")
  if (exists(own)) return own

  const codexHome = env.CODEX_HOME || join(home, ".codex")
  const codex = join(codexHome, "notify.env")
  if (exists(codex)) return codex

  const shared = join(home, ".claude", "notify.env")
  if (exists(shared)) return shared
  return null
}

export function loadConfig(
  env: Env = process.env,
  exists: (path: string) => boolean = existsSync,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): NotifyConfig | null {
  const path = configPath(env, exists)
  if (!path) return null
  try {
    return configFromText(read(path))
  } catch {
    return null
  }
}
