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
`get_self_info`, `send_message` for private and group text messages,
`delete_message`, and `set_group_name`. The latter requires a canonical positive
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
inputs. Other notices, requests and self-sent events are not yet translated to
v12. Unsupported actions, parameters and message segments return explicit errors. File APIs, HTTP event
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
