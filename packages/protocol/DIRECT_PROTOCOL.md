# Independent QQ protocol research

This directory's `src/direct` modules are **experimental protocol building
blocks**, not an alternative login mode. SnowLuma still requires its existing QQ
process and Hook session. The transport uses a caller-supplied connected socket;
these modules do not establish a QQ session, calculate QQ signatures, manage
session tickets, or connect to the OneBot runtime. Tests use offline vectors and
loopback peers. A successful unit test is not evidence of QQ login or delivery.

## Target and evidence

The selected installation package is `QQ_3.2.35_261103_amd64_01.deb`,
188,287,504 bytes, SHA-256
`7de03862327abbd16da27130413698c9517782b27194afc593bc3abf9b55f9ac`.
The extracted `resources/app/package.json` identifies Linux x64 build
`3.2.35-54395` and Linux appid `537391511`. These are static declarations,
not evidence that a server accepts them for an independent client.

The extracted ELF `wrapper.node` has SHA-256
`dc5209e20002735e31a20c9cded0a807d1db4779277dec66c9221ea28a870328`.
Its bytes contain `wtlogin64.trans_emp` at file offset `0x883394`,
`wtlogin64.login` at `0x8833a8`,
`trpc.login.ecdh.EcdhService.SsoNTLoginRapidLogin` at `0x8580c5`,
`trpc.login.ecdh.EcdhService.SsoKeyExchange` at `0x88dc33`, and
`wtlogin_ecdh_session.cc` at `0x8fa1db`. String presence does not establish
the enclosing function, complete call graph, or byte-level login protocol.
The fixed public reference's server point and verification key were not found as
contiguous raw byte sequences in this one ELF; encoded constants, other modules,
and different implementations remain possible. No QQ client was executed or
hooked for these observations.

The application ASAR contains selected JS/HTML members that were not valid
UTF-8 during static analysis; the storage transformation remains unknown.
An external launcher contains a literal `require('../major.node').load(...)`,
which is a source-level boundary, not proof of a runtime call. The login,
key exchange, actual SSO wire format and signing logic of this particular build
remain to be recovered and independently verified.

## Offline components

- `src/direct/qq-tea.ts` implements the 16-cycle QQ-TEA primitive and framing.
  Its tests include synthetic vectors generated with the independent
  [MiraiGo implementation at a fixed revision](https://github.com/Mrs4s/MiraiGo/blob/2b2be6693df1219d867300c6f6cd0f804c59d620/binary/tea.go).
  A [format reference](https://github.com/hzruandd/python-qq/blob/master/socket-qq/tea.py)
  describes the padding and feedback. QQ-TEA is not authenticated encryption;
  successful trailer validation does not prove authenticity or a correct key.
  Do not expose detailed decryption outcomes to a network peer.
- `src/direct/sso.ts` implements an inner protocol-12/13 request encoder and
  response parser based on the field order in a
  [public protocol implementation](https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Struct/SsoPacker.cs).
  Its fixed examples are synthetic, manually derived from that reference; they
  are not captures or independently executed interoperability vectors. The
  caller supplies serialized reserved metadata. Resource and decompression
  limits are local implementation choices, not asserted protocol requirements.
  The response parser validates zlib integrity and rejects invalid UTF-8; both
  are stricter than the cited reference's raw-deflate and replacement-decoding
  behavior. Node's zlib decoder may accept trailing bytes within a compressed
  body. The parser returns body bytes even for nonzero return codes; callers
  must inspect the code. A decompression or parse error is thrown before a
  result is returned.
- `src/direct/sso-reserve.ts` builds reference-format reserved metadata with
  an explicit per-command signing policy and caller-supplied signer. It fails
  closed when a required signature is missing; it neither implements the
  signing algorithm nor determines the target build's signed-command policy.
  The external signer receives the full service command, account, unsigned
  32-bit sequence pattern, and a copy of the exact SSO body. Adapters targeting
  a signed-int32 API must preserve the sequence's bit pattern.
- `src/direct/service-frame.ts` implements the outer request and response layouts
  described by [ServicePacker](https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Struct/ServicePacker.cs),
  including flags for no encryption, D2 key, and the zero key. Request and
  response headers differ; they are not interchangeable. UIN validation and
  the frame size limit are local choices. Callers must verify that an inbound
  UIN matches the account owning the connection. Tests use synthetic manually
  derived frames, not live traffic or target-verified interoperability.
- `src/direct/service-stream.ts` incrementally separates inclusive-length service
  frames from arbitrary byte chunks, rejects oversized/truncated frames and
  retains at most one incomplete frame. It does not open a TCP connection.
- `src/direct/wt-tlv.ts` encodes and decodes counted WT TLV records with bounded
  lengths and preserves repeated tags. `src/direct/wt-ecdh.ts` implements the
  reference secp192k1 shared-X and TEA-key derivation; the peer key must be
  supplied explicitly. These are building blocks, not a QR-login implementation.
- `src/direct/key-exchange.ts` provides P-256 ECDH and AES-256-GCM primitives
  matching a public reference's key-exchange construction. Tests use synthetic
  vectors cross-checked with Node and .NET cryptography, not the target client.
  Server keys and request metadata must be supplied by the caller; the sample's
  actual key-exchange details remain unknown. The companion
  `src/direct/key-exchange-protobuf.ts` provides the corresponding field codecs
  using Proton. `src/direct/key-exchange-flow.ts` composes the protocol-12 key
  exchange frame and a one-shot response decoder. These do not establish a full
  login. GCM using an unverified response public key does not authenticate the
  server: the flow requires a caller-supplied response verifier, whose trust
  policy is not implemented here. Synthetic tests use a permissive verifier
  only for their in-process peer. Cancellation discards the retained handle, but
  JavaScript and the crypto provider do not guarantee secure memory erasure.
- `src/direct/tcp-packet-client.ts` adapts an already-connected socket to the
  existing `PacketSender` contract for protocol-13 frames. The caller must
  supply the account's D2 key, reserved-metadata builder and a response/push
  classifier; it must also handle classified pushes. Tests use a loopback peer,
  not QQ. No classifier or signing implementation for the target build has been
  recovered. An incorrect classifier can misroute messages. Once a request has
  been written, a timeout has an unknown outcome and must not trigger an
  automatic retry of a potentially non-idempotent action.

Run focused offline tests from the repository root with the pinned Node version:

```sh
pnpm --filter @snowluma/protocol exec vitest run tests/direct
```

The package exports these source modules through `@snowluma/protocol/direct/*`.
Existing package and Proton build requirements still apply.

## Reference-only QR research notes

The cited reference's ordinary PC QR branch generates a code with `0x31`, polls
with `0x12`, then sends `wtlogin.login`; its separate key-exchange path is used
for a stored-credential login. It reports QR states 0 (confirmed), 17 (expired),
48 (waiting for scan), 53 (waiting for confirmation), 54 (cancelled), and 144
(invalid). These observations are from the reference's
[login logic](https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Logic/WtExchangeLogic.cs)
and [state declarations](https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Events/Login/TransEmpEvent.cs),
not the supplied QQ binary's verified behavior. The reference handles the QR
response ticket via TLVs `0x1e`, `0x19`, and `0x18`; login success subsequently
provides D2, D2Key, A2, and A1 via another response. A working client also needs
online registration and heartbeat. The selected binary contains
`wtlogin64.trans_emp`, not the reference's exact `wtlogin.trans_emp` literal;
the relationship between these names remains unknown.

## Work remaining for direct operation

1. Establish the selected build's actual login, key exchange, key lifecycle,
   device and version fields, including how account ownership is bound. The
   reference implementation's PC QR path uses a separate `wtlogin.trans_emp`
   flow; key exchange alone is not a QR-login implementation. In that reference,
   QR generation uses subcommand `0x31`, polling uses `0x12`, and the OICQ
   envelope uses secp192k1-derived QQ-TEA rather than the P-256/AES-GCM flow.
   These are [reference observations](https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Packets/Login/WtLogin.cs),
   not verified facts about the supplied build. The reference derives the OICQ
   TEA key as MD5 of the complete 24-byte secp192k1 shared X coordinate, and
   prefixes a counted sequence of big-endian 16-bit tag/length/value records.
   Its request builder advances past 21 bytes without explicitly initializing
   them; their value is unknown.
2. Recover and verify the TCP service envelope, request/response sequence
   association, reconnect and unsolicited event handling.
3. Establish the signing inputs and signing implementation for the required
   commands; an external signing API contract alone is not the algorithm. The
   [reference signing whitelist](https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Common/BotSignProvider.cs)
   includes key exchange, `wtlogin.trans_emp`, `wtlogin.login`, and
   `SsoInfoSync`; it does not establish this build's signing behavior.
4. Implement and test account-isolated session lifecycle and a real
   `PacketSender` adapter; integrate with Bridge without inventing a QQ PID.
5. Independently compare encoded bytes with the target build and verify an
   actual user account session and delivery. Keep credentials and captures out
   of the repository.
