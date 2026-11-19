/**
 * TUI-плагин: строки «Работа: …», «Go: …» и «Токены: …» в футере промпта.
 *
 * Время и токены считаются по загруженным сообщениям сессии и её субагентов.
 * Остаток лимитов Go запрашивается только когда выбран провайдер opencode-go.
 * Точные цифры за всё время — `opencode-tools stats`.
 */
import { Plugin } from "@opencode/plugin/tui"

import { deepseekBalanceLabel } from "./balance"
import { fetchGoUsage, goKey, usageLabel, type GoUsage } from "./usage"
import { collect, label, tokensLabel } from "./worktime"

export default Plugin.define({
  id: "opencode-tools.worktime",
  setup(context) {
    const [clock, tick] = context.storage.memory("clock", {
      initial: { now: Date.now() },
    })
    const [balance, setBalance] = context.storage.store("balance", {
      initial: { text: "" },
    })
    const [usage, setUsage] = context.storage.memory("usage", {
      initial: { data: null as GoUsage | null },
    })

    let busy = false
    let pending: ReturnType<typeof setTimeout> | undefined
    let usageBusy = false
    let pendingUsage: ReturnType<typeof setTimeout> | undefined
    const usingDeepSeek = () => context.ui.model.current()?.providerID === "deepseek"
    const usingGo = () => context.ui.model.current()?.providerID === "opencode-go"

    const refresh = async (force = false) => {
      if (!force && !usingDeepSeek()) return
      if (busy) return
      busy = true
      try {
        const text = await deepseekBalanceLabel()
        if (text && text !== balance.text) {
          await setBalance((draft) => {
            draft.text = text
          })
        }
      } catch {
        // без баланса строка просто короче
      } finally {
        busy = false
      }
    }
    const schedule = (delay: number, force = false) => {
      if (pending) clearTimeout(pending)
      pending = setTimeout(() => void refresh(force), delay)
    }

    const clearUsage = async () => {
      if (usage.data === null) return
      await setUsage((draft) => {
        draft.data = null
      })
    }

    const refreshUsage = async () => {
      if (!usingGo()) {
        await clearUsage()
        return
      }
      if (usageBusy) return
      usageBusy = true
      try {
        const credentials = await context.client.credential.list()
        const key = goKey(credentials)
        if (!key) {
          await clearUsage()
          return
        }
        const data = await fetchGoUsage(key)
        await setUsage((draft) => {
          draft.data = data
        })
      } catch {
        // без лимитов строка просто короче
      } finally {
        usageBusy = false
      }
    }
    const scheduleUsage = (delay: number) => {
      if (pendingUsage) clearTimeout(pendingUsage)
      pendingUsage = setTimeout(() => void refreshUsage(), delay)
    }

    void refresh(true)
    void refreshUsage()
    const firstUsage = setTimeout(() => {
      if (usage.data === null) void refreshUsage()
    }, 2000)
    const balanceTimer = setInterval(() => void refresh(), 5 * 60 * 1000)
    const usageTimer = setInterval(() => void refreshUsage(), 5 * 60 * 1000)
    const stopExecuted = context.data.on("session.execution.succeeded", () => {
      if (usingDeepSeek()) schedule(3000)
      if (usingGo()) scheduleUsage(3000)
    })
    const stopModel = context.data.on("session.model.selected", () => {
      schedule(1000, true)
      scheduleUsage(1000)
    })

    const timer = setInterval(() => {
      tick((draft) => {
        draft.now = Date.now()
      })
    }, 1000)

    const stop = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const sessionID = input.sessionID
        if (!sessionID) return <text> </text>

        try {
          const family = context.data.session.family(sessionID) ?? [sessionID]
          const messages = family.flatMap(
            (id) => context.data.session.message.list(id) ?? [],
          )
          const summary = collect(messages, clock.now)
          const running = context.data.session.status(sessionID) === "running"
          const provider = context.ui.model.current()?.providerID
          const tokens = tokensLabel(summary)
          const limits = provider === "opencode-go" && usage.data
            ? usageLabel(usage.data, clock.now)
            : ""
          return (
            <box flexDirection="column">
              <text fg={context.theme.text.base}>
                {label(summary, running, clock.now,
                       provider === "deepseek" ? balance.text : "")}
              </text>
              {limits ? <text fg={context.theme.text.muted}>{limits}</text> : null}
              {tokens ? <text fg={context.theme.text.muted}>{tokens}</text> : null}
            </box>
          )
        } catch {
          return <text> </text>
        }
      },
    })

    return () => {
      clearTimeout(firstUsage)
      clearInterval(timer)
      clearInterval(balanceTimer)
      clearInterval(usageTimer)
      if (pending) clearTimeout(pending)
      if (pendingUsage) clearTimeout(pendingUsage)
      stopExecuted()
      stopModel()
      stop()
    }
  },
})
