#!/usr/bin/env python3
"""Unit tests for the frozen ConnectedAccount read-only acceptance script."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
import sys
import threading
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

SCRIPT_PATH = Path(__file__).with_name("verify_connected-account_account_mcp.py")
SOURCE_HASH = "cbc6236f52982cf657ebf5ce3a41e71020718499bb9e7fe59a9ed78c674db7c2"
SKILL_SOURCE = (
    "build-connected-account-account-mcp/scripts/verify_connected-account_account_mcp.py"
)


def load_module():
    spec = importlib.util.spec_from_file_location("verify_connected-account_account_mcp", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


verify = load_module()


def start_server(
    handler: type[BaseHTTPRequestHandler],
) -> tuple[ThreadingHTTPServer, threading.Thread, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    # Attached after construction so handler can record observed requests.
    server.observed_requests = []  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    return server, thread, f"http://{host}:{port}"


def stop_server(server: ThreadingHTTPServer, thread: threading.Thread) -> None:
    server.shutdown()
    thread.join(timeout=2)
    server.server_close()


class VerifyScriptTests(unittest.TestCase):
    def test_source_hash_matches_skill_script(self) -> None:
        digest = hashlib.sha256(SCRIPT_PATH.read_bytes()).hexdigest()
        self.assertEqual(digest, SOURCE_HASH)
        self.assertTrue(SCRIPT_PATH.is_file())
        self.assertIn("build-connected-account-account-mcp", SKILL_SOURCE)

    def test_rejects_base_url_with_userinfo_query_or_fragment(self) -> None:
        cases = [
            "https://user:pass@example.com",
            "https://example.com/path",
            "https://example.com?x=1",
            "https://example.com#frag",
            "ftp://example.com",
            "not-a-url",
        ]
        for value in cases:
            with self.subTest(value=value):
                with self.assertRaises(verify.CheckFailure):
                    verify.normalize_base_url(value)

    def test_rejects_unsafe_mcp_path(self) -> None:
        cases = ["", "/", "mcp", "/mcp?x=1", "/mcp#x", "/mcp/../admin", "/mcp//x"]
        for value in cases:
            with self.subTest(value=value):
                with self.assertRaises(verify.CheckFailure):
                    verify.normalize_mcp_path(value)

    def test_check_manifest_requires_protocol_and_capabilities(self) -> None:
        with self.assertRaises(verify.CheckFailure):
            verify.check_manifest({"protocolVersion": "0.9"})
        with self.assertRaises(verify.CheckFailure):
            verify.check_manifest(
                {
                    "protocolVersion": "1.0",
                    "providerKey": "amazon-sp-api",
                    "displayName": "Amazon SP-API",
                    "authorizationFlow": "redirect",
                    "capabilities": {
                        "multiAccount": True,
                        "sharedEmployeeBinding": False,
                        "independentOwnerAuthorization": False,
                        "remark": True,
                        "refresh": True,
                        # missing unbind
                    },
                    "runtime": {
                        "listAccountsTool": "amazon_list_accounts",
                        "accountIdArgument": "account_id",
                    },
                }
            )

    def test_check_accounts_rejects_duplicate_connection_and_provider_mismatch(self) -> None:
        with self.assertRaises(verify.CheckFailure):
            verify.check_accounts(
                {
                    "items": [
                        {
                            "connectionId": "con_1",
                            "externalAccountId": "A1",
                            "providerKey": "amazon-sp-api",
                            "displayName": "A1",
                            "status": "active",
                        },
                        {
                            "connectionId": "con_1",
                            "externalAccountId": "A2",
                            "providerKey": "amazon-sp-api",
                            "displayName": "A2",
                            "status": "active",
                        },
                    ]
                },
                "amazon-sp-api",
            )
        with self.assertRaises(verify.CheckFailure):
            verify.check_accounts(
                {
                    "items": [
                        {
                            "connectionId": "con_1",
                            "externalAccountId": "A1",
                            "providerKey": "other",
                            "displayName": "A1",
                            "status": "active",
                        }
                    ]
                },
                "amazon-sp-api",
            )

    def test_rejects_redirect_responses(self) -> None:
        for code in (301, 302, 307, 308):
            with self.subTest(code=code):
                class Handler(BaseHTTPRequestHandler):
                    def do_GET(self) -> None:  # noqa: N802
                        self.send_response(code)
                        self.send_header("Location", "https://evil.example/steal")
                        self.end_headers()

                    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
                        return

                server, thread, base = start_server(Handler)
                try:
                    with self.assertRaises(verify.CheckFailure) as ctx:
                        verify.http_get(
                            base + "/.well-known/connected-account",
                            timeout=2,
                        )
                    self.assertIn("HTTP 状态", str(ctx.exception))
                    self.assertIn(str(code), str(ctx.exception))
                finally:
                    stop_server(server, thread)

    def test_rejects_oversized_and_invalid_json(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                if self.path.endswith("/big"):
                    body = b"x" * (verify.MAX_RESPONSE_BYTES + 2)
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                body = b"not-json"
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
                return

        server, thread, base = start_server(Handler)
        try:
            with self.assertRaises(verify.CheckFailure):
                verify.http_get(base + "/big", timeout=2)
            with self.assertRaises(verify.CheckFailure):
                verify.http_get(base + "/bad", timeout=2)
        finally:
            stop_server(server, thread)

    def test_discovery_and_health_do_not_send_authorization(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                self.server.observed_requests.append(  # type: ignore[attr-defined]
                    {
                        "path": self.path,
                        "authorization": self.headers.get("Authorization"),
                    }
                )
                if self.path == "/.well-known/connected-account":
                    body = json.dumps(
                        {
                            "protocolVersion": "1.0",
                            "providerKey": "amazon-sp-api",
                            "displayName": "Amazon SP-API",
                            "authorizationFlow": "redirect",
                            "capabilities": {
                                "multiAccount": True,
                                "sharedEmployeeBinding": False,
                                "independentOwnerAuthorization": False,
                                "remark": True,
                                "refresh": True,
                                "unbind": True,
                            },
                            "runtime": {
                                "listAccountsTool": "amazon_list_accounts",
                                "accountIdArgument": "account_id",
                            },
                        }
                    ).encode("utf-8")
                elif self.path == "/mcp/healthz":
                    body = b"ok"
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header(
                    "Content-Type",
                    "application/json" if body.startswith(b"{") else "text/plain",
                )
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
                return

        server, thread, base = start_server(Handler)
        old = os.environ.pop(verify.JWT_ENV_NAME, None)
        try:
            # Even if a JWT is present in the environment, public operations must
            # not attach it — the script only passes token to auth/accounts.
            os.environ[verify.JWT_ENV_NAME] = "should-not-be-sent-on-public-ops"
            verify.manifest_operation(base, 2.0)
            verify.health_operation(base, "/mcp", 2.0)
            observed = server.observed_requests  # type: ignore[attr-defined]
            public_paths = {item["path"] for item in observed}
            self.assertEqual(
                public_paths,
                {"/.well-known/connected-account", "/mcp/healthz"},
            )
            for item in observed:
                self.assertIsNone(item["authorization"])
        finally:
            if old is None:
                os.environ.pop(verify.JWT_ENV_NAME, None)
            else:
                os.environ[verify.JWT_ENV_NAME] = old
            stop_server(server, thread)

    def test_json_output_is_single_object_without_mixed_diagnostics(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                if self.path == "/.well-known/connected-account":
                    body = json.dumps(
                        {
                            "protocolVersion": "1.0",
                            "providerKey": "amazon-sp-api",
                            "displayName": "Amazon SP-API",
                            "authorizationFlow": "redirect",
                            "capabilities": {
                                "multiAccount": True,
                                "sharedEmployeeBinding": False,
                                "independentOwnerAuthorization": False,
                                "remark": True,
                                "refresh": True,
                                "unbind": True,
                            },
                            "runtime": {
                                "listAccountsTool": "amazon_list_accounts",
                                "accountIdArgument": "account_id",
                            },
                        }
                    ).encode("utf-8")
                else:
                    body = b"ok"
                self.send_response(200)
                self.send_header("Content-Type", "application/json" if body.startswith(b"{") else "text/plain")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
                return

        server, thread, base = start_server(Handler)
        old = os.environ.pop(verify.JWT_ENV_NAME, None)
        try:
            args = type(
                "Args",
                (),
                {"base_url": base, "mcp_path": "/mcp", "timeout": 2.0, "json_output": True},
            )()
            ok, results = verify.run(args)
            buffer = io.StringIO()
            with redirect_stdout(buffer):
                verify.render(ok, results, True)
            raw = buffer.getvalue().strip()
            payload = json.loads(raw)
            self.assertIsInstance(payload, dict)
            self.assertIn("ok", payload)
            self.assertIn("checks", payload)
            # Exactly one JSON object on stdout — no mixed diagnostics.
            self.assertEqual(raw.count("\n"), 0)
            self.assertTrue(raw.startswith("{") and raw.endswith("}"))
        finally:
            if old is not None:
                os.environ[verify.JWT_ENV_NAME] = old
            stop_server(server, thread)

    def test_script_does_not_call_mutating_endpoints(self) -> None:
        called: list[str] = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                called.append(f"GET {self.path}")
                if self.path == "/.well-known/connected-account":
                    body = json.dumps(
                        {
                            "protocolVersion": "1.0",
                            "providerKey": "amazon-sp-api",
                            "displayName": "Amazon SP-API",
                            "authorizationFlow": "redirect",
                            "capabilities": {
                                "multiAccount": True,
                                "sharedEmployeeBinding": False,
                                "independentOwnerAuthorization": False,
                                "remark": True,
                                "refresh": True,
                                "unbind": True,
                            },
                            "runtime": {
                                "listAccountsTool": "amazon_list_accounts",
                                "accountIdArgument": "account_id",
                            },
                        }
                    ).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if self.path == "/mcp/healthz":
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"ok")
                    return
                if self.path in {
                    "/connected-account/v1/auth/check",
                    "/connected-account/v1/accounts",
                }:
                    body = (
                        json.dumps(
                            {
                                "authenticated": True,
                                "employeeId": "e1",
                                "issuer": "issuer",
                                "kid": "k1",
                                "expiresAt": "2099-01-01T00:00:00Z",
                            }
                        ).encode("utf-8")
                        if self.path.endswith("auth/check")
                        else json.dumps({"items": []}).encode("utf-8")
                    )
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                self.send_response(404)
                self.end_headers()

            def do_POST(self) -> None:  # noqa: N802
                called.append(f"POST {self.path}")
                self.send_response(500)
                self.end_headers()

            def do_PUT(self) -> None:  # noqa: N802
                called.append(f"PUT {self.path}")
                self.send_response(500)
                self.end_headers()

            def do_DELETE(self) -> None:  # noqa: N802
                called.append(f"DELETE {self.path}")
                self.send_response(500)
                self.end_headers()

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
                return

        server, thread, base = start_server(Handler)
        old = os.environ.get(verify.JWT_ENV_NAME)
        try:
            os.environ[verify.JWT_ENV_NAME] = "test-jwt"
            ok, _results = verify.run(
                type("Args", (), {"base_url": base, "mcp_path": "/mcp", "timeout": 2.0, "json_output": False})()
            )
            self.assertTrue(ok)
            self.assertTrue(all(item.startswith("GET ") for item in called))
            forbidden_substrings = (
                "authorization-attempts",
                "account-bindings",
                "connections/",
                "refresh",
            )
            for item in called:
                for needle in forbidden_substrings:
                    self.assertNotIn(needle, item)
        finally:
            if old is None:
                os.environ.pop(verify.JWT_ENV_NAME, None)
            else:
                os.environ[verify.JWT_ENV_NAME] = old
            stop_server(server, thread)


if __name__ == "__main__":
    unittest.main()
