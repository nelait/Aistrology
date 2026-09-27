"""A small 5-field cron parser and evaluator with IANA time zones (used by the scheduler).

Fields: ``minute hour day-of-month month day-of-week``. Each field accepts ``*``, numbers, ranges
(``1-5``), lists (``1,15``), steps (``*/15``, ``10-50/10``) and, for month and day-of-week, English
names (``jan``, ``mon``). Day-of-week is 0-7 with 0 and 7 both Sunday. As in Vixie cron, when both
day-of-month and day-of-week are restricted a day matches if *either* matches.

Times are evaluated as wall-clock times in the schedule's time zone:

* a wall time skipped by a DST spring-forward gap does not run that day;
* a wall time repeated by a DST fall-back runs once (the first occurrence).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

MONTHS = {m: i + 1 for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split())}
DAYS = {d: i for i, d in enumerate("sun mon tue wed thu fri sat".split())}
MAX_YEARS = 5  # search horizon; a schedule that never fires within it (e.g. "0 0 30 2 *") is invalid


class CronError(ValueError):
    pass


def _value(token: str, lo: int, hi: int, names: dict[str, int] | None) -> int:
    token = token.strip().lower()
    if names and token in names:
        return names[token]
    if not token.isdigit():
        raise CronError(f"invalid value {token!r}")
    value = int(token)
    if not lo <= value <= hi:
        raise CronError(f"value {value} out of range {lo}-{hi}")
    return value


def _field(text: str, lo: int, hi: int, names: dict[str, int] | None = None) -> tuple[frozenset[int], bool]:
    """Parse one field → (allowed values, restricted?)."""
    if not text:
        raise CronError("empty field")
    values: set[int] = set()
    for part in text.split(","):
        step = 1
        if "/" in part:
            part, step_text = part.split("/", 1)
            if not step_text.isdigit() or int(step_text) < 1:
                raise CronError(f"invalid step {step_text!r}")
            step = int(step_text)
        if part == "*":
            start, end = lo, hi
        elif "-" in part:
            a, b = part.split("-", 1)
            start, end = _value(a, lo, hi, names), _value(b, lo, hi, names)
            if start > end:
                raise CronError(f"invalid range {part!r}")
        else:
            start = _value(part, lo, hi, names)
            end = hi if step > 1 else start
        values.update(range(start, end + 1, step))
    return frozenset(values), text != "*"


@dataclass(frozen=True)
class CronSchedule:
    expression: str
    timezone: str
    minutes: frozenset[int]
    hours: frozenset[int]
    days: frozenset[int]
    months: frozenset[int]
    weekdays: frozenset[int]  # 0 = Sunday
    days_restricted: bool
    weekdays_restricted: bool

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)

    def _day_matches(self, d: date) -> bool:
        if d.month not in self.months:
            return False
        dom = d.day in self.days
        dow = (d.isoweekday() % 7) in self.weekdays
        if self.days_restricted and self.weekdays_restricted:
            return dom or dow
        if self.days_restricted:
            return dom
        if self.weekdays_restricted:
            return dow
        return True

    def next_after(self, after: datetime) -> datetime:
        """The first run strictly after ``after`` (aware), returned in UTC."""
        if after.tzinfo is None:
            after = after.replace(tzinfo=UTC)
        tz = self.tz
        local = after.astimezone(tz)
        times = sorted((h, m) for h in self.hours for m in self.minutes)
        day = local.date()
        for _ in range(366 * MAX_YEARS + 1):
            if self._day_matches(day):
                for h, m in times:
                    candidate = datetime.combine(day, time(h, m), tzinfo=tz)  # fold=0: first occurrence
                    as_utc = candidate.astimezone(UTC)
                    if as_utc.astimezone(tz).replace(tzinfo=None) != candidate.replace(tzinfo=None):
                        continue  # skipped by a DST gap
                    if as_utc > after:
                        return as_utc
            day += timedelta(days=1)
        raise CronError("the schedule never fires")

    def upcoming(self, after: datetime, count: int = 5) -> list[datetime]:
        out: list[datetime] = []
        for _ in range(count):
            after = self.next_after(after)
            out.append(after)
        return out

    def min_interval_minutes(self) -> int:
        """Smallest gap between two runs, by wall-clock minute of day (conservative across midnight)."""
        slots = sorted(h * 60 + m for h in self.hours for m in self.minutes)
        gaps = [b - a for a, b in zip(slots, slots[1:])]
        gaps.append(1440 - slots[-1] + slots[0])  # last run of a day → first run of the next day
        return min(gaps)


def parse_cron(expression: str, timezone: str = "UTC") -> CronSchedule:
    parts = expression.split()
    if len(parts) != 5:
        raise CronError("cron expressions have 5 fields: minute hour day-of-month month day-of-week")
    try:
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise CronError(f"unknown time zone {timezone!r}") from exc
    minutes, _ = _field(parts[0], 0, 59)
    hours, _ = _field(parts[1], 0, 23)
    days, days_r = _field(parts[2], 1, 31)
    months, _ = _field(parts[3], 1, 12, MONTHS)
    weekdays, weekdays_r = _field(parts[4], 0, 7, DAYS)
    weekdays = frozenset(0 if d == 7 else d for d in weekdays)
    schedule = CronSchedule(" ".join(parts), timezone, minutes, hours, days, months, weekdays, days_r, weekdays_r)
    schedule.next_after(datetime(2000, 1, 1, tzinfo=UTC))  # rejects schedules that never fire (e.g. Feb 30)
    return schedule
