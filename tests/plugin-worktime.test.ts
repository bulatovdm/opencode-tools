import { describe, expect, test } from "bun:test"

import { collect, formatDuration, label, unionSeconds } from "../plugin/worktime"

const s = (value: number) => value * 1000

function assistant(created: number, completed?: number) {
  return { type: "assistant", time: { created, completed } }
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
})

describe("unionSeconds", () => {
  test("merges overlapping and touching intervals", () => {
    expect(unionSeconds([[0, 10_000], [5_000, 15_000], [15_000, 20_000], [30_000, 40_000]])).toBe(30)
  })
})

describe("label", () => {
  test("shows work and the current turn while running", () => {
    const summary = { seconds: 4320, live: true, lastUser: s(100) }
    expect(label(summary, true, s(280))).toBe("Работа: 1ч 12м · ход: 3м")
  })

  test("hides the turn while idle", () => {
    const summary = { seconds: 60, live: false, lastUser: 0 }
    expect(label(summary, false, s(1000))).toBe("Работа: 1м")
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
