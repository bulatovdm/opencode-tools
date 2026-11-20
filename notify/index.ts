/**
 * Серверный плагин уведомлений на телефон.
 *
 * Подписывается на события сервера OpenCode, отбирает сессии текущего
 * каталога и отправляет ntfy/Telegram:
 *
 * - запрос разрешения — сразу (или через INPUT_NOTIFY_SECONDS);
 * - вопрос агента (`form.created`) — так же;
 * - конец хода — через IDLE_NOTIFY_SECONDS, один раз на ход;
 * - ошибка хода — сразу.
 *
 * Общий `notify.env` с Claude Code и codex-tools: отдельный топик не нужен.
 */
import { Plugin } from "@opencode/plugin"

import { loadConfig } from "./config"
import { deliver } from "./delivery"
import { notificationTitle, projectLabel } from "./format"
import { Notifier, type SessionMeta } from "./notifier"

type RawEvent = {
  id?: string
  type: string
  location?: { directory?: string }
  data?: unknown
}

const RELEVANT = new Set([
  "session.created",
  "session.renamed",
  "session.moved",
  "session.deleted",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.inbox.delivered",
  "session.tool.called",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
])

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function same(left: string | undefined, right: string): boolean {
  if (!left) return false
  return left.replace(/\/+$/, "") === right.replace(/\/+$/, "")
}

export default Plugin.define({
  id: "opencode-tools.notify",
  async setup(ctx) {
    const config = loadConfig()
    if (!config) return

    const project = projectLabel(ctx.location.project.canonical, ctx.location.directory)
    const cache = new Map<string, SessionMeta>()

    const getMeta = async (sessionID: string, fresh = false): Promise<SessionMeta | undefined> => {
      if (!fresh) {
        const cached = cache.get(sessionID)
        if (cached) return cached
      }
      try {
        const result = await ctx.session.get({ sessionID })
        const outer = record(result) ?? {}
        const info = record(outer.data) ?? outer
        const location = record(info.location)
        const meta: SessionMeta = {
          id: sessionID,
          parentID: text(info.parentID),
          title: text(info.title),
          directory: text(location?.directory) ?? text(info.directory),
        }
        cache.set(sessionID, meta)
        return meta
      } catch {
        return cache.get(sessionID)
      }
    }

    const notifier = new Notifier({
      idleSeconds: config.idleSeconds,
      inputSeconds: config.inputSeconds,
      backgroundLimitSeconds: config.backgroundLimitSeconds,
      notify: (sessionID, body) => {
        void (async () => {
          const current = loadConfig()
          if (!current) return
          const meta = await getMeta(sessionID, true)
          if (!meta || !same(meta.directory, ctx.location.directory)) return
          const title = notificationTitle(project, meta)
          const results = await deliver(current, { title, body })
          for (const result of results) {
            if (!result.ok) {
              console.warn(`[opencode-tools] notify: ${result.channel} delivery failed`)
            }
          }
        })().catch(() => {})
      },
    })

    const handle = async (event: RawEvent): Promise<void> => {
      if (!RELEVANT.has(event.type)) return

      const data = record(event.data) ?? {}
      const form = record(data.form)
      const sessionID = text(data.sessionID) ?? text(form?.sessionID)
      if (!sessionID) return

      if (event.type === "session.deleted") {
        cache.delete(sessionID)
        notifier.forget(sessionID)
        return
      }

      if (event.type === "session.moved") {
        const cached = cache.get(sessionID)
        cache.set(sessionID, {
          id: sessionID,
          parentID: cached?.parentID,
          title: cached?.title,
          directory: text(record(data.location)?.directory),
        })
        notifier.forget(sessionID)
        return
      }

      let meta: SessionMeta
      if (event.type === "session.created") {
        meta = {
          id: sessionID,
          parentID: text(data.parentID),
          title: text(data.title),
          directory:
            text(record(data.location)?.directory) ?? text(event.location?.directory),
        }
        cache.set(sessionID, meta)
      } else if (event.type === "session.renamed") {
        const cached = cache.get(sessionID) ?? {
          id: sessionID,
          directory: text(event.location?.directory),
        }
        meta = { ...cached, title: text(data.title) }
        cache.set(sessionID, meta)
      } else {
        const fresh =
          event.type === "session.execution.succeeded" ||
          event.type === "permission.asked" ||
          event.type === "form.created"
        const cached = await getMeta(sessionID, fresh)
        if (!cached) return
        meta = cached
      }

      if (!same(meta.directory, ctx.location.directory)) {
        notifier.forget(sessionID)
        return
      }

      const base = { sessionID, meta }
      switch (event.type) {
        case "session.created":
        case "session.renamed":
          notifier.handle({ ...base, type: event.type })
          return

        case "session.execution.started":
          notifier.handle({ ...base, type: "session.execution.started" })
          return

        case "session.execution.succeeded":
          notifier.handle({ ...base, type: "session.execution.succeeded", eventID: event.id })
          return

        case "session.execution.failed":
          notifier.handle({
            ...base,
            type: "session.execution.failed",
            errorType: text(record(data.error)?.type),
          })
          return

        case "session.execution.interrupted":
          notifier.handle({
            ...base,
            type: "session.execution.interrupted",
            reason: text(data.reason),
          })
          return

        case "session.inbox.delivered":
          notifier.handle({ ...base, type: "session.inbox.delivered" })
          return

        case "session.tool.called":
          notifier.handle({
            ...base,
            type: "session.tool.called",
            background: record(data.input)?.background === true,
          })
          return

        case "permission.asked": {
          const requestID = text(data.id)
          if (!requestID) return
          notifier.handle({
            ...base,
            type: "permission.asked",
            requestID,
            action: text(data.action) ?? "",
          })
          return
        }

        case "permission.replied": {
          const requestID = text(data.requestID)
          if (!requestID) return
          notifier.handle({ ...base, type: "permission.replied", requestID })
          return
        }

        case "form.created": {
          const formID = text(form?.id)
          if (!formID) return
          notifier.handle({ ...base, type: "form.created", formID })
          return
        }

        case "form.replied":
        case "form.cancelled": {
          const formID = text(data.id)
          if (!formID) return
          notifier.handle({ ...base, type: event.type, formID })
          return
        }
      }
    }

    const controller = new AbortController()
    const consume = async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            await handle(event as RawEvent)
          } catch (error) {
            console.warn(
              `[opencode-tools] notify: ${error instanceof Error ? error.message : "event failed"}`,
            )
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn(
            `[opencode-tools] notify: event stream failed: ${
              error instanceof Error ? error.message : "unknown"
            }`,
          )
        }
      }
    }

    void consume()
    return () => {
      controller.abort()
      notifier.dispose()
    }
  },
})
