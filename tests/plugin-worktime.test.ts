import { describe, expect, test } from "bun:test"

import {
  collect,
  compactTokens,
  formatDuration,
  formatMoney,
  formatRate,
  generatedTokens,
  label,
  tokenTotal,
  tokensLabel,
  unionSeconds,
  type Tokens,
} from "../plugin/worktime"

const s = (value: number) => value * 1000

const noTokens: Tokens = {
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
}

function assistant(
  created: number,
  completed?: number,
  cost = 0,
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  },
) {
  return { type: "assistant", cost, tokens, time: { created, completed } }
}

function user(created: number) {
  return { type: "user", time: { created } }
}

describe("collect", () => {
  test("unions parallel subagent steps and drops idle gaps", () => {
    const summary = collect(
      [
        assistant(s(100), s(200)),
        assistant(s(150), s(250)),
        assistant(s(300), s(360)),
      ],
      s(1000),
    )
    expect(summary.seconds).toBe(210)
    expect(summary.live).toBe(false)
  })

  test("a fresh unfinished step grows to now", () => {
    const summary = collect(
      [assistant(s(100), s(200)), user(s(590)), assistant(s(600))],
      s(660),
    )
    expect(summary.seconds).toBe(160)
    expect(summary.live).toBe(true)
    expect(summary.lastUser).toBe(s(590))
  })

  test("a stale unfinished step does not grow", () => {
    const summary = collect(
      [assistant(s(100), s(200)), assistant(s(300))],
      s(300_000),
    )
    expect(summary.seconds).toBe(100)
    expect(summary.live).toBe(false)
  })

  test("corrupt completion is ignored", () => {
    const summary = collect([assistant(s(100), s(100 + 3600))], s(10_000))
    expect(summary.seconds).toBe(0)
  })

  test("empty input", () => {
    expect(collect([], s(10)).seconds).toBe(0)
  })

  test("sums the cost of assistant steps", () => {
    const summary = collect(
      [assistant(s(100), s(110), 0.2), assistant(s(120), s(130), 0.05)],
      s(1000),
    )
    expect(summary.cost).toBeCloseTo(0.25)
  })

  test("sums input, cache and output tokens", () => {
    const summary = collect(
      [
        assistant(s(100), s(110), 0, {
          input: 100, output: 20, reasoning: 30,
          cache: { read: 1000, write: 5 },
        }),
        assistant(s(120), s(130), 0, {
          input: 50, output: 10, reasoning: 5,
          cache: { read: 500, write: 0 },
        }),
      ],
      s(1000),
    )
    expect(summary.tokens).toEqual({
      input: 150,
      cacheRead: 1500,
      cacheWrite: 5,
      output: 30,
      reasoning: 35,
    })
  })
})

describe("unionSeconds", () => {
  test("merges overlapping and touching intervals", () => {
    expect(unionSeconds([[0, 10_000], [5_000, 15_000], [15_000, 20_000], [30_000, 40_000]])).toBe(30)
  })
})

describe("label", () => {
  test("shows work and the current turn while running", () => {
    const summary = {
      seconds: 4320, live: true, lastUser: s(100), cost: 0, tokens: noTokens,
    }
    expect(label(summary, true, s(280))).toBe("Работа: 1ч 12м · ход: 3м")
  })

  test("hides the turn while idle", () => {
    const summary = {
      seconds: 60, live: false, lastUser: 0, cost: 0, tokens: noTokens,
    }
    expect(label(summary, false, s(1000))).toBe("Работа: 1м")
  })

  test("adds spent money and provider balance", () => {
    const summary = {
      seconds: 60, live: false, lastUser: 0, cost: 0.42, tokens: noTokens,
    }
    expect(label(summary, false, s(1000), "DeepSeek: $10.14"))
      .toBe("Работа: 1м · потрачено $0.4200 · баланс DeepSeek: $10.14")
  })
})

describe("tokensLabel", () => {
  const tokens: Tokens = {
    input: 116_700,
    cacheRead: 12_100_000,
    cacheWrite: 0,
    output: 31_600,
    reasoning: 58_800,
  }

  test("shows total, breakdown and session pace", () => {
    const summary = {
      seconds: 10_000, live: false, lastUser: 0, cost: 0, tokens,
    }
    expect(tokenTotal(tokens)).toBe(12_307_100)
    expect(generatedTokens(tokens)).toBe(90_400)
    expect(tokensLabel(summary)).toBe(
      "Токены: 12,3M · вход 116,7k · из кэша 12,1M · выход 90,4k · 9,0 ток/с",
    )
  })

  test("shows cache writes when present", () => {
    const summary = {
      seconds: 0,
      live: false,
      lastUser: 0,
      cost: 0,
      tokens: { ...tokens, cacheWrite: 2_500 },
    }
    expect(tokensLabel(summary)).toBe(
      "Токены: 12,3M · вход 116,7k · из кэша 12,1M · запись 2,5k · выход 90,4k",
    )
  })

  test("hides empty tokens", () => {
    const summary = {
      seconds: 10, live: false, lastUser: 0, cost: 0, tokens: noTokens,
    }
    expect(tokensLabel(summary)).toBeNull()
  })
})

describe("compactTokens", () => {
  test("truncates instead of rounding up", () => {
    expect(compactTokens(999)).toBe("999")
    expect(compactTokens(1_000)).toBe("1k")
    expect(compactTokens(1_500)).toBe("1,5k")
    expect(compactTokens(999_999)).toBe("999,9k")
    expect(compactTokens(46_107_776)).toBe("46,1M")
    expect(compactTokens(2_000_000_000)).toBe("2B")
  })

  test("rate", () => {
    expect(formatRate(9.04)).toBe("9,0 ток/с")
    expect(formatRate(120.96)).toBe("121,0 ток/с")
  })
})

describe("formatMoney", () => {
  test("keeps more digits for small amounts", () => {
    expect(formatMoney(12.3)).toBe("$12.30")
    expect(formatMoney(1.23)).toBe("$1.230")
    expect(formatMoney(0.42)).toBe("$0.4200")
  })
})

describe("formatDuration", () => {
  test("seconds, minutes, hours", () => {
    expect(formatDuration(0)).toBe("0с")
    expect(formatDuration(59)).toBe("59с")
    expect(formatDuration(60)).toBe("1м")
    expect(formatDuration(3599)).toBe("59м")
    expect(formatDuration(3600)).toBe("1ч 00м")
    expect(formatDuration(4320)).toBe("1ч 12м")
  })
})
