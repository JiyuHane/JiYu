# OneBot 12 support

`@harehane/sdk/v12` provides an independent OneBot 12 application-side API. It
is separate from the existing OneBot 11 clients and does not change their
behaviour. The implementation follows selected parts of the
[OneBot 12 candidate standard](https://12.onebot.dev/); consult the connected
implementation's `get_supported_actions` result for its capabilities.

## HTTP

```ts
import { OneBot12HttpClient } from '@harehane/sdk/v12';

const client = new OneBot12HttpClient({
    baseUrl: 'http://127.0.0.1:3012/',
    accessToken: 'YOUR_ACCESS_TOKEN',
});
const response = await client.request('get_version', {});
if (response.status === 'failed') {
    console.error(response.retcode, response.message);
}
```

HTTP actions use a JSON `POST` to `/`. Business failures are returned as
OneBot response objects; HTTP, protocol, timeout and cancellation failures
throw `OneBot12ClientError`. Supply `self` explicitly in request options when
an implementation serves multiple accounts. As a local consistency policy, the
SDK rejects an action response claiming `status: "ok"` with a nonzero `retcode`;
it does not report that response as a successful action. HTTP and ordinary
correlated WebSocket responses report `invalid_response`. A WebSocket frame that
also has a complete event shape remains an ambiguous protocol error instead of
being delivered as either kind. The SDK still accepts `status: "failed"` with
`retcode: 0` for compatibility, and preserves valid response extensions. The
client never automatically retries an action. A timeout or disconnected transport
does not prove that an action's side effects did not occur.

For a nonempty requested `echo`, the HTTP client defaults to requiring the same
response `echo`. The [candidate response specification](https://12.onebot.dev/connect/data-protocol/action-response/)
recommends returning it; to interoperate with an implementation that omits this
recommended field, set `missingEchoPolicy: 'allow'` on the HTTP client. This
accepts only an absent response `echo`: an echo that is present but different,
non-string or duplicated still fails. The option does not synthesize an echo,
change empty-request-echo handling, or apply to WebSocket clients. HTTP's
request/response association does not itself establish the peer's identity.

`maxResponseBytes` limits the UTF-8 body bytes delivered by Fetch, after any
content decoding Fetch performs. With a non-identity `Content-Encoding`, the
client ignores `Content-Length` for the preliminary size check and enforces the
limit while reading the body. With no encoding or `identity`, the preliminary
check relies on the declared length matching the delivered body: incorrect headers
or a custom Fetch implementation that changes the body can cause early rejection.
This limit does not bound encoded network traffic, bandwidth, or buffering already
performed by Fetch; custom Fetch implementations may deliver bytes without
decompression.

### Polling events on a supporting implementation

`client.getLatestEvents({ limit, timeout }, options)` sends the OneBot 12
`get_latest_events` action through HTTP. The connected implementation must
support it; **Jiyu's current v12 HTTP server does not yet implement event
polling**. The standard requires this action for HTTP, but implementations may
omit it from `get_supported_actions`. WebSocket clients retain their generic
`request` interface; the standard does not require this action over WebSocket.

`limit` and `timeout` are optional nonnegative safe integers. They default to
server-side zero when omitted: `limit: 0` places no protocol count limit and
`timeout: 0` uses short polling. `timeout` is the server's wait in **seconds**;
`options.timeoutMs` is the client's total request deadline in **milliseconds**,
defaulting to 30,000. Use an appropriate client deadline with network margin,
or set `timeoutMs: 0` to disable that client deadline. Where the host supports
native `AbortSignal.any`, the SDK uses a dependent signal so an earlier source
listener calling `stopImmediatePropagation()` does not block cancellation. In
older environments without `AbortSignal.any`, the ordinary listener fallback
can still be blocked this way. Use trusted native signals and built-ins;
cross-realm compatibility depends on the host. The SDK does not alter either
timeout or retry.
Cancellation or a lost response does not establish server-side cancellation,
queue rollback, or event delivery; a retry may lose or duplicate observations.

A successful response retains its envelope and extension fields and exposes an
array of non-meta events after checking only their common event fields. Unknown
`detail_type`, `sub_type`, and JSON extension fields are preserved, while
message-specific fields are not validated or typed. A business failure is
returned unchanged with its original arbitrary JSON `data`; malformed success
data raises `OneBot12ClientError` with code `invalid_response`. Existing JSON
size, structure and safe-number policies still apply, including when `limit` is
zero. Parameter snapshots avoid invoking ordinary getters, but JavaScript proxy
reflection traps may execute; do not treat the codec as isolation from hostile
same-process code.

## Forward WebSocket

```ts
import { OneBot12WebSocketClient } from '@harehane/sdk/v12';

const client = new OneBot12WebSocketClient({
    url: 'ws://127.0.0.1:3012/',
    accessToken: 'YOUR_ACCESS_TOKEN',
    // Browser WebSocket cannot set Authorization headers.
    tokenTransport: 'query',
});
client.onEvent((event) => console.log(event.type, event.detail_type));
await client.connect();
const response = await client.request('get_status', {});
console.log(response.status);
client.close();
```

Browser query-token transport is opt-in because URLs can be retained by
reverse proxies and other infrastructure. Configure intermediaries not to log
query strings, and use TLS termination when traffic leaves a trusted local
connection. The client does not automatically reconnect or replay requests.

## Reverse WebSocket (Node.js)

The Node-only `@harehane/sdk/v12/node` entry provides
`createOneBot12ReverseWebSocketServer`. Each implementation connection is a
separate session: select that session when sending an action and use the
complete `{ platform, user_id }` identity for account-specific event handling.
A connection alone does not establish that a particular account is online.

## `get_file` URL subset

`@harehane/sdk/v12` exports `OneBot12GetFileUrlParams`,
`OneBot12GetFileUrlData` and `OneBot12GetFileUrlResponse` as optional type
annotations for the `get_file` URL subset. Parameters have a string `file_id`
and `type: 'url'`. Successful response data has string `name` and `url` fields;
for implementations that provide them, it may also contain `headers` as a
string-to-string map and `sha256` as a string. The failed response branch keeps
arbitrary JSON `data`. JSON extension fields remain permitted by the types.
Jiyu currently returns only `name` and `url` on success, and rejects extra
request parameters.

Use the existing generic request method, for example:

```ts
import type { OneBot12GetFileUrlParams } from '@harehane/sdk/v12';

const params: OneBot12GetFileUrlParams = {
    file_id: 'KNOWN_SAME_ACCOUNT_MEDIA_FILE_ID',
    type: 'url',
};
const response = await client.request('get_file', params);
if (response.status === 'ok') {
    const data = response.data;
    if (
        data !== null && typeof data === 'object' && !Array.isArray(data) &&
        typeof data.name === 'string' && typeof data.url === 'string'
    ) {
        // Use data.name and data.url privately; URL query values may be credentials.
    }
}
```

The request method still returns the generic `OneBot12ActionResponse`. The
normal response parser checks the envelope and JSON value, not action-specific
fields, optional headers or hash, or URL syntax. Callers must validate any fields
they use; a type assertion is not validation.

Jiyu's current v12 server supports only this URL subset, not the complete
`get_file` action: bytes and path modes, and other file operations, are not
implemented. Supply an already-known legacy ID from the same account's v11
media cache, or the transient ID from a supported incoming v12 image or voice
segment. A cache miss or another kind of ID may fail. The
[OneBot URL-mode definition](https://12.onebot.dev/interface/file/actions/#get_file)
requires the application to be able to download the file. Jiyu checks URL syntax
on a best-effort basis, but does not establish that requirement, reachability,
expiration or the caller's permission to access the URL. A cached label
containing `/` or NUL, or equal to `.` or `..`, becomes an empty unknown `name`;
other labels may still be cache IDs rather than original filenames. Validate
`name` for your own platform before using it as a filesystem path.

`OneBot12ImageSegment` and `OneBot12VoiceSegment` are optional static types. The
voice type describes `type: 'voice'` with a string `data.file_id`; the generic
SDK parser does not validate that field or other segment-specific fields. A type
assertion is not validation. Jiyu emits voice only for a current source-qualified
friend/private or normal/group incoming v11 `record` whose public data is
exactly `{file: string, url: nonempty HTTP(S) string}`. It outputs only
`{type: 'voice', data: {file_id}}`, with `[语音]` in `alt_message`. Supported
text, mentions, images and voices retain their order; unsupported or invalid
visible segments reject the whole event. Outbound image/voice, self-sent media
echoes, v11 `audio`, video, flash and marketplace-face conversions remain
unsupported.

Before issuing any handle for an incoming v12 event containing images or voice,
the Jiyu runtime limits the combined number of image/voice segments to 128 and
their combined UTF-8 URL lengths to 256 KiB (262,144 bytes). Exceeding either
limit fails the whole conversion without truncation; an already-prepared
internal ordered poll admission records a gap under its existing rules. Text-only
events and v11 behavior are unaffected by these media limits.
These are local workload policies, not QQ or OneBot protocol limits, and they do
not bound total CPU use or process RSS. A nonce already reserved by an issuer is
not rolled back if that issuer or its provider subsequently fails.

Jiyu's `jiyu-image:v1:` and `jiyu-voice:v1:` IDs are transferable bearer
references to the URL observed in the respective v11 segment, not proof of QQ
origin, actual file identity or bytes. For a supported handle, `get_file`
returns `name: ''` and the original observed URL without a v11 lookup, refresh,
download or file validation. The voice handle uses a separate purpose, random
key, AAD and nonce state from the image handle; a URL is limited to 3,000 UTF-8
bytes, an ID to 4,096 UTF-16 code units and each key to 2²⁴ issuances. The same
runtime keeps its keys across listener close/reopen; permanent quiesce,
force-close, replacement or restart invalidates its handles. Key clearing is
best effort. Either reserved prefix bypasses v11 even when decoding fails, so a
pre-existing v11 alias beginning `jiyu-voice:v1:` no longer works through v12
`get_file`; v11 alias lookup itself is unchanged. A caller with access to the issuing
runtime can redeem a transferred handle, its length leaks URL length, and v11
events or debug/observer paths may still expose the URL.

This snapshot is not an end-to-end no-network or lossless media path. A real
`OneBotInstance` normally performs v11 RKey and voice PTT resolution before
constructing the event; the resolver may access the network or change the source
element, and upstream conversion may lose format, duration or other semantics.
Existing v11 file-ID logic is unchanged. A redacted warning replaces exception
details only in the media URL population catch; other logs have separate
behavior. Production HTTP event polling remains unavailable, and local fixtures
do not establish live QQ interoperability. See the [server details](../onebot/ONEBOT_V12.md).

## Data and compatibility limits

JSON text is supported; MessagePack is not implemented. The codec's local
resource policies limit a JSON message to 4 MiB, nesting to 64 levels, nodes to
100,000 and number literals to 256 characters. The depth limit counts the root
value as depth 0, so an empty array or object at depth 64 is accepted, but any
child of that container at depth 65 is rejected by snapshot validation. For
valid JSON, the preliminary container scan counts the root container as 1 and
allows up to 65 containers along a path; the deepest must be empty to pass the
subsequent snapshot check. A path of 66 containers is rejected by the scan. The
scan is not a syntax validator; JSON.parse checks syntax. This precise root-count
convention was not previously specified clearly in this document and is an SDK
policy, not a OneBot rule. Numbers that overflow, underflow
nonzero values to zero, or cannot be represented safely as integers are
rejected; ordinary floating-point values are rounded to IEEE 754 double
precision rather than retaining every decimal digit. These are SDK policies,
not limits imposed by the OneBot standard. Object input is copied and requires
plain objects and arrays from the current JavaScript realm; use the JSON text
parsers for data from another realm. Boolean `isOneBot12*` helpers are not type
guards: use the parser's returned snapshot for validated data.

The SDK does not imply full support by a particular OneBot implementation or
provide a live QQ session. Jiyu's current v12 capability matrix and setup are
maintained with its OneBot server documentation; unsupported actions or message
segments must remain observable rather than being silently dropped.
