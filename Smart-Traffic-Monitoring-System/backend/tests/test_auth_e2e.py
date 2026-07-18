"""Live HTTP regression coverage for the complete account lifecycle.

Run while the application is running locally:
    python -m pytest tests/test_auth_e2e.py

Set API_BASE_URL to point at another deployed API when needed.  This test sends
real requests and deliberately uses unique user data, so it does not rely on
mocked FastAPI routes or a mocked database.
"""

import json
import os
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import pytest

API_BASE_URL = os.getenv("API_BASE_URL", "http://127.0.0.1:8000").rstrip("/")


def request(method: str, path: str, *, body: dict | None = None, headers: dict | None = None):
    request_headers = dict(headers or {})
    payload = None

    if body is not None:
        if request_headers.get("Content-Type") == "application/x-www-form-urlencoded":
            payload = urlencode(body).encode("utf-8")
        else:
            request_headers.setdefault("Content-Type", "application/json")
            payload = json.dumps(body).encode("utf-8")

    request = Request(
        f"{API_BASE_URL}{path}",
        data=payload,
        method=method,
        headers=request_headers,
    )
    try:
        with urlopen(request, timeout=20) as response:
            raw_body = response.read().decode("utf-8")
            try:
                response_body = json.loads(raw_body) if raw_body else {}
            except json.JSONDecodeError:
                response_body = raw_body
            return response.status, response_body, response.headers
    except HTTPError as exc:
        content = exc.read().decode("utf-8")
        return exc.code, json.loads(content) if content else {}, exc.headers
    except URLError as exc:
        pytest.fail(f"API is not reachable at {API_BASE_URL}: {exc.reason}")


def test_loopback_origin_passes_credentialed_cors_preflight():
    status, _, headers = request(
        "OPTIONS",
        "/api/v1/auth/register",
        headers={
            "Origin": "http://127.0.0.1:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )

    assert status == 200
    assert headers.get("Access-Control-Allow-Origin") == "http://127.0.0.1:5173"
    assert headers.get("Access-Control-Allow-Credentials") == "true"


def test_register_login_profile_and_password_lifecycle():
    suffix = uuid.uuid4().hex[:12]
    initial_password = "InitialPass!234"
    changed_password = "ChangedPass!234"
    email = f"e2e.{suffix}@gmail.com"
    phone_number = f"09{int(suffix[:8], 16) % 100_000_000:08d}"
    user = {
        "username": f"e2e_{suffix}",
        "email": email,
        "phone_number": phone_number,
        "password": initial_password,
    }

    register_status, register_body, _ = request("POST", "/api/v1/auth/register", body=user)
    assert register_status == 201, register_body

    duplicate_status, _, _ = request("POST", "/api/v1/auth/register", body=user)
    assert duplicate_status == 400

    wrong_login_status, _, _ = request(
        "POST",
        "/api/v1/auth/login",
        body={"username": email, "password": "wrong-password"},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert wrong_login_status == 401

    login_status, login_body, login_headers = request(
        "POST",
        "/api/v1/auth/login",
        body={"username": email, "password": initial_password},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert login_status == 200, login_body
    assert login_body["token_type"] == "bearer"
    assert login_body["access_token"]
    assert "access_token=" in login_headers.get("Set-Cookie", "")

    # OAuth2 calls the form field `username`; support an actual username as well
    # as email so a successful registration can always be followed by login.
    username_login_status, username_login_body, _ = request(
        "POST",
        "/api/v1/auth/login",
        body={"username": user["username"], "password": initial_password},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert username_login_status == 200, username_login_body

    authorization = {"Authorization": f"Bearer {login_body['access_token']}"}

    me_status, me_body, _ = request("GET", "/api/v1/auth/me", headers=authorization)
    assert me_status == 200, me_body
    assert me_body["email"] == email

    updated_username = f"e2e_{suffix}_updated"
    profile_status, profile_body, _ = request(
        "PUT",
        "/api/v1/users/profile",
        body={"username": updated_username},
        headers=authorization,
    )
    assert profile_status == 200, profile_body

    password_status, password_body, _ = request(
        "PUT",
        "/api/v1/users/password",
        body={"old_password": initial_password, "new_password": changed_password},
        headers=authorization,
    )
    assert password_status == 200, password_body

    old_password_status, _, _ = request(
        "POST",
        "/api/v1/auth/login",
        body={"username": email, "password": initial_password},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert old_password_status == 401

    new_login_status, new_login_body, _ = request(
        "POST",
        "/api/v1/auth/login",
        body={"username": email, "password": changed_password},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert new_login_status == 200, new_login_body

    updated_me_status, updated_me_body, _ = request(
        "GET",
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {new_login_body['access_token']}"},
    )
    assert updated_me_status == 200, updated_me_body
    assert updated_me_body["username"] == updated_username