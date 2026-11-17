# OneBot 12 support in Jiyu

Jiyu provides an account-scoped, opt-in OneBot 12 listener alongside its
existing OneBot 11 adapters. This is a partial implementation of the
[OneBot 12 candidate standard](https://12.onebot.dev/), not a claim of complete
compatibility. The transport and the translation core have separate responsibilities;
see the [core support matrix](./src/v12/README.md).

## Configuration

In an individual account's `config/onebot_<uin>.json`, add a `v12` object:

```json
{
  "v12": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 3012,
    "accessToken": "REPLACE_WITH_A_STRONG_RANDOM_TOKEN",
    "allowNonLoopback": false
  }
}
```

Omitting `v12` leaves the listener disabled. The field is account-specific and
is not inherited from the global configuration. Select a unique port per
account; it must differ from this account's existing v11 server ports. A strong
access token is required, including for loopback. Binding outside loopback
requires `allowNonLoopback: true`. The listener serves HTTP and forward
WebSocket on the same root path and port.

The listener itself uses plain HTTP/WS, not built-in TLS. Use an appropriate
TLS-terminating proxy when traffic leaves the local host. The protocol requires
support for an `access_token` query parameter when the Authorization header is
absent; configure proxies and access logs not to record query strings or
credentials. If Authorization is present it takes precedence, even if invalid.
The existing WebUI does not expose a v12 editor; its normal v11 settings saves
preserve the server's existing account-specific v12 settings. Cross-process
configuration writers and backup restores do not share a revision lock.

Optional v12 heartbeats can be enabled in this account's `v12` object with
`"heartbeat": { "enabled": true, "interval": 30000 }`. The interval is an
integer from 1 to 2,147,483,647 **milliseconds**; an explicitly disabled
heartbeat also requires a valid interval. Omitting `heartbeat` leaves it disabled,
preserving the existing default. While the listener is running, changing an
enabled interval or toggling the feature reopens the v12 listener and disconnects
existing v12 WebSocket clients; it does not change v11 listeners. A locally
scheduled heartbeat is a nominal transport-level pulse, not evidence that QQ or an account is online, a remote
client received it, or the timer ran with real-time precision. It is a meta
event and is not placed in the HTTP polling queue. If releasing a
heartbeat-enabled listener, or switching a listener to enable heartbeats, fails
during quiescence, the v12 runtime stops the timer and retains the transport for
cleanup rather than reporting a successful restoration; retry requires releasing
the previous transport before reopening.

## HTTP event polling (partial)

The enabled account-local v12 listener accepts `get_latest_events` as a JSON
`POST` to its existing `/` endpoint. This uses the listener's existing HTTP
access checks. Polling is HTTP-only: the ordinary v12 dispatcher and WebSocket
action path return 10002, and `get_supported_actions` does not currently list
it. The [candidate meta-action specification](https://12.onebot.dev/interface/meta/actions/)
permits that omission, so it does not by itself show whether HTTP polling is
supported. The v11 adapters and WebUI are separate from this capability. For example:

```json
{"action":"get_latest_events","params":{"limit":0,"timeout":5},"echo":"poll-1"}
```

`params` must be an object; `limit` and `timeout` default to zero and accept
nonnegative safe integers. `timeout` is measured in seconds and is capped at
10; `limit: 0` removes the count limit but not the byte and capacity limits.
A poll `echo` may contain at most 4,096 UTF-16 code units; a longer one returns
10001 after earlier request checks when a response remains writable.
The poll owner retains at most 128 buffered events, including reserved entries,
with a 256 KiB encoded-array queue budget and a 64 KiB single-event budget. It
allows at most eight waiters and
eight tracked transactions; the transport can impose a lower concurrency limit.
These are not limits on total process memory or upstream activity.

The account must be online and its listener/source binding current. An adapter
reported as active does not prove poll source or owner readiness; a revoked
opening source attempt can leave polling unavailable without proving that this
timing occurs on a live network. Activation is attempted on listener open,
status change, eligible event or poll. Once ready, the owner can buffer eligible
events before the first poll. If old owner cleanup is pending, later activity
retries activation; events can be lost in the interval. The default manager
retains a non-evicting gate for each canonical UIN, up to 1,024 entries per
manager lifetime. Its custom instance
factory does not automatically share that gate, nor do separate managers or
processes. Source tickets identify a local binding and online generation, not
QQ occurrence time or a complete poll-readiness cut; upstream work can still
be in flight when a poll returns.

Before committing a selected nonempty HTTP prefix, the runtime samples the
request's original listener, listener token and source attempt (`sourceAttempt`)
alongside owner, cancellation and deadline checks. This listener guard does not
cover empty, timeout or fallback responses, or writes after commit. It relies on
trusted synchronous callbacks; these samples are not an atomic fence against
arbitrary reentry or later lifecycle changes and do not establish client delivery.
Source-qualified private recalls remain excluded from production polling; this
guard does not admit them.

Responses select an admission-completion FIFO prefix of the surviving queue and
then sort that batch by `time`, stably for equal timestamps. `limit: 1` selects
the FIFO head, not necessarily the globally oldest event. Cross-batch order, later arrivals and
QQ occurrence order are not guaranteed. A short or timed poll can return
`data: []` when it did not reserve events; this is not proof that upstream is
empty or no other reservation holds data. Contention or a head that does not
fit the response can instead produce a failure.

Under count or byte pressure, the HTTP owner first determines whether removing
the oldest unreserved events would make room. An active reservation protects its
physical prefix. If enough room can be made, those oldest unreserved events are
evicted and the new event is admitted; otherwise the queue remains intact and
the new event is dropped. Fixed, content-free warnings are best effort and
category-deduplicated, not a complete loss report or client-visible gap.
Unsupported conversions and private recall are omitted from HTTP polling. A
source-qualified private recall can still be published independently over
WebSocket when its existing guard
succeeds; unsupported conversions are not necessarily available there either.
Closing or rotating a listener/account/source generation can discard queued
memory. When retirement cleanup observes discarded buffered events, it attempts
the fixed warning `v12 http poll retired with undelivered buffered events`;
this best-effort, category-deduplicated diagnostic is not a persistent count
or client-visible gap. A selected batch is committed before response writing:
a lost or partial response can leave delivery unknown, and committed events are not
requeued or automatically replayed. For observed uncertain outcomes the runtime
attempts the fixed, category-deduplicated warning
`v12 http poll delivery outcome unknown; events may be missed`; this best-effort
warning is not a client-visible gap notification. Local `finish` is not a remote
acknowledgement. See the [polling design and detailed limits](V12_HTTP_POLL_DESIGN.md#current-http-polling-behavior).

## Supported behavior and limits

The core currently handles `get_version`, `get_status`, `get_supported_actions`,
`get_self_info`, `get_user_info`, `get_friend_list`, `get_group_info`,
`get_group_list`, `get_group_member_list`, `get_group_member_info`,
`send_message` for private and group text, group mentions, a single standalone
location, and a restricted local-upload image alone or with exactly one text
segment in either conversation type,
`delete_message`, `set_group_name`,
`leave_group`, and the restricted URL mode of `get_file`. The account runtime also
installs local `upload_file`, `get_file` data, and `get_file_fragmented` read
capabilities described below.
Setting a group name
requires a canonical positive uint32 group ID encoded as a string and a string
group name, including an empty string; it forwards one request to the existing account-local v11 handler. The
uint32 limit prevents truncation in the downstream group-name encoding.
Success requires that handler to return an explicit `ok`/zero retcode with null
`data`. This is the handler's result, not independent confirmation of QQ-side
state. A malformed response or failure leaves the outcome potentially uncertain;
no automatic retry is attempted. `delete_message` likewise requires own data
properties `status: 'ok'`, `retcode: 0` and `data: null`; a malformed handler
response is not proof that a requested deletion did or did not happen. Its
response inspection rejects a final Proxy value after JavaScript's `await` has
performed thenable handling, which may itself execute a `then` getter.

For `get_file` with `type: "url"`, non-reserved opaque `file_id` values are
passed once to the existing account-local v11 media lookup; supported hits come
from that account's cached image or voice metadata. The ID must be a nonempty
string of at most 4,096 UTF-16 code units. Supported v12 incoming image, voice
and video segments can instead supply separate transient URL handles as described
below.
URL success returns only `name` and the original HTTP(S) `url`. The
[OneBot URL mode](https://12.onebot.dev/interface/file/actions/#get_file) requires
the application to be able to download the file; Jiyu's best-effort URL syntax
check does not establish that requirement, URL availability, validity period,
required credentials, or application access. Cached names can be identifiers or
other stored labels rather than original filenames. A label containing `/` or NUL,
or equal to `.` or `..`, is projected as an empty unknown name because it is not
a Linux filename; other labels are retained without proof they were the original
filename. Consumers must validate names for their own platform before using them as
filesystem paths. A missing URL returns 10004; a cache miss is not proof that the
underlying file does not exist. The v11 `get_file` request, result and action-error
logs are redacted, and the image URL-refresh warning no longer records its
exception; observers and other lower-level logging or configured URL-refresh
services can still see data.

### Local data uploads

The account runtime installs a local data capability. Its
`get_supported_actions` lists `upload_file` only when both local data callbacks
exist and the current listener's upload lease is valid. The independent core
can instead use the callback pair alone when no readiness callback is supplied.
Listing the action does not imply support for every upload type. `upload_file` accepts only
`type: "data"`: `name` is a primitive string of at most 4,096 UTF-16 code units
and may be empty, while `data` is a JSON string containing canonical RFC 4648
Base64 with padding where required. Whitespace, the base64url alphabet,
unnecessary or missing padding, and noncanonical pad bits are rejected. The empty
string represents zero bytes. An optional `sha256` must be a 64-character
lowercase hexadecimal string matching the decoded bytes; omit it when unused,
rather than supplying `undefined`. A file may contain at most 256 KiB (262,144)
raw bytes.

A successful upload stores the decoded bytes temporarily in the local process and
returns `{file_id}`. Its ID is `jiyu-upload:v1:` followed by 32 random bytes encoded
as unpadded base64url. It is a transferable bearer reference usable only by a
caller of the same account and active listener generation. `get_file` with
`type: "data"` retrieves `{name, data, sha256}`: the original name, canonical
Base64 bytes and lowercase SHA-256. The name is preserved as data, not validated
as a filesystem path. No local upload or data retrieval contacts QQ, invokes v11,
reads or writes a file, or makes an outbound network request; the ordinary client
transport remains separate. These actions themselves do not send an image, voice
message or file, and do not establish an end-to-end QQ media transfer. A separate
[`send_message` image path](#sending-a-single-local-upload-image) can use an
eligible current-generation handle.

When the data capability is available and a request passes the common `file_id`
type and length checks, a foreign, expired or forged ID in this reserved namespace
produces a local not-found result for data mode without a v11 lookup. URL mode returns 10004 for that prefix without
falling back to v11. Once installed, this capability shadows a pre-existing v11
alias starting `jiyu-upload:v1:` through v12 URL lookup; direct v11 lookup is
unchanged. Other reserved media URL handles have the listener-lease checks
described below. Malformed or oversized IDs may
fail earlier common validation. Upload `type: "url"`, `type: "path"` and unknown
types return 10004; the separate `upload_file_fragmented` action remains
unimplemented and returns 10002. Outbound video sending, other group/normal
file and local-path operations, and other outbound media remain unsupported
apart from the [restricted single local-upload image send](#sending-a-single-local-upload-image).

The restricted `get_file_fragmented` capability reads only these local upload
handles; image, voice, video and v11 file IDs do not fall back to another source. It is
advertised only while the local data capability, both fragment callbacks and the
listener lease are available. `prepare` returns `{name, total_size, sha256}`;
`transfer` returns `{data}` as padded Base64 of exactly the requested byte range.
Both `offset` and `size` must be nonnegative JavaScript safe integers. This
implementation accepts a zero-sized range, including at the end of a file, but
rejects a range extending beyond the current file or a requested size above
256 KiB with 10004 instead of truncating it. This is a local policy, not a claim
that the standard specifies EOF behavior. `prepare` creates no session and is not
an authorization token: each transfer independently checks the current store and
lease, and a valid handle can be read without an earlier prepare. Each stage's
success response is bounded separately; transfer checks its full success envelope
before reading a chunk. A direct dispatcher promise may settle after its lease is
revoked if the response was already constructed. Transport quiescence handles
its own pending responses, but delivery, a smaller configured limit, and bytes
already handed to a peer remain outside the local size check. Metadata
SHA-256 comes from the local store's upload-time bytes; a custom direct-core
provider is trusted for its contents and the dispatcher validates only its shape.
For this new action, a direct-core options object must be non-Proxy and have a
plain or null prototype; its upload, read, metadata, chunk and optional readiness
callbacks must be own data properties rather than inherited methods or accessors.
The fragment path compares their identities after reentrant checks and rejects
nested fragment dispatch while a fragment operation or its capability check is
running. The legacy upload/data paths retain their existing callback behavior.
These checks do not verify the truthfulness of callback contents or closure state.

Each listener retains at most 32 entries and 4 MiB (4,194,304) raw bytes in total;
exhaustion returns a fixed failure without evicting an unexpired entry. Expiry is
10 minutes from the upload's initial valid local clock sample, including subsequent
processing time; in an extreme delay an entry can already be expired when success
is returned. Reads do not extend the deadline. Each read samples expiry on entry;
if a synchronous trusted guard crosses the deadline, that read may complete and
the next access expires the entry. Cleanup is lazy, so idle expired content may
remain in memory until the next store access or close. Since only the
active map is checked for random-ID collisions, a historical ID could in principle
coincide with a new random ID; there is no permanent tombstone guarantee.

Every listener close attempt invalidates its data handles, even if closing fails;
the current listener token's `onError`, token or port reload, and runtime quiesce
or force-close also invalidate them. The listener lease is rechecked around
synchronous callbacks and before commit to block a late request from an old
generation. A post-bind transport error attempts to quiesce the transport first;
the runtime also checks its read-only transport state at the guarded points, so
a quiesced transport rejects data access, including after reentrant callbacks.
These checks assume the owner's synchronous readiness and lease callbacks report
truthful state. A callback that returns stale `true`, or a test replacement that
mutates one readiness source while another is being checked, is not an atomic
state snapshot or an authentication guarantee.

If close or quiesce throws while an open is pending, or construction reports an
error and the existing lifecycle later restores that listener as active, the
retired upload lease remains invalid and `get_supported_actions` omits
`upload_file`. A successful close and subsequent reopen are needed to restore
the capability; restoring the listener's general active state alone is not
enough. A peer disconnect by itself does not prove that the listener generation
was revoked; loss of a response after commit is neither rollback nor proof of
remote receipt.
Retained local buffers are cleared on a best-effort basis; input/output/JSON
copies, garbage collection and actual process RSS are not guaranteed to be erased
or bounded by these store limits.

Before an upload has an effect, its complete UTF-8 success response, including
`file_id` and any `echo`, is checked against 1 MiB minus 14 bytes. A data retrieval
separately checks its complete success response, including `name`, `data`,
`sha256` and that request's `echo`, against the same limit. This conservative
budget covers one frame for the default transport with an empty queue only; a
smaller custom limit, existing WebSocket queued frames or a terminated connection
can still prevent delivery. A failed or missing response can leave the upload
outcome unknown; neither Jiyu nor the SDK automatically retries it.

### Incoming messages

Incoming friend/private and normal/group messages with text and v11 `at`
segments are converted to v12 `text`, `mention` and `mention_all` segments.
A current internal source ticket also permits ordinary incoming images, voice
records and videos with the supported v11 public shapes. At the public
JSON-visible boundary voice must be exactly
`{type: 'record', data: {file: <string>, url: <nonempty HTTP(S) string>}}`, and
video must be exactly
`{type: 'video', data: {file: <string>, url: <nonempty HTTP(S) string>}}`;
`file` may be empty. Required fields are own enumerable data properties, and
visible extras, accessors and proxies are rejected. Non-enumerable internal
metadata is not projected or treated as evidence of QQ origin. An accepted
record is projected lossily as exactly `{type: 'voice', data: {file_id}}`, with
`[语音]` in `alt_message`; an accepted video becomes exactly
`{type: 'video', data: {file_id}}` with `[视频]`, and an accepted image renders
as `[图片]`. Before issuing any media handle, the account-local runtime checks
the required event data, every supported segment shape and every media URL against
its syntax and size limits. Text, mentions, images, voice and video retain their
source order. Media issuers recheck their URLs and issue in that order; a later
issuance failure exposes no partial event but does not roll back earlier issuer
side effects. Flash images, marketplace faces, nonzero image subtypes, custom
summaries, v11 `audio`, unsupported video shapes, media-bearing sent-message
echoes and other unsupported segments visible at this boundary reject the whole
v12 event. Sending voice or video remains unsupported, and v11 message and action
semantics are unchanged.

Before issuing any handle for an incoming v12 event containing images, voice
or video, the runtime also enforces a combined maximum of 128 media segments
and 256 KiB (262,144 bytes) across their UTF-8 URLs. Exceeding either limit
fails the whole conversion without truncation; an already-prepared internal
ordered prototype admission records an ordering gap under its existing rules.
Production HTTP polling uses a separate completion-order owner and can omit the
failed event; its 64 KiB per-event and 256 KiB encoded-queue limits are separate
from the media URL budget. Text-only events and v11 behavior are unaffected by
these media limits. These are local workload policies, not QQ or OneBot protocol
limits, and they do not bound total CPU use or process RSS. If a subsequent
issuer or provider fails after reserving a nonce, that nonce is not rolled back.

This projection is not lossless or an end-to-end no-network guarantee. A real
`OneBotInstance` normally passes through the existing v11 RKey and voice or video
URL resolution before constructing the event. Those resolvers may make QQ requests
or change the source element; an upstream decoder or v11 conversion may already
have omitted a segment or semantics such as format and duration. An exception
escaping video resolution can cause the existing per-element conversion loop to
skip that video before the v12 boundary, so v12 may see only the remaining text.
That earlier catch is distinct from the redacted URL-population warning below and
may log exception details. A reply that v11 cannot resolve may also be dropped
before v12 sees the message; the remaining text can then appear without a reply
segment. A reply still visible at the v12 boundary is unsupported and rejects
the whole v12 event. Neither
case identifies the original quoted sender or proves the quoted message's content.
Existing v11 file-ID logic remains unchanged. If the v11 media URL population
step throws, that particular resolver catch logs a fixed redacted warning
instead of the original exception; it is not a guarantee about other logs.
The conversion preserves the v11 mention field, not an independently verified QQ
mention: the upstream decoder can normalize an unresolved mention UIN to zero,
which the v11 converter represents as `all`. The v12 `alt_message` renders
mentions as `@<user_id>` or `@全体成员`, without reconstructing platform display
names. For supported incoming private messages, an enumerable own v11 data
property `auto_reply: true` is preserved as the optional own JSON field
`qq.auto_reply: true`. Accessor and non-enumerable properties are ignored
without invoking an `auto_reply` getter. This is a Jiyu QQ-specific extension,
not a OneBot 12 standard field or confirmation of a successful send. Other values
are ignored, and the field is omitted when absent; group messages never acquire
it. This is partial event conversion support. HTTP polling has the separate
admission, ordering and loss limits described above; local fixtures do not prove
QQ interoperability.

Each supported image, voice or video segment carries a transient
`jiyu-image:v1:`, `jiyu-voice:v1:` or `jiyu-video:v1:` file ID that seals the
exact HTTP(S) URL observed in its v11 segment. A later `get_file` in URL mode on
the same active v12 runtime can resolve that exact URL and construct a core
success with `name: ''`, without calling the v11 media lookup, refreshing the
URL, downloading or validating the file, or invoking v11 `get_file` action
observers or logs. Incoming video handles are not supported by `get_file` data
or path mode or by `get_file_fragmented`.
URLs above 3,000 UTF-8 bytes, IDs above 4,096 UTF-16 code units, and URLs rejected
by the existing syntax checks are unsupported. The ID protects an observed URL
string, not the original bytes, QQ source identity, actual file identity, format,
playability, future URL content or access. Local AES-GCM is unrelated to QQ
signing or its encryption algorithms; image, voice and video each have a separate
purpose, random key, AAD and nonce state.

For these three reserved prefixes in URL mode, after common request validation,
the core samples the originating listener's lease before and after reading the
resolver, after invoking it and after URL classification. A stale, false or
throwing lease produces core 20002; with a current lease, a bad or foreign
handle that resolves to no valid URL produces core 20001. Neither result falls
back to v11. A normal listener close/reopen retains the issuer, but a call through
the old listener's handler still has its expired lease; the new active listener
can attempt redemption of
the same runtime's handle. Quiesce or force-close also invalidates that lease.

This is a trusted internal lifetime seam: the real transport already has its own
quiesce/open admission, and these observations do not establish an external or
cross-account exploit. The checks are synchronous samples, not atomicity across
resolver side effects, untrusted same-process changes, subsequent microtasks,
writes or network delivery. A direct standalone core call without a lease leaves
callback lifetime to its caller; an internal prepared ordinary call made without
a lease instead uses a false sentinel and fails this reserved URL path. On the
normal HTTP response path, the wrapper preserves the core retcode and `echo` but
can replace the failure text; the output and connection limits below still apply.

For image, voice and video handles, a core success is still subject to the
transport's output byte limit for the entire JSON response, including the URL
and `echo`. Quotes in accepted URLs and quotes or backslashes in `echo` are
JSON-escaped and can enlarge the response; raw backslashes in URLs are rejected
by the URL check. Even when the URL and request meet their individual limits,
the response may exceed the transport budget and be replaced by a fallback or
the connection may close. Successful redemption alone does not guarantee that a
client receives the URL.

Each ID is a transferable bearer reference: anyone who can call `get_file` on
the issuing runtime can attempt to recover the URL, and its length is visible.
These URL snapshot handles have no built-in TTL; they can be submitted for
redemption while the issuing account runtime accepts actions and retains the
unrevoked issuing key. The original URL may independently expire or become
inaccessible sooner. The 10-minute TTL above applies to local uploads, not these
handles. An ordinary
listener close/reopen or online-status change does not itself revoke the issuer.
Each key issues at most 2²⁴ handles; exhaustion rejects new projections for that
purpose without revoking previously issued handles.

Permanent runtime quiesce or force-close stops new input and detaches all three
issuer references before attempting their individual revocations. After a
successful revocation, the old issuer no longer redeems its handles; a replacement
or restarted runtime creates its own issuer and key. If revocation throws, cleanup
of that issuer and key remains unknown; if it throws before clearing the issuer,
a separately held reference may still redeem old handles. Clearing is best effort
even when revocation succeeds; it does not guarantee erasure of copies held by
JavaScript, native crypto or consumers. All three prefixes are reserved: an
invalid, tampered, revoked or foreign handle fails through v12 rather than
falling back to v11. In particular, a pre-existing v11 alias beginning
`jiyu-video:v1:` or `jiyu-voice:v1:` is shadowed through v12 `get_file`; v11
actions themselves remain unchanged. The original v11 event and debug/observer
channels may still contain the URL.

For an ordinary event delivered with an internal source ticket, v12 WebSocket
fanout now rechecks its original listener binding and online epoch before
publishing and before each subscriber. An expired, foreign or unverifiable
provided ticket is not published to v12 subscribers; v11 dispatch is unchanged.
Events with no ticket retain the legacy unguarded fanout. A synchronous reentry
with the exact same event and payload can inherit the surrounding ticket scope.
For image, voice and video, the production completion-order HTTP path samples
the source and issuer before enqueue, and the owner samples the issuer again
after its last host callbacks. These checks rely on trusted synchronous callbacks
and are not an atomic enqueue guarantee: later queue serialization, callbacks
or other same-process code may change state. The ordered owner is a separate
prototype, not the production HTTP owner. WebSocket fanout separately rechecks
the source and current issuer references. A poll result already committed before
a later WebSocket check is not rolled back, and the internal poll seam is not a
same-process authentication boundary. These checks do not establish upstream QQ
identity, prevent arbitrary same-process mutation, suppress same-epoch delivery
to a later-joining client, or cancel an asynchronous subscriber that already
began work.

A private `friend_recall` may produce `notice.private_message_delete` only
through the account-local runtime path. The originating upstream
`friend_recall` must carry an explicit boolean `recalledBySelf`; its account,
peer and event time must match the v11 event, and the exact `sourceTicket`
captured for that same event must be present and still current. The same
instance's message store must already have matched an existing candidate, and
the v11 event must retain that candidate's nonzero signed 32-bit `message_id`;
negative IDs are valid. Missing or tampered provenance, cloned or modified
events, expired or mismatched tickets, and store misses skip this v12 event
without changing normal v11 behavior. Passing a standalone or copied v11
`friend_recall` object to `convertV11Event` alone does not establish the
required provenance. The source ticket is an internal correlation marker, not
an authentication boundary against other code in the same process.

The upstream direction selects the v12 `user_id`: the account when
`recalledBySelf` is true, the peer when false. `sub_type` is empty, and the v11
message ID is preserved as a string. Store matching uses only the peer, client
sequence, direction and recall time to select an existing candidate whose
stored timestamp is no later than the recall time. Its existing recall-time
validation requires a nonnegative safe integer, so the store path rejects
fractional recall times even though the source/conversion checks permit fractions
in the normal v12 time range. The match does not prove global uniqueness or
identify the original QQ message. If multiple stored candidates satisfy the
same peer, client sequence, direction and recall-time criteria, successive calls
handling the same recall may select and remove different historical message IDs.
The tombstone upsert alone does not guarantee idempotence. This is
existing store behavior, not evidence that QQ sends duplicate recalls. The
direction remains dependent on the existing QQ decoder; real-client direction
and QQ-side behavior have not been verified.

After final source and event revalidation, the runtime may publish this notice
through v12 subscriber and WebSocket fanout; publication does not establish
client delivery. The runtime does not enqueue private recall into either poll
path: it lacks a final poll-commit guard on the original v11 object. For an
already-ready, ordered-eligible admission that has converted successfully, still
has its valid original source and exact ticket, and is not a replay of the same
object with the same ticket, the child is failed rather than silently skipped.
Source-current checks depend on a trusted synchronous verifier; a callback that
changes the online generation and returns a stale `true` is not fenced merely by
calling it again. The production closure uses internal synchronous state checks;
a side-effectful fake callback does not establish remote behavior.
If no other terminal condition wins first, the internal owner records a sticky
`child_failed` ordering gap for that source epoch and retires its queue;
previously queued, unconsumed data may also be discarded. A prior sticky gap
keeps its first reason; an earlier deadline, clock or other ordering failure can
therefore take precedence over `child_failed`. An absent or stale source, invalid
ticket, same-object/same-ticket replay or pre-ready input does not by itself
create this recall-specific gap; other ordering failures still follow their own
policies. This sticky-gap behavior belongs to the ordered prototype, not the
production HTTP owner. Production HTTP also omits private recall and attempts a
fixed, category-deduplicated warning; its empty-result and bounded-overflow
limitations are described in [HTTP event polling](#http-event-polling-partial).
`pollOwnerStats` exposes ordering state internally, not as a public gap API. The
poll owner's structural validator remains available to direct trusted fixtures;
that does not establish runtime poll admission or an end-to-end completeness
guarantee.

Internal [source-proof and guarded-queue primitives](V12_PRIVATE_RECALL_POLL_DESIGN.md)
are under development. Neither is connected to HTTP polling: the proof rechecks
local object and ticket bindings, but does not establish that an owner or online
epoch is current, that QQ issued the event, or that a client received it. HTTP
continues to omit private recalls until the remaining guarded-commit and runtime
integration work is complete.

A valid v11 `group_recall` maps to `notice.group_message_delete` after account,
time, field and identifier validation. It uses `recall` when sender and operator match;
otherwise the subtype is empty rather than asserting an administrator action.
The message ID is the value exposed by v11, not proof that it identifies a QQ
history entry: the existing upstream resolver may hash a missing sequence. The
protocol decoder retains the first recall entry's legacy behavior and processes
subsequent entries with nonzero sequences in list order; it skips additional
entries with absent or zero sequences and attempts a count-only warning. This
local decoding behavior does not establish real-server batching or delivery.
Unresolved or zero sender/operator IDs are rejected. A valid v11
`group_decrease` with subtype `leave`, `kick` or `kick_me` also maps to
`notice.group_member_decrease`, with an empty subtype. An upstream leave may be a
decoder fallback or a locally synthesized result, and an unknown decrease reason
can default to `kick`; the mapping therefore does not assert a QQ-side reason.
The upstream actor can likewise be synthesized; the mapping only preserves the
v11 fields, not proof of a QQ-side event or its time. Other decrease subtypes,
including `disband`, remain unsupported. A `group_increase` can map to
`notice.group_member_increase`. When v11 reports a known, valid independent
inviter, the event preserves it in the optional string extension
`qq.invitor_id`; `operator_id` remains the original operator. An unknown inviter
(`invitor_id: 0`, `invitor_status: 'unknown'`) omits the extension; that means
unresolved, not that no inviter existed. The subtype stays empty because
upstream reasons can be defaults or inferred from actor equality. The extension
preserves v11 data, not independent proof of QQ identity. Self-join user
identity may come from account context. The Jiyu-specific extension
`notice.qq.group_name_change` projects a supported v11 `notify/group_name` as
`{group_id, group_name, operator_id?}`: the group ID and a resolved operator ID
are canonical decimal strings, and numeric positive zero (`+0`) for the unresolved
v11 operator omits `operator_id` rather than asserting that no operator existed.
Negative zero and the string `"0"` are rejected. The name is preserved without
trimming and must contain 1–1,024 UTF-16 units; this is a local
limit, not a QQ or OneBot limit. Time follows the existing nonnegative safe-number
rule, including fractional values and zero. The upstream decoder can use zero
when the packet timestamp is missing, so it is not proof of the event's time.
This is an [extension](https://12.onebot.dev/interface/rules/), not a standard
group notice, and does not establish QQ-side authenticity or client delivery. The
SDK's dedicated type describes the shape; its generic event parser validates only
common fields. A valid v11 `friend_add` maps to `notice.friend_increase` with an
empty subtype and the same user ID as a string. The upstream new-friend decoder resolves the peer UIN
with a routing fallback and may fall back to the packet header time; this mapping
preserves the v11 fields without independently verifying QQ identity, event, or
time. Canonical positive safe-integer IDs are required, including for string
inputs. An existing v11 group `message_sent` event with subtype `normal` is
translated as a group message only when its `user_id` equals the configured
account. Converted message, notice and generated meta event timestamps must be
nonnegative, finite and at most JavaScript's safe integer maximum; fractional
values within that range remain accepted by conversion, subject to stricter
upstream or store validation such as for private recall above. This local bound
keeps the v12 projection within the SDK and internal poll JSON number limits; it
does not alter v11 events.
This reports the existing self echo; it does not independently confirm send,
receipt or delivery. A private friend self echo with the same account identity and
a visible valid v11 `target_id` maps to a private message with the target retained
in the nonstandard string extension `qq.target_id`. A target equal to the account
is preserved without inferring whether that conversation exists. The existing
v11 converter may omit a target equal to self, so this path only preserves the
field when v11 actually supplies it; unknown or invalid targets are skipped
rather than guessed. Private temporary-chat echoes
remain unsupported. A self echo with an unsupported segment fails conversion
rather than producing a partial event; if the internal ordered poll owner is
active, this failure marks an ordering gap instead of silently skipping the
event. That ordered owner is a separate prototype; production HTTP polling
uses the completion-order policy described above. Other notices and requests
are not yet translated to v12. Unsupported actions, parameters and message
segments return explicit errors. Apart from the existing `get_file` URL subset
and the local data capability described above, other file operations remain
unsupported. HTTP Webhook is not implemented by this listener. Capability and
error details remain authoritative at runtime.

A WebSocket connection receives `meta.connect` first and then the current
account status; network connection alone does not assert that the account is
online. Every listener is bound to one account, and a supplied `self` must
match that account's platform and user ID. Existing v11 adapters continue to
use their own protocol and authentication behavior. `get_status.good` reflects the
current online state and Bridge aggregate receive/request health when queried.
Apart from the initial connection snapshot, `status_update` is triggered by
online/offline changes and observed Bridge aggregate health changes while the
account session is online. Health notifications describe current aggregate
state rather than a complete history; short-lived intermediate changes can be
merged and duplicate notifications are possible. Reentrant status broadcasts
are serialized using bounded latest-state
coalescing, and pending updates may be discarded during shutdown, transport
failure, output queue overflow, or sustained reentry. A send attempt does not
establish delivery to a client. Notifications come from normal BridgeManager
routing; direct external Bridge calls do not necessarily notify this listener.
Hook process identity has no generation marker for a reused PID, and these
notifications do not change the underlying health determination.

`get_self_info` returns the validated account ID as a string, the existing v11
login nickname as `user_name`, and an empty `user_displayname` because no
separate display name is available. The v11 source may already have substituted
the UIN for a missing nickname. The core uses fixed 20001 for inconsistent login
info (including v11 errors 1400 and 1404) and fixed 20002 for other well-formed
v11 failures or exceptions; the current transport may replace these failure
messages with its generic side-effect uncertainty warning even for this read-only
action. This action is an incremental addition, not full v12 support.

`get_user_info` accepts only `user_id`: a canonical positive decimal string from
`1` through `4294967295`. Numeric IDs, zero, leading zeroes, signs, whitespace
and larger values are invalid. After ordinary snapshot, `self` and `echo`
preflight, extra parameters take precedence with 10004; missing or invalid IDs
return 10003. A valid request calls the account-local v11 `get_stranger_info`
exactly once with `{user_id: number}` and does not retry automatically. The uint32
ceiling protects the current local wire path from truncation: `OidbUserInfoRequest.uin`
is `uint_32` and Proton encodes it using `>>> 0`. This guard applies only to this
v12 action; direct v11 `get_stranger_info` retains its existing input behavior,
including the possibility of truncation above the uint32 range. It is neither a
global QQ ID limit nor a OneBot standard limit. See the [user action definition](https://12.onebot.dev/interface/user/actions/#get_user_info).

After `await`, the dispatcher rejects Proxy or array envelopes and data, and reads
only own data properties `status`, `retcode`, successful `data`, numeric positive
safe-integer `user_id`, and primitive strings `nickname` and `remark`. The ID must
match the request and each string must be at most 1,024 UTF-16 code units; empty
strings are retained. It projects only `{user_id: String(id), user_name: nickname,
user_displayname: '', user_remark: remark}` without enumerating unknown fields or
invoking their getters. `user_displayname` is empty because there is no independent
source, not proof the user left it unset. The string limit is local and separate
from the transport's default 1 MiB output budget, which also includes JSON encoding,
field names and echo. An oversized result may become a transport error or close the
connection. Await's thenable assimilation can itself execute a `then` getter before
inspection. Malformed results and v11 failures 1400/1404 produce fixed 20001;
other valid positive v11 failure codes or exceptions produce fixed 20002. These
messages contain no upstream data or exception details; existing transport failure
message rewriting may apply.

When v11 context lacks `getStrangerInfo`, or that provider returns null, v11
synthesizes successful data with the requested ID and empty nickname and remark.
The provider can fall back to cached profile or friend data after a profile fetch
failure. Three dataline pseudo-contacts bypass the network lookup. Otherwise the
profile fetch may access the network, and optional enterprise profile fetching is
best effort. Missing or successful data does not establish user existence or
friendship. A profile response without `uin` is filled with `requestedUin`; when
`uin` is present, inconsistency is checked. Matching the resulting ID therefore
cannot prove the server's identity assertion. Real QQ behavior is unverified.

The shared v11 handler's targeted `get_stranger_info` input, terminal response and
exception diagnostics are redacted, and the contact user-profile warning omits
sensitive details. This is not global log sanitization: observers receive raw v11
responses, and WebUI SSE, other services and logs can independently disclose data.
The v11 response and observer semantics are unchanged.

`get_friend_list` accepts no parameters and calls the account-local v11 handler
once with `{}`. It maps each valid v11 numeric `user_id`, `nickname` and `remark`
to string `user_id`, `user_name` and `user_remark`, respectively. It preserves
order, duplicates and empty strings. `user_displayname` is always `''` because
there is no independent display-name source; this does not mean the user left it
unset. This is a v11 roster representation, not proof of real friendships or a
complete, current list: the v11 action returns `[]` without a provider; its
provider may fall back to cached entries on fetch failure and adds up to three
virtual dataline devices when their IDs are not already present. Like
`get_self_info`, the upstream representation may therefore include fallbacks.
Although the action reports a read-only outcome, the v11 implementation may load
or cache data or trigger network activity.

The complete result is rejected with 20001 if its structure or any required
field is invalid, or if it exceeds local limits of 10,000 entries, 1,024 UTF-16
code units per nickname or remark, or 262,144 UTF-16 code units across both
fields. These are local validation limits, not network response byte limits;
the transport defaults to a separate 1 MiB output limit. JSON encoding, field
names and echo also consume that budget: a successful core result can be replaced
by transport error 20001, or the connection closed if the fallback with echo
also exceeds the limit. The core reads only own data
properties, rejects proxies and sparse arrays after the awaited result, and ignores
unknown fields without accessing them. JavaScript's thenable assimilation during
`await` may itself execute a `then` getter before those checks. Valid v11 failure
codes 1400/1404 and malformed results map to fixed 20001; other valid failures
and exceptions map to fixed 20002. No upstream error details are returned and no
automatic retry is made. Existing transport failure-message rewriting may apply.
The shared v11 handler redacts this action's terminal response and exception text
in its own diagnostics, including for v11 callers, and the friend-list provider's
fallback warning omits exception details. Action observers still receive the
original response; other services, observers or debug streams may independently
inspect or disclose it. These protections do not change v11 response contents.

`get_group_info` accepts only `group_id` and calls the account-local v11 handler
exactly once with `{group_id: number}`. After common preflight, extra parameters
(including `no_cache`) take precedence with 10004; a missing or invalid ID returns
10003 without a handler call. Unlike the [standard's string ID](https://12.onebot.dev/interface/group/actions/#get_group_info),
this implementation requires a canonical positive decimal string within JavaScript's
safe-integer range: zero, signs, whitespace, leading zeroes, numeric inputs and
values above `Number.MAX_SAFE_INTEGER` are rejected. A successful result projects
only the matching numeric ID and the original string name to
`{group_id: String(requestId), group_name}`. Empty names are accepted; names over
1,024 UTF-16 code units are rejected. This local name limit is not a transport byte
limit: JSON encoding, field names and echo also consume the transport output budget.

The v11 action defaults `no_cache` to false. If the provider is missing or returns
null, v11 synthesizes success with the requested ID and an empty name. Success
therefore does not establish that the group exists, that its actual name is empty,
that the account is a current member, or that the data is live. The provider may
reuse the identity cache and retains non-member group details in a short TTL cache;
upstream failures can result in cached or empty fallback data. The underlying
service may access the network. In the non-member detail path, the upstream
implementation assigns the requested ID to the returned object without checking
the response's `groupInfo.uin` or `results.uin`; matching IDs here therefore
validate only the v11 projection, not that the upstream response belongs to the
requested group. A missing upstream detail name also becomes an empty string;
its real-world frequency is unknown. Real QQ behavior has not been verified.

After `await`, the dispatcher rejects Proxy envelopes and data and inspects only
own data properties for `status`, `retcode`, successful `data`, `group_id` and
`group_name`; unknown extras are not accessed. Await's thenable handling can itself
execute a `then` getter before inspection. Malformed results, mismatched IDs and
v11 failures 1400/1404 return fixed 20001; other valid failures and exceptions
return fixed 20002, without group IDs or exception details in the fixed messages
and without automatic retries. Existing transport failure-message rewriting may
apply. The shared v11 handler's targeted `get_group_info` action diagnostics
redact inputs, terminal responses and exception text; the three related contact
warnings omit sensitive details. These contact warnings are shared with the v11
`get_group_info_ex` and `get_group_detail_info` paths. Observers still receive the
original v11 response, and existing SSE or other component logs can still expose
complete data; this change does not alter v11 response or observer semantics.

`get_group_list` accepts no parameters, including no `no_cache`, and calls the
account-local v11 handler exactly once with `{}`. It projects only each positive
safe-integer numeric `group_id` to a string and its string `group_name`, ignoring
v11 extras while preserving order, duplicates and empty names. After ordinary
preflight, nonempty valid JSON parameters return 10004 without a handler call;
non-JSON input is rejected earlier with 10001. Supplied `self` and `echo` follow
the existing preflight behavior. The v11 action defaults `no_cache` to false and
returns `[]` without a provider. Its usual provider skips refresh when
`identity.groups` is nonempty; when empty it attempts a refresh and on failure
warns and falls back to the current cache. An empty, successful or cached result
is not proof of freshness or actual group membership; real QQ behavior is
unverified. When a decoded group entry lacks `groupUin`, the existing contacts
provider substitutes numeric zero and can retain that entry in the identity
cache. If it reaches this action, the positive-ID requirement rejects the entire
list with 20001 rather than dropping that row. Its real-world frequency is
unknown. The underlying service may initiate network activity.

The complete result is rejected with fixed 20001 (`invalid group list result`)
for malformed envelope, array or row, v11 failures 1400/1404, or local limits over
10,000 entries, 1,024 UTF-16 units per name, or 262,144 units across names.
Other valid v11 failures and exceptions return fixed 20002 (`group list
unavailable`), without upstream details or retry. After `await`, the dispatcher
rejects proxies, sparse arrays, inherited required properties and accessors; it
reads only required own data descriptors and does not enumerate extras. Await's
thenable handling may itself execute a `then` getter. These result limits apply
only at this layer, not to network bytes. The transport defaults to 1 MiB, and
escaped JSON, field names and echo consume that budget; it may replace an
oversized core success with error 20001 or close the connection. Existing
transport failure-message rewriting may also apply. The shared v11 handler's
terminal action and exception logs are redacted for this action and its provider
fallback warning omits exception details; v11 response and observer semantics
remain unchanged. Observers and debug streams can still see raw results and
independently traverse or disclose them, and other layers retain their own risks.
See the [group action definition](https://12.onebot.dev/interface/group/actions/#get_group_list).

`get_group_member_list` accepts only `group_id`; `get_group_member_info` accepts
only `group_id` and `user_id`. Each is a canonical positive decimal string from
`1` through `4294967295`; numeric IDs, zero, leading zeroes, signs, whitespace
and larger values are invalid. After ordinary request, `self` and `echo`
preflight, unsupported parameters, including `no_cache`, return 10004 before ID
validation; missing or invalid IDs return 10003. A valid request for either
v12 action calls the account-local v11 `get_group_member_list` exactly once with
`{group_id: number}`, without automatic retry. It does not call the v11 member
info action, whose fallback can synthesize a member. These uint32 restrictions
are local to these v12 actions, not a global QQ or OneBot ID limit.

Each successful v11 row must have own data properties `group_id` equal to the
requested numeric group ID, positive uint32 numeric `user_id`, and primitive
string `nickname` and `card`. Although the v11 member schema permits `card` to
be omitted, v12 requires an own data-property string: a missing or accessor
`card` rejects the entire result with 20001 rather than inventing an empty value.
The production formatter normally supplies `card`, but this is not a guarantee
about every provider result; a missing field cannot be equated with an unset
card. The output contains exactly the standard string fields
`{user_id: String(user_id), user_name: nickname, user_displayname: card}`;
it does not add `group_id`. List results preserve row order, duplicates and empty
names. Info validates the entire list, including rows after a match, and succeeds
only for exactly one matching user ID. Zero or multiple matches return explicit
failure 35000 (`group member match unavailable or ambiguous`), not a claim that
that member does not exist. Malformed envelopes, rows or lists and v11 failures
1400/1404 return fixed 20001; other well-formed v11 failures or exceptions return
fixed 20002, without upstream details. Existing transport failure-message rewriting
may apply.

The complete list is rejected when it exceeds 10,000 rows, either name exceeds
1,024 UTF-16 code units, or the two name fields total more than 262,144 UTF-16
code units across all rows. After `await`, the dispatcher rejects proxies, sparse
arrays, accessors and inherited required properties and reads only required own
data descriptors; unknown extras are not enumerated. Await's thenable handling
can itself execute a `then` getter before these checks. These are local result
limits, not a bound on network bytes or process memory. The transport's separate
default 1 MiB output limit includes JSON escaping, field names and echo, and may
replace an oversized success with an error or close the connection.

The v11 list returns `[]` without a provider. Its usual provider may fall back to
nonempty classified cached members after a fetch failure; absent such cached data,
the failure propagates. The upstream member decoder can substitute empty names
for missing nickname or card data. The row's v11 `group_id` is supplied from the
request rather than independently checked against a server group assertion.
Consequently even a validated unique match, and likewise an empty or cached list,
does not prove server-side group attribution, completeness, freshness, group
existence or actual current membership. The v11 provider may perform network or
cache work; real QQ behavior is unverified. Targeted action diagnostics redact
member-query inputs and terminal results, but observers and other components may
still receive or expose the original v11 data. SDK member response types describe
shapes only: the generic SDK parser checks the envelope and JSON, not the member
fields. See the [candidate group actions](https://12.onebot.dev/interface/group/actions/).

`leave_group` accepts only a canonical positive decimal `group_id` string in
`1..4294967295`; unsupported parameters, including `is_dismiss`, return 10004
before ID validation, and an invalid ID returns 10003. The uint32 bound reflects
the downstream encoder, not a general OneBot ID limit. Each accepted request
calls the account-local v11 `set_group_leave` exactly once and does not retry it.
Only an own-data `status: 'ok'`, zero `retcode` and `data: null` response is a
local success. Malformed responses and failures are reported without upstream
error details; after a handler starts, its outcome can remain uncertain even
when the caller receives an error or times out. The transport's separate output
byte limit includes the echo and complete JSON envelope; an oversized result may
close the response even after an effect has occurred. A successful response is
not an independent confirmation of QQ-side membership.

The v11 action sends a leave request without an `is_dismiss` parameter or a
local group-owner check. Rejecting that extra v12 parameter does not establish
what QQ does when the account owns the group. After the underlying request, the
existing bridge emits a local self-leave event, waits for event subscribers and
updates its local group state; event delivery and durable persistence have their
own failure and waiting boundaries. Action-layer diagnostics redact this action's
inputs, outputs and exception details, but observers and deeper transport or
event logging can still expose data. Real QQ behavior remains unverified.

For private `send_message`, the target `user_id` must be a canonical positive
uint32 decimal string; larger values return `10003` before the v11 handler is
called, avoiding truncation in the downstream private routing field. Group text,
mentions and location retain their existing target range; the single-image and
image-plus-text paths apply the separate uint32 constraint described below.

For group `send_message`, a v12 `mention` with `data.user_id` as a canonical
positive decimal string in the UIN range 1 through 4294967295 maps to the
account-local v11 `at` segment with `data.qq` as that string; `mention_all` with
empty `data` maps to `at` with `qq: 'all'`. Leading zeroes, signs, whitespace,
zero, numeric IDs, values above 4294967295 and `mention` user ID `'all'` are
invalid. The mention limit prevents truncation in the downstream uint32 UIN
encoding; it does not change the group target ID range for text or mentions.
The single-image and image-plus-text paths apply a separate target limit. Mixed
text and mentions retain their order, and the complete message is validated
before one v11 handler call. For private sends both mention types return
unsupported 10005 without calling the v11 handler; this is an implementation
limit, not a claim that the standard forbids private mentions.
After request checks and basic target parsing, an array containing exactly one
text and one image enters the restricted image path described below. Any other
multi-segment form containing an image returns 10005 in an image-combination
scan before per-segment validation.
For the non-image path each segment is processed in order: shape and, for known
segment types, extra fields and required values are validated before the
private-mention decision. Thus malformed fields return 10006 or 10007, while a
valid private mention returns 10005 immediately without checking later segments.
Unknown types return 10005 as before. This is a local v11 representation mapping: the canonical
numeric ID is passed to the existing v11 parser, not resolved by v12. If the
v11 UID resolver returns no value, the resulting element may lack a UID. The
element builder passes an empty UID to the encoder, which omits this default-valued
field from protobuf; a resolver that ultimately rejects aborts the send path.
If the v11 resolver returns the reserved string `'all'` for a
numeric user, the existing element builder selects its mention-all path; this
is a potential downstream behavior, not an assertion that the service returns
that value. UID population, actual mention target, QQ rendering, permissions and
successful delivery remain unverified.

### Sending a single location

Jiyu supports the OneBot 12 [`location` segment](https://12.onebot.dev/interface/message/segments/#location)
for private and group `send_message` only when the entire message is exactly one
location segment. The message may be the segment itself or a single-element
array. The segment must have only `type` and `data`; `data` must contain exactly
`{latitude: number, longitude: number, title: string, content: string}`. Both
coordinates must be finite: latitude is in `[-90, 90]` and longitude in
`[-180, 180]`, inclusive. Both text strings may be empty. Their combined UTF-8
length may not exceed 64 KiB (65,536 bytes), summing each string's UTF-8 byte
length separately. This does not count the eventual JSON card or transport
envelope.

```json
{
  "action": "send_message",
  "params": {
    "detail_type": "group",
    "group_id": "123456",
    "message": [{
      "type": "location",
      "data": {"latitude": 1e-7, "longitude": -0, "title": "Example", "content": ""}
    }]
  }
}
```

Use `detail_type: "private"` and `user_id` in place of the group fields for a
private send. After earlier request and target validation, missing, wrong-type,
out-of-range or over-budget location data returns `10006`; extra segment or data
fields return `10007`. A location mixed with text or mentions, or with another
location, returns `10005` without a v11 send when the relevant segments pass their
earlier checks. Validation of these non-image combinations is sequential: an
earlier malformed field can return `10006` or `10007` first, a valid private
mention returns `10005` immediately,
and request snapshot or transport limits can reject before segment validation.
For example, non-finite in-process numbers fail the snapshot with `10001`. These
coordinate ranges, text limit and combination rules are local support policies,
not assertions about the OneBot standard. `get_supported_actions` lists actions,
not supported segment combinations. Apart from the restricted single-image path
below, optionally with one text segment, other outbound media, including voice
and video, remain unsupported by v12.

Once preflight succeeds, v12 calls the existing account-local v11 send handler
with one `{type: 'location', data: {lat: latitude, lon: longitude, title,
content}}` segment. The existing v11 parser converts each coordinate using
JavaScript `String` and builds a `com.tencent.map` / `LocationShare` JSON card,
which the existing element builder encodes as a `lightApp`. For the numeric
values in the example, its `meta.Location` contains `lat: "1e-7"`, `lng: "0"`,
`title: "Example"` and `address: ""`. In particular, `-0` becomes `"0"` and
small values may use exponent notation. Input JSON number spelling is not
preserved, and digits beyond binary64 precision can be rounded before conversion.
This local path does not establish that a QQ client receives, displays, can read
or delivers the card.

The existing inbound rich-body decoder drops all sibling ordinary text in the
same element list once it successfully decodes a card, including text that was
not merely a compatibility fallback. This is one reason mixed input is not
admitted. Incoming QQ JSON cards remain unsupported by v12 event conversion and
are not automatically mapped back to `location`. Direct v11 message behavior is
unchanged.

The v11 handler's existing TRACE input and action observers can see the original
coordinates, title and address; the WebUI debug tap and other paths may expose
them too. A send-log preview of `[JSON消息]` is not end-to-end redaction. A
failure, invalid result or timeout after the handler starts can leave the send
outcome uncertain; no automatic retry is attempted.

### Sending a single local-upload image

For private or group `send_message`, Jiyu supports one
`{type: 'image', data: {file_id}}` segment, supplied directly or as a
single-element array, or an array of exactly that image and one
`{type: 'text', data: {text: <string>}}` segment in either order. No extra
segment or data fields are accepted. The only accepted `file_id` is a canonical
`jiyu-upload:v1:` handle from this account's current listener generation,
previously returned by `upload_file` with `type: 'data'`. The suffix is the
canonical unpadded base64url encoding of 32 bytes. Incoming `jiyu-image:v1:`,
`jiyu-voice:v1:` or `jiyu-video:v1:` handles, legacy IDs, URLs, local paths,
multiple images and other mixed segment combinations are unsupported. This path
does not fetch a URL or read an arbitrary file.

For the two-segment form, both segments are validated in input order before the
image store is read or the sensitive action is invoked. Its text must be a
string with well-formed UTF-16: an unpaired surrogate returns 10006 before the
store read, avoiding downstream replacement with U+FFFD. This extra UTF-16 check
is specific to image-plus-text, not a new rule for existing text-only sends.
The empty string, spaces, NUL and valid surrogate pairs pass this check. The
v11 parser later skips an exactly empty text placeholder; it does not apply that
empty-placeholder rule to spaces or NUL. There is no additional 64 KiB limit for
this text, although the usual request snapshot and transport limits apply. These
are local policies, not a QQ message-length or delivery guarantee.

After request and basic target checks, other multi-segment forms containing an
image return 10005 in the image-combination scan before per-segment validation.
For a recognized single image or image-plus-text form, missing or non-object
`data` returns 10006; extra segment or data fields are then checked and return
10007 before required values are checked. In the two-segment form those checks
are applied in input order, so an earlier invalid segment determines the result.
A missing or wrong-type `file_id` returns 10006, and a noncanonical upload ID
returns 10005. After these checks, both private
and group image target IDs must be at most `4294967295`; larger canonical IDs
return 10003 before the image store is read or a send is attempted. The bound
prevents truncation of the group target in the downstream uint32 image-upload
pre-application field; it does not establish where a message would otherwise be
delivered. Direct v11 behavior is unchanged and can still narrow that field for
larger group IDs. A syntactically valid ID with no current store entry, invalid
stored data or digest, an unavailable image capability, or a saturated image slot
returns 20002 (`image unavailable`) before submission; earlier request checks
can take precedence. A successful empty `upload_file` is still valid for local
retrieval, but zero-byte content is
not accepted for image sending. The dispatcher reads
the handle once, checks canonical Base64, requires 1–262,144 decoded bytes and
recomputes SHA-256 against the returned lowercase digest. An otherwise valid
one-byte upload passes these local content checks. These size and target bounds
are local policies, not QQ or OneBot maximums. These checks do not parse image
formats, establish file provenance, prove that the bytes are actually decodable
as an image, or establish QQ acceptance. An image send does not consume its
handle or extend its existing upload TTL; the store's 32-entry, 4 MiB and
10-minute limits remain unchanged.

The image path requires the original explicit listener lease, current readiness,
a local read provider and `handleV12SensitiveMessage`. A direct core image call
without an explicit lease, readiness callback or sensitive method fails closed;
listing `upload_file` alone does not establish image-send capability. The
dispatcher pins the initial provider and method identities and rechecks them and
the lease around readiness callbacks. These are lifetime checks, not authentication or isolation
from same-process code: a trusted callback must report its actual state. The
account runtime supplies the local store; a custom core provider must satisfy
its own account and lifecycle contract. `get_supported_actions` lists action
names, not image-segment availability.

Each dispatcher permits at most four image sends in flight. A slot is acquired
before the upload read and remains occupied until the sensitive send and its
sent-time lookup settle; an HTTP timeout alone does not release it. Other
dispatchers have separate limits, so this is neither a global or per-account
concurrency cap nor an RSS bound.

After the original lease, readiness and pinned identities are checked, the
dispatcher calls the sensitive entry at most once with one v11 image segment
whose `file` is `base64://` followed by the canonical Base64 data, optionally
alongside the one v11 text segment in the requested order. After the entry's
synchronous input and debug logging calls return, and immediately before
the registered handler starts, the built-in `ApiHandler` consumes a one-shot start
guard and rechecks quiescence. A failed guard or quiesced handler prevents that
start in the built-in `ApiHandler`; its registered v11 handler otherwise starts
at most once. If a sensitive capability returns without the guard having granted,
the dispatcher returns 20002 with an unknown outcome, even if the capability
claims success. A custom method could already have caused effects or called the
guard at the wrong time; this check does not prove that custom code honored the
guard or contract. Once the handler has started, closing or replacing the listener
cannot retract its effects. A timeout, lost response,
handler failure or unavailable sent-time can leave the outcome unknown; do not
automatically retry the whole send. Existing lower-level Highway chunk handling
may have its own bounded retries. A self-sent v12 event containing an image is
rejected as a whole; in an image-plus-text echo the text is not emitted
separately. Neither a self echo nor a later `get_message` lookup is guaranteed.

Redaction here is limited to this `ApiHandler` sensitive action's own diagnostics
and action-observer records. Each observer receives `redacted: true`, empty
params, a redacted response and `handler_response: 'reported' | 'unavailable'`.
Its response status is the handler-reported status or this layer's fallback, and
its retcode is only the 0/100 success/failure classification; it is not the
original handler failure code. `handler_response: 'reported'` means the top-level
handler status was reported, not that QQ accepted or delivered the message. An
unavailable handler response is marked unknown, not proof that the handler did
not run. The supplied
request `echo` is still returned under the usual rules and is not sanitized.

The registered handler, Bridge, media sinks, other logs and arbitrary
same-process callbacks can still see the original content. For image-plus-text,
the downstream successful-send INFO log can include the first 50 UTF-16 code
units of the text, and local message history may store it. `ApiHandler`
redaction is not end-to-end text redaction. Temporary buffer
clearing is best effort and cannot guarantee erasure of JavaScript Base64 strings
or copies. Synchronous logging and observer callback exceptions are caught at
this boundary. Rejection handling for observer-returned native Promises is best
effort for ordinary constructors and species; malicious constructor/species
behavior, arbitrary thenables and asynchronous logger-subscriber failures are
not guaranteed to be captured by that synchronous boundary. This is not
general end-to-end redaction or hostile-code isolation.

### Send results and limits

`send_message` reports the timestamp already stored by Jiyu. That record may
come from the QQ response or a local-clock fallback and is not necessarily a
QQ-confirmed time. Jiyu returns it only when it is finite, positive and at most
`Number.MAX_SAFE_INTEGER`; positive fractions remain accepted. This is a local
JSON/SDK interoperability constraint, not an upper bound prescribed by OneBot.
If a send has happened but its result or timestamp is unavailable or outside
this range, the outcome can be uncertain: do not automatically retry. A
transport timeout also does not imply that the underlying action stopped.

Input, output and concurrency are bounded. If an action response cannot fit
its configured output limit while retaining its echo, the connection may be
closed instead of returning an oversized response. The transport's shared-server
attach mode requires the host to own routing, TCP admission and idle/header
limits. These are implementation limits, not guarantees of the OneBot standard.
No local fixture establishes real QQ message delivery or client rendering.
