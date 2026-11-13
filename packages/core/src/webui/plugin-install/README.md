# Offline ZIP preflight

`preflightZip` is an internal, synchronous byte-inspection primitive for a
strict subset of ZIP32 archives. It is **not connected to the WebUI or a plugin
installer**: it does not download, extract, write, publish, import or execute
plugins. Passing this check is not proof of plugin ownership, authenticity,
license, compatibility, or safe use on a particular filesystem. In particular,
filesystem links, reparse points, short-name aliases, concurrent replacements,
permissions and crash recovery require separate platform-specific handling.

The limited ZIP32 profile accepts stored (method 0) and raw DEFLATE (method 8)
regular files, portable ASCII paths and recognized DOS or Unix declarations.
Directories must be stored and empty; method 8 requires version-needed 20. It
rejects empty archives and directory-only archives, data descriptors, ZIP64,
encryption, extra fields, comments, unsupported creator metadata, path and case
collisions, and non-contiguous record layouts. This is not general compatibility
with common community ZIPs; many legitimate releases are rejected.

The primitive validates a private snapshot and all local and central records
before processing any archive content, then decompresses in memory for inspection
and checks actual sizes, byte-level DEFLATE consumption and CRC-32. There is no
filesystem extraction. It returns only frozen metadata and the
SHA-256 of that snapshot, never decompressed bytes. Byte consumption does not
establish canonical unused padding bits in the final byte. CRC-32 checks data
consistency, and SHA-256 identifies inspected bytes: neither authenticates the
source or establishes licensing rights. Errors use fixed codes without paths or
underlying exceptions.

Method 8 runs a small built-in capability probe after structural validation;
probe failure returns `unsupported` while stored-only archives remain independent.
It checks fixed examples for completion, trailing bytes, truncation, output cap
and empty output, not all inputs or future zlib versions. Node 24.22.1 was tested
locally; Node 26.12.1 and later were not tested here. Unexpected inflate errors
or malformed engine information return `internal`, rather than success.

Limits are 32 MiB per archive, 512 entries, 8 MiB each for both compressed
and decompressed file data, and 32 MiB cumulative declared and actual output;
paths are limited to 512 bytes, 100 bytes per component, and 16 components.
Even a valid file compressed to more than 8 MiB is rejected as a conservative
compatibility limit. There is no compression-ratio threshold: these output
budgets do not limit CPU, wall-clock time, process RSS or guarantee cancellation.
Synchronous inflate and CRC can block the event loop. Do not connect this
primitive to an online route: production integration requires a separate
isolation, cancellation and resource-control design. It establishes no filesystem
safety, authorization or signature. Tests use only synthetic in-memory fixtures.

## Worker lifecycle prototype

`PreflightWorkerTask` is an internal, single-slot controller with an explicitly
injected Worker factory. It has no default Worker entry and is not connected to
Core startup, the WebUI or an installer. It validates and copies an input view,
binds a worker's reported successful result to the copied bytes' SHA-256, and
validates and freezes the reported metadata. A valid result is a candidate until
an observed natural exit with code zero; aborts, errors and timeouts are final
once selected. Once a Worker has been returned, the separate cleanup result is
`released` only after an exit is observed and required listener cleanup succeeds.
If cleanup is uncertain because exit was not observed in time, the slot remains
occupied; a later exit and successful listener cleanup can release it, although
the already reported cleanup result stays `unknown`. Listener installation or
removal uncertainty is sticky and keeps the slot occupied, with no cleanup retry.
A successful outcome does not override uncertain cleanup. If the factory throws
or returns an invalid handle, the slot remains occupied.

The factory must return a new, exclusively controlled Worker and faithfully map
its actual events: event registration and removal must be non-throwing and
non-reentrant, and events must not be emitted synchronously during registration
or after exit. No other owner may terminate or reuse that Worker. These are
trusted adapter requirements, not facts established by `instanceof`. The
controller cannot independently verify a forged exit or a dishonest result.
SHA-256 binds the report's identifier to the input, not the truth of the
reported metadata. Worker message validation happens after structured cloning,
so it does not impose a hard memory bound on a malicious or faulty sender. The
controller hashes and copies on the parent thread, and its timers depend on
scheduler and event-loop progress. Workers share process permissions and do not
provide process isolation or a hard RSS, CPU or wall-clock limit. The existing
parser creates its own further snapshot. Source-mode synthetic Worker tests are
not evidence of a production bundle entry or live plugin compatibility.

The separate `preflight-worker-protocol.ts` implements a one-shot handler for
`{ kind: 'zip-preflight', version: 1, bytes: ArrayBuffer }` using an explicitly
supplied, trusted synchronous port wrapper. It validates the request, transfers
its Worker-local buffer before inspection, sends at most one controller-compatible
result and closes the port. Invalid requests or parser exceptions produce no
result; a genuine Worker entering this handler must allow fixed send/close errors
to escape rather than turning them into a successful exit. Its data helper makes
an additional copy of a caller's view. Using that helper after the controller's
snapshot therefore adds another parent-side copy; neither transfer nor SHA-256
proves where other copies came from or whether the Worker reports honestly.
The handler has no built-in Worker factory, package extraction or production
entry and uses no plugin code. Its buffer capability behavior is tested on Node
24.22.1; Node 26 and future runtime behavior remain unverified.

The existing Core entry is not a preflight Worker bootstrap: its static application
imports are evaluated before the entry-point branch, and Worker data not recognized
as the existing migration task can enter the application or supervisor path.
Production integration needs a separately verified dispatcher that distinguishes
main-thread startup, recognized Worker kinds and unknown Worker data without
starting application services. It must also preserve the single-bundle release
layout and existing migration behavior. A dynamic import in source alone does
not prove that the final bundled dependency graph defers application side effects.
