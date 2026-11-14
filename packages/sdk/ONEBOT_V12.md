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

## Data and compatibility limits

JSON text is supported; MessagePack is not implemented. The codec's local
resource policies limit a JSON message to 4 MiB, nesting to 64 levels, nodes to
100,000 and number literals to 256 characters. Numbers that overflow, underflow
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
