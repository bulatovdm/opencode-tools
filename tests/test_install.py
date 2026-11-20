"""Тесты установщика: правка plugins и общий notify.env."""
from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

INSTALL = Path(__file__).resolve().parents[1] / "scripts" / "install.py"


def load_install():
    spec = importlib.util.spec_from_file_location("opencode_tools_install", INSTALL)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Не загрузил {INSTALL}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ConfigurePluginTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_install()
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.config = self.root / "opencode.json"
        self.config.write_text(json.dumps({
            "$schema": "https://opencode.ai/config.json",
            "mcp": {},
            "plugins": [],
        }))

    def read(self) -> dict:
        return json.loads(self.config.read_text())

    def test_adds_once_and_keeps_other_settings(self) -> None:
        plugin = str(self.root / "notify")
        self.module.configure_plugin(
            self.config, plugin, True, "https://opencode.ai/config.json")
        self.module.configure_plugin(
            self.config, plugin, True, "https://opencode.ai/config.json")
        data = self.read()
        self.assertEqual(data["plugins"], [plugin])
        self.assertEqual(data["mcp"], {})
        self.assertEqual(data["$schema"], "https://opencode.ai/config.json")

    def test_removes_only_its_own_plugin(self) -> None:
        plugin = str(self.root / "notify")
        other = str(self.root / "other")
        self.module.configure_plugin(
            self.config, other, True, "https://opencode.ai/config.json")
        self.module.configure_plugin(
            self.config, plugin, True, "https://opencode.ai/config.json")
        self.module.configure_plugin(
            self.config, plugin, False, "https://opencode.ai/config.json")
        self.assertEqual(self.read()["plugins"], [other])

    def test_creates_missing_config(self) -> None:
        config = self.root / "new.json"
        plugin = str(self.root / "notify")
        self.module.configure_plugin(
            config, plugin, True, "https://opencode.ai/config.json")
        self.assertEqual(json.loads(config.read_text())["plugins"], [plugin])

    def test_ignores_a_missing_config_on_uninstall(self) -> None:
        config = self.root / "missing.json"
        self.module.configure_plugin(
            config, str(self.root / "notify"), False, "https://opencode.ai/config.json")
        self.assertFalse(config.exists())


class NotifyConfigTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_install()
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.own = self.root / ".config" / "opencode" / "notify.env"
        self.codex = self.root / "codex" / "notify.env"
        self.shared = self.root / "claude" / "notify.env"
        patchers = [
            mock.patch.object(self.module, "NOTIFY_CONFIG", self.own),
            mock.patch.object(self.module, "SHARED_NOTIFY_CONFIG", self.shared),
            mock.patch.object(self.module, "codex_notify_config", lambda: self.codex),
        ]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_order_is_own_codex_shared(self) -> None:
        self.assertEqual(self.module.notify_config_path(), None)
        self.shared.parent.mkdir(parents=True)
        self.shared.write_text("NTFY_TOPIC=shared\n")
        self.assertEqual(self.module.notify_config_path(), self.shared)
        self.codex.parent.mkdir(parents=True)
        self.codex.write_text("NTFY_TOPIC=codex\n")
        self.assertEqual(self.module.notify_config_path(), self.codex)
        self.own.parent.mkdir(parents=True)
        self.own.write_text("NTFY_TOPIC=own\n")
        self.assertEqual(self.module.notify_config_path(), self.own)

    def test_creates_a_private_config_only_when_none_exists(self) -> None:
        with mock.patch.dict(os.environ, {"OPENCODE_NOTIFY_CONFIG": ""}):
            created = self.module.ensure_notify_config()
            self.assertEqual(created, self.own)
            self.assertTrue(self.own.exists())
            self.assertEqual(self.own.stat().st_mode & 0o777, 0o600)
            self.assertIn("NTFY_TOPIC=opencode-", self.own.read_text())

            self.assertIsNone(self.module.ensure_notify_config())

    def test_does_not_create_when_a_shared_config_exists(self) -> None:
        self.shared.parent.mkdir(parents=True)
        self.shared.write_text("NTFY_TOPIC=shared\n")
        with mock.patch.dict(os.environ, {"OPENCODE_NOTIFY_CONFIG": ""}):
            self.assertIsNone(self.module.ensure_notify_config())
        self.assertFalse(self.own.exists())


if __name__ == "__main__":
    unittest.main()
