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
