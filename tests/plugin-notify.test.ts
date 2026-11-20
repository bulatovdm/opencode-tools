import { describe, expect, test } from "bun:test"

import {
  DEFAULT_BACKGROUND_LIMIT_SECONDS,
  DEFAULT_IDLE_SECONDS,
  DEFAULT_INPUT_SECONDS,
  DEFAULT_NTFY_SERVER,
  configFromText,
  configPath,
  loadConfig,
  parseEnvFile,
} from "../notify/config"
import { deliver, ntfyPayload, telegramText, type Fetcher } from "../notify/delivery"
import {
  QUESTION,
  WAITING,
  WAITING_BACKGROUND,
  errorBody,
  notificationTitle,
  permissionBody,
  projectLabel,
} from "../notify/format"
import {
  Notifier,
  RECHECK_MS,
  type NotifyEvent,
  type SessionMeta,
  type Timer,
} from "../notify/notifier"

const HOME = "/home/tester"

function fakeClock() {
  let current = 0
  let sequence = 0
  const timers = new Map<number, { at: number; callback: () => void }>()

  const clock = {
    now: () => current,
    setTimeout(callback: () => void, milliseconds: number) {
      const id = ++sequence
      timers.set(id, { at: current + Math.max(0, milliseconds), callback })
      return id as unknown as Timer
    },
    clearTimeout(timer: Timer) {
      timers.delete(timer as unknown as number)
    },
    advance(milliseconds: number) {
      const target = current + milliseconds
      for (;;) {
        let nextID: number | undefined
        let nextAt = Number.POSITIVE_INFINITY
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < nextAt) {
            nextID = id
            nextAt = timer.at
          }
        }
        if (nextID === undefined) break
        const timer = timers.get(nextID)
        if (!timer) break
        timers.delete(nextID)
        current = timer.at
        timer.callback()
      }
      current = target
    },
    pending: () => timers.size,
  }

  return clock
}

function meta(id: string, parentID?: string): SessionMeta {
  return { id, parentID, title: id, directory: "/project" }
}

function started(id: string, parentID?: string): NotifyEvent {
  return { type: "session.execution.started", sessionID: id, meta: meta(id, parentID) }
}

function succeeded(id: string, eventID = "event-1", parentID?: string): NotifyEvent {
  return { type: "session.execution.succeeded", sessionID: id, meta: meta(id, parentID), eventID }
}

function failed(id: string, errorType?: string, parentID?: string): NotifyEvent {
  return { type: "session.execution.failed", sessionID: id, meta: meta(id, parentID), errorType }
}

function interrupted(id: string): NotifyEvent {
  return { type: "session.execution.interrupted", sessionID: id, meta: meta(id) }
}

function delivered(id: string): NotifyEvent {
  return { type: "session.inbox.delivered", sessionID: id, meta: meta(id) }
}

function permission(id: string, requestID: string, action = "shell"): NotifyEvent {
  return { type: "permission.asked", sessionID: id, meta: meta(id), requestID, action }
}

function permissionReplied(id: string, requestID: string): NotifyEvent {
  return { type: "permission.replied", sessionID: id, meta: meta(id), requestID }
}

function form(id: string, formID: string): NotifyEvent {
  return { type: "form.created", sessionID: id, meta: meta(id), formID }
}

function formReplied(id: string, formID: string): NotifyEvent {
  return { type: "form.replied", sessionID: id, meta: meta(id), formID }
}

function background(id: string): NotifyEvent {
  return { type: "session.tool.called", sessionID: id, meta: meta(id), background: true }
}

function makeNotifier() {
  const sent: { sessionID: string; body: string }[] = []
  const clock = fakeClock()
  const notifier = new Notifier({
    idleSeconds: DEFAULT_IDLE_SECONDS,
    inputSeconds: DEFAULT_INPUT_SECONDS,
    backgroundLimitSeconds: DEFAULT_BACKGROUND_LIMIT_SECONDS,
    clock,
    notify: (sessionID, body) => sent.push({ sessionID, body }),
  })
  return { notifier, sent, clock }
}

describe("config", () => {
  test("parses the shared notify.env format", () => {
    const config = configFromText(`
# Phone notifications
export NTFY_TOPIC="opencode-secret"
NTFY_SERVER=http://127.0.0.1:8080
IDLE_NOTIFY_SECONDS=5
INPUT_NOTIFY_SECONDS="2"
BACKGROUND_WAIT_LIMIT_SECONDS=60
`)
    expect(config).toEqual({
      ntfy: { topic: "opencode-secret", server: "http://127.0.0.1:8080" },
      telegram: undefined,
      idleSeconds: 5,
      inputSeconds: 2,
      backgroundLimitSeconds: 60,
    })
  })

  test("keeps quoted hashes and drops inline comments", () => {
    const values = parseEnvFile(`
A="one # two"
B=three # comment
C='four'
D=$HOME/literal
`)
    expect(values.get("A")).toBe("one # two")
    expect(values.get("B")).toBe("three")
    expect(values.get("C")).toBe("four")
    expect(values.get("D")).toBe("$HOME/literal")
  })

  test("uses defaults and supports Telegram only", () => {
    const config = configFromText(`
TELEGRAM_BOT_TOKEN=token
TELEGRAM_CHAT_ID=42
`)
    expect(config).not.toBeNull()
    expect(config?.ntfy).toBeUndefined()
    expect(config?.telegram).toEqual({ token: "token", chatID: "42" })
    expect(config?.idleSeconds).toBe(DEFAULT_IDLE_SECONDS)
    expect(config?.inputSeconds).toBe(DEFAULT_INPUT_SECONDS)
    expect(config?.backgroundLimitSeconds).toBe(DEFAULT_BACKGROUND_LIMIT_SECONDS)
  })

  test("defaults the ntfy server", () => {
    const config = configFromText("NTFY_TOPIC=topic")
    expect(config?.ntfy?.server).toBe(DEFAULT_NTFY_SERVER)
  })

  test("returns null without a channel", () => {
    expect(configFromText("")).toBeNull()
    expect(configFromText("NTFY_TOPIC=")).toBeNull()
    expect(configFromText("IDLE_NOTIFY_SECONDS=5")).toBeNull()
  })

  test("ignores invalid numbers", () => {
    const config = configFromText(`
NTFY_TOPIC=topic
IDLE_NOTIFY_SECONDS=-1
INPUT_NOTIFY_SECONDS=oops
BACKGROUND_WAIT_LIMIT_SECONDS=Infinity
`)
    expect(config?.idleSeconds).toBe(DEFAULT_IDLE_SECONDS)
    expect(config?.inputSeconds).toBe(DEFAULT_INPUT_SECONDS)
    expect(config?.backgroundLimitSeconds).toBe(DEFAULT_BACKGROUND_LIMIT_SECONDS)
  })

  test("prefers an explicit config and treats an empty value as disabled", () => {
    expect(configPath({ OPENCODE_NOTIFY_CONFIG: "/tmp/custom.env" }, () => false)).toBe(
      "/tmp/custom.env",
    )
    expect(configPath({ OPENCODE_NOTIFY_CONFIG: "" }, () => true)).toBeNull()
  })

  test("falls back from the OpenCode config to Codex and Claude configs", () => {
    const own = `${HOME}/.config/opencode/notify.env`
    const codex = `${HOME}/.codex/notify.env`
    const shared = `${HOME}/.claude/notify.env`
    expect(configPath({ HOME }, (path) => path === own || path === codex || path === shared)).toBe(
      own,
    )
    expect(configPath({ HOME }, (path) => path === codex || path === shared)).toBe(codex)
    expect(configPath({ HOME }, (path) => path === shared)).toBe(shared)
    expect(configPath({ HOME }, () => false)).toBeNull()
  })

  test("honours CODEX_HOME", () => {
    const path = `${HOME}/codex-home/notify.env`
    expect(
      configPath({ HOME, CODEX_HOME: `${HOME}/codex-home` }, (candidate) => candidate === path),
    ).toBe(path)
  })

  test("honours XDG_CONFIG_HOME", () => {
    const path = `${HOME}/xdg/opencode/notify.env`
    expect(configPath({ HOME, XDG_CONFIG_HOME: `${HOME}/xdg` }, (candidate) => candidate === path)).toBe(
      path,
    )
  })

  test("loadConfig returns null when the file cannot be read", () => {
    expect(loadConfig({ OPENCODE_NOTIFY_CONFIG: "/missing" }, () => true, () => {
      throw new Error("nope")
    })).toBeNull()
  })
})

describe("format", () => {
  test("permission body names the action", () => {
    expect(permissionBody("shell")).toBe("🔐 Needs permission: shell")
    expect(permissionBody("  ")).toBe("🔐 Needs permission")
  })

  test("error body names the type", () => {
    expect(errorBody("ProviderAPIError")).toBe(
      "⚠️ OpenCode stopped with an error (ProviderAPIError)",
    )
    expect(errorBody()).toBe("⚠️ OpenCode stopped with an error")
  })

  test("project label names the worktree", () => {
    expect(projectLabel("/repo", "/repo")).toBe("repo")
    expect(projectLabel("/repo", "/worktrees/login")).toBe("repo (login)")
    expect(projectLabel("/repo", "/repo/packages/app")).toBe("repo (app)")
  })

  test("title keeps the project, session name and short id", () => {
    expect(
      notificationTitle("repo", { id: "ses_1234567890abcdef", title: "  Fix   tests " }),
    ).toBe("OpenCode · repo · Fix tests [90abcdef]")
    expect(notificationTitle("repo", { id: "ses_1234567890abcdef" })).toBe(
      "OpenCode · repo · 90abcdef",
    )
  })

  test("title is a single line and truncated", () => {
    const title = notificationTitle("repo", {
      id: "ses_1234567890abcdef",
      title: "a\nb".repeat(100),
    })
    expect(title).not.toContain("\n")
    expect(title).toContain("…")
  })
})

describe("delivery", () => {
  const push = { title: "OpenCode · repo · test", body: WAITING }
  const config = {
    ntfy: { topic: "topic", server: "http://127.0.0.1:9" },
    telegram: { token: "token", chatID: "42" },
    idleSeconds: 30,
    inputSeconds: 0,
    backgroundLimitSeconds: 900,
  }

  test("ntfy payload carries topic, priority and message", () => {
    const payload = JSON.parse(ntfyPayload("topic", push)) as Record<string, unknown>
    expect(payload.topic).toBe("topic")
    expect(payload.title).toBe(push.title)
    expect(payload.message).toBe(push.body)
    expect(payload.priority).toBe(4)
  })

  test("sends to both channels independently", async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetcher: Fetcher = async (url, init) => {
      calls.push({ url, init })
      return new Response("", { status: url.includes("telegram") ? 500 : 200 })
    }

    const results = await deliver(config, push, fetcher)
    expect(results).toEqual([
      { channel: "ntfy", ok: true },
      { channel: "telegram", ok: false },
    ])
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toBe("http://127.0.0.1:9")
    expect(calls[1]?.url).toBe("https://api.telegram.org/bottoken/sendMessage")
    const telegram = new URLSearchParams(String(calls[1]?.init?.body))
    expect(telegram.get("chat_id")).toBe("42")
    expect(telegram.get("text")).toBe(telegramText(push))
  })

  test("a failed channel does not block the other", async () => {
    const fetcher: Fetcher = async (url) => {
      if (url.includes("127.0.0.1")) throw new Error("down")
      return new Response("", { status: 200 })
    }
    const results = await deliver(config, push, fetcher)
    expect(results).toEqual([
      { channel: "ntfy", ok: false },
      { channel: "telegram", ok: true },
    ])
  })
})

describe("notifier", () => {
  test("waits IDLE_NOTIFY_SECONDS and reports once per turn", () => {
    const { notifier, sent, clock } = makeNotifier()
    notifier.handle(started("root"))
    notifier.handle(succeeded("root"))

    clock.advance((DEFAULT_IDLE_SECONDS - 1) * 1000)
    expect(sent).toEqual([])
    clock.advance(1000)
    expect(sent).toEqual([{ sessionID: "root", body: WAITING }])
    clock.advance(60_000)
    expect(sent).toHaveLength(1)
  })

  test("a new turn cancels the idle timer", () => {
    const { notifier, sent, clock } = makeNotifier()
    notifier.handle(started("root"))
    notifier.handle(succeeded("root"))
    clock.advance(10_000)
    notifier.handle(started("root"))
    clock.advance(60_000)
    expect(sent).toEqual([])
  })

  test("a new user prompt cancels the idle timer", () => {
    const { notifier, sent, clock } = makeNotifier()
    notifier.handle(started("root"))
    notifier.handle(succeeded("root"))
    clock.advance(10_000)
    notifier.handle(delivered("root"))
    clock.advance(60_000)
    expect(sent).toEqual([])
  })

  test("interrupt and forget cancel the idle timer", () => {
    const first = makeNotifier()
    first.notifier.handle(started("root"))
    first.notifier.handle(succeeded("root"))
    first.clock.advance(10_000)
    first.notifier.handle(interrupted("root"))
    first.clock.advance(60_000)
    expect(first.sent).toEqual([])

    const second = makeNotifier()
    second.notifier.handle(started("root"))
    second.notifier.handle(succeeded("root"))
    second.clock.advance(10_000)
    second.notifier.forget("root")
    second.clock.advance(60_000)
    expect(second.sent).toEqual([])
  })

  test("permission is reported immediately and question permissions are left to form.created", () => {
    const { notifier, sent, clock } = makeNotifier()
    notifier.handle(permission("root", "p1", "shell"))
    clock.advance(0)
    expect(sent).toEqual([{ sessionID: "root", body: "🔐 Needs permission: shell" }])

    notifier.handle(permission("root", "p2", "question"))
    clock.advance(0)
    expect(sent).toHaveLength(1)
  })

  test("permission reply cancels a delayed input notification", () => {
    const sent: { sessionID: string; body: string }[] = []
    const clock = fakeClock()
    const notifier = new Notifier({
      idleSeconds: 30,
      inputSeconds: 30,
      backgroundLimitSeconds: 900,
      clock,
      notify: (sessionID, body) => sent.push({ sessionID, body }),
    })
    notifier.handle(permission("root", "p1"))
    clock.advance(10_000)
    notifier.handle(permissionReplied("root", "p1"))
    clock.advance(60_000)
    expect(sent).toEqual([])
  })

  test("form.created asks a question and reply cancels it", () => {
    const sent: { sessionID: string; body: string }[] = []
    const clock = fakeClock()
    const notifier = new Notifier({
      idleSeconds: 30,
      inputSeconds: 5,
      backgroundLimitSeconds: 900,
      clock,
      notify: (sessionID, body) => sent.push({ sessionID, body }),
    })

    notifier.handle(form("root", "f1"))
    clock.advance(4_000)
    notifier.handle(formReplied("root", "f1"))
    clock.advance(10_000)
    expect(sent).toEqual([])

    notifier.handle(form("root", "f2"))
    clock.advance(5_000)
    expect(sent).toEqual([{ sessionID: "root", body: QUESTION }])
  })

  test("execution started clears a pending delayed input", () => {
    const sent: { sessionID: string; body: string }[] = []
    const clock = fakeClock()
    const notifier = new Notifier({
      idleSeconds: 30,
      inputSeconds: 30,
      backgroundLimitSeconds: 900,
      clock,
      notify: (sessionID, body) => sent.push({ sessionID, body }),
    })

    notifier.handle(permission("root", "p1"))
    notifier.handle(started("root"))
    clock.advance(60_000)
    expect(sent).toEqual([])
  })

  test("a child turn does not report, and the parent waits for it", () => {
    const { notifier, sent, clock } = makeNotifier()
    notifier.handle(started("root"))
    notifier.handle(started("child", "root"))
    notifier.handle(succeeded("root"))
    clock.advance(DEFAULT_IDLE_SECONDS * 1000)
    expect(sent).toEqual([])

    notifier.handle(succeeded("child", "child-1", "root"))
    clock.advance(RECHECK_MS)
    expect(sent).toEqual([{ sessionID: "root", body: WAITING }])
  })

  test("a child question is reported without a parent idle push", () => {
    const { notifier, sent, clock } = makeNotifier()
    notifier.handle(started("root"))
    notifier.handle(started("child", "root"))
    notifier.handle(succeeded("root"))
    notifier.handle(permission("child", "p1", "question"))

    notifier.handle(form("child", "f1"))
    clock.advance(0)
    expect(sent).toEqual([{ sessionID: "child", body: QUESTION }])

    clock.advance(DEFAULT_IDLE_SECONDS * 1000)
    expect(sent).toHaveLength(1)
  })

  test("background work holds the idle push up to the limit", () => {
    const { notifier, sent, clock } = makeNotifier()
    notifier.handle(started("root"))
    notifier.handle(background("root"))
    notifier.handle(succeeded("root"))

    clock.advance(DEFAULT_IDLE_SECONDS * 1000)
    expect(sent).toEqual([])
    clock.advance((DEFAULT_BACKGROUND_LIMIT_SECONDS - DEFAULT_IDLE_SECONDS) * 1000)
    expect(sent).toEqual([{ sessionID: "root", body: WAITING_BACKGROUND }])
  })

  test("a resumed session clears the background hold", () => {
    const { notifier, sent, clock } = makeNotifier()
    notifier.handle(started("root"))
    notifier.handle(background("root"))
    notifier.handle(succeeded("root"))
    clock.advance(10_000)

    notifier.handle(started("root"))
    notifier.handle(succeeded("root", "event-2"))
    clock.advance(DEFAULT_IDLE_SECONDS * 1000)
    expect(sent).toEqual([{ sessionID: "root", body: WAITING }])
  })

  test("a failed root reports an error, a failed child does not", () => {
    const root = makeNotifier()
    root.notifier.handle(failed("root", "ProviderAPIError"))
    expect(root.sent).toEqual([
      { sessionID: "root", body: "⚠️ OpenCode stopped with an error (ProviderAPIError)" },
    ])

    const child = makeNotifier()
    child.notifier.handle(failed("child", "ToolError", "root"))
    expect(child.sent).toEqual([])
  })

  test("the same success event is reported once", () => {
    const { notifier, sent, clock } = makeNotifier()
    notifier.handle(started("root"))
    notifier.handle(succeeded("root", "same"))
    clock.advance(DEFAULT_IDLE_SECONDS * 1000)
    notifier.handle(succeeded("root", "same"))
    clock.advance(DEFAULT_IDLE_SECONDS * 1000)
    expect(sent).toHaveLength(1)
  })

  test("a later event without parent does not turn a child into a root", () => {
    const { notifier, sent, clock } = makeNotifier()
    notifier.handle(started("root"))
    notifier.handle(started("child", "root"))
    notifier.handle(permission("child", "p1"))
    clock.advance(0)
    expect(sent).toEqual([{ sessionID: "child", body: "🔐 Needs permission: shell" }])

    notifier.handle(succeeded("root"))
    clock.advance(DEFAULT_IDLE_SECONDS * 1000)
    expect(sent).toHaveLength(1)

    notifier.handle(permissionReplied("child", "p1"))
    notifier.handle(succeeded("child", "child-1"))
    clock.advance(RECHECK_MS)
    expect(sent[1]).toEqual({ sessionID: "root", body: WAITING })
  })

  test("pending input suppresses the idle push", () => {
    const { notifier, sent, clock } = makeNotifier()
    notifier.handle(permission("root", "p1"))
    notifier.handle(succeeded("root"))
    clock.advance(60_000)
    expect(sent).toEqual([{ sessionID: "root", body: "🔐 Needs permission: shell" }])
  })
})
