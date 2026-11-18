/**
 * Баланс DeepSeek для строки «Работа:».
 *
 * Ключ читается из auth.json OpenCode, запрос — один GET к DeepSeek. Сеть
 * трогаем только при обновлении; при ошибке оставляем прошлое значение.
 * Чистые функции отделены от TUI, чтобы их можно было тестировать без Bun.
 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export type Balance = {
  currency: string
  total: number | null
  granted: number | null
  toppedUp: number | null
}

export type BalanceSnapshot = {
  available: boolean
  balances: Balance[]
}

export type FetchLike = typeof fetch

const URL = "https://api.deepseek.com/user/balance"
const TIMEOUT_MS = 10_000

export function dataDir(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(base, "opencode")
}

export function authPath(env: Record<string, string | undefined> = process.env): string {
  return join(dataDir(env), "auth.json")
}

export function apiKey(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null
  const record = entry as Record<string, unknown>
  if (typeof record.key === "string" && record.key) return record.key
  const nested = record.type
  if (nested && typeof nested === "object") {
    const key = (nested as Record<string, unknown>).key
    if (typeof key === "string" && key) return key
  }
  return null
}

export async function readDeepSeekKey(path = authPath()): Promise<string | null> {
  const payload = JSON.parse(await readFile(path, "utf8")) as unknown
  if (!payload || typeof payload !== "object") return null
  return apiKey((payload as Record<string, unknown>).deepseek)
}

function number(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseDeepSeek(payload: unknown): BalanceSnapshot {
  if (!payload || typeof payload !== "object") {
    throw new Error("DeepSeek вернул не объект JSON")
  }
  const record = payload as Record<string, unknown>
  const infos = record.balance_infos
  if (!Array.isArray(infos)) {
    throw new Error("в ответе DeepSeek нет balance_infos")
  }

  const balances: Balance[] = []
  for (const info of infos) {
    if (!info || typeof info !== "object") continue
    const item = info as Record<string, unknown>
    balances.push({
      currency: String(item.currency ?? ""),
      total: number(item.total_balance),
      granted: number(item.granted_balance),
      toppedUp: number(item.topped_up_balance),
    })
  }
  return { available: record.is_available !== false, balances }
}

export async function fetchDeepSeek(
  key: string,
  options: { fetchImpl?: FetchLike; timeout?: number } = {},
): Promise<BalanceSnapshot> {
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
    throw new Error(`DeepSeek: HTTP ${response.status}`)
  }
  return parseDeepSeek(await response.json())
}

const SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  CNY: "¥",
  RUB: "₽",
}

export function formatAmount(value: number | null, currency = ""): string {
  if (value === null) return "—"
  const amount = value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  const symbol = SYMBOLS[currency.toUpperCase()]
  return symbol ? `${symbol}${amount}` : `${amount} ${currency}`.trim()
}

export function snapshotLabel(snapshot: BalanceSnapshot): string | null {
  if (snapshot.balances.length === 0) return null
  const amount = snapshot.balances
    .map((item) => formatAmount(item.total, item.currency))
    .join(" · ")
  return snapshot.available ? `DeepSeek: ${amount}` : `DeepSeek: ${amount} (недоступен)`
}

export async function deepseekBalanceLabel(
  path = authPath(),
  fetcher?: FetchLike,
): Promise<string | null> {
  const key = await readDeepSeekKey(path)
  if (!key) return null
  return snapshotLabel(await fetchDeepSeek(key, fetcher ? { fetchImpl: fetcher } : {}))
}
