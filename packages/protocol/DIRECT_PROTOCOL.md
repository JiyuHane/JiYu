# Independent QQ protocol research

This directory's `src/direct` modules are **experimental protocol building
blocks**, not the default account backend. Jiyu, based on SnowLuma, preserves
its existing QQ-process/Hook integration, OneBot runtime and default WebUI.
The separate, explicitly started [direct-login tool](<../../tools/direct-qq-login/README.md>)
has exercised real Linux QR login, registration and heartbeats without a QQ desktop
process or Hook. Its [local native signing worker](<../../tools/local-qq-sign/README.md>)
still relies on the specified official Linux component; it is not an independent
pure TypeScript signing algorithm. Protocol constructors consume a caller-supplied
connected stream rather than opening sockets themselves.
Opt-in encrypted ticket storage and a distinct saved-D2 registration owner are
specified below; storage success and local decoding alone do not establish a
live account. Tests use offline vectors, loopback peers and synthetic subprocesses.
A successful unit test is not evidence of QQ login or delivery. The separate Android AArch64 `libfekit.so` sample and
its bounded signing-related investigation are documented in
[QQ_SIGNATURE_RESEARCH.md](./QQ_SIGNATURE_RESEARCH.md); that sample is not the
Linux `wrapper.node` identified below.

Evidence in this document is separated into **target-static** (bytes and
instructions from the specified QQ build), **reference-static** (source from a
separately identified implementation), **synthetic** (locally generated vectors
or loopback interactions), and **target-runtime** (executing the pinned component
with explicitly described inputs). The local signing checks below combine
synthetic inputs with actual target execution; they do not establish a QQ
service accepting those outputs. A finding in one category does not establish
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
REA's independent ELF-note inspection of that digest reports GNU build ID
`29595d4c6b8f42ee` (Evidence
`ev_e1f49c53fd22c261bb9436b99e56049d3f257674c2b9951c91fc7340adff066a`).
Its `PT_NOTE` and `SHT_NOTE` refer to the same underlying note at file offset
`0x2a8`; they are not independent copies or runtime evidence. Its bytes contain
`wtlogin64.trans_emp` at file offset `0x883394`,
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

Separately, bounded target disassembly associates `0x3453550` with the
`QRCodeCMD31` body encoder; an inspected caller sets `0x31` before invoking it.
Under normal-return and valid-memory assumptions, it writes, in order, a BE16
length followed by bytes from object `+0x38`, BE32 from `+0x50`, BE64 from
`+0x30`, one byte from `+0x54`, a BE16 length followed by bytes from `+0x58`,
and BE16 from `+0x80`. Both byte lengths exclude their own prefixes. The target
helpers write the low 16 bits of a length and then write the length represented
by their 32-bit input; rejecting spans over 65535 bytes is a stricter local
policy. The routine then
traverses nodes rooted at `+0x70`: it uses each node's `+0x20` value in a log,
and, when the object at `+0x28` is nonnull, calls its virtual `+0x18` method
with the same writer. The parent itself does not add a tag or length around
that virtual call; null objects produce no such call. The meaning of `+0x80`,
child encodings, runtime path and relationship to `wtlogin64.trans_emp` are not
established by the body encoder alone. Separate bounded tracing of the
`0x346de60` construction path found that `+0x80` starts at zero and increments
after each successfully linked new tree node; duplicate keys skip that
increment. With valid, unmodified tree state and normally returning operations,
the tree is traversed in ascending unsigned 16-bit key order: the seven observed
fixed keys are `0x16`, `0x1b`, `0x1d`, `0x33`, `0x35`, `0x66`, `0xd1`, with
`0x11` added on a separate nonzero condition. The resulting count is conditional
on those insertions; it is not necessarily the number of child outputs, because
null children are skipped and child writes may fail. On the selected construction
path the `0x1d` child has a zero first byte, BE32 `0x7ffc`, another zero word
and zero array count; this differs from the reference's first-byte value. The
`0xd1` child invokes the target protobuf writer for nested field 1 with two
explicit byte-span fields and nested field 4 with field 6 set to one. One static
inspection also found that the writer retains empty spans; the explicit-empty
wire vector remains a local candidate, not a runtime packet observation.

On this zero-initialized construction path, `0x3476c30` wraps the QR31 body
with a 43-byte header starting with `0x02`, a BE16 total-frame length, command
`0x31`, and a final `0x03` trailer. A 64-bit header field is written as zero on
this path: copying the body object's `+0x30` value to the corresponding header
field occurs only after that field has been serialized. Independently inspected
code under `GetQRCodePicture` then wraps the result as `0x00`, BE16 of inner
length plus four, BE32 of an explicit context value, BE32 `0x72`, two zero
bytes, one zero byte, BE32 of another runtime value, and the inner bytes. The
outer length is not the total outer-buffer length. A separately inspected QR
picture callback passes that buffer onward with command `wtlogin.trans_emp` and
code `0x812`; two callback storage variants reach the same handler. That
handler forwards the command and encoded packet to an unresolved receiver's
virtual method. Its relationship to `wtlogin64.trans_emp` remains unknown.
These observations assume normal construction, unmodified inputs and successful
writes; they do not establish runtime dispatch, signatures or server acceptance.
Native length fields keep low 16 bits; local encoders may reject overflow
instead. The target OICQ success path has a separate 25-byte header: an
explicit version, command, sequence and account word followed by three flag
bytes, a 32-bit zero-extended client-type field, public-number word and zero
instance word. It is followed by the entire output of `0x34f9170`, not simply a
raw ciphertext. This differs from the reference header by two bytes. The
inspected `0x34f9170` path selects between two key inputs or an empty-payload
branch according to context bytes, then writes a mode byte, context byte,
16-byte local value, conditional BE16 fields, a BE16-length optional span and
payload. Two bounded inspections connected one QR entry at `0x34bcc04` to a
new owner when its cached owner is initially null: construction and subsequent
self-binding give the callback that same owner's sender, whose new context has
selector 1, `ctx+4=0`, `ctx+5=1` and `ctx+6=1`. Under successful construction,
no intervening replacement and successful callback promotion, this path selects
the key input at `ctx+0x18`. An initially cached owner and other QR entry points
remain unresolved. The context constructor can use a fallback when its primary
initializer returns zero; a nonzero return alone is not proof of a successful
cryptographic derivation. No actual session key or peer use has been observed.
In the normal bounded path of its `0x8865bb0` helper, two independent static
inspections found the padding, seven zero trailer bytes, big-endian 16-round TEA
and two feedback chains structurally consistent with local `qqTeaEncrypt`. The target calls its
random generator once per byte, whereas the local implementation requests the
random bytes in one call; their generators, failures and runtime outputs have
not been shown equivalent. Static reconstruction alone does not establish the
QR request's selected encryption branch, session keys or compatibility.

Two bounded static inspections of the security-sign policy found that its
constructor initializes mode 2 and inserts the exact command
`wtlogin.trans_emp` into the initial command tree. A mode-2 tree match requests
a signer without consulting the signer's command-predicate slot. The constructor
then invokes a configuration loader which can overwrite that mode; a missing or
unsuitable configuration leaves the initialized value unchanged. The sender's
receiver has not been identified as this particular policy instance, nor has
any concrete signer implementation or live configuration been established.
The inspected signer call site continues packet construction when the signer is
absent or returns failure; this is not evidence that a server accepts such a
packet.

A separate bounded inspection of the target's QR31 response decoder at
`0x3453dc0` finds a BE16-length string, a BE32 word, and a status byte. Status
bytes `0` and `2` follow the same branch: a BE16-length raw byte span, a BE16
count, and that many entries with BE16 tag, BE16 value length and value bytes.
Other status values read another BE16-length string. The string helper consumes
its declared bytes but assigns only up to the first NUL; the raw span helper
preserves NUL bytes. In the inspected helpers a zero length returns success
without assigning the destination, whose prior state remains unknown. Parsing
entry boundaries does not establish that the target decoder accepts the result:
it also invokes a tag factory and a child decoder, either of which can fail.
Status meanings, field semantics, trailing data and actual server behavior
remain unknown; strict local bounds and exact-slice policies are not target
acceptance rules.

The target QR12 query construction path at `0x3455b60` supplies a zero-initialized
object to `0x345c670`. Its body writer emits a BE16-length string, BE32, a
BE16-length span, BE64, one byte, a second BE16-length span, and a BE16 count
followed by that many BE16 values. In the inspected caller's normal unmodified
path, the first string, second span and value array are empty; the BE32, BE64
and first span are supplied from the caller context. The zero-initialized frame
uses the same 43-byte structure as QR31 with command `0x12`; the BE64 extension
is serialized before the later field copy, and so remains zero in this path.
These are conditional static observations, not a server acceptance claim.

The QR12 response candidate at `0x34536a0` begins with the same string, BE32
word and status-byte shape, followed on complete input by BE64, BE32, BE16
count and BE16-tag / BE16-length / value entries. The inspected status-zero
branch checks the BE64, BE32 and count reads; the nonzero branch does not check
those three return values and can continue after a short read. Both branches
still invoke the tag factory and child decoders. A local parser that requires
all fields is therefore deliberately stricter on truncation, not a model of
all native acceptance paths. These status bytes and values have no established
business meaning or peer authenticity. On the inspected status-zero path, the
child decoders for tags `0x18`, `0x19`, `0x1e`, `0x65` and `0x3f` copy their
entire outer TLV value, without another length prefix, into response fields
`+0x68`, `+0x98`, `+0x80`, `+0xb0` and `+0xc8` respectively. In the normal
successfully decoded path, a repeated one of these tags replaces the previous
vector, including when the later value is empty. Other tags and exceptional
native behavior remain outside that observation. A further inspected status-zero
branch constructs a separate success object: response fields `+0x80`, `+0x68`, `+0x98`, `+0xb0` and `+0xc8`
are transferred to success offsets `+0x10`, `+0x28`, `+0x40`, `+0x58` and
`+0x70`. The last two originate from tags `0x65` and `0x3f` respectively on the
inspected path. Two static traces connect this object through a callback and an
adjustor thunk to `OnQRCodeSessionSucceed`, conditional on successful self-bound
owner construction, no later pointer replacement, a successful weak-reference
promotion and actual callback execution. On an inspected normal branch,
`OnQRCodeSessionSucceed` supplies the vectors from QR tags `0x19` and `0x65`
to a WT session routine which constructs node tags `0x016a` and `0x0318`.
For these nodes the encoder is virtual slot `+0x10` and writes BE16 tag, BE16
value length and raw bytes; an empty value still produces a zero-length node.
Another optional node `0x0108` exists, but its presence flag is clear on this
observed QR branch, and it has not been tied to tag `0x3f`. Further bounded
static inspection connects the constructed node pointers to a conditional login
body producer: `0x34fe100` passes the object containing pointers at session
`+0x268` and `+0x270` to `0x3469090`, which conditionally inserts them under
`0x016a` and `0x0318` in a second tree. A pointer and length derived from
session `+0x2b0/+0x2b8` are copied into a `0x0106` node; a separate span from
`+0x298/+0x2a0` supplies a span to `0x3468790` before a `0x0144` node is
built. In the inspected normal path, `0x3469090` constructs a four-pointer
vector containing a locally constructed `0x016e` node, `[session+0x200]`,
`[session+0x230]`, and the result of the `0x0124` factory selector. Given
valid objects and successful writers, `0x3468660` prefixes the number of
objects as BE16 and calls each object's virtual slot `+0x10` in that order.
`0x3468790` passes the resulting plaintext and the `+0x298` span's starting
pointer to `0x8865bb0`; the inspected encryption path reads four 32-bit words
from that pointer. At least 16 readable bytes are therefore a precondition of
that path. The observed call sequence does not establish a local length check;
an earlier call and other invariants were not ruled out. In the inspected caller,
`0x34fe18a–0x34fe1cf` loads `session+0x298` and `+0x2a0`, subtracts the former
from the latter, places the resulting pointer and length at the call stack and
calls `0x3469090`. Its prologue and `0x34691ad–0x34691ee` recover those stack
arguments; under preserved-register and stack-slot assumptions, `0x34692e4`
saves the pointer and `0x3469245` saves the length for the later call. At
`0x3469397–0x34693a4` those saved values are supplied to `0x3468790`; the
inspected `0x346881f–0x3468830` call passes the pointer as the third argument of
`0x8865bb0`. These observations alone do not identify who populated the original
span or prove its business role.

A further bounded inspection finds that `0x34fe100` first calls `0x34fe6a0`
with the same receiver. If the receiver's `+0x2c8` byte is zero, that function
allocates and zeroes 16 bytes and calls `0x3479670` with the buffer and length
16. The inspected `0x3479670` path opens `/dev/urandom` and uses a loop around
an imported `read` symbol, retrying `EINTR`; it can also leave early on errors
or a nonpositive read. The observed caller does not check a success result for
that fill. It next calls `0x34ff570` with the same 16-byte pointer; nearby
strings label the latter `CreateTGTGTSig`. In its inspected continuation,
`0x34ff7f2–0x34ff860` forwards the saved pointer and length in stack arguments
when calling `0x3504d80`; the latter's effects on the buffer are not established.
If `+0x2c8` is still zero at the later check,
allocation and copying succeed, saved pointers remain intact and the indicated
branch is reached, `0x34fe7dc–0x34fe817` allocates a new 16-byte vector at
`session+0x298`, copies the buffer into it and sets its end pointer to begin
plus 16. If the byte was nonzero on initial entry, this initialization is
skipped. Multiple reads, calls, write failures, concurrent changes and other
writers prevent treating these static instructions as observed randomness, a
complete key lifecycle or proof that the QR response supplies this value. The
separate output from `0x34ff570` is also used on this path. In the inspected
`0x34ff570 → 0x3504d80` call, the supplied 16-byte pointer and length become
the callee's seventh and eighth arguments; with the stack and pointer values
intact, `0x3504e5e–0x3504e71` appends that span to an intermediate stream.
The ninth and tenth arguments describe a separately produced vector returned by
`0x3504ca0`; `0x3504f6a–0x3504f89` passes that vector's start pointer as the
third argument to `0x8865bb0`, rather than directly forwarding the supplied
16-byte argument. Equality or aliasing of the underlying ranges is unknown. No
separate key length is passed at that call. On the selected successful initialization path the
resulting vector is subsequently copied to `session+0x2b0`, while the original
16-byte buffer is separately copied to `session+0x298`, subject to the earlier
stated mutation and lifetime assumptions. The two argument positions have distinct
observed roles in this inner call; this does not prove their runtime values or
cryptographic authenticity.

On a bounded normal path, `0x3504ca0` constructs a 24-byte input from an
explicit source span and a 64-bit argument: for source length at most 24 it
copies the source and zero-fills unused space, then overwrites bytes 16–23 with
the 64-bit argument in big-endian order. The resulting first 16 bytes are the
source prefix, zero-padded if needed; source bytes after the sixteenth are
overwritten. Longer copies exceed the 24-byte local array and are not modeled.
It calls `0x8b46000` on exactly 24 bytes and copies the 16-byte result to the
vector whose pointer reaches the encryption call above. The static digest
implementation uses the MD5 initial state, the 64 MD5 round constants and
rotation counts in order, the expected padding and bit-length layout and a
16-byte result. These observations strongly support an MD5 candidate, but each
round's input index and Boolean operation have not been fully established as
equivalent. The local `deriveTargetWtTgtgtKeyCandidate` hashes that constructed
24-byte input using Node's MD5 implementation; its source length cap, integer
checks and snapshotting are local policy. It does not establish target runtime
values, derive an SSO signature or validate a real login.

A separate bounded inspection of `0x3504d80` identifies the normal-success
intermediate plaintext serialization before the `0x8865bb0` call. Let `S` be
its second argument. Under stable valid inputs and successful stream writes,
it emits BE16(4); BE32 of its third argument; BE32 fields at `S+0x04`, `+0x08`
and `+0x0c`; BE64 at `S+0x50`; BE32 of its fourth argument and `S+0x14`; one
byte at `S+0x18`; the fifth/sixth and seventh/eighth argument spans as raw
bytes; BE32(0); one byte at `S+0x19`; the raw vector at `S+0x20`; and BE32
fields at `S+0x10` and `S+0x00`. If the string at `S+0x38` is nonempty, it
then appends BE16 of its low length bits followed by the raw bytes; an empty
string adds no prefix. The fixed portion has 48 bytes before any raw spans or
optional tail. The target ignores several helper results and its helper length
handling is not equivalent to the local candidate's stricter bounds.
`encodeTargetWtTgtgtPlainCandidate` takes these fields explicitly, and
`encodeTargetWtTgtgtEncryptedCandidate` composes it with the above MD5-based
candidate and the existing local QQ-TEA model. At `0x346912e–0x346919f`, the
inspected next-stage construction assigns tag `0x0106`, copies its input span
into an object with vptr `0x8e7f808`, and later uses the same relocated writer
`0x35051e0` as `0x0144`. Its normal-success output is BE16(`0x0106`), BE16 of
the appended byte count and those bytes. The local
`encodeTargetWtLoginNode0106` accepts an explicit span and rejects lengths above
65535 rather than reproducing the target's truncated length backfill. All these
are offline, conditional models and do not establish runtime fields, an SSO
signature, peer identity or service acceptance.

Within `0x34ff570`, the inspected `0x34ff681–0x34ff78b` window also selects
several fields from a receiver state word. With stable receiver fields and
successful string and logging operations, state zero selects `S+0x00 = 1` and
uses the receiver's `+0x1a8` word both at `S+0x50` and as the separate
`0x3504ca0` word. State one selects `S+0x00 = 1`, takes the derivation word
from `+0x2f0` and uses that value at `S+0x50` when nonzero; when it is zero,
the selected `S+0x50` falls back to `+0x1a8`, while the derivation word remains
zero under the stable-field assumption. State one copies the receiver's
`+0x1b0` string into the optional tail. State two sets `S+0x00 = 3`, with both
selected words zero; other observed numeric states use `S+0x00 = 1` and zero
words. The inspected non-state-one tail is empty. The offline
`selectTargetWtTgtgtStateCandidate` models this local selection from explicit
inputs, not the meaning or runtime value of the state.

The offline `encodeTargetWtInitialTwoNodesCandidate` conditionally combines
`0x0106` and `0x0144` using one caller-supplied 16-byte snapshot for both the
TGTGT plaintext argument and the inner `0x0144` key. This correspondence models
only the initial `+0x2c8 = 0` branch above, assuming the original buffer
remains unchanged from the raw7 read through the session copy, and that the
session copy remains unchanged and valid until the later inner-key read. Its
plaintext, derived key, four-fragment result and 16-byte key copy are prepared sequentially
before invoking either caller-supplied random source. The inputs must stay stable
until copied; this is not an atomic snapshot, and only the bytes consumed by the
key candidate contribute to its derived result. Its ciphertext-size bound is a
local policy. Neither model establishes target behavior, target MD5 equivalence,
or live login.

The `0x016e` value contains a copied global string whose first initialization is empty; subsequent
writes and the value at send time are not established by that initializer. One
bounded static path copies an input object's string at `J+0x60` through
`owner+0x170` into that global string. Identifying that as the eventual node
value requires the copy to happen first, all calls to return normally, and no
intervening or aliased writes; `J`'s business identity remains unknown. On the
inspected construction path, `0x3469211–0x346922c` installs vptr `0x8e7f850`
and tag `0x016e`; `0x346925f–0x346926d` moves a 24-byte string representation
into the object's `+0x10` region. The vptr's `+0x10` slot at `0x8e7f860` has
an `R_X86_64_RELATIVE` relocation with addend `0x35053c0`. That writer reads
its tag, reserves a two-byte length, selects the short or long string's byte
span and appends it when nonempty, then writes back the appended count's low
16 bits. Under valid stable storage and successful stream operations, it emits
BE16(`0x016e`), BE16(byte count), followed by those raw bytes; failures and
length truncation differ from the local helper's stricter policy. The offline
`encodeTargetWtLoginNode016e` accepts caller-supplied raw string bytes; it does
not infer their encoding or the target's actual runtime value.

For the second pointer, `0x3468279–0x34682da` constructs an object with vptr
`0x8e80030` and stores it in a temporary structure at `+0x10`; the inspected
`0x3500ac1–0x3500ad8` path constructs and transfers that structure to
`session+0x1f0`, and `0x35035b4–0x35035c4` transfers the pointer at `+0x10`.
The vptr's `+0x10` slot has an `R_X86_64_RELATIVE` relocation with addend
`0x3506630`. Its writer emits tag `0x0147`, backfilled BE16 length, one BE32
word and two byte strings, each with a BE16 length. It independently clamps
both string lengths to 32 bytes and appends their byte prefixes, even if that
splits a multibyte text encoding. The construction copies the word and two
strings from fields corresponding to `session+0x18`, `+0x50` and `+0x68`.
These associations require successful construction, transfer, stable pointers
and no intervening replacement. The target ignores stream-helper results. The
local `encodeTargetWtLoginNode0147` models normal successful output with
caller-supplied raw fields and does not identify their business values.

The same temporary structure's `+0x40` object is constructed at
`0x346842a–0x34684dd` and transferred into `session+0x230` by the inspected
`0x350366e–0x350367e` path. Its vptr `0x8e7fe80` has a `+0x10` relocation
with addend `0x35061f0`. That writer emits tag `0x0128`, a backfilled BE16
length, a BE16 object word followed by seven individual object bytes, a
BE16-length-prefixed string, a BE16-length-prefixed vector, and a trailing
zero word. `0x34692b6–0x34692fa` constructs the string `Linux` and transfers
it into this object's string slot before the inspected writer sequence; the
trailing NUL of the short string is not part of its length. With successful
construction and writes, no later mutation or replacement, the constructed
nine-byte zero prefix and its 16-byte vector imply a `0x24`-byte body when the
Linux string is present. At `0x3468415–0x3468427`, the constructor calls
`0x34faba0` then `0x34fabe0`; `0x3468486–0x346848e` stores the two returned
register words into that vector in x86-64 little-endian order. `0x34fabe0`
tail-jumps to `0x8868a90`, whose inspected return reads two global words; nearby
target log strings refer to a machine-guid array, file reads and random
creation. One bounded initialization branch calls `0x8868c20`, which builds two
processed strings and, if at least one is nonempty, calls `0x8b45610`, feeds
their nonempty byte sequences in order through `0x8b45630`, then calls
`0x8b45e70` and copies the 16-byte output into the global storage. The inspected
update sequence adds no separator or string terminator. One source is derived
from a machine-id read; the second can come from parsed/transformed machine
information or a separate interface-candidate branch. It is not established as
raw file content. Both empty inputs lead to a different fallback path. The
static digest evidence is MD5-like as described above; the offline
`deriveTargetMachineGuidDigestCandidate` models only this nonempty branch from
explicitly supplied processed bytes, not file reads, interface discovery or
fallback. None of these observations establishes actual target bytes, persistence
state or a successful runtime read. Another call to the getter occurs in TGTGT
construction, but equality across calls remains conditional on stable state.
Both length helpers truncate their prefixes to 16 bits while potentially appending
more bytes, and the writer ignores helper errors. The local
`encodeTargetWtLoginNode0128` takes explicit byte fields and rejects oversize
inputs as a separate policy. These are static conditional observations, not
runtime output or proof of server acceptance.

The `0x0124` factory selection reaches `0x350822c`, which allocates a `0x70`-byte
object, installs vptr `0x8e7fd60` and zeroes the remaining object fields. Its
`+0x10` slot at `0x8e7fd70` is an `R_X86_64_RELATIVE` relocation with addend
`0x3505fe0`. The inspected writer emits the tag and a backfilled 16-bit length,
then four length-prefixed byte strings at object offsets `+0x08`, `+0x20`,
`+0x40` and `+0x58`, with the word at `+0x38` between the second and third,
and a trailing zero word. Each string helper writes the low 16 length bits but
can append the full low 32-bit length; the writer ignores helper results.
Under successful allocation and writes, stable pointers, no intervening or
aliased field modifications, and normal short-empty-string interpretation,
the freshly zeroed node therefore emits tag `0x0124`, length `12` and twelve
zero payload bytes. These are conditional static conclusions, not observed
runtime bytes; string meanings and nonempty values remain unknown. The local
`encodeTargetWtLoginNode0124` instead accepts four explicit raw byte strings
and a word, rejecting oversized fields or payloads as a local policy. These
observations do not identify the sender instance or prove that this branch executes.
The input field values, other paths that might replace these objects, and the
complete transformation remain unknown. The offline `encodeTargetWtInnerEncryptedCandidate` composes the
existing four-writer candidate with the existing QQ-TEA model using an explicitly
supplied 16-byte key and random-prefix callback. It returns ciphertext only;
its inputs, random-byte generation and runtime behavior have not been established
as the target's, and the composition does not construct a `0x0144` node. The
implementation clears its own key and plaintext snapshots on a best-effort basis;
the existing QQ-TEA implementation and JavaScript runtime may retain intermediate
copies. Synthetic vectors are not evidence of actual QQ interoperability.

Further bounded static inspection follows the normal construction path beyond
that call. `0x3469385` stores tag `0x0144` in a new object; after `0x3468790`
returns, `0x34693d0–0x34693e0` transfers its three-pointer output vector into
object offsets `+0x10`, `+0x18` and `+0x20`. On the new-key branch,
`0x346946c–0x3469472` associates that object with tree key `0x0144`; the
existing-key branch has separate behavior. The object's vptr comes from
`0x8e7f808`; its `+0x10` slot at `0x8e7f818` is declared by an
`R_X86_64_RELATIVE` relocation with addend `0x35051e0`. The original eight
file bytes at offset `0x8e7d818` are zero: the relocated view is not a literal
file pointer. At `0x35051e0`, the writer reads the object's tag, reserves a
16-bit length, appends the object vector and backfills the appended length's
low 16 bits. With valid, stable pointers and normal successful stream writes,
its result is BE16(`0x0144`), BE16(appended byte count), then those bytes. It
ignores some helper results and does not reject lengths exceeding 65535. The
separate offline `encodeTargetWtLoginNode0144` models only normal successful
output and rejects oversized values as a local policy; it does not establish the
runtime key, execution path, or whether the service accepts the result.

`0x3467d50` first checks for nine required tags, then visits them in this order:
`0106, 0144, 0116, 0142, 0145, 0018, 0141, 0177, 0191`. Only after all are
present does it traverse the optional tag table in its own order. In that table
`0318` precedes `016a`; present nodes are invoked through virtual slot `+0x10`.
When the required nodes exist, the two optional nodes remain present and
unreplaced, and the calls and writer succeed, that path therefore invokes their
known encoders in that order. This is not a claim about the encoding of other
nodes or a unique-node count: inspected duplicate-key branches have separate
count behavior. The resulting nonempty producer output is captured in a heap
closure whose wrapper targets `0x34ffbe0`; its callback conditionally passes the
captured container to `0x34f6610` with `wtlogin.login` and command `0x810`.
In its inspected branch, `0x34f6610` uses a per-entry 16-bit sequence, calls
`0x34f9170` with a captured byte span, and later conditionally dispatches via a
receiver's virtual slot `+0x20`. Its preserved nonzero intermediate result can
also be returned when the receiver is absent or the later `channel+0x40`
control-block promotion fails; an earlier weak-reference failure instead
unwinds. The two inspected callers do not branch on the return. Neither the
return value nor this static path establishes a network send or a connection
to `GetSignInfo`. In the inspected normal branch, tree lookup uses the full
64-bit entry key, a newly constructed node starts with a zero 16-bit value, and
the old value is copied to the local header before incrementing modulo 65536.
The header also receives the key's low 32 bits, the command's low 16 bits,
and `0x87`. The offline `targetWtSendCounterCandidate` computes only those
numeric projections from explicit caller inputs. Equal low-bit projections do
not establish equal full keys or shared nodes; the model does not assign
counters, serialize a header, sign, send, or establish interoperability.

On a candidate sender-construction path through `0x34a9e00`, `0x34f05e0`,
`0x34f4e70` and `0x34f63e0`, the value ultimately assigned to sender `+0x38`
is the address-adjusted subobject `X+0x10` when `X = [H+0x90]` is non-null.
The guarded send then calls that receiver's virtual slot `+0x20`. The dynamic
subobject type and slot target, and any bridge from it to `GetSignInfo`, are
not established; the same-offset sender constructions are not proof of the
same runtime instance. A separately inspected `0x34b9130` construction zeros
`H+0x90/+0x98` and installs a vtable connected to an
`onUnusualDeviceNeedVerify` candidate thunk. The same candidate address point
has an ELF `R_X86_64_RELATIVE` relocation at offset `+0x28` to `0x349f1f0`,
the method in the observed `J+0x60` copy path; additional slots point to
methods that inspect a `+0x90` member. These are static vtable associations,
conditional on relocation and the address point remaining installed, not proof
that the methods operate on the same runtime instance. In particular, the
method's owner and its separate `J` argument have not been identified with
`H` or the QR-success instance. A bounded search in `0x349f000–0x34c0000`
for selected direct-call and indirect `+0x28` forms did not identify a caller
with a proven receiver type or construct `J`'s origin. That search excludes
other instruction forms and address ranges, so it does not establish that no
caller exists. In the inspected normal path, `0x34bafd0` reads and copies that
pair into a new control-block-backed object;
no direct write back to the input pair was observed, subject to pointer-alias
and indirect-call limitations. Other inspected factory calls pass the address
of this pair into newly constructed objects, but do not establish its nonzero
origin or the receiver's dynamic type. The precise execution conditions,
callback scheduling, downstream signer and key identity, and whether a server
accepts any resulting frame remain unknown.
These static observations do not establish an actual QR scan, network send, or
successful login. The offline `encodeTargetWtLoginOrder` helper models only the
conditional writer order: it calls the known encoders for `0318` and `016a`,
while other complete writer fragments are opaque caller assertions. It adds no
outer header or count and does not establish that a supplied fragment actually
belongs to its declared tag. Its 16 MiB aggregate output limit and its input
validation are local policies, not measured native limits or a bound on peak
intermediate allocations. The separate offline
`encodeTargetWtLoginFrameCandidate` composes the existing target-local data and
OICQ encoders with command `0x0810`; the caller must explicitly supply the body,
header values, context and key material. It does not derive a live session,
select a signer or establish that the constructed frame is accepted.

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
`0x666a830`. A more complete static trace now connects a conditional signing-manager
path to that request slot. In the function at `0x6663ca0`, let `S` denote the
stack pointer after its prologue. `0x6663d8a` initializes `[S+0x10]` to zero.
When the local sign condition holds, `0x6663dc8` calls `0x6673480` with output
slot `S+0x2c8`; at `0x6663ddd`, `0x6665a90` transfers that pointer into
`[S+0x10]`. At `0x6664404–0x6664411` the same helper transfers it to
`[S+0xf8]`, and `0x666442c–0x6664434` passes `S+0x60` as the request to
`0x66672f0`, so the destination is request `+0x98`. The helper at
`0x6665a97–0x6665aa4` reads and clears the source slot and writes the destination;
it also releases an existing destination object when present. The inspected
normal branches and loops between those transfers do not directly write or
pass `[S+0x10]`. This is conditional on normal returns, valid objects and no
indirect alias or concurrent write; exception cleanup and other execution paths
are not proven equivalent.

Inside `0x6673480`, the virtual call at `0x66734e1` receives a 72-byte temporary
output region. On a nonzero return, `0x6673572–0x66735d6` moves three 24-byte
string-like representations into a new object at offsets `+0x00`, `+0x18` and
`+0x30`. The `GetSignInfo` success diagnostic calls `0x6674000`, whose
`0x6674008–0x6674078` reads their lengths in that order and formats them using
`token:%lld extra:%lld sign:%lld`. Thus **the diagnostic labels** support the
candidates `+0x00` = token, `+0x18` = extra and `+0x30` = sign; they do not
independently prove the byte values' cryptographic semantics. The subsequent
`0x666a660` checks and writes the nonempty `+0x30`, `+0x00` and `+0x18`
contents to field-24 children 1, 2 and 3 respectively; all empty yields no
child. For its call at `0x6663dc8`, the caller passes a pointer `D` from the
current request controller, a pointer `V` loaded from `[D+0x20]`, and a 32-bit
value `K` from controller `+0x58`. The virtual call receives `D`, `V`, the
temporary output and `K`. Later, `0x666431c–0x6664367` reads the controller and
its nested pointer again to populate the request's sequence-like field and
payload pointer/length. Those observations are consistent with the callback
seeing the source used for the request body and sequence, **if** the objects
and values did not change between reads; they do not establish command or
account provenance, identity across intervening calls, or an actual invocation.
This agrees in field numbering with the independently inspected
[LagrangeV2 secure-info declaration](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Common/BotSignProvider.cs#L620-L628),
but agreement is not proof of binary compatibility or shared implementation.

The path from `0x66672f0` reaches `0x66678b0`, whose call at `0x6667929` uses an
unresolved receiver's virtual slot `+0x20`. Only **if** that receiver selects the
observed V12 head encoder at `0x6669490` does its call at `0x6669727` pass the
request to the field-24 builder at `0x666a1d0`. That V12 virtual receiver,
the callback actually selected at runtime, complete input provenance, runtime
reachability, signature algorithm and usable signing service remain unestablished.

The observed getter `0x6613810` copies a global object/control-pointer pair and
increments a reference count; `0x66137b0` sets that pair. Its caller `0x6613200`
copies a caller-supplied pair into a temporary and passes it to the setter. The
getter and setter access the two global slots separately; these windows do not
establish an atomic snapshot or exclude external synchronization. A static byte
scan of the executable PT_LOAD range for direct x86-64 `E8` relative calls to
`0x6613200` identified four candidates at `0x3526fb5`, `0x3528b39`,
`0x354ced3`, and `0x354e624`. In each corresponding inspected instruction
window, the code first calls constructor `0x351fb20` and passes its constructed
object/control pair to `0x6613200`. Byte-pattern hits are not instruction
boundary proof by themselves; indirect calls, other encodings, other modules,
and other ways to mutate or replace the global pair remain outside that scan.

The constructor writes `0x8e80f38` as the object's virtual-table address point.
For this exact ELF, the slot at VA `0x8e80f48` has file offset `0x8e7ef48` and a
zero raw qword. Its `R_X86_64_RELATIVE` relocation at file offset `0x14a0f8` has
addend `0x3523110`; applying that relocation statically yields this candidate
for the virtual `+0x10` slot invoked at `0x66734e1`. This identifies a candidate
callback type on those four paths, not the global object's actual runtime value.
The code at `0x3523110` is associated with diagnostic strings
`msf_security_sign_callback.cc` and `MSFSign`; it passes a command string, a
buffer and length, an unclassified 32-bit value, and an output region to
`0x6856284` at `0x352329a`. On zero return, `0x3523301–0x3523346` copies
three bounded representations into the three-string result. The locally
inspected success-length formatter associates them with the candidate names
token, extra and sign as described above. The names do not by themselves prove
cryptographic semantics or compatibility with another implementation.

In the inspected `0x6856284` window, `[rsp+0x1a8]` addresses the saved return
address after six pushes and the `sub rsp,0x178` prologue; it is supplied to
`dladdr` at `0x68562d5`. Its result is stored at `[rsp+0x1c]` and checked at
`0x685639a`. Separately, the formatted 32-bit value is the function's fourth
integer argument (`ecx`), stored at `[rsp+0x18]` at `0x6856298` and reloaded as
`r8d` at `0x68563d9`. The two adjacent dword slots are distinct. The format string
is `%d` under the ELF segment mapping described below; with the normal C++ ABI
and dynamic bindings it represents this bit pattern as a signed decimal integer.
The pointer loaded from `[0x91533a0]` is a function pointer, not the integer
radix 10. The argument's upstream meaning remains a candidate: the observed
caller passes its fifth integer argument, and one candidate virtual call site
loads a request object's first dword, but complete runtime object identity and
whether that value is a sequence are not established. The windows at `0x6856444`, `0x6856461`,
and `0x68564af` call internal targets `0x68418ac`,
`0x683fa74`, and `0x6830c58` respectively. Later inspected copy sites read the
same stack slots into output regions `+0x200`, `+0x100`, and `+0x00`,
corresponding to the candidate sign, extra, and token slots. At the
orchestrator prologue `0x68562de–0x68562fe`, the output base `rbx` has its
`+0x200`, `+0x100` and `+0x00` slot pointers saved to stack before dispatch,
confirming a single 0x300-byte result structure with the sign, extra and token
slots at those offsets and their low length bytes written to `+0x2ff`, `+0x1ff`
and `+0xff`. That structure is a caller-provided out-parameter: at the
prologue `0x6856295` the base `rbx` is moved from `r8`, the fifth integer
argument, and the inspected call site `0x352329a` sets `r8` with `lea r8,[rsp+0x58]`
into its own `sub rsp,0x358` frame (`0x58 + 0x300 = 0x358`). That caller is
identified by its own rodata references and failure log at `0x29ff080` as
`MSFSecuritySignCallback` in `msf_security_sign_callback.cc`, with the message
`MSFSign failed, module_id:{}` and the name `MSFSign`; the bytes of those
strings were confirmed at their file offsets. The caller at entry `0x3523110`
saves four arguments at the prologue (`r12d=r8d`, `r14=rcx`, `r13=rdx`,
`r15=rsi`), so `MSFSign`'s inputs are: the command-name `std::string` from the
callback's second argument (`r15`, with the libc++ SSO selection at
`0x3523278–0x3523284` choosing `[r15+0x10]` or `lea [r15+1]`) passed as
`MSFSign` arg1 (`rdi`); the signed body from the callback's third argument, a
`{begin,end}` descriptor (`r13`), passed as arg2 (`rsi = [r13]`) with length
arg3 (`edx = [r13+8] - esi`); and the callback's fifth 32-bit
argument (`r12d`) passed as arg4 (`ecx`). An earlier reading mislabeled this
last value `module_id`; the failure logger does not consume that value. The command name and body are passed
as separate arguments here; whether `MSFSign` concatenates them internally
before signing is not established. The callback's fourth argument (`r14`) is the
result object, filled only after a successful return, not an input. On the success branch
(`test eax,eax; je 0x3523301`) the three slots are assigned into the callback's
result object `r14` as `std::string` token/extra/sign at `r14+0x00/+0x18/+0x30`,
using the length low bytes at structure `+0xff/+0x1ff/+0x2ff`. The diagnostic
labels and RTTI associate `0x6856284` with `MSFSign` and a three-string callback
result. They do not alone prove the cryptographic role of every producer path or
exclude diagnostic processing deeper in those callees. The incorrect
`__to_xstring` template reading is corrected below using per-segment mapping.

The inspected entry `0x3523110` is a candidate virtual callback: an
`R_X86_64_RELATIVE` relocation (addend `0x3523110`) installs it in vtable slot
`0x8e80f48`. A bounded byte-pattern scan found no direct `call`, `jmp` or
address-taking `lea` to the entry, but does not rule out other indirect uses or
prove the runtime identity at any particular call site. That vtable's typeinfo
slot `0x8e80f30` relocates to the typeinfo object `0x8e80f60`, whose name
pointer relocates to `0xcba64c`, where the RTTI name reads
`N2nt8internal23MSFSecuritySignCallbackE` (`nt::internal::MSFSecuritySignCallback`),
with base `N3msf8embedder8security20SecuritySignCallbackE`
(`msf::embedder::security::SecuritySignCallback`); the two preceding vtable
slots `0x8e80f38→0x35248f0` and `0x8e80f40→0x3524980` are sibling virtual
methods. The instance's vptr `0x8e80f38` is installed by the constructor
`0x351fb20`, which is invoked at `0x3526f2b`, `0x3528ac2`, `0x354ce6d` and
`0x354e57b`. The actual runtime identity of a callback at a given virtual call
site and the registration API remain unproved. The conditional caller-side
copies and their association with the candidate callback are described below;
the exact mapping of the result strings into an outbound frame is not recovered. The `dynsym` exports demangle as
`MSF::MSFSDK::sendPacket(unique_ptr<MSFRequest>)` (`0x670dd20`),
`MSF::MSFSDK::pack(unique_ptr<MSFRequest>)` (`0x670e0c0`) and
`MSF::MSFSDK::getClientSecurity(std::string const&, std::string const&)`
(`0x670f020`). The entry of `pack` checks string-like members at
`+0x98/+0xb0/+0xc8` and, on the inspected path, also copies members
`+0xf8/+0x110/+0x128` into a temporary object passed to `0x676c540`. Its
constructed `MSF::protocol::SsoSecureInfo` child and serialization are identified
below; the complete outbound request and runtime dispatch remain unproved. In
`sendPacket`, a zero first dword causes `lock xadd` against a counter followed
by a write back to the request, and a virtual call is made through an object at
`[0x9178fa8]`. Calling the dword a sequence and the object a transport singleton
is a candidate interpretation, not a demonstrated network transaction. `SendMsfRequestInternal` at `0x35505a0`
(reached via its empty-callback log string `SendMsfRequestInternal
security_sign_callback_ is null, cmd={} seq={}` at `0xb591a7`, referenced by
`lea r9,[0xb591a7]` at `0x3550736`) holds the callback pointer at `this+0x70`.
On the non-empty path it virtual-dispatches `call [vtable+0x20]` (a predicate),
then `call [vtable+0x10]` with `rcx = lea [rsp+0x40]` as the three-string result
buffer and `r8d = [rbp]` as an unclassified request dword. It then copies the
three strings via helper `0x29a76e0` from `rsp+0x70/+0x40/+0x58` into request
members `rbp+0xf8/+0x110/+0x128`. If this virtual call resolves to the
candidate callback described above and the fields survive unmodified, the
respective candidate names are sign/token/extra; the virtual target and dynamic
object identity are not proven solely by the call site. `SendMsfRequestInternal` allocates this request as a
single `0x140`-byte object (`mov edi,0x140; call 0x8e10060`), zeroes it, and
populates its members directly before the sign callback: `rbp+0x00` dword is
set from the function's second argument; a `std::string` at `rbp+0x50` is copied
from the third argument via `0x29a76e0` (candidate command); a `std::string` at
`rbp+0x38` is copied from the object field `r12+0x240`; `rbp+0x20` receives a
copy or fallback selected from `r12+0x228`, while a temporary result produced by
`0x3551410` is moved into `rbp+0x80`. Small scalars are set at
`rbp+0x10`/`+0x18`. `0x3551410` is a length-prefix framer:
given a `{begin,end}` buffer it computes `len = end - begin`, reserves via
`0x35a8da0`, then appends `len + 4` as a four-byte big-endian prefix (the four
`0x35a9100` single-byte appends consume `sar 0x18`, `shr 0x10`, `shr 8`, then
the low byte) and finally the raw payload bytes via `0x29a1b70`. It therefore
produces `BE32(payloadLen + 4) || payload`, the classic MSF/SSO
length-self-inclusive field framing for this particular copied buffer. It is not
proof of a complete network envelope.

The call at `0x3550e5d` to `0x355ce90` was previously misidentified here as a
request dispatcher. Its arguments include mapped strings `MSFCore_Service_Log`,
`msfcore_service.cc`, `SendMsfRequestInternal` and a formatted request log,
which instead support a logging helper. The r2 raw-mapping string comment
`"...ocket pool, needn't to Join"` refers to the wrong file offset. At
`0x3550e7d` a PLT entry whose relocation names `MSF::MSFSDK::sharedInstance()`
is called; at `0x3550e98` another PLT entry whose relocation names
`MSF::MSFSDK::sendPacket(unique_ptr<MSFRequest>)` is called with a pointer to
the stack-held request owner. The real runtime bindings, target and network
behavior are not observed. The addresses `0x355ce90` and `0x355f100` do not
establish the writer of request members `+0x98/+0xb0/+0xc8`.

Separately, `pack` dereferences its input owner and validates the three
string-like members at request `+0x98/+0xb0/+0xc8`. On its inspected normal path,
`0x670e201–0x670e293` also copies request members `+0xf8/+0x110/+0x128` to the
local object at `rsp+0xb8/+0xd0/+0xe8`; it passes that object as `rdx` to
`0x676c540` at `0x670e2ca`. On the nonempty paths of the latter function,
`0x676c692–0x676c753` applies presence-bit ORs `1/2/4` and uses helper
`0x57f7340` on local members `+0xb8/+0xd0/+0xe8` into a constructed object's
`+0x18/+0x20/+0x28`, respectively. These offsets are memory layout, not wire
tags; the independent constructor/serializer inspection below establishes the
inner field numbers. Linking those values back to the candidate callback
additionally requires the same request object to reach `pack`, the relevant
branches to run, and no intervening mutation. Writers of the separately checked
request members, complete envelope construction, runtime reachability and the
complete signing algorithm remain unknown.

The offline [presence-mask candidate](<src/direct/target-sign-presence-candidate.ts>)
models only the three conditional OR operations: a nonempty sign/token/extra
view contributes bit `1/2/4`, respectively. Its explicit initial mask preserves
all existing bits, including for empty inputs; the model does not assume that a
native constructor clears the flag byte. It reads view lengths, not contents,
and implements neither native copies nor wire encoding. The names and their
upstream association retain the callback/object-identity conditions above.

A further bounded audit identifies the 0x30-byte object, rather than inferring
protobuf from its shape. The constructor call at `0x676c5d8` enters `0x67c27d0`;
`0x67c27e1–0x67c27e8` installs vptr `0x9032700`. ELF `R_X86_64_RELATIVE`
records give the following independently checked chain:

- `0x90326f8` (vptr minus 8) points to RTTI `0x9033168`.
- RTTI name pointer `0x9033170` points to `0xfe102f`, the raw string
  `N3MSF8protocol13SsoSecureInfoE` (`MSF::protocol::SsoSecureInfo`).
- Its base RTTI is `0x8fc8580`, with name at `0xef2eef` identifying
  `google::protobuf::MessageLite`.
- vptr slot `+0x60`, at `0x9032760`, points to serialization body `0x67c2cd0`.
  Its relocation record is at file offset `0x589898`.

That body reads the presence word at `this+0x10` and writes these actual bytes:

| Presence bit | Object string slot | Tag write VA | Tag byte | Field / wire type |
| --- | --- | --- | --- | --- |
| `1` | `+0x18` | `0x67c2d45` | `0a` | 1 / 2 |
| `2` | `+0x20` | `0x67c2db4` | `12` | 2 / 2 |
| `4` | `+0x28` | `0x67c2e23` | `1a` | 3 / 2 |

The short-field paths write a one-byte length and copy that many bytes through
the `memcpy` PLT. Lengths above 127 or insufficient writer space take shared
helper `0x5810470`, called with field number 1, 2 or 3; at `0x5810498` that
helper computes `fieldNumber * 8 + 2`. The construction visits fields in order
1, 3, 2, but this serializer emits them in order 1, 2, 3. A correctly mapped
log format at `0xb85ab5` calls their lengths `secSigLen`, `secDeviceTokenLen`
and `secExtraLen`; these are diagnostic labels, not recovered signing algorithms.

Empty-value behavior has two distinct layers. At `0x67c27eb` the constructor
clears eight bytes beginning at `+0x10`, so its presence bits start at zero on
this normal construction path. The builder sets bits only for nonempty strings;
if all three are empty, its path at `0x676cb83` deletes the child and skips
installation. In contrast, the generic serializer emits `0a00`, `1200` or
`1a00` for a valid zero-length string whose bit is already set. It can also
append retained bytes via the branch starting at `0x67c2ec5`. The existing
reserve encoder models the nonempty-only builder subset, not arbitrary parsed
`SsoSecureInfo` objects or their retained unknown fields.

The parent binding is independently visible too. The parent at `rsp+0x68` in
`0x676c540` is constructed by `0x67bf400`; its vptr is `0x9032680`. RELATIVE
relocations link the RTTI at `0x9033150` to name VA `0xfe1010`, identifying
`MSF::protocol::ReserveFields`. Its vtable `+0x48` and `+0x60` slots resolve to
size routine `0x67c1890` and serializer `0x67c0ba0`, respectively. The helper
`0x58133d0` calls the size slot at `0x58133ee` and the serializer slot at
`0x58134e3` to produce a caller-owned string.

On the nonempty-child path, `0x676c88b` sets bit 0 of byte `[rsp+0x79]`
(parent `+0x11`) and `0x676c890` stores the child at `[rsp+0xd8]` (parent
`+0x70`). The parent serializer at `0x67c1225` tests the equivalent presence
word mask `0x100`. At `0x67c1236` it loads that child, and `0x67c123a` writes
word `0x01c2` little-endian: bytes `c2 01`, the protobuf tag for **field 24,
wire type 2**. It then writes the child's cached size from `+0x14`, using
`0x5810800` if the size exceeds 127, and calls child serializer `0x67c2cd0` at
`0x67c126b`. The parent size path at `0x67c1a8d–0x67c1aab` calls the child size
routine and accounts for its length prefix and the two-byte outer tag. These
are static normal-path observations, conditional on intact objects, matching
vptrs and no intervening replacement or mutation.

The inspected caller-side handoff is `0x676c951–0x676c95b` into `0x58136d0`
with the parent and an output string; that wrapper calls `0x58133d0` at
`0x58136eb`. The resulting bytes are moved at `0x676c960–0x676c98b` into
member `+0xe0` of a separate 0x100-byte object constructed by `0x67b49c0`.
The call at `0x676ca12–0x676ca1d` reaches its virtual writer `0x67b4f50`
under the inspected vtable, where the selected path copies those member bytes
into another writer. The next wrapping stage called via `0x67b2410` has
virtual target `0x67b4440` under the inspected vtable; its normal and special
wrapping branches are distinguished below. The produced string is moved to the
caller's result at `0x676ca35–0x676ca58`. This traces a conditional byte handoff,
not a demonstrated network write.

This `MessageLite` implementation is distinct from the `CPBMessageOpti` route
at `0x666a1d0` described above. Both inspected implementations place the three
inner fields under field 24, but matching field numbers does not establish a
shared object, caller, complete byte stream or runtime execution path.

**SDK header prefix differs from the earlier CPB-derived head.** The separate
0x100-byte object's constructor `0x67b49c0` sets mode `+0xf8` to 12 and word
`+0x10` to `0x20027635`. On the inspected path `0x676c8ad–0x676c8b5` calls
`0x67b4c30` with 1, setting byte `+0x14` to 1. The mode-12 branch of
`0x67b4f50` starts at `0x67b4fc2` and writes four BE32 words: the result of
`0x67b4c80`, then object words `+0x08`, `+0x0c`, `+0x10`. Its next twelve bytes
at `0x67b504b–0x67b508a` are:

```text
object[0x14] || G[0..8] || object[0x15] || low8(object[0x16] << 2)
G = writable global at VA 0x91790b8
```

Before copying, it stores the latter two values into `G+9` and `G+10`. Thus the
first byte of that block is 1 on this initialized normal path, whereas the
existing `encodeTargetSso12Head` CPB-derived model intentionally writes zero at
head offset 16. The constructor clears `+0x15` but the inspected constructor
does not initialize `+0x16`; writable `G[0..8]` is not a runtime constant just
because its initial segment storage is zero-filled. Keep these implementations
distinct instead of changing the older encoder to fit the new branch.

A second constructor, `0x67b4a50`, uses the same vptr but explicitly sets
`+0x16=1` at `0x67b4a69`, leaves `+0x15` unwritten in the inspected constructor,
and takes its mode from ESI. Direct calls were found at `0x674396e` and
`0x6745afa`. They do not change the fact that the current `0x676c8a8` path calls
`0x67b49c0`, which initializes `+0x15` instead of `+0x16`. No whole-object
zeroing was observed between that path's allocation and construction.

G lies in `.bss` (`SHT_NOBITS`, start `0x9161180`, size `0x4abe8`), beyond the
last load segment's file-backed end `0x9161150`. Standard ELF loading establishes
its initial zero bytes, not their value at serialization time. A bounded scan
of selected RIP-relative instruction families across RX
`[0x299e300,0x8e13400)`, related RELA/dynsym entries, nearby initialization
functions and scalar writes in `[0x67b49c0,0x67b5bb0)` found no additional direct
write to G's first nine bytes. It did find the known `G+9/G+10` stores. The
nearby initializer `0x67b1cd0` writes through `0x91790ab`, and a pointer store
at `0x67b5c9b` targets `0x91790b0`, both stopping before G. This is not complete
alias analysis; indirect/base-plus-offset/wide writes remain possible. Keep
both the nine-byte prefix and the current path's `field16` explicit.

After that mixed block, the mode-12 writer appends these fields in order:

| SDK object member | Encoding |
| --- | --- |
| `+0x20` | `BE32(length+4) || bytes` |
| `+0x50` | `BE32(length+4) || bytes` |
| `+0x68` | `BE32(length+4) || bytes` |
| `+0x98` | `BE32(length+4) || bytes` |
| `+0xb0` | `BE32(length+4) || bytes` |
| `+0xc8` | `BE16((length+2) & 0xffff) || bytes` |
| `+0xe0` | `BE32(length+4) || bytes` (serialized reserve) |

Under ordinary non-overflowing lengths, `0x67b4c80`'s selected branch at
`0x67b4ce5` computes `54 + sum(lengths of those seven strings)`, including
the leading length word but excluding the business bytes that follow. The
layout matches the earlier head's field widths, not its native object layout
or mixed-prefix values. The old head encoder's u16 oversize rejection remains
a local policy rather than an emulation of native truncation.

The separate
[SDK mixed-head candidate](<src/direct/target-msf-sso12-head-candidate.ts>)
exports `encodeTargetMsfSso12HeadCandidate`. It requires all three u32 words,
explicit `field14`, `field15`, `field16`, a nine-byte `globalPrefix9`, and the
seven byte fields named after their offsets. It reuses the old head codec for
its identical length-delimited field layout, then replaces only bytes 16–27.
All nine global bytes remain caller-supplied; there is no implicit zero-filled
global or fabricated value for the uninitialized native field. The API encodes
only H, not the subsequent body, compression, encryption or the normal wrapper.
The older `encodeTargetSso12Head` API and its zero-first-byte profile are intact.

**Trimmed heads for modes 13 and 21.** The writer's actual relative jump table
at `0xfdfc18` maps both of these modes to `0x67b4f86`; mode 12 maps to
`0x67b4fc2`, while mode 20 has a distinct entry at `0x67b50aa`. The shared
trimmed entry writes only:

```text
H = BE32(L) || LP4(object+0x50) || LP4(object+0x68) || LP4(object+0xe0)
L = 16 + length(field50) + length(field68) + length(fieldE0)
```

The length helper has its own relative table at `0xfdfbf0`, mapping 13/21 to
`0x67b4cae`. Its selected string lengths are added with a fixed 16-byte term
at `0x67b4e13–0x67b4e17`, independently matching the writer. The field prefixes
are written at `0x67b511a`, `0x67b518e` and `0x67b520b`; the last raw copy joins
`0x67b56ce–0x67b56e4`, then the common body path. This is not the mode-12 head
with its mixed bytes zeroed: the sequence/app words, mixed block and four
other variable fields are absent from this head. Body bytes are not counted
in L; all three empty strings produce a 16-byte head.

The [trimmed-head candidate](<src/direct/target-msf-trimmed-head-candidate.ts>)
exports `encodeTargetMsfTrimmedHeadCandidate({field50, field68, fieldE0})`.
It reuses the existing self-inclusive field encoder, checks an exact own-data
plain/null-prototype record, rejects invalid/shared/detached/out-of-bounds
views and applies a local 16 MiB total cap before framing allocations. It
returns independent storage and clears its temporary framed fields best
effort. The [trimmed-head tests](<tests/direct/target-msf-trimmed-head-candidate.test.ts>)
cover fixed bytes, all empty combinations, field boundaries, ownership,
hostile metadata, validation and cleanup. Synthetic compositions exercise the
real QQ-TEA and Base mode-13/21 encoders without selecting any live protocol
mode, key or session.

Native mode selection still requires state: `0x675a4c0` is identified by
correctly mapped strings as `MSFPacketHeaderTrimer.cpp::shouldTrim`. Its
ordinary return paths produce only 0 or 1 (`0x675a71a–0x675a725` and
`0x675a857–0x675a867`), but it can update per-key flags and clear stored state.
Thus the builder's `12 + S + 8*(incoming_r8d & 1)` yields 12, 13, 20 or 21
under those observed return paths; this does not authorize choosing trimmed
mode before its native prerequisites are satisfied. The new API encodes only
the given trimmed structure, not the state machine or the distinct mode-20
untrimmed head.

**Untrimmed mode 20.** The remaining writer-table entry at `0x67b50aa`
starts with the inclusive length and the dword at object `+0x08`, both BE32.
It then calls `0x299f000` with the dword at `+0x0c`, framing the resulting
text before the five byte fields:

```text
D = ASCII(decimal(signed_i32_bits(field0c)))
H = BE32(L) || BE32(field08) || LP4(D) || LP4(field20) || LP4(field50)
    || LP4(field68) || LP4(field98) || LP4(fieldE0)
L = 32 + length(D) + sum(lengths of the five byte fields)
```

The conversion is signed, not an unsigned decimal approximation. Its negative
branch at `0x299f0cb–0x299f0d5` writes `'-'`, negates EAX and rejoins the
magnitude formatter. The formatter at `0x299f150` uses decimal thresholds,
100/10000/100000000 grouping and the two-digit table at `0xcbe8c0`; that table
was independently checked against all `00` through `99` pairs. Thus raw
`0x80000000` becomes `-2147483648` and `0xffffffff` becomes `-1`. The output
terminator is not part of the framed string.

The length function's mode-20 entry is `0x67b4d6b`; it runs the same conversion,
adds the five field lengths and adds 32 at `0x67b4f30–0x67b4f40`. Writer prefix
sites are `0x67b52b8`, `0x67b53db`, `0x67b570a`, `0x67b577a`, `0x67b57f3` and
`0x67b5878`. After the final raw copy, `0x67b58db–0x67b58ec` releases the
conversion temporary and joins the shared body path. There is no mode-12
mixed block, numeric `+0x10` word, or B0/C8 field in this head.

The [mode-20 head candidate](<src/direct/target-msf-sso20-head-candidate.ts>)
exports `encodeTargetMsfSso20HeadCandidate`. Its seven required fields are the
two raw u32 bit patterns and five opaque byte views. The local API accepts
`field0c` as u32 and applies signed interpretation only during encoding; it
does not coerce negative/string/object inputs into a bit pattern. Its minimum
is 33 bytes: even zero contributes one ASCII digit. It uses the existing LP4
encoder, validates all views, checks a local 16 MiB total before field framing,
returns owned storage and clears owned decimal/framing temporaries best effort.
The [32 mode-20 tests](<tests/direct/target-msf-sso20-head-candidate.test.ts>)
cover signed boundaries, fixed bytes, field widths, isolation, size gates,
cleanup and a real-implementation QQ-TEA/Base20 composition with explicit inputs.

The pre-transform head layouts for modes 12, 13, 20 and 21 now each have an
offline model. This does not select any of them automatically, implement the
native state machine, or establish real packet acceptance. All remain separate
from compression, encryption, Base flags, credentials and transport binding.

At `0x67b58ec` onward, a nonempty string at `+0x80` is appended unchanged;
an empty one takes `0x67b5920–0x67b593b`, appending `00 00 00 04`. Thus this
writer is not evidence that every nonempty body receives another length prefix.
A nonzero byte `+0x1c` selects `compressBound`/`compress2` at
`0x67b596d–0x67b59dd`; the inspected constructor clears that byte. Finally,
`0x67b59f8–0x67b59fe` calls `0x67b5a30`. With nonzero `+0x18` and nonempty
string `+0x38`, it configures `MSFCCrypt` from that string and encrypts the
writer's accumulated output through `0x67de280`, replacing the output on the
inspected successful path. The key setter `0x67deca0` copies only when its
supplied length is 16; other lengths return without an error or clearing.
Constructor `0x67de220` and configuration helper `0x67decb0` set bytes `+8/+9`
but do not initialize the key region `+0x0a..+0x19`. Consequently a nonempty
but non-16-byte key does not select a known zero-key fallback: key-region
contents remain unknown, even if the caller proceeds into the transformation.
The observed caller sets `+0x18=1` and copies the separately checked request
`+0xc8` string to `+0x38`. Actual key bytes, runtime path selection and dynamic
object continuity remain unverified; the assembled head is not automatically
the final plaintext network payload.

**Selected encryption kernel, static correspondence.** The block function at
`0x67de5f0–0x67de716` takes an 8-byte input in RDI, a 16-byte key in RSI and an
8-byte output in RDX. Its input bytes form two big-endian u32 words; four key
loads and `bswap` instructions at `0x67de61c–0x67de634` form big-endian K0–K3.
`0x67de637` sets the loop counter to 16; `0x67de63d` initializes the sum to
`0x9e3779b9`. The loop uses these u32-wrapping updates, with logical right shifts:

```text
L = L + (((R << 4) + K0) XOR (R + sum) XOR ((R >>> 5) + K1))
R = R + (((L << 4) + K2) XOR (L + sum) XOR ((L >>> 5) + K3))
```

The first update is established at `0x67de66f–0x67de6a2`, the second at
`0x67de6bb–0x67de6d0`. The loop adds delta at its end and decrements the counter
at `0x67de6e1–0x67de6ea`. This is 16 cycles / 32 half-updates, using sums
`delta*1` through `delta*16`; it agrees with the source's sum increment at the
start of each cycle, despite the different instruction placement. Stores at
`0x67de6f0–0x67de708` write both resulting words big-endian. Under valid input,
key and output buffers, this matches the encryption branch of `teaBlock` in
[qq-tea.ts](<src/direct/qq-tea.ts>), not its unaudited native decryption counterpart.
No native function was executed or used as a runtime test oracle.

The containing `0x67de280` branch with `context[8] == 0` also matches the
reference's padding and two feedback chains for non-overflowing nonnegative
input lengths n. It sets `p = (8 - ((n + 10) % 8)) % 8`, then feeds the block
routine this padded byte sequence:

```text
((R0 & 0xf8) | p) || R1..Rp || R(p+1)..R(p+2) || input[0..n) || zero[7]
```

Here R denotes the target's processed random bytes, not necessarily the low
byte of its raw PRNG return. Header/padding/salt construction is established
at `0x67de2e1–0x67de3be`, input copying at `0x67de4e0–0x67de4f7`, and the
seven-byte zero tail at `0x67de51d–0x67de571`; stages may cross a block boundary.
The output length is `n+p+10`. Before the first block, `0x67de361` clears the
previous-state word and points R12 at it. For successive padded blocks Pi:

```text
M_i = P_i XOR C_(i-1)
C_i = F(M_i, K) XOR M_(i-1)
C_0 = M_0 = zero[8]       # initial state, before the first block
F = the 16-cycle big-endian block transform above
```

`0x67de3c7–0x67de3dd` mixes with the previous ciphertext and calls F;
`0x67de3e2–0x67de41d` XORs the previous mixed block into its output;
`0x67de420–0x67de438` updates both prior states. The body and trailer repeat
this at `0x67de460–0x67de4d2` and `0x67de573–0x67de5d8`. The leaf reads input
and key without changing them when its output is independent.

The three random-byte sites resolve a PLT entry at `0x8e11830` through GOT
`0x9160368` to declared symbol `rand`; live binding was not observed. For its
standard nonnegative signed-32-bit return x, the multiply/shift sequence at
`0x67de2e8–0x67de2ff` reduces to `low8(x % 65534)`, **not** simply `low8(x)`.
The other two sites use the same reduction. One derivation uses
`q = floor(0x80010003*x / 2^47)` and `low8(x+2*q)`: the multiplier excess is
65530, and `65530*(2^31-1) < 2^47`, bounding q to `floor(x/65534)` throughout
that input domain. A separate pure-integer check covered all 98,309 distinct
quotient-boundary samples and the inequality; it did not execute sample code.
For example, x=65533/65534/65535 yields 253/0/1. There are `p+3` native PRNG
calls, unlike the local codec's single `randomSource(p+3)` call. The local
secure default RNG remains unchanged.

Thus **conditional static byte equivalence** with `qqTeaEncrypt` is established
for this branch when the initialized 16-byte key and processed random-prefix
bytes are equal, lengths do not overflow, and all input/key/output/state memory
is valid and free from destructive aliasing. The native routine has no observed
capacity argument/check: output must hold `n+p+10` bytes, and the four-byte
output-count slot must be writable. It clears that count at `0x67de369–0x67de36e`
and advances it by eight per block. Nonzero `context[8]` returns without that
initialization; no read of `context[9]` was seen within this selected routine.
Those are bounded direct-access findings, not claims about arbitrary aliases
or external callbacks. This does not establish live ciphertext equality,
default RNG equivalence, a real session key, or the native decryption path.

The [encrypted-payload candidate](<src/direct/target-msf-sso12-payload-candidate.ts>)
composes the existing mixed-head and QQ-TEA implementations for this restricted
uncompressed/encryption-enabled branch. `encodeTargetMsfSso12PayloadCandidate`
takes `head`, `body80`, a required 16-byte `key38`, and an optional synthetic
`randomSource`. It encrypts `H || body80`, substituting `00 00 00 04` only when
body80 is empty; nonempty body bytes receive no additional prefix. It snapshots
all plaintext and key material before calling a supplied RNG. Invalid key
lengths fail locally instead of emulating the native uninitialized-key behavior.

The result is encrypted B for the normal wrapper below, not a whole frame.
Its 16 MiB limit applies to ciphertext including QQ-TEA padding; outer framing
needs additional space and has its own cap. This wrapper clears its owned key,
head and plaintext buffers best effort, including on callback failure; the
underlying codec's internal allocations are not covered by that guarantee.
Built-ins must remain intact throughout the call, as with its dependencies.
This does not implement compression, alternate flags, session-key derivation,
signing, account discovery, production wiring or any transport operation.

**CRequestBase normal outer wrapper.** RTTI identifies vptr `0x9032168` as
`MSF::CRequestBase` (name at VA/file `0xfdfc40`). Its `+0x10` slot resolves to
writer `0x67b4440`, and `+0x18` to length function `0x67b4920`. Write
`LP4(X) = BE32(|X| + 4) || X`, let `P = u32(this+8)`, `A = string(this+0x10)`,
`B = string(this+0x28)` and `U = string(this+0x68)`. For `this[0xa0] == 0`, the
inspected supported modes write:

```text
BE32(L)
BE32(P | (this[0xa1] != 0 ? 0x40000000 : 0))
u8(this[0x0c])
mode-specific field
u8(this[0x60])
LP4(U)
B
```

| Modes P | Mode-specific field | Total self-inclusive length L |
| --- | --- | --- |
| 12, 20 | `LP4(A)` | `18 + |A| + |U| + |B|` |
| 13, 21 | `BE32(u32(this+0xa4))` | `18 + |U| + |B|` |

`0x67b4451` calls the length slot; `0x67b4454–0x67b4470` writes its result
big-endian. The mode dispatch uses the table at VA/file `0xfdfba0`; A's branch
begins at `0x67b44e2`, the integer branch at `0x67b44f3`. The final ordinary
branch `0x67b4622–0x67b4661` appends B as supplied, without a new length prefix
or an encryption call. Other modes take different paths and are not generalized
as valid packets here. The type byte is an object member, not a command-name
classification inside this writer. The constructor defaults it to 2, but the
inspected `0x676c9e0` caller subsequently writes 1. That caller constructs mode
12 at `0x676c9c8`; the constructor clears `+0xa0/+0xa1` at `0x6745d89`.
The inspected setters then copy A through `0x67b4410`, and the nested object
through `0x67b2750` (including its byte to `+0x60` and string to `+0x68`). These
setters do not change the two cleared flags. This identifies the normal branch
on the inspected stable-object path, not every possible caller or runtime state.

**Separate special wrapper, not implemented by the normal model.** Nonzero
`this[0xa0]` selects `0x67b4680`. It overwrites the already-built header H's
first word with a PRNG-derived value, constructs `Q = BE32(|H|+4) || H`, and
passes Q to `MSF::MSFCCrypt` at `0x67de280`. The configured key is a 16-byte
static string reached through pointer `0x9155938` (RELATIVE record at file
`0x81fd10`, pointee VA/file `0xba174c`), not a caller-selected key. It rebuilds
`BE32(5+|C|+|B|) || u8(0x80 | (rand() & 0x7f)) || C || B`. B is appended
*after* this encryption and is not part of Q. The selected encryption branch
has the conditional static correspondence described above; this still does not
implement the special wrapper's framing, PRNG state or runtime behavior.

Consequently, `encodeTargetServiceRequest` remains the earlier route's separate
model: it encrypts `head || busi` with an explicit key and classifies two source
command names. Applying those operations to `CRequestBase` would invent behavior.
B's upstream construction/encryption and real branch selection remain separate
questions; no live server accepted any bytes in this audit.

The separate offline
[normal-wrapper candidate](<src/direct/target-msf-request-base-candidate.ts>)
exports `encodeTargetMsfRequestBaseCandidate`. It requires exactly seven own
data fields: `mode`, `flagA1`, `field0c`, `field60`, `field68`, `field28`, plus
`field10` for modes 12/20 or `fieldA4` for modes 13/21. The raw-byte fields keep
their offset-based names because the model does not establish account, command
or key semantics. In particular, `field28` is already constructed caller-owned
payload; the helper neither encrypts it nor prepends another length to it.
`flagA1` is an explicit byte and any nonzero value sets mode bit `0x40000000`.
Special `flagA0`, other modes, mismatched branch fields, accessors, shared or
invalid views are rejected. Its 16 MiB cap and strict input shape are local
policies. The helper does not change the old service encoder or production
Bridge wiring.

The offline `assembleTargetSignStructureCandidate` models only the
fixed copy layout from three caller-supplied slot byte strings; it implements no
signing algorithm and does not establish the runtime slot values. Associating the
calls with those copies requires the intermediate values to survive the
intervening control flow without replacement or aliasing. In bounded linear
samples from each callee entry, `0x68418ac` saves the command, decimal 32-bit
value and body string, then reaches code using a global object at `0x917b5e0`.
Additional bounded instruction windows described below identify an MD5-like
computation candidate, not a complete signature algorithm. In the initial sample
from `0x683fa74`, code uses the command and body and contains several
command-string comparisons. Later bounded windows below recover three compared
values; runtime reachability is not established.
The sample from `0x6830c58` accesses global objects at `0x917b530` and
`0x917b860` and contains a possible `time` call; the sample does not prove the
clock value reaches the returned token. The initial entry samples were limited
to at most `0x1000` linear bytes per callee; neither those samples nor the
additional instruction windows below are complete control-flow graphs or proof
that every observed branch executes. The callees contain flattened control flow and
have not been fully reconstructed; these local calls do not establish the
algorithm, exclude deeper network or asynchronous effects, or prove that the
supplied file-signature ZIP implements this callback. In another initialization
window, an `O3CmdListNotify` pointer is passed to `0x686365f`,
whose inspected entry byte is `c3` (`ret`); the call alone is not evidence that
a notification was registered or processed. None of these static observations
is a live invocation or a successful signature.

Additional bounded windows in the candidate token path show why the output
cannot yet be replaced with a single known global string. At `0x6836d43–0x6836d63`
the code calls `0x6885046` with a pointer derived from `0x917b860` and a local
string, saving the returned pointer at `[rbp-0x590]`. A separately selected state
at `0x6836fa0–0x6836fd9` uses that object's `+0x48` pointer and `+0x50` length
to construct another local string. A later inspected state at
`0x683aff9–0x683b007` assigns that local string to the result candidate; the
complete path between these states, object lifetime and absence of intervening
mutation remain unknown. In an independent bounded inspection, `0x6885046`
traverses a binary tree using `0x6875528` to compare byte-string keys; it tracks
a lower-bound candidate and performs the reverse comparison before returning an
exact-match candidate. An empty tree or missing key returns its embedded
sentinel at the input object's `+0x08`, not a null pointer. The comparator uses
a `memcmp`-named PLT entry for the common prefix and then compares lengths.
The lookup returns a borrowed pointer; neither a stable tree nor the lifetime of
its nodes is established. In a separate bounded inspection, the lookup key passed
at `0x6836d4a` is the `std::string` built at `0x6830c80–0x6830c9a`: `0x683f8ae`
is a control-flow-flattened Meyers singleton getter whose only return loads the
fixed global object `0x917b530`, and `0x68119f6` copies the NUL-terminated C
string pointed to by that object's `+0x60` field. That storage lies past the
file's end in a runtime-initialized region, so the key is a runtime value set
when the singleton is constructed, not a shipped literal or a hardcoded command
name; its actual bytes remain unknown without the out-of-window constructor.
Within the inspected window no instruction rewrites the key's stack storage
between construction and use, though aliased writes cannot be fully excluded
under the flattened control flow. Elsewhere, the same stack slots
are reused across phases for different global-derived pointers; they must not
be treated as one persistent alias. The caller's `0x68564e1–0x68564fc` copy
uses its local result pointer and length for output `+0x00`, storing the low
length byte at `+0xff`. This link still depends on normal returns, valid
pointers, dynamic bindings and no destructive aliasing. It is not a recovered
token formula or runtime observation.

Further static windows in `0x68418ac` support a conditional MD5 intermediate
candidate. The caller's `0x68563b4–0x68563e0` path formats an unidentified
32-bit value (`r8d` from `[rsp+0x18]`) through the `0x8e12140` formatter and
passes the resulting string as the third argument (`rdx`,
`lea rdx,[rsp+0x140]` at `0x6856439`) to `0x68418ac`. The `lea` instruction at
VA `0x68563d2` has bytes `48 8d 0d c3 65 36 fa` and resolves to format-string
VA `0xbbc99c`. The ELF read-only `PT_LOAD` maps this VA to file offset
`0xbbc99c`, where the bytes are `25 64 00` (`%d`). The executable `PT_LOAD`,
by contrast, uses VA = file offset + `0x1000`. Applying that executable-segment
offset to the read-only segment erroneously reads file offset `0xbbb99c`
(`6c 2c 20 7b 7d 00`, `"l, {}"`); earlier document revisions made exactly that
mapping error. VA `0xbbd99c` is not the `%d` format string either. Radare2
comments from a uniform `-m 0x1000` raw mapping must not be used to resolve
read-only strings without the appropriate `PT_LOAD` translation.

For this sample, translate a file-backed VA with the segment containing it,
using `fileOffset = p_offset + VA - p_vaddr` and checking the `p_filesz` bound:

| Segment flags | `p_vaddr` | `p_offset` | `p_filesz` |
| --- | --- | --- | --- |
| R | `0x0` | `0x0` | `0x299d2cc` |
| RX | `0x299e300` | `0x299d300` | `0x6475100` |
| RW | `0x8e14400` | `0x8e12400` | `0x33f2f0` |
| RW | `0x91546f0` | `0x91516f0` | `0xca60` |

The formatter `0x8e12140` resolves through its GOT slot `0x91607f0` to the
libstdc++ `__gnu_cxx::__to_xstring` specialization, and `[0x91533a0]` resolves
via a `GLOB_DAT` relocation to `vsnprintf`; `edx = 16` is its buffer-size
argument. That GOT VA maps to file offset `0x91513a0`, whose raw qword is zero
before relocation. The erroneously uniform raw mapping instead reads offset
`0x91523a0`, whose qword is ten; it is not evidence of a radix argument.
Subject to the normal ABI and dynamic bindings, `%d` renders the input bit
pattern as signed decimal. A bounded trace of the digest shows that
`0x68419b9` loads the data pointer from the third argument's string object and
`0x68419c1` loads its low 32-bit length. The offline
`targetSignedDecimalMd5Candidate` models signed-decimal MD5 for explicitly
supplied bits, but complete reachability, object lifetime, MD5 path equivalence,
final signer semantics and actual target output remain unverified. Other
branches and uses of the command and body arguments are not excluded. Two distinct
state checks precede the inspected digest path:
`0x6843265–0x684327e` tests byte `+1` of the object returned by `0x684bd56`,
and `0x68433ec–0x684340a` tests dword `+0xa0` of the object returned by
`0x683f8ae`. The candidate path requires respectively a nonzero byte and a
value of one; other paths and the actual runtime values remain unknown.

Under those gates and normal control flow, the observed initialization at
`0x6841993–0x68419ec` clears the bit count, loads the conventional MD5 IV from
the original bytes at VA/file offset `0xbc6e20`, and reads the third parameter's
string pointer and low 32 bits of its length. The padding path saves the original
64-bit bit count, chooses `56 − n` or `120 − n` bytes for
`n = (oldBits >> 3) & 63`, and copies a block whose first byte is `80` followed
by 63 zero bytes. Its VA is `0x9156390`, with original file offset `0x9153390`.
A formatted signed-decimal integer string is nonempty and has at most 11 ASCII
bytes; assuming the formatted object, pointers and buffers remain consistent,
this case fits one final padded block. The `0x6845167–0x684521b` loop assembles its 64 bytes
into 16 little-endian words.

For the first tail-block copy at `0x6845220–0x6845b1a`, all 64 compression steps were
compared statically with RFC 1321: constants, rotations, message-word indices,
round Boolean functions, state dependencies and four-word feed-forward match
the MD5 compression function. A separate disassembly of the 700 instruction
records and a comparison with original ELF bytes agreed on their addresses,
bytes and decoded opcodes. This is a bounded **linear-window** result, not a
whole-function control-flow proof. The subsequent independent mapping audit
reproduced the matches for all 64 round constants and rotations in
`0x6845220–0x6845b19`; that narrower recheck did not independently prove every
message-word selection, Boolean operation or feed-forward dependency claimed
by the earlier comparison. The second tail copy beginning at `0x6845bb9` and
unexamined steps of the full-block copy remain unknown.

The `0x6846699–0x6846796` window serializes four state words into 16 bytes,
and `0x6846887–0x684695b` copies and passes that interval to a PLT target whose
`R_X86_64_JUMP_SLOT` names a `basic_string::_M_construct<const char*>`
specialization. Dynamic export metadata also identifies the caller's
`__to_xstring`-style formatting helper (REA Evidence
`ev_44f6b2a8375b0ed7b4c9f7af2dc21fef36d6ca6afb989f0e19e875dcd522d82d`);
actual runtime PLT binding remains unknown. A further bounded trace follows the
result object: `0x6846887–0x6846923` copies 16 bytes into the half-open range
passed at `0x684694b–0x684695b` for construction into the callee's incoming
result object. The selected return state reaches `0x684bd19` and returns that
object if its canary check passes. At `0x685641c–0x6856444` the caller supplies
its stack object at `+0x100`; after two intervening calls, `0x68564b4–0x68564d9`
loads that object's pointer and length, calls a PLT entry whose ELF JUMP_SLOT
names `memcpy` with the destination saved from output `+0x200`, and stores the
length's low byte at output `+0x2ff`. The inspected copy has no visible local
length clamp. If the constructed range remains intact, intervening calls and
aliases do not replace it, the checked branches complete normally and the PLT
entries use the expected bindings, this path copies 16 raw bytes and records
length `0x10`. Those conditions and actual branch execution are not observed.

The offline [signed-decimal MD5 candidate](src/direct/target-signed-decimal-md5-candidate.ts)
accepts an unsigned 32-bit bit pattern, formats it as a signed decimal integer
and returns the 16 raw MD5 bytes. Its fixed-vector tests exercise only this pure
calculation, not the target. It is not wired into a signer; the conditional
static connection above does not prove an actual target result, that the supplied
ZIP implements this path, or that real QQ accepts the output. The offline
`placeTargetSignedDecimalMd5SlotCandidate` conditionally projects that 16-byte
candidate into a caller-supplied 0x300-byte structure, preserving all other
bytes except its length slot; it does not decide whether the target gates hold
or produce the other fields. No target native code was executed to establish
these observations.

In `0x683fa74`, separate bounded decoding windows recover three command
constants: `trpc.o3.ecdh_access.EcdhAccess.SsoEstablishShareKey`,
`trpc.o3.ecdh_access.EcdhAccess.SsoSecureA2Establish`, and
`trpc.o3.ecdh_access.EcdhAccess.SsoSecureA2Access`. The inspected comparisons
call a PLT entry whose `R_X86_64_JUMP_SLOT` names `strcmp`; those C-string
comparisons constrain only the prefix before the first NUL, not necessarily the
complete original string object. Under the indicated equal-branch and normal
pointer/lifetime conditions, their flattened state paths converge on a call at
`0x684011a` to `0x6be3c6c` with a global object, a body copy and a command copy.
In the helper's entry window, the saved `RDI` is the result object, `RDX` is
the body-string argument and `RCX` is the command-string argument. The first
command comparison at `0x6be3d2c–0x6be3dbb` reads the command length, the
expected length at global `0x917bb68`, the expected pointer at `0x917bb60`, and
then the command pointer. Different lengths select a false result. Equal zero
lengths select true without calling `memcmp`; equal nonzero lengths call the
`memcmp`-named PLT entry `0x8e10110` on all bytes and select true only for a zero
return. This comparison includes embedded NUL bytes, unlike the upstream
`strcmp` checks. The expected pointer and length are separate reads, not a
proven atomic snapshot; their runtime values remain unknown.

The inspected flattened transitions at `0x6be425a` and `0x6d04b74` choose main
state `0x69702191` for this first match, or `0x1de070ba` for a mismatch. The
latter continues to a different global-command comparison and is not established
as the helper's final rejection. The matching state reaches `0x6be3f19`, which
assigns the body string to a local string through the `_M_assign`-named PLT
entry `0x8e12010`. After normal return, `0x6be3f33` sets a local discriminator
to one and main state `0xfccb4311`. At `0x6be4295–0x6be42c9`, that state's
handler saves the copied body's length and starts nested state `0x8f55aae4`;
`0x6be680f` dispatches it to `0x6d017e3`. A zero length selects nested state
`0x3a0f83d9`, while a nonzero length selects `0x6a14ac65`. The following
observation concerns only the zero-length path.

Through `0x6be67b0`, the zero-length state reaches `0x6d0179b`, which passes
`0x91563d0` to helper `0x6d07606`. That helper conditionally calls the
`pthread_mutex_lock`-named PLT entry depending on a separately read runtime
qword at `0x9153310`; the call's success and its applicability to other writers
are not established. Next, let `G` denote the 160 bytes beginning at
`0x917bbe0`. A nonzero `G[0]` selects nested state `0x56904548`. Otherwise,
`0x6be67dc–0x6be6807` calls the `bcmp`-named PLT entry on `G[0:159]` and
`G[1:160]`; a nonzero result selects the same state, while zero selects
`0xeb441fd4`, a path not reconstructed here. For an unchanged snapshot and the
expected `bcmp` binding, the selected state therefore means only that at least
one byte in `G` is nonzero, not that the block is initialized or valid.

State `0x56904548` reaches `0x6d017fd`, which uses the
`basic_string::_M_construct<const char*>`-named PLT entry `0x8e11fc0` to
construct the result from `[0x917bc08, 0x917bc28)`, or `G[0x28:0x48]`: exactly
32 bytes, including any NUL bytes. Those 32 bytes can all be zero even when
another byte made `G` nonzero. At `0x6d01821` the code calls `0x6d076a2`,
which conditionally invokes a `pthread_mutex_unlock`-named PLT entry. Under the
inspected subsequent states `0x49c4fd2e` and `0x2031f10d`, `0x6d051a2`
cleans the local string and the stack-canary-success path returns at
`0x6d051f1`. The command-mismatch, nonempty-body and all-zero-block paths are
not resolved by this branch.

A further bounded trace follows the helper result through its caller on one
additional conditional path. `0x684011f–0x684012d` moves the returned string
to a local object, then inspected outer-result operations append the bytes
`0x0a`, `0x20`, and the 32 raw bytes. If the two subsequently checked auxiliary
strings have zero length, the indicated return states complete normally and no
intervening alias or concurrent mutation changes the string, the result is 34
bytes: `0a 20 || G[0x28:0x48]`. The caller at `0x685650a–0x6856527` copies
that candidate into output `+0x100`; `0x685678b–0x6856794` stores its length's
low byte at output `+0x1ff`. With the same assumptions, that byte is `0x22`.
These are conditional static observations for the described matched-command,
empty-body, nonzero-global branch, not evidence that the actual global, command,
auxiliary fields or runtime execution satisfy the conditions. The offline
`placeTargetO3EmptyExtraSlotCandidate` projects only this asserted local branch
from caller-supplied bytes; it does not select commands, model other branches or
implement a complete signer.

The named entries above are observations from this ELF's `.rela.plt`
`R_X86_64_JUMP_SLOT` records: indices `0x10` and `0x12` name `memcmp` and
`bcmp`, `0x200` and `0x1fb` name the respective `_M_assign` and
`_M_construct<const char*>` specializations, and `0xe0` and `0xe4` name
`pthread_mutex_lock` and `pthread_mutex_unlock`. Their corresponding relocation
file offsets are `0x850568`, `0x850598`, `0x8533e8`, `0x853370`, `0x8518e8`
and `0x851948`. These names do not establish actual runtime binding. This ELF's
executable `PT_LOAD` maps file `0x299d300` to VA `0x299e300` for `0x6475100`
bytes, so the code addresses in these windows use VA = file offset + `0x1000`.
The expected-command slots and `G` lie in a different, zero-filled portion of a
writable load segment; file bytes and the code mapping do not determine their
runtime values. Capstone and Zydis independently decoded the 34-record comparison
window and 93 additional records from the selected state and return windows;
instruction addresses, sizes and bytes matched each other and the original ELF
bytes. This is bounded static evidence, not a complete control-flow graph or
observed execution.

The offline [empty-body global-slice candidate](src/direct/target-empty-body-global-slice-candidate.ts)
models only this conditional branch with caller-supplied command, expected-command
bytes, body length and a 160-byte block. It returns a fresh 32-byte slice when
the modeled conditions hold and `null` for other valid cases, which remain
unresolved rather than representing a target return. Its command-size and input
validation limits are local policy, not recovered target limits. Separate,
purely synthetic Python checks exercised the modeled predicate, including
embedded NULs, an all-zero block and a nonzero byte outside the returned slice;
they did not execute this TypeScript implementation or the native target. The
separate synthetic Vitest suite exercises the TypeScript candidate with local
fixtures, not the native target. This model is not connected to a signer and does
not establish the actual command or global contents.

Other bounded windows conditionally move the helper result into a local string,
append its bytes to a return string and copy that result to the caller's output
region at `+0x100`. This is a candidate data dependency on the region previously
associated with the `extra` diagnostic, not proof of the executed path, a
complete extra algorithm or a working QQ signature. The interpretation requires
normal returns, the named dynamic bindings, valid memory, stable intermediate
pointers and contents, and no destructive aliasing or interfering writes. In
particular, the observations do not prove that the conditional lock runs or
that every writer uses it.

Additional bounded windows identify a conditional candidate writer for the
same output slice. At `0x6d01240`, `488d3d39aa4702` loads `0x917bc80` into
`RDI`, and `0x6d01247` calls PLT entry `0x8e126f0`. The address `0x917bc80` is
`G + 0xa0`, immediately after the defined 160-byte block; the object's runtime
state is unknown. After a normal return, `0x6d01253` (`8985e8e4ffff`) saves
`EAX` at `[rbp-0x1b18]`, and the following instructions set `r13d` to zero and
select state `0x1302ca3d`. In its inspected handler, `0x6d011a1` and
`0x6d011a7` copy that 32-bit word into `[rbp-0x1a78]`, while `r13d` is saved
and sign-extended as the index. The unsigned comparison at `0x6d011c9` selects
state `0xe60b69d9` when that index is below 32. This is an index bound, not an
observed string length.

For the nonnegative indices reached from that zero initialization, the window
`0x6d01062–0x6d01080` computes `index % 4`. The state `0x36eb1cd3` handler at
`0x6d0114e–0x6d01165` multiplies that remainder by eight, shifts the word in
`[rbp-0x1a78]` right by the resulting count, and saves the result in
`[rbp-0x1ab8]`. State `0x943baf34` selects the write window:
`0x6d0110f` (`8b8548e5ffff`) loads that result into `EAX`, `0x6d01115`
(`488b8d70e5ffff`) loads the saved index into `RCX`, `0x6d0111c`
(`488d15bdaa4702`) loads `G` into `RDX`, and `0x6d01123` (`88441128`) writes
`AL` to `G + 0x28 + RCX`. Thus, under the inspected state transitions and stable
slot and memory conditions, output byte `i` is the low byte of `word >>
(8 * (i % 4))`: each 32-bit word is emitted low byte first.

After each write, the window `0x6d01127–0x6d01149` selects a further call
when `index % 4 == 3`; the `0x9d468c30` handler calls the same PLT entry at
`0x6d01030` and saves its returned `EAX` for the next iteration. The
`0xf761b101` handler increments the index and carries that word to the next
`0x1302ca3d` iteration. If all these dispatches are reached in the indicated
order and the calls return normally, indices 0 through 31 use eight words.
The call after index 31 is a ninth call on that path; its result has no
corresponding byte in the inspected 0–31 loop, and its later use is unknown.

The PLT entry at `0x8e126f0` begins with `ff25d2e33400`, jumping through
`0x9160ac8`, followed by `686e020000`, which pushes relocation index `0x26e`.
The corresponding `.rela.plt` record at file offset `0x853e38` is
`c80a16090000000007000000ec0100000000000000000000`: its `R_X86_64_JUMP_SLOT`
references `_ZNSt13random_device9_M_getvalEv`. This is an import declaration,
not a runtime-binding or entropy observation. A separate bounded state handler
at `0x6d00f86–0x6d0100e` constructs a local string from the seven bytes
`default` at `0x992a56`, then calls PLT `0x8e12700` with `0x917bc80` and the
string; the PLT relocation names `std::random_device::_M_init`. After normal
returns from subsequent calls, that handler selects the `0xe0750608` state that
locally dispatches to the first `_M_getval` call above. This suggests a possible
initialization path, not proof that it runs or that either import binds to the
named implementation. The actual object state, call results, reachability, lock
coverage, and stability of stack slots and global contents remain unknown.

A separate chain of inspected dispatcher states can change the same slice. Let
`i` be `[rbp-0x1a58]`, `P` be `[rbp-0x1a88]`, and `Q` be `[rbp-0x1a60]`.
The handler at `0x6d011df–0x6d0123b` saves `d = G + 0x28 + i`, computes
`*d XOR P[i]`, reads `Q[i]`, and selects state `0xd26f9f82`. The matching
handler at `0x6d00f49–0x6d00f6b` XORs those saved values and selects
`0x70cfd142`; its handler at `0x6d00f05–0x6d00f1d` writes the low byte through
`d`. The subsequent state increments the index and returns to a local unsigned
`index < 32` check. Under the inspected transitions, valid pointers, stable slots
and no interfering writes, one iteration is `G[0x28+i] ^= P[i] ^ Q[i]`.
A bounded initialization window sets the loop index to zero, but the complete
path to that window and its runtime execution remain unproved.

Two other observed calls request 32 bytes from PLT `0x8e10800`: at
`0x6d00970–0x6d0097a` the result is saved in the `P` slot, and at
`0x6d00c68–0x6d00c72` it is saved in the `Q` slot. Its `.rela.plt` entry at file
offset `0x850fd0` declares `malloc`; the actual binding, allocation success,
intervening slot updates, buffer contents and possible aliasing are unknown.

On an inspected conditional path, the `P` buffer is filled before the
random-word writes above; afterwards the `Q` buffer is filled, and the XOR
loop runs. The `P` path calls the PLT at `0x6d009a4`; the `Q` path calls it
again at `0x6d00c9c`. PLT `0x8e124c0` uses GOT `0x91609b0`; its
`.rela.plt[0x24b]` entry at file offset `0x853af0` declares the external symbol
`std::chrono::_V2::system_clock::now`. Each path saves the return and uses
`mov ecx, eax` to initialize the first state slot, thus retaining its low 32-bit
pattern. The two call results are separate observations: their actual values,
clock units and equality are not established.

Each path initializes 624 eight-byte slots, followed by an index value of 624,
using the 32-bit recurrence multiplier `0x6c078965`. The engine call targets PLT
`0x8e12120` and GOT `0x91607e0`; `.rela.plt[0x211]` at file offset `0x853580`
references a weak defined `std::mersenne_twister_engine` operator with the
32-bit MT19937 parameters and ELF symbol value `0x6d06e00`. Its candidate
`_M_gen_rand` at `0x6d06e66` follows PLT `0x8e12150` and a separate relocation.
Under the seeded-state invariant that the upper 32 bits of every eight-byte slot
remain zero, the inspected initialization, in-place 624-word twist and temper
operations agree with the standard 32-bit recurrence. The two byte loops use
x86's masked 32-bit shift count and store only `AL`; each successive four-byte
group is therefore emitted low byte first. On this path eight words fill each
buffer, while a ninth call is made after the final byte; its later effect remains
unknown. Initial GOT contents are lazy-binding stubs, not observed resolved
function addresses. Interposition, dynamic binding, actual calls and the values
stored remain unverified.

The separate [seeded slice-mix candidate](src/direct/target-seeded-mt-slice-mix-candidate.ts)
is a pure local model: callers supply two uint32 seeds and the 32-byte slice
**after** the candidate random-word writes but **before** the XOR. It creates
two standard MT19937 streams and returns the XOR of their first eight words,
expanded low byte first, with that caller-supplied slice. Its input restrictions
and memory bounds are local policy, and it has no connection to a signer or the
existing return candidate. Its finite output matches independent synthetic C++
`std::mt19937` and NumPy `RandomState` vectors; those vectors do not establish
native execution. The model assumes the inspected dispatcher states and calls
occur in order, the target functions bind as above, memory remains valid and
stable, and no intervening write or destructive alias changes the values. The
connection from the subsequent XOR path to the helper's eventual return remains
unproved; neither this model nor the earlier random-word observations establish
a complete signature or QQ acceptance.

Additional bounded Capstone x86 and Zydis windows extend the conditional path
past the XOR loop without establishing its eventual return. When the saved
index is 32, the unsigned comparison at `0x6d0118b` selects state
`0xff0e352a`; the inspected dispatch tree reaches its matching handler at
`0x6d0128d`. That handler reads a byte from global `0x917e398`, saves it in a
local slot, and selects `0x1d3f1d43`. The corresponding handler selects one of
two states according to that byte. If it is zero, a path calls `0x299eeac` with
that global's address and branches on the return; its initialization paths are
not fully reconstructed. If it is nonzero, the selected path tests a second
byte at `0x917f728`, with a similar conditional call when that byte is zero.
Both globals are in a writable, zero-filled portion of a load segment; their
runtime values and intervening writes are unknown.

On the conditional fast path where both bytes are nonzero, `0x6d0169b` passes
`0x917e3a0` to PLT `0x8e12120`, then initializes an index to zero. Its
`0x6d014d8` handler bounds the index below eight. For each index,
`0x6d012e3–0x6d01302` shifts the saved low 32-bit result right by eight times
`index % 4` and writes the low byte to `G + 0x50 + index`. After indices 3 and
7, `0x6d015c1` makes another call to the same PLT with the same global object;
the result after index 7 has no corresponding write in this eight-byte loop,
and its later use is unknown. Subject to normal returns and stable state, the
first two returned words therefore supply bytes 0–3 and 4–7 in low-byte-first
order. This does not establish whether that global object's state is related to
those used for `P` or `Q`. The referenced dynamic symbol is weak and
public/default visibility, so it may be preempted; the file's initial lazy GOT
entry is not the resolved runtime binding.

After that loop exits, `0x6d016dd` writes the all-ones qword to `G + 0x20`, and
the preceding instructions clear a separate 32-byte local stack region. These
writes to `G + 0x20` and `G + 0x50` through `G + 0x57` lie outside the
`G + 0x28` through `G + 0x47` slice, but inside the 160-byte block. The
inspected continuation selects state `0x327ad760` and reaches the dispatcher
handler at `0x6be748d`; subsequent inspected windows use additional local
states and a byte read. A connection from this path to the slice read at
`0x6d017fd`, a helper return, or the caller's output remains unproved. In the
sequential stream reached from the direct branch target `0x6d01392`,
`0x6d013c4` is the final byte of the instruction starting at `0x6d013c2`, not
an instruction boundary in that stream. These are conditional static facts;
indirect calls, aliases, concurrent writers and runtime control flow remain
unresolved.

A further conditional continuation reads a descriptor at linked address
`0x9035278`. Under the inspected non-null branch, with the traced pointer still
intact, `0x6c0478f` reads the byte corresponding to linked address `0x9035284`;
when that byte is nonzero, it is saved alongside a pointer to a
cleared 32-byte stack region. Later code reads the little-endian dword at
`0x9035280` and, if it equals 4, calls PLT `0x8e10720` with `(1, 0x6c)` and
stores the result in a local object. Its relocation declares `calloc`; the actual
binding and return value remain unobserved. On the further conditional path where
that return is nonzero, its `[0, 0x6c)` range is writable, the traced pointer is
intact and the stores complete, seven 16-byte stores at
`0x6be7d66` through `0x6be7d84` write zeros over `[0, 0x6c)` relative to the
returned pointer, with overlapping stores. Instruction `0x6be7d99` then reads
the descriptor byte at `+0xd`; the inspected continuation passes `(2, byte)` to
the same PLT entry and tests the second return for zero. Neither runtime binding
nor either allocation result has been observed. The inspected continuation has not
established a read from `G + 0x28` through `G + 0x47` or a link to the eventual
return, and it does not establish that no such link exists later.

Under the further assumptions that both calls return nonzero and the traced local
slots remain stable, the inspected dispatcher states set a local flag to zero,
carry the address of `[rbp-0x1420]` into another local slot, and reach the
comparison at `0x6bf9bb0` and conditional jump at `0x6bf9bb5` to `0x6bf9e8f`.
That handler reads the local object's descriptor pointer and, if nonzero, selects
state `0xb8fe90a5`. The handler at `0x6bf9a20` then checks the local object's
`+16` pointer slot for zero;
this checks the pointer itself, not bytes in the allocation it points to. On the
nonzero branch, `0x6bf9c68` reads descriptor `+0xd` again and compares it as an
unsigned value with a previously saved value derived from descriptor `+0xc`.
The second read is not necessarily equal to the byte used in the earlier call.

For the conditional `L <= r` branch, write `L` for the saved value derived from
`+0xc`, `r` for that later `+0xd` read, `K` for the second allocation, and `S`
for the previously saved stack-region pointer. Code then reads `+0xd` twice more,
calling PLT `0x8e10040` as `(K, 0x36, n1)` and `(K+n1, 0x5c, n2)` respectively.
Its relocation declares `memset`, but its actual runtime binding remains unknown.
If those calls have normal `memset` semantics, their addresses are writable and
`n1+n2` fits the allocation, they fill the two corresponding ranges. The three
`+0xd` readings used for allocation and filling are separate reads, as is the
comparison value `r`; equality requires an additional stability assumption.
The condition `L <= r` alone does not bound `L` by either later fill length.

The selected state initializes index `i` to zero and, when `i < L`, reads `K[i]`
and `S[i]`, XORs them and writes the low byte back to `K[i]`. It then reads
`K[n1+i]` and `S[i]`, writes their XOR to `K[n1+i]`, increments `i`, and returns
to the unsigned `i < L` test. This describes the inspected loop control under
valid-address, stable-pointer and non-destructive-alias assumptions. On exit
state `0x83fd5b18`, code checks the descriptor again and, if its `+8` dword
still equals 4 and the first allocation `P` remains valid and writable, initializes
parts of `P`. It then rereads descriptor `+0xd` as a separate length `n3` and
saves both `K` and `n3` in local slots. A subsequent handler independently
rereads descriptor `+8`; if this later read also equals 4, the selected branch
calculates the addresses `P+0x28` and `P+8`. Those address calculations do not
read their contents or use `G` as the base, and do not establish a reference to
`G+0x28`; aliasing between `P` and `G` remains unobserved. These observations
alone do not establish what consumes `K` or the exit of this path; a further
conditional path is examined below. Neither `n3` nor either `+8` check is an
observation of runtime values, and the repeated reads need not match.

Under the further conditions that `n3` is nonzero and the saved slots and pointer
remain stable, the selected handler reads the first dword of `P` as `c`, saves
`64 - (c & 63)`, then writes `(c + n3) mod 2^32` back to that dword and records
the unsigned carry for subsequent dispatch. If the earlier initialization of
that dword to zero is still intact, this particular update has `c=0` and no carry;
that remains conditional rather than a runtime observation. These reads and
writes concern `P`; they do not establish that the separately saved `K` or its
contents are consumed, nor do they establish the identity of the eventual hash,
return value or SSO signing callback.

On the selected no-carry branch, the code tests `t = c & 63` and copies `t`,
`K` and `n3` into further local slots. When `t` is zero, it subsequently compares
`n3` as an unsigned length against 64. Under the additional condition `n3 >= 64`,
the inspected handlers copy `K` and `n3` again and dispatch to `0x6c0072e`.
A zero `t` does not by itself imply `c` is zero, and `n3 >= 64` is not a runtime
observation. The current `n3` is a separate descriptor read and need not match
the earlier lengths or the original file byte.

On that further selected path, `0x6c0072e` first controls a loop that copies eight
32-bit values into the stack array beginning at `V = rbp-0x12b0`. The source is
`P0+8`, where `P0` is the value read from `[rbp-0x1558]` and saved in
`[rbp-0x1b40]` by `0x6bfda47–0x6bfda5c`. The adjacent slot `[rbp-0x1b28]`
saves `P0+8` at that time. Separately, `0x6be3ccd–0x6be3ce6` computes `V` and
stores it in `[rbp-0x1b78]`; relating these facts requires the same execution
frame and stable intervening slots. The copying source's alias relationship
with `K` remains unobserved. Valid reads and writes and non-destructive overlap
are required for the copied words to retain their respective source values; a
single simultaneous eight-word source state additionally requires the source
not to change across reads. The 32-byte working array at `[rbp-0x12b0,
rbp-0x1290)` is adjacent to, and does not overlap, the 256-byte schedule array
at `[rbp-0x13b0, rbp-0x12b0)`; the source range has not been shown disjoint
from either. Only after that loop finishes does the code initialize an index
`j` to zero and, while `j < 16`, read four bytes per iteration from the pointer
saved at `[rbp-0x1b18]`. The previously traced
pointer-copy chain identifies that pointer as `K` under the same slot-stability
and non-destructive-alias assumptions. The byte loads at `0x6c0058c`,
`0x6c00593`, `0x6c0059d` and `0x6bff4d1` are combined and written to the stack
array at `[rbp-0x13b0 + 4*j]`. If the corresponding `K` bytes remain unchanged
throughout their reads, the resulting 32-bit value is
`W[j] = BE32(K[4*j .. 4*j+3])`; otherwise, its four bytes are the values at
their respective load times. Reaching and completing these reads additionally
requires the eight preceding source words to be readable, their destinations to
be writable, and all 64 bytes of `K` to be readable; the length comparison alone
does not establish allocation capacity or valid addresses.

After the 16-word load, a separate index `k` begins at zero. In the selected
first iteration, `0x6c004bc–0x6c004dd` reads `W[0]` and the first 32-bit table
entry at linked address `0x00fe6a00`. Assuming `W[0]` remains intact between
its creation and this use, these values and the `r15` fields are readable and
stable across their uses, and the intermediate stack slots are writable without
destructive aliasing, write `A` through `H` for the 32-bit fields at offsets
`0` through `+0x1c` of the `r15` value at `0x6c0042a`. Under those same
conditions, the inspected first item computes and writes, modulo 2^32:

```text
T1 = H + (ROL32(E, 26) ^ ROL32(E, 21) ^ ROL32(E, 7))
       + (G ^ ((F ^ G) & E)) + table[0] + W[0]
T2 = (ROL32(A, 30) ^ ROL32(A, 19) ^ ROL32(A, 10))
       + ((A & B) | (A & C) | (B & C))
[r15+0x0c] = D + T1
[r15+0x1c] = T1 + T2
```

The `T1` result is stored in a temporary stack slot at `0x6c004f5`; `T2` is
stored at `0x6c000ed`, followed by the two writes at `0x6c0011a` and
`0x6c00135`. A second static decoder independently confirmed this first item.
Linking that `r15` to `V` additionally requires the register to still contain,
or have restored, the saved pointer when entering `0x6c0042a`; it is used as
scratch on other paths. A separate trace identifies two unrolled batches
beginning at `k=0` and `k=8`, reading `W[k+n]` and `table[k+n]` for `n=0..7`
and advancing `k` by eight. The independent check covers the first update,
not the complete formula of every unrolled item. These are in-place slot writes,
not proof that the code literally shifts all eight fields. The table's first
16 original file bytes are `98 2f 8a 42 91 44 37 71 cf fb c0 b5 a5 db b5 e9`;
interpreted as little-endian 32-bit words they are `428a2f98`, `71374491`,
`b5c0fbcf` and `e9b5dba5`. Treating those as runtime table values additionally
requires the loading, any relocations and subsequent writes to preserve the
corresponding file bytes. The first-item expressions, two writes and these first
four constants are consistent with one SHA-256 compression update using rotating
slots and the corresponding round constants. This local match does not prove the
complete algorithm, final output, or a connection to the current QQ SSO signing
callback.

On the further selected `k >= 16` branch, `0x6bff5c8` initializes a batch index
`b` to 16. At `0x6c00b43`, an unsigned comparison selects the expansion path
while `b < 64`; `0x6c00b09–0x6c00b1a` advances it by eight. Under stable index
and pointer slots, valid readable and writable storage, no exceptions and no
destructive aliasing, the examined batches start at 16, 24, 32, 40, 48 and 56.
They produce `W[16]` through `W[63]`; the next comparison at 64 exits instead of
accessing `W[64]`. The primary static trace inspected all eight unrolled items;
an independent decoder confirmed the first and last items and the loop boundary.
For each resulting index `x`, the inspected operations correspond to:

```text
s1(v) = ROL32(v, 15) XOR ROL32(v, 13) XOR (v >>> 10)
s0(v) = ROL32(v, 25) XOR ROL32(v, 14) XOR (v >>> 3)
W[x]  = s1(W[x-2]) + W[x-7] + s0(W[x-15]) + W[x-16]  mod 2^32
```

The recurrence matches the SHA-256 message schedule after converting the rotate
directions. Its reads must observe the intended initial or previously generated
words; the code also interleaves table reads and working-data writes, so this
relationship depends on those writes not destructively aliasing `W` or its
pointer slots. The offline [`targetSha256ScheduleCandidate`](src/direct/target-sha256-schedule-candidate.ts)
models this recurrence for one caller-supplied 64-byte block and returns fresh
numeric schedule words, not digest bytes; the returned typed array's backing-byte
order is platform-native. It rejects shared, resizable and invalid backing views; callers
must exclude external native writes or backing invalidation during the snapshot.
Its fixed errors distinguish invalid input, unavailable prerequisites and
operation failure. It is not wired into the signer and has not been compared with
a runtime execution of the target.

After the `b=64` branch, the selected dispatcher initializes a new index to
zero and loops while it is below eight. `0x6c006cf` reads a 32-bit word through
`r15`, and `0x6c006ff` adds it modulo 2^32 to the corresponding word through
`Q = [rbp-0x1b28]`, writing the sum back through `Q`. The traced setup saved
`P0+8` there, using the value read through `[rbp-0x1c10]` at that time; the
latter pointer was set to `&[rbp-0x1558]`. The saved `Q` equals `P+8` only if
that earlier slot still held the previously established `P` when sampled and
the saved `Q` slot remains unchanged. Later changes to `[rbp-0x1558]` do not
themselves change the already-saved pointers. On the selected last expansion
batch, `0x6bffbcc` restores `r15`
from `[rbp-0x1b78]`; if that slot still contains `V`, the traced successors
leave the register unchanged, and `[rbp-0x1b28]` still contains the previously
saved `P0+8` through the writeback reads, this add-back reads `V` and writes to
`P0+8`. The eight source words and destination words must be readable and the
destination writable; `r15`, `Q`, the index and intermediate pointer slots must
stay stable across the loop, without concurrent interference or destructive
aliasing. If the two ranges coincide, these additions instead double the words;
partial overlap can also affect subsequent reads. The complete preceding round
sequence, final output and any SSO connection remain unestablished.

The original file bytes `+0xc = 0x20` and `+0xd = 0x40` suggest `L=32` and
64-byte halves only if they and the relevant reads remain unchanged at runtime.
A distinct `L > r` branch performs conditional writes to the first allocation,
but its subsequent behavior is not yet traced. Neither branch is connected here
to `G + 0x28..0x47`, the final output, or an SSO signer; these observations alone
do not establish that link.

The descriptor bytes have a different file mapping from the code: the writable
`PT_LOAD` maps linked `0x9035280` through `0x9035285` to file offsets
`0x9033280` through `0x9033285`. The six original bytes are `04 00 00 00 20 40`.
Independent bounded static parsing of this file's declared `DT_RELA` and
`DT_JMPREL` tables found no relocation write intersecting that six-byte interval.
Its dynamic table declares no standard REL or RELR table, nor the examined
Android packed REL/RELA/RELR tags; its section table has no `SHT_REL` or
`SHT_RELR`. The adjacent
`R_X86_64_RELATIVE` write at `0x9035278` ends immediately before the interval.
These file and relocation facts do not establish the runtime values: declared
initializers, other loader processing or later writes remain unexamined.

These code observations use the executable `PT_LOAD` mapping stated above,
not a file mapping for `G` or the adjacent global object. Capstone and Zydis
independently decoded the selected bounded instruction windows with matching
addresses and bytes. REA target-free ELF-note inspection bound the artifact
identity to SHA-256
`dc5209e20002735e31a20c9cded0a807d1db4779277dec66c9221ea28a870328`
(Evidence `ev_271c0c5147b796ee579565881d7092aee4e02a7201c1955a4baf0261355b143d`).
This is static evidence rather than observed execution or a complete search for
writers.

The separately supplied file-signature research archive contains a report that
also refers to constructor `0x351fb20`, vtable address point `0x8e80f38` and
two command-literal leads. These are report assertions; the archive did not
contain the reported original ELF or application-signature files. The report
includes its own corrections and an unresolved address discrepancy between
`0x6e8cbc0` and `0x6e8dbc0`; neither address is resolved here. Its reported
application-file verification hashes a file with SHA-256, encodes the digest as
lowercase hexadecimal ASCII and verifies RSA-PSS using SHA-256. This is not
established as an SSO `extra` operation or a packet-signing algorithm. See
[QQ_SIGNATURE_RESEARCH.md](./QQ_SIGNATURE_RESEARCH.md) for the archive's scope
and the independent synthetic verifier's limits.

A complete inventory of this ELF's 885 defined default/protected dynamic exports contains no symbol whose
value equals `0x6613200` or `0x66137b0` (REA evidence
`ev_6829f3d51f172faae17c5de300ab034d8496bae4e5913bea953c39d2f68b7722`).
This does not rule out local/hidden symbols, indirect calls, bindings or code in
other modules. REA's exact export-table projection for this digest reports
`MSF::MSFSDK::notifyRefreshSign` at `0x670e760` with declared size 808 and
`MSF::MSFSDK::clearSign` at `0x670eba0` with declared size 299 (Evidence
`ev_7c15e1adeefdfaebda06707a851ea1e3745061fe60525dfa0d30340a98e48691`).
Declared symbol sizes do not establish complete code boundaries or execution.
In separate bounded instruction windows, those exports both obtain a receiver
from global `0x9178fa8` and call its virtual slot `+0x28`; neither inspected
window directly calls `0x6613200` or `0x66137b0`. The export-table inspection
did not revalidate those instruction windows. Their relationship to the object
returned by `0x6613810` is still unknown, as are the dispatch targets and signing
algorithm.
The two constructed objects have separate virtual-table address points at
`0x902c6c8` and `0x902c7c8`; ELF relative relocations put `0x6713850` and
`0x6713c00` in their respective `+0x30` slots. Local instruction windows make
these slots candidate execution methods, not observed runtime calls. Both load
a receiver from global `0x9177e20`; their inspected callees did not establish a
connection to the signer setter. In one inspected path, `0x6713850` passes that
receiver and fields of its current object to `0x67252d0`. If the call returns
normally, it loads a receiver from a different global slot, `0x9177dd0`, and
indirectly tail-calls that receiver's virtual slot `+0x10` without a local null
check. The other inspected method, `0x6713c00`, eventually loads the first global
receiver and tail-calls `0x6725530`. Another bounded path at `0x6712410`
first calls virtual slot `+0` on the object in `0x9177dd0` without a local null
check; normal return and a valid initial object are prerequisites. It then loads
a receiver from a separate global slot, `0x9177de0`, and re-reads `0x9177dd0`;
the initial virtual call could have changed either value. If the re-read object
is non-null, two separate conditional calls to `0x35b6ec0` can produce two local
pointer/control pairs. Each successful branch separately reads `0x9177dd8` as
its control pointer. The path passes both pairs, which may be empty, to virtual
slot `+0` of the `0x9177de0` receiver without a local null check. A different
bounded window at `0x670d682` calls `0x67116e0` with a stack output. On the
inspected normal-return path, that helper allocates `0x278` bytes at `B`, calls
`0x673f160` with `B+0x18`, and writes the pair `(B+0x18, B)` to that output.
The caller loads the pair, clears the stack source, saves the old control pointer,
and writes 16 bytes to global `0x9177dd0/8` with one `movups` instruction.
If the old control pointer is non-null, a subsequent `lock xadd -1` tests its
old count; old zero enters its virtual cleanup and release path. This is not a
claim that the 16-byte write is atomic. Separately, the bounded function at
`0x675a330` returns immediately when its input's `+0x68` is zero. Otherwise it
walks a `+0x60` pointer chain, calling `0x8e10050` per node, clears that field,
zeroes `+0x58` eight-byte slots at the `+0x50` base, and clears `+0x68`.
The inspected window does not free the slot array or establish a status return.
The observations require valid pointers, a finite chain, valid array bounds,
normal returns and no interfering mutations; they do not establish runtime
reachability or a protocol operation. The globals' business meanings and any
connection to the signer pair remain unknown. The dispatch receiver's `+0x28`
and the constructed objects' `+0x30` slots
belong to different objects. The inspected candidate paths both access the
`0x9177e20` receiver's `+0x30` and call `0x6725fb0`;
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
substituted for the archive entries. In the inspected `major.node`, the exported
`Init` function statically registers a `load` property using the exported `Load`
callback. A separate exported `LoadInternal` searches a symbolically named
`map_for_bytecode` by exact name bytes and can return a pointer and length; this
observation alone does not identify the stored format or prove which resources
are loaded at runtime. No path from the plaintext launchers to `wrapper.node` or
the signing-manager setter has been established. This is a bounded static
result, not proof that no such path exists.

The same outbound path builds the business buffer by a direct call at
`0x666794d` to `0x6667fa0`, not another virtual-table slot. A bounded
backtrace identifies a direct call at `0x6664434` through thunk `0x66672f0` to
`0x66678b0`; at that call site the request is a caller-owned stack object. Its
body pointer and length correspond to `rsp+0xe0` and `rsp+0xe8` at that point.
In the inspected caller, `0x6664347–0x6664367` obtains a vector-like pair via
`T = [rbp]` and `V = [T+0x20]`, copies `[V]` into the request body pointer,
and stores the low 32 bits of `[V+8] - [V]` as its length. Independently,
`0x6663d13` obtains `P` via the `+0x10` vtable slot of `U = [Q+0x10]`;
`0x6663d2c` then calls its `+0x18` slot with `(U, P)` before the subsequent
`T = [P]`, `V = [T+0x20]` span access. The concrete implementation of `U` and
whether that second call modifies `P` remain unknown. A selector at `T+0x28`
passes through `0x6664830`, yielding `0x0c`, `0x0d`, `0x14` or `0x15` for
`P+0xc8`; its business meaning and any connection to wt commands are unproved.
Separately, `0x6662f70` stores its second argument at `[rdi+0x10]` and, when
that argument is nonzero, transfers control to `0x6662f80`. Bounded continuous
instruction decoding independently confirmed direct calls at `0x665b27c` and
`0x665b59a`. Assuming the preceding calls return normally and preserve
callee-saved registers under the x86-64 System V ABI, both take the first
argument from the receiver's `+0x60`; the former passes zero as the second
argument and the latter passes the receiver itself. If that first argument is
`Q`, the latter stores the receiver into `Q+0x10` at that point; subsequent
changes are not excluded. Three further calls at `0x665b6a8`, `0x665b727`, and
`0x665bd1f` were decoded in a separate bounded pass with the same receiver and
`+0x60` pattern; their complete enclosing function boundaries were not established.

At `0x665b130–0x665b137`, code writes the address `0x902aa80` to an object's
first word. For this static vptr address point, independently checked ELF
`R_X86_64_RELATIVE` relocations at `0x902aa90` and `0x902aa98` have addends
`0x665d870` and `0x665d9f0` respectively. The corresponding on-disk words are
zero; the relocated values are load bias plus the respective addends, not those
on-disk words.
The `0x665d870` path can return a value read from the receiver's `+0x58`, while
`0x665d9f0` reads that field and another field of its second argument. Calls
within these paths may change state. The static assignment does not prove the
receiver still has that vptr at the setter, that either virtual call actually
uses these entries, or that the `+0x58` value remains equal to the earlier `P`.
The concrete receiver type, business body and actual command remain unknown;
nearby `AsyncRunLoop` diagnostics do not establish the type.

Separately, bounded decoding of `0x665cc80` identifies a candidate queue-write
path. Assuming intervening calls return normally and preserve the relevant
callee-saved registers under the x86-64 System V ABI, its second argument is a
pointer slot. At `0x665ccf8–0x665cd06`, an initial slot value `P1` is used to
read `T1=[P1]`, `V1=[T1+0x20]`, and the 64-bit difference `[V1+8]-[V1]`.
On one later branch, `0x665ce44–0x665ce55` rereads the slot as `P2`, clears
the slot, writes `P2` into a segmented queue position derived from receiver
fields `+0x18`, `+0x30` and `+0x38`, and increments the count at `+0x38`.
When the capacity branch invokes its helper, those queue fields are reloaded
before recomputing the position. The intervening calls or aliasing could change
the slot, so the two reads do not prove `P1 == P2`, nor do they prove either is
the `P` denoted in the separate `0x6663d13`/`0x6663d2c` path. Pointer validity,
arithmetic overflow, synchronization, dynamic reachability and the source or
contents of the body remain unverified.

A separately decoded caller at `0x665ca70` eventually calls `0x665cc80` at
`0x665cc0f`. It passes `0xe0` in `edi` to `0x8e10060` and retains that call's
return as `R`; the callee's allocation semantics are not established by this
observation alone. After an indirect call at `0x665cb64`, it reads the current
value `T2` from a slot addressed by the caller's entry `rdx`, clears that slot,
and writes `T2` to `[R]`. Following additional calls, it places `R` into a
local slot and passes that slot's address to `0x665cc80`. These observations
assume preceding calls return normally and preserve the relevant callee-saved
registers under the System V ABI. They do not prove the slot's contents before
the indirect call, that later calls leave `[R]` unchanged, or that the callee's
separate `P1` and `P2` reads both equal `R`. One additional bounded pass found a
similar direct call at `0x665d325` from the `0x665d160` entry, transferring a
current value from a slot addressed by entry `rcx` into a call return before
passing that return in a local slot. Within the scanned virtual-address interval
`[0x665b120,0x665df80)`, a raw search found no `E8 rel32` candidates targeting
`0x665ca70`; this does not exclude indirect calls, callers outside the interval,
or other modules. The construction and contents of `T2` remain unknown.

An independently decoded wrapper beginning at `0x6639cd0` directly calls
`0x665ca70` at `0x6639d55`. Under the same normal-return and System V ABI
assumptions, it reads the current contents `T0` of the slot addressed by its
entry `rdx` at `0x6639cfb`, clears that source slot, and stores `T0` in a local
slot. An earlier direct call precedes that read, and an indirect call at
`0x6639d26` precedes passing the local slot's address in `rdx` to `0x665ca70`.
Those calls or aliases may modify relevant memory; the evidence does not prove
that `T0` equals `T2` at the callee's later read, or identify how either value
was constructed. A single bounded pass also decoded a similar transfer from a
slot addressed by entry `rcx` in a separate wrapper at `0x6639e10`, calling
`0x665d160` at `0x6639eae`; that second wrapper has not been independently
checked.

On one independently decoded branch of the `0x663c090` entry, after preceding
calls return and a helper result is zero, `0x663c1ff` reads a slot at `A+0x28`
where `A` is the entry `rdi`. The path clears that source slot and stores the
read value in a local slot; after an indirect callback at `0x663c232`, it passes
the local slot's address in `rdx` to `0x6639cd0` at `0x663c270`. Normal-return
and System V callee-saved register assumptions apply. In particular, the
receiver passed to this call is a register value loaded from `[A]` earlier, not
a fresh read of `[A]` at the call. Intervening calls or aliases may modify the
source slot, local slot, or receiver's fields; the value read from `A+0x28` is
not established as `T0` or `T2` at their later reads. A bounded examination of
the 357,420 entries in the ELF dynamic RELA table found no type-8 addend equal
to either `0x663c090` or `0x663c7d0`; it does not cover other relocation types,
tables or indirect references. Other branches, object construction and the body
producer remain unresolved.

One independently decoded caller at `0x663c050` stores its entry `rdi` and
`rsi` as local values `p0` and `n0`, passes their slot addresses to
`0x35a6d20` in `rdx` and `rcx`, and supplies `0x10` in `edi` and `0x90` in
`esi`. If that helper returns normally, the caller immediately passes its
`rax` to `0x663c090` at `0x663c07a`, without a null check. For these arguments,
the helper's decoded instructions first reject unsigned `n0 < 0x90`; otherwise
they compute `aligned=(p0+15)&~15` and `delta=aligned-p0` with 64-bit modular
arithmetic, rejecting unsigned `delta > n0-0x90`. On the remaining branch they
write `aligned` to the `p0` slot, write `n0-delta` to the `n0` slot, and return
`aligned`. The two rejecting branches return zero without writing either slot;
a computed `aligned` value of zero is also possible and does not alone identify
the branch. This is alignment and available-space arithmetic, not evidence of
allocation or construction. It does not directly write `[aligned+0x28]`, though
aliasing with the local slots is not excluded. The input values' validity,
actual object lifetime, and any previous initialization remain unknown.

A separate, independently decoded branch of `0x663bf10` calls `0x35a6d20`
twice and denotes the returned values here as `D` and `N`. When `N` is nonzero,
it stores function addresses `0x663bf10` and `0x663c050` into two words of an
entry-supplied container `C`, then calls `0x663c4d0` with `rdi=N`, `rsi=D`.
Assuming the preceding calls return normally, preserve the required System V
callee-saved registers, and relevant memory accesses complete, the called routine
first copies or clears other fields;
at `0x663c509–0x663c515` it reads `[D+0x28]`, writes zero to that address,
and writes the read value to `[N+0x28]`. Earlier writes in the same routine or
the caller may alias those addresses, so this describes ordered operations rather
than an unconditional final source or destination state. A later indirect call
may also change state. The evidence does not establish that this function-pointer
container is invoked, that `N` is the `A` independently computed by
`0x663c050`, or that the transferred value is a protocol body. The `N=0` branch
chooses other function addresses and is not covered by this nonzero-branch claim.

The `0x663c158` and `0x663c232` call sites both pass `esi=0`, `rcx=0x10`, and
`r9=0x10` to an indirect target read from the current receiver's `+0x80`; the
actual target is unknown. In the conditional case where that target is
`0x663bf10` and the inspected instructions and memory accesses complete
normally, the zero-index jump-table entry selects its `0x663bf81` branch.
Both calls to `0x35a6d20` then receive `0x10` as the available-space value and
`0x90` as the requested size, so both take its unsigned-borrow zero-return
branch. The second result `N` is therefore zero and the resulting branch writes
`0x663c4c0`, not `0x663c050`, to the container's `+8` slot at `0x663c024`.
This conditional observation corrects any inference that those parameters
select the nonzero-`N` branch; it does not establish the real indirect target,
final slot contents after later calls or aliases, runtime reachability, or the
behavior at other call sites.

Returning to the separately inspected `0x6663d13` path, a conditional branch
also passes its `T` to classifier `0x6667140`, and another call copies it into
request `+0x28`. The source object was returned by a prior virtual
call; its construction, the actual command on this path and the body semantics
remain unknown. The helper reads
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
against a local collection. A bounded recheck shows that the lookup key is the
second decoded head string (`field2`, stored at head `+0x28`), not a string from
the separately parsed reserve output. The collection lookup compares string
length and bytes. Only if it succeeds and at least five bytes remain after the
declared head does the caller skip four bytes before decoding the business
wrapper. The skipped bytes are not checked on this branch. The collection's
origin, complete reserve wire types and business meaning are not established;
the conditional offset must not be inferred from synthetic headers. Bounded
inspection of the reserve parser also shows presence checks using API indices
9, 22, 23 and 25 and nested extraction. Further bounded inspection establishes
that these indices compare against `tag >> 3` keys in the same underlying
object's field table; this maps the observed indices to field numbers, but does
not establish a complete protobuf wire schema. For index 23, an empty retrieved
array takes a failure path; a nonempty array whose child conversion fails can
instead continue without updating the corresponding output. These distinctions
are not yet implemented as a faithful reserve parser. A later bounded trace
resolves the nonempty-vector parser entry to `0x8b54360`; its dispatch at
`0x8b54480` separates a tag into `tag & 7` and `tag >> 3` before a wire-index
jump table. In the inspected branches, wire indices 0, 1 and 5 forward
`tag >> 3` to a numeric-storage lookup; index 2 forwards it to a separate
function. Follow-up inspection of the constructor and the parser's eight-byte
`this` adjustment shows that their storage and the API presence lookup refer to
the same field table. The observed tag bytes `48` and `c8 01` identify wire-0
fields 9 and 25; one-byte values `00..7f` take the direct value path. For a
single new field with a complete canonical wire-0 value up to `0xffffffff`,
the inspected multi-byte reader yields that value, and the numeric setter's
internal ZigZag encoding is reversed by the field getter, yielding its low 32
bits. The wire value itself is not ZigZag-encoded. Field 9 writes output `+0`,
while field 25 writes `+0x50` and sets a presence flag at `+0x54`. This is a
bit pattern, not a determination of business signedness. Complete parser
behavior, repeated values and other wire types remain unverified.

The decrypt caller bypasses `0x666c5a0` for selector 0. Inside that function,
selector 1 takes a primary 16-byte candidate from one context object's `+0x78`;
an absent primary immediately fails. If a secondary candidate exists at another
object's `+0x78`, the caller retries only when the first decrypt call's return
low byte is not `1`. The final result check tests for nonzero; the inspected
success and failure exits of `0x8835ea0` return low bytes `1` and `0`
respectively. The two calls reuse the same output buffer and length variable:
`0x8835fcb` can update that length before a later framing or trailer failure,
and the second call's capacity check uses the retained value. The failed first
call may also have written part of the buffer; the inspected successful second
path overwrites every byte in its resulting valid prefix, assuming normal
non-aliased memory access. The later nonempty-output check is not a retry
condition: a first call that succeeds with an empty output is rejected by the
outer caller without a secondary attempt. Selector 2 references the same fixed
data location as the outbound class-2 branch and has no secondary candidate.
Other values fail in the callee. The selected decrypt routine checks a minimum
16-byte, eight-byte-aligned input and seven trailing zero bytes. These observations
neither identify the objects or key lifecycle nor prove that outbound classifier
and response selector always correspond. QQ-TEA framing checks are not server authentication, and static
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
A subsequent bounded inspection of the `DecodeData` candidate at `0x34f9710`
shows the primary decoder receives a pointer from receiver `+0x18`; receiver
byte `+4` can bypass it, and a fallback calls the same decoder with an embedded
address at receiver `+7`. The candidate constructor at `0x34f8af0` passes the
`+0x18` output to mode-dependent routines. One mode reaches `0x34f7740`, where
`0x2c7` is passed to `0x8d6f790` near a secp192k1 diagnostic. The latter calls
`0x8d6a6f0`, whose bounded lookup compares IDs across a five-entry table. A
separate table initializer, if its intervening calls return without modifying
the table, writes ID `0x2c7` and a `NIST P-192` label to the first table entry;
the downstream lookup compares this ID. In the bounded initializer, the same
entry receives a 24-byte element length and parameter-table pointer at ELF VA
`0x126eae0`, assuming intervening initialization calls return without modifying
the entry. Independently checked static comparisons found its first three
24-byte slices, interpreted as big-endian integers, match the public `p`, `a`,
and `b` of secp192k1 and do not match prime192v1. The next three slices also
match the standard secp192k1 generator coordinates and order; the generator
comparison used a locally generated standard point, and the order was compared
with [SEC 2](https://www.secg.org/sec2-v2.pdf). The observed `0x8d47460`
import path supports the big-endian interpretation for the imported slices, and
`0x8d6a89e` passes the first three imported values to a virtual slot. The next
three slices also follow static point/order construction paths. A separate
bounded inspection identifies a candidate method that copies the first three
arguments into group-object fields, conditional on the inspected method table
being the one actually selected. These comparisons establish matching public
parameters in the file on this static branch, not the runtime table contents,
active methods, cofactor, peer point, key derivation or login reachability. The
`NIST P-192` label conflicts with the observed parameters and is not by itself
proof of the mathematical group. Function identities and input provenance remain
unproved.

On the inspected `0x34f7740` path, the entry `rsi` addresses a short-or-long
string-like object; its bytes and length are passed to `0x8bc0600`. For valid
ASCII hexadecimal digits, independently checked table entries and instructions
show pairs of characters combined into one byte, with output length
`floor(input length / 2)`; a final unpaired character is not processed. Invalid
character behavior and the input's origin or business meaning were not
established. The converted bytes are then passed to `0x8d76300` with a freshly
created point-like object and group reference. On its separately inspected
`0x04` prefix branch, `0x8d76150` derives a width `w` from the group and requires
length `1 + 2*w`, before passing each `w`-byte component to the current group
method at `+0x88` and then to `0x8d6cea0`. Other prefix paths and dynamic method
identity remain unknown. On the statically inspected success path, `0x8d6cea0`
copies the two converted components to a temporary object; afterward,
`0x8d76300` copies those two fields into the new wrapper at `+8` and `+0x50`,
and copies group `+0x140` to wrapper `+0x98`. This description assumes calls
return normally and relevant aliases do not change the copied values. The
setter's conditional arithmetic and comparison support an elliptic-curve-
equation check if the candidate field operations and group coefficients have
their inferred meanings. They do not establish the third field's value, complete
point representation, actual peer identity or runtime reachability.

Two bounded static entry paths supply that string-like input. When the selector
is `1`, `0x34f75e0` constructs a temporary string-like object from embedded
image data and calls `0x34f7740`. Two independent bounded reconstructions found
98 hexadecimal characters whose decoded point has the 49-byte uncompressed form,
passes a local secp192k1 point check and equals the reference public point in
`wt-ecdh.ts`; the point bytes are not reproduced here. The final two characters
come from an instruction immediate, so this does not conflict with the earlier
negative search for one contiguous full point. The comparison describes a
conditional static default, not the peer actually used by a live session or
proof of service compatibility. A separate selector-`1` branch at `0x34f8490`
forwards its `rcx` as `rsi` through
a tail jump. One observed caller, `0x34f8af0`, first reads a caller-supplied
pointer slot, writes zero to the slot and stores the read value at object
`+0x48`; on a nonnull path it passes the current stored pointer plus eight to
`0x34f8490`. The corresponding null-pointer path can select the embedded-data
constructor; a false result on the nonnull path instead reaches a separate
fallback. These are conditional instruction-level paths, not a complete caller
inventory: intervening calls, aliases, allocation failures and dynamic
state can affect the values. The transferred pointer's construction, the
embedded string's semantics, peer identity and runtime reachability remain
unknown.

In another independently checked static path, `0x8d70370` asks `0x8d5beb0` to
fill a scalar-like value with lower bound 1 and an upper bound obtained from
`group+0x10`. On the inspected group-initialization branch, that bound comes
from the sixth public parameter slice previously compared with the secp192k1
order. The inspected sampler masks candidates and rejects those outside its
bounds, with at most 99 fills; successful values satisfy `1 <= d < order`
under the selected initialization, comparison and normal-memory assumptions.
Its random-source branches and uniformity are not established. The same value is
stored through `context+0x10` and used both by a group-method `+0x40` path with
the group point and by the `0x8d34270` group-method `+0x38` path with the
imported point. A candidate table binds both to the same point-multiply-like
routine, conditional on that table being active and unchanged. This supports an
ECDH-like relationship but does not establish the actual peer identity or live
server acceptance.

On this bounded path, `0x34f7a74` calls `0x8d34270` with a stack buffer and
capacity `0x200`. Its return is tested only for zero; a nonzero return is
sign-extended and passed with the buffer to `0x8b46000`. On an inspected error
path, if the call to `0x8d35840` returns normally, `0x8d34270` returns `-1`,
which that test does not exclude; this static observation does not establish
that the error path reaches the call at runtime
or predict its consequences. Separately, the inspected candidate method-table
initializer assigns `0x8d78860`, `0x8d90350`, and `0x8d70d20` to slots
`+0x38`, `+0x18`, and `+0x80` respectively. A subsequent bounded trace links
this initializer to the `0x2c7` registration on the inspected normal path; it
still assumes that intervening calls and aliases do not alter the selected table.
The first contains scalar-bit selection and point-like operations; the second
has a first-output path compatible with coordinate conversion; and the third
performs a conversion followed by a group-width byte export. Its scalar path
reverses bytes, while other inspected paths use SIMD blocks.
A separately checked instruction sequence in `0x8d90350` tests whether the raw
limbs at point `+0x90` are nonzero, computes a fixed-width candidate `m-2`, and
passes that value and those limbs to `0x8d4e390`. It then passes the result twice
to `0x8d4e950`; when the first output pointer is nonnull, it passes that
intermediate and point `+0` to the same helper, writing to the first output.
When the second output pointer is nonnull, it combines the intermediate with
the first helper's result and then combines that value with point `+0x48`, using
the same helper and writing to the second output. These data dependencies
assume the helper calls return normally and do not have value-changing aliases;
the nonzero limb test alone establishes neither point validity nor invertibility.
The inspected helper structure suggests exponentiation and modular arithmetic;
their complete mathematical equivalence remains unproved. A later inspection
traced the same method's first output through point encoding and the second
output to the parity bit of the compressed-point prefix, supporting the first
output's identification as affine X. The registered group modulus has 192
significant bits, and the observed export on this method table writes a
fixed-width 24-byte big-endian value, including leading zeroes. A second
inspection independently checked the width and export ordering but did not
independently complete the coordinate-identification proof. Under normal
successful arithmetic, unchanged table/parameters, valid memory and the same
peer and scalar, this supports the interpretation of the returned bytes as
fixed-width shared X; it is not a runtime observation or a formal proof of
every field operation. `0x8b46000` produces 16 bytes using an update and
finalization path. One bounded
static symbolic inspection compared all 64 compression steps with
[RFC 1321](https://www.rfc-editor.org/rfc/rfc1321): message-word indices,
Boolean expressions, constants, rotations, state flow, and final feed-forward
matched. A separate inspection independently checked the 64 rotations, found
corresponding constants in their rotation-delimited instruction windows, and
checked eight round-boundary steps, initialization, block handling, padding,
length encoding, and little-endian output; it did not independently trace the
other 56 steps' Boolean and message-word data flow. Under valid-memory,
normal-return and non-destructive-alias assumptions, these observations
support MD5 on the inspected well-formed path; they are not a formal proof or an
observation of
runtime execution. On the inspected successful null-callback path, the caller
passes the fixed-width 24-byte candidate described above to this helper; its
identification as ECDH shared X depends on the stated table, point and arithmetic
assumptions. Actual key and peer-point provenance remain unverified.
The disassembler automatically displayed an
annotation that may contain a hardcoded public-key string; its value was not
retained in this record.
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

- `src/direct/target-qr31-body.ts` implements the observed QR31 body skeleton
  using explicitly supplied offset-named fields and already-encoded child
  outputs. `field80` is never inferred from child count; the caller supplies
  actual child encodings in the desired traversal order. The 65535-byte limit
  applies locally to each prefixed field and each supplied child, including its
  tag and length bytes, with separate local limits of 4096 children and 16 MiB
  output. A standalone child encoder's maximum value can consequently exceed
  the body encoder's child limit. The limits do not bound peak memory or the
  cost of scanning caller-object metadata. This is a partial body
  encoder, not a verified QR login, target-session implementation or proof of
  wire interoperability.
- `src/direct/target-qr31-tlv.ts` writes individually observed QR31 child
  encodings for tags `0x11`, `0x16`, `0x1b`, `0x1d`, `0x33`, `0x35` and
  `0x66`; each output includes its own BE16 tag and value-length prefix. The
  `0x16` and `0x33` helpers constrain their opaque byte vectors to the inspected
  16-byte construction path; larger or different paths remain unmodeled. The
  `0x11` inclusion condition and all unknown field contents are caller-owned.
  Size rejection is stricter than the observed native low-16-bit behavior.
- `src/direct/target-qr31-frame.ts` wraps a supplied body using the observed
  zero-initialized QR31 construction path. Its fixed header, inclusive BE16
  total length and `0x03` trailer are local encodings of that static path, not
  proof of a target login session. It rejects frames larger than 65535 bytes;
  the target writes the low 16 bits. Byte-view prototype chains are limited to
  256 examined objects as a local resource policy.
- `src/direct/target-qr31-get-picture.ts` composes the observed new-tree
  picture-request branch from explicitly supplied context fields and bytes,
  including the optional `0x11` presence decision, seven fixed child types,
  their ascending order, and the locally encoded frame and channel wrapper. It
  assumes successful unique inserts and child writes; it does not connect,
  choose server keys, sign, create an authenticated session or prove QQ login.
  The input byte cap does not bound the cost of scanning arbitrary attached
  object metadata; cleanup of temporary buffers is best effort.
- `src/direct/target-qr31-channel-wrapper.ts` wraps an explicit inner byte
  sequence with the observed QR31 picture-request channel envelope. Both
  caller-context words remain explicit inputs. Its BE16 length is the inner
  length plus four, not the resulting buffer's length; rejecting a value above
  65535 is a local policy. Composing it with the local QR31 frame encoder limits
  the frame body to 65487 bytes, four fewer than the frame encoder's standalone
  maximum. It does not establish the final SSO command or network authentication.
- `src/direct/target-qr31-d1.ts` uses the real Proton codec to build the D1
  nested message and its TLV wrapper from two caller-provided raw byte fields.
  It explicitly retains both fields when empty. The target's empty-field wire
  behavior is supported by one static analysis, not independent runtime proof;
  the older reference string codec omits empty strings and is not substituted.
- `src/direct/target-qr31-response.ts` strictly extracts the observed QR31
  response field boundaries from a caller-delimited slice. It keeps raw bytes,
  numeric status, repeated tags and zero-length values, and distinguishes an
  unchanged zero-length string destination from a nonzero C-string projection.
  It does not run the target tag factory or child decoders, infer status meanings,
  authenticate a peer, or prove the target accepts the extracted result. Its
  exact-consumption, 16 MiB and 4096-entry restrictions are local policies.
- `src/direct/target-qr12-body.ts` writes the observed QR12 request-body
  fields, including the trailing array of BE16 values. Its query helper selects
  the inspected caller's empty and zero fields and takes the remaining two
  numbers and opaque span explicitly. Three span limits of 65535 bytes, an
  array limit of 4096 and a 16 MiB aggregate check are local policies. Under
  these component limits the largest constructible body is 204818 bytes;
  metadata enumeration and peak memory are not bounded by the output cap.
- `src/direct/target-qr12-frame.ts` wraps a supplied body in the inspected
  zero-initialized QR12 frame structure, reusing the corresponding QR31 frame
  encoder with a different command. Its inclusive-length overflow rejection is
  a local policy; it does not authenticate or send the request.
- `src/direct/target-qr12-query.ts` composes the selected QR12 body, frame and
  the same observed channel wrapper from an explicit context word, 64-bit word,
  raw span and runtime word. Its cross-layer span limit of 65466 bytes is a
  local policy, not a target limit; input metadata enumeration and peak memory
  are not bounded by the output limit. It does not send or authenticate a query.
- `src/direct/target-qr12-selected.ts` projects the last raw values for tags
  `0x18`, `0x19`, `0x1e`, `0x65` and `0x3f` from a strictly extracted
  status-zero response, distinguishing a missing tag from a present empty value.
  It does not execute the native tag factory or other child decoders, infer
  ticket meanings, or establish that the server or target accepts the response.
- `src/direct/target-qr12-response.ts` separately extracts the QR12 prefix,
  status, BE64 and BE32 words, and raw TLV boundaries from an exact slice. It
  requires complete fields for every status, unlike the inspected target's
  nonzero-status short-read branch. It does not run tag factories or child
  decoders, interpret status, verify a peer or establish login.
- `src/direct/target-qr-wt-candidate.ts` composes an explicit QR channel byte
  sequence with local QQ-TEA, the observed conditional WT data wrapper and the
  target OICQ header. Its mode-1 choices describe only the inspected new-owner
  path and its documented conditions; keys, extra bytes and random bytes are
  supplied by the caller. It neither signs nor sends an SSO request, and the
  result is not proof of a valid QR login.
- `src/direct/target-wt-inner-writer-candidate.ts` prefixes four explicitly
  supplied opaque writer outputs with `BE16(4)` and concatenates them in caller
  order. It models only the recorded four-object normal-success writer sequence
  at `0x3469090` and `0x3468660`; the inputs are caller assertions, not verified
  node encodings or four established TLVs. Empty fragments are a local simulation
  choice. The 16 MiB aggregate limit, copying and unsafe-view rejection are local
  policies, not target limits. Inputs must remain stable until snapshotted; the
  output belongs to the caller and cleanup is best effort. This helper does not
  invoke target writers, encrypt, sign, send, authenticate or establish login.
- `src/direct/target-wt-inner-encrypted-candidate.ts` composes the four-writer
  candidate with local QQ-TEA and an explicitly supplied key and random source.
  Its output is only a local conditional candidate, not a discovered key, a
  signature or proof that the target produces identical ciphertext.
- `src/direct/target-wt-login-node.ts` encodes the observed normal-success node
  forms `0x0106`, `0x016a`, `0x0318`, `0x0144` and `0x016e` from explicitly supplied raw bytes.
  A node includes its BE16 tag and BE16 value length but no entry count. Its
  per-value limit is a local policy; a later enclosing frame may impose a smaller
  bound. This does not establish that any node is sent in a login request.
- `src/direct/target-wt-node-0124-candidate.ts` models the selected `0x0124`
  writer's four explicit raw byte strings and 16-bit word on its normal-success
  path. Its range checks are local policy, and it does not discover field
  identities or claim the target supplied any particular values.
- `src/direct/target-wt-node-0147-candidate.ts` and
  `src/direct/target-wt-node-0128-candidate.ts` model the inspected inner-node
  writers from explicitly supplied values. The former truncates both strings to
  32 bytes as observed; the latter rejects oversize values as local policy.
- `src/direct/target-machine-guid-digest-candidate.ts` models one nonempty
  processed-byte digest branch with a local MD5 candidate. It neither reads
  host identity files nor models target fallback or interface discovery.
- `src/direct/target-wt-tgtgt-key-candidate.ts` is a bounded MD5-based candidate
  for the separately inspected `0x3504ca0` derivation, not a verified SSO signer
  or proof that any supplied input matches the target.
- `src/direct/target-wt-tgtgt-plain-candidate.ts` models the examined `0x3504d80`
  normal-success plaintext sequence from explicit raw fields; the matching
  `target-wt-tgtgt-encrypted-candidate.ts` composes that sequence, the key
  candidate and local QQ-TEA. Their length and failure rules are local policies;
  neither establishes target equivalence or live login.
- `src/direct/target-wt-local-data.ts` additionally composes the existing local
  QQ-TEA encoder with that field layout using explicit caller-supplied key,
  plaintext and padding bytes. It does not model the target's random generator
  or automatically choose a QR key. In its `ctx5=0` branch the supplied
  `local16` is both the encryption key and part of the returned bytes. The
  underlying encoder retains internal key-word and padded-plaintext allocations
  that this wrapper cannot wipe; its temporary-buffer cleanup is best effort.
- `src/direct/target-wt-encode-data.ts` serializes the observed conditional
  `0x34f9170` field layout from an explicit precomputed payload. It does not
  perform encryption or infer which branch a QR session uses; its stricter
  component and total limits, and its rejection of nonempty data in observed
  empty branches, are local policies. `src/direct/target-wt-oicq.ts` wraps an
  explicit opaque result using the target's 25-byte OICQ header, supplied
  version, command, sequence, account bits and context words. Neither helper
  obtains keys, signs packets, authenticates a response or opens a connection.
- `src/direct/target-sso12-reserve.ts` uses Proton to encode a constrained
  subset of the target's statically observed reserve fields. It preserves empty
  values where the observed path has presence flags and returns an empty buffer
  when only fields 12 and/or 23 are supplied. Field 23 is a repeated child message
  with two explicitly present byte fields, including empty values; collection
  order is preserved. The local policy limits that collection to 4096 records
  and rejects sparse arrays, accessors and shared buffers.
  Fields 13, 15 and 16 retain explicitly present empty bytes, field 26 retains
  an explicitly present zero, and field 24 is emitted only if a child is nonempty.
  Enabling field 21 writes the observed constant 32. The additive
  `encodeTargetSso12ReserveFromNativeSlots` helper accepts caller-supplied raw
  bytes for the observed `+0x00`, `+0x18` and `+0x30` string-like result slots
  and maps them to field-24 children 2, 3 and 1 respectively. It does not read a
  native object, implement a signer, choose a command or establish runtime field
  semantics. `decodeTargetMsfSignOutput` separately models the observed successful
  768-byte callback output: a caller supplies status zero and a byte snapshot;
  lengths at `0xff`, `0x1ff` and `0x2ff` select contents at `0x00`, `0x100`
  and `0x200`. The three returned copies can be supplied to the slot encoder.
  It does not call the callback or obtain native memory, and a caller-provided
  buffer is not evidence that the target produced it. The `GetSignInfo` length
  labels discussed above are candidates; neither encoder is a complete model of
  the target reserve.
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
- `src/direct/target-sso12-numeric-reserve.ts` provides a local, strict candidate
  for an empty reserve or a reserve consisting only of single wire-0 fields 9
  and/or 25 with canonical unsigned values `0..0xffffffff`. Its result distinguishes
  an absent field from an explicitly encoded zero; an absent field means no
  observed update, not a known native default. Rejecting duplicates, unknown
  fields, noncanonical or larger values, and other wire types is a local policy,
  not a claim that the
  target rejects them. Simultaneous fields 9 and 25 in either order are local
  synthetic cases: target-static evidence covers one new field at a time. Explicit
  opt-in to the lookup pipeline uses this candidate; it does not establish native
  acceptance or QQ interoperability.
- `src/direct/target-sso12-lookup.ts` provides the observed bytewise `field2`
  collection match and the conditional zero-or-four-byte skip decision. The
  caller supplies the collection and the number of bytes after the declared
  head, and remains responsible for their origin, their association with the
  same plaintext, and successful reserve parsing. A match with five to seven
  bytes remaining selects four but does not make the following wrapper valid.
  The count and aggregate-byte limits are local resource policies; the result
  does not authenticate a peer or prove full target compatibility.
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
- `src/direct/selector1-local-qqtea-residual-capacity-candidate.ts` exposes an
  explicit, standalone two-key **local QQ-TEA candidate**, not a target-native
  decoder or an authenticated response. It snapshots the primary key and
  ciphertext; only an explicit local framing failure permits it to inspect and
  snapshot a secondary key. A local early framing failure retains the original
  ciphertext length as the second attempt's capacity; a local later trailer
  failure uses the first attempt's computed plaintext length. Empty successful
  plaintext, insufficient second-attempt capacity and ordinary candidate
  validation failures terminate without another retry. Unexpected runtime
  exceptions are not interpreted as framing failures. These stage labels and
  capacities are local model choices; byte equivalence with the native routine
  has not been established. The secondary input must stay isolated until its
  deferred snapshot. The per-input 16 MiB limit is not a peak-memory or time
  bound, and synchronous decryption can allocate per block. The caller must
  independently verify the original frame and must not expose failure details,
  timing or key selection to a peer; padding is not authentication. Cleanup is
  best effort. This helper is not wired into the raw transaction or the live
  Bridge, and does not establish QQ interoperability.
- `composeTargetResponseCandidateWithSelector1LocalResidual` explicitly
  combines a private basic-frame snapshot, the standalone local two-key model
  and a single strict response transform. It accepts only selector 1, reads the
  secondary key only after a local framing failure, and does not retry because
  head, business framing or decompression failed. The caller must independently
  verify and isolate the exact supplied frame and keep keys stable until their
  respective snapshots. Returned values are unverified candidates; this path is
  neither a native-equivalence claim nor part of raw transport or live login.
  The per-view bounds do not bound aggregate memory, synchronous CPU time, or
  retained copies, and errors or timing must not be exposed to a peer.
- `src/direct/target-response-candidate.ts` composes the basic prefix, a single
  explicit-key decryption candidate and that bounded transform. The caller must
  independently verify and isolate the same frame bytes supplied to it; this
  composition does not establish authentication or request binding. Selector 0
  takes no key; selectors 1 and 2 each require one caller-provided key and do not
  fall back. The first basic word is preserved rather than treated as a frame
  length. Basic offsets refer to the supplied frame view; head and business
  offsets refer to the plaintext candidate, not the encrypted wire. Opaque basic
  data, head tail and post-business trailing bytes remain separate outputs. An
  additive `composeTargetResponseCandidateWithFinal` variant also reads the
  final word from the same private plaintext, before business transformation;
  it repeats the strict head parse and snapshot, so the per-view cap is not a
  peak-memory cap. A successful candidate necessarily has a complete business
  prefix and therefore a readable final word; the caller-supplied prior is
  observable only in shorter spans handled by the standalone final reader.
  The additive `composeTargetResponseCandidateWithLookup` variant performs the
  caller-supplied collection lookup on the same private decrypted candidate and
  applies its selected skip before transforming the body. By default it rejects
  nonempty reserve vectors and preserves the previous result shape. Passing the
  final argument `'numeric-candidate'` opts into strict numeric decoding of the
  reserve from that same private plaintext, returning `numericReserveCandidate`
  with `kind: 'numeric-reserve-candidate'` and `field9`/`field25` values or null
  when absent. In the TypeScript API, `numericReserveCandidate` is optional even
  when a literal opt-in is supplied, so consumers must check it before use. This
  is not a complete target reserve parser. The collection is
  validated and copied after decryption and head parsing, not at API entry; the
  caller remains responsible for input stability and peer trust. A synthetic
  loopback test composes the original explicit-skip candidate inside
  `transactRaw()` after a fixture verifier accepts its frame and publishes only after the transaction
  succeeds. On cancellation the test caller clears its staged result; the raw
  transport itself does not clear arbitrary values returned by a consumer. The
  loopback framing requires the first word to equal frame length, a local
  transport condition not established for the target's basic decoder. A separate
  synthetic loopback test connects the target-static request encoders to the
  raw transaction and empty-reserve lookup candidate; its fixture verification
  and local sequence assignment do not establish server authentication or
  target request/response binding.
- `src/direct/target-raw-transaction.ts` offers two experimental transaction
  entry points on a caller-supplied connected raw transport. `createSso12RawClient` constructs
  the shared raw engine without reference profile, key, signer or classifier
  options; its UIN is a caller-supplied 1–20-digit local identity label, not a
  verified account binding. The existing reference-mode `Sso12PacketClient`
  remains accepted. In raw-only mode, bytes
  arriving outside an active raw transaction close the connection rather than
  entering the reference decoder. The adapter snapshots caller inputs, encodes
  the target-static head, business and outer frame, uses the raw client's locally
  allocated sequence, and invokes the caller's raw verifier before
  decoding the response. The response selector, key and lookup collection are
  explicit caller inputs; `response.reserveMode: 'numeric-candidate'` explicitly
  selects the numeric candidate and otherwise only empty reserve is accepted.
  The verifier receives independent copies and must supply the trust policy. The
  adapter enforces one ordered build, verify and consume, compares raw UIN and
  uint32 sequence values across callbacks and the returned local sequence, and
  parses a private copy only after bytewise comparison with the private verified
  frame. Equal identity values in distinct objects, including inherited getters,
  remain accepted; each field is read once per callback. Repeated, concurrent or
  out-of-order callbacks poison the transaction even if the transport catches the
  error. Frame snapshots have a 16 MiB per-frame limit and increase peak memory;
  wiping owned snapshots is best effort. These local checks do not prove what an
  untrusted transport actually wrote, establish server authentication, or bind the
  target response sequence to the request. The caller must trust its transport's
  actual writes, deadlines and write-state reporting. A result is transferred only
  after the raw transaction succeeds; inconsistencies yield unknown write outcome
  and no automatic retry. The raw consumer now hands the transport an opaque
  frozen token rather than the parsed candidate; the final successful result still
  returns the candidate to the caller. Generic transports that pass their consumer
  value through unchanged, including the built-in client, remain compatible;
  custom transports that inspect or mutate that intermediate value must change.
  After the adapter observes transport settlement, late callbacks fail closed;
  promise settlement itself and its continuation are not an atomic boundary.
  Synchronous preparation
  counts against the required timeout but cannot be preempted. For the original
  `transactTargetRawOnce` entry, the head's input sequence is a placeholder
  replaced by the raw client's local sequence, while reserve bytes are prepared
  beforehand; that entry cannot construct a candidate from the newly assigned
  sequence. The raw
  client's inclusive-length framing remains a local constraint, not a proven
  target rule, and the adapter does not establish real QQ authentication,
  response binding, login or online state. Its encoder dependencies assume
  untampered JavaScript built-ins; cleanup is best effort and cannot erase engine
  or callback-owned copies.
- The separate opt-in `transactTargetRawCandidateReserveOnce` entry constructs a
  **caller-supplied candidate**, not a QQ signature. After its raw transport
  supplies a local uint32 sequence, it invokes `buildCandidate` with that value,
  the two distinct UIN labels and independent snapshots of the head command bytes
  and unprefixed raw body. The callback returns a status and 0x300-byte candidate
  output; the existing conditional output decoder and native-slot reserve encoder
  construct field 24 before the same local sequence is encoded in the head. It
  snapshots the head, body and reserve base, including inactive fields 12 and 23,
  before awaiting the callback, and rechecks the completed head and frame size.
  The 16 MiB aggregate input budget includes the 0x300-byte output; it is not a
  peak-memory bound. A supplied abort signal is propagated through a private
  `AbortSignal.any` dependent, while the original is checked at local boundaries.
  The caller must not modify the returned output until the transaction settles:
  even a synchronous return is observed after Promise/thenable assimilation, not
  as an atomic snapshot at the return statement. Caller-owned output remains
  untouched unless it aliases the callback's borrowed input, which is wiped best
  effort; retained copies and callback side effects remain outside that cleanup.
  Selected built-in changes are rejected, but this is not same-process isolation:
  built-ins and imported codecs are trusted throughout. Structural transports
  remain responsible for their writes, cancellation and settlement. Local fake
  tests exercise this data path without a target process or socket; they establish
  neither that the target's controller K equals the sequence nor the actual
  signing input, output, request/response binding or QQ acceptance.
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
  32-bit sequence pattern, and a copy of the SSO body captured before the trace
  and classification callbacks. Existing direct callers pass separate frame and
  signer-input buffers; a wrapper may still change inputs before builder entry.
  The same bounded copy, up to 16 MiB, is made for unsigned requests. Inputs
  must remain stable until read and copied; accessors, proxies, caller callbacks
  and their exceptions are not isolated. Concurrent changes to shared memory do
  not have an atomic-snapshot guarantee. Cross-realm byte views are rejected by
  the existing `instanceof` check; ordinary Buffers and same-realm Uint8Array
  subclasses remain accepted, but customized subclass iterators are not used.
  Signature fields are read once and independently copied using their actual
  typed-array lengths; a nonempty sign and the per-field limit are enforced on
  those copies. The signer must leave the callback request's own account, command,
  sequence and body view unchanged, with body bytes intact at validation points;
  lasting changes are rejected, including changes during signature-field getters.
  Register and send-text reference flows also check the callback UID before
  handing off a frame. This intentionally tightens the callback contract. The
  check cannot observe changes made and restored between checks, later changes,
  or the bytes actually used by a signer; it does not establish authenticity.
  Adapters targeting a signed-int32 API must preserve the sequence's bit pattern.
- `src/direct/lagrange-v2-milky-signer.ts` independently adapts that callback to
  the V2 Milky external signing-service contract using a caller-injected
  asynchronous transport, not an offline signing algorithm. Its JSON data contract
  follows the one observed
  in [LagrangeV2 Milky Signer at commit 7011cdf](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Milky/Utility/Signer.cs#L572-L660).
  Upstream authors retain their rights; no upstream implementation or command
  list is copied. Its transport receives a plain object with numeric `uin`,
  `command`, signed `seq`, lowercase hexadecimal `body` and `guid`, and `qua`.
  The caller supplies the transport and is responsible for any serialization,
  trust, timeouts, credentials and side effects. The module has no HTTP client,
  endpoint, token injection, signing algorithm or successful-result fallback.
  It does not inspect the upstream command whitelist; the reserve builder's
  caller still chooses the per-command classification. The reference DTO is
  neither a target-build observation nor evidence of interoperability.
  Local restrictions are stricter than the cited implementation: an account is
  bound at construction and must match each request, use canonical nonzero
  decimal spelling and not exceed `Number.MAX_SAFE_INTEGER`; there is no zero
  account fallback. A 16-byte GUID and a nonempty QUA are explicit profile
  inputs. Command and QUA are nonempty and at most 65536 UTF-8 bytes each; the
  body is at most 16 MiB and may be empty. An unsigned 32-bit sequence is mapped
  to the signed 32-bit integer with the same bits; negative zero is rejected.
  Configuration and request DTOs must be plain, non-proxy objects with data
  properties, including unknown own fields; their descriptor inspection rejects
  accessors without calling them. After transport resolution, response objects
  are checked by the same descriptor rule. Promise/thenable assimilation can read
  a returned object's `then` getter or proxy trap before that response check;
  transport execution and those effects belong to the caller's trust boundary.
  Byte inputs must be live, non-shared Uint8Array views;
  proxied or overly deep prototype chains are rejected. Inputs are snapshotted
  before transport invocation; callers must keep bytes stable until that point.
  The response must contain `code`, `message` (string up to 65536 UTF-8 bytes or
  null) and `value`; only integer code zero is accepted. The three required value
  fields `sec_sign`, `sec_token`, and `sec_extra` must be even-length ASCII hex,
  at most 65536 decoded bytes each. Uppercase is accepted; sign must be nonempty,
  while token and extra may be empty. Unknown data fields are ignored. Results
  are independent byte arrays. Fixed-stage errors omit transport exceptions and
  response messages to avoid forwarding secrets; no original exception cause is
  retained. These limits do not bound all engine allocations, arbitrary metadata
  enumeration, or any effects and retained copies owned by the injected transport.
  Pure fake-transport fixtures test the local mapping and actual reserve-builder
  composition; no server, signing, target client or online behavior is exercised.
- `src/direct/lagrange-v2-default-signer.ts` separately adapts the fixed V2
  [default PC provider contract](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Common/BotSignProvider.cs#L575-L617):
  the caller-injected transport receives only `cmd`, signed-int32 `seq` and
  uppercase hexadecimal `src`, and supplies `value.sign`, `value.token` and
  `value.extra` as hexadecimal strings. Unlike Milky, that DTO does not carry
  UIN, GUID or QUA. Account binding is nonetheless enforced locally; payloads
  and callbacks should not be treated as anonymous or isolated from their owner.
  This adapter makes no network request itself, chooses no endpoint or command
  policy, and implements no signing algorithm or retry. Its local contract is
  deliberately stricter than the reference: the account must be canonical and
  at most `Number.MAX_SAFE_INTEGER`, the command must be nonempty and at most
  65536 UTF-8 bytes, the body is bounded to 16 MiB, and negative zero sequences
  are rejected. Both response objects and all three fields must exist as plain
  data, each decoded field is limited to 65536 bytes, and sign must be nonempty;
  the reference's missing-field defaults and empty sign are not reproduced.
  Unknown data properties are ignored, but accessors and proxies are rejected;
  Promise assimilation and any transport effects remain the caller's responsibility.
  Fixed-stage errors omit external exception and response text. Immutable payload
  strings and copies retained by a transport cannot be erased by this adapter.
  This mapping and its fake-transport tests do not establish live interoperability.
- `src/direct/linux-qq-app-signature-verify.ts` implements the supplied research
  archive's reported Linux application-file verification formula using a caller-
  supplied RSA-2048 SPKI key: SHA-256 of data, lowercase hexadecimal ASCII, then
  RSA-PSS SHA-256 with a 32-byte salt. It accepts bytes only, performs no file or
  network access, and applies explicit local size and key round-trip restrictions.
  Its in-memory tests use synthetic keys; the archive did not contain the reported
  original target files and signatures for independent replay. This file verifier
  is not an implementation of SSO packet `sign`, `token` or `extra`; the supplied
  key is not authenticated merely by passing it to this function. The related
  `linux-qq-app-signature-check-envelope.ts` wraps caller-supplied opaque JCE
  bytes with the reported four-byte total-length prefix and returns reconstructed
  MSF fields as metadata; it does not serialize JCE or establish a wire format.
  Details and evidence limits are recorded in [QQ_SIGNATURE_RESEARCH.md](./QQ_SIGNATURE_RESEARCH.md).
- `src/direct/wt-login-keystore.ts` projects the UID from inner WT TLV `0x543`
  using the `9 → 11 → 1` message path declared by [LagrangeV2 ThirdPartyLoginResponse](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Packets/System/ThirdPartyLoginResponse.cs)
  and its [login handler](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Logic/WtExchangeLogic.cs).
  Absent TLV and present TLV with an absent or empty UID remain distinct; neither
  outcome establishes login or authentication. This is an independent partial
  projection, not a complete keystore or a target-build observation. Local limits
  include 1024 entries and 65535 total encoded bytes, with duplicate `0x543`,
  malformed UTF-8 and unsupported wire types rejected. Proton preserves a leading
  U+FEFF in protobuf string values, matching the statically inspected referenced
  .NET decoder's handling of UTF-8 BOM bytes. Local malformed-data handling remains
  intentionally stricter and is not asserted equivalent. Array
  slots and each entry's `tag` and `value` must be own data properties; proxied
  objects and shared, resizable, detached or out-of-bounds byte storage are
  rejected. Those checks
  assume ordinary untampered JavaScript intrinsics. The selected bytes are copied
  and the owned snapshot cleared best-effort; JavaScript UID strings and
  runtime-internal copies cannot be explicitly erased. Synthetic
  fixtures join WT decoding, this projection and reserve construction without
  logging in or connecting. The authors of LagrangeV2 retain their rights.
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
- `src/direct/target-wt-hex-point-candidate.ts` decodes a deliberately strict
  subset of the target's observed hexadecimal input path. The caller supplies a
  coordinate width from 1 to 256 bytes; the helper requires exactly `2*(1+2*w)`
  ASCII hexadecimal characters and an uncompressed `0x04` prefix. It rejects odd
  input even though the inspected native converter ignores an unpaired final
  character, and it rejects invalid hex without claiming to reproduce the
  native invalid-character behavior. The returned point bytes are a caller-owned
  format candidate, not evidence of curve membership, group selection, peer
  identity, authentication or target interoperability. No curve or peer key is
  selected automatically; the width and size limits are local policies.
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
  it aliases that input. The attempt tracks its own temporary byte arrays, including
  signer and verifier loans and locally decoded tickets. Local close, abort or
  failure revokes and best-effort wipes registered arrays even if a callback is
  still pending; that callback must not rely on a loan remaining intact afterwards.
  Late settlement triggers another best-effort wipe. A ticket result is transferred
  out of this tracking before final cleanup; if cleanup reenters close before
  delivery, the existing failure path wipes it afterwards, not necessarily before
  the reentrant close returns. The registry is local ownership bookkeeping, not
  isolation from arbitrary same-process mutation. Constructor failures, helper-internal
  buffers, detached loans, copies made by callbacks, strings and JS/crypto internals
  are outside this guarantee. Existing timeout checks do not force a noncooperative
  transport or callback to settle. These behaviors do not establish server authentication. The
  result does not mark online status or attach to Bridge. An optional
  `enableUidProjection` setting projects inner TLV `0x543` only after the caller's
  raw and context policies accept the response. It is disabled by default, so the
  original result shape and handling remain unchanged. When enabled, `tickets`
  results include `uidProjection`, distinguishing an absent TLV from a present
  empty UID; malformed selected data fails the attempt. The confirmed UIN and UID
  remain subject to the caller's identity and authentication policy, and the UID
  string cannot be reliably erased. The fake transport exercises the actual local
  codecs, but does not establish real transport or server behavior. The separate
  `createBorrowedWtReferenceLoginAttempt` accepts an owner-supplied raw session
  lease rather than a socket. Its QR fetch, poll and login share that lease and
  ECDH context; after a successful ticket result the owner can pass the lease and
  ticket data to borrowed registration. A synthetic test exercises this handoff
  with production codecs, not a live peer. The owner must retain exclusive lease
  control throughout the attempt and registration and provide trusted transport
  quiescence and response-verification policies. Attempt failure or in-flight
  close poisons the lease; successful completion and idle close leave it with the
  owner. `whenClosed` notification is asynchronous and is not a synchronous
  connection-state barrier; a foreign lease or owner that terminates it during
  the commit window can defeat that observation. JavaScript strings, crypto
  internals and copies retained by callbacks cannot be reliably erased. This is
  not yet wired into the application runtime or proof of V2/QQ interoperability.
  See the reference lifecycle notes below for other verification gaps.
- `src/direct/wt-reference-session.ts` composes borrowed QR login and registration
  as one local account owner on the same lease. Registration receives the confirmed
  UIN and nonempty UID projected from that attempt's accepted tickets, not a
  caller-supplied replacement. The UID is passed to an external reserve builder;
  the resulting opaque bytes do not prove UID inclusion or a valid signature.
  Successful local registration classification retains ticket material privately
  until close, cancellation or lease termination. Caller-driven `heartbeat()` and
  `alive()` use the same lease and confirmed account; heartbeat uses the retained
  credentials and reports an interval, missing interval or SSO error. Neither
  establishes online state. Transport failures and SSO errors poison the lease;
  a missing heartbeat interval remains distinct from zero and does not by itself
  poison it. `alive()` here is a post-registration manual subset: fixed V2 starts
  its separate Alive timer after connection, potentially before login. Idle close
  returns control of the lease to the caller. Caller-held aliases, callbacks,
  modified promise species and same-tick lease termination remain outside these
  local guarantees. No peer authentication, online state, QQ interoperability or
  Bridge integration is established by this owner. The existing socket-backed raw
  client remains single-request and may close on push. The separate multiplex
  client and its injected-stream adapter can be exercised with this owner, but
  are not yet connected to the application event pipeline.
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
  The verifier receives a copy of the complete request frame, whose service header
  can contain the D2 ticket. The injected transport likewise sees the wire frame.
  Both belong to the caller's trust boundary; wiping the provided copy cannot
  prevent them from retaining data. SSO header version and registration build
  version remain distinct. It closes the claimed socket and does not retry,
  mark the account online, authenticate
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
  The separate `referenceRegisterOnTransport` entry can borrow an existing raw
  transport without explicitly closing or awaiting it. It locally checks callback
  order, context, observed transport identity and sequence, verified response
  bytes, and the returned result token. The confirmed login UIN, which may differ
  from the transport's local UIN, is used for signing and envelope checks. This
  is still one registration transaction, not a combined login session: the
  transport owner must provide exclusivity, sequence allocation, accurate write
  status and quiescence before reuse. A local abort or deadline ends the borrowed
  call even when the transport does not settle; after invocation its write state is
  `unknown`. This local settlement does not stop transport effects or prove it is
  safe to reuse. A transport may stall indefinitely, close itself when the
  transaction signal is aborted, misreport effects or invoke late callbacks. The
  signal is transaction-scoped and may also be aborted during successful cleanup;
  it must not be treated as a connection-lifetime signal. Guard-owned copies can
  remain held by an uncooperative pending operation; local cleanup covers only
  reachable buffers owned by the registration flow. The guard cannot prove actual
  writes, server identity, signature authenticity or a physical session. Once
  invoked, transport failures use fixed result codes; locally detected pre-cancellation
  or expiry have separate codes, while invalid configuration rejects instead of
  returning a result. Absent a locally winning stop, a valid failure's write status
  remains the transport's claim; exceptions, invalid results and guard violations
  instead report `unknown`. A method getter
  can run even before options validation, and Promise/thenable assimilation can
  have effects; both belong to the caller's transport trust boundary.
  Bounded candidate copies and synchronous validation do not bound total memory,
  concurrency or timer latency. No retries are performed.
- `src/direct/guard-raw-transaction.ts` contains the single-transaction callback
  guard used by borrowed registration. Optional synchronous context and result
  disposers support future consumers: a result is transferred only after validation
  and context disposal succeed. The producer must keep their mutable storage
  separate, and remains responsible for allocations not returned to the guard,
  retained copies, and external callback effects. A never-settling transport is
  still an owner concern. A swallowed callback exception now conservatively
  reports an unknown write state rather than trusting a claimed `not-written`.
- `src/direct/raw-session-broker.ts` is an experimental local lease for one
  caller-supplied raw client. It retires the exact client object for that module
  instance, serializes lease transactions, and poisons on uncertain transport
  failure, expiry or cancellation. This cannot enforce exclusivity against direct
  client access, alternative wrappers or another module instance. The owner must
  provide a truthful synchronous usability check and a trusted successful-settlement
  quiescence contract; the broker does not authenticate the peer, verify callback
  ordering or prove writes. It accepts same-realm standard AbortSignals whose
  prototype and listener methods remain unchanged while in use. The broker samples
  local termination again after reading a client transaction method and before
  accepting a successful result; an already-terminated lease does not assimilate
  a foreign `whenClosed` thenable after its getter returns. Getter side effects and
  work already entered cannot be undone, Promise rejection observation is best
  effort, and asynchronous close observation is not a physical transport fence.
  Timers are not hard realtime and callback-owned late allocations require producer
  cleanup. The separate internal broker factory can issue a single-use proof that its own
  authority claimed the first local broker terminal transition for a particular
  lease before its sampled deadline and cancellation. It does not establish
  cleanup completion, peer identity, response authenticity or the order in which
  the underlying client closed: client closure can precede the broker's
  asynchronous observation. The injected WT multiplex composition uses this
  authority for terminal poll and non-ticket login handoff; its deep-importable
  interface is not an isolation boundary against other code in the process.
  Synthetic tests exercise both two registrations and a WT fetch/poll/login followed
  by registration through one lease and production codecs. The application runtime
  is not yet attached: an owner must keep the lease across login and registration,
  and explicitly poison it if an outer registration guard later rejects a result
  the transport had reported as successful.
- `src/direct/raw-multiplex-client.ts` is an in-memory, caller-fed raw client that
  separates explicitly classified push frames from single-flight responses. It
  bounds frame, pending-classification and push storage; its writer, classifier,
  push verifier and push handler are caller-provided. A response candidate waits
  for the writer to finish successfully before transaction verification and
  consumption; push handling can continue meanwhile. Push handlers are ordered
  relative to each other, but can run before an earlier response finishes its
  verification and consumption. An optional, synchronous `holdFollowingFrames`
  policy can instead hold later frames until a selected response's consumption
  finishes. The caller must stage required state during consumption, keep business
  delivery separately gated, and ensure its writer does not depend on a held frame.
  Separately, `allowDeferredFrames` is disabled by default. When explicitly enabled,
  a caller's classifier may defer an otherwise unclassified complete frame captured
  during the current written transaction before its response. The mux retains that
  frame against both frame and push quotas, temporarily parks subsequent classified
  pushes in arrival order, and lets the matching response pass. After successful
  response verification and consumption it retries each deferred frame once, accepts
  only a push route, verifies each push, and enqueues them in order before settling
  the transaction. The independent push handler may still be running or fail later.
  Classification, push verification and the push handler must not wait for the same
  transaction, owner registration or FIFO; callbacks must enqueue promptly and defer
  business work. Deferred frames are not authenticated by this local policy, and an
  uncooperative callback or sustained input may still lead to timeout or capacity
  failure. No production classifier automatically selects deferred frames. A synthetic
  Linux EasyLogin fixture exercises an unknown candidate before a response, but does
  not establish that QQ sends this ordering or that the candidate is authentic.
  A held partial frame or sustained input can delay settlement until timeout. The
  opt-in `allowIncompleteFollowingFrame` permits settlement after a matched response
  is verified and consumed while a subsequent frame remains incomplete. The frame
  retains the identity captured when its prefix began; a stale response cannot become
  a later transaction's response. A later bad frame can still close the client after
  success. A separate opt-in `frameAssemblyTimeoutMs` limits assembly from the
  first prefix byte processed by `feed` until the complete frame is accepted, without
  extending the deadline for incremental input or a transaction change. It is disabled
  by default and does not bound later queue or callback work. The timer and boundary
  checks depend on event-loop scheduling, not a hard real-time guarantee. On timeout
  the client closes with `frame-assembly-timeout`; a timer-scheduling error closes
  it locally with `frame-assembly-timer-failed`. Owners must observe `whenClosed`.
  A synthetic Linux EasyLogin
  fixture exercises a push prefix before the register request and its remainder
  afterward; this is not evidence that a QQ server sends that ordering. Full-frame
  backlog and callback completion still gate settlement. The barrier itself supplies
  neither a key nor authentication. Already queued or
  running push callbacks are not paused by the barrier. Successful transaction
  settlement means that transaction's callbacks and write have ended, not that
  independent push handling is globally quiescent. A later push failure can close
  the client, which the owner must observe through `whenClosed`. `end()` closes
  immediately rather than draining already queued frames or callbacks; pending
  transactions report failure with uncertain write state after a write attempt.
  The configured classification and UIN/sequence comparisons are local policies,
  not peer or message authentication. This client does not open a socket or attach pushes to
  Bridge or OneBot. The older standalone fixture supplies a synthetic D2 key
  directly to its classifier; it does not establish session key handoff.
- `src/direct/wt-multiplex-reference.ts` composes an injected stream, broker and
  WT session with an owner-specific internal classifier. It stages the confirmed
  UIN and a private copy of the login-derived D2 key during validated response
  consumption, before the matching barrier releases later frames. Registration
  must finish successfully before locally classified push frames are released
  from the bounded FIFO to the caller's verifier and handler. Those callbacks
  receive temporary copies of the original encrypted frame. An optional
  `onPushBody` callback receives the independently decrypted SSO business body
  after the raw verifier and handler succeed; this is a byte payload, not yet a
  Bridge or OneBot event. Its metadata includes the SSO return code unchanged.
  The caller supplies `maxPushBodyBytes` from 1 through 16 MiB when enabling it.
  That limit is checked after SSO parsing and decompression, whose separate
  16 MiB output cap is not a limit on total process memory. Callback copies are
  wiped best-effort after settlement or termination; an independently closing
  transport may be observed in a subsequent microtask. The SSO parser also wipes
  its reachable temporary field copies on success or failure while preserving
  caller-owned input and successfully returned fields. Copies internal to zlib or
  the JavaScript engine and copies retained by callers are not guaranteed to be
  erased. The API does not expose the D2 key for caller-side decoding. The
  deep-importable capability helpers are an internal ownership convention, not isolation from
  other code in the same process. Send-coordination helpers bind an attempt to its
  registered borrowed lease and one locally active run; they reject a stopped or
  busy attempt at binding and reject reuse of a completed run within the same
  capability. The injected reference multiplex session uses a one-time local handle
  to expose `sendText` after registration. It accepts explicit text, routing,
  sequence, random and response-size inputs, and returns a local response projection;
  this is not connected to the production Bridge or proof of message delivery.
  SSO errors and uncertain transport failures close the reference owner and reject
  rather than being reported as successful sends; the projected business result
  can itself be absent or nonzero. Loading the session or multiplexer now loads
  the request codec earlier than before, including its existing Proton dependency.
  While that operation is in progress, queued push callbacks wait and are resumed
  afterwards if the session remains active; close or failure can discard them.
  Attempts to send from a running push callback are rejected rather than waiting
  on themselves. The pre-existing operations retain their earlier
  push callback timing. The handle's revoked-state checks and best-effort byte
  wiping do not force an already running external callback to settle. A custom
  lease's first `whenClosed` read occurs inside the borrowed attempt and can
  assimilate an external thenable; the subsequent owner read is restricted to a
  same-realm ordinary Promise. Those checks are local coordination, not isolation.
  Deep callers can register their own objects, and direct low-level binding does
  not attach the attempt's lifecycle; neither operation proves origin, peer identity
  or isolation. The legacy borrowed attempt API still returns tickets. The classifier
  and caller-provided verification are local policies;
  QQ-TEA does not authenticate the peer. This composition does not create a
  connection, implement the signing algorithm, attach events to Bridge or OneBot,
  or establish real QQ interoperability. A transport that closes independently
  is observed via the next synchronous entry check or an asynchronous close
  notification; the latter is not a same-stack revocation fence. Its `whenClosed`
  indicates logical closure, not physical stream teardown or completion of a
  callback already in progress. In this composition, a terminal QR poll or
  non-ticket login result can be returned with its original status and code or
  state after the guard commits, an internal authority claims the broker-local
  terminal, and an exact-result receipt passes the local closure, cancellation and
  deadline checks. The receipt does not authenticate the peer or prove physical
  stream ordering. An independently closed stream or failed check remains a
  session error. The older standalone session without the internal authority can
  still lose these business details when its borrowed attempt poisons the lease
  before the session resumes. The exact-result final-delivery deadline fence does
  not extend to legacy registration, heartbeat or alive outcomes.
- `src/direct/send-message-request.ts` builds a reference-only, single-text
  `MessageSvc.PbSendMsg` request body from an explicit route, text, client
  sequence and random value. Its schema and default-field choices are inferred
  from LagrangeV2 commit `7011cdf87368cc0fb77273c1508e779a52328165`, not from
  captured QQ traffic or an execution of that reference implementation. Input
  ranges and UTF-8 limits are local policy, not proven server constraints. The
  request schema is for encoding; decoding it does not reliably distinguish an
  absent required scalar from its default. The returned bytes use a dedicated
  backing buffer, but the temporary Proton encoding is not securely erased. The
  function neither signs nor sends the result and is not connected to Bridge.
- `src/direct/send-message-response.ts` contains a reference-only projection of
  `MessageSvc.PbSendMsg` response fields based on the LagrangeV2 schema and
  sequence choice at commit `7011cdf87368cc0fb77273c1508e779a52328165`. Its
  `int64` and `uint64` fields remain `bigint`, and it reports field presence
  separately from the derived sequence fallback. Empty input yields absent
  fields and a derived `0n`, not a successful receipt. Unknown fields are not
  exposed; a known field using a different wire type may therefore appear absent.
  Nonzero results are retained and Proton decoding errors propagate. This is not
  strict validation of the response schema or UTF-8.
  This isolated decoder is not connected to the existing Bridge sending path;
  it authenticates neither the peer nor the response and proves no delivery.
  The reference schema and local tests do not establish equivalent behavior of
  the reference C# writer for negative `int64` values; its inspected fast and
  slow paths differ and require separate verification.
- `src/direct/sso-reference-send-text-flow.ts` composes these codecs with an
  injected borrowed transport and caller-supplied reserve and raw verification
  policies. It is not wired to the production session or Bridge. The public
  `referenceSendTextOnTransport` requires the transport identity UIN to equal the
  login UIN exactly; unlike borrowed registration, a transport identity of `0`
  is not accepted for another account. A separate deep-importable composition
  helper accepts the original transport identity alongside the confirmed account
  only when an active local capability matches the exact attempt, lease, run,
  account and D2 key bytes. It neither changes the raw transport identity nor
  establishes the origin or authenticity of those values. The reference multiplex
  session calls this helper through its owner-specific handle; the production
  Bridge does not. The owner must handle failures and poison the transport as
  appropriate; the helper does not do so or retry. The public
  function now returns its asynchronous core's promise through a non-async wrapper:
  normal direct construction still throws, but function-object reflection and use
  as `Reflect.construct`'s `newTarget` can differ from the former async function.
  This comparison and a successful verifier do not authenticate the peer or prove
  delivery. Outer SSO and inner message sequences remain
  separate; the response's client sequence is not compared with the request's.
  A zero SSO code yields the decoded projection, not an asserted business
  success: `result` may be absent, zero or nonzero. The injected transport and
  raw-frame verifier see a request frame whose service header can contain D2;
  they are trusted to handle it, not isolated from it. Its untrusted `errMsg` may
  contain private data; callers control its handling. The configured response
  limit is checked after SSO decoding, which can first inflate up to 16 MiB.
  The internal helper first validates and shallowly snapshots its outer options
  before reading the borrowed transport's method. When a signal is present, it
  checks that captured signal on both sides of the method getter; nested objects
  and byte arrays are copied after that getter, which can mutate them. With no
  signal, a valid outer options object is re-read after the getter; invalid outer
  options are rejected before it. An already-aborted captured signal may return
  `raw-cancelled` before the helper validates the capability; a getter that throws
  still reports an invalid borrowed transport, including if it also aborts. Only
  token revocation without signal abort does not by itself prevent the getter.
  The public helper retains its earlier getter order. After copying the remaining
  inputs, the internal helper dynamically imports the capability module and
  rechecks cancellation and elapsed deadline.
  A non-settling import is not forcibly interrupted and retains those
  owned copies until it settles. A loss of local run ownership during cleanup
  yields an uncertain-write failure rather than a successful response or a claim
  that no bytes were written; it does not release a different active run. The
  last build-time capability check and the borrowed transport's physical write
  are not atomic. In a synthetic test, an injected lease revokes the capability
  after the builder returns without poisoning or closing its multiplex client;
  its in-memory write callback records one frame while revoked. After a synthetic
  response is fed, the transaction returns failure with unknown write state. This
  does not establish how a future session owner will handle that race. Deadlines
  and cleanup do not force a non-settling transport or callback to finish; its
  owner remains responsible for exclusivity and poisoning on failure.
- `src/msg-push/index.ts` also exposes `parseDirectMsgPushOrThrow` for callers
  holding a decrypted push body and its metadata. It accepts no fabricated PID,
  requires a matching identity UIN, the known MsgPush command and a zero return
  code as local policy, and reuses the existing synchronous context, registry,
  filtering and optional deduplication. A dedup instance must be scoped to one
  account/session: its keys do not include the account UIN. An empty or unsupported
  message can yield no events; that is not proof of delivery. Identity and
  deduplication can have synchronous effects that are not rolled back on an
  exception. The standalone parser has no body-size limit of its own; callers must
  bound input and decoding work separately. Rich and light cards now share the
  existing 8 MiB decoded-output budget across the root and its nested quoted
  elements, in the decoder's existing parent-before-child processing order.
  Cards exceeding the remaining budget use the existing ignored-card and fallback
  behavior, including its debug diagnostic; this intentionally changes large
  nested messages on legacy and history paths too. The budget does not limit
  markdown, total work, memory usage or recursion depth. Nested quoted elements
  still have no independent depth or cumulative decode-work limit, and an outer
  byte limit is not a direct JavaScript stack bound. The input body is borrowed
  and callers own input and output lifetimes; binary results must not be assumed
  independent of the input. The direct parser
  avoids raw payload previews in its own warnings and error traces, but reused
  identity services and other existing diagnostics may still record identifiers;
  callers must also handle thrown errors and logging policy appropriately. This
  parser itself neither dispatches events nor connects the direct session to
  Bridge, OneBot or a real QQ peer. A caller that has already parsed events may
  pass them to `IncomingPacketPipeline.processDecodedDirectEvents` with only
  command and sequence trace metadata, without inventing a PID. The caller must
  bind the correct account and manage body and event lifetimes; this entry is not
  connected to a production direct session. It does not authenticate the source,
  enforce strict mixed-event ordering, or await asynchronous subscribers and
  detached roster refreshes. Existing pipeline logs may contain event data.
  A synthetic in-memory test composes the reference multiplexer's body callback,
  this parser, the pipeline and the event bus for text messages. Its verifier is
  a test stub; it does not prove authentication, production wiring, or the
  ownership of other event types. A separate synthetic cross-package test feeds
  parsed friend and group text through the real OneBot `registerEventPipeline`
  using account-scoped fake contexts and dispatch, and applies v12 conversion to
  those dispatches. It explicitly stops and drains the OneBot handlers; it does
  not construct the production OneBot instance, exercise network adapters, or
  prove live delivery. Its body-lifetime observations apply only to those text
  fixtures. Group-title parsing now emits a title only when the last rich token's
  own JSON `text` field is a string; other field types are dropped rather than
  crossing the typed event boundary. The group-recall decoder preserves the first
  entry's existing behavior and then emits subsequent entries with nonzero
  sequence numbers in list order. Additional entries with an absent or zero
  sequence are skipped; the decoder attempts a single count-only warning. The
  first entry can still use the legacy zero-sequence fallback, so its downstream
  message ID is not proof of a QQ history match. A decoder error can fail the
  whole batch, and downstream failures can prevent later dispatch. Neither this
  behavior nor synthetic tests prove that a real QQ server emits multiple entries
  or that the resulting events were delivered. Separately, the existing packet
  pipeline's member-cache refresh is detached and best-effort: same-group events
  can be coalesced, including a reentrant self-join that would otherwise request
  a group-list refresh. It is not a drain or delivery barrier.
- `src/direct/direct-push-ingress.ts` supplies a disabled-by-default in-process
  ingress for a caller-provided identity and packet pipeline. Activation is an
  owner decision, not authentication or online-state evidence. The caller asserts
  that the pipeline is bound to that identity and has handled source authentication;
  this ingress independently checks local UIN, command, return code and sequence.
  It snapshots borrowed bodies before asynchronous work, uses a per-instance dedup
  and a serial queue, and bounds accepted body size, queued body bytes, pending
  items and the post-parse event count. These are local limits, not a bound on
  parser or structured-clone work, decoded graphs, subscribers or total process
  memory. Structured cloning isolates cloneable event data from the owned body but
  can change prototypes or Buffer representation and does not guarantee support
  for future event types. `empty` combines distinct parser outcomes; `settled`
  means only that the pipeline promise settled, not that events were delivered or
  every pipeline error surfaced. Parsing can update identity or dedup before a later
  failure, and stopping cannot reverse those effects or interrupt synchronous work.
  Stop rejects new work and drops queued work; already-entered pipeline work can
  still emit. Drain waits for ingress-owned work, not asynchronous bus subscribers
  or detached roster refreshes, and can remain pending if initialization or a
  pipeline dependency never settles. A dependency awaited by the pipeline must not
  await another submission to the same FIFO or its drain, because it may then wait
  on its own work. The raw multiplex callback requires an
  adapter to consume the result and return `undefined`; synthetic tests exercise
  that handoff with fabricated in-memory frames and policy callbacks. The source must supply a
  valid borrowed body through the synchronous snapshot; this ingress cannot detect
  a buffer already wiped upstream. A separate synthetic OneBot test composes this
  ingress with the real event pipeline and v12 conversion using fake account contexts;
  it tracks ingress and OneBot drains separately. A separate deep-internal guarded
  factory accepts a trusted synchronous local-liveness check: a non-true result
  stops admission and fences the next processing stage. The check is not source
  authentication, and must not mutate the identity. Already-entered parser or
  pipeline effects are not rolled back; a guard after pipeline settlement can
  report stopped even though effects have occurred. Identity, pipeline, ordinary
  Array and Promise intrinsics, and the absence of synchronous reentry from runtime
  hooks remain trusted in-process assumptions. Core `Bridge` now exposes
  an internal, opt-in, single-claim composition port bound to that Bridge's identity
  and packet pipeline. Its owner must supply authentication and limits; activation
  does not attach a transport, sender, PID or online status. Bridge disposal stops
  the port and awaits ingress-owned work before closing identity and its event bus;
  already-entered pipeline work can still emit after stop. Without an attached
  packet sender, outgoing packet-backed actions do not gain send capability from
  this receive-only port. Local status or action listings do not prove QQ login.
  An additional internal `openLinuxEasyPushProcessor` port creates the guarded
  processor with the Bridge's own identity and pipeline, sharing the same one-shot
  claim with the existing ingress. The caller supplies the owner, queue limits,
  complete-frame verifier and source-authentication assertion; none is proof of
  peer identity. The processor checks the owner's active account against the
  Bridge UIN before activation and during guarded work. Its raw verifier still sees
  a candidate before owner classification, so the caller must route frames to the
  correct owner. Once created, the processor owns that owner's lifecycle: stopping
  it or disposing the Bridge requests that the owner close. If construction yields
  no handle, the caller retains responsibility for the owner, which a failed factory
  may already have closed. Disposal waits for admitted processor work but does not make
  an uncooperative dependency finish. This port does not start a session, connect a
  transport, provide a packet sender or establish online state.
  Synthetic tests compose real memory-only Bridge objects with the OneBot event
  pipeline and fake OneBot contexts, including independently gated subscriber
  completion; they do not start a OneBot instance or exercise network adapters.
  Bridge disposal does not await OneBot subscribers or detached roster work, and
  hanging dependencies can delay disposal.
  Legacy and Direct pushes use separate dedup instances and may duplicate events;
  their relative ordering and cross-generation identity isolation are not guaranteed.
  For a manager-owned session's final PID detach, the manager reserves its close
  before synchronous logging and close observers; a same-UIN reopening from those
  callbacks therefore receives a `beforeOpen` gate for the reserved close. The gate
  waits for settlement, including failure, and shutdown still reports close failures.
  Synthetic tests observe the gate; they do not establish real database behavior.
  Separate construction and PID-binding reentrancy windows remain outside that
  guarantee. After manager shutdown begins, late PID-disconnect callbacks are ignored.
  Bridge packet handling also reserves accepted work before packet and initialization
  getters can reenter disposal; dependencies that never settle can still block it.
  This port is not automatically claimed by the production session manager, and it
  does not establish peer authentication or live QQ interoperability.
- `src/direct/raw-multiplex-stream.ts` adapts a caller-supplied, already-established
  byte stream to that client without opening or connecting a socket. It requires
  exclusive ownership and uses the shared direct-socket ownership registry for
  the exact stream object in this module instance. Closing is logical first;
  physical close and successful listener cleanup determine when the shared claim
  can be released. A pending write uses a separate stream-owned copy; cleanup of
  that copy depends on the stream honoring its callback contract. A write returning
  `false` is accepted once, but a subsequent write while `writableNeedDrain` is
  true fails closed rather than waiting or retrying. Callback success is local
  stream behavior, not evidence of remote receipt. Callers must preserve their own
  error handling for registration failures, nonconforming streams and post-close
  errors. No live connection, QQ interaction or application wiring was tested.
- `src/direct/sso-register.ts` encodes the reference PC registration and SSO
  heartbeat bodies, and classifies a registration response using its command,
  SSO return code and exact `register success` message. Account and sequence
  binding remain the transport caller's responsibility. PC service-level fields
  were also checked against fixed LagrangeV2 commit `7011cdf`: its
  [registration](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/System/InfoSyncService.cs#L7-L59)
  and [heartbeat](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/System/SsoHeartBeatService.cs#L7-L22)
  have matching PC field assignments. Android uses different assignments and is
  not represented by this PC codec. The explicit-default wire behavior and
  hand-derived vectors have not been compared with the running V2 serializer
  or target. V2 places UID in the SSO reserve; this local registration flow passes
  UID to a caller-supplied reserve builder and does not prove the builder includes
  it. Local `missing-result` also remains distinct from V2's default empty response
  message; both are non-success but are not identical response classifications.
  These codecs do not perform registration, change online state, schedule
  heartbeats or validate server identity.
- `src/direct/sso-unregister.ts` is an offline codec for the fixed LagrangeV2
  [unregister request and response](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/System/SsoUnregisterService.cs#L9-L29).
  Its request bytes are derived from the reference fields and generator source;
  they have not been compared with a running reference serializer or QQ. The
  response projection observes the top-level message field without classifying
  success. It distinguishes an absent field from an explicitly empty string,
  unlike the reference object's empty-string default. Unknown and wrong-wire
  fields and invalid UTF-8 follow Proton's decoder behavior. The caller supplies
  a local response-size limit; shared, resizable and detached buffers are rejected.
  Clearing temporary bytes does not guarantee erasure of strings or other copies.
  No transport, logout, server authentication or online-state transition is wired.
- `src/direct/sso-reference-unregister-flow.ts` composes that codec with one
  caller-supplied borrowed transport, opaque reserve builder and raw-frame verifier.
  Its standalone entry requires a canonical positive UIN at most `0xffffffff`
  that exactly matches the transport's self-reported UIN. A separate deep-internal
  capability entry can bind a staged raw UIN of `0` to a confirmed account and key;
  it shares the send operation's single-flight slot and rejects reused runs. This
  entry is tested with manually staged synthetic capability state and is not connected
  to the WT session or multiplexer. Its options are shallow-snapshotted before the
  transport getter; nested records and bytes are inspected afterwards. Matching
  identity, passing a caller verifier or obtaining a response does not authenticate
  a peer or establish a remote logout.
  After outer and inner SSO parsing (including decompression), nonzero SSO retcodes
  are returned without decoding protobuf; zero produces only an absent/present
  message observation. The protobuf size cap applies after SSO decoding, not to
  its earlier allocations or peak memory. The owner supplies exclusive access,
  cross-call single-flight and failure poisoning; a pending noncooperative transport
  or callback is not forcibly stopped by this helper's deadline or abort signal.
  It does not open a connection, change the session state or close the transport;
  a caller-supplied transport may have external effects. Only synthetic transports
  have been exercised for this helper.
- `src/direct/sso-reference-heartbeat-flow.ts` composes one borrowed protocol-12
  heartbeat using an owner-supplied account, credentials, signer and raw-response
  verifier. It validates local command, sequence and account binding and retains
  an observed interval as `bigint`, without inferring its unit; absent and zero
  are distinct. Its optional integer `maxResponseBodyBytes` accepts `0..16 MiB` and
  defaults to 16 MiB for this standalone borrowed helper. It bounds decoded
  body bytes during decompression and for uncompressed data, including before a
  nonzero SSO result is returned; zero allows only an empty decoded body and uses
  a one-byte inflate cap followed by a nonempty check. For zero SSO return codes,
  the heartbeat protobuf decoder also applies its separate 1 MiB input limit;
  the stricter applicable limit wins, and passing a size limit does not by itself
  make a body valid. Nonzero SSO results do not enter that protobuf decoder.
  Outer-frame and other limits apply separately. The SSO decoder copies an
  uncompressed body before checking its limit; outer TEA and transport processing
  can also make frame copies. This output/decompression limit is not a whole-path
  peak-memory or CPU bound. The helper now rejects lasting changes to the signer
  input and to the verifier's temporary request and response copies; callbacks that
  previously used those copies as in-place scratch must use separate storage.
  Changes restored before a check, retained copies and the validity of a returned
  signature remain unproven. The Linux Easy owner applies its stricter default and
  maximum of 65536 decoded body bytes, as described below. This is a local
  contract, not an exact reproduction of V2's missing-value or integer-cast
  semantics. Fixed V2
  [schedules SSO heartbeat](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Logic/WtExchangeLogic.cs#L384-L422)
  immediately after its registration success and every 270 seconds thereafter;
  it discards the response instead of scheduling from its interval field. V2's
  callback also does not implement this owner's fail-and-poison response policy.
  Its separate two-second `Heartbeat.Alive` is not this transaction. Jiyu's reference
  owner does not automatically start either timer, and its one-request transport
  does not handle asynchronous pushes. External signer output remains opaque, and
  QQ peer authentication and real wire compatibility remain unverified.
- `src/direct/sso-reference-alive-flow.ts` builds one borrowed `Heartbeat.Alive`
  request with protocol 13, no encryption and the four-byte body from
  [fixed V2](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/System/AliveService.cs#L6-L18).
  It accepts initial UIN `0` and an empty UID, so a caller may construct the
  pre-login reference request without fabricating login credentials. Reserve bytes
  still come from a caller callback. The local response policy requires protocol
  13 and no encryption, but the upstream request definition does not establish
  that server responses always have those properties. The verifier receives the
  expected UIN, sequence and frames, but not the transport identity UIN; callers
  needing that relationship must bind it separately. The helper does not own its
  transport, schedule retries or establish authentication.
- `src/direct/sso-heartbeat-scheduler.ts` is an explicitly started, caller-owned
  SSO heartbeat scheduler with a fixed 270-second default period and injected timer
  support. It skips overlapping ticks instead of allowing V2's possible overlapping
  timer callbacks; it never treats the response interval as a scheduling unit.
  Stop waits for in-flight work, so a callback that never settles can leave it
  pending. An optional caller interrupt may stop the session; the scheduler itself
  does not silently close or poison it. It does not schedule the separate Alive
  flow or attach to the application runtime.
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
  policy is not implemented here. The optional caller-supplied inner SSO A2
  defaults to empty; it is distinct from the empty outer D2 used with zero-key
  transport. The caller must ensure it belongs to the intended account. The
  legacy `createKeyExchangeFlow` accepts reserved metadata before generating its
  body. The additive `prepareKeyExchangeFlow` instead generates one protobuf body
  and exposes a borrowed copy before `finish(reserved)` frames that same private
  body, allowing a caller to await a body-dependent signer. The reference
  [signing call](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Context/PacketContext.cs#L49-L57)
  passes the protobuf packet data before SSO framing. This is an in-process
  ownership contract, not an isolation boundary against code altering built-ins.
  The comparison at finish detects current changes to the borrowed bytes, but does
  not prove what an external signer actually signed. Finish or cancel ends the
  borrow and clears the exposed view best-effort: a callback still awaiting can
  observe it cleared, and
  the owner of any separate copy must clear that copy. Finish is one-shot even on
  failure; cancellation during finishing revokes the result. The resulting flow
  rejects recursive completion without affecting the outer completion, and a
  verifier that synchronously cancels it prevents ticket delivery. Its sequence is
  signed 32-bit; an adapter carrying uint32 must preserve its bit pattern explicitly.
  A signer deadline and transport lease remain caller responsibilities. Synthetic
  tests use a permissive verifier only for their in-process peer.
  The serialized `KeyExchangeRequestBuf` plaintext, successfully returned
  decryption buffers and reachable response-decoder outputs on later failures are
  wiped best-effort; SSO framing and other intermediate copies, crypto/codec copies
  that never become accessible, and caller-owned or transferred session bytes are
  excluded. If key-exchange construction fails after deriving a shared secret, that
  internal value is also outside this flow's cleanup guarantee. If the protobuf
  decoder throws before returning, its internal field copies are not reachable for
  cleanup. Cancellation discards the retained handle, but JavaScript and the crypto
  provider do not guarantee secure memory erasure.
- `src/direct/sso-reference-key-exchange-flow.ts` composes one prepared exchange
  over an injected borrowed raw transport. It binds the expected UIN and raw uint32
  sequence, passes a copied protobuf body to caller-supplied reserved metadata and
  requires a caller-supplied raw-frame policy before consuming the same candidate.
  A changed signer input is rejected, although that comparison cannot establish what
  the signer actually signed. The outer response dummy byte must be zero as a local
  restriction; the reference flow separately checks framing, account, sequence,
  command and return code. Response-key verification is also caller policy, not
  established server identity. Abort or deadline ends the local wait and clears
  owned views best-effort, including locally staged session key and ticket copies
  until final handoff. An uncooperative transport, callback or guard may remain
  active and retain its own copies or side effects. A transport invoked before a
  failure is reported with unknown write state. Do not reuse it without an owner
  establishing quiescence, and do not interpret this reference transaction as an
  online session, retry guarantee, runtime integration or live QQ interoperability.
- `src/direct/nt-linux-login-reference.ts` independently constructs an offline
  Linux PC NT-login request body from the fixed LagrangeV2 `7011cdf` reference's
  [common request](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/Login/NTLoginCommon.cs#L13-L29)
  and [Linux head fields](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/Login/NTLoginCommon.cs#L105-L135).
  It accepts caller-supplied session key and ticket, an opaque already-encoded
  login body, Linux device/app metadata and a mandatory 12-byte nonce. Based on the
  [reference GCM construction](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Utility/Cryptography/AesGcmProvider.cs#L11-L39),
  it supports 16-, 24- and 32-byte keys, empty AAD and `nonce || ciphertext || tag`.
  The caller must ensure nonce uniqueness per key; the helper neither generates
  nor tracks nonces. Its account is a canonical positive decimal string within
  signed 64-bit range and its app ID is limited to nonnegative signed 32-bit;
  these are local restrictions, not claims about the whole reference or QQ. An
  absent or undefined cookie creates an empty cookie message; explicit `null` is
  rejected by this API. Empty body and supplied empty strings preserve the local
  reference field-presence rules. The 1 MiB input/framing budget is not a peak
  memory bound. Copied byte temporaries are wiped best-effort; caller inputs,
  returned ticket bytes, strings and crypto/runtime copies remain outside that
  claim. The existing exchange flow does not automatically feed this helper or
  bind its returned material to this account, expiry or a trusted peer; GCM also
  does not authenticate the outer ticket or establish server identity. Synthetic
  tests exercise Node cryptography and Proton, not a running V2 implementation,
  actual QQ login or the supplied native signing library.
- `src/direct/nt-linux-login-response-reference.ts` is a separate offline PC
  response projection based on the reference's
  [decode path](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/Login/NTLoginCommon.cs#L55-L76).
  With a caller-supplied session key, it authenticates the GCM-encrypted field 3
  before interpreting the common message. It returns an opaque body, preserving
  absent versus present-empty, and distinguishes missing head, missing error
  information, and a `uint64` code with its wire-presence flag. A present empty
  error message projects the reference's default zero code with `codePresent: false`;
  this is a decoded value, not a login-success determination. Nonzero codes still
  carry any decoded body. This local parser rejects repeated or wrong-wire selected
  fields, non-minimal varints and protobuf groups, unlike the more permissive
  upstream decoder. The selected outer fields are 1 (ticket), 3 (encrypted buffer),
  4 (uint32 type), and 5 (security buffer); only field 3 is required, but any of
  these fields is subject to the duplicate and wire checks. Unselected fields
  with wire types 0, 1, 2 or 5 are skipped as
  opaque data, including repeated fields. Its 1 MiB per-input/plaintext and field
  count bounds are local admission rules, not a whole-process memory bound. Outer
  ticket and type are not authenticated by this GCM payload; identity, account
  binding, replay protection, key provenance and expiry are caller responsibilities.
  Owned reachable byte temporaries are wiped best-effort, excluding caller buffers,
  returned body and runtime/crypto-internal copies. No session orchestration or
  production Bridge integration is provided by either reference helper.
- `decodeLinuxNTLoginReferenceResponseWithTips` is an opt-in offline projection
  of the same authenticated common response. In addition to the original status
  and body, it exposes ErrorInfo fields 2 and 3 as `tips.title` and `tips.content`:
  `null` means a field is absent, while an empty string remains present-empty.
  `tips` itself is `null` when the head or ErrorInfo is absent. The optional
  projection does not decide whether a status is successful or whether a caller
  should display, log, or act on server-provided text. It is not wired into the
  EasyLogin transaction, owner, or production Bridge. Each text field is locally
  limited to 4096 UTF-8 bytes and decoded strictly; repeated or wrong-wire selected
  fields are rejected. The original response helper still treats these fields as
  unknown, preserving its prior behavior. GCM integrity under the supplied key
  does not establish its provenance, the server identity, account binding, or
  freshness. Output and intermediate strings, including those created before a
  failed projection, cannot be reliably wiped; callers own the returned body. The reference behavior is based on [the fixed error fields](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Packets/Login/NTLogin.cs#L167-L182)
  and the [EasyLogin parse branch](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/Login/EasyLoginService.cs#L22-L33),
  not observed QQ traffic.
- `src/direct/nt-linux-easy-login-reference.ts` independently encodes the PC
  EasyLogin opaque request body and projects four ticket fields from its response,
  based on the reference's [service](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/Login/EasyLoginService.cs#L9-L33)
  and [packet declarations](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Packets/Login/NTLogin.cs#L306-L315).
  The caller explicitly supplies a nonempty A1 to the request encoder and may pass
  its returned bytes as the NT request helper's body. The response projector
  accepts an explicit body, reports whether its tickets message was present, and
  returns independent A1/A2/D2/D2Key byte arrays or `null` for absent fields;
  present-empty arrays are preserved. It does not validate ticket contents, bind
  them to an account or peer, decide login success, persist credentials, or handle
  the separate unusual-device response. The caller owns and must clear input and
  returned byte arrays. Reachable internal copies are wiped best-effort, excluding
  runtime/codec copies that become inaccessible. Local limits are 1 MiB per
  encoded frame and 256 fields per inspected message; selected fields reject
  duplicates and wrong wire types, and all varints must be minimally encoded.
  These stricter rules are not a complete description of V2 or QQ behavior.
- `src/direct/nt-linux-easy-unusual-device-reference.ts` separately projects the
  reference EasyLogin response body's field 3 (`SecProtect`) and its nested field 2
  (`UnusualDeviceCheckSig`) as opaque bytes. It reports the presence of the outer
  message separately from a missing, empty or nonempty nested value and returns an
  independent caller-owned copy. It leaves the existing ticket projection and owner
  unchanged. The fixed V2 reference [returns this field for error 140022011](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/Login/EasyLoginService.cs#L22-L33)
  and [passes a present value into a later WT path](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Logic/WtExchangeLogic.cs#L128-L145).
  This helper does not inspect the status or start that path: caller policy must
  bind the decoded status and body, authenticate the source, manage freshness and
  clear returned bytes. Its synthetic GCM/Proton and explicit QR-body fixtures do
  not prove QQ interoperability or SSO signature semantics. The local parser caps
  input at 1 MiB and each inspected message at 256 fields, rejecting duplicate
  selected fields, wrong wire types, non-minimal varints and protobuf groups;
  unknown fields are skipped. These rules are local rather than V2 equivalence or
  a CPU-time bound, and the separate QR TLV encoder has a 65535-byte value limit.
- `src/direct/sso-reference-linux-easy-login-flow.ts` composes those PC helpers
  into one transaction on a caller-supplied borrowed raw transport. Its signer
  receives the complete serialized NT forward request, including the session
  ticket, before SSO framing; the raw verifier receives copies of both frames.
  These callbacks and the transport are trust boundaries. The transaction binds
  its configured UIN and sequence, rejects lasting signer-body mutation, verifies
  the raw candidate according to the caller's policy, then returns NT status and
  an opaque caller-owned body without deciding success or persisting tickets.
  Missing status fields, omitted code and absent versus empty body remain distinct;
  unusual-device data is preserved as opaque bytes, not automatically handled.
  The caller supplies a nonce unique under the session key and owns account/peer
  binding, expiry and replay policy. A local timeout or abort cleans reachable owned
  views best-effort but does not establish transport quiescence or revoke callback
  side effects. Guard-owned buffers may remain until an uncooperative transport
  settles; after any uncertain write, the owner must resolve that transport before
  reuse. A synthetic in-memory test manually runs key exchange and EasyLogin on
  the same broker lease, with caller-managed credential cleanup and poisoning on
  failure. That fixture assumes successful transport quiescence; it is not a
  production session owner or proof of peer identity. This experimental reference
  flow is not wired into production Direct, does not mark an account online, and
  has not established live interoperability.
- `src/direct/linux-easy-login-session.ts` is an in-process reference coordinator
  for those two transactions on the caller's same borrowed lease. It snapshots
  both stages' inputs, carries one monotonic deadline and requires an explicit
  caller policy for the opaque key-exchange expiration before EasyLogin. Its
  per-stage write states remain separate; unsuccessful claimed sessions request
  lease poisoning, while a response leaves the lease with its caller and returns
  an opaque status/body without asserting login or online success. The policy is
  evaluated only once and does not establish later validity. The local WeakSet
  claim covers the exact lease object in this module instance only, not wrappers,
  other module instances or direct use of the underlying client. Lease provenance,
  exclusivity, trusted successful quiescence, peer and account binding, expiry,
  replay prevention and nonce uniqueness remain caller responsibilities. Lease
  termination is observed asynchronously and is not a synchronous fence. The
  deadline depends on event-loop progress; a noncooperative transport, guard or
  callback can retain its own copies and continue effects after local settlement.
  Its in-process observation assumes ordinary Promise internals; mutated Promise
  constructors/species, arbitrary thenables and other same-process changes remain
  outside that contract. The separate internal
  `runLinuxEasyLoginSessionWithKeyCapability` path reserves a token against the
  original lease and UIN before key exchange, then transfers its one-shot proof
  internally to EasyLogin. The child receives a transport wrapper, while the key
  remains bound to the original lease. It checks the parent deadline around
  response consumption and returns only tentative state after cleanup and a final
  account/sequence check. The owner must revoke it on subsequent failure or close;
  the returned login body is caller-owned and can contain ticket material. A
  same-batch, in-memory mux test exercises both transactions and the early key
  stage. This is not peer authentication or production integration. Actual QQ
  interoperability and production Bridge wiring remain unverified.
- `src/direct/linux-easy-reference-register.ts` provides a separate borrowed-lease
  handoff from an EasyLogin response to reference registration. It uses the existing
  four-ticket projection and registration transaction; UID and its association with
  UIN, peer trust, ticket validity and reuse of the same exclusive lease remain
  explicit caller responsibilities. The registration transport's identity UIN must
  match the supplied account for this handoff, without changing the general borrowed
  registration contract. The local gate requires a present wire code equal to zero;
  unlike the [pinned V2 decode](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Internal/Services/Login/NTLoginCommon.cs#L55-L76),
  it rejects an omitted code that protobuf defaults to zero. A separate caller
  policy must also accept the account/UID; neither rule proves authentication.
  A non-success registration classification requests lease poisoning; the returned
  `poison` describes the local request, not completed closure. Success is only the
  existing registration-response classification, not proof that QQ is online. The
  two calls have separate deadlines; an owner requiring a single end-to-end deadline
  must enforce it across both. The owner must not reuse an uncertain lease, and must
  establish successful quiescence. Lease termination is observed asynchronously,
  not as a synchronous revocation fence. Outstanding callbacks, guard or transport
  effects and their private copies can outlive local settlement. A synthetic test
  composes key exchange, EasyLogin and registration using the same in-memory broker
  lease and an explicit caller policy; it does not authenticate its fake peer. The
  adapter does not persist tickets or connect the production Bridge; live
  interoperability is unverified.
- `src/direct/linux-easy-key-capability.ts` and the internal
  `referenceLinuxEasyLoginWithKeyCapability` entry implement part of an
  EasyLogin/multiplexer handoff. A module-local lease claim and opaque token
  identify a single login attempt; the consumer validates explicit zero status
  and ticket shapes and stages the D2 key synchronously before returning. An
  explicit key comparison can commit it, and a failed commit after resolving
  that tentative slot revokes it. Flow failure or cancellation requests revoke;
  the owner must also revoke on outer failures. The caller owns and must
  wipe its original key, ticket and body copies; token garbage collection does not
  guarantee erasure. Parsing under the tentative or active key returns only local
  service/SSO metadata and a caller-owned payload, not the key; decryption and
  parsing do not authenticate a peer. Input/response sequences still need
  operation-specific matching by the future owner. The 16 MiB frame limit is not
  a CPU, latency or peak-memory limit: callers need a smaller business-specific
  cap before invoking the synchronous decoder. Existing QQ-TEA/SSO helpers retain
  temporary allocations that this capability cannot comprehensively erase. An
  in-memory mux test verifies staging before a following frame is classified,
  including while the login result is still pending. The mux can classify such
  tentative candidates before the guard's final outcome; they must remain in a
  bounded queue with no business delivery until registration, key comparison,
  commit and an owner-liveness check succeed. A later failure must clear that
  queue and revoke the key. The caller must verify that the supplied transport
  really belongs to its claimed lease: the internal entry does not establish this
  relationship. The standalone candidate queue described below is not yet wired
  to this entry, a production owner or Bridge.
- `src/direct/linux-easy-account-owner.ts` is an opt-in, one-shot local owner for
  an injected raw client. It creates one private broker lease and sequentially
  performs the reference key exchange, EasyLogin and registration on it, without
  accepting a caller-fabricated login result. It preflights independently known
  registration fields before attempting login and requires an explicit zero login
  status, valid ticket shapes, caller policy acceptance, and the local registration
  classification `success` with no poison request. Its `registered` result is not
  peer authentication or an online-state claim. The login and registration profiles
  are independently supplied and can differ; this owner does not establish a common
  device identity. After registration it retains private copies of the fields
  needed by the experimental text-send and heartbeat operations and the registration
  profile; the unused A1 copy is wiped. `sendText` uses the same lease with a bounded,
  account-bound request and does not expose a ticket accessor. The existing
  transport and raw verifier callbacks receive request frames whose service
  header can contain the D2 ticket; these injected components must be trusted
  with such data. Busy or purely local invalid requests do not disrupt the current
  operation; an uncertain attempted send
  closes the owner and requests poison without retry. Its response is a local
  protocol projection, not proof of message delivery. After registration, an
  explicit `owner.heartbeat({timeoutMs, signal?, maxResponseBodyBytes?})` makes
  one borrowed reference heartbeat on that same private lease and account. It
  shares the owner's single-flight slot with `start` and `sendText`; a competing
  operation returns `busy` without inspecting its options. `timeoutMs` is required
  and is an integer from 1 through 2147483647 milliseconds; `signal` is optional.
  The optional integer response-body limit is `0..65536` bytes and defaults to
  65536. It applies during decompression and to uncompressed bodies, including
  nonzero SSO responses; zero permits only an empty decoded body. To implement
  zero, the decoder uses a one-byte inflate cap and then rejects any nonempty
  output. This is a local body bound, not a frame, peak-memory or CPU bound.

  A successful local response preserves an observed `interval` as `bigint`
  without assigning a unit; a missing interval is distinct from zero and does not
  by itself close the owner. A nonzero SSO code is returned as `sso-error` and,
  as local policy rather than an assertion about the server, stops the owner and
  requests lease poisoning. Busy, invalid options and cancellation or expiry
  before lease entry report not-written without disturbing an otherwise active
  owner. A transport, validation, cancellation or deadline failure after lease
  entry closes the owner, requests poison and reports an unknown write state;
  lease entry alone is not proof that bytes were written. The owner's lifetime
  deadline still applies.
  Cancellation and deadline checks depend on local event-loop progress and do not
  forcibly stop an uncooperative transport or callback or undo its effects. This
  owner does not schedule heartbeats automatically, create a connection, or wire
  them into production Core. A synthetic test combines the owner and actual raw mux
  with an in-memory peer, placing a push before or after the heartbeat response in
  one chunk; this exercises local routing, not a real QQ session. Its local result
  does not authenticate a server, validate a signature, establish online state or
  prove delivery; injected callbacks may have their own effects. Owner-held byte
  copies are wiped best effort on close or failure. The separate deep-import-only
  `createLinuxEasyAccountOwnerWithKeyCapability` variant binds a tentative key to
  its own lease and commits it only after the local registration success result,
  using the EasyLogin sequence and a separate comparison copy. Its internal
  `classifyLinuxEasyOwnerD2Candidate` returns only account, sequence, command and
  return-code metadata, never the body, key or ticket. The input frame and decoded
  SSO body are each limited to 64 KiB by local policy, not by an established QQ
  protocol limit. Metadata is sensitive and must not be logged. The internal broker
  binds only the exact lease, account and initially empty capability. On its own
  local terminal transition it invokes revocation synchronously before abort,
  operation cancellation or client close; a failed revocation does not prove
  erasure. An external `whenClosed` event is still observed asynchronously. A
  tentative classification is not authentication and is not delivered as a
  business event. The deep-internal `extractLinuxEasyOwnerPushBody` is available
  only after local registration and active-key checks. It checks the expected
  MsgPush metadata, re-parses the complete inner SSO and returns a separate,
  caller-owned business body; the caller must wipe it. This extraction does not
  authenticate the sender. A trusted composition must independently verify the
  same stable raw frame before extraction, and bind its stop path to the ingress.
  The optional local processor described below performs this composition when given
  a caller-supplied verifier; neither owner variant is automatically attached to
  production push handling.
  The lifetime deadline and phase deadlines depend on event-loop progress. Close
  revokes local state and requests poison, but cannot stop work already inside an
  uncooperative callback or transport, nor erase their retained copies. A broker
  may discard a late value before the owner sees it, so its producer remains
  responsible for that value. Lease close observation is asynchronous, not a
  synchronous transport fence; the original client or other wrappers can bypass
  this module's local lease discipline. This owner neither creates a connection nor
  attaches to the production Bridge, and does not establish QQ interoperability.
- `src/direct/linux-easy-push-queue.ts` provides a standalone, synchronous bounded
  FIFO for copied candidate frames and metadata. Its byte and count limits include
  the one in-flight item. The local drain switch does not establish registration,
  an active key or source authentication. Release and close wipe queue-owned
  frames best effort, but not copies or transferred storage held elsewhere. This
  queue is not connected to the owner or ingress by default. The separate raw mux
  defer policy requires explicit caller classification and is not enabled by this
  queue. `takeDetailed` atomically distinguishes an item from an empty, disabled,
  busy, closed or failed take; a failed take retains the FIFO and its quota.
- `src/direct/linux-easy-push-processor.ts` is a separate experimental in-memory
  composition of an exclusive owner, candidate queue, caller verifier and guarded
  ingress. The caller must await successful local registration before activation
  and assert the identity and source policy. The synchronous verifier sees a copy
  of the complete encrypted frame and must return exactly `true`; mutation still
  present at return is detected, but retained copies and mutation followed by
  restoration are not. The processor then reclassifies the queued frame, compares
  its route, extracts the active-key business body and submits it to the guarded
  ingress. Its `status()` distinguishes a local processing failure from an
  explicitly stopped processor without exposing frames or error details; active
  is only the last local observation, not a remote connection check. Its stop
  path wipes reachable owned buffers best effort; it cannot undo an already-entered
  parser or pipeline, or erase data retained by a callback.
  A dependency must not wait for this processor's own drain or subsequent FIFO
  work: doing so can deadlock. Drain can remain pending on an uncooperative pipeline
  or initialization. After each 16 completed and released items, the worker yields
  to the event loop; this does not bound an individual callback or pipeline wait.
  An idle owner termination is observed at the next check or explicit stop. A
  synthetic test also composes the real mux, owner and processor with a fake peer,
  including pushes following an EasyLogin response in the same in-memory input.
  Source authentication, real transport wiring, delivery and QQ interoperability
  remain unverified. No unknown pre-response D2 classification is added by this
  module.
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
online registration and heartbeat. The selected binary contains a contiguous
`wtlogin64.trans_emp` literal, while the bounded QR picture-request callback
constructs `wtlogin.trans_emp` from separate static pieces and passes it to an
unresolved receiver with a target-encoded `0x812` request. Whether that receiver
maps the name to the `wtlogin64` literal is unknown. Neither observation proves
runtime execution or acceptance.

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

## MSF security-sign chain (static summary)

This consolidates bounded static observations and conditional links; it does
not establish that one real request traverses the whole chain.

- Callback identity: RTTI and relocations associate vtable `0x8e80f38` and entry
  `0x3523110` with `nt::internal::MSFSecuritySignCallback`, derived from
  `msf::embedder::security::SecuritySignCallback`. Runtime registration and
  the identity at a specific virtual call remain conditional.
- Invocation: `SendMsfRequestInternal` (`0x35505a0`) loads a callback pointer
  from `this+0x70` and invokes virtual slots `+0x20` and `+0x10`. The latter
  receives an output buffer and the request's first dword. Interpreting that
  call as the candidate callback requires its runtime vtable to match.
- Orchestrator: the direct call at `0x352329a` enters `0x6856284`, named by
  diagnostics as `MSFSign`. Its observed output copies use a 0x300-byte region
  with candidate token/extra/sign slots at `+0x00/+0x100/+0x200` and low length
  bytes at `+0xff/+0x1ff/+0x2ff`. The three producer paths remain conditional.
- Result marshalling: the request receives strings at `+0xf8/+0x110/+0x128`
  from the callback result's `+0x30/+0x00/+0x18`. Given the candidate layout,
  those are sign/token/extra, respectively.
- Request handoff: `0x355ce90` is a logging helper, not the request dispatcher.
  The subsequent PLT calls at `0x3550e7d` and `0x3550e98` name
  `MSF::MSFSDK::sharedInstance()` and `sendPacket(unique_ptr<MSFRequest>)`.
- Pack-side copies: the separate `pack` path copies request fields
  `+0xf8/+0x110/+0x128` into local `+0xb8/+0xd0/+0xe8`. Its call to
  `0x676c540` conditionally copies the nonempty strings into a constructed
  object's `+0x18/+0x20/+0x28` and ORs presence bits `1/2/4`. Constructor,
  RTTI and serializer inspection independently identify that object as
  `MSF::protocol::SsoSecureInfo`: `0x67c2cd0` emits fields 1/2/3 as
  length-delimited bytes. Parent `MSF::protocol::ReserveFields` serializer
  `0x67c0ba0` places that child under field 24 (`c2 01`). These are serializer
  observations, not an inference from memory offsets or presence flags. The
  writer of request `+0x98/+0xb0/+0xc8` and the complete live send path remain
  unestablished.
- Field framing: `0x3551410` frames a payload as `BE32(len+4) || payload`
  (length self-inclusive, big-endian), modeled offline by
  `encodeTargetMsfLengthPrefixedFieldCandidate`.

**Queued send versus the separate pack API.** The inspected request construction
in `0x35505a0` initially clears the string storage covering `+0xc8`, then
`0x35507bf–0x35507c9` stores qword `0x100000000` at `+0x10`, setting the
request type at `+0x14` to 1. This is conditional on later callbacks/aliases not
changing the request; it does not characterize every MSFRequest constructor.

`sendPacket` at `0x670dd20` stores the original request at closure `+8`.
A RELATIVE slot `0x902c478` associates its candidate call target with
`0x67128e0`. That routine branches on request type. At `0x6712b19–0x6712b1c`,
a type other than 2 skips the type-2 credential checks. The subsequent normal
queue path copies selected members into a local object T:

| Request string | Local T string |
| --- | --- |
| `+0x50` | `+0x10` |
| `+0x20` | `+0x38` |
| `+0x38` | `+0x50` |
| `+0x80` | `+0x70` |
| `+0x68` | `+0x88` |

The three signature fields are copied separately. The inspected copy windows
`0x6712c7e–0x6712e63` do not copy request `+0x98/+0xb0/+0xc8` into T. The
last call is virtual slot `+0x20` of the object reached through global
`0x9177dd0`, not a demonstrated call to `pack`.

The initializer at `0x670d682–0x670d6a6` stores the result of `0x67116e0`
into that global. The factory allocates a 0x278-byte control/object block,
constructs the object at allocation `+0x18` with `0x673f160`, and stores that
embedded-object pointer and the control-block pointer into its output pair.
The constructor installs vptr `0x902e940`; its RELATIVE RTTI link
`0x902e938 → 0x902ec58`, with name at `0xfdc2ec`, identifies
`MSF::MSFPacketModule`. No later derived-vptr store was observed in the inspected
factory. If this remains the live object, slot `0x902e960` resolves the queue
call to `0x6742a40`, named `MsfSendPacket` by correctly mapped diagnostics.

The query described next is an overload check, not a credential lookup. The
entry tests T `+0x38` (logged as `uin`) and the incoming bit-2/bit-3 flags from
request `+0x0c`. It calls
`0x6769d20` with receiver `+0x1d0`, command T `+0x10` and a temporary string.
A successful lookup takes `0x6742bcf–0x6742c12`, logs
`cmd is overload in server, so reject to send[cmd:%s,seqId:%d]` from true VA
`0xb8599d`, and selects code 10. It does not supply a key to the send path.
The error virtual call at `0x6742c82` uses vptr `+0xd8` (candidate slot
`0x902ea18 → 0x67538b0`) with arguments beginning `(receiver,4,code,T,0,0)`.

The overload container has an exact-command hash table at `C+0` and another
table at `C+0x28`, where `C=receiver+0x1d0`. The selected node layout is
`next@0`, `hash@8`, `command@0x10`, `expiry@0x28`, output flag `@0x2c`, and
optional text `@0x30`. The main-table test at `0x6769d78–0x6769d7c` is signed
32-bit `expiry > low32(time(NULL))`. A live entry returns true regardless of
whether its output flag requests copying the text; an expired entry is erased.
Thus this query can mutate the overload table and is not a key fetch.

The related updater `0x6769410` skips four leading bytes of its input `+0x70`
string and calls `0x676a2b0`, consuming 0x40-byte parsed records. In the inspected
write branch, TTL is limited to 1–1800 seconds; expiry is the low-32-bit sum of
current time and TTL. Patterns ending in `.*` are placed in the second table
after dropping `*`. Full wildcard semantics are not established: the fallback
query visibly searches a dotted prefix, then supplies the original command to
a subsequent lookup/insertion helper. The updater's caller and parser field
tags remain untraced; no overload-policy implementation was added.

Other observed early decisions select code 1 after the conditional network
check, or code 3 for an empty `uin` field when virtual `+0x38` returns true.
The latter resolves to candidate `0x67430f0`: it searches receiver `+0x178`
with `0x3525cf0` and returns whether no node was found. The membership values
and complete delivery-policy behavior are not inferred from these tests alone.
Paths reaching `0x6742bba–0x6742bc0` call virtual `+0xd0`, with candidate slot
`0x902ea10 → 0x6753f90`. Other paths may enqueue or return earlier; the queue
entry is not evidence that every request reaches this final call.

The ordinary `0x6753f90` continuation moves selected T fields into a new
0x1a8-byte object P, retaining offsets such as `+0x10/+0x38/+0x50/+0x70/+0x88`
and `+0xb8/+0xd0/+0xe8`, and clears the moved source storage. P `+0x38` here
comes from request `+0x20`; it is not the key string at `+0x38` of the separate
head object constructed by the pack API. Some metadata is also changed:
`0x6754248–0x675425d` conditionally increments signed P `+0x114` when it is at
most 30, then copies it to `+0x118`; `0x6754398–0x6754438` clamps signed byte
`+0x12e` to 0–5. A later branch may set `+0x178=1`. Their business meanings
remain unassigned.

At `0x67545aa` it consults virtual `+0x38`. On the branch needing the additional
state check, `0x67545b5–0x67545c9` calls `0x6725690` through the object at global
`0x9177e20`, using `&P[0x38]` and the sign-extended scalar at P `+0x30` as
inputs. A non-null return permits `0x6753d20(receiver,P)`; no member of that
return record is passed as this call's key. The branch without the requirement
also reaches `0x6753d20`. When the check fails, P is instead placed in the
receiver `+0x48` container and scheduling helper `0x6751030` is invoked. Its
constructed callback has candidate RELATIVE slot `0x902f470 → 0x67594c0`.

Before registration, a conditional path in `0x6753d20` copies P's `+0x28`
subobject with `0x67b2630`; if the command test `0x67b2370` permits it,
`0x6753dab` calls virtual `+0x30` on the object at global `0x9177e18`, passing
that temporary. The matching constructed target is an additional gray-check
request producer, described below, not the original P's encryptor or signer.
A later virtual `+0x38` test can instead select the `(4,3,P)` error path and
destroy P. Those branches must not be skipped when reconstructing the call chain.

**Conditional gray-check side request.** At `0x670d8d8–0x670d8f4`, a 0x88-byte
object is allocated, constructed by `0x6729300`, and stored at `0x9177e18`.
Its vptr `0x902dac0` has RTTI `0x902db10`, name `0xfdab60`, identifying
`MSF::CSecurityModule`; slot `0x902daf0` resolves `+0x30` to `0x67299d0`.
Correctly mapped diagnostics name this method `DoAppGrayCheck` in
`SecurityModule.cpp`. A matching-input test through `0x67b2790` can return
early. Otherwise, the inspected path builds an object with `0x6729ba0`,
serializes it with `0x672c4a0`, and prefixes the resulting bytes with their
inclusive big-endian four-byte length.

It allocates a separate 0x1a8-byte request, constructs it with `0x67b31f0`,
sets its sequence via `0x673f140`, copies the input identity subobject to
`+0x28`, and stores the framed body at `+0x70`. Its command at `+0x10` comes
from RELATIVE slot `0x9155818 → 0xa20b4f`: `GrayUinPro.Check`. The call at
`0x6729b3b` submits this new object through the packet module's virtual
`+0x78`, candidate slot `0x902e9b8 → 0x6743230`. This identifies an extra
request under the matching object/branch conditions; it does not serialize
or authenticate the original queued packet, nor establish server acceptance.
On the inspected channel branch in `0x6743230`, `0x67432d7` calls
`CreateRequestBase` with R8D zero, ESI from the selected P `+0x130` value, and
EDX from a selected connection's virtual `+0x70` result. A non-null returned
Base is serialized via its virtual `+0x10` at `0x6743326`. Those observations
still leave the channel-selection conditions and wire delivery unverified.

The continuing path at `0x6753ece–0x6753ed4` reaches `0x6744210(receiver,P)`.
If P `+0x38` is empty, `0x6744243–0x674424e` assigns the literal `"0"` from
true VA `0x88c26e`. That entry then wraps P and passes the wrapper to
`0x6750da0` with receiver `+0x60` and P `+0x108`, not an observed serialization
call. A `MessageSvc.PbSendMsg` command match also calls slots `+0x10` and `+0`
on the objects at globals `0x9177e60` and `0x9177e70`. These are further
registration/queue leads, not evidence that `0x6744210` is the packet builder.
The selected pull-consumer and builder are now connected below; the caller
that drives this consumer and the final transport still remain to be traced.
A bounded RX scan for direct E8/E9 calls to `0x676c540` identified `0x670e2ca`
in the separate pack API; it did not establish a queue-to-pack connection.
The exported pack symbol is present, but no symbol-based PLT relocation for
it was found in this image. These limited scans do not exclude other indirect
or external use.

**Queue identity and selected consumer.** The wrapper built by `0x675b220`
has `W+0=P`, `W+8=0` and dword `W+0x10=0`. The insertion helper `0x6750da0`
organizes the receiver `+0x60` container into 0x38-byte groups keyed at group
`+0x30`, matching P `+0x108`. It stores W in segmented pointer slots, with
512 pointers per block, creates and sorts groups when necessary, and
increments the total at receiver `+0x78`. None of these insertion operations
is itself a packet send.

The packet-module vtable has RELATIVE slot `0x902ea88 → 0x6747530` at
`+0x148`. This method reads the same receiver `+0x60` container and obtains
two group-selection bounds from the caller-supplied object's virtual
`+0x80/+0x88`. It supplies a predicate with vptr `0x902efc0` to `0x6747310`.
The predicate slot `0x902eff0 → 0x6756520` first tests packet-module virtual
`+0x38` with P's command. A false result accepts directly; otherwise it
requires a non-null `0x6725690` result from the same registry, UIN and signed
type inputs described below. When a slot qualifies, the helper removes and
returns that W via `0x6755760`, decrementing the total. Its no-match path
instead returns the value at global `0x91781b0`; that value has not been proven
always NULL at runtime.

For a selected non-null W, `0x6747617–0x6747644` dereferences it to the same
P. The method stores the supplied object's virtual `+0` result in P `+0x130`
and calls `0x67436a0` with W, that result, a virtual `+0x70` result, and a
stack-supplied mode flag. If a Base object is returned, `0x6747657–0x674768c`
uses an output adapter with vptr `0x902ed00` and invokes Base virtual `+0x10`,
writing to the caller-provided output. Thus the selected queue-to-builder-to-
serialization path is linked at the W/P identity level. It does not establish
who invokes `+0x148` at runtime, the live object bindings or downstream socket
transmission; empty and failed-builder branches remain separate paths.

Do not substitute the timer consumer for this path. The callback chain
`0x67594c0 → 0x6751d10 → 0x6742fb0`, with a predicate resolving to
`0x6759580`, is identified by correctly mapped diagnostics as
`OnCheckRequestTimeout`. It reads W/P, changes P `+0x114` and handles timeout
conditions; it is not the selected pull-and-serialize method above.

For request type 2, `0x6712b22–0x6712b80` and `0x6712f30–0x6712f4e`
require already-nonempty `+0x98/+0xb0/+0xc8/+0x20`. Calls through
`0x67252d0 → 0x6724ce0 → 0x6723dd0` pass the existing `+0xc8` value onward;
`0x6723e28–0x6723e2f` copies it into a temporary `+0x68`, with a later candidate
state-node destination at `+0x90`. This is a conditional **request-to-state**
direction; it does not by itself derive credentials. The correctly mapped log
string at `0xbbc9d0` labels the length as `d2key:%d`; the label and nonempty
checks do not establish a 16-byte length. Separate send-side consumption is
now traced below.

**Shared state identity and returned record.** The type-2 caller loads the
object at `0x9177e20` at `0x6712f69–0x6712f70` before `0x6712f7f → 0x67252d0`.
The ordinary send gate loads that same global at `0x67545b5–0x67545bc` before
`0x67545c4 → 0x6725690`. Both paths access the object's `+0x30` tree through
`0x6725fb0`; this is an object-identity and data-flow link, not a match of
unrelated offsets.

The outer tree compares UIN strings lexicographically by raw bytes. At its
matching node, `+0x38` holds an inner ordered tree keyed by signed integer.
The query returns inner-node `+0x28`, the record body. If the integer key is
absent, only selector `-1` falls back to the nonempty inner tree's first item;
other misses return NULL. The setter normalizes selector `-1` to `0` before
insertion. The verified record fields are:

| Returned record | Source in the type-2 request |
| --- | --- |
| string `+0x00` | string `+0x38` |
| string `+0x18` | string `+0x98` |
| string `+0x30` | string `+0xb0` |
| integer `+0x48` | selected type integer |
| string `+0x68` | string `+0xc8` |

The setter allocates a 0xe0-byte inner node at `0x6724f8a` and moves the
record into node `+0x28` at `0x672502e–0x672503d`. The move at
`0x67257fb–0x6725824` includes string `+0x68`, establishing
`inner node+0x90 == returned record+0x68` for this layout. The presence-only
call at `0x67545c4` still does not inspect that field.

**Actual client credential notifications, independent of type 2.** Two
additional entry points reach the same registry from real client call sites,
not just from the exported SDK interface. The caller object is identified as
`nt::MSFCoreService` by RTTI `0x8e82c40 → 0x8e830e0 → 0xcbbfa3` and type name
`N2nt14MSFCoreServiceE`.

The login path is:

```text
SessionInit @ 0x354db50: incoming RDX object, string at +0x120
  → hex decode @ 0x354de3f → 0x8bc0600
  → this+0x288, moved at 0x354de44–0x354de75
  → caller temporary string at stack +0x20
  → call 0x354e521 → PLT 0x8e10b20
  → MSFSDK::notifyLoginSuccess @ 0x670e3c0
  → callback capture+0x70 → 0x67134a0
  → 0x6724990 → 0x6724ce0 → record+0x68
```

The PLT binding uses GOT `0x915fce0`, with its symbol-bearing relocation at
file offset `0x851480`. The caller passes type **0** at `0x354e517`. Importantly,
the original field is **hexadecimal text**, not bytes copied directly into
the key. Decoder `0x8bc0600` produces `floor(input_length/2)` bytes. At
`0x8bc06c0–0x8bc06d3`, it combines lookup values for `input[2*i]` and
`input[2*i+1]` as the high/low nibbles. Table `0x124ce58` maps ASCII digits
and both cases of A–F to 0–15. Hence 32 valid hexadecimal characters produce
16 bytes; neither that input length nor valid text is proven for all callers.
This is decoding, not a cryptographic derivation or recovery of the producer.

The refresh path is distinct:

```text
UpdateSignaureInfo @ 0x35545a0: incoming R8 byte container
  → begin/end loaded at 0x3554a36/0x3554a39, raw byte copy
  → caller temporary string at stack +0x20
  → call 0x3554c4f → PLT 0x8e10b80
  → MSFSDK::notifyRefreshSign @ 0x670e760
  → callback capture+0x70 → 0x6713850
  → 0x67252d0 → 0x6724ce0 → record+0x68
```

The corresponding GOT is `0x915fd10`, relocation file offset `0x851510`; this
caller also passes type **0**. The correctly mapped diagnostic at `0xb06d6d`
is `UpdateSignaureInfo account:{} uid:{} a2:{} d2:{} d2_key:{}`. The last
container is therefore labeled `d2_key` by the client, rather than by an
offset-based guess. This path copies its bytes without the login path's hex
decoder.

Both SDK methods read their last string parameter from entry-stack `+8`,
copy it to a temporary `+0x68`, then into callback capture `+0x70`:
`0x670e42c–0x670e4b2` for login and `0x670e7cc–0x670e852` for refresh.
The observed callback-construction paths require global byte `0x9177d58 == 1`.
These are conditional static chains: the callbacks, registry entries and
later queries still require matching object/state lifetimes. The next
unresolved producers are the writer of `SessionInit`'s input string `+0x120`
and the producer of `UpdateSignaureInfo`'s R8 byte container. Their origin in
WTLogin and their actual runtime lengths have not been established.

**Upstream virtual-call boundary.** For the observed MSFCoreService address
point `0x8e82c48`, slot `+0x90` resolves to `SessionInit @ 0x354db50`, and
slot `+0xf0` (`0x8e82d38`) resolves to `UpdateSignaureInfo @ 0x35545a0`.
Installation at `0x355c8f6–0x355c8fd` writes this vptr to the object. RTTI
`0x8e830f8 → 0x8e81cb8`, with the name at `0xcbb844`, identifies its main
base as `nt::IMSFInterface`; this does not identify SessionInit's RDX type.
Bounded direct E8/E9 scans found no direct calls to either target in the
inspected executable section. This directs further work toward virtual or
other indirect calls; it is not an unreachability proof.

One conditional refresh-shaped caller was found at `0x34a4d90`. It uses the
incoming value, or falls back to `this+0x300` when that value is zero; if both
are zero it takes an `uin is empty` callback path. For the current-value
case it clears three local strings at `+0x1c8/+0x1e0/+0x1f8`. With a non-null
receiver from `this+0x90`, `0x34a4ef8–0x34a4f15` allocates exactly sixteen
bytes and explicitly fills them with zero, then `0x34a4f46–0x34a4f5e` invokes
receiver virtual `+0xf0` with the converted identity string, two empty byte
containers and that sixteen-zero-byte container.

Only if this receiver has the observed MSFCoreService binding does that call
reach the refresh method above. Its identity/lifecycle and the containing
function's upstream caller remain unproven. The clears and empty/zero inputs
support a reset or initialization candidate, not successful-session credential
production. No default key or nonzero D2-key derivation is inferred from it.

Further typed entry points remain candidates, not connected producers. Two
lambda type names at `0xbd3215/0xbd32f3` refer to
`NTWrapperSession::internalStartNT(nt::im_core::SessionConfig const&)`.
A separate `NTSessionBase::Init` path at `0x55e71d0` reaches a virtual
`+0x160` call at `0x55e747a`; if its receiver uses the observed SessionForNt
vtable `0x8e15b50`, that slot resolves to `0x29c8fa0`. Neither path has been
linked to `0x354db50`, and SessionConfig has not been established as the RDX
object type. Candidate `0x29fd310` belongs to a StartRefreshLoginTicket
callback and `0x34b0168` to listener dispatch, but neither receiver has been
proven to be the relevant IMSFInterface. None supplies evidence for the
`+0x120` writer or for nonzero key production.

The type-2 request constructor remains separate and unproven. A bounded E8
scan targeting `sendPacket` and its PLT found only the already-known type-1
call at `0x3550e98`. Five ordinary `mov [reg+0x14],2` encoding candidates and
23 `movabs 0x0000000200000000` candidates did not establish another
MSFRequest constructor in their inspected windows. This is not an exhaustive
absence result: it omits other instruction forms, indirect calls and external
modules. Neither notification route above depends on treating those
unidentified objects as MSFRequest instances.

**Send-side key consumption.** The separate builder at `0x67436a0`, named
`CreateRequestBase` by diagnostics, queries the same registry at `0x6743bf1`
and keeps the returned record in R14. It constructs a head through
`0x674396e → 0x67b4a50`, not the default constructor used by SDK `pack`.
At `0x6743e6f` it tests the packet module's command predicate at virtual `+0x40`.
Given the observed vptr, `0x902e980 → 0x6743110` compares the command exactly
against three initial string pointers: `Heartbeat.Alive`, `Heartbeat.Ping`
and `Client.CorrectTime` (`0x9155838/0x9155840/0x9155848`). The resulting
branches are:

| Branch condition | head `+0x18` / Base `+0x0c` | Observed key/framing choice |
| --- | --- | --- |
| Command predicate true | `0 / 0` | Encryption disabled; head `+0x98` cleared |
| Predicate false, low byte of incoming ESI nonzero, record present | `1 / 1` | Base `+0x10` gets record `+0x30`; head `+0x38` gets record `+0x68` |
| Predicate false, low byte of incoming ESI zero | `2 / 2` | head `+0x38` explicitly initialized to sixteen zero bytes |

The record-key path is instruction-level: `0x6743ea9` enables the head,
`0x6743eb1` sets the Base tag, `0x6743eb6–0x6743ebd` copies the outer field,
and `0x6743ec2–0x6743ecd` copies record `+0x68` into head `+0x38`. The zero-key
path is `0x6743eeb–0x6743f03`. This closes a conditional chain from the
already-provided type-2 request `+0xc8`, through the stored record, to the
send head's key input. It does not identify who generated the original value,
prove a 16-byte record key, or make the zero-key branch a fallback for invalid
nonempty keys.

Mode and prefix selection are also conditional. At this call site the mode
passed to the alternate constructor is
`12 + S + 8*(incoming_r8d & 1)`, where S is the 0/1 result of the conditional
`0x675a4c0` (`shouldTrim`) call, otherwise zero. The four resulting modes are
12, 13, 20 and 21; the mode must not be hardcoded to 12 without the caller's
conditions. The builder writes head `+0x15` from a global connection
object's virtual `+0x48` result, retaining unsigned values below 4 and using
zero otherwise (`0x6743a25–0x6743a3d`). The constructor's `+0x16=1` may be
cleared at `0x67439b4` when incoming EDX differs from 4 and the object at
`0x9177de0` returns 1 from virtual `+0x30`.

At `0x6744007–0x6744033`, the builder constructs an output wrapper targeting
Base `+0x28` and invokes head virtual `+0x10` into it. It destroys the head
and returns the CRequestBase object at `0x67440b1–0x67440c5`; that return alone
is not a network send. A nearby field consumer at `0x674636a` belongs to
`CreateNetworkResponseSO`, so its record `+0x68` access is receive-side evidence
and is not substituted for the send-side copy above.

The caller/populator of SDK `pack`'s `+0xc8` input remains unclosed. The selected
ordinary queue route now reaches `CreateRequestBase` and its writers, rather
than demonstrating a call through `pack → 0x676c540`. Shared head serialization
does not make the two constructors' mode, prefix or credential selection
identical. The encrypted-payload API still models only the explicit mode-12
subset; the other head APIs model H for modes 13/20/21, not an entire
transformed payload. None implements the native dispatcher, registry lookup,
dynamic flag selection, credential generation or transport.

Remaining unknowns in this chain: the three producers' exact cryptographic
algorithms (their bodies are control-flow-flattened; the `sign` producer shows
an MD5-like compression over a single `__to_xstring`/`vsnprintf`-formatted
decimal of a 32-bit argument, which is not a proven signer); the signed body's
own upstream content; whether `MSFSign` concatenates command and body
internally; the identity of the gating states and the 32-bit argument; SDK
`pack` caller fields; the ordinary path's actual mode/flags and original
credential production; and the final binding to live transport. The conditional
record-to-key and queue-to-serializer links above do not supply those missing
values. No target step was executed; none establishes real QQ acceptance.

### Static-audit regression checks

The earlier mapping audit passed 40 Protocol tests (including 19 presence-mask
tests) and 17 in-memory Core session tests. The presence tests cover all eight
empty/nonempty combinations against all 256 initial masks, foreign-realm views,
shared/detached/out-of-bounds rejection, and input-accessor isolation. The Core
regression also corrected a test's access to `Bridge.empty` through the narrower
public `BridgeInterface`; the listener now verifies readiness by sending through
that public interface. No runtime Bridge implementation was changed by this fix.

Commands run from the repository root with the pinned Node/pnpm versions:

```sh
pnpm --filter @snowluma/protocol exec vitest run tests/direct/target-sign-presence-candidate.test.ts tests/direct/target-signed-decimal-md5-candidate.fake.test.ts tests/direct/target-sign-structure-result-candidate.test.ts tests/direct/target-sign-structure-integration.test.ts
pnpm --filter @snowluma/core exec vitest run tests/bridge-direct-session.fake.test.ts --silent
pnpm typecheck
pnpm lint
git diff --check
```

These focused tests and the workspace type/lint checks passed. The full test
suite, release build and live QQ interoperability were not exercised by this
audit. The target ELF was only read, not loaded or executed. Passing the local
models does not establish the target's runtime bindings or server acceptance.

The subsequent serializer audit added a
[17-case cross-component regression](<tests/direct/target-sign-reserve-integration.test.ts>)
without adding another production encoder. It compares the existing structure
assembler, named-slot extractor, status-gated native-slot decoder, presence-mask
model and CPB-derived reserve encoder, using the real Proton transform. Fixed
hex vectors cover all eight empty/nonempty combinations; 127/128/255-byte
payloads cross length-varint boundaries. It also checks view offsets, unused
slot bytes, independent output ownership, failed-status gating and the difference
between preserving an arbitrary initial mask and encoding nonempty fields.
This is model consistency, not execution of the newly identified MessageLite
serializer or proof that both native routes are used by a live connection.

The five-file focused run below passed 85 tests; the independent strict test
compilation also passed. Protocol's normal tsconfig includes only source files,
so the latter deliberately checks the newly added test too:

```sh
pnpm --filter @snowluma/protocol exec vitest run tests/direct/target-sign-reserve-integration.test.ts tests/direct/target-sign-presence-candidate.test.ts tests/direct/target-msf-sign-output.fake.test.ts tests/direct/target-sso12-sign-slots.fake.test.ts tests/direct/target-sso12-reserve.test.ts
pnpm --filter @snowluma/protocol exec tsc --ignoreConfig --noEmit --strict --noUnusedLocals --noUnusedParameters --noImplicitReturns --noFallthroughCasesInSwitch --noImplicitOverride --target ES2022 --module ESNext --moduleResolution bundler --esModuleInterop --skipLibCheck --resolveJsonModule --lib ES2022 --types node tests/direct/target-sign-reserve-integration.test.ts
```

The next wrapper audit added
[37 normal-wrapper cases](<tests/direct/target-msf-request-base-candidate.test.ts>),
including fixed vectors for all four modes, self-inclusive lengths, unchanged
payload append, exact size-cap boundaries, invalid inputs, detached/shared/OOB
views, captured-intrinsic behavior and cleanup after an injected failure. Its
comparison with the old service encoder feeds that encoder's synthetic ciphertext
as the new wrapper's opaque B field: it establishes an expressible outer-byte
subset, not equivalent encryption algorithms or native paths.

The six-file combined run passed **101 tests**. Its independent strict test
compilation also passed; `ESNext` library declarations cover the resizable-buffer
test cases, while production sources still pass the repository configuration.
The parent run used Node 24.22.1 and pnpm 11.25.0. Workspace `pnpm typecheck`
and `pnpm lint` also passed, retaining the pre-existing Core/OneBot typecheck
cycle warning. The two new files passed formatting checks, and all eleven local
documentation links resolved. Full workspace tests and release builds were not
run in this pass; no QQ execution, native target loading, Hook, real connection,
commit or push was performed.

```sh
pnpm typecheck
pnpm lint
pnpm --filter @snowluma/protocol exec vitest run tests/direct/target-msf-request-base-candidate.test.ts tests/direct/target-sso12-head.test.ts tests/direct/target-service-business.test.ts tests/direct/target-service-request.test.ts tests/direct/target-service-integration.test.ts tests/direct/target-sign-reserve-integration.test.ts
pnpm --filter @snowluma/protocol exec tsc --ignoreConfig --noEmit --strict --noUnusedLocals --noUnusedParameters --noImplicitReturns --noFallthroughCasesInSwitch --noImplicitOverride --target ES2022 --module ESNext --moduleResolution bundler --esModuleInterop --skipLibCheck --resolveJsonModule --lib ESNext --types node tests/direct/target-msf-request-base-candidate.test.ts
```

The SDK mixed-head pass added
[21 tests](<tests/direct/target-msf-sso12-head-candidate.test.ts>): a fixed
nonzero-prefix vector, comparison preserving the old CPB profile, every possible
`field16` byte, seven field positions, empty/maximum-size cases, input validation
and actual reserve/head/normal-wrapper composition. The composition deliberately
feeds an untransformed synthetic head as B; it does not claim that a live server
would accept those bytes or that the native encryption stage was run.

The seven-file run below passed **131 tests**, including the unchanged QQ-TEA
reference suite. The new test file also passed its explicit strict compilation.
The QQ-TEA test vectors are existing independent reference vectors, not captures
or execution results from the supplied Linux target. Workspace typechecking and
lint, both new files' formatting checks and fourteen local documentation links
also passed. The Core/OneBot typecheck cycle warning is unchanged. This pass did
not run full workspace tests, release builds, QQ, Hook or live network sessions.

```sh
pnpm typecheck
pnpm lint
pnpm --filter @snowluma/protocol exec vitest run tests/direct/target-msf-sso12-head-candidate.test.ts tests/direct/target-msf-request-base-candidate.test.ts tests/direct/target-sso12-head.test.ts tests/direct/target-service-request.test.ts tests/direct/target-service-integration.test.ts tests/direct/target-sign-reserve-integration.test.ts tests/direct/qq-tea.test.ts
pnpm --filter @snowluma/protocol exec tsc --ignoreConfig --noEmit --strict --noUnusedLocals --noUnusedParameters --noImplicitReturns --noFallthroughCasesInSwitch --noImplicitOverride --target ES2022 --module ESNext --moduleResolution bundler --esModuleInterop --skipLibCheck --resolveJsonModule --lib ESNext --types node tests/direct/target-msf-sso12-head-candidate.test.ts
```

The encrypted-payload pass added
[21 composition tests](<tests/direct/target-msf-sso12-payload-candidate.test.ts>):
fixed pre-encryption bytes, empty/raw body behavior, all alignment positions,
real normal-wrapper composition, independent output storage, input mutation or
detachment during the RNG, invalid keys/views/records, ciphertext budgeting,
error sanitization and owned-buffer cleanup after callback failure.

The eight-file combined run passed **152 tests**. The new test's explicit strict
compilation passed after adding a runtime ArrayBuffer check before transferring
fixture buffers; production types were not weakened. The actual existing codec
implementations and Proton configuration were retained. Workspace `pnpm typecheck`
and `pnpm lint` passed, with the same pre-existing typecheck cycle warning. Both
new files passed quality/format checks and all sixteen local document links
resolved. These are synthetic composition tests, not native differential
execution or a live login attempt. Full workspace tests and release builds were
not run; the old head/QQ-TEA sources and production wiring were unchanged.

```sh
pnpm typecheck
pnpm lint
pnpm --filter @snowluma/protocol exec vitest run tests/direct/target-msf-sso12-payload-candidate.test.ts tests/direct/target-msf-sso12-head-candidate.test.ts tests/direct/target-msf-request-base-candidate.test.ts tests/direct/target-sso12-head.test.ts tests/direct/target-service-request.test.ts tests/direct/target-service-integration.test.ts tests/direct/target-sign-reserve-integration.test.ts tests/direct/qq-tea.test.ts
pnpm --filter @snowluma/protocol exec tsc --ignoreConfig --noEmit --strict --noUnusedLocals --noUnusedParameters --noImplicitReturns --noFallthroughCasesInSwitch --noImplicitOverride --target ES2022 --module ESNext --moduleResolution bundler --esModuleInterop --skipLibCheck --resolveJsonModule --lib ESNext --types node tests/direct/target-msf-sso12-payload-candidate.test.ts
```

The subsequent queued-send investigation changed this document only. It
rechecked the supplied ELF's hash, PT_LOAD address translations, key RELATIVE
slots and selected instruction windows, and reran the same eight-file suite:
**152/152 passed**. The sixteen local links and `git diff --check` were checked
again. It did not rerun full workspace type/lint/build checks, alter production
routing, or execute the target client, Hook, account sessions or network I/O.

The registry/key-selection follow-up added one explicit-zero-key regression
to the payload suite: **22 payload tests; 153/153 across the same eight files**.
It checks real encryption/decryption with a caller-supplied sixteen-zero-byte
key, distinguishes it from the nonzero fixture key, and retains rejection of
an empty key. It does not add automatic key selection or a default key.
The changed test passed explicit strict TypeScript compilation, quality lint,
formatting checks, and the complete workspace typecheck/lint commands. The
sixteen local links and whitespace diff check also passed. Full workspace
tests and release builds were not run; no production source was changed and
no target client, Hook, account session or network I/O was executed.

**Trimmed-head and credential-bridge follow-up:** the new suite has **17
passing tests**; the expanded ten-file regression is **184/184**. The increase
over the previous 153-test set is 17 new trimmed-head tests plus fourteen
existing LP4 tests added to this regression selection. The new cases exercise
the fixed 24-byte head vector,
all empty-field combinations, total and per-field boundaries, aggregate cap
rejection before framing, cross-realm shared-buffer rejection, temporary
cleanup, and synthetic real-implementation QQ-TEA/Base compositions for both
13 and 21. A separate read-only source review found no concrete defect; the
aggregate-cap and foreign shared-buffer cases were added after that review.

The final source and test passed quality/format checks and explicit strict
compilation. Full workspace typecheck and lint passed, retaining the existing
Core/OneBot dependency-cycle warning. All eighteen local Markdown links and
`git diff --check` passed. Full workspace tests and release builds were not
run. No client, Hook, account session, target native function or network
connection was executed. Static table checks and byte-layout tests do not
establish credential generation or server acceptance.

```text
pnpm --filter @snowluma/protocol exec vitest run tests/direct/target-msf-trimmed-head-candidate.test.ts tests/direct/target-msf-length-prefixed-field-candidate.test.ts tests/direct/target-msf-sso12-payload-candidate.test.ts tests/direct/target-msf-sso12-head-candidate.test.ts tests/direct/target-msf-request-base-candidate.test.ts tests/direct/target-sso12-head.test.ts tests/direct/target-service-request.test.ts tests/direct/target-service-integration.test.ts tests/direct/target-sign-reserve-integration.test.ts tests/direct/qq-tea.test.ts
pnpm --filter @snowluma/protocol exec tsc --ignoreConfig --noEmit --strict --noUnusedLocals --noUnusedParameters --noImplicitReturns --noFallthroughCasesInSwitch --noImplicitOverride --target ES2022 --module ESNext --moduleResolution bundler --esModuleInterop --skipLibCheck --resolveJsonModule --lib ESNext --types node tests/direct/target-msf-trimmed-head-candidate.test.ts
pnpm typecheck
pnpm lint
pnpm exec eslint packages/protocol/src/direct/target-msf-trimmed-head-candidate.ts packages/protocol/tests/direct/target-msf-trimmed-head-candidate.test.ts
pnpm exec eslint --config eslint.format.config.ts packages/protocol/src/direct/target-msf-trimmed-head-candidate.ts packages/protocol/tests/direct/target-msf-trimmed-head-candidate.test.ts
pnpm exec prettier --check packages/protocol/src/direct/target-msf-trimmed-head-candidate.ts packages/protocol/tests/direct/target-msf-trimmed-head-candidate.test.ts
git diff --check
```

**Mode-20 follow-up:** the new head suite adds **32 passing tests**; the
expanded eleven-file regression is **216/216**. It includes fixed bytes,
signed-decimal boundaries through INT32_MIN, sequence-bit preservation,
per-field and aggregate size limits, decimal-width-sensitive limits, hostile
views/records, temporary cleanup and a synthetic QQ-TEA/Base20 composition.
The digit-pair table was checked directly from the sample, without executing
the native formatter. An independent read-only source review found no concrete
layout, input-isolation or cleanup defect under the stated assumptions.

Explicit strict test compilation, full workspace typecheck/lint and scoped
quality/format checks passed. The existing Core/OneBot dependency-cycle warning
remains. All twenty local document links and `git diff --check` passed. The
full workspace test suite and release build were not run; no QQ client, Hook,
account session, target-native function or network connection was executed.

```text
pnpm --filter @snowluma/protocol exec vitest run tests/direct/target-msf-sso20-head-candidate.test.ts tests/direct/target-msf-trimmed-head-candidate.test.ts tests/direct/target-msf-length-prefixed-field-candidate.test.ts tests/direct/target-msf-sso12-payload-candidate.test.ts tests/direct/target-msf-sso12-head-candidate.test.ts tests/direct/target-msf-request-base-candidate.test.ts tests/direct/target-sso12-head.test.ts tests/direct/target-service-request.test.ts tests/direct/target-service-integration.test.ts tests/direct/target-sign-reserve-integration.test.ts tests/direct/qq-tea.test.ts
pnpm --filter @snowluma/protocol exec tsc --ignoreConfig --noEmit --strict --noUnusedLocals --noUnusedParameters --noImplicitReturns --noFallthroughCasesInSwitch --noImplicitOverride --target ES2022 --module ESNext --moduleResolution bundler --esModuleInterop --skipLibCheck --resolveJsonModule --lib ESNext --types node tests/direct/target-msf-sso20-head-candidate.test.ts
pnpm typecheck
pnpm lint
pnpm exec eslint packages/protocol/src/direct/target-msf-sso20-head-candidate.ts packages/protocol/tests/direct/target-msf-sso20-head-candidate.test.ts
pnpm exec eslint --config eslint.format.config.ts packages/protocol/src/direct/target-msf-sso20-head-candidate.ts packages/protocol/tests/direct/target-msf-sso20-head-candidate.test.ts
pnpm exec prettier --check packages/protocol/src/direct/target-msf-sso20-head-candidate.ts packages/protocol/tests/direct/target-msf-sso20-head-candidate.test.ts
git diff --check
```

## Target QR-login command surface (verified strings)

The supplied build's own strings confirm, as direct observations rather than
reference inference, that it contains the WTLogin/QR machinery: command tokens
`wtlogin64.trans_emp` (`0x883394`), `wtlogin.trans_emp` (`0x9f3a1b`),
`wtlogin.qrlogin` (`0xab65a5`), `wtlogin.exchange_emp` (`0xa80273`),
`wtlogin64.login`/`wtlogin.login`, `wtlogin.register`, `wtlogin.exchange`,
`wtlogin.device_lock`, `wtlogin64.name2uin`, `StatSvc.register` (`0x928e6c`),
`SsoInfoSync` (`0xa6368c`), `Heartbeat.Alive` (`0xa5864a`) and
`ConfigPushSvc.GetIpDirect` (`0x976625`), plus the ECDH-access commands
`trpc.o3.ecdh_access.EcdhAccess.SsoSecureA2Establish`/`SsoSecureA2Access`/
`SsoEstablishShareKey`. Internal source-path strings name the owning modules:
`wtlogin_ecdh_session.cc`, `wtlogin_ecdh_key.cc`, `wtlogin_session_tgtgt.cc`,
`wtlogin_resp_tlv_process.cc`, `wtlogin_pkg.cc`, `qrcode_login_session.cc`,
`qrcode_login_request_impl.cc`, `qrcode_tlvs.cc` and `qrcode_cmd.cc`, with a
build identity `nt.wtlogin.0.0.1` and log strings such as
`Quick login to get qrcode pic. decoder.qr_url: {},query_time: {}, expire_time:
{}` and `Start to poll qrcode avatar`. This establishes that the QR-login command
names and module layout exist in this build and broadly align with the reference
flow's command surface; it does not recover their subcommand values, TLV layouts,
key-exchange parameters or signing, which remain the work below.

The string `qrcode_cmd.cc` is referenced by `lea rsi,[0xa2af7f]` at
`0x345370c`. The nearby `lea r8,[0x8c3504]` at `0x345371a` refers to the
literal `QRCode CMD0x12 Decode result code: {}`. These static references suggest
an associated decoder/logging path, but they do not independently establish
runtime reachability, a transmitted subcommand or whether `0x12` is QR polling.
Other strings in the same read-only segment mention ECDH key generation and
`ptlogin_socket write ssl_hello`; their proximity in the file does not tie them
to the QR path or prove which transport, curve or envelope a QR request uses.
Neither the target's QR-generation nor polling subcommand is established solely
by these strings; the `0x31`/`0x12` values above remain reference observations.

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
   association, reconnect and unsolicited event handling. The inspected
   `MSF::MSFSDK::sendPacket` (`0x670dd20`) path conditionally uses `lock xadd`
   and updates the request's first dword; a sequence allocator is a candidate
   interpretation. `MSF::MSFSDK::pack` (`0x670e0c0`) copies request strings into
   a local object and calls `0x676c540`. Its `ReserveFields`/`SsoSecureInfo`
   serialization and conditional handoff into outer member `+0xe0` are described
   above. The mode-12 head at `0x67b4f50` has a distinct mixed prefix and a
   final optional compression/encryption stage; `0x67b4440`'s normal wrapper
   appends the already-built payload rather than encrypting it again. The new
   mixed-head model preserves that header distinction. The selected `context[8]==0`
   encryption branch is now statically matched to the reference under explicit
   key, memory, length and random-byte assumptions; actual key/prefix selection,
   other cipher branches, native decryption and special-path execution remain open.
   The logging call at `0x355ce90` is not a dispatcher, and format strings do not
   establish template-driven serialization. Dynamic bindings, actual envelope
   bytes and the end-to-end network path remain open.
3. Establish the signing inputs and signing implementation for the required
   commands; an external signing API contract alone is not the algorithm. The
   [reference signing whitelist](https://github.com/LagrangeDev/Lagrange.Core/blob/fe789c4a23796fbc82fa09e70a9c44c8a5cf2948/Lagrange.Core/Common/BotSignProvider.cs)
   includes key exchange, `wtlogin.trans_emp`, `wtlogin.login`, and
   `SsoInfoSync`; it does not establish this build's signing behavior. Static
   reversing of the selected build has identified the orchestrator `0x6856284`
   as this build's `MSFSign` (called from `MSFSecuritySignCallback` in
   `msf_security_sign_callback.cc`), which fills a caller-provided 0x300-byte
   out-parameter with token at `+0x00`, extra at `+0x100` and sign at `+0x200`,
   each length low byte at `+0xff`/`+0x1ff`/`+0x2ff`, from callees `0x6830c58`,
   `0x683fa74` and `0x68418ac`, then returns the three fields as `std::string`
   token/extra/sign in the callback result object. Its inputs are also
   observed at the `0x3523110` caller: a string argument, the bytes selected by
   a `{begin,end}` descriptor, and a 32-bit value reach the direct call at
   `0x352329a`. RTTI identifies the candidate callback type as
   `nt::internal::MSFSecuritySignCallback` with base
   `msf::embedder::security::SecuritySignCallback`. A separate caller at
   `0x35505a0` invokes a virtual slot through `this+0x70` and copies the three
   results to request members `+0xf8/+0x110/+0x128`, conditionally named
   sign/token/extra. Linking that invocation, its request owner and the later
   `pack` path requires unresolved runtime identity and no intervening mutation.
   Independent serializers now establish fields 1/2/3 inside outer field 24;
   this conclusion comes from tag-writing instructions, not the presence bits
   alone. Complete algorithms, the body's upstream content, command/body
   composition, full envelope encoding and live acceptance remain unverified. The offline
   `assembleTargetSignStructureCandidate`, `placeTargetSignedDecimalMd5SlotCandidate`
   and `placeTargetO3EmptyExtraSlotCandidate` model only that fixed byte layout
   and the two conditional slot writes; they are cross-checked against each other
   but still require, as unknowns: the actual sign value (the `0x68418ac` path
   shows an MD5-like compression over a single formatted string of a 32-bit
   argument under two state gates and is not a proven full signer; its formatter
   is `__gnu_cxx::__to_xstring` over `vsnprintf` with `%d` at correctly mapped
   VA/file offset `0xbbc99c`, so the bare-decimal
   `targetSignedDecimalMd5Candidate` models the conditional signed-decimal
   intermediate but is not demonstrated byte-equivalent to the complete target
   path), the real extra bytes beyond the
   inspected empty-body `0a 20 || G[0x28:0x48]` branch, the runtime token lookup
   key (a singleton `+0x60` field resolved at construction, bytes unknown), the
   identity of the gating states and the formatted 32-bit value, and whether the supplied
   file-signature ZIP implements this callback. None of these establishes a
   byte-exact signer or that a real QQ server accepts the output.
4. Implement and test account-isolated session lifecycle and a real
   `PacketSender` adapter; integrate with Bridge without inventing a QQ PID.
5. Independently compare encoded bytes with the target build and verify an
   actual user account session and delivery. Keep credentials and captures out
   of the repository.

## Local signer and live-login integration work

The operator selected a locally implemented signing service rather than a
public signing endpoint. The new path has two distinct parts:

- [Python worker and deployment contract](../../tools/local-qq-sign/README.md):
  a separately started Linux process calls the fixed build's native entry.
  It is an independently written loader/protocol, **not** an independent
  reimplementation of the signing algorithm. No QQ desktop, process injection,
  public signing endpoint or HTTP listener is used by this worker.
- [Node process adapter](./src/direct/local-qq-sign-worker.ts): an explicit
  subprocess owner implements the existing signing callback, with a bounded
  single-in-flight queue, whole-request deadlines, checked worker identity
  declaration and actual child-close observation. The declaration is not remote
  attestation. An initially anonymous UIN `0` may bind once to the confirmed
  positive UIN while idle; later cross-account use fails.

Neither part is automatically started by Core. The existing default Hook path,
OneBot v11 behavior, Jiyu identity and default WebUI remain in place. Native
component invocation is a separate evidence category from both pure algorithm
reconstruction and a QQ server accepting a signed request.

### Native ABI and input provenance

The selected DEB and ELF digests were rechecked before extracting only the
required local component inputs. The package metadata again declares
`3.2.35-54395`, `buildVersion=54395`, `platform=linux`, `eleArch=x64`, and
`appid.linux=537391511`. That last property alone does not establish every
WT/SSO profile field.

| Input | SHA-256 |
| --- | --- |
| Main ELF | `dc5209e20002735e31a20c9cded0a807d1db4779277dec66c9221ea28a870328` |
| Bundled Bugly library | `b4c78ae60326e7c68b9f026d5c43a8db1ad19ab4069a11a3468a498b9ee8599d` |
| Bundled vips C++ library | `994c562dc1242f07ce62c0c918bd4e49eebf5bb7a0e34726892a4c79ddab3399` |
| Bundled crbase library | `5c4ef5b297291301eb40c4ae48d31083830132b146bac3c21a68e080ec71fc8e` |
| Bundled x86-64 unwind library | `ffd57d6f0a4e902278f2f33d88247b7661f7bd03bd300733db3193d51cd98f7b` |
| Bundled base unwind library | `7466ebba89873fa3a959ae0a14c824140df82a8ebba40bc1c3808acbc5eab76b` |
| Bundled ssh2 library | `b18f774efaf7e074338133ec9ae93dd3a94fb33ff2aa1eedbf4d5b45172d8e23` |
| Package metadata | `68f4d6c83c396ca90fde51af1fdf4eafb40b20bd7151bc187c4128194d5afa7f` |

The first dynamic-load attempt returned `dlopen-failed`; a separate bounded
loader diagnostic identified missing `libcrbase.so`. This was a staging error:
looking only at the main ELF's direct dependencies omitted dependencies of
Bugly. A recursive `DT_NEEDED` inventory recovered the four additional bundled
libraries above from the same pinned DEB, not substitute system implementations.
The resulting closure contains seven bundled ELFs (including the main ELF) and
16 system-library names. All seven file hashes and all 16 system-library loads
were then checked before repeating the native test.

A fresh aligned disassembly of the caller at `0x3523110` confirms the five
SysV inputs at `0x352329a`: command pointer, body pointer, 32-bit body length,
32-bit value and output pointer. The worker preserves that fourth argument's
u32 bits and names it `sequence`, matching the external service contract. The
target is `0x6856284`. The callee's `[rsp+0x1a8]` is the saved return address, not
a sixth argument.

Subsequent static review corrected the earlier `module_id` attribution: the
complete format at rodata `0xa2b404` is `MSFSign failed, module_id:{} data:{}`.
The call sequence at `0x35232a5–0x35232e5` supplies a command-string copy and the
body length to that logger, not `r12d`. Its formatter consumes the first as a
libc++ string and the second as an integer. Thus `module_id` labels the command
here, not the native call's fourth argument.

Independent upstream data flow supports the sequence interpretation:
`SendMsfRequestInternal` retains its second argument at `0x35505bb`, labels
that value `seq` in another diagnostic, stores it in the request's first dword
at `0x35507b7–0x35507bc`, and reloads it into `r8d` at `0x3550814` before virtual
dispatch. If that dispatch selects the identified callback, it becomes
`r12d`, then `ecx` at the native call. Both examined standalone implementations
also pass request sequence, not a fixed zero: [Micuks sign.py](https://github.com/Micuks/ntqq-sign-server/blob/a2f4346e3a25f4a39a42ef3e618da2a019a9f983/sign.py#L276-L281)
and [nimeng main.rs](https://github.com/nimeng1299/SignServer/blob/c0b515853d6f8de5b28c757d4cdccb8e145f8dc9/src/main.rs#L63-L70).
This supports retaining the current sequence contract; it does not by itself
prove the specific live QR packet's complete field mapping or server acceptance.

The loader verifies the entire ELF digest and the file-backed executable
range before loading, then obtains the load bias through `dlinfo` for that exact
handle. It uses the already verified file descriptor and no offset scanner.
The helper's no-op registration symbol does not implement a QQ/N-API host.
The executable and dependencies still execute native code; per-process
isolation, fixed output framing and canaries are not a proof about all native
side effects. Library lifetime ends with the dedicated process rather than an
unverified in-process unload.

### Correct first-login reference chain

The current
[Core V2 reference state machine](https://github.com/LagrangeDev/Lagrange.Core/blob/e1bd4baa16fa86ef000154e3eecb7816a29b63a7/Lagrange.Core/Internal/Logic/WtExchangeLogic.cs)
uses the following initial-QR path:

```text
wtlogin.trans_emp / OICQ 0x812 / code2d 0x31
  -> poll code2d 0x12 with the same ECDH/random-key context
  -> confirmed UIN, temporary A1, NoPicSig, TgtgtKey
  -> wtlogin.login / OICQ 0x810 / subcommand 0x09
  -> decrypt the ticket block and obtain D2, D2Key, A2, A1, UID
  -> SsoInfoSync using D2/D2Key
  -> online only after the registration business result succeeds
```

KeyExchange/EasyLogin is the cached-A1 recovery branch, not the empty-session
QR entry. The reference signs the complete service payload (the OICQ envelope)
before wrapping SSO. Its QR and login requests use protocol 12 with encryption
type 2 and a zero TEA key; registration switches to D2 encryption. These are
[reference packet-construction facts](https://github.com/LagrangeDev/Lagrange.Core/blob/e1bd4baa16fa86ef000154e3eecb7816a29b63a7/Lagrange.Core/Internal/Context/PacketContext.cs),
not evidence that this target build accepts the same profile.

Two similarly named fields have different meanings: the local QR context's
`ssoVersion: string` maps to the reference's full `CurrentVersion`, whereas
QR fetch fields' `ssoVersion: number` maps to its numeric SSO version. The
[reference SSO writer](https://github.com/LagrangeDev/Lagrange.Core/blob/e1bd4baa16fa86ef000154e3eecb7816a29b63a7/Lagrange.Core/Internal/Packets/Struct/SsoPacker.cs)
and [reference app profiles](https://github.com/LagrangeDev/Lagrange.Core/blob/e1bd4baa16fa86ef000154e3eecb7816a29b63a7/Lagrange.Core/Common/BotAppInfo.cs)
show the distinction. The latter currently declares Linux `3.2.26-46494`, not
this sample's build; its numeric fields must not silently overwrite the sample.

The 21-byte code2d reserved field and 12-byte login TLV 0x124 are `Skip` regions
in that reference. Its `Skip` merely advances a position, so the source does
not prove a fixed value for either region. Explicit zero filling is a local
deterministic policy, not a captured server-approved default.

### Validation checkpoint

- Parent rerun: `python -B -m unittest discover -s tools/local-qq-sign -p test_worker.py`
  passed **92/92** fake-backend/FFI tests. Importing and these tests do not load
  the target, invoke its signing function, or send login traffic.
- Parent rerun: the new Node adapter's **49/49** real-subprocess fixture tests,
  the existing reserve builder's **23/23** tests and its **1/1** integration test
  passed together (**73 tests across 3 files**). The subprocesses in these tests
  are synthetic Node workers, not the QQ native component.
- Explicit strict TypeScript compilation included both the new source and test
  file and passed. Full workspace `pnpm typecheck` and `pnpm lint` passed; the
  pre-existing Core/OneBot typecheck dependency-cycle warning remains. Full
  workspace tests and release builds were not run for this checkpoint.
- Local link checks passed for this document and the worker guide,
  and `git diff --check` passed.
- The native-input staging step rechecked the source DEB and main ELF digests,
  preserved the original inputs, and recorded the three dependency/metadata
  digests above.
- The separate local Linux environment passed its dependency checks, compiler
  execution and stop/restart checks: Debian 12 x86-64, Python 3.11.2, GCC 12.2,
  glibc 2.36, using QEMU TCG. WSL, BIOS and Windows optional features were not
  changed. The main session owns the live guest; a child-session job was found
  absent at handoff and was replaced by a main-session-owned start of the same
  verified overlay, followed by another complete dependency check.
- The Python suite also passed **92/92 on Linux**, and the small host-symbol
  helper compiled successfully there.
- **Actual native execution passed** under a non-root UID in a network namespace
  containing only loopback. The exact verified ELF was loaded and called for
  `wtlogin.trans_emp` (sequence 1, four synthetic body bytes),
  `wtlogin64.trans_emp` (sequence 2, four bytes), and `wtlogin.login`
  (sequence 4, eight bytes). Each returned **48 sign bytes, zero token bytes and
  zero extra bytes**. An intervening NUL-containing command was rejected without
  a native call. Ready framing, all four response IDs, nonempty sign checks and
  process exit code 0 passed; the run took 5.346 seconds including startup.
- **The real Node-to-native path also passed**: the new process adapter launched
  SSH to that same local guest, used the network-isolated Python worker, queued
  the two QR command variants, bound an idle synthetic UIN from `0` to `10001`,
  rejected further use of `0`, and signed a login command. All three native
  results again had lengths `48 / 0 / 0`. Explicit close observed the SSH child's
  actual `close` with `SIGKILL`; a subsequent guest process check found no
  remaining worker processes. This is not a claim that killing an arbitrary
  local child always terminates its descendants.
- These body bytes and the UIN above are **synthetic inputs**, not a real login.
  A nonempty native result does not prove that the command's body, profile,
  sequence mapping or signature is acceptable to QQ. In particular, the empty
  token/extra fields are observations for these inputs, not assumed universal
  requirements.
- These native-only tests did not obtain a QR or confirm an account. Later live
  reference/probe observations are recorded below; delivery and receiving still
  require separate end-to-end validation.

### Explicit runner and first service observations

The separate [direct login probe](../../tools/direct-qq-login/README.md) now
composes the existing WT/multiplex owner, one observed TCP connection, the
local signing adapter and explicit candidate configuration. Importing/building
it does not log in. It preserves the same connection and keys from fetching
through registration, waits for acquisitions and actual resource closure, and
never sends a message automatically. This is not a Core/WebUI/OneBot backend
integration. Its short online hold has no heartbeat scheduler yet.

The candidate's target-metadata fields and reference-derived assumptions are
separately labeled. Linux PC reserve `msgType` and `ntCoreVersion` are omitted,
not filled with Android's 32/100. The fixed Core default whitelist contains all
three configured commands: `wtlogin.trans_emp`, `wtlogin.login` and
`trpc.msg.register_proxy.RegisterProxy.SsoInfoSync`; neither UIN zero nor
EncryptEmpty bypasses that classification. See the [fixed whitelist](https://github.com/LagrangeDev/Lagrange.Core/blob/e1bd4baa16fa86ef000154e3eecb7816a29b63a7/Lagrange.Core/Common/BotSignProvider.cs#L540-L598)
and [call site](https://github.com/LagrangeDev/Lagrange.Core/blob/e1bd4baa16fa86ef000154e3eecb7816a29b63a7/Lagrange.Core/Internal/Context/PacketContext.cs#L49-L63).

The first live fetch reached a connected QQ gateway but ended without a QR.
A second fresh attempt, with bounded transport diagnostics but otherwise the
same candidate, recorded one write call / 619 socket write bytes, **zero
socket read bytes and zero complete response frames**, then `raw-cancelled`
at the WT transaction deadline. The native signing worker had started, and
resource closure completed. Two further single-attempt checks used the other
IPv4 address returned by the same gateway's DNS, and the wrapper directory as
the native process working directory, respectively. Both again recorded
`619 / 0` write/read bytes and no complete response. The host clock was also
within two seconds of the QQ website's HTTPS Date header. These are no-response
observations, not server rejection codes or proof that the signature was
rejected. No phone confirmation was requested. The protocol-12 outer and inner frame field order was compared
again with the fixed reference; no discrepancy was established by that check.

The added diagnostics keep only a closed vocabulary of close reasons and
numeric counters, not bodies or credentials. Node write counters may include
locally queued bytes and do not prove remote receipt. Both the outer WT deadline
and the inner raw deadline exist; either may settle first, so a silent peer can
produce `raw-cancelled` or `raw-timeout`. The probe regression suite now passes
**12/12**, including this diagnostic case and the previous same-connection,
registration-failure, cancellation and drain tests. Strict probe typechecking,
quality lint, formatting and the Proton-enabled build also pass.

A narrowed optional `ServiceFrameDecoder` limit was added for this connection:
its default stays 16 MiB, while the probe requests 2 MiB and rejects an oversized
length prefix before frame allocation. The six relevant existing protocol
suites pass **190/190**, including new limit boundaries, plus explicit source/test
strict typechecking and targeted lint. Those initial no-response experiments
alone did not establish live QR fetching, account login or interoperability.

### Differential reference execution: outbound width and QR terminator

A separately built, pinned Core reference client using the same candidate profile,
GUID and local Linux signing process obtained a real QR response: 627 outbound
bytes, 975 inbound bytes, SSO return code zero and a 604-byte QR PNG. It closed
without polling, account confirmation, login, registration or messaging. The
reference build and its instrumentation remain private research artifacts, not
copied implementation code in the shipped protocol.

Comparing actual encoder output located a concrete outbound defect. The OICQ
fixed request header is **28 bytes**, not 26: the reference writes a four-byte
`retryTime` after the two-byte client version. The previous implementation left
only two bytes before its ECDH head. The shared encoder now explicitly writes
uint32 zero at offset 24, starts the encryption head at 28 and includes the two
bytes in the total length. This fixes both 0x810 and 0x812 outbound frames, not
the asymmetric inbound header. Independent complete-header and length-limit
regressions were added; the 32 affected WT/fixture-consumer test files passed
557 tests, and the runner's then-current 12 tests passed.

There is also a separate explained protobuf presence difference: the reference
encodes empty UID (three bytes), token and extra (two bytes each); the existing
Proton schema omits these defaults. With only the OICQ width fixed, Jiyu's own
619-byte request received a 975-byte response, so those seven omitted bytes are
not the cause of the original no-response result. No blanket protobuf-presence
change was made.

The next failure was reproduced inside Jiyu's own response parser. A debugger
attached only to that standalone Node process, not a QQ desktop process, observed
`RangeError: trailing WT TLV bytes`. A bounded inspection at that exception found
count=3, inputLength=727, consumed=726 and exactly one remaining byte, `0x03`.
This provides runtime evidence for the previously unresolved Code2d terminator.

The generic Code2d decoder continues to preserve its raw remainder, and the TLV
decoder still requires exact consumption. Instead, the explicit attempt slice
callback now also receives an optional final decoded byte. The Linux probe policy
requires `0x03` before excluding exactly that one byte for fetch/poll; it preserves
the existing login-body range. Its synthetic replies now model this marker, and
missing, wrong or duplicate marker cases are covered rather than accepted by a
permissive TLV decoder. After that correction, Jiyu obtained a real QR and a
waiting-scan poll response (two writes/two frames). The same complete path was then
run inside Linux with Node 24.22.1 and a directly spawned local native signer:
1078 bytes written, 1190 read, with successful QR/poll parsing before intentional
cancellation. Neither bootstrap experiment authenticated an account.

### First phone confirmation and login TLV dictionary semantics

A subsequent user-operated Linux session reached actual phone confirmation and
received a state-zero login response. Its TLV 0x119 decrypted successfully, but
the local login decoder rejected a repeated tag inside the decrypted TLV list.
The session closed before registration; this is not an online or delivery result.

The pinned Core `ProtocolHelper.TlvUnPack` explicitly assigns `tlv[tag] = data`
while reading in order. Its rule is deterministic last-value-wins, not rejection
of all duplicates. The login-local projection now follows that dictionary rule,
wiping each replaced owned value. The generic TLV decoder still validates the
entire block before projection. A malformed final credential value is rejected;
the decoder never falls back to an earlier value that happens to parse. QR TLV
rules are unchanged. Subsequent user-confirmed Linux runs completed ticket
projection, UID extraction and the exact successful registration response, and
emitted `online`.

The fixed reference has distinct `InfoSyncPush` and `PushParams` startup
notification services. After adding these to the explicit push-command set,
a live Linux run received both, completed `SsoHeartBeat` successfully and received
an exact `Heartbeat.Alive` response. A metadata-only diagnostic then identified
the next rejected frame as `ConfigPushSvc.PushReq`, protocol 13 with D2
encryption. No account key or message body was needed for that diagnosis.

The [fixed command/protocol mapping](<src/direct/wt-reference-push-commands.ts>)
now accepts the first three notifications only with protocol 12 and the observed
configuration notification with protocol 12 or 13. All retain the same D2,
account, key-state, raw-association, queue and body limits; unknown commands are
not accepted generically. Configuration bytes are delivered opaquely only to
an opted-in callback, not interpreted as chat or automatically acknowledged.
The fixed Core reference has no corresponding handler and its default
unhandled-service path logs without disconnecting or sending a default reply;
that source behavior does not establish whether a particular server response
requires acknowledgement. The configuration fix has passed offline regressions;
sustained operation and the requested friend/message action remain live
validation steps, not established by the successful heartbeat alone.

### Experimental Linux outbound friend requests

The registered [multiplex owner](<src/direct/wt-multiplex-reference.ts>) now exposes
`friendRequest`. This is a low-level opt-in API; it does not introduce a OneBot v11
action, replace the default WebUI, or create a second connection. The fixed
commands are `OidbSvcTrpcTcp.0x7c1_1` (settings) and
`OidbSvcTrpcTcp.0x7c2_5` (application). Both must be explicitly included in the
local signer's command policy. This is the native Linux V2 protobuf route, not
the older Android JCE `friendlist.addFriend` route.

[Request codecs](<src/direct/linux-friend-request.ts>) use unsigned 64-bit UINs and
the native UIN envelope mode. Query version is fixed at 1, matching the supplied
Linux client's `getBuddySetting` object and the native uint32 tag-1 setter.
Sources remain caller-explicit. The native Node input path materializes omitted
`addSetting`, `groupId` and `cardSwitch` as **present zero values**; the request
codec now preserves those defaults instead of omitting tags 3, 5 and 20.
Other optional fields preserve explicit zero, false and empty values, while
missing values stay absent; unknown device fields and fabricated UID
conversions are not used. [Response codecs](<src/direct/linux-friend-response.ts>) retain field
presence, signed business results and repeated UTF-8 questions. Opaque response
buffers have explicit ownership and disposal; owner results expose only their
presence and lengths.

Static decoding of the matching Linux client's V8 caches established these
specific UI conventions:

- For ordinary numeric-UIN search, the source pair is **1 / 3**. The client
  explicitly uses its `WINDOWS` table even in this Linux package. Its `qid` table
  key is selected by the non-phone branch, not by a separate QID identity check.
- Settings are passed through into `addFriendSetting`: AllEveryone=0,
  NeedVerify=1, RefuseEveryone=2, NeedAnswerQuestion=3,
  NeedAnswerQuestionAndAudit=4, AfterAnswerQuestionCorrectly=100,
  FriendAlready=101 and RefuseFameFrd=102. These are decoded assignments, not
  values inferred from string order.
- The query UI checks the **outer native callback result**, not its inner
  `rsp.result`. Accordingly, the owner preserves the query's inner result but
  does not require it to equal zero.
- The application UI's success branch requires outer success, a response
  object, `rsp.errorCode===0` and `rsp.result===0`. This is an application-result
  test, not proof that the recipient saw or accepted the request.
- The native-call object uses `myAllowFlag=1` and `showMyCard=1` (wire
  `cardSwitch`, tag 20). The latter must be explicit when following the UI;
  the Node missing-argument default is 0, not 1. An explicitly empty verification
  form yields empty answer text and group 0; the normal populated desktop form
  may instead construct a nickname greeting. The API does not invent that
  greeting or enable `autoSend`. The five examined caches do not establish
  `autoSend` semantics. Their friend-call object omits token/sig/srcFlag rather
  than initializing these fields to empty or zero.

The [finite owner workflow](<src/direct/wt-reference-friend-flow.ts>) accepts:

```ts
// The caller supplies the chosen target and operation intent.
const settings = await owner.friendRequest({
    mode: 'inspect',
    peerUin: TARGET_UIN, // bigint, never a signed-32-bit coercion
    sourceId: 1,
    sourceSub: 3,
    timeoutMs: 20_000,
    maxResponseBodyBytes: 65_536,
});
```

`inspect` performs only the settings query. `apply` additionally requires explicit
`expectedSetting` and `application` fields and **requeries under the same gate**.
It stops without an application on an OIDB error, nonzero inner error code,
missing/mismatched setting, conflicting returned peer UIN or nonempty questions.
It never treats `isContactFriend` as proof of existing QQ friendship. The
application fields are not automatically derived from arbitrary setting values.

Both steps share one deadline bounded by the lease, with fresh child-run
identities and fixed step/command bindings. Signer-provided commands do not
select the route. A write with an uncertain outcome is not retried. Public
results are `settings`, `not-applied` or `application-response`; transport
failures preserve the stage, attempted flag and write state. `application-response`
means a correlated response was decoded, including possible business errors,
not that friendship exists. Push callbacks are deferred across the whole gate,
and final cleanup/revocation checks precede result delivery.

The initial focused integration matrix passed **74 files / 1544 tests**, including 66
codec and 56 friend-workflow tests; the latter reproduce the erroneous query
inner-result gate before its correction. These are offline results.

A subsequent explicit Linux test sent **one** application on the authenticated
connection. Both the fresh settings check and a later read-only check returned
setting 0. The application response had explicit result 0, errorCode 0,
friendSetting 0, myAllowFlag 1, groupId 0, and present-but-empty sig and verify.
No chat was sent. However, the operator reported that neither a received
application nor the target in the sender's friend list was visible. Therefore
**that initial response did not establish end-to-end friend addition**; it is not
promoted to a completed friendship. A later explicitly requested attempt and
recipient confirmation are recorded below.

The recovered UI classifies setting-0 success as a direct add, but that is local
UI categorization, not an independent membership query. Its success callback
does not issue a second application. The settings endpoint does not replace a
friend-roster query. No application was replayed to diagnose this discrepancy.

The same live session accepted `ConfigPushSvc.PushReq` on protocol 13 and
completed 39 Alive replies before a later `frame-rejected` closure. The original
diagnostic stopped after its first 32 non-login frames and did not retain the
closing frame; this is not evidence that the closure caused the earlier
friend-state discrepancy. Private diagnostics now retain the latest 32
non-login frame-header records rather than stopping permanently at the first
32 records. The regression uses synthetic
frames, including late rejection and mismatched heartbeat headers, without QQ
traffic.

A subsequent **read-only** Linux session captured the actual rejected command:
`ConfigPushSvc.PushReq`, protocol 12, D2, with the registered account binding
matching the outstanding request. The former protocol-13-only mapping rejected
this variant. The fixed command now accepts 12 and 13 in both routing and body
decoding, while the other three push commands remain protocol-12-only. A
red-first synthetic reproduction, 59 command/ownership tests, the 74-file
1551-test integration matrix, 29 real-loopback runner tests and strict test-file
typechecking passed for this transport change. This explains that session's
closure; it does not establish the cause of the missing friendship.

The diagnostic's rolling window now records every non-WT header. The private
classifier projection has no business `retCode`, so the observer does not infer
a healthy heartbeat from a missing value. A production-shaped synthetic run
with 140 frames retains the latest 32 and the final rejection, with 12 checks
passing and no QQ traffic.

The operator subsequently requested exactly one additional application, with
account persistence enabled first. That request received `result=1/errorCode=170`
and the server text “好友添加请求已发送，需对方确认。”. The operator then
confirmed that the recipient **received and accepted it**. No chat was sent and
no further application was replayed. The private diagnostic's `nativeUiAccepted`
zero/zero predicate was false; it was not a delivery or friendship predicate.

After that acceptance, the observed connection closed on the exact known
`trpc.msg.olpush.OlPushService.MsgPush` command using protocol 13, D2, while
registered and with no pending request. This newly observed variant is distinct
from the previous ConfigPush fix. The exact MsgPush command now accepts both
12 and 13, while InfoSyncPush and PushParams still require 12. Account, D2/key,
raw-frame, body, queue and lifecycle constraints are unchanged. A red-first
reproduction failed 12 of 129 mux/restored cases before the mapping fix; the
subsequent complete matrix passed **64 files / 1289 tests**. The tool suite passed
**288 tests**, including QR registration and idle restored-owner MsgPush13 delivery.

### Opt-in credential checkpoint and separate restored owner

The [persisted-session codec](<src/direct/wt-persisted-session.ts>) defines the
version-1 binary DTO `{ version, uin, uid, guid, tickets: { d2, d2Key, a1, a2 } }`.
Its encode/decode/clone operations validate canonical positive uint32 UINs,
strict UTF-8, fixed 16-byte GUID/D2Key and bounded nonempty tickets. They copy
borrowed inputs; `disposeWtPersistedSession` erases owned byte arrays. A decoded
DTO is not a proven live QQ identity. It is never a fake QR confirmation.

The existing [reference session](<src/direct/wt-reference-session.ts>) accepts an
optional `checkpoint: { timeoutMs, save(snapshot, context) }`. The snapshot is an
independent borrowed copy. The callback runs only after the real registration
response and key-capability commit, and must finish before success is exposed.
While it waits, public state remains `login-register` or `restore-register`.
The callback receives a session-scoped `AbortSignal` and `isCurrent()` guard;
the old, completed QR-attempt signal is not reused. Close, failure and deadline
expiry revoke the guard and erase the borrowed snapshot. External storage must
copy what it owns, honor the guard and implement its own durable I/O barrier.
No callback is installed by default.

`createWtRestoredMultiplexReference(stream, options)` creates a **new** owner,
origin, reservation and connection lease. `options.transportUin` must equal
`options.session.persisted.uin`. The session options include the DTO,
`profile: { subAppId, version }`, registration metadata, transaction and restore
timeouts, signal, reserved-header builder and raw-response verifier. Its
`restoreAndRegister()` performs the existing SsoInfoSync exchange using the saved
D2/D2Key/A2 and the UID from the DTO. Only a correlated successful registration
activates the shared send/heartbeat/Alive/friend-request gate. The returned owner
has no QR fetch/poll/login methods; failed restore does not fall back to QR,
renew A1, replay a write or erase stored credentials.

The [Node tool adapter](<../../tools/direct-qq-login/account-persistence.ts>) and
[Linux vault](<../../tools/direct-qq-login/account-vault.ts>) implement optional
storage, not the protocol package. The vault uses authenticated AES-256-GCM,
independent key and data roots, account/profile/device binding, process flock,
revision CAS, temporary-file fsync, atomic rename and directory fsync. Normal
close preserves ciphertext. It reports commit uncertainty rather than treating
rename alone as a completed durable save. The [tool guide](<../../tools/direct-qq-login/README.md#加密账号保存与显式恢复>)
documents explicit save/restore flags and stable-data requirements; the original
JSON configuration and memory-only call remain valid.

Initial protocol validation for this addition passed **64 files / 1247 synthetic
tests**, including 20 DTO and 28 restored/checkpoint lifecycle cases. The cases
cover two accounts, genuine codec exchanges, rejected registration, no fake QR
provenance, post-restore activity, callback races and owned-buffer cleanup.
Strict protocol typechecking explicitly included the new tests. Separate Node
vault and adapter tests exercise file/guard/CAS behavior, including actual Linux
process locks and crash points. These are distinct from real QQ verification. A subsequent real QR registration
completed the guarded encrypted checkpoint before online and before the second
friend application. The private ciphertext and separate key files had the
expected ownership and 0600 modes.

**Saved-ticket restoration against QQ subsequently passed live validation** in
a fresh Node process and fresh local signing process. The observed sequence was
store open/load, connect, restore/register, and online: no QR fetch/confirmation
and no friend application or chat replay. SsoHeartBeat and 25 consecutive Alive
replies succeeded, along with configuration/synchronization pushes. The account
selector matched the prior login and the encrypted record remained byte-identical.
The new process held the vault lock while online; explicit close released it,
left the encrypted account data intact and ended both processes. The diagnostic
reported zero exceptions and child exit 0. This tests one real restore, not an
unlimited credential lifetime, automatic A1 renewal or permanent online service.
