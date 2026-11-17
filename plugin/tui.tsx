/**
 * TUI-плагин: строка «Работа: …» в футере промпта.
 *
 * Время считается по загруженным сообщениям сессии и её субагентов.
 * Точные цифры за всё время — `opencode-tools stats`.
 */
import { Plugin } from "@opencode/plugin/tui"

import { collect, label } from "./worktime"

export default Plugin.define({
  id: "opencode-tools.worktime",
  setup(context) {
    const [clock, tick] = context.storage.memory("clock", {
      initial: { now: Date.now() },
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
          return (
            <text fg={context.theme.text.base}>
              {label(summary, running, clock.now)}
            </text>
          )
        } catch {
          return <text> </text>
        }
      },
    })

    return () => {
      clearInterval(timer)
      stop()
    }
  },
})
