#!/usr/bin/env python3
"""Real agent work time from OpenCode's local SQLite database.

The unit of work is an assistant step: `time.created` -> `time.completed` in
`session_message`. Steps run back to back inside a turn, so the union of their
intervals is the time the agent was actually busy: no idle gaps between turns,
and parallel subagents are not counted twice.

Sessions migrated from the V1 store keep their original timestamps only in the
old `message` table; their V2 `completed` values were written at migration
time. For those sessions the old table is used instead.
"""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path

MAX_STEP_MS = 30 * 60 * 1000      # longer steps are migration artifacts
LIVE_WINDOW_MS = 15 * 60 * 1000   # an unfinished step this fresh is still running
EDIT_TOOLS = {"edit", "write", "patch", "multiedit", "apply_patch"}

MONTHS_GEN = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
]


# ------------------------------------------------------------------ окружение

def data_dir() -> Path:
    base = os.environ.get("XDG_DATA_HOME")
    root = Path(base) if base else Path.home() / ".local" / "share"
    return root / "opencode"


def db_path() -> Path:
    return data_dir() / "opencode.db"


def connect(path: Path | None = None) -> sqlite3.Connection:
    path = path or db_path()
    if not path.exists():
        raise FileNotFoundError(f"база OpenCode не найдена: {path}")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def tables(conn: sqlite3.Connection) -> set[str]:
    return {
        row[0]
        for row in conn.execute("select name from sqlite_master where type='table'")
    }


def require_schema(conn: sqlite3.Connection) -> None:
    missing = {"session_v2", "session_message"} - tables(conn)
    if missing:
        raise RuntimeError(
            "база не похожа на OpenCode V2; нет таблиц: " + ", ".join(sorted(missing))
        )


# ------------------------------------------------------------------ форматирование

def local_midnight_ms(day: date) -> int:
    return int(datetime(day.year, day.month, day.day).timestamp() * 1000)


def day_of(ms: int) -> date:
    return datetime.fromtimestamp(ms / 1000).date()


def fmt_dur(seconds: float) -> str:
    s = int(round(seconds))
    if s < 60:
        return f"{s}с"
    m, s = divmod(s, 60)
    if m < 60:
        return f"{m}м {s:02d}с"
    h, m = divmod(m, 60)
    return f"{h}ч {m:02d}м"


def fmt_dur_short(seconds: float) -> str:
    s = int(round(seconds))
    if s < 60:
        return f"{s}с"
    m = s // 60
    if m < 60:
        return f"{m}м"
    return f"{m // 60}ч{m % 60:02d}"


def fmt_money(x: float) -> str:
    if x >= 10:
        return f"${x:.2f}"
    if x >= 1:
        return f"${x:.3f}"
    return f"${x:.4f}"


def fmt_tokens(count: float) -> str:
    """Компактно, с усечением: 999 999 -> 999,9k, а не 1M."""
    count = int(count)
    for threshold, suffix in ((1_000_000_000, "B"), (1_000_000, "M"),
                              (1_000, "k")):
        if count >= threshold:
            scaled = count / threshold
            # Для больших миллионов/миллиардов десятая доля только удлиняет
            # строку; километровые значения оставляем с одним знаком.
            digits = 0 if threshold >= 1_000_000 and scaled >= 100 else 1
            factor = 10 ** digits
            value = int(scaled * factor) / factor
            text = f"{value:.{digits}f}"
            if digits:
                text = text.rstrip("0").rstrip(".")
            return text.replace(".", ",") + suffix
    return str(count)


def fmt_rate(tokens: dict, seconds: float) -> str:
    if seconds <= 0:
        return "—"
    rate = tokens["generated"] / seconds
    return f"{rate:.1f}".replace(".", ",") + " ток/с"


def fmt_range(start: date, end: date, first_ever: date | None = None) -> str:
    today = date.today()
    if start == today and end == today:
        return f"сегодня, {today.day} {MONTHS_GEN[today.month - 1]} {today.year}"
    if first_ever:
        return (f"за всё время · с {first_ever.day} "
                f"{MONTHS_GEN[first_ever.month - 1]} {first_ever.year}")
    if start.year == end.year and start.month == end.month:
        return f"{start.day}–{end.day} {MONTHS_GEN[end.month - 1]} {end.year}"
    if start.year == end.year:
        return (f"{start.day} {MONTHS_GEN[start.month - 1]} – "
                f"{end.day} {MONTHS_GEN[end.month - 1]} {end.year}")
    return (f"{start.day} {MONTHS_GEN[start.month - 1]} {start.year} – "
            f"{end.day} {MONTHS_GEN[end.month - 1]} {end.year}")


# ------------------------------------------------------------------ проект

def resolve_project(conn: sqlite3.Connection, spec: str) -> tuple[str, str]:
    """Найти проект OpenCode по пути: '.' — текущий каталог, иначе путь."""
    target = os.path.realpath(os.getcwd() if spec == "." else os.path.expanduser(spec))
    rows = conn.execute(
        "select id, worktree from project where worktree is not null and worktree != ''"
    ).fetchall()
    best = None
    for row in rows:
        worktree = os.path.realpath(row["worktree"])
        if target == worktree or target.startswith(worktree.rstrip(os.sep) + os.sep):
            if best is None or len(worktree) > len(best[1]):
                best = (row["id"], worktree)
    if best is None:
        known = "\n".join(f"  {row['worktree']}" for row in sorted(rows, key=lambda r: r["worktree"]))
        raise ValueError(f"проект для «{spec}» не найден.\nИзвестные проекты:\n{known}")
    return best


# ------------------------------------------------------------------ сессии

def load_sessions(conn: sqlite3.Connection, project_id: str | None = None) -> dict[str, dict]:
    sql = ("select id, parent_id, project_id, title, time_created, time_updated, "
           "cost, tokens_input, tokens_output, tokens_reasoning "
           "from session_v2")
    params: tuple = ()
    if project_id:
        sql += " where project_id = ?"
        params = (project_id,)
    sessions = {}
    for row in conn.execute(sql, params):
        sessions[row["id"]] = dict(row)
    return sessions


def family_roots(sessions: dict[str, dict]) -> dict[str, str]:
    """session id -> root session id (subagents roll up into their parent)."""
    roots: dict[str, str] = {}

    def root_of(session_id: str) -> str:
        if session_id in roots:
            return roots[session_id]
        seen = []
        current = session_id
        while True:
            parent = sessions.get(current, {}).get("parent_id")
            if not parent or parent not in sessions or parent in seen:
                break
            seen.append(current)
            current = parent
        for item in seen + [current]:
            roots[item] = current
        return current

    for session_id in sessions:
        root_of(session_id)
    return roots


def v1_session_ids(conn: sqlite3.Connection) -> set[str]:
    if {"message"} - tables(conn):
        return set()
    return {row[0] for row in conn.execute("select distinct session_id from message")}


def session_intervals(
    conn: sqlite3.Connection,
    session_id: str,
    v1_ids: set[str],
    start_ms: int | None = None,
    end_ms: int | None = None,
    now_ms: int | None = None,
) -> tuple[list[tuple[int, int]], list[int]]:
    """Интервалы работы агента в одной сессии: (готовые, незавершённые старты)."""
    now_ms = now_ms if now_ms is not None else int(datetime.now().timestamp() * 1000)
    intervals: list[tuple[int, int]] = []
    ongoing: list[int] = []

    if session_id in v1_ids:
        sql = ("select time_created, json_extract(data,'$.time.created') created, "
               "json_extract(data,'$.time.completed') completed "
               "from message where session_id = ? "
               "and json_extract(data,'$.role') = 'assistant'")
        params: list = [session_id]
        if start_ms is not None:
            sql += " and time_created >= ?"
            params.append(start_ms)
        if end_ms is not None:
            sql += " and time_created < ?"
            params.append(end_ms)
        rows = conn.execute(sql, params)
    else:
        sql = ("select time_created, json_extract(data,'$.time.created') created, "
               "json_extract(data,'$.time.completed') completed "
               "from session_message where session_id = ? and type = 'assistant'")
        params = [session_id]
        if start_ms is not None:
            sql += " and time_created >= ?"
            params.append(start_ms)
        if end_ms is not None:
            sql += " and time_created < ?"
            params.append(end_ms)
        rows = conn.execute(sql, params)

    for row in rows:
        created = row["created"] or row["time_created"]
        completed = row["completed"]
        if not isinstance(created, (int, float)) or created <= 0:
            continue
        if completed is None:
            if now_ms - created <= LIVE_WINDOW_MS:
                ongoing.append(int(created))
                intervals.append((int(created), int(now_ms)))
            continue
        if not isinstance(completed, (int, float)):
            continue
        duration = completed - created
        if duration <= 0 or duration > MAX_STEP_MS:
            continue
        intervals.append((int(created), int(completed)))
    return intervals, ongoing


def merged_seconds(intervals: list[tuple[int, int]], since_ms: int = 0) -> float:
    """Длина объединения интервалов; перекрытия не считаются дважды."""
    total = 0
    end = 0
    for start, stop in sorted(intervals):
        start = max(start, since_ms, end)
        if stop > start:
            total += stop - start
            end = stop
    return total / 1000.0


def split_by_day(
    intervals: list[tuple[int, int]], start_ms: int, end_ms: int
) -> dict[date, float]:
    """Разбить интервалы по локальным суткам внутри диапазона."""
    result: dict[date, float] = {}
    for start, stop in intervals:
        start = max(start, start_ms)
        stop = min(stop, end_ms)
        while start < stop:
            day = day_of(start)
            next_midnight = local_midnight_ms(day + timedelta(days=1))
            chunk_end = min(stop, next_midnight)
            result[day] = result.get(day, 0.0) + (chunk_end - start) / 1000.0
            start = chunk_end
    return result


# ------------------------------------------------------------------ одна сессия

TOKEN_FIELDS = ("input", "cache_read", "cache_write", "output", "reasoning")


def empty_tokens() -> dict:
    tokens = {field: 0 for field in TOKEN_FIELDS}
    tokens["total"] = 0
    tokens["generated"] = 0
    return tokens


def session_tokens(conn: sqlite3.Connection, session_ids: list[str]) -> dict:
    """Токены всех шагов семейства: вход, кэш, выход и рассуждения."""
    if not session_ids:
        return empty_tokens()
    marks = ",".join("?" for _ in session_ids)
    row = conn.execute(
        f"""select
              coalesce(sum(json_extract(data,'$.tokens.input')), 0),
              coalesce(sum(json_extract(data,'$.tokens.cache.read')), 0),
              coalesce(sum(json_extract(data,'$.tokens.cache.write')), 0),
              coalesce(sum(json_extract(data,'$.tokens.output')), 0),
              coalesce(sum(json_extract(data,'$.tokens.reasoning')), 0)
            from session_message
            where type = 'assistant'
              and session_id in ({marks})""",
        session_ids,
    ).fetchone()
    tokens = dict(zip(TOKEN_FIELDS, (value or 0 for value in row)))
    tokens["total"] = sum(tokens[field] for field in TOKEN_FIELDS)
    tokens["generated"] = tokens["output"] + tokens["reasoning"]
    return tokens


def session_work_time(
    conn: sqlite3.Connection,
    session_id: str,
    now_ms: int | None = None,
) -> dict | None:
    """Работа по корню сессии и всем её субагентам."""
    require_schema(conn)
    now_ms = now_ms if now_ms is not None else int(datetime.now().timestamp() * 1000)
    sessions = load_sessions(conn)
    if session_id not in sessions:
        matches = [sid for sid in sessions if sid.startswith(session_id)]
        if len(matches) != 1:
            return None
        session_id = matches[0]

    roots = family_roots(sessions)
    root = roots[session_id]
    members = [sid for sid, owner in roots.items() if owner == root]

    v1_ids = v1_session_ids(conn)
    intervals: list[tuple[int, int]] = []
    ongoing: list[int] = []
    for member in members:
        found, running = session_intervals(conn, member, v1_ids, now_ms=now_ms)
        intervals.extend(found)
        ongoing.extend(running)

    last_user = conn.execute(
        "select max(time_created) from session_message "
        f"where session_id in ({','.join('?' for _ in members)}) and type = 'user'",
        members,
    ).fetchone()[0]
    current = None
    if ongoing:
        started = last_user if last_user else min(ongoing)
        current = max(0.0, (now_ms - started) / 1000.0)

    steps = conn.execute(
        "select count(*) from session_message "
        f"where session_id in ({','.join('?' for _ in members)}) and type = 'assistant'",
        members,
    ).fetchone()[0]
    tools = conn.execute(
        "select count(*) from session_message sm "
        "join json_each(json_extract(sm.data,'$.content')) c "
        f"where sm.session_id in ({','.join('?' for _ in members)}) "
        "and sm.type = 'assistant' and json_extract(c.value,'$.type') = 'tool'",
        members,
    ).fetchone()[0]

    session_members = [sessions[member] for member in members]
    seconds = merged_seconds(intervals)
    tokens = session_tokens(conn, members)
    return {
        "session_id": root,
        "title": sessions[root]["title"],
        "total_seconds": seconds,
        "current_seconds": current,
        "live": bool(ongoing),
        "last_user_at": last_user,
        "steps": steps,
        "tools": tools,
        "subagents": len(members) - 1,
        "cost": sum(s["cost"] or 0 for s in session_members),
        "tokens": tokens,
        "tokens_per_second": (
            tokens["generated"] / seconds if seconds > 0 else None
        ),
        "sessions": members,
    }


def time_label(value: dict | None) -> str:
    if value is None:
        return "Работа: история недоступна"
    parts = ["Работа: " + fmt_dur(value["total_seconds"])]
    if value["live"] and value["current_seconds"] is not None:
        parts.append("ход: " + fmt_dur(value["current_seconds"]))
    else:
        parts.append("ход: пауза")
    return " · ".join(parts)


# ------------------------------------------------------------------ статистика

def empty_bucket() -> dict:
    return {
        "sessions": 0, "subagents": 0, "prompts": 0, "steps": 0,
        "tools": 0, "edits": 0, "seconds": 0.0, "cost": 0.0,
    }


def add(bucket: dict, **values) -> None:
    for key, value in values.items():
        bucket[key] += value


def stats(
    conn: sqlite3.Connection,
    start_ms: int,
    end_ms: int,
    project_id: str | None = None,
    now_ms: int | None = None,
) -> tuple[dict[date, dict], dict[str, dict]]:
    """Счётчики по дням и агрегаты по корневым сессиям."""
    require_schema(conn)
    now_ms = now_ms if now_ms is not None else int(datetime.now().timestamp() * 1000)
    sessions = load_sessions(conn, project_id)
    roots = family_roots(sessions)
    v1_ids = v1_session_ids(conn)

    buckets: dict[date, dict] = {}

    def bucket(day: date) -> dict:
        return buckets.setdefault(day, empty_bucket())

    # сессии
    project_filter = " and project_id = ?" if project_id else ""
    params = (start_ms, end_ms) + ((project_id,) if project_id else ())
    for row in conn.execute(
        f"""select date(time_created/1000,'unixepoch','localtime') d,
                   count(*) filter (where parent_id is null),
                   count(*) filter (where parent_id is not null)
            from session_v2
            where time_created >= ? and time_created < ?{project_filter}
            group by d""",
        params,
    ):
        add(bucket(date.fromisoformat(row[0])), sessions=row[1], subagents=row[2])

    # промпты и шаги
    join_project = " join session_v2 s on s.id = sm.session_id" if project_id else ""
    params = (start_ms, end_ms) + ((project_id,) if project_id else ())
    where_project = " and s.project_id = ?" if project_id else ""
    for row in conn.execute(
        f"""select date(sm.time_created/1000,'unixepoch','localtime') d,
                   sm.type, count(*)
            from session_message sm{join_project}
            where sm.time_created >= ? and sm.time_created < ?
              and sm.type in ('user','assistant'){where_project}
            group by d, sm.type""",
        params,
    ):
        if row[1] == "user":
            add(bucket(date.fromisoformat(row[0])), prompts=row[2])
        else:
            add(bucket(date.fromisoformat(row[0])), steps=row[2])

    # инструменты
    for row in conn.execute(
        f"""select date(sm.time_created/1000,'unixepoch','localtime') d,
                   json_extract(c.value,'$.name'), count(*)
            from session_message sm{join_project}
            join json_each(json_extract(sm.data,'$.content')) c
            where sm.time_created >= ? and sm.time_created < ?
              and sm.type = 'assistant'
              and json_extract(c.value,'$.type') = 'tool'{where_project}
            group by d, 2""",
        params,
    ):
        target = bucket(date.fromisoformat(row[0]))
        add(target, tools=row[2])
        if row[1] in EDIT_TOOLS:
            add(target, edits=row[2])

    # стоимость
    for row in conn.execute(
        f"""select date(sm.time_created/1000,'unixepoch','localtime') d,
                   coalesce(sum(json_extract(sm.data,'$.cost')), 0)
            from session_message sm{join_project}
            where sm.time_created >= ? and sm.time_created < ?
              and sm.type = 'assistant'{where_project}
            group by d""",
        params,
    ):
        add(bucket(date.fromisoformat(row[0])), cost=row[1] or 0)

    # работа: интервалы по семействам сессий
    family_intervals: dict[str, list[tuple[int, int]]] = {}
    family_members: dict[str, list[str]] = {}
    for session_id, session in sessions.items():
        family_intervals.setdefault(roots[session_id], []).extend(
            session_intervals(conn, session_id, v1_ids, start_ms, end_ms, now_ms)[0]
        )
        family_members.setdefault(roots[session_id], []).append(session_id)

    for root_id, intervals in family_intervals.items():
        merged = [(start, stop) for start, stop in intervals]
        # объединяем внутри семейства, затем режем по суткам
        merged.sort()
        union: list[tuple[int, int]] = []
        for start, stop in merged:
            if union and start <= union[-1][1]:
                union[-1] = (union[-1][0], max(union[-1][1], stop))
            else:
                union.append((start, stop))
        for day, seconds in split_by_day(union, start_ms, end_ms).items():
            add(bucket(day), seconds=seconds)

    # агрегаты по корневым сессиям для --sessions
    per_session: dict[str, dict] = {}
    for session_id, session in sessions.items():
        if roots[session_id] != session_id:
            continue
        members = family_members.get(session_id, [session_id])
        relevant = family_intervals.get(session_id, [])
        if not relevant and not any(
            start_ms <= sessions[m]["time_created"] < end_ms for m in members
        ):
            continue
        steps = conn.execute(
            "select count(*) from session_message "
            f"where session_id in ({','.join('?' for _ in members)}) "
            "and type = 'assistant' and time_created >= ? and time_created < ?",
            members + [start_ms, end_ms],
        ).fetchone()[0]
        tools = conn.execute(
            "select count(*) from session_message sm "
            "join json_each(json_extract(sm.data,'$.content')) c "
            f"where sm.session_id in ({','.join('?' for _ in members)}) "
            "and sm.type = 'assistant' and json_extract(c.value,'$.type') = 'tool' "
            "and sm.time_created >= ? and sm.time_created < ?",
            members + [start_ms, end_ms],
        ).fetchone()[0]
        per_session[session_id] = {
            "id": session_id,
            "title": session["title"],
            "created": session["time_created"],
            "steps": steps,
            "tools": tools,
            "seconds": merged_seconds(family_intervals.get(session_id, [])),
            "subagents": len(members) - 1,
        }
    return buckets, per_session


def stats_totals(buckets: dict[date, dict]) -> dict:
    total = empty_bucket()
    for bucket in buckets.values():
        for key in total:
            total[key] += bucket[key]
    return total


def first_session_date(conn: sqlite3.Connection) -> date | None:
    row = conn.execute("select min(time_created) from session_v2").fetchone()
    return day_of(row[0]) if row and row[0] else None


def latest_session(conn: sqlite3.Connection, project_id: str | None = None) -> dict | None:
    sql = ("select id, title from session_v2 where time_archived is null "
           "and parent_id is null")
    params: tuple = ()
    if project_id:
        sql += " and project_id = ?"
        params = (project_id,)
    sql += " order by time_updated desc limit 1"
    row = conn.execute(sql, params).fetchone()
    return dict(row) if row else None


def dump(value) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)
