/**
 * Чистая логика времени работы: объединение интервалов шагов агента.
 * Держится отдельно от TUI, чтобы её можно было тестировать без OpenCode.
 */
export type Interval = [number, number]

export const MAX_STEP_MS = 30 * 60 * 1000
export const LIVE_WINDOW_MS = 15 * 60 * 1000

export type Tokens = {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
}

export type Summary = {
  seconds: number
  live: boolean
  lastUser: number
  cost: number
  tokens: Tokens
}

type Message = {
  type?: string
  role?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: {
      read?: number
      write?: number
    }
  }
  time?: {
    created?: number
    completed?: number
  }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0
}

export function collect(messages: readonly Message[], now: number): Summary {
  const intervals: Interval[] = []
  const tokens: Tokens = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
  }
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
    tokens.input += count(message.tokens?.input)
    tokens.cacheRead += count(message.tokens?.cache?.read)
    tokens.cacheWrite += count(message.tokens?.cache?.write)
    tokens.output += count(message.tokens?.output)
    tokens.reasoning += count(message.tokens?.reasoning)
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

  return { seconds: unionSeconds(intervals), live, lastUser, cost, tokens }
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

export function compactTokens(value: number): string {
  for (const [threshold, suffix] of [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "k"],
  ] as const) {
    if (value >= threshold) {
      const count = Math.floor((value / threshold) * 10) / 10
      return count.toFixed(1).replace(/\.0$/, "").replace(".", ",") + suffix
    }
  }
  return String(value)
}

export function generatedTokens(tokens: Tokens): number {
  return tokens.output + tokens.reasoning
}

export function tokenTotal(tokens: Tokens): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + generatedTokens(tokens)
}

export function formatRate(value: number): string {
  return `${value.toFixed(1).replace(".", ",")} ток/с`
}

export function tokensLabel(summary: Summary): string | null {
  const total = tokenTotal(summary.tokens)
  if (total === 0) return null

  const parts = [
    `Токены: ${compactTokens(total)}`,
    `вход ${compactTokens(summary.tokens.input)}`,
    `из кэша ${compactTokens(summary.tokens.cacheRead)}`,
  ]
  if (summary.tokens.cacheWrite > 0) {
    parts.push(`запись ${compactTokens(summary.tokens.cacheWrite)}`)
  }
  parts.push(`выход ${compactTokens(generatedTokens(summary.tokens))}`)
  if (summary.seconds > 0) {
    parts.push(formatRate(generatedTokens(summary.tokens) / summary.seconds))
  }
  return parts.join(" · ")
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
