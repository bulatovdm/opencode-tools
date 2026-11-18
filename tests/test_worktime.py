import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest
from datetime import date, datetime, timedelta

spec = importlib.util.spec_from_file_location(
    "worktime", pathlib.Path(__file__).parents[1] / "scripts/worktime.py")
wt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wt)

ROOT = "ses_root"
CHILD = "ses_child"


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = pathlib.Path(self.temp.name) / "opencode.db"
        self.db = sqlite3.connect(self.path)
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.executescript("""
            create table project (id text primary key, worktree text);
            create table session_v2 (
                id text primary key, project_id text, parent_id text, title text,
                time_created integer, time_updated integer, time_archived integer,
                cost real, tokens_input integer, tokens_output integer,
                tokens_reasoning integer);
            create table session_message (
                id text primary key, session_id text, type text, seq integer,
                time_created integer, time_updated integer, data text);
            create table message (
                id text primary key, session_id text,
                time_created integer, time_updated integer, data text);
        """)

    def session(self, session_id, parent=None, title="test", created=0,
                cost=0.0, project="p1"):
        self.db.execute(
            "insert into session_v2 values (?,?,?,?,?,?,?,?,?,?,?)",
            (session_id, project, parent, title, created, created, None,
             cost, 0, 0, 0))

    def assistant(self, session_id, created, completed=None, cost=0.0,
                  tools=(), tokens=None):
        content = [{"type": "tool", "name": name} for name in tools]
        data = {
            "role": "assistant",
            "time": {"created": created, "completed": completed},
            "cost": cost,
            "content": content,
        }
        if tokens is not None:
            data["tokens"] = tokens
        self.db.execute(
            "insert into session_message values (?,?,?,?,?,?,?)",
            (f"msg_{session_id}_{created}", session_id, "assistant", created,
             created, created, json.dumps(data)))

    def user(self, session_id, created):
        data = {"role": "user", "time": {"created": created}}
        self.db.execute(
            "insert into session_message values (?,?,?,?,?,?,?)",
            (f"usr_{session_id}_{created}", session_id, "user", created,
             created, created, json.dumps(data)))

    def v1_assistant(self, session_id, created, completed):
        data = {"role": "assistant",
                "time": {"created": created, "completed": completed}}
        self.db.execute(
            "insert into message values (?,?,?,?,?)",
            (f"v1_{session_id}_{created}", session_id, created, created,
             json.dumps(data)))

    def store(self):
        self.db.commit()


def s(value):
    return int(value * 1000)


class WorkTimeTests(Fixture):
    def test_parallel_subagents_are_unioned_and_idle_excluded(self):
        self.session(ROOT, title="root")
        self.session(CHILD, parent=ROOT, title="child")
        # [100,200] and [150,250] overlap by 50s; gap 250..300 is idle
        self.assistant(ROOT, s(100), s(200))
        self.assistant(CHILD, s(150), s(250))
        self.assistant(ROOT, s(300), s(360))
        self.store()
        value = wt.session_work_time(self.db, ROOT, now_ms=s(1000))
        self.assertEqual(value["total_seconds"], 210)
        self.assertFalse(value["live"])
        self.assertIsNone(value["current_seconds"])

    def test_live_step_advances_and_stops_at_now(self):
        self.session(ROOT)
        self.assistant(ROOT, s(100), s(200))
        self.user(ROOT, s(590))
        self.assistant(ROOT, s(600), None)
        self.store()
        value = wt.session_work_time(self.db, ROOT, now_ms=s(660))
        self.assertEqual(value["total_seconds"], 160)
        self.assertTrue(value["live"])
        self.assertEqual(value["current_seconds"], 70)

    def test_stale_unfinished_step_does_not_grow(self):
        self.session(ROOT)
        self.assistant(ROOT, s(100), s(200))
        self.assistant(ROOT, s(300), None)
        self.store()
        value = wt.session_work_time(self.db, ROOT, now_ms=s(300_000))
        self.assertEqual(value["total_seconds"], 100)
        self.assertFalse(value["live"])

    def test_corrupt_completion_is_ignored(self):
        self.session(ROOT)
        self.assistant(ROOT, s(100), s(100 + 3600))
        self.store()
        value = wt.session_work_time(self.db, ROOT, now_ms=s(10_000))
        self.assertEqual(value["total_seconds"], 0)

    def test_v1_timestamps_win_for_migrated_sessions(self):
        self.session(ROOT)
        self.session(CHILD, parent=ROOT)
        # V2: completion written at migration, 40 minutes later
        self.assistant(ROOT, s(100), s(2500))
        # V1: the real 10 second step
        self.v1_assistant(ROOT, s(100), s(110))
        self.store()
        value = wt.session_work_time(self.db, ROOT, now_ms=s(10_000))
        self.assertEqual(value["total_seconds"], 10)

    def test_subagent_steps_roll_up_into_root(self):
        self.session(ROOT)
        self.session(CHILD, parent=ROOT)
        self.assistant(CHILD, s(100), s(160), tools=("read", "edit"))
        self.store()
        value = wt.session_work_time(self.db, ROOT, now_ms=s(10_000))
        self.assertEqual(value["total_seconds"], 60)
        self.assertEqual(value["subagents"], 1)
        self.assertEqual(value["steps"], 1)
        self.assertEqual(value["tools"], 2)

    def test_tokens_roll_up_and_speed_uses_work_time(self):
        self.session(ROOT)
        self.session(CHILD, parent=ROOT)
        self.assistant(ROOT, s(100), s(110), tokens={
            "input": 100, "output": 20, "reasoning": 30,
            "cache": {"read": 1000, "write": 5},
        })
        self.assistant(CHILD, s(100), s(110), tokens={
            "input": 50, "output": 10, "reasoning": 5,
            "cache": {"read": 500, "write": 0},
        })
        self.store()
        value = wt.session_work_time(self.db, ROOT, now_ms=s(1000))
        tokens = value["tokens"]
        self.assertEqual(tokens["input"], 150)
        self.assertEqual(tokens["cache_read"], 1500)
        self.assertEqual(tokens["cache_write"], 5)
        self.assertEqual(tokens["output"], 30)
        self.assertEqual(tokens["reasoning"], 35)
        self.assertEqual(tokens["total"], 1720)
        self.assertEqual(tokens["generated"], 65)
        self.assertAlmostEqual(value["tokens_per_second"], 6.5)

    def test_compact_token_format_truncates(self):
        self.assertEqual(wt.fmt_tokens(999), "999")
        self.assertEqual(wt.fmt_tokens(1000), "1k")
        self.assertEqual(wt.fmt_tokens(1500), "1,5k")
        self.assertEqual(wt.fmt_tokens(46_107_776), "46,1M")
        self.assertEqual(wt.fmt_tokens(2_000_000_000), "2B")
        self.assertEqual(wt.fmt_rate({"generated": 65}, 10), "6,5 ток/с")
        self.assertEqual(wt.fmt_rate({"generated": 0}, 0), "—")


class StatsTests(Fixture):
    def test_daily_buckets_count_prompts_steps_tools_and_cost(self):
        day = date(2026, 11, 17)
        base = wt.local_midnight_ms(day)
        self.session(ROOT, title="day", created=base)
        self.user(ROOT, base + s(1))
        self.assistant(ROOT, base + s(2), base + s(5), cost=0.5,
                       tools=("edit", "read"))
        self.user(ROOT, base + s(10))
        self.assistant(ROOT, base + s(11), base + s(15), cost=0.25,
                       tools=("shell",))
        self.store()

        buckets, per_session = wt.stats(
            self.db, base, base + 86_400_000, now_ms=base + 86_400_000)
        self.assertEqual(len(buckets), 1)
        bucket = buckets[day]
        self.assertEqual(bucket["sessions"], 1)
        self.assertEqual(bucket["prompts"], 2)
        self.assertEqual(bucket["steps"], 2)
        self.assertEqual(bucket["tools"], 3)
        self.assertEqual(bucket["edits"], 1)
        self.assertEqual(bucket["seconds"], 7)
        self.assertEqual(bucket["cost"], 0.75)
        self.assertIn(ROOT, per_session)

    def test_step_crossing_midnight_is_split(self):
        first = date(2026, 11, 16)
        start = wt.local_midnight_ms(first) + 86_400_000 - s(300)  # 23:55
        self.session(ROOT, created=start)
        self.assistant(ROOT, start, start + s(600))  # 10 minutes, 5 each side
        self.store()
        buckets, _ = wt.stats(
            self.db, wt.local_midnight_ms(first),
            wt.local_midnight_ms(first + timedelta(days=2)),
            now_ms=start + s(700))
        self.assertEqual(buckets[first]["seconds"], 300)
        self.assertEqual(buckets[first + timedelta(days=1)]["seconds"], 300)

    def test_project_filter(self):
        day = date(2026, 11, 17)
        base = wt.local_midnight_ms(day)
        self.db.execute("insert into project values (?,?)", ("p1", "/one"))
        self.db.execute("insert into project values (?,?)", ("p2", "/two"))
        self.session("ses_one", created=base, project="p1")
        self.session("ses_two", created=base, project="p2")
        self.user("ses_one", base + s(1))
        self.user("ses_two", base + s(2))
        self.store()
        buckets, _ = wt.stats(
            self.db, base, base + 86_400_000, project_id="p1",
            now_ms=base + 86_400_000)
        self.assertEqual(buckets[day]["prompts"], 1)
        self.assertEqual(buckets[day]["sessions"], 1)


if __name__ == "__main__":
    unittest.main()
