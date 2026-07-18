from time import time_ns

from fastapi.testclient import TestClient

from app.main import app


TEST_TRACK_ID = time_ns()


def report(sequence: int = 0) -> dict[str, object]:
    movement = {
        "queueLength": 2,
        "queuePcu": 2,
        "arrivalRate": 0.5,
        "avgWaitingTime": 3,
        "maxWaitingTime": 5,
        "downstreamOccupancy": 0.2,
    }
    direction = {
        "total": 3,
        "waiting": 2,
        "queuePcu": 2,
        "medianSpeed": 1,
        "arrivalRate": 0.5,
        "departureRate": 0.25,
        "occupancy": 0.2,
        "left": movement,
        "through": movement,
    }
    return {
        "type": "traffic_report",
        "sequence": sequence,
        "timestampMs": 123,
        "stats": {name: direction for name in ("north", "south", "east", "west")},
        "boxOccupied": False,
        "emergency": None,
    }


def receive_initial(websocket: object) -> tuple[dict[str, object], dict[str, object]]:
    signal = websocket.receive_json()
    history = websocket.receive_json()
    assert signal["type"] == "signal_state"
    assert history["type"] == "violation_history"
    return signal, history


def violation(track_id: int = TEST_TRACK_ID) -> dict[str, object]:
    return {
        "type": "violation_event",
        "trackId": track_id,
        "licensePlate": "00027",
        "vehicleClass": "CAR",
        "direction": "north",
        "movement": "STRAIGHT",
        "violation": "RED_LIGHT",
        "signal": "RED",
        "timestampMs": 123456,
        "intersection": "Nút giao Mậu Thân",
        "evidence": {"laneId": "north-straight-in", "speed": 3.2, "signal": "RED"},
    }


def test_health() -> None:
    with TestClient(app) as client:
        assert client.get("/health").json() == {"status": "ok"}


def test_websocket_accepts_report_and_broadcasts_state() -> None:
    with TestClient(app) as client:
        with client.websocket_connect("/ws/traffic") as websocket:
            initial, history = receive_initial(websocket)
            assert initial["subPhase"] == "ALL_RED"
            assert isinstance(history["violations"], list)

            websocket.send_json(report())
            state = websocket.receive_json()
            assert state["type"] == "signal_state"
            assert set(state["signals"]) == {"north", "south", "east", "west"}
            assert state["signals"] == state["mainSignals"]
            assert state["countdowns"] == state["mainCountdowns"]
            assert set(state["leftSignals"]) == {"north", "south", "east", "west"}


def test_websocket_rejects_out_of_order_report() -> None:
    with TestClient(app) as client:
        with client.websocket_connect("/ws/traffic") as websocket:
            receive_initial(websocket)
            websocket.send_json(report(2))
            websocket.send_json(report(1))

            messages = [websocket.receive_json() for _ in range(3)]
            assert any(message.get("type") == "error" for message in messages)


def test_control_command_is_acknowledged() -> None:
    with TestClient(app) as client:
        with client.websocket_connect("/ws/traffic") as websocket:
            receive_initial(websocket)
            websocket.send_json(
                {
                    "type": "control_command",
                    "commandId": "test-command",
                    "action": "ALL_RED",
                }
            )
            acknowledgement = websocket.receive_json()
            assert acknowledgement == {
                "type": "control_ack",
                "commandId": "test-command",
                "action": "ALL_RED",
                "accepted": True,
            }


def test_violation_is_broadcast_once_and_restored_on_reconnect() -> None:
    with TestClient(app) as client:
        with client.websocket_connect("/ws/traffic") as websocket:
            receive_initial(websocket)
            websocket.send_json(violation())
            messages = [websocket.receive_json() for _ in range(3)]
            recorded = next(message for message in messages if message["type"] == "violation_event")
            assert recorded["licensePlate"] == "00027"
            assert recorded["vehicleClass"] == "CAR"

            websocket.send_json(violation())
            websocket.send_json(
                {
                    "type": "control_command",
                    "commandId": "after-duplicate",
                    "action": "RESET",
                }
            )
            acknowledgement = websocket.receive_json()
            assert acknowledgement["type"] == "control_ack"

        with client.websocket_connect("/ws/traffic") as websocket:
            _, history = receive_initial(websocket)
            matches = [
                item
                for item in history["violations"]
                if item["trackId"] == TEST_TRACK_ID and item["violation"] == "RED_LIGHT"
            ]
            assert len(matches) == 1
            assert matches[0]["evidence"]["signal"] == "RED"


def test_invalid_report_returns_validation_error() -> None:
    with TestClient(app) as client:
        with client.websocket_connect("/ws/traffic") as websocket:
            receive_initial(websocket)
            websocket.send_json({"type": "traffic_report", "sequence": 0})
            error = websocket.receive_json()
            assert error["type"] == "error"
            assert error["message"] == "Dữ liệu không hợp lệ."
