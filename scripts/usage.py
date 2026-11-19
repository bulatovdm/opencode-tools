#!/usr/bin/env python3
"""Остаток лимитов OpenCode Go.

Go считает использованную долю пятичасового, недельного и месячного окна.
Для человека полезнее остаток, поэтому в выводе и футере показываем
`100 - percent`. Ключ берётся из auth.json или из таблицы credential в базе
OpenCode; ключ нигде не печатается.
"""
from __future__ import annotations

import json
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

import balance
import worktime

DEFAULT_TIMEOUT = 10.0
USER_AGENT = "opencode-tools"
URL = "https://opencode.ai/zen/go/v1/usage"

# Подменяется в тестах, чтобы не ходить в сеть.
open_url = urllib.request.urlopen

WINDOWS = (
    ("rolling", "5 часов"),
    ("weekly", "неделя"),
    ("monthly", "месяц"),
)


class UsageError(RuntimeError):
    """Не удалось получить лимиты Go."""


# ------------------------------------------------------------------ ключи

def credential_key(value) -> str | None:
    """Ключ из записи auth.json или credential: key/api или OAuth access."""
    if not isinstance(value, dict):
        return None
    kind = value.get("type")
    if kind in ("key", "api"):
        key = value.get("key")
        if isinstance(key, str) and key:
            return key
    if kind == "oauth":
        access = value.get("access")
        if isinstance(access, str) and access:
            return access
    key = value.get("key")
    if isinstance(key, str) and key:
        return key
    return None


def read_go_key_from_db(path: Path | None = None) -> str | None:
    """Ключ из таблицы credential. Активная запись важнее старой."""
    try:
        conn = worktime.connect(path)
    except (FileNotFoundError, RuntimeError, sqlite3.Error):
        return None
    try:
        if "credential" not in worktime.tables(conn):
            return None
        row = conn.execute(
            "select value from credential "
            "where integration_id = 'opencode-go' "
            "order by active desc, time_updated desc limit 1"
        ).fetchone()
        if row is None:
            return None
        payload = json.loads(row[0])
    except (sqlite3.Error, ValueError, TypeError):
        return None
    finally:
        conn.close()
    return credential_key(payload)


def read_go_key(auth_path: Path | None = None,
                db_path: Path | None = None) -> str | None:
    # Активная запись credential — текущий источник; auth.json — запасной.
    key = read_go_key_from_db(db_path)
    if key:
        return key
    try:
        auth = balance.read_auth(auth_path)
    except (FileNotFoundError, ValueError):
        auth = {}
    return credential_key(auth.get("opencode-go")) if isinstance(auth, dict) else None


# ------------------------------------------------------------------ ответ

def reset_ms(value) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str) and value:
        try:
            return int(
                datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
                * 1000
            )
        except ValueError:
            return 0
    return 0


def parse_meter(value, name: str) -> dict:
    if not isinstance(value, dict):
        raise UsageError(f"в ответе Go нет окна «{name}»")
    percent = balance.number(value.get("percent"))
    if percent is None:
        raise UsageError(f"в ответе Go нет процента окна «{name}»")
    return {
        "percent": max(0.0, min(100.0, percent)),
        "limited": value.get("status") == "rate-limited"
        or value.get("limited") is True,
        "resets_at": reset_ms(value.get("resetsAt")),
    }


def parse_go(payload) -> dict:
    if not isinstance(payload, dict):
        raise UsageError("OpenCode Go вернул не объект JSON")
    usage = payload.get("usage")
    if not isinstance(usage, dict):
        raise UsageError("в ответе OpenCode Go нет usage")
    return {
        key: parse_meter(usage.get(key), name)
        for key, name in WINDOWS
    }


def fetch_go(key: str, timeout: float = DEFAULT_TIMEOUT) -> dict:
    request = urllib.request.Request(
        URL,
        headers={
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with open_url(request, timeout=timeout) as response:
            body = response.read()
    except urllib.error.HTTPError as error:
        raise UsageError(
            f"OpenCode Go: HTTP {error.code}{balance.http_error_detail(error)}"
        ) from error
    except urllib.error.URLError as error:
        raise UsageError(
            f"OpenCode Go: не удалось связаться — {error.reason}"
        ) from error
    except TimeoutError as error:
        raise UsageError(
            f"OpenCode Go: нет ответа за {timeout:g} с"
        ) from error
    except OSError as error:
        raise UsageError(
            f"OpenCode Go: не удалось связаться — {error}"
        ) from error

    try:
        payload = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as error:
        raise UsageError("OpenCode Go: не разобрал ответ") from error
    return parse_go(payload)


# ------------------------------------------------------------------ вывод

def remaining(value: dict) -> float:
    if value["limited"]:
        return 0.0
    return max(0.0, min(100.0, 100.0 - value["percent"]))


def fmt_percent(value: float) -> str:
    rounded = round(value, 1)
    if rounded == int(rounded):
        return f"{int(rounded)}%"
    return f"{rounded:.1f}".replace(".", ",") + "%"


def fmt_time(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000).strftime("%d.%m %H:%M")


def print_limits(value: dict) -> None:
    print("OpenCode · лимиты Go")
    print()
    print(f"  {'окно':<12}{'осталось':>10}{'сброс':>18}")
    print("─" * 40)
    for key, name in WINDOWS:
        meter = value[key]
        left = "лимит" if meter["limited"] else fmt_percent(remaining(meter))
        reset = fmt_time(meter["resets_at"]) if meter["resets_at"] else "—"
        print(f"  {name:<12}{left:>10}{reset:>18}")
    print()
