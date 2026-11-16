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

## Supported behavior and limits

The core currently handles `get_version`, `get_status`, `get_supported_actions`,
`get_self_info`, `get_user_info`, `get_friend_list`, `get_group_info`,
`get_group_list`, `get_group_member_list`, `get_group_member_info`,
`send_message` for private and group text messages and group mentions,
`delete_message`, `set_group_name`, and `leave_group`. Setting a group name
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
Incoming friend/private and normal/group messages with text and v11 `at`
segments are converted to v12 `text`, `mention` and `mention_all` segments;
unsupported message semantics and media are not silently converted. The
conversion preserves the v11 field, not an independently verified QQ mention:
the upstream decoder can normalize an unresolved mention UIN to zero, which
the v11 converter represents as `all`. The v12 `alt_message` renders mentions
as `@<user_id>` or `@全体成员`, without reconstructing platform display names.
For supported incoming private messages, an enumerable own v11 data property
`auto_reply: true` is preserved as the optional own JSON field
`qq.auto_reply: true`. Accessor and non-enumerable properties are ignored
without invoking an `auto_reply` getter. This is a Jiyu
QQ-specific extension, not a OneBot 12 standard field or confirmation of a
successful send. Other values are ignored, and the field is omitted when absent;
group messages never acquire it. This is partial event conversion support, not a
claim that HTTP event polling or live QQ behavior has been verified.

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
policies. The legacy buffer
does not enqueue private recall and has separate unresolved empty-result and
bounded-overflow concerns.
`pollOwnerStats` exposes the gap internally, not as a public gap API. The poll
owner's structural validator remains available to direct trusted fixtures;
that does not establish runtime poll admission. Production HTTP event polling
and an end-to-end completeness guarantee remain unimplemented.

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
identity may come from account context. A valid
v11 `friend_add` maps to `notice.friend_increase` with an empty subtype and the
same user ID as a string. The upstream new-friend decoder resolves the peer UIN
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
event. The poll owner is not wired to a production HTTP polling action. Other
notices and requests are not yet translated to v12. Unsupported actions, parameters and message segments return explicit errors. File APIs, HTTP event
polling and HTTP Webhook are not implemented by this listener. Capability and
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
called, avoiding truncation in the downstream private routing field. This does
not narrow the group target ID range.

For group `send_message`, a v12 `mention` with `data.user_id` as a canonical
positive decimal string in the UIN range 1 through 4294967295 maps to the
account-local v11 `at` segment with `data.qq` as that string; `mention_all` with
empty `data` maps to `at` with `qq: 'all'`. Leading zeroes, signs, whitespace,
zero, numeric IDs, values above 4294967295 and `mention` user ID `'all'` are
invalid. The mention limit prevents truncation in the downstream uint32 UIN
encoding; it does not change the group target ID range. Mixed text and
mentions retain their order, and the complete message is validated before one
v11 handler call. For private sends both mention types return unsupported 10005
without calling the v11 handler; this is an implementation limit, not a claim
that the standard forbids private mentions.
Each segment is processed in order: shape and, for known segment types, extra
fields and required values are validated before the private-mention decision.
Thus malformed fields return 10006 or 10007, while a valid private mention
returns 10005 immediately without checking later segments. Unknown types return
10005 as before. This is a local v11 representation mapping: the canonical
numeric ID is passed to the existing v11 parser, not resolved by v12. If the
v11 UID resolver returns no value, the resulting element may lack a UID. The
element builder passes an empty UID to the encoder, which omits this default-valued
field from protobuf; a resolver that ultimately rejects aborts the send path.
If the v11 resolver returns the reserved string `'all'` for a
numeric user, the existing element builder selects its mention-all path; this
is a potential downstream behavior, not an assertion that the service returns
that value. UID population, actual mention target, QQ rendering, permissions and
successful delivery remain unverified.

`send_message` reports the timestamp already stored by Jiyu. That record may
come from the QQ response or a local-clock fallback and is not necessarily a
QQ-confirmed time. If a send has happened but its result or timestamp is
unavailable, the outcome can be uncertain: do not automatically retry. A
transport timeout also does not imply that the underlying action stopped.

Input, output and concurrency are bounded. If an action response cannot fit
its configured output limit while retaining its echo, the connection may be
closed instead of returning an oversized response. The transport's shared-server
attach mode requires the host to own routing, TCP admission and idle/header
limits. These are implementation limits, not guarantees of the OneBot standard.
No local fixture establishes real QQ message delivery or client rendering.
