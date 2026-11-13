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
bridge, static JSON configuration schema, and explicit configuration hooks; it
does not recreate the NapCat internal `core`, `oneBot`, `router`,
`NapCatConfig`, complete plugin manager, dynamic configuration controllers or
cross-plugin exports. Plugins that require those interfaces may fail explicitly.
A plugin that appears in the index is not necessarily usable in Jiyu. The supported
hooks, entry-point rules, action behavior and queue limits are described in the
[host implementation notes](./src/plugin-host/README.md).

The current plugin host executes explicitly selected ESM code in the Jiyu Node
process. It is not a process, filesystem, network or permission sandbox. Code
can access the full process and other accounts. Node may retain imported module
and dependency state across activations. Stopping event delivery and running
`plugin_cleanup` does not prove plugin-created timers, workers, subprocesses or
other detached work have stopped, and must not be treated as permission to
overwrite a live plugin's files.

Jiyu stops new action ingress when an account instance is quiesced. As a
result, a cleanup hook that attempts to start a new action during instance
disposal receives the existing closed response; this differs from hosts that
permit action calls throughout cleanup. Already admitted work is drained before
account stores are closed. Cleanup failure and incomplete resource ownership
must remain observable rather than being reported as full process cleanup.

Marketplace browsing does not install or start anything. The local-management
path looks for manually placed direct subdirectories under
`data/plugin-packages/<plugin-id>` relative to the Jiyu working directory;
plugin state is kept separately under `data/plugins/<account-id>/<plugin-id>`.
Only an explicit enable for a running account executes the selected local ESM
entry. Stopping a plugin is not an uninstall. Jiyu checks the selected paths,
but filesystem replacement between checks and loading remains possible.

The configuration panel calls static schema and optional get/set hooks only
on explicit user actions. Its editor supports a narrow subset of fields and
requires the returned object to match that schema; unsupported schemas are not
silently rewritten. A successful set means the plugin's hook returned, not
that data was durably stored. There is no host-managed configuration-file
fallback, version check, merge guarantee, dynamic controller or HTML editor.
Hooks run with the same process privileges as the plugin, and a request failure
can leave its effects unknown. Schema and later configuration operations are
bound to the same active plugin generation; a restart or re-enable requires a
new explicit read. The editor checks a narrow numeric subset, while the
underlying JSON/JavaScript number model can still lose precision or original
numeric spelling.

Archive downloads, store installation, updates and online rollback are separate
work; do not interpret catalog browsing or a local compatibility test as their
completion. The host and index can be tested with synthetic local plugins
without running QQ. Real plugin and QQ interoperability require separate
validation.
