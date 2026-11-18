import io
import json
import pathlib
import sys
import tempfile
import unittest
import urllib.error

ROOT = pathlib.Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import balance as bl  # noqa: E402

DEEPSEEK = {
    "is_available": True,
    "balance_infos": [{
        "currency": "USD",
        "total_balance": "10.17",
        "granted_balance": "0.00",
        "topped_up_balance": "10.17",
    }],
}


class FakeResponse:
    def __init__(self, payload):
        self.body = json.dumps(payload).encode("utf-8")

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class AuthTests(unittest.TestCase):
    def test_reads_api_key(self):
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / "auth.json"
            path.write_text(json.dumps({"deepseek": {"type": "api", "key": "sk-1"}}))
            auth = bl.read_auth(path)
        self.assertEqual(bl.api_key(auth["deepseek"]), "sk-1")

    def test_reads_nested_api_key(self):
        self.assertEqual(
            bl.api_key({"type": {"type": "api", "key": "sk-2"}}), "sk-2")

    def test_missing_key_is_none(self):
        self.assertIsNone(bl.api_key({"type": "api"}))
        self.assertIsNone(bl.api_key("sk-3"))
        self.assertIsNone(bl.api_key(None))

    def test_missing_auth_file(self):
        with self.assertRaises(FileNotFoundError):
            bl.read_auth(pathlib.Path("/nonexistent/auth.json"))

    def test_malformed_auth_file(self):
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / "auth.json"
            path.write_text("{not json")
            with self.assertRaises(ValueError):
                bl.read_auth(path)


class DeepSeekTests(unittest.TestCase):
    def test_parses_balance(self):
        value = bl.parse_deepseek(DEEPSEEK)
        self.assertTrue(value["available"])
        self.assertEqual(value["balances"][0]["total"], 10.17)
        self.assertEqual(value["balances"][0]["granted"], 0.0)
        self.assertEqual(value["balances"][0]["topped_up"], 10.17)

    def test_parses_multiple_currencies_and_bad_numbers(self):
        value = bl.parse_deepseek({
            "balance_infos": [
                {"currency": "USD", "total_balance": "1.50"},
                {"currency": "CNY", "total_balance": "oops"},
            ],
        })
        self.assertTrue(value["available"])
        self.assertEqual(len(value["balances"]), 2)
        self.assertEqual(value["balances"][0]["total"], 1.5)
        self.assertIsNone(value["balances"][1]["total"])

    def test_unavailable(self):
        value = bl.parse_deepseek({"is_available": False, "balance_infos": []})
        self.assertFalse(value["available"])

    def test_response_without_balance_infos(self):
        with self.assertRaises(bl.BalanceError):
            bl.parse_deepseek({"is_available": True})


class FetchTests(unittest.TestCase):
    def setUp(self):
        self.original = bl.open_url
        self.addCleanup(setattr, bl, "open_url", self.original)
        self.auth = {"deepseek": {"type": "api", "key": "sk-secret"}}

    def test_fetch_sends_key_and_returns_balance(self):
        seen = []

        def fake(request, timeout=None):
            seen.append((request, timeout))
            return FakeResponse(DEEPSEEK)

        bl.open_url = fake
        values = bl.fetch_balances(self.auth, timeout=3)

        self.assertEqual(len(values), 1)
        self.assertEqual(values[0]["id"], "deepseek")
        self.assertEqual(values[0]["name"], "DeepSeek")
        self.assertEqual(values[0]["balances"][0]["total"], 10.17)
        request, timeout = seen[0]
        self.assertEqual(request.full_url, "https://api.deepseek.com/user/balance")
        self.assertEqual(request.get_header("Authorization"), "Bearer sk-secret")
        self.assertEqual(timeout, 3)

    def test_http_error_is_reported(self):
        def failing(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 401, "Unauthorized", {},
                io.BytesIO(b'{"error":{"message":"bad key"}}'))

        bl.open_url = failing
        with self.assertRaises(bl.BalanceError) as caught:
            bl.fetch_balances(self.auth)
        self.assertIn("HTTP 401", str(caught.exception))
        self.assertIn("bad key", str(caught.exception))

    def test_network_error_is_reported(self):
        def failing(request, timeout=None):
            raise urllib.error.URLError("offline")

        bl.open_url = failing
        with self.assertRaises(bl.BalanceError) as caught:
            bl.fetch_balances(self.auth)
        self.assertIn("DeepSeek", str(caught.exception))
        self.assertIn("offline", str(caught.exception))

    def test_unsupported_provider(self):
        with self.assertRaises(bl.BalanceError) as caught:
            bl.fetch_balances(self.auth, only="opencode")
        self.assertIn("не поддержан", str(caught.exception))

    def test_no_supported_provider_connected(self):
        with self.assertRaises(bl.BalanceError) as caught:
            bl.fetch_balances({"opencode": {"type": "api", "key": "x"}})
        self.assertIn("opencode", str(caught.exception))

    def test_connected_provider_without_key(self):
        with self.assertRaises(bl.BalanceError) as caught:
            bl.fetch_balances({"deepseek": {"type": "api"}})
        self.assertIn("нет API-ключа", str(caught.exception))


class FormatTests(unittest.TestCase):
    def test_money(self):
        self.assertEqual(bl.fmt_amount(10.17, "USD"), "$10.17")
        self.assertEqual(bl.fmt_amount(0, "USD"), "$0.00")
        self.assertEqual(bl.fmt_amount(1234.5, "EUR"), "€1,234.50")
        self.assertEqual(bl.fmt_amount(5.0, "XYZ"), "5.00 XYZ")
        self.assertEqual(bl.fmt_amount(None, "USD"), "—")

    def test_label_joins_currencies(self):
        value = {"balances": [
            {"total": 1.5, "currency": "USD"},
            {"total": 20.0, "currency": "CNY"},
        ]}
        self.assertEqual(bl.balance_label(value), "$1.50 · ¥20.00")
        self.assertEqual(bl.balance_label({"balances": []}), "нет данных")


if __name__ == "__main__":
    unittest.main()
