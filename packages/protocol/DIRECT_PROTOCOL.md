# Independent QQ protocol research

This directory's `src/direct` modules are **experimental protocol building
blocks**, not an alternative login mode. Jiyu, based on SnowLuma, still requires
its existing QQ process and Hook session. The transport uses a caller-supplied
connected socket; these modules do not establish a verified QQ session,
calculate QQ signatures, persist an online ticket lifecycle, or connect to the
OneBot runtime. The experimental attempt owner temporarily holds synthetic or
caller-validated login material in memory. Tests use
offline vectors and loopback peers. A successful unit test is not evidence of
QQ login or delivery.

Evidence in this document is separated into **target-static** (bytes and
instructions from the specified QQ build), **reference-static** (source from a
separately identified implementation), and **synthetic** (locally generated
vectors or loopback interactions). A finding in one category does not establish
the others.

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
The ELF's first `PT_LOAD` maps file offset zero to module-relative address zero,
so those string offsets also identify their module-relative addresses. The
`wtlogin64.trans_emp` and `wtlogin64.login` addresses appear as addends in
`R_X86_64_RELATIVE` relocation records at file offsets `0x576470` and `0x576488`,
respectively. A bounded disassembly at `0x6667140` shows a static lookup over a
24-byte-record table based at `0x902ac70`: it compares string lengths and bytes,
and the two command records both carry classification value `2`. A verified
static call chain from `0x66680b4` passes this classification into `0x666c390`;
for class `2`, that function selects a fixed data location and passes its 16 bytes
as the key to a 16-round TEA-style encryptor. In the observed branch the inputs
called `EncodeReqHead` and `EncodeBusiBuff` in adjacent diagnostics are combined
before encryption; the output is appended to the preceding `EncodeBasic` buffer,
then the overall byte length is written big-endian at offset zero. A bounded
inspection of `EncodeBasic` shows a four-byte placeholder, another big-endian
four-byte value, a classification byte, a conditional four-byte value or
inclusive-length-prefixed byte span, then another byte and an inclusive-length
prefixed string. An adjacent diagnostic labels the last string `uin`; the two
virtual-call results and field semantics are not fully resolved. In particular,
our reference-derived service encoder writes zero for the byte after the
conditional field, whereas the target reads a byte from its request object; it
is not yet established whether that target byte can be nonzero. A direct caller
at `0x66679aa` lies near `codec_processor.cc` and `EncodePacket` logs,
supporting an outbound packet-encoding interpretation. The relationship between
this target classification and the reference's encryption flags is not yet
established; the value `2` alone must not be equated with a zero TEA key. The
precise protocol fields and runtime reachability remain unknown; this is not
proof of signing behavior. No key material is recorded here.

The protocol-12 factory branch installs a virtual table whose `+0x20` entry
resolves to `EncodeReqHead` at `0x6669490`. Its bounded disassembly writes a
length, the request sequence, two caller-context 32-bit fields, then a 12-byte
region whose first byte is zero and whose next-to-last byte comes from a context
field. The reference-derived encoder instead writes `02` followed by eleven
zero bytes there, and hardcodes one preceding 32-bit value. Several subsequent
inclusive-length-prefixed byte strings are visible, but their complete semantics
remain unknown. Thus the reference encoder is not established as byte-equivalent
to this target's V12 branch; the observed differences are static code facts, not
a claim about any particular live session. Its reserve-building path calls an
object associated with `CPBMessageOpti`. Bounded inspection of its serialization
path shows fields 12, 13, 15, 16 and 32 written as wire-type-2 byte strings,
fields 21 and 26 as wire-type-0 unsigned values, and field 24 as a wire-type-2
nested message with up to three byte-string fields. Further bounded inspection
of `0x6669da0` and the repeated-object writer `0x8b47f10` identifies field 23 as
repeated wire-type-2 child messages, each with two wire-type-2 byte strings.
Source records are traversed in `0x30`-byte steps and appended in input order;
empty child fields remain present, so an all-empty record has the statically
derived encoding `ba01040a001200`. Empty collections omit field 23. The observed
builder skips serialization if only field 12 or field 23 was set; several
other fields enable serialization. In particular, `0x666a268–0x666a2d5` selects
field 13 by presence without a nonempty check, `0x8b47741–0x8b47768` and
`0x8b47b28–0x8b47b37` show the empty-byte wire path, `0x666a35c–0x666a383`
sets field 21 to 32 when both flags hold, `0x666a465–0x666a484` forwards field
26 when its presence flag is set without testing its value, and
`0x666a660–0x666a6bb` checks the three child strings before creating field 24.
The child container comes from the request object's pointer at `+0x98`, not
from the head context: its string offsets `+0x30`, `+0x00`, and `+0x18` feed
child fields 1, 2, and 3 respectively, when nonempty. This permutation is a
memory-layout observation, not evidence of signature or other business meaning.
The same `req + 0x98` container is also read by the bounded path beginning at
`0x666a830`; its constructor, population source and any relationship to signing
remain unknown. A caller at `0x66678b0` invokes a virtual slot compatible with the
observed V12 head encoder, but static inspection did not establish its runtime
receiver type or complete calling chain. A separately bounded wrapper path
at `0x6664434` passes a stack request to `0x66672f0`; immediately before that,
`0x6664411` calls `0x6665a90` with a destination at request `+0x98` and a
stack-sourced input. That helper transfers a pointer and clears the source slot;
if the destination held an old object, it releases that object's resources. On a
conditional earlier path, `0x6673480` invokes a virtual method and moves three
0x18-byte string-like objects from its output into a newly allocated object;
failure returns a null pointer. Nearby static diagnostic strings include
`security_sign_manager.cc`, `GetSignInfo` and `sign success`, which link this
bounded path to a signing-manager context. They do not establish the virtual
method implementation, field meanings, runtime reachability, signing algorithm
or usable signing service. The observed getter `0x6613810` copies a global
object/control-pointer pair and increments a reference count; `0x66137b0` sets
that pair from an input supplied elsewhere. Thus this observation does not
identify the implementation behind the signing-related virtual call. Bounded
searches did not establish the setter's caller or dynamic type; indirect calls,
other encodings and other modules remain possible. A complete inventory of this
ELF's 885 defined default/protected dynamic exports contains no symbol whose
value equals `0x6613200` or `0x66137b0` (REA evidence
`ev_6829f3d51f172faae17c5de300ab034d8496bae4e5913bea953c39d2f68b7722`).
This does not rule out local/hidden symbols, indirect calls, bindings or code in
other modules. In separate bounded instruction windows, the exported
`notifyRefreshSign` and `clearSign` both obtain a receiver from global
`0x9178fa8` and call its virtual slot `+0x28`; neither inspected window directly
calls `0x6613200` or `0x66137b0`. Their relationship to the object returned by
`0x6613810` is still unknown, as are the dispatch targets and signing algorithm.
The two constructed objects have separate virtual-table address points at
`0x902c6c8` and `0x902c7c8`; ELF relative relocations put `0x6713850` and
`0x6713c00` in their respective `+0x30` slots. Local instruction windows make
these slots candidate execution methods, not observed runtime calls. Both load
a receiver from global `0x9177e20`; their inspected callees did not establish a
connection to the signer setter. The dispatch receiver's `+0x28` and the
constructed objects' `+0x30` slots belong to different objects. The inspected
candidate paths both access the second receiver's `+0x30` and call `0x6725fb0`;
the clear path's subsequent pointer/count changes and releases are consistent
with deleting a node from an associated structure. A later bounded inspection
of the notify candidate `0x6724ce0` also shows a node insertion/update path:
`0x6724f3a` calls `0x6726100`, the new-node branch links a node and increments
a count, and `0x672502b–0x6725045` moves a temporary object into node `+0x28`.
Earlier in the same bounded path, `0x6724ce0` searches an associated structure,
compares three node fields, and returns zero when all three compare equal. The
examined continuation of `0x67252d0` cleans up temporaries and returns a saved
boolean; no direct call to the signing-manager setter was seen in those windows.
Another inspected function, `0x6725690`, searches a string-indexed structure via
`0x6725fb0`, then a second tree using an integer and may return a node's `+0x28`
address. Its relation to the outbound request's `+0x98` container is unknown.
This does not establish the structure's business meaning, callback execution,
or a link to the signing-manager setter.
These are bounded static observations, not runtime or peer-compatibility
evidence. Field meanings, upstream collection construction and signature
behavior remain unverified.

The packaged application declares an entry inside `application.asar`. The two
selected launcher entries in that archive were not valid UTF-8 in the static
analysis, so their code was not recovered. Separate plaintext launcher files
outside the archive contain calls to `major.node.load(...)`; they must not be
substituted for the archive entries. No path from those plaintext files to
`wrapper.node` or the signing-manager setter has been established. This is a
bounded static result, not proof that no such path exists.

The same outbound path builds the business buffer by a direct call at
`0x666794d` to `0x6667fa0`, not another virtual-table slot. That helper reads
the request object's byte pointer at `+0x80` and 32-bit length at `+0x88`, then
calls `0x6669c80` to write `BE32(length + 4)` followed by the unchanged body.
The main request entry rejects a null pointer or zero length; the lower-level
length helper itself can write a length-four prefix for an empty span. This
separates the observed request precondition from the helper's empty behavior.
Upstream body semantics and full native overflow/allocation behavior remain
unknown.

On the response side, bounded inspection of `0x6668330` shows an initial call
to `DecodeBasic` at `0x6668a50`. In that input span it reads two BE32 words
at offsets 0 and 4, one byte each at 8 and 9, and a byte string beginning with
an inclusive BE32 length at 10. Lengths below 4 fail; 4 represents an empty
string. On success its consumed length is `10 + string length`, which the caller
requires to be smaller than the input span. The first word is not compared with
the input length on this path, and the string's semantics are not established.
The byte at offset 8 selects `0x666c5a0` when nonzero, operating on the remaining
bytes and requiring nonempty output; the zero branch keeps the remainder. The resulting span is passed to
`DecodeRspHead` at `0x6668b50`, and its consumed length is checked against the
span before additional processing and a call to `0x6668d00`. The helper
`0x6669a10` reads an inclusive BE32 business length: values below four fail,
four yields an empty body, and larger values describe the following bytes. A
low bit of a decoded head field selects `UncompressBuffer` at `0x666c890`.
That function passes the body to the imported `uncompress` symbol through
call `0x666ca30`, PLT `0x8e10650` and the static relocation slot `0x915fa78`.
It makes at most four attempts whose output capacities are computed in 32-bit
arithmetic as 10, 20, 40 and 80 times the input length. Return code `-5` triggers a retry;
other nonzero codes fail. The ELF declares a dependency on `libz.so.1`, so zlib
wrapping is a reasonable inference, but the actual runtime binding, version,
supported input formats, dictionary and trailing-byte behavior remain unknown.
No absolute output limit was established on this path. The preceding length
helper also adjusts allocation before checking the read result; these static
observations are not a resource-safety guarantee. In `DecodeRspHead`, the
declared inclusive head length is checked against the whole incoming span and
the reader then resets its position to byte 4. The next BE32, at bytes 4–7, is used by a later
`seq_id` diagnostic; the following BE32 is at bytes 8–11. The reader is not
restricted to the declared head boundary while decoding the remaining fields,
so a short declared head can overlap bytes subsequently treated as business
body. A final BE32 read's success is also ignored before returning success.
These are static observations of the selected implementation, not validation
rules to copy into a new parser. In particular, the sequence's binding to a
particular request remains unproven. The next three fields are inclusive-BE32
length-delimited byte strings, followed by a BE32 word stored at `+0x58`, then
an inclusive-BE32 byte vector. On the inspected path, the low bit controlling
optional decompression comes directly from that word. A final BE32 read into
`+0x78` is attempted without checking its return value; the decoder leaves its
prior destination value unchanged if fewer than four bytes remain. A bounded
recheck follows `0x6668cd2–0x6668cdd` into `0x6668ec0` and `0x8b64950`: the
reader checks the remaining length of the original span, writes the big-endian
word only when four bytes remain, and then advances. The caller later starts
business processing at the declared head end, independently of this final read.
These byte strings and the final word retain unknown business semantics.

For the V12 path, `DecodeRspHead` reads a length-delimited byte vector into its
output; the inclusive four-byte length is not included in the vector. The V12
virtual slot `+0x28` resolves to `0x6669900`, which forwards that vector to
`0x666ad40`. An empty vector returns success without updating the initialized
output; a nonempty vector is passed to a `CPBMessageOpti` parser, and failure
stops packet decoding. On success, the caller compares an extracted head string
against a local collection. Only if that lookup succeeds and at least five bytes
remain after the declared head does it skip four bytes before decoding the
business wrapper. The skipped bytes are not checked on this branch. The
collection's origin, complete reserve wire types and business meaning are not
established; the conditional offset must not be inferred from synthetic headers.

The decrypt caller bypasses `0x666c5a0` for selector 0. Inside that function,
selector 1 takes a primary 16-byte candidate from one context object's `+0x78`
and, only after the first decryption fails, may try a second object's `+0x78`;
an absent primary immediately fails. Selector 2 references the same fixed data
location as the outbound class-2 branch. Other values fail in the callee. The
selected decrypt routine checks a minimum 16-byte, eight-byte-aligned input and
seven trailing zero bytes. These observations neither identify the objects or
key lifecycle nor prove that outbound classifier and response selector always
correspond. QQ-TEA framing checks are not server authentication, and static
inspection does not establish runtime response compatibility. The local
`target-service-decrypt-candidate.ts` accepts one explicitly supplied key for
selector 1 or 2 and never selects or falls back between keys. Selector 0
requires the key value to be absent or `undefined`. It returns only an
unauthenticated plaintext candidate, requires the caller to verify the original
frame independently, and enforces its own nonempty and size policies. This is
not an exact implementation of the native two-candidate retry behavior. The
current strict raw transport independently requires an inclusive length in the
first frame word; target-static `DecodeBasic` did not establish that check, so
this transport constraint must not be mistaken for a target validation rule.
A synthetic loopback test exercises the transport callbacks with basic parsing,
a single caller-supplied TEA key, strict head parsing, business framing and
explicit candidate inflation. Its verifier compares a fabricated fixture and
is not peer authentication; it does not establish QQ interoperability.

A bounded x86-64 disassembly also shows a `lea` at module-relative address
`0x34f8b6e` referring to `wtlogin_ecdh_session.cc`, near references to
`WTLoginECDHSession` and an ECDH V1 server-key-rotation message; another at
`0x34f97ec` occurs near `DecodeData` and an ECDH-decryption message. In the
latter neighborhood, the call at `0x34f97b1` targets `0x8866060`; bounded
instruction inspection shows big-endian word operations and a 16-round loop
with the TEA delta and shifts. Further bounded inspection of that candidate
shows the first decoded byte's low three bits used as padding length, output
length `input − padding − 10`, two block-feedback chains, and a seven-zero-byte
trailer check. These operations are structurally consistent with QQ-TEA
unpacking, but static analysis does not establish runtime reachability, key
provenance, a complete executable equivalence, or wire compatibility.
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

- `src/direct/target-sso12-reserve.ts` uses Proton to encode a constrained
  subset of the target's statically observed reserve fields. It preserves empty
  values where the observed path has presence flags and returns an empty buffer
  when only fields 12 and/or 23 are supplied. Field 23 is a repeated child message
  with two explicitly present byte fields, including empty values; collection
  order is preserved. The local policy limits that collection to 4096 records
  and rejects sparse arrays, accessors and shared buffers.
  Fields 13, 15 and 16 retain explicitly present empty bytes, field 26 retains
  an explicitly present zero, and field 24 is emitted only if a child is nonempty.
  Enabling field 21 writes the observed constant 32. Field numbers are
  intentionally not assigned business or signing semantics; the encoder is not
  a complete model of the target reserve.
- `src/direct/target-sso12-head.ts` encodes the statically observed V12 request
  header. The sequence, context numbers, opaque byte strings and already-encoded
  reserve are explicit inputs; it does not infer their semantics or create a
  signature. Its return value already contains the header's inclusive length and
  can be supplied as the head to `target-service-request.ts`. Length limits and
  rejection of shared buffers are local policies; target runtime compatibility
  is unverified. Head and reserve encoders best-effort clear their own temporary
  snapshots after success or failure; their returned buffers and caller input
  remain intact. This does not guarantee erasure of JS or Proton internal copies.
- `src/direct/target-service-response-basic.ts` reads only the observed basic
  prefix and length-delimited opaque bytes, retaining both words as unsigned
  values and byte 9 without assigning it business meaning. The parser accepts
  an exact-end basic segment; a packet caller still needs to enforce the
  observed requirement for remaining bytes. Its 16 MiB cap applies to the
  basic segment only, not the rest of the input. It neither treats the first
  word as a frame length nor decrypts or authenticates the remainder.
- `src/direct/target-sso12-response-head.ts` locally parses the three observed
  length-delimited byte fields, the flags word and the reserve vector strictly
  inside the declared head. The remaining bytes are preserved as an opaque tail;
  no final word, business meaning, authentication or automatic decompression is
  inferred. Unlike the observed native reader, this local parser rejects fields
  that cross the declared head boundary. Its allocation cap is a local policy.
- `src/direct/target-sso12-response-final.ts` models the final BE32 read for the
  subset accepted by that strict head parser. Given the complete plaintext span
  and a caller-supplied prior value, it reads from immediately after the reserve,
  including across the declared head boundary, or preserves the prior value if
  fewer than four bytes remain. It does not alter the declared head end or opaque
  tail. The whole-view 16 MiB cap is local; a successful read does not establish
  the outer caller's length condition, complete packet success, authentication
  or QQ interoperability.
- `src/direct/target-sso12-response-prefix.ts` probes only the first three
  big-endian words of a candidate response head and returns the remaining
  declared head bytes as an opaque copy. It locally requires at least 12 bytes
  within the declared head, stricter than the observed native `L >= 5` behavior;
  acceptance proves neither the rest of the head nor request binding or peer
  identity. Its 16 MiB cap and input checks are local policies.
- `src/direct/target-service-business-response.ts` parses one inclusive-length
  response business wrapper at a caller-selected offset and returns an independent
  body copy and next offset. A length of four is valid and produces an empty
  body; incomplete, undersized and locally oversized declarations fail before
  body allocation. It does not interpret the head flag, decompress the body,
  verify peer identity or bind the response to a request. Its 16 MiB cap and
  rejected shared buffers are local policies, not observed target limits.
- `src/direct/target-zlib-candidate.ts` offers an explicit local zlib-wrapped
  inflate candidate with caller-selected output limit and a 16 MiB local cap on
  input and output. It rejects trailing data using Node's consumed-byte count.
  It neither follows the target's retry policy nor establishes the target's
  runtime zlib binding, accepted format or trailing-byte semantics. The explicit
  transform described below can invoke it only when requested. A synthetic
  integration test separately composes the prefix probe, business wrapper and candidate inflate;
  that test also composes the basic prefix for a synthetic zero-selector case.
  It assumes no conditional four-byte skip, whose target applicability depends
  on a separate string-collection lookup; it does not infer a compression flag,
  prove full native header/reserve decoding, or authenticate a peer.
- `src/direct/target-response-transform.ts` composes the strict head and business
  wrapper parsers for an already caller-accepted view. The caller explicitly
  chooses a final skip of zero or four bytes and a compression policy; a set
  low flag bit triggers the zlib candidate only when explicitly selected. The
  returned offsets leave outer trailing bytes to the caller. As local resource
  policies, the entire input view—including those trailing bytes—and the chosen
  output budget are each capped at 16 MiB; the budget also applies to unchanged
  bodies. This is stricter than separately bounded fields and is not a target
  limit. The transform does not authenticate, establish the lookup decision,
  prove native decompression behavior or verify QQ interoperability.
- `src/direct/target-response-candidate.ts` composes the basic prefix, a single
  explicit-key decryption candidate and that bounded transform. The caller must
  independently verify and isolate the same frame bytes supplied to it; this
  composition does not establish authentication or request binding. Selector 0
  takes no key; selectors 1 and 2 each require one caller-provided key and do not
  fall back. The first basic word is preserved rather than treated as a frame
  length. Basic offsets refer to the supplied frame view; head and business
  offsets refer to the plaintext candidate, not the encrypted wire. Opaque basic
  data, head tail and post-business trailing bytes remain separate outputs. A
  synthetic loopback test composes this stage inside `transactRaw()` after a
  fixture verifier accepts its frame and publishes only after the transaction
  succeeds. On cancellation the test caller clears its staged result; the raw
  transport itself does not clear arbitrary values returned by a consumer. The
  loopback framing requires the first word to equal frame length, a local
  transport condition not established for the target's basic decoder.
- `src/direct/target-service-business.ts` frames a nonempty raw request body as
  `BE32(body length + 4) || body` for the observed main-request path. The
  standalone helper's empty-body behavior differs from the main entry; this
  encoder deliberately models the latter's nonempty precondition. The 16 MiB
  inclusive cap and rejected shared buffers are local policies, not target limits.
- `src/direct/target-service-request.ts` models the observed class-2 outbound
  branch of the selected build: it constructs `EncodeBasic`, encrypts the
  caller-provided request head and business bytes together, appends them, and
  writes the overall length. Only the two observed `wtlogin64` commands are
  accepted; protocol value, basic branch, request byte, identifiers and the
  16-byte TEA key must be explicitly supplied. The key is neither embedded nor
  extracted by this module. Synthetic integration tests compose reserve, target
  V12 head, business framing and this branch, check each inclusive length and
  decrypt the result using a test-only key. Its 16 MiB limit and input validation
  are local choices; these vectors do not demonstrate target execution or server
  compatibility.
- `src/direct/qq-tea.ts` implements the 16-cycle QQ-TEA primitive and framing.
  Its tests include synthetic vectors generated with the independent
  [MiraiGo implementation at a fixed revision](https://github.com/Mrs4s/MiraiGo/blob/2b2be6693df1219d867300c6f6cd0f804c59d620/binary/tea.go).
  A [format reference](https://github.com/hzruandd/python-qq/blob/master/socket-qq/tea.py)
  describes the padding and feedback. QQ-TEA is not authenticated encryption;
  successful trailer validation does not prove authenticity or a correct key.
  This implementation rejects nonzero trailer bytes. The cited Lagrange reference
  does not explicitly clear every trailer byte in its stack-allocated encryption
  path, so strict trailer validation is a local policy, not proof that every
  reference-generated packet will pass. Do not expose detailed decryption
  outcomes to a network peer.
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
  supplied explicitly. `src/direct/wt-oicq.ts` encodes reference-style OICQ
  `0x812` and PC login `0x810` requests and decodes selected response encryption
  forms. The `0x810` encoder wraps a caller-provided body; it does not sign,
  send or log in. Its response framing checks are stricter than the reference,
  and the caller must bind decoded account, command and sequence to the active
  session. QQ-TEA decryption alone
  does not authenticate the response.
- `src/direct/wt-qr-request.ts`, `wt-qr-protobuf.ts` and `wt-qr-response.ts`
  implement reference-style QR request bodies, D1 protobuf and selected response
  bodies. The response parser rejects duplicate TLV tags (the reference uses
  last-wins) and requires the caller to delimit the exact business body: a final
  byte is not automatically treated as an OICQ trailer. D1 unknown fields retain
  diagnostic metadata only; their raw values are not replayed on re-encoding.
  Response tickets are sensitive and must not be logged.
- `src/direct/wt-qr-frame.ts` constructs reference-style QR OICQ bodies and can
  also compose a protocol-12/zero-key service frame. Construct an OICQ body once
  and pass those same bytes to the SSO sender: separate constructions use fresh
  random TEA padding and produce different signatures. The service name, peer
  key, skipped bytes, account and signing policy are explicitly supplied. A
  loopback test combines the OICQ builder with the protocol-12 sender; this is
  not a QQ login or target compatibility test. The standard ECDH context returns
  a fresh public-key copy on each read and prevents facade replacement; callers
  supplying substitute contexts remain responsible for key pairing.
- `src/direct/wt-login-request.ts` builds the reference PC `0x810/9` business
  body with caller-provided device values and temporary tickets. The reference
  skips twelve bytes when constructing TLV `0x124`; their contents are not
  established, so this implementation requires those bytes as explicit input.
  It also rejects UINs larger than 32 bits rather than silently truncating the
  reference's corresponding field. A synthetic integration test composes this
  body with the `0x810` envelope and checks it with an independent ECDH peer;
  these local constraints and vectors do not prove target compatibility.
- `src/direct/wt-login-response.ts` parses reference-style `0x810/9` business
  responses and decrypts `0x119` using a caller-supplied `TgtgtKey`. Ticket
  fields are only returned after local structural checks; parsed tickets do not
  prove an authenticated login. The caller must bind the outer command, account
  and sequence to the pending session. Failure now best-effort clears owned TLV
  and partial ticket copies, and the returned decryption plaintext is cleared on
  both success and failure. The TLV parser similarly clears its unreturned copies
  after a late parse failure. Successful results transfer independent copies to
  the caller; caller input and keys are preserved. This does not guarantee erasure
  of crypto-internal padded data, strings or runtime copies. No ticket data should
  be logged.
- `src/direct/wt-reference-login-attempt.ts` experimentally joins reference QR
  fetch/poll and `0x810` on one caller-supplied connected socket. Explicit raw
  trust, context, signing and business-slice policies are mandatory. Temporary
  tickets remain private to a single-use confirmation state; local lifetime
  limits include that state. Its successful ticket result includes the confirmed
  UIN associated with that attempt, rather than substituting the initial transport
  UIN; the account remains subject to the caller's verification policy. Signer
  output is copied before the callback's input buffer is cleared, including when
  it aliases that input. Callback-visible verification copies are independently
  cleared best-effort. Neither behavior establishes server authentication. The
  result does not mark online status or attach to Bridge. See the reference lifecycle notes below for the
  synthetic coverage and remaining verification gaps.
- `src/direct/wt-qr-flow.ts` coordinates a reference-style fetch and poll on
  one caller-supplied connected socket, with explicit timestamp, response and
  context verification and business-body boundaries. It closes on confirmation,
  terminal failure or cancellation, without handing off its socket or ECDH
  context to `0x810`. Its response verifier sees decoded OICQ bytes and local
  SSO binding, not the complete wire frame; it must not be mistaken for an
  implemented server-authentication protocol. The current fetch/poll errors are
  generic and do not distinguish timeout, trust-policy rejection and parse
  failure. QR URLs, signatures and tickets are sensitive; do not log them.
- `src/direct/wt-login-flow.ts` combines the reference-style login body, OICQ
  envelope and SSO 12 frame into a one-shot transaction. It requires the caller
  to provide an exchange, an independent server-verification policy and exact
  business-body boundaries. A permissive test callback is not authentication;
  the module returns ticket copies but neither stores them nor registers online.
  It is not wired to `Sso12PacketClient` and does not establish continuity with
  the preceding QR flow. JavaScript and external callbacks may retain copies of
  sensitive data, so memory clearing is best effort.
- `src/direct/sso-reference-register-flow.ts` composes an experimental one-shot
  registration transaction using a new caller-supplied connected socket, a
  reference login ticket result, caller-supplied signer and raw-frame verifier.
  It verifies through that caller policy before decoding, then checks the
  reference envelope account, command and local sequence before classification.
  It accepts a caller-provided ticket object and cannot prove that its ticket
  bytes originated from the stated UIN; the caller must maintain that association.
  SSO header version and registration build version remain distinct. It closes
  the claimed socket and does not retry, mark the account online, authenticate
  the server or establish compatibility with the selected QQ build. Callback
  byte snapshots are wiped best-effort after completion or cancellation; the
  callback may retain copies or continue its own side effects. A synthetic
  two-socket test passes the login result directly to registration after the
  login socket closes, and exercises success, raw-verifier rejection, and
  abort/timeout while the verifier is pending. In those synthetic failure cases,
  the test observes no additional write or decode after releasing the verifier;
  it does not establish arbitrary late-callback behavior or cancel effects
  performed by the callback itself. Its fabricated peer and verification policy
  do not prove server identity or wire compatibility.
- `src/direct/sso-register.ts` encodes the reference PC registration and SSO
  heartbeat bodies, and classifies a registration response using its command,
  SSO return code and exact `register success` message. Account and sequence
  binding remain the transport caller's responsibility. Explicit defaults follow
  static analysis of the reference serializer; hand-derived vectors have not
  been compared with the running reference or target. These codecs do not perform
  registration, change online state, schedule heartbeats or validate server identity.
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
- `src/direct/sso12-packet-client.ts` is a single-flight protocol-12 client for
  an already-connected socket, with caller-supplied account policy, classifier,
  signing metadata, device parameters and zero-key or D2-key encryption. It
  closes on a classified push, timeout or cancellation and never replays the
  request; a timeout after writing leaves its outcome unknown. The protocol-12
  and protocol-13 adapters share a socket ownership registry so they cannot
  simultaneously own the same socket; callers must also avoid attaching other
  consumers. `getProfile()` returns a fresh GUID copy along with the configured
  account, sub-app ID and version; account and device identifiers should not be
  logged.
  `sendBoundPacket()` reports the sequence and command matched to the pending
  request, including for nonzero SSO return codes. The ordinary `sendPacket()`
  and `sendBoundPacket()` paths decode and may decrypt an incoming service frame
  before checking its UIN; they offer no raw-frame verifier and can report
  different failures for decryption and UIN mismatch. Such binding follows the
  caller's policies and is not server authentication. Use the separate raw path
  when caller verification must precede decoding. Its experimental
  `transactRaw()` offers a separate single-flight path that gives a bounded
  candidate wire frame to caller callbacks before the library decodes it. The
  returned sequence is the local allocation, not proof of a response match; the
  caller must verify all semantics and peer trust. The selected target's response
  selector 1 and 2 key paths have separate static evidence but are not wired to
  this reference transport; no key identity or selector/class equivalence should
  be inferred. Callback context is caller-owned,
  and callback byte copies are best-effort wiped after use; a callback must make
  its own copy of any bytes it needs to retain. Cleanup uses a captured typed-array
  intrinsic and handles detached callback buffers independently, so replacing an
  instance's `fill` method or transferring its backing does not prevent transaction
  settlement. It does not erase transferred or other externally held copies.
  Deadlines and abort handling run
  on the JavaScript event loop: a synchronous callback can block them, and an
  asynchronous callback can continue its own external side effects after the
  transaction has timed out. Callers must stage effects until successful return
  and implement any stronger cancellation independently. `writeState: unknown`
  means a write was attempted, not that the peer received or rejected it. Extra observed
  data during this strict transaction closes the connection. Request-frame input
  rejects shared backing buffers and proxy-bearing prototype chains before copying;
  prototype traversal is locally bounded to 256 levels and keeps the previous
  local-realm view restriction. External code must not pause the owned socket or
  alter its reading mode. These checks cannot establish
  when bytes still in the operating-system buffer arrived. The client cannot verify
  that an opaque body was built for the same account and device profile; an
  eventual login orchestrator must enforce that relationship. This reference-only
  client neither logs in nor completes registration and has only synthetic
  loopback coverage.
- `src/direct/tcp-packet-client.ts` adapts an already-connected socket to the
  existing `PacketSender` contract for protocol-13 frames. The caller must
  supply the account's D2 key, reserved-metadata builder and a response/push
  classifier; it must also handle classified pushes. Tests use a loopback peer,
  not QQ. No classifier or signing implementation for the target build has been
  recovered. An incorrect classifier can misroute messages. `whenClosed`
  resolves after socket closure, pending-request failure and internal key cleanup
  with a typed, bounded reason; it does not automatically reconnect. This adapter
  cannot send protocol-12 registration or SSO-heartbeat requests. Once a request
  has been written, a timeout has an unknown outcome and must not trigger an
  automatic retry of a potentially non-idempotent action.

Run focused offline tests from the repository root with the pinned Node version:

```sh
pnpm --filter @snowluma/protocol exec vitest run tests/direct
```

The package exports these source modules through `@snowluma/protocol/direct/*`.
Existing package and Proton build requirements still apply.

## Experimental integration contracts

The two encoding families are separate:

| Family | Inputs supplied by caller | Current boundary |
| --- | --- | --- |
| Target-static reserve/head/service | Opaque target-context fields, already-encoded business bytes and the class-2 TEA key | Pure encoding only; no socket, signature or authenticated response implementation |
| Reference login attempt | An already-connected socket, device profile, signing callback, independent raw/context verification and exact business slices | Synthetic QR-to-ticket lifecycle; no online registration or Bridge integration |
| Reference registration attempt | A new connected socket, account-bound ticket result, device fields, signing callback and independent raw verifier | One synthetic request and reference classification; no server-authentication implementation, heartbeat lifecycle or online state |

For the target family, pass the reserve encoder's bytes directly to the head
encoder's `reserved` field, and pass the head's complete output directly to the
service encoder's `head` field. Each output already contains the length framing
specified by its own layer; do not insert another head-length prefix. The service
encoder's `busi` is the separately encoded business buffer, not automatically a
raw OICQ message. For the observed target path, this buffer is an inclusive BE32
length followed by the raw request body. The current service encoder does not
add that business prefix or validate its contents; passing an unwrapped OICQ
message would omit a statically observed layer. Use
`encodeTargetServiceBusiness(rawBody)` to produce this buffer for a nonempty
body, then pass its result as `busi`. Never substitute a zero or invented key
for the target's key and interpret a local encryption success as protocol
compatibility.

For the reference attempt, the caller retains responsibility for endpoint
selection and connection establishment. Call `fetch()`, manually poll while the
result is `wait` or `confirm`, and call `login()` only after `confirmed`. Status
`confirm` still means waiting for user confirmation. Do not log the QR URL,
image contents, raw frames or ticket results. `timeoutMs` bounds a transaction;
`attemptTimeoutMs` also covers idle time while confirmation is held, and neither
is a recovered server-expiry rule. Always close an abandoned attempt.

Raw and context callbacks returning `true` in synthetic tests are fixture
policies, not reusable production authentication. Raw verification precedes
library response decoding; a verifier's own metadata parsing is only an
untrusted preview unless supported by independent trust. Verification inputs are
copies and are cleared after use. Any retained callback data or asynchronous
external side effects remain the callback owner's responsibility. No automatic
verification-challenge completion or failed-write replay is provided.

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

The reference's confirmed QR response supplies temporary `TgtgtKey`, `NoPicSig`
and A1 values. Its PC `wtlogin.login` then constructs OICQ `0x810` subcommand
`0x09` with 15 TLVs. On a successful login response, the reference decrypts
TLV `0x119` using `TgtgtKey` and reads D2 (`0x143`), D2Key (`0x305`), A2
(`0x10a`), and A1 (`0x106`). The temporary A1 and returned A1 are separate
values. These details are [static reference observations](https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Services/Login/LoginService.cs),
not evidence of the selected build's behavior. A complete ticket set is not by
itself proof of registration or server acceptance.

In the reference's ordinary PC path, QR and `0x810` use the same keystore's
secp192k1 context and random key. After confirmation the returned UIN is assigned
before the login request; the uninterrupted path uses the same `SocketContext`
without an explicit reconnect. The QR business fields containing zero UIN do not
prove that every surrounding header uses zero: those headers use the keystore's
current UIN. See the [reference transition](https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Logic/WtExchangeLogic.cs#L425-L465)
and [packet sending path](https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Context/PacketContext.cs#L34-L81).
This does not establish what the target server requires. The current experimental
QR flow closes its socket after confirmation and does not transfer its ECDH
context to the separate login transaction, so those two modules are not yet a
complete reference lifecycle.

The separate experimental `WtReferenceLoginAttempt` now models that continuity
using one socket owner, sequence allocator, ECDH context and random key. Its
manual `fetch()`, `poll()` and `login()` operations use `transactRaw()` and keep
confirmed temporary tickets private. The confirmed UIN is range-checked and
used for login, while the transport lease still reports the initial UIN. A
successful synthetic loopback exchanges fetch, waiting states, confirmation
and `0x810` over one connection; this does not prove target compatibility or
that the server requires one physical socket.

This new owner passes independent copies of the actual request frame and raw
candidate response to the caller's explicit trust policy before library
response decoding. It does not re-encode responses as evidence or add another
socket reader. Consumer results are staged until the raw transaction succeeds;
local per-request and whole-attempt deadlines include time spent holding
confirmation. Failure closes the attempt without automatic write replay.
Tickets only establish a parsed structure, not registration or online state.
The owner remains reference-only, separate from both the target encoders and
the production Bridge. After raw and context verification and a successful
transaction, `login()` can also return `verification-required`, `nonzero` or
`incomplete` with the numeric business state, or `error` with state and numeric
code. These non-ticket outcomes terminate the attempt and clear its temporary
material; they do not initiate a verification challenge or retry. Server error
text and raw TLVs are omitted. Malformed bodies and rejected trust/context
policies still throw generic errors; an incomplete parsed outcome is not a
replacement for structural validation. Its complete response-mismatch,
reentrancy, late-callback and cleanup-race matrix is not yet fully covered.
Additional real-Proton loopback regressions cover mismatched SSO sequence and
command, mismatched login OICQ UIN and command with valid business bodies, a
positive control, out-of-range confirmed UIN, socket ownership contention and
cancellation during raw verification. These tests verify local rejection behavior,
not the target's response conventions or cryptographic trust.
Bounded independent probes covered invalid login byte inputs, malicious slice
objects, signal handling, cleanup after a slice failure, and staged tickets
invalidated before commit. Follow-up bounded probes checked typed non-ticket
results, rejected raw/context policies, malformed inner ticket data and closure
after a non-ticket result was staged but before commit. Some probe inputs used
a local protobuf stub, so those probes establish lifecycle behavior only, not
complete codec integration.

In the same reference, `SsoInfoSync` registration and `SsoHeartBeat` use
protocol 12 with D2-key encryption. The registration logic marks the account
online only when the response message is exactly `register success`; a zero SSO
return code alone is insufficient. A separate `Heartbeat.Alive` uses protocol 13
without encryption. These are [reference implementation observations](https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Internal/Logic/WtExchangeLogic.cs),
not verified facts about the supplied QQ build. Current standalone code does not
complete the registration or heartbeat lifecycle.

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
