import { describe, expect, test } from "bun:test"

import {
  fetchGoUsage,
  formatReset,
  goKey,
  parseGoUsage,
  percentText,
  remainingPercent,
  usageLabel,
  type FetchLike,
} from "../plugin/usage"

const LIVE = {
  usage: {
    rolling: { status: "ok", percent: 6, resetsAt: "2026-11-20T00:22:57.000Z" },
    weekly: { status: "ok", percent: 2, resetsAt: "2026-11-23T00:00:00.000Z" },
    monthly: { status: "ok", percent: 1, resetsAt: "2026-12-19T19:05:10.000Z" },
  },
}

const NOW = Date.parse("2026-11-19T20:00:00.000Z")

describe("parseGoUsage", () => {
  test("parses the three windows and ISO reset times", () => {
    const value = parseGoUsage(LIVE)
    expect(value.rolling.percent).toBe(6)
    expect(value.weekly.percent).toBe(2)
    expect(value.monthly.percent).toBe(1)
    expect(value.rolling.resetsAt).toBe(Date.parse("2026-11-20T00:22:57.000Z"))
    expect(value.weekly.limited).toBe(false)
  })

  test("accepts millisecond reset times", () => {
    const value = parseGoUsage({
      usage: {
        rolling: { status: "rate-limited", percent: 100, resetsAt: 1_800_000_000_000 },
        weekly: { percent: 0, resetsAt: 0 },
        monthly: { percent: 50, resetsAt: 1_900_000_000_000 },
      },
    })
    expect(value.rolling.limited).toBe(true)
    expect(value.rolling.resetsAt).toBe(1_800_000_000_000)
  })

  test("rejects a response without usage", () => {
    expect(() => parseGoUsage({})).toThrow()
    expect(() => parseGoUsage({ usage: {} })).toThrow()
  })
})

describe("remaining percent", () => {
  test("shows what is left, not what is used", () => {
    expect(remainingPercent({ percent: 6, limited: false, resetsAt: 0 })).toBe(94)
    expect(remainingPercent({ percent: 0, limited: false, resetsAt: 0 })).toBe(100)
  })

  test("a closed window has nothing left", () => {
    expect(remainingPercent({ percent: 12, limited: true, resetsAt: 0 })).toBe(0)
  })

  test("keeps one decimal below ten percent", () => {
    expect(percentText(94)).toBe("94")
    expect(percentText(99.6)).toBe("99,6")
    expect(percentText(0)).toBe("0")
  })
})

describe("formatReset", () => {
  test("minutes, hours and days", () => {
    expect(formatReset(NOW + 30_000, NOW)).toBe("1м")
    expect(formatReset(NOW + 4 * 60 * 60_000, NOW)).toBe("4ч")
    expect(formatReset(NOW + (4 * 60 + 23) * 60_000, NOW)).toBe("4ч 23м")
    expect(formatReset(NOW + 3 * 24 * 60 * 60_000, NOW)).toBe("3д")
    expect(formatReset(NOW - 1, NOW)).toBe("сейчас")
  })
})

describe("usageLabel", () => {
  test("composes the Go line with the remaining limits", () => {
    expect(usageLabel(parseGoUsage(LIVE), NOW)).toBe(
      "Go: осталось 5ч 94% (4ч 23м) · нед 98% (3д) · мес 99% (29д)",
    )
  })

  test("omits reset when the server did not report it", () => {
    const value = parseGoUsage({
      usage: {
        rolling: { percent: 50 },
        weekly: { percent: 50 },
        monthly: { percent: 50 },
      },
    })
    expect(usageLabel(value, NOW)).toBe(
      "Go: осталось 5ч 50% · нед 50% · мес 50%",
    )
  })

  test("shows a closed window without a percent", () => {
    const value = parseGoUsage({
      usage: {
        rolling: { status: "rate-limited", percent: 100, resetsAt: NOW + 60_000 },
        weekly: { status: "ok", percent: 50, resetsAt: NOW + 3 * 24 * 60 * 60_000 },
        monthly: { status: "ok", percent: 90, resetsAt: NOW + 20 * 24 * 60 * 60_000 },
      },
    })
    expect(usageLabel(value, NOW)).toBe(
      "Go: осталось 5ч лимит · нед 50% (3д) · мес 10% (20д)",
    )
  })
})

describe("goKey", () => {
  test("reads the active key", () => {
    expect(goKey([
      { integrationID: "opencode-go", active: true, value: { type: "key", key: "oc_sk_1" } },
    ])).toBe("oc_sk_1")
  })

  test("accepts OAuth access", () => {
    expect(goKey([
      { integrationID: "opencode-go", active: true, value: { type: "oauth", access: "tok" } },
    ])).toBe("tok")
  })

  test("ignores other providers and inactive entries", () => {
    expect(goKey([
      { integrationID: "deepseek", active: true, value: { type: "key", key: "sk" } },
      { integrationID: "opencode-go", active: false, value: { type: "key", key: "oc_sk_2" } },
    ])).toBeNull()
    expect(goKey([])).toBeNull()
  })
})

describe("fetchGoUsage", () => {
  test("sends the key and parses the response", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fake: FetchLike = async (input, init) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify(LIVE), { status: 200 })
    }

    const value = await fetchGoUsage("oc_sk_secret", { fetchImpl: fake })

    expect(value.rolling.percent).toBe(6)
    expect(calls[0].url).toBe("https://opencode.ai/zen/go/v1/usage")
    expect((calls[0].init?.headers as Record<string, string>).Authorization)
      .toBe("Bearer oc_sk_secret")
  })

  test("HTTP error", async () => {
    const fake: FetchLike = async () => new Response("nope", { status: 401 })
    await expect(fetchGoUsage("oc_sk", { fetchImpl: fake }))
      .rejects.toThrow("HTTP 401")
  })
})
