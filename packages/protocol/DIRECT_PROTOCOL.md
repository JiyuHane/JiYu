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
an earlier call and other invariants were not ruled out. The `0x016e` value
contains a copied global string whose first initialization is empty; subsequent
writes and the value at send time are not established by that initializer.
A separate getter produces `Linux` for a field in the third node, not for the
`0x016e` string. These observations do not identify the sender instance or
prove that this branch executes. The key's business identity, actual input
bytes, the two session-owned node types and complete transformation remain
unknown.

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
On a candidate sender-construction path through `0x34a9e00`, `0x34f05e0`,
`0x34f4e70` and `0x34f63e0`, the value ultimately assigned to sender `+0x38`
is the address-adjusted subobject `X+0x10` when `X = [H+0x90]` is non-null.
The guarded send then calls that receiver's virtual slot `+0x20`. The dynamic
subobject type and slot target, and any bridge from it to `GetSignInfo`, are
not established; the same-offset sender constructions are not proof of the
same runtime instance. A separately inspected `0x34b9130` construction zeros
`H+0x90/+0x98` and installs a vtable connected to an
`onUnusualDeviceNeedVerify` candidate thunk. That does not establish its
identity with the QR-success instance. In the inspected normal path,
`0x34bafd0` reads and copies that pair into a new control-block-backed object;
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
- `src/direct/target-wt-login-node.ts` encodes the two observed node forms
  `0x016a` and `0x0318` from explicitly supplied opaque bytes. A node includes
  its BE16 tag and BE16 value length but no entry count. Its per-value limit is
  a local policy; a later enclosing frame may impose a smaller bound. This does
  not establish that either node is sent in a login request.
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
- `src/direct/target-raw-transaction.ts` offers one experimental transaction
  on a caller-supplied connected raw transport. `createSso12RawClient` constructs
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
  counts against the required timeout but cannot be preempted. The head's input
  sequence is a placeholder replaced by the raw client's local sequence, while
  reserved/signing bytes are prepared beforehand; this adapter cannot itself
  construct a signature that depends on the newly assigned sequence. The raw
  client's inclusive-length framing remains a local constraint, not a proven
  target rule, and the adapter does not establish real QQ authentication,
  response binding, login or online state. Its encoder dependencies assume
  untampered JavaScript built-ins; cleanup is best effort and cannot erase engine
  or callback-owned copies.
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
