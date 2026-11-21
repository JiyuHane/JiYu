# Managed Linux direct accounts

Jiyu can run explicitly configured Linux QQ accounts without attaching to a desktop QQ process. This mode reuses the existing per-account `Bridge`, OneBot v11 action/event path, message store, adapters, and WebUI debug composer. Hook/process discovery remains the default when no managed-account configuration is supplied.

The direct runtime is Linux-only. It still depends on a locally executed, pinned QQ native signing component; it does not use a public signing service and is not a pure JavaScript replacement for that component. The standalone login configuration and signer fields are documented by the [direct login tool](../../tools/direct-qq-login/README.md).

## Enable the service

Set `JIYU_DIRECT_QQ_CONFIG` to the absolute path of a private JSON file before starting Core. The file is opt-in: an unset variable leaves the existing Hook/WebUI startup unchanged. Up to 32 accounts are accepted.

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "main",
      "label": "Main QQ",
      "configFile": "/etc/jiyu/direct/main/login.json",
      "selectorFile": "/var/lib/jiyu/direct/main/account-selector.json",
      "persistence": {
        "vaultRoot": "/var/lib/jiyu/direct/main/vault",
        "keyRoot": "/etc/jiyu/direct/main/keys",
        "slotId": "0123456789abcdef0123456789abcdef"
      },
      "autoRestore": true,
      "autoRenew": true
    }
  ]
}
```

`id` is the stable WebUI/API identifier. `configFile` is the strict direct-login configuration. `selectorFile` contains only the selected UIN; tickets and renewal times are stored in the encrypted vault. All paths must be absolute. Every account must have distinct selector, device-state, QR, vault, and key paths. Files and their trusted POSIX ancestor chain must belong to the current user and use private permissions (directories `0700`, files `0600`); symbolic links and multi-link managed files are rejected.

The direct login configuration allows at most 16 `reserve.signCommands` entries. A managed account normally keeps the same list it used when the encrypted account was created: the list contributes to the vault's profile binding, so changing it makes a saved record belong to a different profile. The two native renewal commands are fixed, code-owned capabilities and are signed independently of that mutable list; they do not need to be added to an existing account configuration. They remain unreachable through the fixed OneBot packet surface.

## WebUI and HTTP behavior

The **Direct accounts** page at `/accounts` lists configured accounts and exposes QR start, stored-account restore, stop, explicit renewal, QR display, and cancellation. Mutations return HTTP `202`; completion is established by polling the returned operation until its status is `succeeded`, `failed`, or `cancelled`. Account revisions are compare-and-set values. Reusing the same idempotency key and request under the same authenticated WebUI session returns the same operation; it never replays the effect.

The backend endpoints are rooted at `/api/direct`. They use the existing WebUI authentication, consent, and required-password-change gates. State-changing requests must be same-origin, request bodies are bounded, QR bytes remain authenticated, and raw mutation tracing excludes the entire direct route tree. A reverse proxy must preserve the backend-visible origin and `X-SnowLuma-Token`; forwarded host/protocol headers do not override origin checks.

Messages are not sent through a new direct-message endpoint. Once an account reports both `online` and `onebotReady`, the account appears in the existing `/debug` action tester and composer. `send_private_msg` and all other actions continue through the original OneBot v11 dispatcher and account Bridge.

## Session ownership and command surface

A direct login claims its UIN in `BridgeManager` before registration and binds one exact Bridge/OneBot generation. Hook and direct sessions cannot own the same account concurrently. Teardown rejects new work, drains the bounded packet queue and push ingress, closes the protocol owner and Bridge, and waits for that exact OneBot generation to retire.

Direct packet requests are limited to the fixed commands required by the current Bridge/OneBot implementation:

- `MessageSvc.PbSendMsg`
- `OidbSvcTrpcTcp.0xfd4_1`
- `OidbSvcTrpcTcp.0xfe1_2`
- `OidbSvcTrpcTcp.0xfe5_2`
- `OidbSvcTrpcTcp.0xfe7_3`
- `OidbSvcTrpcTcp.0x9067_202`

There is no arbitrary command endpoint. Request bodies are bounded to 64 KiB and response bodies to 2 MiB. Business writes are never automatically replayed after timeout, disconnect, renewal, or recovery.

## Ticket renewal and recovery

Renewal uses the native Linux NT sequence on the existing authenticated owner:

1. `trpc.login.ecdh.EcdhService.SsoKeyExchange`
2. `trpc.login.ecdh.EcdhService.SsoNTLoginRefreshTicket`
3. authenticated response validation
4. durable encrypted checkpoint of the complete candidate ticket set and server renewal times
5. in-memory D2/D2Key capability rotation

Only completion of all five steps is reported as renewed. Heartbeat, Alive, D2 restore, and reconnect are separate operations and never count as renewal. Before the first network write, renewal durably replaces the prior schedule with a zero-time write-ahead fence; success replaces that fence with the server receipt. A crash or ambiguous outcome therefore cannot replay an old due receipt after restart. A legacy vault without renewal times performs one automatic, write-ahead-fenced bootstrap renewal after the account becomes ready; subsequent scheduling uses the absolute server times saved in the same encrypted vault record. Missing server times remain missing and do not create a guessed interval.

A response that requests login-state reset first invalidates the exact persisted vault revision and then moves the account to `needs-login`. Nonzero protocol responses are counted per live owner, and ten consecutive responses disable renewal on that owner. Empty-A1 success responses are local failures and do not increment that counter. The scheduler never invents a retry time: ambiguous or already-written requests are not retried automatically, and a protocol error requires a later explicit renewal request.

`SsoHeartBeat` and `Heartbeat.Alive` maintain liveness independently of renewal. Unexpected transport loss retires the old Bridge/OneBot generation before bounded stored-account recovery begins. Recovery may repeat session restore, but it never repeats a message or another business packet write.

## QR and persistence lifecycle

For a new QR account, encrypted checkpoint completion precedes selector publication and Bridge activation. A selector is published atomically and never replaced by a different UIN. QR access is tied to the exact running operation and generation; stop/cancel revokes that capability. The runtime does not unlink a QR solely from a pathname because the pathname is not a generation-safe deletion handle.

Normal stop preserves the selected account and encrypted vault. Loss of the master key is visible and never causes replacement of the existing encrypted record. Back up the vault, key directory, device state, selector, and strict login configuration together.
