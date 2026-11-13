# Offline ZIP preflight

`preflightZip` is an internal, synchronous byte-inspection primitive for a
strict subset of ZIP32 archives. It is **not connected to the WebUI or a plugin
installer**: it does not download, extract, write, publish, import or execute
plugins. Passing this check is not proof of plugin ownership, authenticity,
license, compatibility, or safe use on a particular filesystem. In particular,
filesystem links, reparse points, short-name aliases, concurrent replacements,
permissions and crash recovery require separate platform-specific handling.

The current profile accepts only stored entries with portable ASCII paths and
recognized DOS or Unix regular-file/directory declarations. It rejects empty
archives and archives containing only directories, DEFLATE, data descriptors,
ZIP64, encryption, extra fields, comments, unsupported creator metadata,
path and case collisions, and non-contiguous record layouts. Many legitimate
ZIP archives, including common plugin releases, may therefore be rejected.
Unrecognized features are rejected rather than silently skipped.

The primitive validates a private snapshot, local and central records, stored
sizes and CRC-32, then returns frozen metadata and the SHA-256 of that snapshot;
it does not return extracted bytes. CRC-32 checks data consistency, and
SHA-256 identifies the inspected bytes: neither authenticates the source or
establishes licensing rights. Errors use fixed codes without returning paths or
underlying exception messages.

Limits are 32 MiB per archive, 512 entries, 8 MiB per file, 32 MiB cumulative
file size, 512 bytes per path, 100 bytes per component, and 16 components.
These bound the inspected data and returned metadata, not total process memory
or execution time. A synchronous scan can block the event loop; production
integration needs a separate isolation, cancellation and resource-control
design. No actual community plugin or QQ client is required for the synthetic
fixture tests.
