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
Separately, `0x2fe5b4–0x2fe5d0` forms the string address for
`com/tencent/mobileqq/qsec/qseccodec/SecCipher$SecInfo` in `x0` and calls
`0x33ec58`; its result is stored at `[sp+0x338]`. The helper passes the same
first argument to `0x33e1d4` in the inspected entry window. These observations
do not identify either helper, the returned object's type, or a signing call.
The sites are conditional branches in flattened control flow; subsequent
comparisons and state selection do not prove that the blocks execute in address
order.

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
