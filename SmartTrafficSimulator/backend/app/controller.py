from __future__ import annotations

import math
import time
from enum import Enum
from typing import Callable

from .schemas import CountdownMap, DirectionCountdown, DirectionStatsMap, SignalState


class GreenPhase(str, Enum):
    NS_LEFT = "NS_LEFT"
    NS_STRAIGHT_RIGHT = "NS_STRAIGHT_RIGHT"
    EW_LEFT = "EW_LEFT"
    EW_STRAIGHT_RIGHT = "EW_STRAIGHT_RIGHT"


class SubPhase(str, Enum):
    GREEN = "GREEN"
    YELLOW = "YELLOW"
    ALL_RED = "ALL_RED"


GREEN_PHASES = list(GreenPhase)
PHASE_DIRECTIONS: dict[GreenPhase, tuple[str, str]] = {
    GreenPhase.NS_LEFT: ("north", "south"),
    GreenPhase.NS_STRAIGHT_RIGHT: ("north", "south"),
    GreenPhase.EW_LEFT: ("east", "west"),
    GreenPhase.EW_STRAIGHT_RIGHT: ("east", "west"),
}
DEFAULT_NEXT: dict[GreenPhase, GreenPhase] = {
    GreenPhase.NS_LEFT: GreenPhase.NS_STRAIGHT_RIGHT,
    GreenPhase.NS_STRAIGHT_RIGHT: GreenPhase.EW_LEFT,
    GreenPhase.EW_LEFT: GreenPhase.EW_STRAIGHT_RIGHT,
    GreenPhase.EW_STRAIGHT_RIGHT: GreenPhase.NS_LEFT,
}

GREEN_MIN_SECONDS = 8
GREEN_MAX_SECONDS = 32
YELLOW_SECONDS = 3
ALL_RED_SECONDS = 1
MAX_ALL_RED_SECONDS = 3
COMMIT_SECONDS = 8
MAX_WAIT_SECONDS = 45
DOWNSTREAM_FULL = 0.85
STARVATION_BONUS = 1000
TELEMETRY_TIMEOUT_SECONDS = 2.0


class TrafficController:
    """Authoritative four-phase adaptive controller with safe transitions."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self.stats = DirectionStatsMap()
        self.phase = GreenPhase.NS_STRAIGHT_RIGHT
        self.sub_phase = SubPhase.ALL_RED
        self.planned_next = GreenPhase.NS_STRAIGHT_RIGHT
        self.phase_started_at = clock()
        self.phase_duration_seconds = ALL_RED_SECONDS
        self.manual = False
        self.emergency_hold = False
        self.preempt_target: GreenPhase | None = None
        self.box_occupied = False
        self.last_report_at: float | None = None
        self.last_sequence = -1
        self.revision = 0
        self.state = "FREE"
        self.reason = "Đang chờ dữ liệu giao thông từ mô phỏng."
        self.early_request = False
        self.recovery_cursor = 0

    def update_report(
        self,
        stats: DirectionStatsMap,
        box_occupied: bool,
        emergency_phase: GreenPhase | None,
        sequence: int,
        now: float | None = None,
    ) -> bool:
        if sequence <= self.last_sequence:
            return False
        self.last_sequence = sequence
        self.last_report_at = self._clock() if now is None else now
        self.stats = stats
        self.box_occupied = box_occupied
        self.preempt_target = emergency_phase
        self.state = self._classify_state()
        return True

    def telemetry_stale(self, now: float | None = None) -> bool:
        current = self._clock() if now is None else now
        return self.last_report_at is None or current - self.last_report_at > TELEMETRY_TIMEOUT_SECONDS

    def command(self, action: str) -> None:
        if action == "AUTO":
            self.manual = False
            self.emergency_hold = False
        elif action == "MANUAL":
            self.manual = True
        elif action == "NEXT":
            self.early_request = True
        elif action == "ALL_RED":
            self.emergency_hold = True
            self._enter(SubPhase.ALL_RED, MAX_ALL_RED_SECONDS)
        elif action == "CLEAR_ALL_RED":
            self.emergency_hold = False
        elif action == "RESET":
            self.manual = False
            self.emergency_hold = False
            self.preempt_target = None
            self.phase = GreenPhase.NS_STRAIGHT_RIGHT
            self.planned_next = GreenPhase.NS_STRAIGHT_RIGHT
            self._enter(SubPhase.ALL_RED, ALL_RED_SECONDS)
        self.revision += 1

    @property
    def elapsed(self) -> float:
        return max(0.0, self._clock() - self.phase_started_at)

    def _elapsed(self, now: float) -> float:
        return max(0.0, now - self.phase_started_at)

    def _remaining(self, now: float) -> float:
        return max(0.0, self.phase_duration_seconds - self._elapsed(now))

    def _committed(self, now: float) -> bool:
        return self.sub_phase is SubPhase.GREEN and self._remaining(now) <= COMMIT_SECONDS

    def _enter(self, sub_phase: SubPhase, duration: float, now: float | None = None) -> None:
        self.sub_phase = sub_phase
        self.phase_duration_seconds = duration
        self.phase_started_at = self._clock() if now is None else now

    @staticmethod
    def _movement_group(phase: GreenPhase) -> str:
        return "left" if phase in (GreenPhase.NS_LEFT, GreenPhase.EW_LEFT) else "through"

    def _movement_demand(self, phase: GreenPhase) -> float:
        group = self._movement_group(phase)
        total = 0.0
        for direction in PHASE_DIRECTIONS[phase]:
            movement = getattr(getattr(self.stats, direction), group)
            queue_term = movement.queue_pcu
            wait_term = max(0.0, movement.avg_waiting_time) ** 1.5 * 0.12
            arrival_term = movement.arrival_rate * 1.5
            penalty = 0.15 if movement.downstream_occupancy >= DOWNSTREAM_FULL else 1.0
            total += (queue_term + wait_term + arrival_term) * penalty
            if movement.max_waiting_time >= MAX_WAIT_SECONDS:
                total += STARVATION_BONUS
        return total

    def _phase_clear(self, phase: GreenPhase) -> bool:
        group = self._movement_group(phase)
        return any(
            getattr(getattr(self.stats, direction), group).downstream_occupancy < DOWNSTREAM_FULL
            for direction in PHASE_DIRECTIONS[phase]
        )

    def _most_starved(self, current: GreenPhase) -> GreenPhase | None:
        worst = MAX_WAIT_SECONDS
        chosen: GreenPhase | None = None
        for phase in GREEN_PHASES:
            if phase is current:
                continue
            group = self._movement_group(phase)
            for direction in PHASE_DIRECTIONS[phase]:
                wait = getattr(getattr(self.stats, direction), group).max_waiting_time
                if wait > worst:
                    worst = wait
                    chosen = phase
        return chosen

    def _escape_phase(self, current: GreenPhase) -> GreenPhase:
        candidates = [phase for phase in GREEN_PHASES if phase is not current]
        start = self.recovery_cursor % len(candidates)
        ordered = candidates[start:] + candidates[:start]

        def occupancy(phase: GreenPhase) -> float:
            group = self._movement_group(phase)
            return sum(
                getattr(getattr(self.stats, direction), group).downstream_occupancy
                for direction in PHASE_DIRECTIONS[phase]
            )

        chosen = min(ordered, key=occupancy)
        self.recovery_cursor += 1
        return chosen

    def choose_next(self, current: GreenPhase) -> GreenPhase:
        if self.preempt_target is not None:
            self.reason = f"Ưu tiên xe khẩn cấp cho pha {self.preempt_target.value}."
            return self.preempt_target
        starved = self._most_starved(current)
        if starved is not None:
            self.reason = f"Chống bỏ đói: chuyển sang {starved.value} vì đã chờ quá {MAX_WAIT_SECONDS} giây."
            return starved
        if self.state == "GRIDLOCK":
            chosen = self._escape_phase(current)
            self.reason = f"Phục hồi kẹt cứng: mở pha thoát {chosen.value}."
            return chosen

        chosen = current
        best_score = -math.inf
        for phase in GREEN_PHASES:
            score = self._movement_demand(phase)
            if phase is current:
                score -= 1.5  # chống mở lại pha vừa kết thúc nếu chênh lệch rất nhỏ
            if not self._phase_clear(phase):
                score -= 100
            if score > best_score:
                best_score = score
                chosen = phase
        self.reason = f"Ưu tiên {chosen.value} theo áp lực hàng chờ và sức chứa đường ra."
        return chosen

    def green_duration(self, phase: GreenPhase) -> int:
        return max(GREEN_MIN_SECONDS, min(GREEN_MAX_SECONDS, GREEN_MIN_SECONDS + round(self._movement_demand(phase) * 1.35)))

    def _classify_state(self) -> str:
        directions = [self.stats.north, self.stats.south, self.stats.east, self.stats.west]
        total_queue = sum(d.queue_pcu for d in directions)
        total = sum(d.total for d in directions)
        waiting = sum(d.waiting for d in directions)
        departures = sum(d.departure_rate for d in directions)
        movers = [d.median_speed for d in directions if d.total > 0]
        avg_speed = sum(movers) / len(movers) if movers else math.inf
        if total_queue > 10 and avg_speed < 0.35 and departures < 0.3:
            return "GRIDLOCK"
        if total_queue > 7 and avg_speed < 1.4:
            return "CONGESTED"
        if total > 6 or waiting > 3:
            return "BUSY"
        return "FREE"

    def tick(self, now: float | None = None) -> bool:
        current = self._clock() if now is None else now
        changed = False

        if self.telemetry_stale(current):
            if self.sub_phase is not SubPhase.ALL_RED or self.reason != "Mất dữ liệu giao thông: giữ toàn đỏ an toàn.":
                self._enter(SubPhase.ALL_RED, MAX_ALL_RED_SECONDS, current)
                self.reason = "Mất dữ liệu giao thông: giữ toàn đỏ an toàn."
                self.revision += 1
                return True
            return False

        if self.emergency_hold:
            if self.sub_phase is not SubPhase.ALL_RED:
                self._enter(SubPhase.ALL_RED, MAX_ALL_RED_SECONDS, current)
                changed = True
            return changed

        elapsed = self._elapsed(current)
        remaining = self._remaining(current)
        if self._committed(current):
            self.planned_next = self.choose_next(self.phase)

        if self.sub_phase is SubPhase.GREEN:
            min_satisfied = elapsed >= GREEN_MIN_SECONDS
            starved = self._most_starved(self.phase)
            switch_for_preempt = self.preempt_target is not None and self.phase is not self.preempt_target and min_satisfied
            hold_for_preempt = self.preempt_target is self.phase
            should_end = not hold_for_preempt and (
                switch_for_preempt
                or (starved is not None and min_satisfied)
                or (self.early_request and min_satisfied)
                or (not self.manual and remaining <= 0)
            )
            if should_end:
                self.early_request = False
                self.planned_next = self.choose_next(self.phase)
                self._enter(SubPhase.YELLOW, YELLOW_SECONDS, current)
                changed = True
        elif self.sub_phase is SubPhase.YELLOW and remaining <= 0:
            self._enter(SubPhase.ALL_RED, ALL_RED_SECONDS, current)
            changed = True
        elif self.sub_phase is SubPhase.ALL_RED:
            if remaining <= 0 and (not self.box_occupied or elapsed >= MAX_ALL_RED_SECONDS):
                self.phase = self.choose_next(self.phase)
                self.planned_next = DEFAULT_NEXT[self.phase]
                duration = GREEN_MAX_SECONDS if self.preempt_target is self.phase else self.green_duration(self.phase)
                self._enter(SubPhase.GREEN, duration, current)
                changed = True

        if changed:
            self.revision += 1
        return changed

    def _signals(self) -> dict[str, str]:
        result = {"north": "RED", "south": "RED", "east": "RED", "west": "RED"}
        if self.sub_phase is SubPhase.ALL_RED:
            return result
        color = "GREEN" if self.sub_phase is SubPhase.GREEN else "YELLOW"
        for direction in PHASE_DIRECTIONS[self.phase]:
            result[direction] = color
        return result

    def _countdowns(self, now: float) -> CountdownMap:
        signals = self._signals()
        remaining = self._remaining(now)
        reveal_next = self._committed(now)
        next_directions = PHASE_DIRECTIONS[self.planned_next]

        def countdown(direction: str) -> DirectionCountdown:
            color = signals[direction]
            if color != "RED":
                return DirectionCountdown(seconds=remaining, visible=True, color=color)
            if reveal_next and direction in next_directions:
                return DirectionCountdown(
                    seconds=remaining + YELLOW_SECONDS + ALL_RED_SECONDS,
                    visible=True,
                    color="RED",
                )
            return DirectionCountdown(seconds=0, visible=False, color="RED")

        return CountdownMap(
            north=countdown("north"),
            south=countdown("south"),
            east=countdown("east"),
            west=countdown("west"),
        )

    def snapshot(self, now: float | None = None) -> SignalState:
        current = self._clock() if now is None else now
        remaining = self._remaining(current)
        return SignalState(
            revision=self.revision,
            serverTimestampMs=round(time.time() * 1000),
            phase=self.phase.value,
            subPhase=self.sub_phase.value,
            plannedNext=self.planned_next.value,
            signals=self._signals(),
            countdowns=self._countdowns(current),
            remainingMs=max(0, math.ceil(remaining * 1000)),
            committed=self._committed(current),
            manual=self.manual,
            state=self.state,
            reason=self.reason,
            preempted=self.preempt_target is not None,
            preemptTarget=self.preempt_target.value if self.preempt_target else None,
            telemetryStale=self.telemetry_stale(current),
        )
