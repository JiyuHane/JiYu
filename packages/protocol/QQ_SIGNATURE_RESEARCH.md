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
build ID and `JNI_OnLoad` export at virtual address `0x62b3c`. REA's native
ELF decompiler was unavailable in the Windows analysis environment; the
following instruction observations were made with read-only radare2 and are
not presented as REA decompilation or execution traces.

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

### AES evidence and limits

Four 256-byte windows in `.rodata` were independently compared, byte for byte,
with an AES S-box generated using GF(2^8) reduction polynomial `0x11b` and its
inverse: forward tables at `0x908d5b`, `0x90bf88`, `0x911eff`, and an inverse
table at `0x912094`. The observed bytes match the respective standard tables.
This establishes the presence of matching constants in this exact artifact,
not that they are used, what AES mode or keys would apply, or that they are on
a signing path. These are file-backed static virtual addresses, not live process
addresses. No keys were extracted or recorded.

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
