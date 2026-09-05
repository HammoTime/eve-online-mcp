# EVE Online MCP

A read-only [Model Context Protocol](https://modelcontextprotocol.io/) server for the complete EVE Online ESI API surface. It lets an AI assistant discover live ESI capabilities, inspect exact parameters and OAuth requirements, retrieve public or character data, and turn that context into practical plans for your next adventure.

The server is generated at runtime from a pinned copy of CCP's OpenAPI 3.1 document. Today it exposes all `GET`/`HEAD` routes plus an explicitly audited allowlist of semantically read-only `POST` lookups (bulk ID/name resolution, affiliations, CSPA calculation, and asset name/location lookup). Every state-changing operation is excluded.

## What the MCP server exposes

- `search_esi_operations` finds endpoints using ordinary keywords, ESI tags, and authentication requirements.
- `get_esi_operation` returns exact parameters, request-body schema, OAuth scopes, cache hints, and rate-limit metadata.
- `call_esi` invokes only catalogued read operations. It rejects undeclared parameters, validates values, fixes the origin to ESI, supplies compatibility headers, and never accepts an Authorization header from a tool call.
- `eve-esi://catalog` describes the pinned API coverage and excluded operation count.
- `plan_eve_adventure` is a prompt for evidence-based recommendations with costs, preparation, risk, travel, and a concrete first action.

ESI cache headers are respected in memory, pagination/rate-limit headers are returned to the model, errors remain structured, responses are limited to 5 MB by default, and a descriptive User-Agent is sent as [recommended by ESI](https://developers.eveonline.com/docs/services/esi/best-practices/).

## Development container

All project commands are intended to run in [the devcontainer](.devcontainer/devcontainer.json). In VS Code, choose **Dev Containers: Reopen in Container**. The container installs the locked dependencies automatically.

From another devcontainer-capable editor, open this repository using `.devcontainer/devcontainer.json`. If you only have Docker, the equivalent environment is:

```sh
docker build --target development -f .devcontainer/Dockerfile -t eve-online-mcp-dev .
docker run --rm -it -v "$PWD:/workspace" -w /workspace eve-online-mcp-dev npm ci
```

The supported commands are:

```sh
npm run dev           # serve MCP over stdio from TypeScript
npm run validate      # formatting, lint, typecheck, tests/coverage, build
npm run schema:check  # compare the pinned and current upstream schemas
npm run schema:update # replace the pin with canonical current OpenAPI JSON
```

## Install and configure an MCP host

Once published, configure your MCP host to run the npm package directly:

```json
{
  "mcpServers": {
    "eve-online": {
      "command": "npx",
      "args": ["-y", "eve-online-mcp"],
      "env": {
        "ESI_USER_AGENT": "YourApp/1.0 (you@example.com; +https://github.com/you/your-repo)"
      }
    }
  }
}
```

For a local checkout, build in the devcontainer and use `node /absolute/path/to/eve-online-mcp/dist/index.js` instead.

### EVE SSO

Public ESI routes need no credentials and never trigger login. On the first operation that needs character or corporation data, the server automatically opens EVE SSO in the browser. After consent it stores only the refresh credential in the user's OS configuration directory, rotates it when EVE returns a replacement, and manages short-lived access tokens in memory. No client secret or manual token handling is required.

The package ships with this public PKCE client configuration:

- Client ID: `6a65f1e650d240659dafbad29fb55e05`
- Callback URL: `http://localhost:52765/callback`

The callback must match the EVE application registration exactly. PKCE is intended for local applications that cannot keep a client secret, so never distribute or commit the client secret. The login can also be started or managed explicitly:

```sh
npx eve-online-mcp auth login
npx eve-online-mcp auth status
npx eve-online-mcp auth logout
```

The default login requests the complete authenticated read-only scope set from the pinned schema. A narrower login can be requested with `auth login --scopes "scope.one scope.two"`, though operations outside that grant will remain unavailable.

<details>
<summary>Complete ESI scope list</summary>

```text
esi-alliances.read_contacts.v1
esi-assets.read_assets.v1
esi-assets.read_corporation_assets.v1
esi-calendar.read_calendar_events.v1
esi-characters.read_agents_research.v1
esi-characters.read_blueprints.v1
esi-characters.read_contacts.v1
esi-characters.read_corporation_roles.v1
esi-characters.read_fatigue.v1
esi-characters.read_fw_stats.v1
esi-characters.read_loyalty.v1
esi-characters.read_medals.v1
esi-characters.read_notifications.v1
esi-characters.read_standings.v1
esi-characters.read_titles.v1
esi-clones.read_clones.v1
esi-clones.read_implants.v1
esi-contracts.read_character_contracts.v1
esi-contracts.read_corporation_contracts.v1
esi-corporations.read_blueprints.v1
esi-corporations.read_contacts.v1
esi-corporations.read_container_logs.v1
esi-corporations.read_corporation_membership.v1
esi-corporations.read_divisions.v1
esi-corporations.read_facilities.v1
esi-corporations.read_fw_stats.v1
esi-corporations.read_medals.v1
esi-corporations.read_standings.v1
esi-corporations.read_starbases.v1
esi-corporations.read_structures.v1
esi-corporations.read_titles.v1
esi-corporations.track_members.v1
esi-fittings.read_fittings.v1
esi-fleets.read_fleet.v1
esi-industry.read_character_jobs.v1
esi-industry.read_character_mining.v1
esi-industry.read_corporation_jobs.v1
esi-industry.read_corporation_mining.v1
esi-killmails.read_corporation_killmails.v1
esi-killmails.read_killmails.v1
esi-location.read_location.v1
esi-location.read_online.v1
esi-location.read_ship_type.v1
esi-mail.read_mail.v1
esi-markets.read_character_orders.v1
esi-markets.read_corporation_orders.v1
esi-markets.structure_markets.v1
esi-planets.manage_planets.v1
esi-planets.read_customs_offices.v1
esi-search.search_structures.v1
esi-skills.read_skillqueue.v1
esi-skills.read_skills.v1
esi-universe.read_structures.v1
esi-wallet.read_character_wallet.v1
esi-wallet.read_corporation_wallets.v1
```

</details>

`EVE_ACCESS_TOKEN`, `EVE_REFRESH_TOKEN`, `EVE_CLIENT_ID`, and `EVE_CLIENT_SECRET` remain supported as non-default overrides for automation or existing credentials. The server reports missing JWT scopes before spending an ESI request.

Optional settings:

| Variable                 | Purpose                                                   |
| ------------------------ | --------------------------------------------------------- |
| `ESI_USER_AGENT`         | Identifies your app and provides contact details to CCP   |
| `ESI_MAX_RESPONSE_BYTES` | Overrides the 5,000,000-byte response ceiling             |
| `ESI_OPENAPI_PATH`       | Loads a different local OpenAPI document for development  |
| `EVE_CREDENTIALS_PATH`   | Overrides the OS credential file location                 |
| `EVE_DISABLE_AUTO_SSO`   | Set to `1` to prevent browser login on protected calls    |
| `EVE_SSO_REDIRECT_URI`   | Overrides the localhost callback for a custom application |

Do not commit tokens or client secrets. Tool responses never include the token, and callers cannot override the ESI origin or inject arbitrary headers.

## Suggested usage

Select the `plan_eve_adventure` prompt in your MCP host, or ask something like:

> Using my current location, skills, wallet, assets, and the nearby market, give me three two-hour exploration plans. Explain risk and startup cost, then recommend the best first step.

The model can discover the relevant endpoints instead of relying on memorized route names. Large paginated datasets should be requested one page at a time using the returned `x-pages` header.

## Schema monitoring

[`esi-schema-monitor.yml`](.github/workflows/esi-schema-monitor.yml) runs daily and on demand. It downloads CCP's current schema, canonicalizes it, compares SHA-256 hashes and operation definitions, and creates one deduplicated GitHub issue describing added, removed, and modified routes. Further detections comment on the open issue rather than creating noise.

After reviewing an update:

```sh
npm run schema:update
npm run validate
```

Review any new non-GET operation manually. Read-only `POST` routes are deliberately allowlisted in `src/openapi.ts`; a new route is not exposed until its semantics are verified.

## Publishing to npm

[`release.yml`](.github/workflows/release.yml) runs on every push to `main`. Release Please maintains a release pull request using Conventional Commit history; use subjects such as `fix: repair release workflow` or `feat: add route planning`. That pull request updates `package.json` and `CHANGELOG.md` together. Merging it creates the matching Git tag and GitHub Release, then validates and packs the project inside the devcontainer and publishes that exact version to npm. A guarded assertion compares the release version, Git tag, and the tagged `package.json` before publishing. The workflow also bootstraps an existing matching GitHub Release when its package version is still absent from npm.

Publishing uses npm trusted publishing through GitHub OIDC and produces provenance. On npm, configure the trusted publisher as repository `HammoTime/eve-online-mcp`, workflow `release.yml`, with direct publishing allowed. Because an unclaimed package cannot have trusted publishing configured yet, its first release requires a granular npm automation token stored as the `NPM_TOKEN` GitHub secret. That one-time bootstrap publish does not request provenance, which also permits recovery of a historical tag whose repository metadata predates the current GitHub owner. After the initial publish, configure trusted publishing and remove the secret; subsequent OIDC releases publish provenance.

## Test suite

Vitest covers catalog filtering, local `$ref` resolution, safe URL and header construction, schema validation, OAuth refresh and scopes, caching, response limits, error handling, schema diffing, and end-to-end MCP tool/resource/prompt calls over an in-memory transport. Coverage gates require at least 80% for statements, lines, functions, and branches. GitHub CI executes the same `npm run validate` command inside the devcontainer image.

Licensed under the [GNU AGPL v3](LICENSE).
