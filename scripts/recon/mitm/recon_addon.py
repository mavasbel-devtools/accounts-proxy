"""Recon capture addon (plan 2026-10-19-20-04, phases R1 and R2).

Records one JSON file per request, response, WebSocket connection and transport error, one registry of client
connections and their TLS ClientHello, and (through the driver) a step timeline. The record shapes are fixed by plan
§6 (`recon-request/2`, `recon-response/3`, `recon-websocket/2`, `recon-error/2`) and §17 (`recon-connections/1`).

Contract:

* Headers are ordered `[name, value]` pairs with duplicates preserved, never objects.
* Bodies are the decoded bytes: UTF-8 when the bytes are valid UTF-8, base64 otherwise. Nothing is re-serialized, so
  field order and whitespace survive for byte-level comparison.
* A streamed response (`text/event-stream`) records one entry per chunk with its arrival time, plus `doneAtMs`. The
  callback returns the chunk unchanged: capture never alters what the client receives.
* Every record carries `wallAtMs` (epoch milliseconds on the host clock), which is what the step markers written by
  the driver use, so a flat capture can be read as a workflow.
* Every HTTP record names the client and server connection it travelled on (`clientConn`/`serverConn`), and every
  client connection's ClientHello is kept verbatim in `connections.json`: cipher order, extension order, curves and
  point formats are the material a JA3 (or any later) fingerprint is computed from, and the raw bytes make the
  computation reproducible offline.
* An aborted exchange is still recorded: when the client cancels mid-stream, the partial response (every chunk
  received before the cancellation, `aborted: true`, and the error) is written, not lost. A client that closes the
  socket after the provider's terminal event (`message_stop`, `[DONE]`, `response.completed`, a non-null
  `finish_reason`/`finishReason`) is `clientClosed: true`, complete, and not counted as an abort or an error.
* URLs are redacted like bodies: an OAuth callback or a signed link carries credentials in its query.
* Redaction runs before anything touches disk. The manifest is `scripts/recon/shared/redaction.json`, shared with the
  TypeScript redactor. A body that still matches a secret rule after redaction is refused: the record keeps headers
  and status, the body is dropped, and `secretScan` says `refused`.
* Writes are atomic (`.tmp` + `os.replace`), so a killed run never leaves a half-written record.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import time
from typing import Any
from urllib.parse import urlsplit

from mitmproxy import ctx, http

# Updater, telemetry and CDN traffic observed in R0. It is recorded anyway, labelled `noise: true`, so promotion can
# drop it without the capture ever having silently discarded evidence.
NOISE_HOSTS = re.compile(
    r"(?:^|\.)(?:browser\.events\.data\.microsoft\.com|redirector\.gvt1\.com|main\.vscode-cdn\.net|"
    r"update\.code\.visualstudio\.com|vscode\.download\.prss\.microsoft\.com|api\.github\.com|"
    r"antigravity-unleash\.goog|play\.googleapis\.com|"
    r"antigravity-ide-auto-updater-[0-9a-z-]+\.us-central1\.run\.app|"
    r"playwright(?:-[a-z]+)?\.azureedge\.net|github\.com|objects\.githubusercontent\.com|"
    r"codeload\.github\.com)$"
)

SCHEMA_REQUEST = "recon-request/2"
# /3 adds the request URL and method to the response record, and `clientClosed`: a stream whose last bytes carried a
# protocol terminal event and whose socket the client then closed is complete, not aborted.
SCHEMA_RESPONSE = "recon-response/3"
SCHEMA_WEBSOCKET = "recon-websocket/2"
SCHEMA_ERROR = "recon-error/2"
SCHEMA_CONNECTIONS = "recon-connections/1"
SCHEMA_INDEX = "recon-index/2"

# An identity header value shorter than this is not learned: replacing it everywhere would corrupt unrelated text
# (the same floor as the TypeScript redactor's known secrets).
LEARNED_MIN_LENGTH = 6

# What a stream's last bytes look like when the provider finished the answer (Anthropic, OpenAI chat, OpenAI
# Responses, Gemini). A client that closes the socket right after one of these ended a complete response; only a
# stream without any of them was cancelled mid-answer. `finish_reason` and `finishReason` are matched with a non-null
# value, because both protocols carry the key with null in every earlier chunk.
TERMINAL_PATTERNS = (
    re.compile(r"event:\s*message_stop"),
    re.compile(r'"type"\s*:\s*"message_stop"'),
    re.compile(r"\[DONE\]"),
    re.compile(r"event:\s*response\.completed"),
    re.compile(r'"type"\s*:\s*"response\.completed"'),
    re.compile(r'"finish_reason"\s*:\s*"[a-z_]+"'),
    re.compile(r'"finishReason"\s*:\s*"[A-Z_]+"'),
)



def _now_ms(started: float) -> int:
    return int((time.time() - started) * 1000)


def _wall_ms() -> int:
    return int(time.time() * 1000)


def _text(raw: bytes | str) -> str:
    return raw.decode("latin-1") if isinstance(raw, bytes) else raw


def _split_url(url: str) -> tuple[str, str]:
    parts = urlsplit(url)
    return parts.hostname or "", parts.path


def _peer(value: Any) -> list[Any] | None:
    if value is None:
        return None
    return list(value) if isinstance(value, tuple) else [value]


def _alpn(conn: Any) -> str | None:
    for attribute in ("alpn", "alpn_proto_negotiated"):
        value = getattr(conn, attribute, None)
        if value:
            return value if isinstance(value, str) else value.decode("latin-1")
    return None


def _connection(conn: Any) -> dict[str, Any]:
    """Identity and negotiated TLS parameters of one connection, as a record names it."""
    if conn is None:
        return {}
    return {
        "id": getattr(conn, "id", None),
        "peername": _peer(getattr(conn, "peername", None)),
        "sni": getattr(conn, "sni", None),
        "tlsEstablished": bool(getattr(conn, "tls_established", False)),
        "tlsVersion": getattr(conn, "tls_version", None),
        "alpn": _alpn(conn),
        "cipher": getattr(conn, "cipher", None),
    }


def _header_pairs(headers: Any) -> list[list[str]]:
    return [[name, value] for name, value in headers.items(multi=True)] if headers else []


def _u16_list(body: bytes) -> list[int]:
    """A vector of 2-byte values with its own 2-byte length prefix (supported_groups, signature_algorithms)."""
    if len(body) < 2:
        return []
    length = int.from_bytes(body[:2], "big")
    values = body[2 : 2 + length]
    return [int.from_bytes(values[i : i + 2], "big") for i in range(0, len(values) - 1, 2)]


def _u8_list(body: bytes) -> list[int]:
    if not body:
        return []
    length = body[0]
    return list(body[1 : 1 + length])


def _hello_summary(hello: Any) -> dict[str, Any]:
    """ClientHello as offered: the exact inputs of a JA3 fingerprint, plus the raw bytes it came from."""
    raw: bytes = hello.raw_bytes(wrap_in_record=False)
    extensions = hello.extensions
    groups = next((_u16_list(body) for kind, body in extensions if kind == 10), [])
    formats = next((_u8_list(body) for kind, body in extensions if kind == 11), [])
    signatures = next((_u16_list(body) for kind, body in extensions if kind == 13), [])
    ciphers = list(hello.cipher_suites)
    extension_types = [kind for kind, _ in extensions]
    # JA3 (Salesforce): MD5 of version,ciphers,extensions,curves,point-formats in the order the client sent them.
    # Values are never filtered or reordered: a fingerprint is only useful if it is exactly what the wire carried.
    ja3 = ",".join(
        [
            str(int.from_bytes(raw[0:2], "big")),
            "-".join(str(value) for value in ciphers),
            "-".join(str(value) for value in extension_types),
            "-".join(str(value) for value in groups),
            "-".join(str(value) for value in formats),
        ]
    )
    alpn = []
    for value in hello.alpn_protocols:
        alpn.append(value.decode("latin-1") if isinstance(value, bytes) else value)
    return {
        "sni": hello.sni,
        "alpnOffers": alpn,
        "cipherSuites": ciphers,
        "extensions": [{"type": kind, "data": base64.b64encode(body).decode("ascii")} for kind, body in extensions],
        "supportedGroups": groups,
        "ecPointFormats": formats,
        "signatureAlgorithms": signatures,
        "ja3": ja3,
        "ja3Hash": hashlib.md5(ja3.encode("ascii")).hexdigest(),
        "raw": base64.b64encode(raw).decode("ascii"),
        "rawBytes": len(raw),
    }


class Decompressor:
    """Incremental decoder for a streamed body, so chunk boundaries reflect arrival, not compression framing."""

    def __init__(self, encoding: str) -> None:
        self.encoding = encoding
        self.decoded = False

    def feed(self, chunk: bytes) -> bytes:
        if not chunk:
            return b""
        if self.encoding in ("", "identity"):
            return chunk
        try:
            import zlib

            if self.encoding in ("gzip", "x-gzip"):
                if not hasattr(self, "_zlib"):
                    self._zlib = zlib.decompressobj(16 + zlib.MAX_WBITS)
                self.decoded = True
                return self._zlib.decompress(chunk)
            if self.encoding == "deflate":
                if not hasattr(self, "_zlib"):
                    self._zlib = zlib.decompressobj()
                self.decoded = True
                return self._zlib.decompress(chunk)
            if self.encoding == "br":
                import brotli  # type: ignore[import-not-found]

                if not hasattr(self, "_br"):
                    self._br = brotli.Decompressor()
                self.decoded = True
                return self._br.process(chunk)
        except Exception:  # noqa: BLE001 - capture must never break the request path
            return chunk
        return chunk


def _stream_terminated(streamed: dict[str, Any]) -> bool:
    """True when the stream's tail carried a protocol terminal event, i.e. the provider finished the answer."""
    tail = streamed.get("tail") or ""
    return any(pattern.search(tail) for pattern in TERMINAL_PATTERNS)


def _field_patterns(field: str) -> list[re.Pattern[str]]:
    """Both spellings of one JSON field: plain, and escaped inside a JSON-encoded string value.

    Claude's `metadata.user_id` is a JSON document carried as a string, so its `device_id` and `account_uuid` appear on
    the wire as `\\"device_id\\":\\"...\\"`. A plain field pattern cannot see them; the escaped variant is the same rule
    applied to that nesting.
    """
    return [
        re.compile(r'("' + re.escape(field) + r'"\s*:\s*")(?:[^"\\]|\\.)*(")'),
        re.compile(r'(\\"' + re.escape(field) + r'\\"\s*:\s*\\")(?:[^"\\]|\\.)*?(\\")'),
    ]


class ReconAddon:
    def __init__(self) -> None:
        self.seq = 0
        self.started = time.time()
        self.manifest: dict[str, Any] = {}
        self.max_body = 32 * 1024 * 1024
        self.connections: list[dict[str, Any]] = []
        self.counts = {
            "requests": 0,
            "responses": 0,
            "aborted": 0,
            "clientClosed": 0,
            "websockets": 0,
            "websocketFrames": 0,
            "connections": 0,
            "errors": 0,
            "noise": 0,
            "tunneled": 0,
            "refused": 0,
            "truncated": 0,
        }

    # ------------------------------------------------------------------ options

    def load(self, loader: Any) -> None:
        loader.add_option("recon_out", str, "", "Directory for capture records")
        loader.add_option("recon_client", str, "unknown", "Client label")
        loader.add_option("recon_client_version", str, "unknown", "Exact client version")
        loader.add_option("recon_cell", str, "unknown", "Provider cell the client targets")
        loader.add_option("recon_run", str, "run", "Run label")
        loader.add_option("recon_scenario", str, "", "Scenario id, when the run is generated from the matrix")
        loader.add_option("recon_redaction", str, "", "Path to shared/redaction.json (required)")
        loader.add_option("recon_max_body", int, 32 * 1024 * 1024, "Maximum captured body bytes per message")
        loader.add_option(
            "recon_intercept_hosts",
            str,
            "",
            "Regex of SNI values to intercept; everything else is passed through unmodified",
        )

    def running(self) -> None:
        path = ctx.options.recon_redaction
        if not path:
            raise RuntimeError("recon_redaction is required: capture never runs without a redaction manifest")
        with open(path, encoding="utf-8") as handle:
            self.manifest = json.load(handle)
        if self.manifest.get("schema") != "recon-redaction/3":
            raise RuntimeError(f"unexpected redaction manifest schema: {self.manifest.get('schema')}")
        self.max_body = int(ctx.options.recon_max_body)
        self._credential_headers = {name.lower() for name in self.manifest["credentialHeaders"]}
        self._identity_headers = {name.lower() for name in self.manifest["identityHeaders"]}
        # Values carried by an identity header (the ChatGPT account id), learned as the run sees them and redacted
        # wherever they appear afterwards: the same id comes back as a bare array element or object `id`, which no
        # field rule can name (measured 2026-10-25, Codex `wham/accounts/check`).
        self._learned: dict[str, str] = {}
        self._credential_fields = list(self.manifest["credentialFields"])
        self._identity_fields = list(self.manifest["identityFields"])
        self._query_fields = list(self.manifest["queryCredentialFields"])
        self._prefixes = list(self.manifest["tokenPrefixes"])
        self._markers = list(self.manifest["forbiddenMarkers"])
        self._tail = int(self.manifest["tokenBodyMinTail"])
        self._field_patterns = [
            (field, pattern)
            for field in self._credential_fields
            for pattern in _field_patterns(field)
        ]
        # Identity fields are redacted wherever they appear, including inside a JSON-encoded string such as Claude's
        # metadata.user_id, which is why the escaped variant exists.
        self._identity_patterns = [
            (field, pattern)
            for field in self._identity_fields
            for pattern in _field_patterns(field)
        ]
        self._value_patterns = [
            (item["name"], re.compile(item["regex"]))
            for item in self.manifest.get("identityPatterns", [])
        ]
        self._scoped = [
            (item["host"].lower(), item["pathPrefix"], set(item["fields"]))
            for item in self.manifest.get("identityScoped", [])
        ]
        query = "|".join(re.escape(field) for field in self._query_fields)
        self._query_pattern = re.compile(r"((?:^|[?&\s,])(?:" + query + r")=)[^&\s\"']+", re.IGNORECASE)
        prefix = "|".join(re.escape(p) for p in self._prefixes)
        self._token_pattern = re.compile("(?:" + prefix + r")[A-Za-z0-9_\-./+=]{" + str(self._tail) + r",}")
        self._bearer_pattern = re.compile(r"Bearer\s+[A-Za-z0-9_\-./+=]{20,}")
        pattern = ctx.options.recon_intercept_hosts
        self._intercept = re.compile(pattern) if pattern else None

    # ------------------------------------------------------------------ redaction

    def _scope_fields(self, scope: tuple[str, str] | None) -> set[str]:
        """Identity field names the manifest scopes to this endpoint (`id`/`name` are a person on a profile route)."""
        if scope is None:
            return set()
        host, path = scope
        fields: set[str] = set()
        for rule_host, prefix, names in self._scoped:
            if rule_host == host.lower() and path.startswith(prefix):
                fields |= names
        return fields

    def _redact_text(
        self, text: str, where: str = "body", scope: tuple[str, str] | None = None
    ) -> tuple[str, list[dict[str, str]]]:
        redactions: list[dict[str, str]] = []

        def note(name: str, rule: str) -> None:
            entry = {"where": where, "name": name, "rule": rule}
            if entry not in redactions:
                redactions.append(entry)

        for value, name in self._learned.items():
            if value in text:
                text = text.replace(value, f"<REDACTED:{name}>")
                note(name, "identity-value")
        for field, pattern in self._field_patterns:
            text, count = pattern.subn(lambda m, f=field: m.group(1) + f"<REDACTED:{f}>" + m.group(2), text)
            if count:
                note(field, "credential-field")
        for field, pattern in self._identity_patterns:
            text, count = pattern.subn(lambda m, f=field: m.group(1) + f"<REDACTED:{f}>" + m.group(2), text)
            if count:
                note(field, "identity-field")
        for field in self._scope_fields(scope):
            for pattern in _field_patterns(field):
                text, count = pattern.subn(lambda m, f=field: m.group(1) + f"<REDACTED:{f}>" + m.group(2), text)
                if count:
                    note(field, "identity-scoped")
        for name, pattern in self._value_patterns:
            text, count = pattern.subn(f"<REDACTED:{name}>", text)
            if count:
                note(name, "identity-pattern")
        text, count = self._query_pattern.subn(lambda m: m.group(1) + "<REDACTED:field>", text)
        if count:
            note("query", "credential-query")
        text, count = self._token_pattern.subn("<REDACTED:token>", text)
        if count:
            note("token", "token-prefix")
        return text, redactions

    def _redact_url(self, url: str) -> tuple[str, list[dict[str, str]]]:
        """A URL is as sensitive as a body: an OAuth callback and a signed link both carry credentials in the query."""
        return self._redact_text(url, where="url")

    def _scan(self, text: str) -> list[str]:
        hits = []
        match = self._token_pattern.search(text)
        if match:
            hits.append(f"token-prefix:{match.group(0)[:12]}")
        match = self._bearer_pattern.search(text)
        if match:
            hits.append("bearer-token")
        for marker in self._markers:
            if marker in text:
                hits.append(f"private-key:{marker}")
        return hits

    def _redact_headers(self, pairs: list[tuple[str, str]]) -> tuple[list[list[str]], list[dict[str, str]]]:
        out: list[list[str]] = []
        redactions: list[dict[str, str]] = []
        for name, value in pairs:
            if name.lower() in self._credential_headers:
                scheme = re.match(r"^(Bearer|Basic)\s+", value, re.IGNORECASE)
                out.append([name, f"{scheme.group(1)} <REDACTED:{name.lower()}>" if scheme else f"<REDACTED:{name.lower()}>"])
                entry = {"where": "header", "name": name.lower(), "rule": "credential-header"}
                if entry not in redactions:
                    redactions.append(entry)
            elif name.lower() in self._identity_headers:
                if len(value) >= LEARNED_MIN_LENGTH:
                    self._learned.setdefault(value, name.lower())
                out.append([name, f"<REDACTED:{name.lower()}>"])
                entry = {"where": "header", "name": name.lower(), "rule": "identity-header"}
                if entry not in redactions:
                    redactions.append(entry)
            else:
                redacted, found = self._redact_text(value)
                out.append([name, redacted])
                redactions.extend(found)
        return out, redactions

    # ------------------------------------------------------------------ body

    def _body(self, raw: bytes, scope: tuple[str, str] | None = None) -> dict[str, Any]:
        original = len(raw)
        truncated = original > self.max_body
        if truncated:
            self.counts["truncated"] += 1
            raw = raw[: self.max_body]
        entry: dict[str, Any] = {"truncated": truncated, "originalBytes": original}
        try:
            text = raw.decode("utf-8")
            entry["bodyEncoding"] = "utf8"
        except UnicodeDecodeError:
            entry["bodyEncoding"] = "base64"
            entry["body"] = base64.b64encode(raw).decode("ascii")
            scan_text = raw.decode("latin-1")
            hits = self._scan(scan_text)
            entry["secretScan"] = "clean" if not hits else "refused"
            if hits:
                entry["secretScanHits"] = hits
                entry["body"] = None
                self.counts["refused"] += 1
            return entry
        redacted, redactions = self._redact_text(text, scope=scope)
        hits = self._scan(redacted)
        entry["body"] = redacted
        entry["redactions"] = redactions
        entry["secretScan"] = "clean" if not hits else "refused"
        if hits:
            entry["secretScanHits"] = hits
            entry["body"] = None
            self.counts["refused"] += 1
        return entry

    # ------------------------------------------------------------------ io

    def _write(self, record: dict[str, Any], suffix: str, seq: int) -> None:
        out = ctx.options.recon_out
        if not out:
            return
        os.makedirs(out, exist_ok=True)
        record["seq"] = seq
        path = os.path.join(out, f"{seq:03d}-{suffix}.json")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(record, handle, indent=2, ensure_ascii=False)
        os.replace(tmp, path)

    def _write_connections(self) -> None:
        out = ctx.options.recon_out
        if not out:
            return
        os.makedirs(out, exist_ok=True)
        record = self._base(SCHEMA_CONNECTIONS)
        record["connections"] = self.connections
        path = os.path.join(out, "connections.json")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(record, handle, indent=2, ensure_ascii=False)
        os.replace(tmp, path)

    def _base(self, schema: str) -> dict[str, Any]:
        record: dict[str, Any] = {
            "schema": schema,
            "run": ctx.options.recon_run,
            "client": ctx.options.recon_client,
            "clientVersion": ctx.options.recon_client_version,
            "cell": ctx.options.recon_cell,
            "mode": "mitm",
        }
        if ctx.options.recon_scenario:
            record["scenario"] = ctx.options.recon_scenario
        return record

    # ------------------------------------------------------------------ hooks

    def tls_clienthello(self, data: Any) -> None:
        """
        Record what the client offered before mitmproxy answered, once per client connection.

        When `recon_intercept_hosts` is set, a connection whose SNI does not match is tunneled with the real
        certificate instead of intercepted. R0 measured why: a Chromium-based client (Antigravity) rejects mitmproxy's
        minted leaf on its updater, telemetry and CDN hosts even with the CA trusted, while the language server's API
        hosts accept it. The ClientHello is recorded either way, and the entry says whether the connection was
        intercepted, so a tunneled connection is never mistaken for an uninspected one.
        """
        hello = data.client_hello
        connection = _connection(getattr(getattr(data, "context", None), "client", None))
        summary = _hello_summary(hello)
        intercepted = self._intercept is None or bool(self._intercept.search(hello.sni or ""))
        if not intercepted:
            data.ignore_connection = True
            self.counts["tunneled"] += 1
        entry = {"wallAtMs": _wall_ms(), **connection, **summary, "intercepted": intercepted}
        # A connection that renegotiates (rare) must not produce two entries with one id.
        self.connections = [item for item in self.connections if item.get("id") != entry.get("id")]
        self.connections.append(entry)
        self.counts["connections"] = len(self.connections)
        self._write_connections()

    def tls_established_client(self, data: Any) -> None:
        """
        Fill the negotiated parameters into the connection entry the ClientHello wrote.

        The hello is captured before the handshake answers, so `tlsEstablished`, the negotiated ALPN and the cipher are
        unknown at that point. Without this hook the registry would say `alpn: null` for every connection and a gap
        report could not distinguish "offered h2" from "negotiated h2".
        """
        conn = getattr(data, "conn", None)
        if conn is None:
            return
        entry = next((item for item in self.connections if item.get("id") == getattr(conn, "id", None)), None)
        if entry is None:
            return
        cipher = getattr(conn, "cipher", None)
        entry.update(
            {
                "tlsEstablished": bool(getattr(conn, "tls_established", False)),
                "tlsVersion": getattr(conn, "tls_version", None),
                "alpn": _alpn(conn),
                "cipher": list(cipher) if isinstance(cipher, tuple) else cipher,
            }
        )
        self._write_connections()

    def request(self, flow: http.HTTPFlow) -> None:
        self.seq += 1
        seq = self.seq
        flow.metadata["recon_seq"] = seq
        flow.metadata["recon_at"] = time.time()
        request = flow.request
        headers, redactions = self._redact_headers(list(request.headers.items(multi=True)))
        body = self._body(request.get_content(strict=False) or b"", (request.host, request.path))
        url, url_redactions = self._redact_url(request.pretty_url)
        redactions.extend(url_redactions)
        host, _ = _split_url(request.pretty_url)
        record = self._base(SCHEMA_REQUEST)
        record.update(
            {
                "seq": seq,
                "flowId": flow.id,
                "wallAtMs": _wall_ms(),
                "atMs": _now_ms(self.started),
                "method": request.method,
                "url": url,
                "httpVersion": request.http_version,
                "headers": headers,
                "trailers": _header_pairs(request.trailers),
                "clientConn": _connection(flow.client_conn),
                "serverConn": _connection(flow.server_conn),
                "noise": bool(NOISE_HOSTS.search(host)),
                **body,
            }
        )
        if redactions:
            record["redactions"] = redactions + list(record.get("redactions", []))
        self.counts["requests"] += 1
        if record["noise"]:
            self.counts["noise"] += 1
        self._write(record, "request", seq)

    def responseheaders(self, flow: http.HTTPFlow) -> None:
        flow.metadata["recon_headers_at"] = time.time()
        response = flow.response
        if response is None:
            return
        content_type = response.headers.get("content-type", "").lower()
        if "text/event-stream" not in content_type:
            return
        encoding = response.headers.get("content-encoding", "").lower()
        state: dict[str, Any] = {
            "chunks": [],
            "decoder": Decompressor(encoding),
            "encoding": encoding,
            "ended": None,
            # The last kilobytes of the decoded stream: enough to see the protocol's terminal event even when it is the
            # very last write, without holding a second copy of a multi-megabyte body.
            "tail": "",
        }
        flow.metadata["recon_stream"] = state

        def sink(chunk: bytes) -> bytes:
            if chunk:
                decoded = state["decoder"].feed(chunk)
                state["chunks"].append((time.time(), decoded))
                state["tail"] = (state["tail"] + decoded.decode("utf-8", "replace"))[-8192:]
            else:
                state["ended"] = time.time()
            return chunk

        response.stream = sink

    @staticmethod
    def _event_name(text: str) -> str | None:
        """The event name of one SSE frame: the `event:` line, or the `type` of a data-only frame (OpenAI)."""
        for line in text.splitlines():
            if line.startswith("event:"):
                return line[len("event:") :].strip() or None
        for line in text.splitlines():
            if not line.startswith("data:"):
                continue
            payload = line[len("data:") :].strip()
            if not payload.startswith("{"):
                continue
            try:
                body = json.loads(payload)
            except ValueError:
                continue
            if isinstance(body, dict) and isinstance(body.get("type"), str):
                return body["type"]
        return None

    def _stream_record(self, flow: http.HTTPFlow, ended_at: float, aborted: bool) -> tuple[dict[str, Any], list[dict[str, str]]]:
        streamed = flow.metadata["recon_stream"]
        redactions: list[dict[str, str]] = []
        chunks: list[dict[str, Any]] = []
        frames: list[dict[str, Any]] = []
        scan_hits: list[str] = []
        # Network chunks are not frames: one frame spans several TCP reads. The carry buffer reassembles them so the
        # record says where each logical SSE event started and ended, which is what stream framing is judged on.
        carry = ""
        for when, chunk in streamed["chunks"]:
            text = chunk.decode("utf-8", "replace")
            redacted, found = self._redact_text(text, scope=(flow.request.host, flow.request.path))
            scan_hits.extend(self._scan(redacted))
            at_ms = int((when - self.started) * 1000)
            entry: dict[str, Any] = {
                "atMs": at_ms,
                "bytes": len(chunk),
                "text": redacted,
                "redactions": found,
            }
            event = self._event_name(text)
            if event is not None:
                entry["event"] = event
            chunks.append(entry)
            redactions.extend(found)
            carry += redacted.replace("\r\n", "\n")
            while "\n\n" in carry:
                frame, carry = carry.split("\n\n", 1)
                frames.append({"atMs": at_ms, "event": self._event_name(frame), "bytes": len(frame.encode("utf-8")) + 2})
        if carry:
            frames.append({"atMs": int((ended_at - self.started) * 1000), "event": self._event_name(carry), "bytes": len(carry.encode("utf-8")), "complete": False})
        record: dict[str, Any] = {
            "bodyEncoding": "utf8",
            "chunks": chunks,
            "frames": frames,
            "doneAtMs": int((ended_at - self.started) * 1000),
            "streamed": True,
            "aborted": aborted,
            "secretScan": "clean" if not scan_hits else "refused",
        }
        if scan_hits:
            record["secretScanHits"] = scan_hits
            for chunk in chunks:
                chunk["text"] = None
            self.counts["refused"] += 1
        return record, redactions

    def response(self, flow: http.HTTPFlow) -> None:
        response = flow.response
        if response is None:
            return
        seq = int(flow.metadata.get("recon_seq", self.seq))
        at = float(flow.metadata.get("recon_headers_at", time.time()))
        headers, redactions = self._redact_headers(list(response.headers.items(multi=True)))
        url, url_redactions = self._redact_url(flow.request.pretty_url)
        redactions.extend(url_redactions)
        host, _ = _split_url(flow.request.pretty_url)
        record = self._base(SCHEMA_RESPONSE)
        record.update(
            {
                "seq": seq,
                "flowId": flow.id,
                "wallAtMs": _wall_ms(),
                "url": url,
                "method": flow.request.method,
                "status": response.status_code,
                "httpVersion": response.http_version,
                "headers": headers,
                "trailers": _header_pairs(response.trailers),
                "headersAtMs": int((at - self.started) * 1000),
                "clientConn": _connection(flow.client_conn),
                "serverConn": _connection(flow.server_conn),
                "noise": bool(NOISE_HOSTS.search(host)),
            }
        )
        streamed = flow.metadata.get("recon_stream")
        if streamed is not None:
            body_record, found = self._stream_record(flow, streamed["ended"] or time.time(), aborted=False)
            record.update(body_record)
            redactions.extend(found)
        else:
            record.update(self._body(response.get_content(strict=False) or b"", (flow.request.host, flow.request.path)))
            record["streamed"] = False
            record["aborted"] = False
            record["doneAtMs"] = _now_ms(self.started)
        record["clientClosed"] = False
        if redactions:
            record["redactions"] = redactions
        if flow.error is not None:
            record["error"] = str(flow.error)
        self.counts["responses"] += 1
        self._write(record, "response", seq)

    # ------------------------------------------------------------------ websocket

    def _write_websocket(self, flow: http.HTTPFlow, complete: bool) -> None:
        seq = int(flow.metadata.get("recon_ws_seq", self.seq))
        frames = flow.metadata.get("recon_ws_frames", [])
        websocket = flow.websocket
        record = self._base(SCHEMA_WEBSOCKET)
        record.update(
            {
                "seq": seq,
                "flowId": flow.id,
                "url": self._redact_url(flow.request.pretty_url)[0],
                "httpVersion": flow.request.http_version,
                "wallAtMs": _wall_ms(),
                "openedAtMs": int((flow.metadata.get("recon_ws_at", time.time()) - self.started) * 1000),
                "clientConn": _connection(flow.client_conn),
                "serverConn": _connection(flow.server_conn),
                "complete": complete,
                "frames": frames,
            }
        )
        if websocket is not None:
            record["closeCode"] = websocket.close_code
            record["closeReason"] = websocket.close_reason
            record["closedByClient"] = websocket.closed_by_client
        self._write(record, "websocket", seq)

    def websocket_start(self, flow: http.HTTPFlow) -> None:
        self.seq += 1
        flow.metadata["recon_ws_seq"] = self.seq
        flow.metadata["recon_ws_at"] = time.time()
        flow.metadata["recon_ws_frames"] = []
        self.counts["websockets"] += 1
        self._write_websocket(flow, complete=False)

    def websocket_message(self, flow: http.HTTPFlow) -> None:
        websocket = flow.websocket
        if websocket is None or not websocket.messages:
            return
        message = websocket.messages[-1]
        raw: bytes = message.content or b""
        try:
            text = raw.decode("utf-8")
            redacted, redactions = self._redact_text(text, scope=(flow.request.host, flow.request.path))
            scan = self._scan(redacted)
            frame: dict[str, Any] = {
                "wallAtMs": _wall_ms(),
                "atMs": _now_ms(self.started),
                "fromClient": message.from_client,
                "opcode": int(getattr(message.type, "value", message.type)),
                "bodyEncoding": "utf8",
                "bytes": len(raw),
                "text": None if scan else redacted,
                "secretScan": "clean" if not scan else "refused",
            }
            if redactions:
                frame["redactions"] = redactions
            if scan:
                frame["secretScanHits"] = scan
                self.counts["refused"] += 1
        except UnicodeDecodeError:
            frame = {
                "wallAtMs": _wall_ms(),
                "atMs": _now_ms(self.started),
                "fromClient": message.from_client,
                "opcode": int(getattr(message.type, "value", message.type)),
                "bodyEncoding": "base64",
                "bytes": len(raw),
                "body": base64.b64encode(raw[: self.max_body]).decode("ascii"),
                "secretScan": "clean",
            }
        flow.metadata["recon_ws_frames"].append(frame)
        self.counts["websocketFrames"] += 1
        self._write_websocket(flow, complete=False)

    def websocket_end(self, flow: http.HTTPFlow) -> None:
        self._write_websocket(flow, complete=True)

    # ------------------------------------------------------------------ errors and index

    @staticmethod
    def _error_class(message: str) -> str:
        lowered = message.lower()
        if "client disconnected" in lowered or "client connection closed" in lowered:
            return "client-disconnect"
        if "stream reset" in lowered or "stream closed" in lowered or "rst_stream" in lowered:
            return "stream-reset"
        if "reset by peer" in lowered or "connection reset" in lowered:
            return "connection-reset"
        if "timed out" in lowered or "timeout" in lowered:
            return "timeout"
        if "tls" in lowered or "certificate" in lowered:
            return "tls"
        return "other"

    def error(self, flow: http.HTTPFlow) -> None:
        if "recon_seq" in flow.metadata:
            seq = int(flow.metadata["recon_seq"])
        else:
            self.seq += 1
            seq = self.seq
        message = str(flow.error) if flow.error else None
        host, _ = _split_url(flow.request.pretty_url) if flow.request else ("", "")
        wrote_response = os.path.exists(os.path.join(ctx.options.recon_out, f"{seq:03d}-response.json"))
        if wrote_response:
            # The response hook runs only after the whole response (or stream) has been delivered, so a transport error
            # after it is the client closing a finished exchange — the same `clientClosed` case as below, just observed
            # from the other side. It is not an error the exchange suffered, and recording it as one would put an error
            # on every ordinary 401 or on every client that hangs up after the last SSE frame.
            self._mark_client_closed(seq)
            return
        # A cancelled stream is the one case where the response hook never runs. The chunks received before the
        # cancellation are evidence of how the client framed and consumed the stream, so they are written here.
        # A socket the client closes *after* the provider's terminal event is not a cancellation: the answer was
        # delivered, the client merely did not wait for the server to close first. That case is `clientClosed`, and it
        # must not be counted as an abort or an error, or every opencode run would look like three cancelled streams.
        finished = "recon_stream" in flow.metadata and _stream_terminated(flow.metadata["recon_stream"])
        if "recon_stream" in flow.metadata:
            response = flow.response
            streamed = flow.metadata["recon_stream"]
            headers, redactions = self._redact_headers(list(response.headers.items(multi=True))) if response else ([], [])
            url, url_redactions = self._redact_url(flow.request.pretty_url) if flow.request else (None, [])
            redactions.extend(url_redactions)
            chunks = streamed["chunks"]
            record = self._base(SCHEMA_RESPONSE)
            record.update(
                {
                    "seq": seq,
                    "flowId": flow.id,
                    "wallAtMs": _wall_ms(),
                    "url": url,
                    "method": flow.request.method if flow.request else None,
                    "status": response.status_code if response else None,
                    "httpVersion": response.http_version if response else None,
                    "headers": headers,
                    "trailers": _header_pairs(response.trailers) if response else [],
                    "headersAtMs": int((float(flow.metadata.get("recon_headers_at", time.time())) - self.started) * 1000),
                    "clientConn": _connection(flow.client_conn),
                    "serverConn": _connection(flow.server_conn),
                    "noise": bool(NOISE_HOSTS.search(host)),
                    "clientClosed": finished,
                }
            )
            if not finished:
                record["error"] = message
            body_record, found = self._stream_record(
                flow,
                chunks[-1][0] if finished and chunks else time.time(),
                aborted=not finished,
            )
            record.update(body_record)
            redactions.extend(found)
            if redactions:
                record["redactions"] = redactions
            self.counts["responses"] += 1
            self.counts["clientClosed" if finished else "aborted"] += 1
            self._write(record, "response", seq)
        if finished:
            # The exchange completed; the socket close is transport noise, not an error the client caused.
            return
        record = self._base(SCHEMA_ERROR)
        record.update(
            {
                "seq": seq,
                "flowId": flow.id,
                "wallAtMs": _wall_ms(),
                "atMs": _now_ms(self.started),
                "url": self._redact_url(flow.request.pretty_url)[0] if flow.request else None,
                "clientConn": _connection(flow.client_conn),
                "serverConn": _connection(flow.server_conn),
                "error": message,
                "errorClass": self._error_class(message or ""),
                "noise": bool(NOISE_HOSTS.search(host)),
            }
        )
        # A client cancellation is classified by `aborted`, not counted again as an error: the error record keeps the
        # reason, but `counts.errors` means an exchange that failed without delivering a response.
        if "recon_stream" not in flow.metadata:
            self.counts["errors"] += 1
        self._write(record, "error", seq)

    def _mark_client_closed(self, seq: int) -> None:
        """Mark an already-written response as `clientClosed`, once, when the client hangs up after it was delivered."""
        path = os.path.join(ctx.options.recon_out, f"{seq:03d}-response.json")
        try:
            with open(path, encoding="utf-8") as handle:
                record = json.load(handle)
        except (OSError, ValueError):
            return
        if record.get("clientClosed") is True:
            return
        record["clientClosed"] = True
        self.counts["clientClosed"] += 1
        self._write(record, "response", seq)

    def done(self) -> None:
        out = ctx.options.recon_out
        if not out:
            return
        os.makedirs(out, exist_ok=True)
        self._write_connections()
        index = self._base(SCHEMA_INDEX)
        index.update(
            {
                "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "wallAtMs": _wall_ms(),
                "durationMs": _now_ms(self.started),
                "redactionManifest": self.manifest.get("schema"),
                "counts": self.counts,
            }
        )
        path = os.path.join(out, "index.json")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(index, handle, indent=2, ensure_ascii=False)
        os.replace(tmp, path)


addons = [ReconAddon()]
