/**
 * Чистая логика времени работы: объединение интервалов шагов агента.
 * Держится отдельно от TUI, чтобы её можно было тестировать без OpenCode.
 */
export type Interval = [number, number]

export const MAX_STEP_MS = 30 * 60 * 1000
export const LIVE_WINDOW_MS = 15 * 60 * 1000

export type Summary = {
  seconds: number
  live: boolean
  lastUser: number
  cost: number
}

type Message = {
  type?: string
  role?: string
  cost?: number
  time?: {
    created?: number
    completed?: number
  }
}

export function collect(messages: readonly Message[], now: number): Summary {
  const intervals: Interval[] = []
  let lastUser = 0
  let live = false
  let cost = 0

  for (const message of messages) {
    const type = message.type ?? message.role
    const created = message.time?.created
    if (type === "user") {
      if (typeof created === "number" && created > lastUser) lastUser = created
      continue
    }
    if (type !== "assistant") continue
    if (typeof message.cost === "number" && message.cost > 0) cost += message.cost
    if (typeof created !== "number" || created <= 0) continue

    const completed = message.time?.completed
    let end: number | null = null
    if (typeof completed === "number") {
      end = completed
    } else if (now - created <= LIVE_WINDOW_MS) {
      end = now
      live = true
    }
    if (end === null || end <= created) continue
    if (end - created > MAX_STEP_MS) continue
    intervals.push([created, end])
  }

  return { seconds: unionSeconds(intervals), live, lastUser, cost }
}

export function unionSeconds(intervals: readonly Interval[]): number {
  let total = 0
  let start: number | null = null
  let end = 0

  for (const [from, to] of [...intervals].sort((left, right) => left[0] - right[0])) {
    if (start === null) {
      start = from
      end = to
      continue
    }
    if (from <= end) {
      if (to > end) end = to
      continue
    }
    total += end - start
    start = from
    end = to
  }
  if (start !== null) total += end - start
  return total / 1000
}

export function formatDuration(seconds: number): string {
  const value = Math.max(0, Math.round(seconds))
  if (value < 60) return `${value}с`
  const minutes = Math.floor(value / 60)
  if (minutes < 60) return `${minutes}м`
  return `${Math.floor(minutes / 60)}ч ${String(minutes % 60).padStart(2, "0")}м`
}

export function formatMoney(value: number): string {
  if (value >= 10) return `$${value.toFixed(2)}`
  if (value >= 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(4)}`
}

export function label(
  summary: Summary,
  running: boolean,
  now: number,
  balance?: string | null,
): string {
  const parts = [`Работа: ${formatDuration(summary.seconds)}`]
  if (running && summary.lastUser > 0) {
    parts.push(`ход: ${formatDuration((now - summary.lastUser) / 1000)}`)
  }
  if (summary.cost > 0) parts.push(`потрачено ${formatMoney(summary.cost)}`)
  if (balance) parts.push(`баланс ${balance}`)
  return parts.join(" · ")
}
