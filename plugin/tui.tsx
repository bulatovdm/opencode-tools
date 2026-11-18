/**
 * TUI-плагин: строка «Работа: …» в футере промпта.
 *
 * Время считается по загруженным сообщениям сессии и её субагентов.
 * Точные цифры за всё время — `opencode-tools stats`.
 */
import { Plugin } from "@opencode/plugin/tui"

import { deepseekBalanceLabel } from "./balance"
import { collect, label } from "./worktime"

export default Plugin.define({
  id: "opencode-tools.worktime",
  setup(context) {
    const [clock, tick] = context.storage.memory("clock", {
      initial: { now: Date.now() },
    })
    const [balance, setBalance] = context.storage.store("balance", {
      initial: { text: "" },
    })

    let busy = false
    let pending: ReturnType<typeof setTimeout> | undefined
    const usingDeepSeek = () => context.ui.model.current()?.providerID === "deepseek"
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

    void refresh(true)
    const balanceTimer = setInterval(() => void refresh(), 5 * 60 * 1000)
    const stopExecuted = context.data.on("session.execution.succeeded", () => {
      if (usingDeepSeek()) schedule(3000)
    })
    const stopModel = context.data.on("session.model.selected", () => {
      schedule(1000, true)
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
          return (
            <text fg={context.theme.text.base}>
              {label(summary, running, clock.now,
                     provider === "deepseek" ? balance.text : "")}
            </text>
          )
        } catch {
          return <text> </text>
        }
      },
    })

    return () => {
      clearInterval(timer)
      clearInterval(balanceTimer)
      if (pending) clearTimeout(pending)
      stopExecuted()
      stopModel()
      stop()
    }
  },
})
