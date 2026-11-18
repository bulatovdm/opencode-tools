#!/usr/bin/env python3
"""Остаток на балансе провайдеров, подключённых к OpenCode.

Ключи OpenCode хранит в `auth.json` рядом с базой. У каждого провайдера свой
эндпоинт и свой формат ответа, поэтому поддержка добавляется по одному:
сейчас это DeepSeek. OpenCode Zen публичного API баланса не имеет.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path

import worktime

DEFAULT_TIMEOUT = 10.0
USER_AGENT = "opencode-tools"

# Подменяется в тестах, чтобы не ходить в сеть.
open_url = urllib.request.urlopen

CURRENCY_SYMBOLS = {
    "USD": "$",
    "EUR": "€",
    "CNY": "¥",
    "RUB": "₽",
}


class BalanceError(RuntimeError):
    """Не удалось получить баланс."""


# ------------------------------------------------------------------ ключи

def auth_path() -> Path:
    return worktime.data_dir() / "auth.json"


def read_auth(path: Path | None = None) -> dict:
    path = path or auth_path()
    if not path.exists():
        raise FileNotFoundError(f"файл с ключами OpenCode не найден: {path}")
    try:
        text = path.read_text()
    except OSError as error:
        raise ValueError(f"не прочитал {path}: {error}") from error
    try:
        data = json.loads(text)
    except ValueError as error:
        raise ValueError(f"не разобрал {path}: {error}") from error
    if not isinstance(data, dict):
        raise ValueError(f"в {path} ожидался объект JSON")
    return data


def api_key(entry) -> str | None:
    """Ключ из записи auth.json: обычной или вложенной формы."""
    if not isinstance(entry, dict):
        return None
    key = entry.get("key")
    if isinstance(key, str) and key:
        return key
    nested = entry.get("type")
    if isinstance(nested, dict):
        key = nested.get("key")
        if isinstance(key, str) and key:
            return key
    return None


# ------------------------------------------------------------------ провайдеры

def number(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_deepseek(payload) -> dict:
    if not isinstance(payload, dict):
        raise BalanceError("DeepSeek вернул не объект JSON")
    infos = payload.get("balance_infos")
    if not isinstance(infos, list):
        raise BalanceError("в ответе DeepSeek нет balance_infos")

    balances = []
    for info in infos:
        if not isinstance(info, dict):
            continue
        balances.append({
            "currency": str(info.get("currency") or ""),
            "total": number(info.get("total_balance")),
            "granted": number(info.get("granted_balance")),
            "topped_up": number(info.get("topped_up_balance")),
        })
    return {
        "available": payload.get("is_available") is not False,
        "balances": balances,
    }


PROVIDERS = {
    "deepseek": {
        "name": "DeepSeek",
        "url": "https://api.deepseek.com/user/balance",
        "parse": parse_deepseek,
    },
}


def http_error_detail(error: urllib.error.HTTPError) -> str:
    try:
        payload = json.loads(error.read().decode("utf-8"))
    except (ValueError, UnicodeDecodeError, AttributeError):
        return ""
    if not isinstance(payload, dict):
        return ""
    message = payload.get("error")
    if isinstance(message, dict):
        message = message.get("message")
    if isinstance(message, str) and message:
        return " · " + message
    return ""


def fetch_provider(provider_id: str, key: str,
                   timeout: float = DEFAULT_TIMEOUT) -> dict:
    provider = PROVIDERS.get(provider_id)
    if provider is None:
        raise BalanceError(f"провайдер не поддержан: {provider_id}")

    request = urllib.request.Request(
        provider["url"],
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
        raise BalanceError(
            f"{provider['name']}: HTTP {error.code}{http_error_detail(error)}"
        ) from error
    except urllib.error.URLError as error:
        raise BalanceError(
            f"{provider['name']}: не удалось связаться — {error.reason}"
        ) from error
    except TimeoutError as error:
        raise BalanceError(
            f"{provider['name']}: нет ответа за {timeout:g} с"
        ) from error
    except OSError as error:
        raise BalanceError(
            f"{provider['name']}: не удалось связаться — {error}"
        ) from error

    try:
        payload = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as error:
        raise BalanceError(f"{provider['name']}: не разобрал ответ") from error

    value = provider["parse"](payload)
    return {"id": provider_id, "name": provider["name"], **value}


def fetch_balances(auth: dict, only: str | None = None,
                   timeout: float = DEFAULT_TIMEOUT) -> list[dict]:
    """Опросить выбранного провайдера или всех поддержанных из auth.json."""
    if only:
        if only not in PROVIDERS:
            support = ", ".join(sorted(PROVIDERS))
            raise BalanceError(
                f"провайдер «{only}» не поддержан (есть: {support})")
        ids = [only]
    else:
        ids = [provider_id for provider_id in PROVIDERS if provider_id in auth]

    if not ids:
        connected = ", ".join(sorted(auth)) or "нет"
        support = ", ".join(PROVIDERS)
        raise BalanceError(
            f"нет подключённых провайдеров с поддержкой баланса ({support}). "
            f"Подключены: {connected}")

    result = []
    for provider_id in ids:
        key = api_key(auth.get(provider_id))
        if not key:
            name = PROVIDERS[provider_id]["name"]
            raise BalanceError(f"{name}: в auth.json нет API-ключа")
        result.append(fetch_provider(provider_id, key, timeout))
    return result


# ------------------------------------------------------------------ вывод

def fmt_amount(value: float | None, currency: str = "") -> str:
    if value is None:
        return "—"
    amount = f"{value:,.2f}"
    symbol = CURRENCY_SYMBOLS.get(currency.upper())
    if symbol:
        return f"{symbol}{amount}"
    return f"{amount} {currency}".strip()


def balance_label(value: dict) -> str:
    balances = value["balances"]
    if not balances:
        return "нет данных"
    if len(balances) == 1:
        return fmt_amount(balances[0]["total"], balances[0]["currency"])
    return " · ".join(
        fmt_amount(item["total"], item["currency"]) for item in balances)


def print_balance(values: list[dict]) -> None:
    print("OpenCode · баланс")
    print()
    for value in values:
        print(f"  {value['name']:<16}{balance_label(value):>12}")
        if not value["available"]:
            print(f"    {'статус':<14}{'недоступен':>12}")
        for item in value["balances"]:
            print(f"    {'оплачено':<14}{fmt_amount(item['topped_up'], item['currency']):>12}")
            print(f"    {'бонусы':<14}{fmt_amount(item['granted'], item['currency']):>12}")
    print()
