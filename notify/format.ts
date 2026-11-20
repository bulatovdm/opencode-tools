/**
 * Тексты пушей и заголовок уведомления.
 *
 * В тело не попадают команды, пути, промпты и содержимое файлов: только тип
 * события, имя проекта и название сессии.
 */
import { basename } from "node:path"

export const WAITING = "💬 Waiting for your reply"
export const WAITING_BACKGROUND =
  "💬 Waiting for your reply (a background task is still running)"
export const PERMISSION = "🔐 Needs permission"
export const QUESTION = "❓ OpenCode asks you a question"
export const ERROR = "⚠️ OpenCode stopped with an error"

function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
}

export function permissionBody(action: string): string {
  const value = oneLine(action)
  return value ? `${PERMISSION}: ${value}` : PERMISSION
}

export function errorBody(type?: string): string {
  const value = oneLine(type ?? "")
  return value ? `${ERROR} (${value})` : ERROR
}

export function cleanTitle(value: string | undefined, limit = 120): string {
  const text = oneLine(value ?? "")
  if (text.length <= limit) return text
  return text.slice(0, Math.max(0, limit - 1)).trimEnd() + "…"
}

/** `<репозиторий>` или `<репозиторий> (<worktree>)` для отдельного каталога. */
export function projectLabel(canonical: string, directory: string): string {
  const main = basename(canonical || directory)
  const current = basename(directory || canonical)
  if (!main) return current || "session"
  if (current && current !== main) return `${main} (${current})`
  return main
}

export function notificationTitle(
  project: string,
  session: { id: string; title?: string },
): string {
  const short = session.id.replace(/^ses_/, "").slice(-8)
  const name = cleanTitle(session.title)
  const label = name ? `${name} [${short}]` : short
  return ["OpenCode", cleanTitle(project, 80), label].filter(Boolean).join(" · ")
}
