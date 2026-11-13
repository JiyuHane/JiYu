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
