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
`send_message` for private and group text messages, and `delete_message`.
Incoming friend/private and normal/group text messages are converted to v12
message events; unsupported message semantics and media are not silently
converted. Self-sent events are not yet translated to v12. Unsupported actions,
parameters and message segments return explicit errors. File APIs, HTTP event
polling and HTTP Webhook are not implemented by this listener. Capability and
error details remain authoritative at runtime.

A WebSocket connection receives `meta.connect` first and then the current
account status; network connection alone does not assert that the account is
online. Every listener is bound to one account, and a supplied `self` must
match that account's platform and user ID. Existing v11 adapters continue to
use their own protocol and authentication behavior.

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
