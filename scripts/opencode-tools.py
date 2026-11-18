#!/usr/bin/env python3
"""opencode-tools — личные инструменты для OpenCode.

Пока одна команда: реальное время работы агента.
"""
from __future__ import annotations

import argparse
import sys
import time as clock
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import balance as bl  # noqa: E402
import worktime as wt  # noqa: E402

VERSION = "0.2.0"


def print_time(value: dict, label: str = "работа агента") -> None:
    print(f"OpenCode · {label}")
    print()
    print(f"  сессия          {value['title']}")
    print(f"  id              {value['session_id']}")
    print(f"  работа          {wt.fmt_dur(value['total_seconds'])}")
    if value["live"] and value["current_seconds"] is not None:
        print(f"  ход             идёт · {wt.fmt_dur(value['current_seconds'])}")
    else:
        print("  ход             пауза")
    print(f"  шагов           {value['steps']}")
    print(f"  инструментов    {value['tools']}")
    if value["subagents"]:
        print(f"  субагентов      {value['subagents']}")
    print(f"  стоимость       {wt.fmt_money(value['cost'])}")
    print()


def print_summary(total: dict, label: str, project_name: str | None) -> None:
    suffix = f" · {project_name}" if project_name else ""
    print(f"OpenCode · {label}{suffix}")
    print()
    print(f"  заходов          {total['sessions']:>6}")
    if total["subagents"]:
        print(f"    субагентов     {total['subagents']:>6}")
    print(f"  промптов         {total['prompts']:>6}")
    print(f"  шагов агента     {total['steps']:>6}")
    print(f"  время работы     {wt.fmt_dur(total['seconds']):>6}")
    print(f"  инструментов     {total['tools']:>6}")
    print(f"    правок файлов  {total['edits']:>6}")
    print(f"  стоимость        {wt.fmt_money(total['cost']):>6}")
    print()


def print_daily(buckets: dict[date, dict], start: date, end: date,
                monthly: bool) -> None:
    keys: list[str] = []
    day = start
    while day <= end:
        key = f"{day.year}-{day.month:02d}" if monthly else day.isoformat()
        if key not in keys:
            keys.append(key)
        day += timedelta(days=1)

    header = (f"{'день':<12}{'заходы':>7}{'промпты':>9}{'шаги':>7}"
              f"{'время':>9}{'инстр.':>9}{'$':>9}")
    print(header)
    print("─" * len(header))

    totals = wt.empty_bucket()
    for key in keys:
        if monthly:
            year, month = key.split("-")
            current = date(int(year), int(month), 1)
            name = f"{wt.MONTHS_GEN[current.month - 1][:3]} {year}"
            bucket = wt.empty_bucket()
            for day_key, day_bucket in buckets.items():
                if f"{day_key.year}-{day_key.month:02d}" == key:
                    for field in bucket:
                        bucket[field] += day_bucket[field]
        else:
            current = date.fromisoformat(key)
            name = f"{current.day:02d}.{current.month:02d}"
            bucket = buckets.get(current, wt.empty_bucket())
        for field in totals:
            totals[field] += bucket[field]
        if not bucket["sessions"] and not bucket["steps"]:
            continue
        print(f"{name:<12}{bucket['sessions']:>7}{bucket['prompts']:>9}"
              f"{bucket['steps']:>7}{wt.fmt_dur_short(bucket['seconds']):>9}"
              f"{bucket['tools']:>9}{bucket['cost']:>9.3f}")

    print("─" * len(header))
    print(f"{'итого':<12}{totals['sessions']:>7}{totals['prompts']:>9}"
          f"{totals['steps']:>7}{wt.fmt_dur_short(totals['seconds']):>9}"
          f"{totals['tools']:>9}{totals['cost']:>9.3f}")
    print()


def print_sessions(per_session: dict[str, dict], limit: int) -> None:
    if not per_session:
        return
    rows = sorted(per_session.values(), key=lambda r: r["created"], reverse=True)[:limit]
    print("сессии")
    print(f"{'начало':<12}{'шаги':>6}{'время':>8}{'инстр.':>8}  название")
    print("─" * 78)
    for row in rows:
        from datetime import datetime
        when = datetime.fromtimestamp(row["created"] / 1000).strftime("%d.%m %H:%M")
        title = row["title"][:44]
        print(f"{when:<12}{row['steps']:>6}{wt.fmt_dur_short(row['seconds']):>9}"
              f"{row['tools']:>8}  {title}")
    print()


def cmd_time(args) -> int:
    conn = wt.connect()
    project_id = None
    if args.project:
        project_id, _ = wt.resolve_project(conn, args.project)

    session_id = args.session
    if not session_id:
        latest = wt.latest_session(conn, project_id)
        if not latest:
            print("opencode-tools: нет сессий", file=sys.stderr)
            return 1
        session_id = latest["id"]

    value = wt.session_work_time(conn, session_id)
    if value is None:
        print(f"opencode-tools: сессия не найдена: {session_id}", file=sys.stderr)
        return 1

    if args.json:
        print(wt.dump(value))
    else:
        print_time(value)
    return 0


def cmd_watch(args) -> int:
    conn = wt.connect()
    project_id = None
    if args.project:
        project_id, _ = wt.resolve_project(conn, args.project)

    session_id = args.session
    if not session_id:
        latest = wt.latest_session(conn, project_id)
        if not latest:
            print("opencode-tools: нет сессий", file=sys.stderr)
            return 1
        session_id = latest["id"]

    try:
        while True:
            value = wt.session_work_time(conn, session_id)
            if value is None:
                print(f"\ropencode-tools: сессия не найдена: {session_id}", file=sys.stderr)
                return 1
            print("\r\033[2K" + wt.time_label(value), end="", flush=True)
            clock.sleep(args.interval)
    except KeyboardInterrupt:
        print()
        return 0


def cmd_balance(args) -> int:
    auth = bl.read_auth()
    values = bl.fetch_balances(auth, args.provider, args.timeout)
    if args.json:
        print(wt.dump({"providers": values}))
    else:
        bl.print_balance(values)
    return 0


def cmd_stats(args) -> int:
    conn = wt.connect()
    today = date.today()
    project_id = None
    project_name = None
    if args.project:
        project_id, worktree = wt.resolve_project(conn, args.project)
        project_name = Path(worktree).name

    first_ever = None
    if args.all:
        first_ever = wt.first_session_date(conn)
        if first_ever is None:
            print("opencode-tools: в базе нет сессий", file=sys.stderr)
            return 1
        start = first_ever
    else:
        days = args.days if args.days and args.days > 0 else 1
        start = today - timedelta(days=days - 1)

    end = today
    start_ms = wt.local_midnight_ms(start)
    end_ms = wt.local_midnight_ms(end + timedelta(days=1))

    buckets, per_session = wt.stats(conn, start_ms, end_ms, project_id)
    total = wt.stats_totals(buckets)
    span_days = (end - start).days + 1

    if args.json:
        print(wt.dump({
            "range": {"from": start.isoformat(), "to": end.isoformat()},
            "total": total,
            "days": [
                {"date": day.isoformat(), **bucket}
                for day, bucket in sorted(buckets.items())
            ],
            "sessions": sorted(per_session.values(), key=lambda r: r["created"],
                               reverse=True),
        }))
        return 0

    print_summary(total, wt.fmt_range(start, end, first_ever), project_name)
    if span_days > 1:
        print_daily(buckets, start, end, monthly=span_days > 45)
    if args.sessions:
        print_sessions(per_session, args.limit)

    print("время работы = сумма длительностей шагов агента, без пауз между заходами")
    print("источник: " + str(wt.db_path()))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="opencode-tools",
        description="Личные инструменты для OpenCode.",
    )
    parser.add_argument("--version", action="version", version=VERSION)
    sub = parser.add_subparsers(dest="command")

    time_parser = sub.add_parser(
        "time", help="реальное время работы одной сессии (по умолчанию — последней)")
    time_parser.add_argument("--session", metavar="ID", help="id или начало id сессии")
    time_parser.add_argument("--project", metavar="PATH", help="проект: путь или '.'")
    time_parser.add_argument("--json", action="store_true")
    time_parser.set_defaults(func=cmd_time)

    watch_parser = sub.add_parser(
        "watch", help="живая строка с текущей работой сессии")
    watch_parser.add_argument("--session", metavar="ID", help="id или начало id сессии")
    watch_parser.add_argument("--project", metavar="PATH", help="проект: путь или '.'")
    watch_parser.add_argument("--interval", type=float, default=1.0,
                              help="обновление в секундах (по умолчанию 1)")
    watch_parser.set_defaults(func=cmd_watch)

    balance_parser = sub.add_parser(
        "balance", help="остаток на балансе провайдера")
    balance_parser.add_argument("--provider", metavar="ID",
                                help="провайдер (по умолчанию: все подключённые)")
    balance_parser.add_argument("--timeout", type=float, default=bl.DEFAULT_TIMEOUT,
                                help="таймаут запроса в секундах (по умолчанию 10)")
    balance_parser.add_argument("--json", action="store_true")
    balance_parser.set_defaults(func=cmd_balance)

    stats_parser = sub.add_parser(
        "stats", help="заходы, промпты, шаги, время и стоимость за период")
    group = stats_parser.add_mutually_exclusive_group()
    group.add_argument("--days", type=int, help="последние N дней (по умолчанию: сегодня)")
    group.add_argument("--all", action="store_true", help="за всё время")
    stats_parser.add_argument("--project", metavar="PATH", help="проект: путь или '.'")
    stats_parser.add_argument("--sessions", action="store_true", help="разбивка по сессиям")
    stats_parser.add_argument("--limit", type=int, default=20, help="строк в разбивке")
    stats_parser.add_argument("--json", action="store_true")
    stats_parser.set_defaults(func=cmd_stats)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if not getattr(args, "func", None):
        parser.print_help()
        return 0
    try:
        return args.func(args)
    except (FileNotFoundError, RuntimeError, ValueError) as error:
        print(f"opencode-tools: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
