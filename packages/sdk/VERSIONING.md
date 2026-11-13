# @harehane/sdk Versioning

The SDK follows SemVer for its public package surface:

- Exported runtime values and classes from `@harehane/sdk`.
- Exported types from `@harehane/sdk` and `@harehane/sdk/types`.
- Supported subpath exports: `client`, `messages`, `events`, `errors`, `actions`, `types`, and `node`.
- Runtime behavior of typed client helpers, message builders, event helpers, and SDK error classes.

## Package name migration

The Jiyu SDK package name changes from `@snowluma/sdk` to `@harehane/sdk`.
This is a package-identity breaking change: install the new package once it is
published, update the dependency name and every import, including subpaths such
as `@snowluma/sdk/node` → `@harehane/sdk/node`, and regenerate your own lockfile.
Keep the existing `SnowLuma` class, type, action and error identifiers; their
names and the OneBot v11 behavior remain unchanged by this rename.

The names identify separate npm packages. Renaming this workspace neither creates
nor updates the old package, redirects old imports, or establishes that the new
package has already been published. Existing consumers of the old name must
migrate explicitly; availability and version history of either package depend on
the registry and its maintainers. No package alias is included in this workspace.

## Version policy

SDK and application versions are synchronized by `pnpm bump <version>` from the repository root.

The current Node.js requirement is `^24.22.1 || >=26.12.1`. Use the repository's `.node-version` for development and builds.

The SDK is an ES module package that supports native Node.js imports and bundler consumers. Its build uses `NodeNext`; relative source imports and re-exports must use `.js` specifiers so both emitted JavaScript and declarations resolve without a bundler. Package tests compile fresh output, load every runtime entry point with Node.js, and typecheck consumers with both NodeNext and bundler resolution.

- Major: removes or changes a public export, changes runtime behavior incompatibly, changes supported Node version, or removes/changes an existing package subpath.
- Minor: adds new public API or package subpaths, supports new SnowLuma actions, adds optional parameters, or adds error subclasses.
- Patch: fixes bugs, improves docs, narrows implementation details without breaking public types, or updates action metadata without changing call signatures.

## Release Checklist

1. Run `pnpm bump <version>` to update all workspace versions.
2. Update `packages/sdk/CHANGELOG.md`.
3. Run `pnpm --filter @harehane/sdk typecheck`.
4. Run `pnpm --filter @harehane/sdk test`.
5. Run `pnpm --filter @harehane/sdk build`.
6. Keep the SDK's `LICENSE` and `JIYU_NOTICE.md` byte-for-byte in sync with the repository-root originals. The SDK package test checks both the copies and the packed archive.
7. Run `pnpm --filter @harehane/sdk pack --dry-run` to inspect published files.

## Automated npm Publish

`.github/workflows/sdk-npm-publish.yml` defines a publish job for SDK-related changes on `main` and reads the package name and version from the SDK manifest. Successful publication of `@harehane/sdk` requires the workflow's SDK filters, npm package access, and Trusted Publishing configuration to be set up for the new package and repository. The checked-in job uses GitHub OIDC and the GitHub Environment named `SnowLuma`; this inherited environment name is a configuration identifier, not the project name. The workflow configuration alone does not establish registry availability or successful publication.

Review the one-time settings in [`.github/npm-trusted-publishing.md`](../../.github/npm-trusted-publishing.md) and verify the new package's npm configuration before publishing.

If the package version already exists on npm, the workflow skips publishing that run. Bump `packages/sdk/package.json` before merging SDK changes that should create a new npm release.

## Action Compatibility

`SNOWLUMA_ACTIONS`, `isSnowLumaAction`, and `SnowLumaKnownAction` are available from both `@harehane/sdk` and `@harehane/sdk/actions`. The catalog includes this release's executable action names, compatibility aliases, and raw actions. OneBot's registry tests verify that the SDK catalog stays aligned with the server; the published SDK does not import server code.

This local catalog is not a capability check against a connected server. Every known action name has a parameter and result entry in `SnowLumaActionMap`, including aliases. Existing broad JSON contracts are retained for compatibility. New parameter types describe accepted input forms, including numeric strings and primitive coercions; server-side range and state validation still applies. Custom actions and dynamically selected names remain supported through `raw()` and `rawResponse()`. Adding an action type is a minor change unless it changes an existing method signature or return type.

Stream result types describe individual frame payloads, including intermediate and terminal frames. Both built-in clients support `requestStream()` (envelopes) and `stream()` (payloads with API error handling), plus incremental file upload/download helpers; see [STREAMING.md](STREAMING.md). Existing `request()`, `call()`, `raw()`, `rawResponse()` and `downloadFile()` keep their single-response contracts. Custom subclasses that only implement `request()` remain valid; the default `requestStream()` explicitly reports unsupported streaming. Stream reset/error envelopes retain their existing error behavior. Album counts and IDs returned as decimal strings stay strings, and ordinary message IDs remain signed numbers.

The package consumer tests check complete action-map coverage, inferred results, compatibility aliases, and invalid input examples with both NodeNext and bundler resolution. The same parameter examples are checked against the server's real action parsers without starting QQ or executing actions.

Additive media-send methods, explicit quoted replies, and WebSocket event waits are described in [MESSAGING.md](MESSAGING.md). Existing string paths, ordinary `reply()` behavior, and handler/context types remain supported. The optional `node` subpath owns local filesystem access; browser-facing entry points stay free of Node imports. The runtime also propagates group-file chat publication failures instead of returning success after a failed publication; successful action response shapes are unchanged.

The optional `node` entry also exports `createReverseWebSocketServer`, `SnowLumaReverseWebSocketServer`, and reverse-session types. These additive exports accept OneBot reverse connections without changing the forward client. The `ws` runtime dependency is loaded only by the Node entry; browser-facing exports remain free of Node server imports. See [REVERSE_WEBSOCKET.md](REVERSE_WEBSOCKET.md).
