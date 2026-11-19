import io
import json
import pathlib
import sqlite3
import sys
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stdout

ROOT = pathlib.Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import usage as us  # noqa: E402

LIVE = {
    "usage": {
        "rolling": {
            "status": "ok",
            "percent": 6,
            "resetsAt": "2026-11-20T00:22:57.000Z",
        },
        "weekly": {
            "status": "ok",
            "percent": 2,
            "resetsAt": "2026-11-23T00:00:00.000Z",
        },
        "monthly": {
            "status": "ok",
            "percent": 1,
            "resetsAt": "2026-12-19T19:05:10.000Z",
        },
    },
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


class ParseTests(unittest.TestCase):
    def test_parses_three_windows(self):
        value = us.parse_go(LIVE)
        self.assertEqual(value["rolling"]["percent"], 6)
        self.assertEqual(value["weekly"]["percent"], 2)
        self.assertEqual(value["monthly"]["percent"], 1)
        self.assertFalse(value["rolling"]["limited"])
        self.assertGreater(value["rolling"]["resets_at"], 0)

    def test_accepts_millisecond_resets(self):
        value = us.parse_go({
            "usage": {
                "rolling": {"percent": 100, "status": "rate-limited",
                            "resetsAt": 1_800_000_000_000},
                "weekly": {"percent": 0, "resetsAt": 0},
                "monthly": {"percent": 50, "resetsAt": 1_900_000_000_000},
            },
        })
        self.assertTrue(value["rolling"]["limited"])
        self.assertEqual(value["rolling"]["resets_at"], 1_800_000_000_000)

    def test_missing_usage(self):
        with self.assertRaises(us.UsageError):
            us.parse_go({})
        with self.assertRaises(us.UsageError):
            us.parse_go({"usage": {}})

    def test_remaining_and_percent(self):
        self.assertEqual(us.remaining({"percent": 6, "limited": False}), 94)
        self.assertEqual(us.remaining({"percent": 12, "limited": True}), 0)
        self.assertEqual(us.fmt_percent(94), "94%")
        self.assertEqual(us.fmt_percent(99.6), "99,6%")


class KeyTests(unittest.TestCase):
    def test_credential_key_forms(self):
        self.assertEqual(us.credential_key({"type": "key", "key": "oc_sk_1"}), "oc_sk_1")
        self.assertEqual(us.credential_key({"type": "api", "key": "sk-1"}), "sk-1")
        self.assertEqual(us.credential_key({"type": "oauth", "access": "tok"}), "tok")
        self.assertIsNone(us.credential_key({"type": "key"}))
        self.assertIsNone(us.credential_key("oc_sk_2"))

    def test_reads_key_from_auth_json(self):
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / "auth.json"
            path.write_text(json.dumps({
                "opencode-go": {"type": "api", "key": "oc_sk_3"},
            }))
            key = us.read_go_key(path, pathlib.Path(temp) / "missing.db")
        self.assertEqual(key, "oc_sk_3")

    def test_reads_key_from_credential_table(self):
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp) / "opencode.db"
            conn = sqlite3.connect(path)
            conn.execute(
                "create table credential ("
                "id text, integration_id text, label text, value text, "
                "active integer, time_updated integer)"
            )
            conn.execute(
                "insert into credential values (?, ?, ?, ?, ?, ?)",
                ("c1", "opencode-go", "Go",
                 json.dumps({"type": "key", "key": "oc_sk_old"}), 0, 1),
            )
            conn.execute(
                "insert into credential values (?, ?, ?, ?, ?, ?)",
                ("c2", "opencode-go", "Go",
                 json.dumps({"type": "key", "key": "oc_sk_new"}), 1, 2),
            )
            conn.commit()
            conn.close()
            key = us.read_go_key_from_db(path)
        self.assertEqual(key, "oc_sk_new")


class FetchTests(unittest.TestCase):
    def setUp(self):
        self.original = us.open_url
        self.addCleanup(setattr, us, "open_url", self.original)

    def test_fetch_sends_key_and_parses(self):
        seen = []

        def fake(request, timeout=None):
            seen.append((request, timeout))
            return FakeResponse(LIVE)

        us.open_url = fake
        value = us.fetch_go("oc_sk_secret", timeout=3)

        self.assertEqual(value["rolling"]["percent"], 6)
        request, timeout = seen[0]
        self.assertEqual(request.full_url, "https://opencode.ai/zen/go/v1/usage")
        self.assertEqual(request.get_header("Authorization"), "Bearer oc_sk_secret")
        self.assertEqual(timeout, 3)

    def test_http_error_is_reported(self):
        def failing(request, timeout=None):
            raise urllib.error.HTTPError(
                request.full_url, 401, "Unauthorized", {},
                io.BytesIO(b'{"error":{"message":"bad key"}}'))

        us.open_url = failing
        with self.assertRaises(us.UsageError) as caught:
            us.fetch_go("oc_sk")
        self.assertIn("HTTP 401", str(caught.exception))
        self.assertIn("bad key", str(caught.exception))


class PrintTests(unittest.TestCase):
    def test_prints_remaining_limits(self):
        output = io.StringIO()
        with redirect_stdout(output):
            us.print_limits(us.parse_go(LIVE))
        text = output.getvalue()
        self.assertIn("OpenCode · лимиты Go", text)
        self.assertIn("94%", text)
        self.assertIn("98%", text)
        self.assertIn("99%", text)
        self.assertIn("5 часов", text)
        self.assertIn("неделя", text)
        self.assertIn("месяц", text)


if __name__ == "__main__":
    unittest.main()
