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
`get_self_info`, `get_user_info`, `get_friend_list`, `get_group_info`, `get_group_list`, `send_message` for private and group text messages and group
mentions, `delete_message`, and `set_group_name`. The latter requires a canonical positive
safe-integer group ID encoded as a string and a string group name, including an
empty string; it forwards one request to the existing account-local v11 handler.
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
account and its nonnegative finite timestamp does not exceed JavaScript's safe
integer maximum. This local bound keeps this new projection within the SDK and
internal poll JSON number limits; it does not alter ordinary incoming messages.
This reports the existing self echo; it does not independently confirm send,
receipt or delivery. Private self-sent events remain unsupported because
v11's `target_id` has no equivalent standard v12 recipient field. A group
self echo with an unsupported segment fails conversion rather than producing a
partial event; if the internal ordered poll owner is active, this failure marks
an ordering gap instead of silently skipping the event. The poll owner is not
wired to a production HTTP polling action. Other notices and requests are not
yet translated to v12. Unsupported actions, parameters and message segments return explicit errors. File APIs, HTTP event
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
