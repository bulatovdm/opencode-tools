import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  apiKey,
  deepseekBalanceLabel,
  fetchDeepSeek,
  formatAmount,
  parseDeepSeek,
  readDeepSeekKey,
  snapshotLabel,
  type FetchLike,
} from "../plugin/balance"

const DEEPSEEK = {
  is_available: true,
  balance_infos: [{
    currency: "USD",
    total_balance: "10.14",
    granted_balance: "0.00",
    topped_up_balance: "10.14",
  }],
}

async function tempAuth(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencode-tools-"))
  const path = join(dir, "auth.json")
  await writeFile(path, contents)
  return path
}

describe("apiKey", () => {
  test("reads plain and nested entries", () => {
    expect(apiKey({ type: "api", key: "sk-1" })).toBe("sk-1")
    expect(apiKey({ type: { type: "api", key: "sk-2" } })).toBe("sk-2")
  })

  test("missing key", () => {
    expect(apiKey({ type: "api" })).toBeNull()
    expect(apiKey("sk-3")).toBeNull()
    expect(apiKey(null)).toBeNull()
  })
})

describe("readDeepSeekKey", () => {
  test("reads the deepseek key from auth.json", async () => {
    const path = await tempAuth(JSON.stringify({ deepseek: { type: "api", key: "sk-4" } }))
    try {
      expect(await readDeepSeekKey(path)).toBe("sk-4")
    } finally {
      await rm(path, { force: true })
    }
  })

  test("returns null when deepseek is not connected", async () => {
    const path = await tempAuth(JSON.stringify({ opencode: { type: "api", key: "sk-5" } }))
    try {
      expect(await readDeepSeekKey(path)).toBeNull()
    } finally {
      await rm(path, { force: true })
    }
  })
})

describe("parseDeepSeek", () => {
  test("parses balances", () => {
    const snapshot = parseDeepSeek(DEEPSEEK)
    expect(snapshot.available).toBe(true)
    expect(snapshot.balances[0].total).toBe(10.14)
    expect(snapshot.balances[0].granted).toBe(0)
    expect(snapshot.balances[0].toppedUp).toBe(10.14)
  })

  test("multiple currencies and bad numbers", () => {
    const snapshot = parseDeepSeek({
      balance_infos: [
        { currency: "USD", total_balance: "1.50" },
        { currency: "CNY", total_balance: "oops" },
      ],
    })
    expect(snapshot.balances).toHaveLength(2)
    expect(snapshot.balances[0].total).toBe(1.5)
    expect(snapshot.balances[1].total).toBeNull()
  })

  test("unavailable", () => {
    const snapshot = parseDeepSeek({ is_available: false, balance_infos: [] })
    expect(snapshot.available).toBe(false)
  })

  test("response without balance_infos", () => {
    expect(() => parseDeepSeek({ is_available: true })).toThrow()
  })
})

describe("fetchDeepSeek", () => {
  test("sends the key and parses the response", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fake: FetchLike = async (input, init) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify(DEEPSEEK), { status: 200 })
    }

    const snapshot = await fetchDeepSeek("sk-secret", { fetchImpl: fake })

    expect(snapshot.balances[0].total).toBe(10.14)
    expect(calls[0].url).toBe("https://api.deepseek.com/user/balance")
    expect((calls[0].init?.headers as Record<string, string>).Authorization)
      .toBe("Bearer sk-secret")
  })

  test("HTTP error", async () => {
    const fake: FetchLike = async () => new Response("nope", { status: 401 })
    await expect(fetchDeepSeek("sk", { fetchImpl: fake })).rejects.toThrow("HTTP 401")
  })
})

describe("formatting", () => {
  test("amounts", () => {
    expect(formatAmount(10.14, "USD")).toBe("$10.14")
    expect(formatAmount(0, "USD")).toBe("$0.00")
    expect(formatAmount(1234.5, "EUR")).toBe("€1,234.50")
    expect(formatAmount(5, "XYZ")).toBe("5.00 XYZ")
    expect(formatAmount(null, "USD")).toBe("—")
  })

  test("snapshot label", () => {
    expect(snapshotLabel(parseDeepSeek(DEEPSEEK))).toBe("DeepSeek: $10.14")
    expect(snapshotLabel({ available: false, balances: [] })).toBeNull()
  })

  test("full label from auth", async () => {
    const path = await tempAuth(JSON.stringify({ deepseek: { type: "api", key: "sk-6" } }))
    const fake: FetchLike = async () => new Response(JSON.stringify(DEEPSEEK), { status: 200 })
    try {
      expect(await deepseekBalanceLabel(path, fake)).toBe("DeepSeek: $10.14")
    } finally {
      await rm(path, { force: true })
    }
  })
})
