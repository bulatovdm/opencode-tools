/**
 * Решения «кому и когда отправлять пуш» отдельно от OpenCode.
 *
 * Время, таймеры и отправка внедряются, поэтому сценарии проверяются в
 * тестах без живого сервера: конец хода, запрос разрешения, вопрос, отмена
 * ответом, фоновые задачи и субагенты.
 */
import {
  QUESTION,
  WAITING,
  WAITING_BACKGROUND,
  errorBody,
  permissionBody,
} from "./format"

export type SessionMeta = {
  id: string
  parentID?: string
  title?: string
  directory?: string
}

type Base = {
  sessionID: string
  meta: SessionMeta
}

export type NotifyEvent =
  | (Base & { type: "session.created" })
  | (Base & { type: "session.renamed" })
  | (Base & { type: "session.execution.started" })
  | (Base & { type: "session.execution.succeeded"; eventID?: string })
  | (Base & { type: "session.execution.failed"; errorType?: string })
  | (Base & { type: "session.execution.interrupted"; reason?: string })
  | (Base & { type: "session.inbox.delivered" })
  | (Base & { type: "session.tool.called"; background: boolean })
  | (Base & { type: "permission.asked"; requestID: string; action: string })
  | (Base & { type: "permission.replied"; requestID: string })
  | (Base & { type: "form.created"; formID: string })
  | (Base & { type: "form.replied"; formID: string })
  | (Base & { type: "form.cancelled"; formID: string })

export type Timer = ReturnType<typeof setTimeout>

export type Clock = {
  now(): number
  setTimeout(callback: () => void, milliseconds: number): Timer
  clearTimeout(timer: Timer): void
}

export type NotifierOptions = {
  idleSeconds: number
  inputSeconds: number
  backgroundLimitSeconds: number
  notify: (sessionID: string, body: string) => void
  clock?: Clock
  log?: (message: string) => void
}

type Wait = {
  token: object
  started: number
  timer?: Timer
}

export const RECHECK_MS = 15_000

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (timer) => clearTimeout(timer),
}

export class Notifier {
  private readonly options: NotifierOptions
  private readonly clock: Clock
  private readonly meta = new Map<string, SessionMeta>()
  private readonly active = new Set<string>()
  private readonly inputs = new Map<string, Set<string>>()
  private readonly inputTimers = new Map<string, Map<string, Timer>>()
  private readonly waits = new Map<string, Wait>()
  private readonly background = new Map<string, number>()
  private readonly lastSuccess = new Map<string, string>()

  constructor(options: NotifierOptions) {
    this.options = options
    this.clock = options.clock ?? systemClock
  }

  handle(event: NotifyEvent): void {
    const previous = this.meta.get(event.sessionID)
    this.meta.set(event.sessionID, {
      id: event.sessionID,
      parentID: event.meta.parentID ?? previous?.parentID,
      title: event.meta.title ?? previous?.title,
      directory: event.meta.directory ?? previous?.directory,
    })

    switch (event.type) {
      case "session.created":
      case "session.renamed":
        return

      case "session.execution.started":
        this.cancelWait(event.sessionID)
        this.clearInputs(event.sessionID)
        this.background.delete(event.sessionID)
        this.lastSuccess.delete(event.sessionID)
        this.active.add(event.sessionID)
        return

      case "session.execution.succeeded":
        if (event.eventID && this.lastSuccess.get(event.sessionID) === event.eventID) {
          return
        }
        if (event.eventID) this.lastSuccess.set(event.sessionID, event.eventID)
        this.active.delete(event.sessionID)
        if (this.isChild(event.sessionID)) return
        this.scheduleWait(event.sessionID)
        return

      case "session.execution.failed":
        this.active.delete(event.sessionID)
        this.cancelWait(event.sessionID)
        if (!this.isChild(event.sessionID)) {
          this.emit(event.sessionID, errorBody(event.errorType))
        }
        return

      case "session.execution.interrupted":
        this.active.delete(event.sessionID)
        this.cancelWait(event.sessionID)
        return

      case "session.inbox.delivered":
        this.cancelWait(event.sessionID)
        return

      case "session.tool.called":
        if (!event.background) return
        this.background.set(event.sessionID, (this.background.get(event.sessionID) ?? 0) + 1)
        return

      case "permission.asked":
        // Вопрос приходит отдельным form.created; иначе был бы двойной пуш.
        if (event.action === "question") return
        this.scheduleInput(
          event.sessionID,
          `permission:${event.requestID}`,
          permissionBody(event.action),
        )
        return

      case "permission.replied":
        this.settleInput(event.sessionID, `permission:${event.requestID}`)
        return

      case "form.created":
        this.scheduleInput(event.sessionID, `form:${event.formID}`, QUESTION)
        return

      case "form.replied":
      case "form.cancelled":
        this.settleInput(event.sessionID, `form:${event.formID}`)
        return
    }
  }

  /** Забыть сессию: таймеры снимаются, состояние удаляется. */
  forget(sessionID: string): void {
    this.cancelWait(sessionID)
    this.clearInputs(sessionID)
    this.active.delete(sessionID)
    this.background.delete(sessionID)
    this.lastSuccess.delete(sessionID)
    this.meta.delete(sessionID)
  }

  dispose(): void {
    for (const sessionID of [...this.waits.keys()]) this.cancelWait(sessionID)
    for (const sessionID of [...this.inputTimers.keys()]) this.clearInputs(sessionID)
  }

  private isChild(sessionID: string): boolean {
    return Boolean(this.meta.get(sessionID)?.parentID)
  }

  private rootOf(sessionID: string): string {
    let current = sessionID
    const seen = new Set<string>()
    while (true) {
      if (seen.has(current)) return current
      seen.add(current)
      const parent = this.meta.get(current)?.parentID
      if (!parent || parent === current) return current
      current = parent
    }
  }

  private hasActiveDescendant(root: string): boolean {
    for (const sessionID of this.active) {
      if (sessionID !== root && this.rootOf(sessionID) === root) return true
    }
    return false
  }

  private hasInput(sessionID: string): boolean {
    return (this.inputs.get(sessionID)?.size ?? 0) > 0
  }

  private hasInputDescendant(root: string): boolean {
    for (const [sessionID, keys] of this.inputs) {
      if (sessionID === root || keys.size === 0) continue
      if (this.rootOf(sessionID) === root) return true
    }
    return false
  }

  private scheduleWait(sessionID: string): void {
    this.cancelWait(sessionID)
    // Пока висит запрос разрешения или вопрос, «жду ответа» не нужен:
    // о самом запросе уже отправлено отдельное уведомление.
    if (this.hasInput(sessionID)) return

    const token = {}
    const started = this.clock.now()
    const state: Wait = { token, started }
    this.waits.set(sessionID, state)

    const check = () => {
      const current = this.waits.get(sessionID)
      if (!current || current.token !== token) return

      if (this.hasInput(sessionID)) {
        this.waits.delete(sessionID)
        return
      }

      const blocked =
        this.hasActiveDescendant(sessionID) ||
        this.hasInputDescendant(sessionID) ||
        (this.background.get(sessionID) ?? 0) > 0

      if (blocked) {
        if (this.clock.now() - started >= this.options.backgroundLimitSeconds * 1000) {
          this.waits.delete(sessionID)
          this.emit(sessionID, WAITING_BACKGROUND)
          return
        }
        state.timer = this.clock.setTimeout(check, RECHECK_MS)
        return
      }

      this.waits.delete(sessionID)
      this.emit(sessionID, WAITING)
    }

    state.timer = this.clock.setTimeout(check, Math.max(0, this.options.idleSeconds) * 1000)
  }

  private cancelWait(sessionID: string): void {
    const state = this.waits.get(sessionID)
    if (!state) return
    if (state.timer !== undefined) this.clock.clearTimeout(state.timer)
    this.waits.delete(sessionID)
  }

  private scheduleInput(sessionID: string, key: string, body: string): void {
    let keys = this.inputs.get(sessionID)
    if (!keys) {
      keys = new Set()
      this.inputs.set(sessionID, keys)
    }
    if (keys.has(key)) return
    keys.add(key)

    let timers = this.inputTimers.get(sessionID)
    if (!timers) {
      timers = new Map()
      this.inputTimers.set(sessionID, timers)
    }
    const timer = this.clock.setTimeout(
      () => {
        timers?.delete(key)
        if (!this.inputs.get(sessionID)?.has(key)) return
        this.emit(sessionID, body)
      },
      Math.max(0, this.options.inputSeconds) * 1000,
    )
    timers.set(key, timer)
  }

  private settleInput(sessionID: string, key: string): void {
    const keys = this.inputs.get(sessionID)
    keys?.delete(key)
    if (keys?.size === 0) this.inputs.delete(sessionID)

    const timers = this.inputTimers.get(sessionID)
    const timer = timers?.get(key)
    if (timer !== undefined) this.clock.clearTimeout(timer)
    timers?.delete(key)
    if (timers?.size === 0) this.inputTimers.delete(sessionID)
  }

  private clearInputs(sessionID: string): void {
    const timers = this.inputTimers.get(sessionID)
    if (timers) {
      for (const timer of timers.values()) this.clock.clearTimeout(timer)
    }
    this.inputTimers.delete(sessionID)
    this.inputs.delete(sessionID)
  }

  private emit(sessionID: string, body: string): void {
    try {
      this.options.notify(sessionID, body)
    } catch (error) {
      this.options.log?.(`notify failed: ${error instanceof Error ? error.message : "unknown"}`)
    }
  }
}
