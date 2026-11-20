#!/usr/bin/env python3
"""Установка opencode-tools: тесты, ссылка в ~/.local/bin, плагины OpenCode."""
from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

NAME = "opencode-tools"
CONFIG_DIR = Path.home() / ".config" / "opencode"
CLI_CONFIG = CONFIG_DIR / "cli.json"
SERVER_CONFIG = CONFIG_DIR / "opencode.json"
NOTIFY_CONFIG = CONFIG_DIR / "notify.env"
SHARED_NOTIFY_CONFIG = Path.home() / ".claude" / "notify.env"

CLI_SCHEMA = "https://opencode.ai/v2/cli.json"
SERVER_SCHEMA = "https://opencode.ai/config.json"


def run_tests(source: Path) -> None:
    subprocess.run(
        [sys.executable, "-m", "unittest", "discover", "-s", str(source / "tests")],
        check=True,
    )
    bun = shutil.which("bun")
    if bun:
        subprocess.run(
            [bun, "test", str(source / "tests")],
            check=True,
        )


def configure_plugin(
    config: Path,
    plugin: str,
    enabled: bool,
    schema: str,
) -> None:
    """Добавляет или убирает путь плагина в списке plugins."""
    if not config.exists():
        if not enabled:
            return
        config.parent.mkdir(parents=True, exist_ok=True)
        data = {"$schema": schema}
    else:
        try:
            data = json.loads(config.read_text())
        except ValueError as error:
            raise SystemExit(
                f"Не разобрал {config}: {error}. Добавьте плагин вручную: {plugin}"
            )

    plugins = data.get("plugins")
    if plugins is None:
        plugins = []
    if not isinstance(plugins, list):
        raise SystemExit(f"В {config} поле plugins — не массив")

    before = json.dumps(data, sort_keys=True)
    if enabled:
        if plugin not in [item if isinstance(item, str) else item.get("package")
                          for item in plugins]:
            plugins.append(plugin)
    else:
        plugins = [item for item in plugins
                   if not (item == plugin or
                           (isinstance(item, dict) and item.get("package") == plugin))]
    data["plugins"] = plugins
    if json.dumps(data, sort_keys=True) == before:
        return

    if config.exists():
        stamp = datetime.now().strftime("%Y%m%dT%H%M%S%f")
        backup = config.with_name(config.name + ".backup-" + stamp)
        shutil.copyfile(config, backup)
        backup.chmod(0o600)

    config.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{config.name}.", dir=config.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, config)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def configure_tui(source: Path, enabled: bool) -> None:
    configure_plugin(CLI_CONFIG, str(source / "plugin"), enabled, CLI_SCHEMA)


def configure_notifier(source: Path, enabled: bool) -> None:
    configure_plugin(SERVER_CONFIG, str(source / "notify"), enabled, SERVER_SCHEMA)


def codex_notify_config() -> Path:
    home = os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))
    return Path(home) / "notify.env"


def notify_config_path() -> Path | None:
    explicit = os.environ.get("OPENCODE_NOTIFY_CONFIG")
    if explicit:
        path = Path(explicit)
        return path if path.exists() else None
    if NOTIFY_CONFIG.exists():
        return NOTIFY_CONFIG
    codex = codex_notify_config()
    if codex.exists():
        return codex
    if SHARED_NOTIFY_CONFIG.exists():
        return SHARED_NOTIFY_CONFIG
    return None


def ensure_notify_config() -> Path | None:
    """Создаёт личный notify.env, если нет ни своего, ни общего с Codex/Claude."""
    if os.environ.get("OPENCODE_NOTIFY_CONFIG"):
        return None
    if (NOTIFY_CONFIG.exists() or codex_notify_config().exists()
            or SHARED_NOTIFY_CONFIG.exists()):
        return None

    NOTIFY_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    topic = "opencode-" + secrets.token_hex(16)
    content = (
        "# Phone notifications for OpenCode (notify/index.ts).\n"
        "# ntfy: install the ntfy app on your phone and subscribe to this topic.\n"
        "# Anyone who knows the topic name can read it, so keep it secret.\n"
        f"NTFY_TOPIC={topic}\n"
        "# NTFY_SERVER=https://ntfy.sh\n"
        "\n"
        "# Seconds after a turn ends before \"waiting for your reply\".\n"
        "# IDLE_NOTIFY_SECONDS=30\n"
        "# Seconds before a permission or question push (0 = immediately).\n"
        "# INPUT_NOTIFY_SECONDS=0\n"
        "# Longest hold while a background task is still running.\n"
        "# BACKGROUND_WAIT_LIMIT_SECONDS=900\n"
        "\n"
        "# Telegram (optional): a bot from @BotFather and your chat id.\n"
        "# TELEGRAM_BOT_TOKEN=\n"
        "# TELEGRAM_CHAT_ID=\n"
    )

    descriptor, temporary = tempfile.mkstemp(
        prefix=".notify.env.", dir=NOTIFY_CONFIG.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            stream.write(content)
        os.chmod(temporary, 0o600)
        os.replace(temporary, NOTIFY_CONFIG)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return NOTIFY_CONFIG


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--uninstall", action="store_true", help="убрать команду и плагины")
    args = parser.parse_args()

    source = Path(__file__).resolve().parents[1]
    script = source / "scripts" / f"{NAME}.py"
    binary = Path.home() / ".local" / "bin" / NAME

    if args.uninstall:
        configure_tui(source, enabled=False)
        configure_notifier(source, enabled=False)
        if binary.is_symlink() and binary.resolve() == script.resolve():
            binary.unlink()
            print(f"Удалено: {binary}")
        else:
            print(f"Команда не удалена: {binary} не ссылается на этот репозиторий")
        print("Плагины убраны из cli.json и opencode.json. "
              "Перезапустите TUI или выполните /reload.")
        return 0

    run_tests(source)
    script.chmod(0o755)
    binary.parent.mkdir(parents=True, exist_ok=True)
    if binary.exists() or binary.is_symlink():
        if not binary.is_symlink() or binary.resolve() != script.resolve():
            raise SystemExit(f"Команда уже занята: {binary}")
    else:
        binary.symlink_to(script)

    configure_tui(source, enabled=True)
    configure_notifier(source, enabled=True)
    created = ensure_notify_config()
    notify = notify_config_path()

    print(f"Установлено: {binary} -> {script}")
    print(f"Плагин TUI: {source / 'plugin'} (в cli.json)")
    print(f"Плагин уведомлений: {source / 'notify'} (в opencode.json)")
    if notify:
        suffix = " (создан)" if created else ""
        print(f"Уведомления: {notify}{suffix}")
        print("Подпишитесь на топик из этого файла в приложении ntfy.")
    elif os.environ.get("OPENCODE_NOTIFY_CONFIG"):
        print(f"Уведомления: {os.environ['OPENCODE_NOTIFY_CONFIG']} (файл не найден)")
    print()
    print("  opencode-tools time            # работа последней сессии")
    print("  opencode-tools stats --days 7  # заходы, шаги, время, стоимость")
    print("  opencode-tools balance         # остаток на балансе")
    print("  opencode-tools limits          # остаток лимитов OpenCode Go")
    print("  opencode-tools watch           # живая строка")
    print()
    print("Строки «Работа: …», «Go: …» и «Токены: …» появятся в футере "
          "после /reload или перезапуска TUI.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
