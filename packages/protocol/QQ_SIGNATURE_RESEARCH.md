# QQ signing: static investigation notes

These notes distinguish observations from working signing code. The current
project does not implement or validate the signature algorithm described here.
No QQ client, QQ Hook, native target, real account, or external signing service
was run during this investigation.

## Examined native sample

The supplied `libfekit.so` is an Android AArch64 ELF64 shared object, not the
Linux x86-64 `wrapper.node` discussed in [DIRECT_PROTOCOL.md](./DIRECT_PROTOCOL.md).
Its SHA-256 is
`29e7a344a5b5657480bdd249ec0676b0d48f66375fcef428970d1e0f6e08b9ea` and its
GNU build ID is `6ed8706cc869f8191e8abcda6eb02f58c2b65bec`. Strings mentioning
`com.tencent.mobileqq` and QSec provide static association clues, not proof of
which installation or QQ version loaded this particular file. The original
binary is not included in this repository.

REA's target-independent ELF and export inspections identified its format,
build ID and `JNI_OnLoad` export at virtual address `0x62b3c`. REA 6.8.0's
native ELF decompiler was unavailable in the Windows analysis environment:
its Windows Ghidra profile does not accept this ELF, its Kuna provider does not
support Windows hosts, and no IDA provider was configured. The following
instruction observations were made with read-only radare2 and are not
presented as REA decompilation or execution traces.

### JNI registration candidate

Within bounded instructions of `JNI_OnLoad`, `0x6b8b8–0x6b8dc` writes a
three-pointer table at `0x9a66a0`. The named values are the string `d` at
`0x90e062`, signature `(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)[B`
at `0x90833d`, and code address `0x2b6454`. Separately, an indirect call via
`x20`'s function table at `+0x30` uses the class-name string
`com/tencent/mobileqq/qsec/qsecest/QsecEst`; its return is stored at
`[x19+0x528]`. A later instruction window loads from the same base expression
and passes it, the table and a count of one to an indirect call at `+0x6b8`.
Under the JNI function-table convention these are `FindClass` and
`RegisterNatives` candidates. Obfuscated control flow prevents concluding from
linear addresses alone that the two call sites execute in that order, that the
table remains unchanged, or that registration succeeds. The bounded entry
window at `0x2b6454` does not establish its cryptographic or signing semantics.
In a nearby bounded window, conditional blocks call `malloc(0x40)`, then on a
non-null allocation set a 32-bit field at offset `0x18` to 4 and allocate
`strlen(x21)+1` bytes. A later non-null branch copies that many bytes from
`x21`; it then re-reads a saved pointer before storing it at offset `0x20` of
the first allocation. The null second-allocation branch stores zero instead.
This local reconstruction assumes the indicated state transitions, stable
saved slots and registers, valid NUL-terminated input, non-overflowing length,
valid non-aliasing memory, and normally returning AAPCS64-conforming callees.
A later conditional window reads the object again and, if non-null, checks a
separate pointer field at offset `0x38`. A non-null old pointer is passed to
`free`; subsequent blocks allocate four bytes and, when allocation succeeds,
copy four bytes from a static address before writing a re-read pointer to that
field. The failure branch writes zero. The old field is not immediately cleared
after `free`; successful writeback and preserved slots are separate assumptions.
The same memory and calling-convention conditions apply, together with valid
ownership of any freed pointer. The `0x20` and `0x38` fields have different
offsets and their meaning is unknown. The complete function boundary, input's
origin, structure's purpose, execution and any connection to signing remain
unknown. No static source bytes were interpreted as keys.

Another bounded block at `0x2b7298` clears a 129-byte buffer at `x21`, calls
`__system_property_get` with that buffer, and stores the 32-bit return at
`[x23]`. Under the observed state transitions, a positive return selects a
path to `malloc(0x40)` at `0x2b7448`; a non-positive return selects a path
that saves a length of one, copies that many bytes from a static address into
the buffer, re-reads the saved length to append a zero byte, then reaches the
same allocation call. This conditional reconstruction assumes preserved state
and saved slots, valid non-overlapping buffers and normally returning callees;
it does not establish that either branch executes or that the buffer contents
are used for signing. The property name and static source byte were not
interpreted.

In a conditionally connected continuation after that allocation, a non-null
64-byte allocation is zeroed by two paired vector stores. The allocation pointer
is written to `[x23]`, overwriting the saved property return. On the non-null
path a 32-bit value of four is stored at offset `0x18`, and `strlen(x21)+1`
bytes are allocated for a copy of the same buffer. A later conditional block
copies those bytes and stores the re-read allocation pointer at offset `0x20`;
if that allocation is null, zero is stored instead. This linkage depends on the
indicated state constants, AAPCS64 register preservation, unchanged saved slots,
valid non-aliasing storage, a terminated buffer, a representable length and
normally returning calls. It establishes neither runtime reachability nor the
structure's purpose or any relationship to signing or AES.

Under the inspected dispatch-state and AAPCS64 preservation conditions, the
`0x2b75ec` write is followed by the `0x2b7604` branch. For non-null `P`, that
branch saves the address `P+0x38`, conditionally frees its old pointer, allocates
four bytes, conditionally copies from a static address, then writes the re-read
allocation pointer or zero through the re-read saved address. The old field is
not cleared immediately after `free`. This interpretation additionally assumes
valid ownership, valid non-overlapping memory, normally returning calls and
saved slots unaffected by aliasing or concurrent writes. The later load from
`[sp+0x128]` has a different source expression; the inspected window establishes
neither equality nor inequality with `P` or its fields. No static source bytes
were interpreted, and the function's purpose and actual execution remain unknown.

In a further conditional window, `0x2b7604` loads `Q` from `[x23]` into
`x19`, replacing an earlier 32-bit state value. `Q` equals the pointer used at
`0x2b75ec` only if that slot has not changed in between. After a separate pointer
`S` is loaded from `[sp+0x128]`, the code reads `[S]` before checking `Q` for
null. With `Q` non-null and `[S]` null, an observed path writes `Q` to `[S]`.
With a non-null head and a finite traversal ending at node `T`, another path
performs two separate stores: `[T]=Q` and `[Q+8]=T`. During traversal, `[x23]`
is overwritten by the current node, so it cannot be assumed to retain `Q`.
This linked-structure interpretation assumes valid pointers, normal returns,
AAPCS64 preservation and no harmful aliasing or concurrent mutation; cyclic
links may prevent termination. The purpose, entry reachability and relation to
signing or AES remain unknown.

Under the inspected state values, both link paths can subsequently dispatch to
`0x2b7a78`, which calls `memset` with `x21` and length `0x81`, then calls
`__system_property_get` with `x21` as its buffer. Those argument expressions
are not directly `Q` or `S`, although aliasing has not been excluded. After the
call, a 32-bit write to `w19` overwrites the previous `x19=Q`, and the property
return is stored as 32 bits at `[x23]`; on the traversed path that slot may have
been changed to `T`. This conditional path assumes valid memory, preserved
state and normally returning AAPCS64 calls. It establishes no function return,
actual execution, or relationship to signing or AES.

In the conditionally reached continuation at `0x2b7c04`, the 32-bit value read
from `[x23]` is compared as signed. A positive value dispatches to an allocation
of `0x40` bytes at `0x2b7c24–0x2b7c28`. A non-positive value can instead store
one at `[x23+0x18]`, copy that length from a static address to `x21`, re-read a
saved length and write a zero byte at `x21+length`, before reaching the same
allocation. The re-read length equals the copied length only if the saved slot
is unchanged. This interpretation also requires valid, non-overlapping memory,
normal AAPCS64 calls and stable state without harmful aliasing or concurrency.
The preceding 32-bit write does not identify the full `[x23]` slot as `Q` or
`T`; the path remains unproven at runtime and is not linked to signing or AES.

Separately, `0x2fe5b4–0x2fe5d0` forms the string address for
`com/tencent/mobileqq/qsec/qseccodec/SecCipher$SecInfo` in `x0` and calls
`0x33ec58`; its result is stored at `[sp+0x338]`. The helper passes the same
first argument to `0x33e1d4` in the inspected entry window. On another
conditional path in `0x33ec58`, the code reads a function pointer from global
`0x9a6a30` and calls it with the saved `0x33e1d4` result and saved class-name
pointer as its first two arguments. This local path depends on preserved stack
and register values, including two dispatch-state constants; the slot's
setter, target and actual execution are unknown. The eight-byte slot lies in
the ELF's allocated `.bss` `SHT_NOBITS` range; this identifies no file-backed
initial value. In the inspected RELA entries, none has an `r_offset` equal to
the slot's starting address, but other relocation ranges and runtime writes
were not excluded. After that indirect call, the inspected path passes the
same saved object to `0x33e878`. In its bounded state machine, assuming valid
receiver/vtable pointers and normally returning AAPCS64-conforming callees, it
calls slot `+0x720`; if the return's low byte is nonzero it calls `+0x88` and
returns 1, otherwise it returns 0. If the receiver is actually a standard
`JNIEnv`, these slots correspond to `ExceptionCheck` and `ExceptionClear`.
Their identity and runtime execution remain unverified, as does the proposed JNI
class lookup. Inside `0x33e1d4`, one conditional state path initializes a local
output slot and passes its
address, a pointer previously read from global `0x9a6a28`, and `0x00010006`
to an indirect call through that pointer's function table at `+0x30`; the code
then records whether the return is `-2`. This path also requires the dispatch
register `w11` to retain `0xf5a5c4ad` at the inspected branch. If the pointer
is a valid `JavaVM` using the JNI Invoke ABI, this resembles `GetEnv` with
`JNI_VERSION_1_6` and a `JNI_EDETACHED` check. The pointer's identity, prior
side effects, actual path reachability, returned object's type and signing
relationship remain unknown. A separate `JNI_OnLoad` window at
`0x63328–0x6334c` reloads a pointer saved from entry `x0`, initializes an
output slot to zero, supplies its address and `0x00010006`, then calls that
pointer's function-table slot `+0x30`. If the entry argument is a valid
`JavaVM`, the saved register and slot remain unchanged, and this block is
reached, that call has the same `GetEnv` ABI shape. It is not established that
this saved pointer is the value in global `0x9a6a28`. Flattened control flow
also prevents assuming that surrounding blocks execute in address order.

### AES evidence and limits

Four 256-byte windows in `.rodata` were independently compared, byte for byte,
with an AES S-box generated using GF(2^8) reduction polynomial `0x11b` and its
inverse: forward tables at `0x908d5b`, `0x90bf88`, `0x911eff`, and an inverse
table at `0x912094`. The observed bytes match the respective standard tables.
Separate bounded AArch64 instruction windows also construct these table
addresses and use byte-indexed loads. For example, `0x844c48–0x844c60`
constructs `0x911eff`, loads an index byte, reads the forward table and writes
the result back; `0x860268–0x860274` constructs `0x912094` and reads the
inverse table by index. A radare2 `pdc` view of a manually bounded block at
`0x844c40` agrees with that local substitution. The artificial block's `void`
signature and return in that view are not evidence of real function boundaries
or return values. In another bounded window at `0x844c84–0x844d24`, a
conditional path rotates four bytes at `A = x29 - 0xf4` from
`[A0, A1, A2, A3]` to `[A1, A2, A3, A0]`. That local deduction requires the
three dispatch-state values to be distinct and stable, valid memory and no
harmful aliasing; other states need not follow this path. The adjacent S-box
and rotation windows are selected by flattened control flow, so their linear
ordering does not establish their execution order or an AES key schedule.

A separate conditional window at `0x2f3a70–0x2f3ab8` reads four values
through the verified forward S-box at `0x90bf88`. One index is loaded as a
64-bit value from `[x19+0x380]`; the other three are loaded as bytes. It XORs
the first substitution with one byte from a second base `0x90c088`, indexed
by a 32-bit value shifted right by two. The content and bounds of this second
table were not examined. A separately inspected preceding block writes a
zero-extended byte to the 64-bit index slot; this only bounds the index if that
particular path is taken and the slot remains unchanged. The substitution block
sets a dispatch state and branches to `0x2f3830`; the following block is not
necessarily the linear instruction successor.

If the dispatcher selects `0x2f3880`, it reads the **32-bit** slot
`[x19+0x288]` twice (`0x2f3880` and `0x2f3884`). This is the same slot read at
`0x2f3a80` for the second-table index, not the distinct **64-bit** S-box index
slot `[x19+0x380]` read at `0x2f3a70`. Let `A = x19+0x4a0`, `i0` be the
32-bit value used earlier for the second table, `i1` and `i2` the two later
values, and `b1 = (4*i1) mod 2^32` and `b2 = (4*i2) mod 2^32`. Subject to
valid memory and absent harmful aliasing, the four output bytes at `A[b1+j]`,
for `j=0..3`, each XOR a substitution result with
`A[(b2-16+j) mod 2^32]`; the first result also includes the byte from the
second table. The 32-bit slot is re-read yet again afterward. A particular
observed dispatch-register value is sufficient for the inspected branch but is
not established as its runtime value, and these reads need not be equal. The
32-bit address arithmetic can wrap, including when an index is below four.

Another bounded instruction trace identifies a **conditional initialization**
of the same local area. At `0x2f33f0–0x2f33fc`, two pointers loaded from
`[x19+0x1c8]` and `[x19+0x140]` are passed to `memcmp` with length `0x23`.
Under the inspected dispatcher states, a zero comparison can reach a block
that initializes a local index to zero. The loop at `0x2f3a4c–0x2f3a6c`,
`0x2f3abc–0x2f3afc` and `0x2f3b00–0x2f3b2c` can then copy four groups of
four bytes from the address `0x908eb0` into `A = x19+0x4a0`; a later
conditional block sets the word index to four and enters the candidate
word-generation loop. An earlier bounded path includes a `malloc(0x23)`, a
store of the result in `[x19+0x1c8]`, and a dispatcher-selected block that
re-reads that slot and writes 35 zero bytes there. If allocation succeeds,
those particular paths are reached, the pointer slot remains unchanged and
`memcmp` returns zero normally under its ABI, then its other compared 35-byte
range is all zero at the time of comparison. A different inspected instruction
also partially writes the pointer slot, so its stability is a condition, not an
observed fact. These deductions additionally assume stable registers and local
slots, valid source and destination ranges, and no harmful aliasing or concurrent
changes. The compared buffers and source bytes were not examined. Their
meaning, the reachability of this path and any connection to a signing entry
remain unknown.

A further bounded radare2 instruction trace provides **conditional** evidence
for the rotated inputs. At `0x2f39bc–0x2f39fc`, a 32-bit `j` from
`[x19+0x288]` selects four bytes at `A + ((4*j-k) mod 2^32)` for `k=4,3,2,1`,
using zero-extended 32-bit offsets; the code stores them in `[x19+0x2f0]`,
`[x19+0x2f8]`, `[x19+0x300]` and `[x20]`, respectively. Without arithmetic
wrap, these are the four bytes preceding `A + 4*j`. At `0x2f3a00–0x2f3a24`, another read of `j` selects a dispatcher
state based on `j & 3`. With the inspected dispatcher register equal to
`0x17da7ce7`, the zero branch selects `0x2f3a28`, which zero-extends the second
saved byte into `[x19+0x380]`; the dispatcher then selects `0x2f3a70`. Under
stable registers and slots, valid memory and no harmful aliasing, that path
substitutes the saved bytes in order 1, 2, 3, 0. The nonzero branch can select
`0x2f3880` directly using the unrotated bytes. After the write window,
`0x2f38ec–0x2f38f8` reads `j` again and computes `j+1`; a dispatcher-selected
block at `0x2f3998–0x2f39b4` stores it and compares the re-read value with 44.
A separate conditional block supplies an initial value of 4. These are static
path deductions, not evidence that those states occur or that repeated reads
are stable at runtime; 32-bit index arithmetic can wrap.

For comparison, the [NIST AES standard](https://csrc.nist.gov/pubs/fips/197/final)
describes AES-128 key expansion using rotated and substituted words and XOR
with the word four positions earlier. The inspected path resembles part of
that recurrence, but the extra table contents, valid bounds, initial data,
complete algorithm, function boundary, reachability and signing connection
remain unestablished. The match does not establish a real key schedule.

These are static instructions, not observed execution. They do not establish a
complete AES operation, mode, keys, or a connection to a signing path. A separate scan of aligned direct `BL` encodings in the 16 KiB
window beginning at the candidate `0x2b6454` found only six library PLT targets;
it did not find a direct call to the selected table-reference locations. This
window is not an established function boundary and excludes indirect calls and
other paths, so it does not establish the absence of a connection. These are
file-backed static virtual addresses, not live process addresses. No keys were
extracted or recorded.

The offline [`native-aarch64-sbox-scan.mjs`](../../tools/native-aarch64-sbox-scan.mjs)
reproduces the standard-table and direct-reference search for an explicitly
selected ELF file:

```sh
node tools/native-aarch64-sbox-scan.mjs /path/to/libfekit.so
```

The tool reads the file, does not execute it, and outputs its SHA-256, selected
section ranges, matching table addresses, and static reference candidates. It
only accepts its bounded ELF64 little-endian AArch64 shared-object profile and
scans complete 256-byte standard tables in `.rodata`, with aligned `ADR` and
adjacent `ADRP` plus 64-bit `ADD` instructions in `.text`. Other layouts,
indirect addressing, table fragments, transformed tables and runtime-loaded
code are outside this search. A candidate does not establish a valid execution
path, an actual table read or signing behavior. The optional in-memory API
scans a private copy. The CLI follows the selected path, including symbolic
links, and compares file metadata before and after reading; that is not an
atomic filesystem snapshot or a guarantee against concurrent changes that
preserve metadata. Supply a stable copy for reproducible analysis. This is
research tooling and is not connected to the application or plugin host.

## Public protocol reference

[LagrangeV2 at commit `7011cdf87368cc0fb77273c1508e779a52328165`](https://github.com/LagrangeDev/LagrangeV2/tree/7011cdf87368cc0fb77273c1508e779a52328165)
contains a protocol client and interfaces to external signing providers. Its
[Milky signer](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Milky/Utility/Signer.cs)
uses an HTTP signing service; the separate
[Core provider](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Common/BotSignProvider.cs)
and [Android provider](https://github.com/LagrangeDev/LagrangeV2/blob/7011cdf87368cc0fb77273c1508e779a52328165/Lagrange.Core/Common/AndroidBotSignProvider.cs)
have different request contracts. An HTTP client contract is not evidence of
the server's signing algorithm or of this sample's native ABI. The inspected
commit did not contain a root license file or a `.so` file; no rights to copy
its implementation are assumed here. The sample's version, native call graph,
key derivation, algorithm, and compatibility with that source remain unverified.
