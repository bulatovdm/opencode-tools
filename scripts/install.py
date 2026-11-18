#!/usr/bin/env python3
"""Установка opencode-tools: тесты, ссылка в ~/.local/bin, TUI-плагин."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

NAME = "opencode-tools"
CLI_CONFIG = Path.home() / ".config" / "opencode" / "cli.json"


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


def configure_plugin(source: Path, enabled: bool) -> None:
    path = str(source / "plugin")
    if not CLI_CONFIG.exists():
        if not enabled:
            return
        CLI_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        data = {"$schema": "https://opencode.ai/v2/cli.json"}
    else:
        try:
            data = json.loads(CLI_CONFIG.read_text())
        except ValueError as error:
            raise SystemExit(
                f"Не разобрал {CLI_CONFIG}: {error}. Добавьте плагин вручную: {path}"
            )

    plugins = data.get("plugins")
    if plugins is None:
        plugins = []
    if not isinstance(plugins, list):
        raise SystemExit(f"В {CLI_CONFIG} поле plugins — не массив")

    before = json.dumps(data, sort_keys=True)
    if enabled:
        if path not in [item if isinstance(item, str) else item.get("package")
                        for item in plugins]:
            plugins.append(path)
    else:
        plugins = [item for item in plugins
                   if not (item == path or
                           (isinstance(item, dict) and item.get("package") == path))]
    data["plugins"] = plugins
    if json.dumps(data, sort_keys=True) == before:
        return

    if CLI_CONFIG.exists():
        stamp = datetime.now().strftime("%Y%m%dT%H%M%S%f")
        backup = CLI_CONFIG.with_name(CLI_CONFIG.name + ".backup-" + stamp)
        shutil.copyfile(CLI_CONFIG, backup)
        backup.chmod(0o600)

    CLI_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=".cli.json.", dir=CLI_CONFIG.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, CLI_CONFIG)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uninstall", action="store_true", help="убрать команду и плагин")
    args = parser.parse_args()

    source = Path(__file__).resolve().parents[1]
    script = source / "scripts" / f"{NAME}.py"
    binary = Path.home() / ".local" / "bin" / NAME

    if args.uninstall:
        configure_plugin(source, enabled=False)
        if binary.is_symlink() and binary.resolve() == script.resolve():
            binary.unlink()
            print(f"Удалено: {binary}")
        else:
            print(f"Команда не удалена: {binary} не ссылается на этот репозиторий")
        print("Плагин убран из cli.json. Перезапустите TUI или выполните /reload.")
        return 0

    run_tests(source)
    script.chmod(0o755)
    binary.parent.mkdir(parents=True, exist_ok=True)
    if binary.exists() or binary.is_symlink():
        if not binary.is_symlink() or binary.resolve() != script.resolve():
            raise SystemExit(f"Команда уже занята: {binary}")
    else:
        binary.symlink_to(script)

    configure_plugin(source, enabled=True)

    print(f"Установлено: {binary} -> {script}")
    print(f"Плагин TUI: {source / 'plugin'} (в cli.json)")
    print()
    print("  opencode-tools time            # работа последней сессии")
    print("  opencode-tools stats --days 7  # заходы, шаги, время, стоимость")
    print("  opencode-tools balance         # остаток на балансе")
    print("  opencode-tools watch           # живая строка")
    print()
    print("Строки «Работа: …» и «Токены: …» появятся в футере "
          "после /reload или перезапуска TUI.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
