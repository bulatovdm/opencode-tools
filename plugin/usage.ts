/**
 * Остаток лимитов OpenCode Go: пятичасовое, недельное и месячное окна.
 *
 * OpenCode Go отдаёт проценты использованного лимита; в футере показываем
 * остаток. Ключ берётся из хранилища credentials самого OpenCode, запрос —
 * один GET. Сеть трогаем только при обновлении; при ошибке оставляем прошлое
 * значение. Чистые функции отделены от TUI, чтобы их можно было тестировать
 * без Bun и без сети.
 */

export type Meter = {
  /** Процент использованного лимита, 0..100. */
  percent: number
  /** Окно уже закрыто, новые запросы не пройдут до сброса. */
  limited: boolean
  /** Момент сброса, миллисекунды Unix. 0 — сервер не сообщил. */
  resetsAt: number
}

export type GoUsage = {
  rolling: Meter
  weekly: Meter
  monthly: Meter
}

export type CredentialLike = {
  integrationID?: string
  active?: boolean
  value?: {
    type?: string
    key?: string
    access?: string
  }
}

export type FetchLike = typeof fetch

const URL = "https://opencode.ai/zen/go/v1/usage"
const TIMEOUT_MS = 10_000

function count(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error("в ответе OpenCode Go нет процента лимита")
  }
  return Math.max(0, Math.min(100, parsed))
}

function epoch(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function meter(value: unknown): Meter {
  if (!value || typeof value !== "object") {
    throw new Error("в ответе OpenCode Go нет окна лимита")
  }
  const record = value as Record<string, unknown>
  return {
    percent: count(record.percent),
    limited: record.status === "rate-limited" || record.limited === true,
    resetsAt: epoch(record.resetsAt),
  }
}

export function parseGoUsage(payload: unknown): GoUsage {
  if (!payload || typeof payload !== "object") {
    throw new Error("OpenCode Go вернул не объект JSON")
  }
  const usage = (payload as Record<string, unknown>).usage
  if (!usage || typeof usage !== "object") {
    throw new Error("в ответе OpenCode Go нет usage")
  }
  const record = usage as Record<string, unknown>
  return {
    rolling: meter(record.rolling),
    weekly: meter(record.weekly),
    monthly: meter(record.monthly),
  }
}

export async function fetchGoUsage(
  key: string,
  options: { fetchImpl?: FetchLike; timeout?: number } = {},
): Promise<GoUsage> {
  const fetcher = options.fetchImpl ?? fetch
  const response = await fetcher(URL, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "User-Agent": "opencode-tools",
    },
    signal: AbortSignal.timeout(options.timeout ?? TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`OpenCode Go: HTTP ${response.status}`)
  }
  return parseGoUsage(await response.json())
}

/**
 * Ключ Go из списка credentials OpenCode. Обычно это key; на случай OAuth
 * поддерживаем access. Неактивную запись не используем.
 */
export function goKey(entries: readonly CredentialLike[]): string | null {
  const entry = entries.find(
    (item) => item?.integrationID === "opencode-go" && item.active !== false,
  )
  const value = entry?.value
  if (!value || typeof value !== "object") return null
  if (value.type === "key" && typeof value.key === "string" && value.key) {
    return value.key
  }
  if (value.type === "oauth" && typeof value.access === "string" && value.access) {
    return value.access
  }
  return null
}

export function remainingPercent(value: Meter): number {
  if (value.limited) return 0
  return Math.max(0, Math.min(100, 100 - value.percent))
}

export function percentText(value: number): string {
  const rounded = Math.round(value * 10) / 10
  if (rounded === Math.round(rounded)) return String(Math.round(rounded))
  return rounded.toFixed(1).replace(".", ",")
}

/** Компактно: до часа — минуты, до суток — часы и минуты, дальше — дни. */
export function formatReset(resetsAt: number, now: number): string {
  const left = resetsAt - now
  if (left <= 0) return "сейчас"
  const minutes = Math.ceil(left / 60_000)
  if (minutes < 60) return `${minutes}м`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest ? `${hours}ч ${String(rest).padStart(2, "0")}м` : `${hours}ч`
  }
  return `${Math.floor(hours / 24)}д`
}

function meterLabel(name: string, value: Meter, now: number): string {
  if (value.limited) return `${name} лимит`
  const reset = value.resetsAt > 0 ? ` (${formatReset(value.resetsAt, now)})` : ""
  return `${name} ${percentText(remainingPercent(value))}%${reset}`
}

/** Строка футера: `Go: осталось 5ч 94% (4ч 34м) · нед 98% (3д) · мес 99% (29д)`. */
export function usageLabel(usage: GoUsage, now: number): string {
  return (
    "Go: осталось " +
    [
      meterLabel("5ч", usage.rolling, now),
      meterLabel("нед", usage.weekly, now),
      meterLabel("мес", usage.monthly, now),
    ].join(" · ")
  )
}
