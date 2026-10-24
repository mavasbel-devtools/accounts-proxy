"""Self-check of the recon capture addon (plan 2026-10-19-20-04, phases R1 and R2).

Drives the addon with synthetic flows through `mitmproxy.test` and asserts the record contract: ordered headers,
byte-exact bodies, SSE chunk timing (including a gzip-encoded stream), WebSocket frames, redaction of every credential
class, refusal when a secret survives redaction, connection identity, the ClientHello/JA3 inputs, and the partial
record of an aborted stream. This runs without a network or a real client, so it is the unit tier of the capture path;
`scripts/tests/unit/recon-capture.test.ts` runs it and additionally proves the same addon inside a real mitmdump.

Usage: <mitmproxy's python> scripts/recon/mitm/selfcheck.py
Exit: 0 pass, 1 failure (the failing assertion is printed).
"""

from __future__ import annotations

import gzip
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST = HERE.parent / "shared" / "redaction.json"


def load_addon():
    spec = importlib.util.spec_from_file_location("recon_addon", HERE / "recon_addon.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read(out: str, name: str) -> dict:
    with open(os.path.join(out, name), encoding="utf-8") as handle:
        return json.load(handle)


def latest(out: str, suffix: str) -> dict:
    names = sorted(name for name in os.listdir(out) if name.endswith(suffix))
    assert names, f"no {suffix} record"
    return read(out, names[-1])


def client_hello(sni: str) -> bytes:
    """A structurally valid TLS 1.3 ClientHello body (RFC 8446 §4.1.2) with the extensions JA3 reads."""

    def extension(kind: int, body: bytes) -> bytes:
        return kind.to_bytes(2, "big") + len(body).to_bytes(2, "big") + body

    name = sni.encode("ascii")
    server_name = (len(name) + 3).to_bytes(2, "big") + b"\x00" + len(name).to_bytes(2, "big") + name
    alpn_list = b"\x02h2\x08http/1.1"
    alpn = len(alpn_list).to_bytes(2, "big") + alpn_list
    groups = bytes([0, 29, 0, 23, 0, 24])
    groups_body = len(groups).to_bytes(2, "big") + groups
    formats = b"\x01\x00"
    signatures = bytes([0x04, 0x03, 0x08, 0x04])
    signatures_body = len(signatures).to_bytes(2, "big") + signatures
    extensions = (
        extension(0, server_name)
        + extension(16, alpn)
        + extension(10, groups_body)
        + extension(11, formats)
        + extension(13, signatures_body)
    )
    body = b"\x03\x03" + bytes(range(32)) + b"\x00"
    body += (2).to_bytes(2, "big") + bytes([0x13, 0x01])
    body += b"\x01\x00"
    body += len(extensions).to_bytes(2, "big") + extensions
    return body


def main() -> int:
    from mitmproxy import http
    from mitmproxy.test import taddons, tflow
    from mitmproxy.websocket import WebSocketMessage

    addon_module = load_addon()

    def header_pairs(pairs):
        return http.Headers([(name.encode(), value.encode()) for name, value in pairs])
    failures: list[str] = []
    checks = 0

    def check(condition: bool, message: str) -> None:
        nonlocal checks
        checks += 1
        if not condition:
            failures.append(message)

    with tempfile.TemporaryDirectory(prefix="recon-selfcheck-") as out:
        addon = addon_module.ReconAddon()
        with taddons.context(addon) as tctx:
            tctx.configure(
                addon,
                recon_out=out,
                recon_client="selfcheck",
                recon_client_version="1.0.0",
                recon_cell="claude",
                recon_run="selfcheck/run",
                recon_redaction=str(MANIFEST),
                recon_max_body=1_000_000,
            )
            addon.running()

            # 1. request: ordered duplicate headers, credential header, JSON field, token prefix, query parameter.
            request = http.Request(
                "api.anthropic.com",
                443,
                b"POST",
                b"https",
                b"api.anthropic.com",
                b"/v1/messages?access_token=query-secret-value",
                b"HTTP/2",
                headers=header_pairs(
                    [
                        ("accept", "application/json"),
                        ("x-duplicate", "one"),
                        ("x-duplicate", "two"),
                        ("authorization", "Bearer sk-ant-abcdefghijklmnop"),
                        ("content-type", "application/json"),
                    ]
                ),
                content=(
                    b'{"model":"claude-sonnet-4-5","metadata":{"user_id":"user_abc"},'
                    b'"access_token":"sk-ant-should-be-redacted","echo":"ya29.aaaaaaaaaaaaaaaa"}'
                ),
                trailers=None,
                timestamp_start=1,
                timestamp_end=2,
            )
            flow = tflow.tflow(req=request)
            addon.request(flow)
            record = read(out, "001-request.json")
            check(record["schema"] == "recon-request/2", "request schema")
            check(record["method"] == "POST" and record["httpVersion"] == "HTTP/2", "request method/version")
            names = [pair[0] for pair in record["headers"]]
            check(names == ["accept", "x-duplicate", "x-duplicate", "authorization", "content-type"], "header order and duplicates")
            check(record["headers"][2][1] == "two", "duplicate value preserved")
            check(record["headers"][3][1] == "Bearer <REDACTED:authorization>", "credential header keeps scheme")
            body = record["body"]
            check('"model":"claude-sonnet-4-5"' in body, "body bytes preserved inline")
            check("sk-ant-should-be-redacted" not in body, "credential field redacted")
            check("ya29.aaaa" not in body, "token prefix redacted")
            check("query-secret-value" not in body, "query parameter redacted")
            check(record["secretScan"] == "clean", "request scan clean")
            check(
                "<REDACTED:field>" in record["url"] and "query-secret-value" not in record["url"],
                "URL query redacted",
            )
            check(record["clientVersion"] == "1.0.0" and record["cell"] == "claude", "run metadata")
            check(record["wallAtMs"] > 1_700_000_000_000, "request carries a wall clock")
            check(record["clientConn"]["id"] == flow.client_conn.id, "request names its client connection")
            check(record["serverConn"]["id"] == flow.server_conn.id, "request names its server connection")

            # 1b. ClientHello: the exact offer a fingerprint is computed from, kept with its raw bytes.
            from mitmproxy import tls as tls_module

            hello_body = client_hello("api.anthropic.com")
            flow.client_conn.sni = "api.anthropic.com"
            hello_data = type(
                "HelloData",
                (),
                {
                    "client_hello": tls_module.ClientHello(hello_body),
                    "context": type("Ctx", (), {"client": flow.client_conn})(),
                },
            )()
            addon.tls_clienthello(hello_data)
            registry = read(out, "connections.json")
            check(registry["schema"] == "recon-connections/1", "connections schema")
            check(len(registry["connections"]) == 1, "one connection entry")
            entry = registry["connections"][0]
            check(entry["sni"] == "api.anthropic.com" and entry["id"] == flow.client_conn.id, "connection identity")
            check(entry["alpnOffers"] == ["h2", "http/1.1"], "ALPN offers in order")
            check(entry["cipherSuites"] == [4865], "cipher suites in order")
            check([item["type"] for item in entry["extensions"]] == [0, 16, 10, 11, 13], "extension order")
            check(entry["supportedGroups"] == [29, 23, 24], "supported groups")
            check(entry["ecPointFormats"] == [0], "point formats")
            check(entry["signatureAlgorithms"] == [0x0403, 0x0804], "signature algorithms")
            expected_ja3 = "771,4865,0-16-10-11-13,29-23-24,0"
            check(entry["ja3"] == expected_ja3, "JA3 component string")
            check(entry["ja3Hash"] == hashlib.md5(expected_ja3.encode("ascii")).hexdigest(), "JA3 hash")
            check(
                __import__("base64").b64decode(entry["raw"]) == hello_body
                and entry["rawBytes"] == len(hello_body),
                "raw ClientHello preserved",
            )

            # 1c. Once the handshake finishes, the same entry carries the negotiated parameters, not just the offer.
            class Negotiated:
                id = flow.client_conn.id
                alpn = "h2"
                tls_version = "TLSv1.3"
                cipher = ("TLS_AES_128_GCM_SHA256", "TLSv1.3", 128)
                tls_established = True

            addon.tls_established_client(type("EstablishedData", (), {"conn": Negotiated()})())
            entry = read(out, "connections.json")["connections"][0]
            check(
                entry["alpn"] == "h2"
                and entry["tlsVersion"] == "TLSv1.3"
                and entry["tlsEstablished"] is True
                and entry["cipher"][0] == "TLS_AES_128_GCM_SHA256",
                "negotiated ALPN, TLS version and cipher filled after the handshake",
            )

            # 2. non-stream response.
            response = http.Response(
                b"HTTP/2",
                200,
                reason=b"OK",
                headers=header_pairs([("content-type", "application/json"), ("set-cookie", "session=abc")]),
                content=b'{"ok":true}',
                trailers=None,
                timestamp_start=1,
                timestamp_end=2,
            )
            plain = tflow.tflow(req=request, resp=response)
            plain.metadata["recon_seq"] = 1
            addon.response(plain)
            record = read(out, "001-response.json")
            check(record["schema"] == "recon-response/3" and record["status"] == 200, "response schema/status")
            check(
                record["url"] == "https://api.anthropic.com/v1/messages?access_token=<REDACTED:field>"
                and record["method"] == "POST",
                "response names the request it answers, with the URL redacted",
            )
            check(record["body"] == '{"ok":true}', "response body exact")
            check(record["headers"][1][1] == "<REDACTED:set-cookie>", "set-cookie redacted")
            check(record["secretScan"] == "clean", "response scan clean")

            # 2b. A close after a fully delivered response is `clientClosed`, not an error: no error file is written and
            # the already-written response is marked. Every 401 a signed-out client reads ends this way.
            from mitmproxy.flow import Error

            late = tflow.tflow()
            late.metadata["recon_seq"] = 1
            late.error = Error("Client disconnected")
            addon.error(late)
            record = read(out, "001-response.json")
            check(record["clientClosed"] is True, "late close marks the finished response")
            check(not os.path.exists(os.path.join(out, "001-error.json")), "no error record after a delivered response")

            # 3. streamed SSE response: chunk boundaries and arrival times survive.
            stream_flow = tflow.tflow(req=request)
            stream_flow.metadata["recon_seq"] = 2
            stream_flow.response = http.Response(
                b"HTTP/1.1",
                200,
                reason=b"OK",
                headers=header_pairs([("content-type", "text/event-stream"), ("cache-control", "no-cache")]),
                content=b"",
                trailers=None,
                timestamp_start=1,
                timestamp_end=2,
            )
            addon.responseheaders(stream_flow)
            sink = stream_flow.response.stream
            check(callable(sink), "SSE response is streamed")
            frames = [b"event: message_start\ndata: {}\n\n", b"event: content_block_delta\ndata: {\"t\":\"x\"}\n\n", b""]
            for frame in frames:
                assert callable(sink)
                returned = sink(frame)
                check(returned == frame, "stream callback returns the chunk unchanged")
            addon.response(stream_flow)
            record = read(out, "002-response.json")
            check(len(record["chunks"]) == 2, "one entry per non-empty chunk")
            check(record["chunks"][1]["text"].startswith("event: content_block_delta"), "chunk text")
            check(record["chunks"][0]["atMs"] <= record["doneAtMs"], "chunk timing")
            check(record["headersAtMs"] <= record["chunks"][0]["atMs"], "headers before body")
            check([frame["event"] for frame in record["frames"]] == ["message_start", "content_block_delta"], "frame boundaries")

            # 4. gzip-encoded SSE: chunks are decompressed for the record, the client keeps the original bytes.
            gzip_flow = tflow.tflow(req=request)
            gzip_flow.metadata["recon_seq"] = 3
            gzip_flow.response = http.Response(
                b"HTTP/1.1",
                200,
                reason=b"OK",
                headers=header_pairs([("content-type", "text/event-stream"), ("content-encoding", "gzip")]),
                content=b"",
                trailers=None,
                timestamp_start=1,
                timestamp_end=2,
            )
            addon.responseheaders(gzip_flow)
            compressed = gzip.compress(b"event: ping\ndata: {}\n\n")
            sink = gzip_flow.response.stream
            assert callable(sink)
            sink(compressed)
            sink(b"")
            addon.response(gzip_flow)
            record = read(out, "003-response.json")
            check(record["chunks"][0]["text"] == "event: ping\ndata: {}\n\n", "gzip stream decompressed for the record")

            # 4a. a frame split across two network chunks is reassembled, and a data-only frame takes its type.
            split_flow = tflow.tflow(req=request)
            split_flow.metadata["recon_seq"] = 31
            split_flow.response = http.Response(
                b"HTTP/2",
                200,
                reason=b"OK",
                headers=header_pairs([("content-type", "text/event-stream")]),
                content=b"",
                trailers=None,
                timestamp_start=1,
                timestamp_end=2,
            )
            addon.responseheaders(split_flow)
            split_sink = split_flow.response.stream
            assert callable(split_sink)
            split_sink(b'data: {"type":"response.output_text.')
            split_sink(b'delta","delta":"hi"}\n\n')
            split_sink(b"")
            addon.response(split_flow)
            record = read(out, "031-response.json")
            check(record["streamed"] is True and len(record["chunks"]) == 2, "split frame keeps both chunks")
            check(record["frames"] == [{"atMs": record["frames"][0]["atMs"], "event": "response.output_text.delta", "bytes": record["frames"][0]["bytes"]}], "split frame reassembled")
            check(record["frames"][0]["bytes"] > 40, "reassembled frame size")

            # 4b. a cancelled stream keeps every chunk received before the cancellation.
            from mitmproxy.flow import Error

            abort_flow = tflow.tflow(req=request)
            abort_flow.metadata["recon_seq"] = 30
            abort_flow.response = http.Response(
                b"HTTP/2",
                200,
                reason=b"OK",
                headers=header_pairs([("content-type", "text/event-stream")]),
                content=b"",
                trailers=None,
                timestamp_start=1,
                timestamp_end=2,
            )
            addon.responseheaders(abort_flow)
            abort_sink = abort_flow.response.stream
            assert callable(abort_sink)
            abort_sink(b"event: message_start\ndata: {}\n\n")
            abort_flow.error = Error("Client disconnected")
            addon.error(abort_flow)
            record = read(out, "030-response.json")
            check(record["aborted"] is True and record["streamed"] is True, "aborted stream marked")
            check(len(record["chunks"]) == 1 and record["chunks"][0]["event"] == "message_start", "chunk before abort kept")
            check(record["error"] == "Client disconnected", "abort error on the response record")
            error_record = read(out, "030-error.json")
            check(error_record["errorClass"] == "client-disconnect", "abort classified")

            # 4c. A client that closes after the provider's terminal event ended a complete response. This is the shape
            # every opencode run produced: `[DONE]` arrives, the client hangs up, mitmproxy reports "Client
            # disconnected". Recording that as an abort would mislabel every completed stream as cancelled.
            done_flow = tflow.tflow(req=request)
            done_flow.metadata["recon_seq"] = 32
            done_flow.response = http.Response(
                b"HTTP/2",
                200,
                reason=b"OK",
                headers=header_pairs([("content-type", "text/event-stream")]),
                content=b"",
                trailers=None,
                timestamp_start=1,
                timestamp_end=2,
            )
            addon.responseheaders(done_flow)
            done_sink = done_flow.response.stream
            assert callable(done_sink)
            done_sink(b'data: {"choices":[{"delta":{},"finish_reason":null}]}\n\n')
            done_sink(b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
            done_sink(b"data: [DONE]\n\n")
            done_flow.error = Error("Client disconnected")
            addon.error(done_flow)
            record = read(out, "032-response.json")
            check(record["aborted"] is False and record["clientClosed"] is True, "complete stream closed by client")
            check("error" not in record, "a completed stream carries no error")
            check(not os.path.exists(os.path.join(out, "032-error.json")), "no error record for a completed stream")
            check(len(record["chunks"]) == 3, "every chunk of the completed stream kept")

            # 5. websocket frames, both directions, with a binary frame.
            ws_flow = tflow.tflow(ws=tflow.twebsocket(messages=False))
            ws_flow.request.host = "api.openai.com"
            ws_flow.request.path = "/v1/responses"
            addon.websocket_start(ws_flow)
            ws_flow.websocket.messages.append(WebSocketMessage(1, True, b'{"type":"response.create","input":"hi"}'))
            addon.websocket_message(ws_flow)
            ws_flow.websocket.messages.append(WebSocketMessage(2, False, b"\xff\xfe\x00binary"))
            addon.websocket_message(ws_flow)
            addon.websocket_end(ws_flow)
            websocket_files = sorted(name for name in os.listdir(out) if name.endswith("-websocket.json"))
            check(len(websocket_files) == 1, "one websocket record per connection")
            record = read(out, websocket_files[0])
            check(record["schema"] == "recon-websocket/2" and record["complete"], "websocket schema and completion")
            check(len(record["frames"]) == 2, "every frame recorded")
            check(record["frames"][0]["fromClient"] and record["frames"][0]["bodyEncoding"] == "utf8", "text frame")
            check(record["frames"][1]["bodyEncoding"] == "base64", "binary frame base64")

            # 6. a secret that survives redaction is refused, never written.
            leak_request = http.Request(
                "api.anthropic.com",
                443,
                b"POST",
                b"https",
                b"api.anthropic.com",
                b"/v1/messages",
                b"HTTP/2",
                headers=header_pairs([("content-type", "text/plain")]),
                content=b"key material: -----BEGIN PRIVATE KEY-----abc",
                trailers=None,
                timestamp_start=1,
                timestamp_end=2,
            )
            addon.request(tflow.tflow(req=leak_request))
            record = latest(out, "-request.json")
            check(record["secretScan"] == "refused" and record["body"] is None, "surviving secret refused")
            check(addon.counts["refused"] == 1, "refusal counted")

            # 6b. identity: the operator's account is removed, the protocol shape is kept.
            profile = http.Request(
                "www.googleapis.com",
                443,
                b"POST",
                b"https",
                b"www.googleapis.com",
                b"/oauth2/v2/userinfo",
                b"HTTP/2",
                headers=header_pairs([("content-type", "application/json")]),
                content=json.dumps(
                    {
                        "id": "101436079838085510712",
                        "email": "someone@example.org",
                        "name": "Ada Lovelace",
                        "given_name": "Ada",
                        "family_name": "Lovelace",
                        "picture": "https://lh3.example/photo.png",
                        "note": "contact someone@example.org",
                    }
                ).encode(),
                trailers=None,
                timestamp_start=1,
                timestamp_end=2,
            )
            addon.request(tflow.tflow(req=profile))
            body = json.loads(latest(out, "-request.json")["body"])
            check(body["email"] == "<REDACTED:email>" and body["note"] == "contact <REDACTED:email>", "email redacted as a field and in prose")
            check(body["id"] == "<REDACTED:id>" and body["name"] == "<REDACTED:name>", "profile route scopes id and name")
            check(body["given_name"] == "<REDACTED:given_name>" and body["picture"] == "<REDACTED:picture>", "identity fields redacted")

            # The same `name` field off a profile route is a model name, not a person.
            model = http.Request(
                "api.anthropic.com",
                443,
                b"POST",
                b"https",
                b"api.anthropic.com",
                b"/v1/messages",
                b"HTTP/2",
                headers=header_pairs([("content-type", "application/json")]),
                content=json.dumps({"model": {"name": "claude-opus-5-5"}}).encode(),
                trailers=None,
                timestamp_start=1,
                timestamp_end=2,
            )
            addon.request(tflow.tflow(req=model))
            check(json.loads(latest(out, "-request.json")["body"])["model"]["name"] == "claude-opus-5-5", "name outside a profile route kept")

            # Claude's metadata.user_id is a JSON document carried as a string.
            nested = {"metadata": {"user_id": json.dumps({"device_id": "d-1", "account_uuid": "u-1", "session_id": "s"})}}
            nested_request = http.Request(
                "api.anthropic.com",
                443,
                b"POST",
                b"https",
                b"api.anthropic.com",
                b"/v1/messages",
                b"HTTP/2",
                headers=header_pairs([("content-type", "application/json")]),
                content=json.dumps(nested).encode(),
                trailers=None,
                timestamp_start=1,
                timestamp_end=2,
            )
            addon.request(tflow.tflow(req=nested_request))
            inner = json.loads(json.loads(latest(out, "-request.json")["body"])["metadata"]["user_id"])
            check(inner["device_id"] == "<REDACTED:device_id>" and inner["account_uuid"] == "<REDACTED:account_uuid>", "nested JSON string redacted")
            check(inner["session_id"] == "s", "non-identity nested value kept")

            # Claude Code's organisation is a UUID in the path and in three body spellings (measured 2026-10-21).
            org = "e60f8b6d-0000-4000-8000-000000000001"
            org_request = http.Request(
                "api.anthropic.com",
                443,
                b"GET",
                b"https",
                b"api.anthropic.com",
                f"/api/organizations/{org}/model_selector/cc".encode(),
                b"HTTP/2",
                headers=header_pairs([("content-type", "application/json")]),
                content=json.dumps(
                    {"organization_uuid": org, "organizationUUID": org, "accountUUID": org, "uuid": "kept-1"}
                ).encode(),
                trailers=None,
                timestamp_start=1,
                timestamp_end=2,
            )
            addon.request(tflow.tflow(req=org_request))
            org_record = latest(out, "-request.json")
            check(org not in json.dumps(org_record), "organisation UUID absent from path and body")
            check("/organizations/<REDACTED:organization>/model_selector/cc" in org_record["url"], "organisation path redacted, route kept")
            check(json.loads(org_record["body"])["uuid"] == "kept-1", "unrelated uuid field kept")

            # The OpenCode Console workspace id rides in a request header (measured 2026-10-20).
            workspace = "wrk_01AAAAAAAAAAAAAAAAAAAAAAAA"
            ws_request = http.Request(
                "opencode.ai",
                443,
                b"POST",
                b"https",
                b"opencode.ai",
                b"/inference/go/openai/v1/chat/completions",
                b"HTTP/1.1",
                headers=header_pairs([("content-type", "application/json"), ("x-opencode-org-id", workspace)]),
                content=b"{}",
                trailers=None,
                timestamp_start=1,
                timestamp_end=2,
            )
            addon.request(tflow.tflow(req=ws_request))
            ws_record = latest(out, "-request.json")
            check(workspace not in json.dumps(ws_record), "workspace id absent from the record")
            check(["x-opencode-org-id", "<REDACTED:workspace>"] in ws_record["headers"], "workspace header redacted, name kept")

            # OpenAI's user id rides in the answer stream's `safety_identifier` (measured 2026-10-24).
            openai_user = "user-AAAAAAAAAAAAAAAAAAAAAAAA"
            oa_request = http.Request(
                "api.openai.com",
                443,
                b"POST",
                b"https",
                b"api.openai.com",
                b"/v1/responses",
                b"HTTP/1.1",
                headers=header_pairs([("content-type", "application/json")]),
                content=json.dumps({"safety_identifier": openai_user, "note": "user-agent"}).encode(),
                trailers=None,
                timestamp_start=1,
                timestamp_end=2,
            )
            addon.request(tflow.tflow(req=oa_request))
            oa_record = latest(out, "-request.json")
            check(openai_user not in json.dumps(oa_record), "OpenAI user id absent from the record")
            check(json.loads(oa_record["body"])["note"] == "user-agent", "text that only starts like the pattern kept")

            # 7. transport error record.
            addon.error(tflow.tflow(err=True))
            check(latest(out, "-error.json")["error"] is not None, "transport error recorded")

            addon.done()
            index = read(out, "index.json")
            check(index["schema"] == "recon-index/2", "index schema")
            check(index["counts"]["requests"] == 8 and index["counts"]["responses"] == 6, "index counts")
            check(index["counts"]["aborted"] == 1, "index abort count")
            check(index["counts"]["clientClosed"] == 2, "index completed-after-close count")
            check(index["counts"]["connections"] == 1, "index connection count")
            check(index["counts"]["websockets"] == 1 and index["counts"]["websocketFrames"] == 2, "index websocket counts")
            check(index["counts"]["errors"] == 1, "index error count counts only failures without a response")
            check(read(out, "030-error.json")["errorClass"] == "client-disconnect", "an abort still records its reason")
            check(index["redactionManifest"] == "recon-redaction/2", "index names the manifest")

    # 8. the addon refuses to run without a redaction manifest.
    addon = addon_module.ReconAddon()
    try:
        with taddons.context(addon) as tctx:
            tctx.configure(addon, recon_out=tempfile.gettempdir())
            addon.running()
        check(False, "running without a manifest must fail")
    except RuntimeError:
        check(True, "missing manifest is fatal")

    if failures:
        for failure in failures:
            print(f"FAIL {failure}")
        print(f"{len(failures)} of {checks} checks failed")
        return 1
    print(f"PASS {checks} checks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
