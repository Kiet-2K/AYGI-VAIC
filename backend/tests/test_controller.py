from app.controller import (
    ALL_RED_SECONDS,
    GREEN_MAX_SECONDS,
    GREEN_MIN_SECONDS,
    MAX_ALL_RED_SECONDS,
    TELEMETRY_TIMEOUT_SECONDS,
    YELLOW_SECONDS,
    GreenPhase,
    SubPhase,
    TrafficController,
)
from app.schemas import DirectionStats, DirectionStatsMap, MovementStats


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def stats_for(
    phase: GreenPhase,
    *,
    queue: float = 8,
    max_wait: float = 0,
    downstream: float = 0,
) -> DirectionStatsMap:
    stats = DirectionStatsMap()
    group = "left" if phase in (GreenPhase.NS_LEFT, GreenPhase.EW_LEFT) else "through"
    directions = ("north", "south") if phase.value.startswith("NS") else ("east", "west")
    for direction in directions:
        movement = MovementStats(
            queuePcu=queue / 2,
            queueLength=round(queue / 2),
            maxWaitingTime=max_wait,
            downstreamOccupancy=downstream,
        )
        setattr(getattr(stats, direction), group, movement)
        setattr(
            stats,
            direction,
            DirectionStats(
                total=round(queue / 2),
                waiting=round(queue / 2),
                queuePcu=queue / 2,
                medianSpeed=0,
                **{group: movement},
            ),
        )
    return stats


def report(controller: TrafficController, stats: DirectionStatsMap, sequence: int = 0) -> None:
    assert controller.update_report(stats, False, None, sequence)


def test_green_duration_is_clamped() -> None:
    clock = Clock()
    controller = TrafficController(clock)
    controller.stats = DirectionStatsMap()
    assert controller.green_duration(GreenPhase.NS_LEFT) == GREEN_MIN_SECONDS

    controller.stats = stats_for(GreenPhase.NS_LEFT, queue=100)
    assert controller.green_duration(GreenPhase.NS_LEFT) == GREEN_MAX_SECONDS


def test_controller_follows_safe_phase_sequence() -> None:
    clock = Clock()
    controller = TrafficController(clock)
    report(controller, stats_for(GreenPhase.EW_STRAIGHT_RIGHT))

    clock.now = ALL_RED_SECONDS
    assert controller.tick(clock.now)
    assert controller.sub_phase is SubPhase.GREEN
    assert controller.phase is GreenPhase.EW_STRAIGHT_RIGHT

    clock.now += controller.phase_duration_seconds
    report(controller, stats_for(GreenPhase.EW_STRAIGHT_RIGHT), sequence=1)
    assert controller.tick(clock.now)
    assert controller.sub_phase is SubPhase.YELLOW

    clock.now += YELLOW_SECONDS
    report(controller, stats_for(GreenPhase.EW_STRAIGHT_RIGHT), sequence=2)
    assert controller.tick(clock.now)
    assert controller.sub_phase is SubPhase.ALL_RED

    clock.now += ALL_RED_SECONDS
    report(controller, stats_for(GreenPhase.EW_STRAIGHT_RIGHT), sequence=3)
    assert controller.tick(clock.now)
    assert controller.sub_phase is SubPhase.GREEN


def test_starvation_overrides_normal_demand() -> None:
    controller = TrafficController(clock=lambda: 0)
    stats = stats_for(GreenPhase.NS_STRAIGHT_RIGHT, queue=30)
    starved = stats_for(GreenPhase.EW_LEFT, queue=1, max_wait=46)
    stats.east.left = starved.east.left
    stats.west.left = starved.west.left
    controller.stats = stats

    assert controller.choose_next(GreenPhase.NS_STRAIGHT_RIGHT) is GreenPhase.EW_LEFT


def test_emergency_preemption_has_highest_priority() -> None:
    controller = TrafficController(clock=lambda: 0)
    controller.preempt_target = GreenPhase.EW_STRAIGHT_RIGHT

    assert controller.choose_next(GreenPhase.NS_LEFT) is GreenPhase.EW_STRAIGHT_RIGHT


def test_stale_telemetry_forces_all_red() -> None:
    clock = Clock()
    controller = TrafficController(clock)
    report(controller, stats_for(GreenPhase.NS_STRAIGHT_RIGHT))
    clock.now = ALL_RED_SECONDS
    controller.tick(clock.now)
    assert controller.sub_phase is SubPhase.GREEN

    clock.now += TELEMETRY_TIMEOUT_SECONDS + 0.01
    assert controller.tick(clock.now)
    assert controller.sub_phase is SubPhase.ALL_RED
    assert controller.phase_duration_seconds == MAX_ALL_RED_SECONDS
    assert controller.snapshot(clock.now).telemetry_stale


def test_snapshot_exposes_per_direction_countdowns() -> None:
    clock = Clock()
    controller = TrafficController(clock)
    report(controller, stats_for(GreenPhase.NS_STRAIGHT_RIGHT))
    clock.now = ALL_RED_SECONDS
    controller.tick(clock.now)
    snapshot = controller.snapshot(clock.now)

    assert snapshot.signals["north"] == "GREEN"
    assert snapshot.signals["east"] == "RED"
    assert snapshot.countdowns.north.visible
    assert not snapshot.countdowns.east.visible
    assert snapshot.remaining_ms == controller.phase_duration_seconds * 1000
