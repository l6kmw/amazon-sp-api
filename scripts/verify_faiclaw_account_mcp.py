#!/usr/bin/env python3
"""Run non-mutating ConnectedAccount account-MCP contract checks."""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_RESPONSE_BYTES = 1024 * 1024
JWT_ENV_NAME = "CONNECTED_ACCOUNT_JWT"
USER_AGENT = "build-connected-account-account-mcp-verifier/1.0"


class CheckFailure(Exception):
    """A safe, user-facing verification failure."""


class RejectRedirects(HTTPRedirectHandler):
    """Keep credentials on the exact Provider endpoint under test."""

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


HTTP_OPENER = build_opener(RejectRedirects())


@dataclass
class CheckResult:
    name: str
    status: str
    message: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "只读检查 ConnectedAccount Connected Account v1 发现清单、MCP 健康端点，"
            "以及可选的 Employee JWT 身份和账号列表契约。"
        )
    )
    parser.add_argument("--base-url", required=True, help="Provider 公网 Origin，例如 https://account.example.com")
    parser.add_argument("--mcp-path", default="/mcp", help="Streamable HTTP MCP 路径，默认 /mcp")
    parser.add_argument("--timeout", type=positive_timeout, default=10.0, help="单次 HTTP 超时秒数，默认 10")
    parser.add_argument("--json", action="store_true", dest="json_output", help="输出机器可读 JSON")
    return parser.parse_args()


def positive_timeout(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("timeout 必须是数字") from exc
    if parsed <= 0 or parsed > 120:
        raise argparse.ArgumentTypeError("timeout 必须大于 0 且不超过 120 秒")
    return parsed


def normalize_base_url(value: str) -> str:
    parsed = urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise CheckFailure("base-url 必须是包含主机的 HTTP/HTTPS Origin")
    if parsed.username is not None or parsed.password is not None:
        raise CheckFailure("base-url 不得携带用户名或密码")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise CheckFailure("base-url 只能包含协议、主机和可选端口")
    return urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


def normalize_mcp_path(value: str) -> str:
    path = value.strip()
    if not path.startswith("/") or path == "/":
        raise CheckFailure("mcp-path 必须是非根绝对路径")
    if any(character in path for character in "?#\\") or "//" in path:
        raise CheckFailure("mcp-path 必须是干净的 URL 路径")
    segments = path.split("/")
    if any(segment in {".", ".."} for segment in segments):
        raise CheckFailure("mcp-path 不得包含相对路径段")
    return path.rstrip("/")


def read_response(response: Any) -> bytes:
    payload = response.read(MAX_RESPONSE_BYTES + 1)
    if len(payload) > MAX_RESPONSE_BYTES:
        raise CheckFailure("响应超过 1 MiB 安全限制")
    return payload


def http_get(url: str, timeout: float, token: str | None = None, expect_json: bool = True) -> Any:
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = Request(url, headers=headers, method="GET")
    try:
        with HTTP_OPENER.open(request, timeout=timeout) as response:
            status = getattr(response, "status", response.getcode())
            if status != 200:
                raise CheckFailure(f"HTTP 状态为 {status}，预期 200")
            payload = read_response(response)
    except HTTPError as exc:
        raise CheckFailure(f"HTTP 状态为 {exc.code}，预期 200") from None
    except (URLError, TimeoutError, socket.timeout) as exc:
        reason = getattr(exc, "reason", exc)
        if isinstance(reason, (TimeoutError, socket.timeout)):
            raise CheckFailure("HTTP 请求超时") from None
        raise CheckFailure("HTTP 请求失败") from None

    if not expect_json:
        return payload
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise CheckFailure("响应不是有效 UTF-8 JSON") from None


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CheckFailure(f"{label} 必须是 JSON object")
    return value


def require_nonempty_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CheckFailure(f"字段 {field} 必须是非空字符串")
    return value.strip()


def require_boolean(value: Any, field: str) -> bool:
    if not isinstance(value, bool):
        raise CheckFailure(f"字段 {field} 必须是 boolean")
    return value


def check_manifest(payload: Any) -> dict[str, Any]:
    manifest = require_object(payload, "discovery manifest")
    if manifest.get("protocolVersion") != "1.0":
        raise CheckFailure("protocolVersion 必须为 1.0")
    require_nonempty_string(manifest.get("providerKey"), "providerKey")
    require_nonempty_string(manifest.get("displayName"), "displayName")
    if manifest.get("authorizationFlow") != "redirect":
        raise CheckFailure("authorizationFlow 必须为 redirect")

    capabilities = require_object(manifest.get("capabilities"), "capabilities")
    for field in (
        "multiAccount",
        "sharedEmployeeBinding",
        "independentOwnerAuthorization",
        "remark",
        "refresh",
        "unbind",
    ):
        require_boolean(capabilities.get(field), f"capabilities.{field}")

    runtime = require_object(manifest.get("runtime"), "runtime")
    require_nonempty_string(runtime.get("listAccountsTool"), "runtime.listAccountsTool")
    require_nonempty_string(runtime.get("accountIdArgument"), "runtime.accountIdArgument")
    return manifest


def check_auth(payload: Any) -> dict[str, Any]:
    auth = require_object(payload, "auth/check response")
    if auth.get("authenticated") is not True:
        raise CheckFailure("authenticated 必须为 true")
    for field in ("employeeId", "issuer", "kid", "expiresAt"):
        require_nonempty_string(auth.get(field), field)
    expires_at = auth["expiresAt"].replace("Z", "+00:00")
    try:
        parsed_expiry = datetime.fromisoformat(expires_at)
    except ValueError:
        raise CheckFailure("expiresAt 必须是 RFC3339 时间") from None
    if parsed_expiry.tzinfo is None:
        raise CheckFailure("expiresAt 必须包含 RFC3339 时区")
    return auth


def check_accounts(payload: Any, provider_key: str) -> int:
    response = require_object(payload, "accounts response")
    items = response.get("items")
    if not isinstance(items, list):
        raise CheckFailure("accounts.items 必须是 array")
    seen_connections: set[str] = set()
    for index, raw_item in enumerate(items):
        item = require_object(raw_item, f"accounts.items[{index}]")
        connection_id = require_nonempty_string(item.get("connectionId"), f"items[{index}].connectionId")
        if connection_id in seen_connections:
            raise CheckFailure(f"重复 connectionId: items[{index}]")
        seen_connections.add(connection_id)
        require_nonempty_string(item.get("externalAccountId"), f"items[{index}].externalAccountId")
        actual_provider = require_nonempty_string(item.get("providerKey"), f"items[{index}].providerKey")
        if actual_provider != provider_key:
            raise CheckFailure(f"items[{index}].providerKey 与 discovery 不一致")
        require_nonempty_string(item.get("displayName"), f"items[{index}].displayName")
        require_nonempty_string(item.get("status"), f"items[{index}].status")
        if "metadata" in item and not isinstance(item["metadata"], dict):
            raise CheckFailure(f"items[{index}].metadata 必须是 object")
    return len(items)


def execute_check(results: list[CheckResult], name: str, operation: Any) -> Any | None:
    try:
        value, message = operation()
    except CheckFailure as exc:
        results.append(CheckResult(name=name, status="fail", message=str(exc)))
        return None
    results.append(CheckResult(name=name, status="pass", message=message))
    return value


def run(args: argparse.Namespace) -> tuple[bool, list[CheckResult]]:
    results: list[CheckResult] = []
    try:
        base_url = normalize_base_url(args.base_url)
        mcp_path = normalize_mcp_path(args.mcp_path)
    except CheckFailure as exc:
        results.append(CheckResult(name="configuration", status="fail", message=str(exc)))
        return False, results

    manifest = execute_check(
        results,
        "discovery_manifest",
        lambda: manifest_operation(base_url, args.timeout),
    )
    execute_check(
        results,
        "mcp_health",
        lambda: health_operation(base_url, mcp_path, args.timeout),
    )

    token = os.environ.get(JWT_ENV_NAME, "").strip()
    if not token:
        message = f"未设置 {JWT_ENV_NAME}，跳过鉴权检查"
        results.append(CheckResult(name="employee_auth", status="skip", message=message))
        results.append(CheckResult(name="connected_accounts", status="skip", message=message))
    elif manifest is None:
        results.append(CheckResult(name="employee_auth", status="skip", message="discovery 失败，跳过依赖检查"))
        results.append(CheckResult(name="connected_accounts", status="skip", message="discovery 失败，跳过依赖检查"))
    else:
        auth = execute_check(
            results,
            "employee_auth",
            lambda: auth_operation(base_url, args.timeout, token),
        )
        if auth is None:
            results.append(CheckResult(name="connected_accounts", status="skip", message="身份检查失败，跳过账号检查"))
        else:
            execute_check(
                results,
                "connected_accounts",
                lambda: accounts_operation(base_url, args.timeout, token, manifest["providerKey"]),
            )

    return not any(result.status == "fail" for result in results), results


def manifest_operation(base_url: str, timeout: float) -> tuple[dict[str, Any], str]:
    manifest = check_manifest(http_get(base_url + "/.well-known/connected-account", timeout))
    return manifest, f"protocol 1.0, providerKey={manifest['providerKey']}"


def health_operation(base_url: str, mcp_path: str, timeout: float) -> tuple[bytes, str]:
    payload = http_get(base_url + mcp_path + "/healthz", timeout, expect_json=False)
    return payload, "HTTP 200"


def auth_operation(base_url: str, timeout: float, token: str) -> tuple[dict[str, Any], str]:
    auth = check_auth(http_get(base_url + "/connected-account/v1/auth/check", timeout, token=token))
    return auth, f"issuer={auth['issuer']}, employeeId={auth['employeeId']}"


def accounts_operation(
    base_url: str,
    timeout: float,
    token: str,
    provider_key: str,
) -> tuple[int, str]:
    count = check_accounts(http_get(base_url + "/connected-account/v1/accounts", timeout, token=token), provider_key)
    return count, f"items={count}"


def render(ok: bool, results: list[CheckResult], json_output: bool) -> None:
    if json_output:
        print(json.dumps({"ok": ok, "checks": [asdict(result) for result in results]}, ensure_ascii=False))
        return
    for result in results:
        print(f"[{result.status.upper()}] {result.name}: {result.message}")
    print("PASS" if ok else "FAIL")


def main() -> int:
    args = parse_args()
    ok, results = run(args)
    render(ok, results, args.json_output)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
