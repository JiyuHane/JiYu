# OneBot 12 support

`@harehane/sdk/v12` provides an independent OneBot 12 application-side API. It
is separate from the existing OneBot 11 clients and does not change their
behaviour. The implementation follows selected parts of the
[OneBot 12 candidate standard](https://12.onebot.dev/); consult the connected
implementation's `get_supported_actions` result and documentation for its capabilities;
some supported HTTP-only actions may be omitted from discovery.

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
support it. Jiyu's enabled account-local v12 listener provides a **partial
HTTP-only** implementation when the listener and online source are current;
its ordinary dispatcher and WebSocket action path still return 10002. Jiyu does
not currently list the action in `get_supported_actions`, so that result alone
is not a complete discovery mechanism for this endpoint. The [candidate
meta-action specification](https://12.onebot.dev/interface/meta/actions/)
permits this omission even though it requires the action for HTTP. WebSocket
clients retain their generic `request` interface.

For Jiyu, `timeout` is capped at 10 seconds and a poll `echo` above 4,096
UTF-16 code units returns 10001 after earlier checks if a response remains
writable. The in-memory queue is limited to 128 events and 256 KiB of encoded
array data, with a 64 KiB single-event budget;
`limit: 0` does not remove these or response-size limits. Each response selects
a completion-order FIFO prefix of the surviving queue, then sorts that prefix
stably by event `time`; `limit: 1` does not necessarily return the globally
oldest event. Separate
batches, late arrivals and QQ occurrence order have no global ordering guarantee.
A successful empty array means this poll obtained no reservation, not that the
upstream pipeline is empty or another poll holds no events.

For eligible ordinary events and qualified private recalls, Jiyu's production
completion-order HTTP owner uses a scoped guarded queue. The account/epoch scope
is local lifecycle correlation, not proof of QQ origin, online state or owner
authority; trusted owner checks remain separate. This is not the separate
ordered-producer prototype, and the scoped queue alone is not sufficient proof
for private-recall admission.

Before settling a selected prefix, the scoped transaction samples the request's
original listener, listener token and source attempt (`sourceAttempt`) alongside
owner, cancellation and deadline checks. Its own write path resamples the
listener before writing, after the header write, and around body/end and local
finish checks. This includes empty/timeout successes and its own fallback when
written, not independently generated transport responses. These trusted
synchronous samples are not an atomic fence against a callback that changes the
source and returns stale `true`, later asynchronous changes or network delivery.

The account and listener must be current and online. Pending prior-owner cleanup
can temporarily prevent activation, and events may be missed while later
status, event or poll activity retries. Under queue pressure the server may
evict the oldest unreserved events to admit a new event. An active reservation's
physical prefix stays protected; if removing all unreserved events would still
not make enough room, the queue remains intact and the new event is dropped.
Loss warnings are best effort, not client-visible gap notifications. An uncertain
admission after enqueue begins may already have queued the event; an uncertain
effect or cleanup can leave the shared gate locked and polling unavailable. If
the pre-admission drop-watermark statistics sample throws, Jiyu retires the
exact sampled scoped owner if still attached and attempts a cleanup-pending
warning after WebSocket fanout; that warning does not establish whether an event
was lost. Internal counters and cleanup indicators are not a durable loss ledger. The transaction distinguishes
selection, commit, release, prune, scope revocation and uncertainty; when it
continues after no-drain settlement, it attempts to resume the queue barrier
using that settlement's exact receipt. If an admitted recall proof is stale at
settlement, the queue can prune that recall without committing other valid
selected entries on that attempt; those entries remain subject to later
lifecycle and overflow limits. A prune can yield an unavailable failure when a
response is writable, not a successful empty batch. Unsupported conversions and
recalls without the required evidence can be omitted. Queue state is in memory
and may be discarded at
close or generation changes. A lost response after the server commits a batch
can leave delivery unknown; neither server nor SDK automatically replays it.
Jiyu attempts a fixed, category-deduplicated warning for known uncertain
delivery, not a client-visible gap notification or receipt guarantee.
The default manager's non-evicting 1,024-UIN gate is per manager; custom
factories and separate managers or processes do not automatically share it.
See the [server polling limits](../onebot/V12_HTTP_POLL_DESIGN.md#current-http-polling-behavior).

Jiyu can poll a source-qualified `notice.private_message_delete` projected from
`friend_recall` after attempting its independent WebSocket fanout. The proof
binds the original v11 event, provenance, exact event ticket, conversion identity
and candidate; the owner separately checks account, source epoch and current
lifecycle. The owner's ticket may be another object from the same epoch; the
proof still requires the exact original event ticket. A first qualified recall
can activate the HTTP owner after fanout. Missing or stale evidence and changes
made during a subscriber callback can prevent HTTP admission.

The runtime records at most one local HTTP attempt per exact original
event/ticket pair before its admission guards, including when a prepared or
ordered context excludes the attempt. That does not deduplicate different objects
or tickets, other runtimes or restarts. Fixed poll warnings omit the proof, ticket,
account-self and event contents; the standard event still has its ordinary
`self`, and existing lower-level logs may expose recall identifiers and
direction. The SDK checks common event fields, not recall-specific payload
fields or provenance. These local checks do not establish QQ authenticity,
global exactly-once processing, durable event history, security isolation,
remote delivery or live QQ interoperability.

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

### Jiyu private-message deletion type

`@harehane/sdk/v12` exports the optional TypeScript shape
`OneBot12QQPrivateMessageDeleteEvent` for the private-message deletion notice
currently emitted by Jiyu's QQ adapter. It describes `type: 'notice'`,
`detail_type: 'private_message_delete'`, an empty `sub_type`, a `self` whose
`platform` is `'qq'`, and string `message_id` and `user_id` fields. The message
ID can represent a negative signed 32-bit value; `user_id` identifies the
recalling party, either the account or its peer. This describes Jiyu's current
projection, not every implementation of the notice.

```ts
import type { OneBot12QQPrivateMessageDeleteEvent } from '@harehane/sdk/v12';

// Apply your own source and detail-field checks before calling this function.
function messageIdOfValidatedRecall(event: OneBot12QQPrivateMessageDeleteEvent): string {
    return event.message_id;
}
```

The generic event and polling parsers check common event fields, not these
notice-specific fields or QQ provenance. A type annotation is not runtime
validation or authentication of the event's origin.

### Jiyu group-administrator change extension

Jiyu's nonstandard `notice.qq.group_admin_change` projects v11 `group_admin`
`set` and `unset` as `is_admin: true` and `is_admin: false`, respectively. Its
`sub_type` is empty, `self.platform` is `'qq'`, and `group_id` and the affected
`user_id` are canonical positive safe-integer decimal strings. Jiyu does not
emit or infer an `operator_id` for this notice. The reported change is not proof
of current or effective permissions, QQ origin, client delivery or real QQ
interoperability. Subject to the ordinary source, queue and lifecycle limits
above, the event can reach WebSocket subscribers or HTTP polling; an unticketed
independent dispatch can use the legacy WebSocket path but is not admitted to
production polling.

`@harehane/sdk/v12` exports `OneBot12QQGroupAdminChangeEvent` as an optional
TypeScript description of Jiyu's current shape:

```ts
import type { OneBot12QQGroupAdminChangeEvent } from '@harehane/sdk/v12';

// Apply your own source and detail-field checks before calling this function.
function reportedAdminChange(event: OneBot12QQGroupAdminChangeEvent): boolean {
    return event.is_admin;
}
```

The generic event and polling parsers validate common event fields, not this
extension's fields or QQ provenance; they can preserve unknown fields and
subtypes. A TypeScript annotation does not validate the payload at runtime or
authenticate its origin, and this type does not define every implementation's
behavior.

### Jiyu group-name extension

`@harehane/sdk/v12` exports the `OneBot12QQGroupNameChangeEvent` TypeScript
shape for Jiyu's `notice.qq.group_name_change` extension. It contains string
`group_id` and `group_name` fields and an optional string `operator_id`. Jiyu
omits the operator when its v11 source reports numeric positive zero as
unresolved; omission does not establish that no operator existed. This is an
implementation-specific extension, not a standard OneBot notice.

The generic SDK event parser validates only common notice fields and preserves
other JSON fields: it does **not** check the extension's field types or Jiyu's
name and ID limits. A TypeScript annotation is not runtime validation. See the
[server event details](../onebot/ONEBOT_V12.md) for its source and delivery
limitations.

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

## Sending a single location with Jiyu

`@harehane/sdk/v12` exports `OneBot12LocationSegment`, a TypeScript shape for
[OneBot 12 `location`](https://12.onebot.dev/interface/message/segments/#location).
It describes `latitude` and `longitude` as numbers and `title` and `content` as
strings. This is a static type, not runtime validation: the generic segment parser
checks the common segment and JSON structure, not location-specific fields. The
type's open JSON object also permits extra fields that Jiyu rejects; satisfying it
does not establish that a segment is acceptable to the server.

For Jiyu, submit exactly one `location` segment with no other segments, either as
a segment object or as a single-element array, to a private or group conversation:

```ts
import type { OneBot12LocationSegment } from '@harehane/sdk/v12';

const location: OneBot12LocationSegment = {
    type: 'location',
    data: {
        latitude: 23.1291,
        longitude: 113.2644,
        title: 'Example',
        content: 'Example address',
    },
};
const response = await client.request('send_message', {
    detail_type: 'private',
    user_id: '123456',
    message: [location],
});
```

For a group, use `detail_type: 'group'` and `group_id` instead of `user_id`.
After earlier request and target checks, Jiyu requires exactly the four data
fields shown: finite numeric latitude in `[-90, 90]`, finite numeric longitude in
`[-180, 180]`, and strings for both title and content, including empty strings.
Their combined UTF-8 length must be at most 64 KiB (65,536 bytes). Missing or
invalid values, out-of-range coordinates and this text limit return `10006`;
extra segment or data fields return `10007`. An otherwise valid location mixed
with text or mentions, or with a second location, returns `10005` without a v11
send. On the non-image path segment checks run in order, so an earlier invalid
segment or other preflight failure can take precedence. After request checks and
basic target parsing, exactly one text plus one image enters the restricted
image path below; other multi-segment forms containing an image are rejected by
an earlier combination scan with `10005`. Non-finite in-process inputs can fail snapshot
validation with `10001`. Separate request and transport limits also
apply. These ranges, length and combination restrictions are Jiyu policies, not
claims about requirements of the OneBot standard. `get_supported_actions` reports
action names, not per-segment support. Apart from the [restricted single-image
path](#sending-one-locally-uploaded-image-with-jiyu) described below, other
outbound media, including voice, remain unsupported by Jiyu v12.

Jiyu passes the accepted location as a v11 `location` segment. The existing v11
parser builds a `com.tencent.map` / `LocationShare` JSON card, encoded as a
`lightApp`. Coordinate numbers are converted with JavaScript `String`: `-0`
becomes `"0"`, small values can use exponent notation, and the original JSON
number spelling and digits beyond binary64 precision are lost. The SDK has its
own JSON number policies described below. The current inbound rich-body decoder
can drop all sibling ordinary text when any card decodes successfully, so Jiyu
does not allow mixed location messages. Incoming QQ JSON cards are still not
mapped automatically to v12 location segments. This describes local translation,
not a guarantee of QQ client receipt, display, readability or delivery.

The existing v11 handler's TRACE input and action observers can see coordinates,
title and address in the clear; the WebUI debug tap and other paths may also
expose them. A send-log preview of `[JSON消息]` is not end-to-end redaction. A
failure or timeout after a send begins can leave its outcome uncertain; neither
the SDK nor Jiyu retries automatically. Existing v11 message behavior is
unchanged. See the [server details](../onebot/ONEBOT_V12.md#sending-a-single-location).

## Sending one locally uploaded image with Jiyu

`OneBot12ImageSegment` is an optional TypeScript description of the image
segment's `file_id` shape, not action-specific runtime validation or a guarantee
that a server accepts that ID. With Jiyu, `send_message` accepts one
`{type: 'image', data: {file_id}}` object, either directly or in a one-element
array, or exactly two segments containing that image and one
`{type: 'text', data: {text: <string>}}` in either order, for a private or group
target. Both segments require their supported fields only. They are validated in
input order before any store read or sensitive call. The ID must be a canonical
`jiyu-upload:v1:` handle from `upload_file` data mode or `upload_file_fragmented`
finish for the same account and current listener generation. Incoming media
handles, legacy IDs, URLs, local
paths, multiple images and other mixed combinations are unsupported.

In the two-segment form, text with an unpaired UTF-16 surrogate returns `10006`
before the store read to avoid downstream U+FFFD replacement; this is not a new
restriction on text-only sends. Empty text, spaces, NUL and valid surrogate pairs
pass this check, but the v11 parser later skips an exactly empty text placeholder.
There is no additional 64 KiB mixed-text cap, though normal snapshot and transport
limits apply. Jiyu uses at most one sensitive v11 action and preserves the segment
order in its input; this does not guarantee QQ rendering or delivery.

The upload must contain 1–262,144 bytes and the private or group target must be a
canonical positive uint32 ID; Jiyu checks canonical Base64 and the returned
SHA-256 before submitting. These size and target bounds are local policies, not
QQ or OneBot maximums. An otherwise valid one-byte upload passes these local
content checks, which do not establish image decodability or QQ acceptance.
Zero-byte uploads are valid for data retrieval but not this send.
Sending neither consumes the handle nor extends its TTL; the existing upload
store limits remain in effect.

The original listener lease, readiness, local reader and sensitive v11 method
must remain valid. In the built-in handler, the one-shot guard and quiescence
check run after synchronous input/debug logging returns and immediately before
the registered handler starts. If a sensitive capability returns without its
guard having granted, the dispatcher reports 20002 with an unknown outcome, even
if the capability claims success; a custom method may already have caused
effects, and the check does not prove that it respected the guard. A dispatcher
allows four in-flight image sends from before reading through the send and
sent-time lookup; an HTTP timeout does not release a slot before that work
settles. This limit is per dispatcher, not a global or account-wide concurrency
cap or an RSS bound. Once the registered handler starts, closing cannot retract
its effects and a timeout or failed response may leave the outcome unknown. Neither client nor server automatically retries the whole send;
existing lower-level Highway chunk handling may retry individual chunks.

A self-sent v12 event containing an image is rejected as a whole, so mixed text
is not emitted separately; neither a self echo nor later `get_message` lookup is
guaranteed.

The sensitive `ApiHandler` action diagnostics and observer records are locally
redacted; observer retcodes are only 0/100 classifications, and a reported
handler status is not proof of delivery. Other logs, media/Bridge sinks and
same-process callbacks can still see content. For image-plus-text, the downstream
successful-send INFO log can include the first 50 UTF-16 code units of the text,
and local history may store it; the `ApiHandler` redaction is not end-to-end
text redaction. A supplied `echo` follows normal response rules. JavaScript Base64
copies cannot be guaranteed erased; observer Promise rejection handling is best
effort, not a guarantee against
malicious constructors/species, arbitrary thenables or asynchronous logger
subscriber failures. See the [server's image-send contract](../onebot/ONEBOT_V12.md#sending-a-single-local-upload-image)
for guards, status details and limitations. Live QQ acceptance remains unverified.

## Local file data subset

`@harehane/sdk/v12` exports `OneBot12UploadFileDataParams`,
`OneBot12UploadFileDataResult` and
`OneBot12UploadFileDataResponse`, and `OneBot12GetFileDataParams`,
`OneBot12GetFileDataResult` and `OneBot12GetFileDataResponse`. These are optional
TypeScript annotations: they do not validate action-specific fields at runtime.
The existing generic `request()` still returns `OneBot12ActionResponse`, not an
automatically narrowed response. The generic parser checks the envelope and JSON,
not Base64 canonicality, digest integrity or action-specific result fields. A
response type assertion is not validation, and the generic v12 client does not
automatically encode, decode or verify file bytes.

For a connected `client`, this synthetic upload/retrieval example uses the
Base64 string for `hello` and omits the optional upload hash. It does not claim
those bytes form a decodable image:

```ts
import type {
    OneBot12GetFileDataParams,
    OneBot12UploadFileDataParams,
} from '@harehane/sdk/v12';

const upload: OneBot12UploadFileDataParams = {
    type: 'data',
    name: 'hello.txt',
    data: 'aGVsbG8=',
};
const uploaded = await client.request('upload_file', upload);
if (
    uploaded.status === 'ok' && uploaded.data !== null &&
    typeof uploaded.data === 'object' && !Array.isArray(uploaded.data) &&
    typeof uploaded.data.file_id === 'string'
) {
    const get: OneBot12GetFileDataParams = {
        type: 'data',
        file_id: uploaded.data.file_id,
    };
    const retrieved = await client.request('get_file', get);
    if (
        retrieved.status === 'ok' && retrieved.data !== null &&
        typeof retrieved.data === 'object' && !Array.isArray(retrieved.data) &&
        typeof retrieved.data.name === 'string' &&
        typeof retrieved.data.data === 'string' &&
        typeof retrieved.data.sha256 === 'string'
    ) {
        // These are shape checks only, not Base64 or SHA-256 verification.
    }
}
```

Jiyu's local upload accepts only `type: 'data'`. `name` is a primitive
string of at most 4,096 UTF-16 units, including the empty string; `data` is a
canonical RFC 4648 Base64 JSON string, padded where required, for at most 256 KiB
(262,144) decoded bytes. The empty Base64 string represents zero bytes. Optional
`sha256`, if supplied, must be 64 lowercase hexadecimal characters matching the
raw bytes; omit the property when unused rather than assigning `undefined`.
Upload success carries `{file_id}`. Jiyu data retrieval success carries
`{name, data, sha256}`, with `data` a Base64 string rather than a byte array and
`sha256` the lowercase digest. The generic result type permits an absent hash for
other implementations; the Jiyu result includes it. The returned name is
not path-sanitized.

The `jiyu-upload:v1:` handle contains 32 random bytes encoded as unpadded
base64url. It is a transferable reference within the same account and current
listener generation, not a QQ file ID. While the data capability is available,
a foreign, expired or forged otherwise valid ID returns local not-found in data
mode without a v11 lookup; URL mode returns 10004 for this prefix without v11 fallback. An old v11
alias with the prefix is shadowed by v12 URL lookup, while direct v11 lookup is
unchanged. Other reserved media URL handles have the listener-lease checks
described below. Common snapshot and ID checks
can fail earlier. Upload `url`, `path` and unknown types return 10004. See
[`upload_file_fragmented`](#upload_file_fragmented-stage-types) for Jiyu's
separate local staging action. In Jiyu's account runtime,
`get_supported_actions` will list `upload_file` only when both data callbacks
exist and the current listener's upload lease is valid; a standalone core without a
readiness callback instead checks the callback pair. Listing the action does not
promise all types.

At most 32 entries and 4 MiB (4,194,304) raw bytes are retained per listener;
capacity exhaustion returns a fixed failure without eviction. Expiry is 10
minutes from the upload's initial valid local clock sample, including subsequent
processing time; a sufficiently delayed upload can already be expired on success.
Retrieval does not extend expiry. Cleanup is lazy and idle expired content can
remain until another store access or close. A historical random ID could in
principle be generated again because collision checks cover only active entries.
Every close attempt, even a failed one, the current listener token's `onError`,
token/port reload, and runtime quiesce/force-close invalidate these handles. The
listener lease is checked around synchronous callbacks and before commit. A
post-bind transport error attempts quiescence first; the runtime also checks
read-only transport state at guarded points, rejecting data access while quiesced,
including after reentrant callbacks. If close or quiesce throws while open is pending, or a
construction-time error is followed by the existing lifecycle restoring that
listener as active, the retired upload lease stays invalid and discovery omits
`upload_file`. A successful close and reopen are needed to restore it. A peer
disconnect by itself does not prove listener-generation revocation; losing a
response after commit is neither rollback nor proof of client receipt. Local buffer clearing is
best effort; input/output/JSON copies, garbage collection and actual process RSS
are not guaranteed to be cleared or bounded.

Before upload effects, Jiyu checks the complete UTF-8 upload success envelope,
including `file_id` and the upload request's `echo`, against 1 MiB minus 14 bytes.
A later data retrieval separately checks its own complete success envelope,
including `name`, `data`, `sha256` and its own `echo`. This is only a conservative
single-frame budget for the default empty-queue transport: smaller custom limits,
already queued WebSocket output or a closed connection may still prevent delivery.
A failed or missing response can leave the upload outcome unknown; do not
automatically retry. These local actions do not contact QQ, call v11, read or write
files or make outbound network requests. The client transport is separate, and
these v12 data actions do not themselves upload to QQ or send image, voice or
file messages. A separate [`send_message` image path](#sending-one-locally-uploaded-image-with-jiyu)
can use an eligible current-generation handle. See the [server details](../onebot/ONEBOT_V12.md#local-data-uploads).

## `upload_file_fragmented` stage types

The SDK describes the three stages of
[OneBot 12 `upload_file_fragmented`](https://12.onebot.dev/interface/file/actions/#upload_file_fragmented)
with `OneBot12UploadFileFragmented{Prepare,Transfer,Finish}Params` and the
corresponding `Response` types, all exported by `@harehane/sdk/v12`.

| Stage | Request fields in addition to `stage` | Successful `data` |
| --- | --- | --- |
| `prepare` | `name: string`, `total_size: number` | `{ file_id: string }`, a staging ID |
| `transfer` | `file_id: string` (staging ID), `offset: number`, `data: string` (Base64 bytes in JSON) | `null` (no result data) |
| `finish` | `file_id: string` (staging ID), `sha256: string` (lowercase whole-file digest) | `{ file_id: string }`, the usable file ID |

The two ID-bearing result shapes are also exported. Byte lengths and offsets
use the JavaScript safe-integer subset of `int64`; these static types do not
validate ranges, Base64, digest syntax or content. The failure branches retain
generic JSON `data`. `call()` and `request()` remain generic. Use the optional
helpers below for stage-specific validation and response types.

### Single-stage upload helpers

`@harehane/sdk/v12` exports three browser-safe functions:

- `prepareOneBot12FragmentedUpload(transport, params, options?)`
- `transferOneBot12FragmentedUpload(transport, params, options?)`
- `finishOneBot12FragmentedUpload(transport, params, options?)`

Each accepts the corresponding typed params, including the literal `stage`,
checks a snapshot of the JSON object, and calls
`transport.request('upload_file_fragmented', …)` at most once. The transport
implements the same structural `OneBot12FileFragmentRequester` used by the
read helpers. HTTP, forward WebSocket and Node reverse WebSocket sessions
keep their own request options; the helper forwards the original options
object. It starts no next stage, upload loop, automatic retry or hash calculation.

The checks require a string `name` (possibly empty), nonnegative safe integers
for `total_size` and `offset`, nonempty opaque IDs, a string `data` for transfer,
and exactly 64 lowercase hexadecimal characters for the finish digest. The
helper does not check the Base64 alphabet, decode bytes, verify a digest,
apply Jiyu's size cap, or track offset continuity. The server may reject a
string (including empty data), a size or a range the helper accepted. JSON
extensions are preserved by the SDK codec; Jiyu rejects extra stage fields.

A resolved envelope is snapshotted again. On success, prepare and finish
must return a data object with a nonempty string `file_id`; transfer must
return `data: null`. A valid business failure is returned as JSON, not thrown.
Local snapshot/shape failures reject with `OneBot12ClientError` code
`invalid_options` (`Invalid upload_file_fragmented parameters`) or
`invalid_response` (`Invalid upload_file_fragmented response`). Transport
rejections propagate unchanged. As with the read helpers, snapshots happen
outside the transport deadline and are not an isolation boundary for custom
JavaScript objects or transports. A malformed response or a timeout is not
evidence that a mutating stage did not run.

On Jiyu, discover `upload_file_fragmented` on the active listener, then send the
three stages as separate calls. Wait for each success before submitting the next.
Use the `prepare` ID only for `transfer` and `finish`. Send nonempty canonical
padded Base64 chunks at consecutive byte offsets starting at zero, or skip
`transfer` for an empty file. `finish` requires the SHA-256 of the complete raw
file; its new ID works with local data or fragment reads. The file cap is 256
KiB and the draft counts against the same 32-entry / 4 MiB limit as ordinary
uploads. The ten-minute TTL starts at `prepare` and does not renew. There is no
abort stage. If a response is lost, do not automatically retry: the stage may
already have changed state. This is a local temporary upload, not a QQ media
transfer. See the [server contract](../onebot/ONEBOT_V12.md#local-fragmented-uploads).

## `get_file_fragmented` read-only types

`@harehane/sdk/v12` exports the following optional TypeScript shapes for
[OneBot 12 `get_file_fragmented`](https://12.onebot.dev/interface/file/actions/#get_file_fragmented):

- `OneBot12GetFileFragmentedPrepareParams`: `{ stage: 'prepare', file_id: string }`.
- `OneBot12GetFileFragmentedPrepareResult`: `{ name: string, total_size: number, sha256: string }`.
- `OneBot12GetFileFragmentedTransferParams`: `{ stage: 'transfer', file_id: string, offset: number, size: number }`.
- `OneBot12GetFileFragmentedTransferResult`: `{ data: string }`, where JSON bytes are Base64 text.
- `OneBot12GetFileFragmentedPrepareResponse` and `OneBot12GetFileFragmentedTransferResponse`: envelopes with their respective result on `status: 'ok'` and arbitrary JSON `data` on `status: 'failed'`.

`total_size`, `offset` and `size` represent the JavaScript safe-integer subset of
JSON `int64`; `offset` and `size` are byte counts. TypeScript's `number` type does
not enforce integer or range restrictions. The shapes permit JSON extension
fields, although a particular server may reject them. The generic codec retains
its existing JSON and safe-number policies, but performs no action-specific field,
range, Base64 or digest validation. These type declarations alone add no runtime
interception; the separate helpers below perform their stated shape checks.

For a `client` and a `fileId` supplied by a supporting implementation, the
existing generic calls can describe the two stages:

```ts
import type {
    OneBot12GetFileFragmentedPrepareParams,
    OneBot12GetFileFragmentedTransferParams,
} from '@harehane/sdk/v12';

const prepare: OneBot12GetFileFragmentedPrepareParams = {
    stage: 'prepare',
    file_id: fileId,
};
const metadata = await client.call('get_file_fragmented', prepare);
```

After the application validates the returned fields and selects a range allowed by
the server, a transfer request can be expressed as:

```ts
const transfer: OneBot12GetFileFragmentedTransferParams = {
    stage: 'transfer',
    file_id: fileId,
    offset: 0,
    size: 1,
};
const fragment = await client.call('get_file_fragmented', transfer);
```

The sample's one-byte range is illustrative; the caller must choose a range
appropriate to the validated result and server limits. Both `call()` and
`request()` still return the generic `OneBot12ActionResponse`, not an automatically
narrowed response. The response types describe the intended shapes; an assertion is
not validation. The returned SHA-256 is a server-reported descriptor, not proof of
source authenticity or content integrity. Callers that require integrity need to
verify the assembled bytes and assess the trust of any expected digest separately.
The SDK does not automatically decode, assemble, verify, retry or stream these calls.

### Single-stage helpers

`@harehane/sdk/v12` also exports browser-safe standalone functions
`prepareOneBot12FileFragment` and `transferOneBot12FileFragment`. Their signatures
use the exported `OneBot12FileFragmentRequester` structural `request` interface:

```ts
interface OneBot12FileFragmentRequester {
    request(
        action: string,
        params?: OneBot12JsonObject,
        options?: OneBot12RequestOptions,
    ): Promise<OneBot12ActionResponse>;
}

declare function prepareOneBot12FileFragment<T extends OneBot12FileFragmentRequester>(
    transport: T,
    params: OneBot12GetFileFragmentedPrepareParams,
    options?: Parameters<T['request']>[2],
): Promise<OneBot12GetFileFragmentedPrepareResponse>;

declare function transferOneBot12FileFragment<T extends OneBot12FileFragmentRequester>(
    transport: T,
    params: OneBot12GetFileFragmentedTransferParams,
    options?: Parameters<T['request']>[2],
): Promise<OneBot12GetFileFragmentedTransferResponse>;
```

Each helper attempts at most one `request('get_file_fragmented', ...)` call.
Invalid local input is rejected before that attempt. Neither function starts a
multi-request download or automatically requests the other stage.

For example, with the HTTP `client` above and a `fileId` from a supporting
implementation:

```ts
import {
    prepareOneBot12FileFragment,
    transferOneBot12FileFragment,
} from '@harehane/sdk/v12';

const metadata = await prepareOneBot12FileFragment(
    client,
    { stage: 'prepare', file_id: fileId },
    { echo: 'prepare-file' }, // HTTP option
);

if (metadata.status === 'ok' && metadata.data.total_size >= 1) {
    // A supporting server may still reject this illustrative range.
    const fragment = await transferOneBot12FileFragment(
        client,
        { stage: 'transfer', file_id: fileId, offset: 0, size: 1 },
        { echo: 'read-file' }, // HTTP option
    );
    if (fragment.status === 'ok') {
        const encoded = fragment.data.data; // string, not verified bytes
        void encoded;
    }
}
```

The helper snapshots the whole JSON parameter object before calling the
transport and validates the requested `stage` and a string `file_id`. For
transfer, `offset` and `size` must also be safe integers: zero and negative safe
integers pass the helper; fractions and unsafe integers do not. A successful
prepare response must have string `name` and `sha256` and a safe-integer
`total_size`, also including zero or negative values; a successful transfer
response must have string `data`. Strings can be empty. JSON extension fields
are retained subject to the SDK's generic JSON limits. Although the TypeScript
index signature permits `undefined`, an own field with that value is not JSON
and the generic parser rejects it; omit the field instead. The helper does not
validate a server's allowed ranges, decode or check Base64, validate digest
syntax, compare a hash, authenticate a source, assemble data or retry. A
server-reported digest alone does not establish integrity. Applications must
select ranges and perform any decoding and integrity checks they require.

A rejected parameter snapshot or stage-specific input yields a rejected promise
with `OneBot12ClientError` code `invalid_options` and fixed message
`Invalid get_file_fragmented parameters`. If the transport resolves with a
malformed envelope or malformed successful stage result, the helper rejects
with code `invalid_response` and fixed message `Invalid get_file_fragmented response`.
An `ok` response must also satisfy the generic zero-retcode rule. A valid
`failed` response is returned rather than thrown, preserving its JSON contents
and extensions, including a zero or negative safe-integer `retcode`; its object
identity and original prototypes are not preserved. Transport exceptions,
including abort and timeout errors, propagate unchanged. Existing SDK `call()`
and `request()` remain generic; these helpers have stage-specific return types.

The response envelope and its JSON data are snapshotted again after the
transport request resolves. Both that response snapshot and the synchronous
parameter snapshot occur outside the SDK transport's own timeout: the timeout is
not a whole-helper deadline and cannot interrupt synchronous processing. The SDK
codec rejects accessors in the copied JSON shape, but reflection on a Proxy can
execute traps; a custom transport's `request` or returned thenable can also
reenter.
These snapshots are not a security or atomicity boundary. Object inputs also
cannot recover precision already lost in an earlier JSON parse.

A supplied options object is passed through by the same reference, not
snapshotted. While a WebSocket is opening, for example, a later change to
`options.self` may affect what that transport serializes. HTTP retains its
existing echo policy; WebSocket transports generate their own correlation echo
and do not use a caller-supplied `echo`. An extra `echo` property passed from
JavaScript is ignored by those transports rather than rejected. The options type
is inferred from the visible third parameter of `T['request']`: widening to the
structural requester or using an overloaded or generic request method can lose
transport-specific option information. Use the concrete transport type where
that information is needed.

An implementation must support the action; exporting types does not establish
server support. Even a listed action does not promise every file ID or range is
accepted. Jiyu's account runtime provides this action only while its local data
capability and listener lease are available. It covers only a published local
file ID from `upload_file` data mode or `upload_file_fragmented` finish, held in
memory for the same account and current listener generation, subject to its
lifetime and capacity limits. Jiyu requires
nonnegative `offset` and `size`, permits zero-byte ranges, bounds local files and
ranges to 256 KiB, rejects ranges extending beyond the file rather than truncating
them, and samples expiry on each read. Thus a negative value accepted by a helper
is rejected by Jiyu. These are implementation policies, not universal server
guarantees. URL/path uploads, legacy v11 IDs and incoming QQ media handles
are outside that scope. This is not a claim about QQ media retrieval, other
OneBot servers or network availability.

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

Jiyu's existing URL subset is not the complete `get_file` action. The separate
local data capability above retrieves only locally uploaded data; path mode and
general file operations remain unsupported. For URL mode, supply an already-known legacy ID from the
same account's v11 media cache, or the transient ID from a supported incoming v12
image, voice or video segment. A cache miss or another kind of ID may fail. The
[OneBot URL-mode definition](https://12.onebot.dev/interface/file/actions/#get_file)
requires the application to be able to download the file. Jiyu checks URL syntax
on a best-effort basis, but does not establish that requirement, reachability,
expiration or the caller's permission to access the URL. A cached label
containing `/` or NUL, or equal to `.` or `..`, becomes an empty unknown `name`;
other labels may still be cache IDs rather than original filenames. Validate
`name` for your own platform before using it as a filesystem path.

`OneBot12ImageSegment`, `OneBot12VoiceSegment` and `OneBot12VideoSegment` are
optional static TypeScript shapes. The video type describes `type: 'video'` with
a string `data.file_id`; the generic SDK segment parser checks the common JSON
shape but does not validate that field or other video-specific fields. A type
assertion is not validation and exporting a type does not establish server
capability. Jiyu emits voice or video only for a current source-qualified
friend/private or normal/group incoming v11 `record` or `video`, respectively,
whose public data is exactly `{file: string, url: nonempty HTTP(S) string}`;
`file` may be empty. Required fields are own enumerable data properties, and
visible extras, accessors and proxies are rejected. Voice projects to
`{type: 'voice', data: {file_id}}`, with `[语音]` in `alt_message`; video projects
to `{type: 'video', data: {file_id}}`, with `[视频]`. Supported text, mentions,
images, voices and videos retain their order; unsupported or invalid visible
segments reject the whole event. Apart from the restricted outbound single-image
path described above, outbound voice or video, self-sent media echoes, v11
`audio`, unsupported video shapes, flash and marketplace-face conversions remain
unsupported.

Before issuing any handle for an incoming v12 event containing images, voice or
video, the Jiyu runtime limits their combined number to 128 media segments and
their combined UTF-8 URL lengths to 256 KiB (262,144 bytes). Exceeding either
limit fails the whole conversion without truncation; an already-prepared
internal ordered-prototype admission records a gap under its existing rules.
Production HTTP polling uses a separate completion-order owner and can omit the
failed event; its 64 KiB per-event and 256 KiB encoded-queue limits are separate
from this media URL budget. Text-only events and v11 behavior are unaffected by
these media limits. These are local workload policies, not QQ or OneBot protocol
limits, and they do not bound total CPU use or process RSS. A nonce already
reserved by an issuer is not rolled back if that issuer or its provider
subsequently fails.

For image, voice and video, the production completion-order HTTP path samples
source and issuer before enqueue, and the owner samples the issuer again after
its last host callbacks. These checks rely on trusted synchronous callbacks and
are not an atomic enqueue guarantee: later queue serialization, callbacks or
other same-process code may change state. The ordered owner is a separate
prototype, not the production HTTP owner.

Jiyu's `jiyu-image:v1:`, `jiyu-voice:v1:` and `jiyu-video:v1:` IDs are
transferable bearer references to the URL observed in the respective v11
segment, not proof of QQ origin, actual file identity, bytes, format or
playability. For a supported handle, successful `get_file` URL-mode redemption
constructs a core result with `name: ''` and the original observed URL without
a v11 lookup, refresh, download or file validation; transport output limits
still apply. Incoming video handles do not support `get_file` data or path mode
or `get_file_fragmented`. Each media kind has a separate purpose, random key,
AAD and nonce state; a URL is limited to 3,000 UTF-8 bytes, an ID to 4,096
UTF-16 code units and each key to 2²⁴ issuances.

For these three reserved prefixes in URL mode, after common request validation
Jiyu samples the originating listener's lease before and after reading the
resolver, after invoking it and after URL classification. A stale, false or
throwing lease produces core 20002; with a current lease, a bad or foreign
handle that resolves to no valid URL produces core 20001. Neither falls back to
v11. A normal listener close/reopen retains the issuer, but an old listener handler
still carries its
expired lease; the new active listener can attempt redemption of the same
runtime's handle. Quiesce or force-close also invalidates that lease. Non-reserved
v11 fallback IDs keep their existing path.

These checks concern a trusted internal lifetime seam; the real transport already
has quiesce/open admission. Local reentry observations do not establish an
external or cross-account exploit, and the synchronous samples do not make
resolver side effects, untrusted same-process changes, later microtasks, writes
or network delivery atomic. A standalone direct core call without a lease leaves
callback lifetime to its caller; an internal ordinary request prepared without a
lease instead uses a false sentinel for this reserved URL path. On the normal
HTTP response path, the wrapper preserves the core retcode and `echo` but can
replace its text; transport output and connection limits still apply.

For image, voice and video handles, a core success is still subject to the
transport output byte limit for the complete JSON envelope, including the URL
and `echo`. Quotes in an accepted URL and quotes or backslashes in `echo` are
JSON-escaped and can enlarge the response; raw backslashes in URLs are rejected
by the URL check. Even when the URL and request meet their individual limits,
the response may exceed the transport budget and be replaced by a fallback or
the connection may close. Successful redemption alone does not guarantee that a
client receives the URL.

These URL snapshot handles have no built-in TTL and can be submitted for
redemption while the issuing account runtime accepts actions and retains the
unrevoked issuing key; the original URL can expire or become inaccessible
independently. The 10-minute TTL above applies to local uploads, not these
handles. An ordinary listener
close/reopen or online-status change does not itself revoke the issuer.

Permanent runtime quiesce or force-close stops new input and detaches all three
issuer references before attempting their individual revocations. After a
successful revocation, the old issuer no longer redeems its handles; a replacement
or restarted runtime creates its own issuer and key. If revocation throws, cleanup
of that issuer and key remains unknown; if it throws before clearing the issuer,
a separately held reference may still redeem old handles. Clearing is best effort
even when revocation succeeds; it does not guarantee erasure of JavaScript, native
crypto or consumer copies. Each reserved prefix bypasses v11 even when decoding
fails, so a pre-existing v11 alias beginning `jiyu-video:v1:` or `jiyu-voice:v1:`
is shadowed through v12 `get_file`; v11 alias lookup itself is unchanged. A caller
with access to the issuing runtime can attempt to redeem a transferred handle,
its length leaks URL length, and v11 events or debug/observer paths may still
expose the URL.

This snapshot is not an end-to-end no-network or lossless media path. A real
`OneBotInstance` normally performs v11 RKey and voice/video URL resolution before
constructing the event; the resolvers may make QQ requests or change the source
element, and upstream conversion may lose format, duration or other semantics.
An exception escaping video resolution can cause the existing per-element loop
to skip the video before v12 sees it, so an event may contain only the remaining
text. That catch is distinct from the media URL-population catch and may log
exception details. Existing v11 file-ID logic is unchanged. A redacted warning
replaces exception details only in the media URL-population catch; other logs
have separate behavior. Jiyu's partial HTTP event polling has separate source,
queue and delivery limits; local fixtures do not establish live QQ
interoperability. See the [server details](../onebot/ONEBOT_V12.md#http-event-polling-partial).

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
