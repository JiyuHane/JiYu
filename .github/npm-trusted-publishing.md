# npm Trusted Publishing

The npm publish workflows use GitHub Actions OIDC instead of a long-lived
`NPM_TOKEN`. Each package must have a matching Trusted Publisher entry on npm
before its first publish after this migration.

The following values describe the inherited SnowLuma publishing configuration.
The SDK is now named `@harehane/sdk`; its npm ownership and trusted-publisher
configuration must be verified separately for the Jiyu repository before any
publication. A package rename does not automatically transfer npm ownership or
create an alias for `@snowluma/sdk`.

For the existing SnowLuma UI and MCP packages, the inherited configuration
lists a **GitHub Actions** trusted publisher with:

| Field | Value |
| --- | --- |
| Organization or user | `SnowLuma` |
| Repository | `SnowLuma` |
| Workflow filename | The exact filename below |
| Environment | `SnowLuma` |

| Package | Workflow filename |
| --- | --- |
| `@snowluma/ui` | `ui-npm-publish.yml` |
| `@snowluma/mcp` | `mcp-npm-publish.yml` |

The workflow job keeps the `SnowLuma` GitHub Environment, so the environment
field must match exactly. The workflows grant `id-token: write`, use Node 24
(which provides a recent enough npm CLI), and publish with provenance. They do
not read `NPM_TOKEN`.

For `@harehane/sdk`, the repository workflow is `sdk-npm-publish.yml` in
`JiyuHane/JiYu` and currently specifies the `SnowLuma` GitHub environment.
Configure the publisher against the actual repository, workflow and environment
only after confirming npm namespace ownership and the applicable distribution
permissions. Neither the new npm package nor its publisher is presumed to exist.

Verify each applicable package and publisher before attempting publication.
The checked-in workflow definitions alone do not establish npm ownership,
existing published versions, or permissions.
