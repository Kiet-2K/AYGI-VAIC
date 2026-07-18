from fastapi.testclient import TestClient

from app.main import app


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


def test_health() -> None:
    with TestClient(app) as client:
        assert client.get("/health").json() == {"status": "ok"}


def test_websocket_accepts_report_and_broadcasts_state() -> None:
    with TestClient(app) as client:
        with client.websocket_connect("/ws/traffic") as websocket:
            initial = websocket.receive_json()
            assert initial["type"] == "signal_state"
            assert initial["subPhase"] == "ALL_RED"

            websocket.send_json(report())
            state = websocket.receive_json()
            assert state["type"] == "signal_state"
            assert set(state["signals"]) == {"north", "south", "east", "west"}


def test_websocket_rejects_out_of_order_report() -> None:
    with TestClient(app) as client:
        with client.websocket_connect("/ws/traffic") as websocket:
            websocket.receive_json()
            websocket.send_json(report(2))
            websocket.send_json(report(1))

            messages = [websocket.receive_json() for _ in range(3)]
            assert any(message.get("type") == "error" for message in messages)


def test_control_command_is_acknowledged() -> None:
    with TestClient(app) as client:
        with client.websocket_connect("/ws/traffic") as websocket:
            websocket.receive_json()
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


def test_invalid_report_returns_validation_error() -> None:
    with TestClient(app) as client:
        with client.websocket_connect("/ws/traffic") as websocket:
            websocket.receive_json()
            websocket.send_json({"type": "traffic_report", "sequence": 0})
            error = websocket.receive_json()
            assert error["type"] == "error"
            assert error["message"] == "Dữ liệu không hợp lệ."
