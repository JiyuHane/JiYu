# Jiyu plugin compatibility

Jiyu is developing a partial, independently implemented compatibility layer for
NapCat-style OneBot 11 plugins. The compatible interface is informed by the
[public NapCat plugin documentation](https://doc.napneko.icu/develop/plugin).
NapCatQQ is Copyright © 2024 Mlikiowa; its source, its separately licensed
components and each third-party plugin retain their respective ownership and
license conditions. The compatibility layer is not a redistribution of the
NapCatQQ implementation and does not grant rights to third-party plugins.

The user-selected [HolyFoxTeam community index](https://github.com/HolyFoxTeam/napcat-plugin-community-index)
provides third-party plugin metadata. An index entry is not verification of a
plugin's author, source authenticity, license, safety, or compatibility with
Jiyu. Its `minVersion` describes NapCat, not Jiyu. Treat each plugin's own
license and attribution independently.

## Third-party plugin responsibility

Third-party plugins are independently developed, maintained and operated by
their respective authors or providers. Jiyu has no affiliation or partnership
with those third parties; displaying a plugin or implementing a compatible
interface does not endorse it. Jiyu does not assume responsibility for
third-party plugin code, data handling, operation, results or resulting losses.
Questions or issues concerning a plugin should be directed to its author or
provider.

## Current boundary

The first compatibility subset uses OneBot v11 actions and events. It supports
selected lifecycle callbacks and a limited account-scoped `actions.call`
bridge, static JSON configuration schema, explicit configuration hooks, and a
partial data-only `NapCatConfig` builder. The builder supports `text`, `number`,
`boolean`, `select`, `multiSelect`, `html`, `plainText`, and `combine`. The
display methods return untrusted strings as data, not rendered or executed HTML;
their empty labels cause rejection by the current configuration editor. Their
UUID-derived keys are an independent strategy, not a claim about the upstream
random algorithm or collision guarantees. Reactive flags are metadata only. It
does not recreate the NapCat internal `core`, `oneBot`, `router`, complete
plugin manager, dynamic configuration controllers or cross-plugin exports.
Plugins that require those interfaces may fail explicitly.
A plugin that appears in the index is not necessarily usable in Jiyu. The supported
hooks, entry-point rules, action behavior and queue limits are described in the
[host implementation notes](./src/plugin-host/README.md).

The current plugin host executes explicitly selected ESM code in the Jiyu Node
process. It is not a process, filesystem, network or permission sandbox. Code
can access the full process, its network permissions and other accounts, and
can block the host. Schema and configuration limits bound accepted JSON copies,
not already-constructed input objects, transient `Reflect.ownKeys` enumeration,
CPU use or RSS. They do not provide process or resource isolation. Node may
retain imported module and dependency state across activations. Stopping event delivery and running
`plugin_cleanup` does not prove plugin-created timers, workers, subprocesses or
other detached work have stopped, and must not be treated as permission to
overwrite a live plugin's files.

Jiyu stops new action ingress when an account instance is quiesced. As a
result, a cleanup hook that attempts to start a new action during instance
disposal receives the existing closed response; this differs from hosts that
permit action calls throughout cleanup. Already admitted work is drained before
account stores are closed. Cleanup failure and incomplete resource ownership
must remain observable rather than being reported as full process cleanup.

Marketplace browsing does not install or start anything. The existing local
search also uses Unicode compatibility normalization as a fallback, followed by
locale-independent lowercasing if locale-aware matching misses. A match can be
broader than the text displayed; a search hit does not verify the plugin's identity
or compatibility. The local-management path looks for manually placed
direct subdirectories under
`data/plugin-packages/<plugin-id>` relative to the Jiyu working directory;
plugin state is kept separately under `data/plugins/<account-id>/<plugin-id>`.
Only an explicit enable for a running account executes the selected local ESM
entry. Stopping a plugin is not an uninstall. Jiyu checks the selected paths,
but filesystem replacement between checks and loading remains possible.

The local list can explicitly preview a candidate's `package.json` `main` and
`type` declarations without importing the plugin. These are unverified local
strings, not proof that an entry exists, is compatible, is licensed, or comes
from the claimed author. Invalid or unavailable declarations are reported rather
than treated as a successful preview. Files can change after preview; enabling
continues to perform its own checks.

The configuration panel calls static schema and optional get/set hooks only
on explicit user actions. Its editor accepts at most 64 fields, only `key`,
`label`, `type`, `default`, `description`, `placeholder`, and optional
`reactive: false` and `hidden: false` properties, nonempty safe keys and nonempty
labels, and the `string`, `text`, `number`, `boolean`, and restricted static `select` and
`multi-select` types. Both selection types require `options`: 1–256 entries with
nonblank labels and unique string or safe-number values; numeric `1` and string
`"1"` remain distinct. A single current value must match one option exactly. A
multi-select current value must be a dense array of distinct declared options;
an empty array is valid, and the editor preserves selection order. A `placeholder`
must be an own enumerable data-property string of at most 1024 UTF-16 units;
an empty string is retained. String, number and Jiyu's editable text fields use
it as a native input hint; select, multi-select and boolean fields display it as
a static declaration instead. It is never used as a configuration value. In the
user-supplied NapCat source ZIP (SHA-256
`3f8378928116587295c508fe61f82591c9fb64b5b5e7185e0b8b3e9e32b013f7`),
placeholder is declared for all item types; the inspected UI uses it on string,
number, select and multi-select controls. That snapshot does not establish other
NapCat versions or runtime compatibility. Jiyu intentionally does not adopt its
empty-string/description fallback, and treats unmarked `text` as editable rather
than the snapshot's display-only text. Declared defaults need not match the
options, are displayed as declarations, and are never automatically saved; a
multi-select default can also contain duplicates. The editor disables its
controls while a configuration operation is busy or the account cannot execute;
read and write confirmation and generation guards still apply. An invalidated
confirmation can be dismissed without closing a newer confirmation ticket. These
are narrower UI rules than the builder's schema rules. When present, the
metadata properties must be own enumerable data properties with the value
`false`; `hidden: false` leaves the field visible. Other `hidden` and `reactive`
values remain unsupported; neither metadata property enters configuration values
or enables dynamic controllers. Even a builder-produced field may be rejected. For a
`plainText` item made by the current slot's own builder, a versioned sidecar
can identify that item in the captured static schema. The editor displays the
plain text and any accepted static field declarations in schema order as a
read-only snapshot. Field labels, keys, types, descriptions, defaults and
options are declarations, not current configuration values; this view calls
neither the configuration getter nor setter. An unmarked item, unknown version
or mismatched snapshot remains unsupported. This does not prevent direct
`setConfig` API calls, other tabs, or plugin-side changes. The sidecar is not
authentication or an isolation boundary against an untrusted backend or
same-process plugin. HTML display is still unsupported in the editor. Other
fields in such a view are not writable; editing them requires a separate server
consistency design. The returned object
must match the schema; unsupported schemas are not silently rewritten. A successful set means the plugin's hook returned, not
that data was durably stored. There is no host-managed configuration-file
fallback, version check, merge guarantee, dynamic controller or HTML editor.
Hooks run with the same process privileges as the plugin, and a request failure
can leave its effects unknown. Schema and later configuration operations are
bound to the same active plugin generation; a restart or re-enable requires a
new explicit read. The editor checks a narrow numeric subset, while the
underlying JSON/JavaScript number model can still lose precision or original
numeric spelling. A write checks the active plugin generation before reading its
body; an inactive or stale generation therefore takes precedence over malformed
or oversized body errors. Disable or request abort cancels a write that is still
reading, but an already invoked hook remains reserved until its promise settles.
For a reader already acquired by the route, an abnormal read before the stream
reports completion also triggers cancellation. Cancellation that is pending or
rejected remains visible as `cleanup_uncertain` and continues to count against
the pending-operation limits; it does not establish that underlying resources
have stopped. A cancellation that never settles, or rejects without establishing
cleanup, retains its reservation indefinitely for the life of the route owner.
Bodies rejected before a reader is acquired are cancelled on a
best-effort basis without that accounting, and their underlying resource state
also remains unknown. The final admission checks rely on the instance's
synchronous state observations being truthful; arbitrary in-process code retains
the privileges described above and can interfere with those observations.

Archive downloads, store installation, updates and online rollback are separate
work; do not interpret catalog browsing or a local compatibility test as their
completion. An internal [offline ZIP preflight](../core/src/webui/plugin-install/README.md)
checks a limited ZIP32 stored/raw-DEFLATE subset and is not an installer;
common community ZIPs with extra fields, descriptors or non-ASCII paths remain
outside the profile. The host and index can be tested
with synthetic local plugins without running QQ. Real plugin and QQ
interoperability require separate validation.
