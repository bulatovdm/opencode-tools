/**
 * Отправка пуша во все настроенные каналы.
 *
 * У каждого канала свой таймаут; сбой ntfy не мешает Telegram. Ошибки
 * возвращаются без текста, чтобы токен Telegram не попал в лог.
 */
import type { NotifyConfig } from "./config"

export type Push = {
  title: string
  body: string
}

export type Channel = "ntfy" | "telegram"

export type Delivery = {
  channel: Channel
  ok: boolean
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

const TIMEOUT_MS = 10_000

export function ntfyPayload(topic: string, push: Push): string {
  return JSON.stringify({
    topic,
    title: push.title,
    message: push.body,
    priority: 4,
  })
}

export function telegramText(push: Push): string {
  return `${push.title} — ${push.body}`
}

export async function deliver(
  config: NotifyConfig,
  push: Push,
  fetcher: Fetcher = fetch,
): Promise<Delivery[]> {
  const tasks: Promise<Delivery>[] = []

  if (config.ntfy) {
    const { topic, server } = config.ntfy
    tasks.push(
      fetcher(server, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: ntfyPayload(topic, push),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
        .then((response) => ({ channel: "ntfy" as const, ok: response.ok }))
        .catch(() => ({ channel: "ntfy" as const, ok: false })),
    )
  }

  if (config.telegram) {
    const { token, chatID } = config.telegram
    tasks.push(
      fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ chat_id: chatID, text: telegramText(push) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
        .then((response) => ({ channel: "telegram" as const, ok: response.ok }))
        .catch(() => ({ channel: "telegram" as const, ok: false })),
    )
  }

  return Promise.all(tasks)
}
