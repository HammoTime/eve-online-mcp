# EVE Online MCP

A read-only [Model Context Protocol](https://modelcontextprotocol.io/) server for the complete EVE Online ESI API surface. It lets an AI assistant discover live ESI capabilities, inspect exact parameters and OAuth requirements, retrieve public or character data, and turn that context into practical plans for your next adventure.

The server is generated at runtime from a pinned copy of CCP's OpenAPI 3.1 document. Today it exposes all `GET`/`HEAD` routes plus an explicitly audited allowlist of semantically read-only `POST` lookups (bulk ID/name resolution, affiliations, CSPA calculation, and asset name/location lookup). Every state-changing operation is excluded.

## What the MCP server exposes

- `search_esi_operations` ranks endpoints using deterministic lexical and curated intent matching, supports hard tag/authentication filters and offsets, and explains every match.
- `get_esi_operation` returns exact parameters, request-body schema, required caller inputs, defaults, pagination guidance, OAuth scopes, cache hints, safe examples where available, and rate-limit metadata.
- `call_esi` invokes one page of one catalogued read operation. It rejects undeclared parameters, validates values, fixes the origin to ESI, supplies compatibility headers, and never accepts an Authorization header from a tool call.
- `resolve_eve_entities` performs one exact-only public batch lookup from names to every matching ID/category, or from IDs to names/categories. Ambiguous and unresolved values remain explicit.
- `get_character_context` retrieves only the requested `profile`, `location`, `ship`, `skills`, `skillQueue`, and/or `wallet` sections for an explicit character ID, with per-section data, freshness, and errors.
- `get_market_snapshot` collects bounded pages of public regional orders for one type, optionally filters one exact location, and returns observed aggregates with honest completeness warnings.
- `eve-esi://catalog` describes pinned API coverage, excluded operation count, and guidance for the generic and focused workflows.
- `plan_eve_adventure` is a prompt for evidence-based recommendations with costs, preparation, risk, travel, and a concrete first action. Its optional activity playbooks cover exploration, factional warfare, mining, industry, trading, hauling, agent missions, PvE, and PvP.

ESI cache headers are respected in memory, protected cache entries are isolated by credential context, and every response reports fetch/serve/expiry timestamps plus defensive page metadata. Errors include stable codes, retryability, Retry-After guidance, and a suggested action. Individual responses and bounded composite workflows use 5 MB safety ceilings. A descriptive User-Agent is sent as [recommended by ESI](https://developers.eveonline.com/docs/services/esi/best-practices/); it is derived from the installed package version and has the form `eve-online-mcp/<version> (adam@hammo.dev; +https://github.com/HammoTime/eve-online-mcp)`.

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
      "args": ["-y", "eve-online-mcp"]
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
| `ESI_USER_AGENT`         | Optional override for a downstream app's identity/contact |
| `ESI_MAX_RESPONSE_BYTES` | Overrides the 5,000,000-byte response ceiling             |
| `ESI_OPENAPI_PATH`       | Loads a different local OpenAPI document for development  |
| `EVE_CREDENTIALS_PATH`   | Overrides the OS credential file location                 |
| `EVE_DISABLE_AUTO_SSO`   | Set to `1` to prevent browser login on protected calls    |
| `EVE_SSO_REDIRECT_URI`   | Overrides the localhost callback for a custom application |

Do not commit tokens or client secrets. Tool responses never include the token, and callers cannot override the ESI origin or inject arbitrary headers.

## Suggested usage

Select the `plan_eve_adventure` prompt in your MCP host, or ask something like:

> Using my current location, skills, wallet, assets, and the nearby market, give me three two-hour exploration plans. Explain risk and startup cost, then recommend the best first step.

The prompt accepts a required free-form `goal`, plus optional `activity`, `characterId`, and `constraints` arguments. Supported activity values are `exploration`, `factional_warfare`, `mining`, `industry`, `trading`, `hauling`, `missions`, `pve`, and `pvp`. Omitting `activity` retains the general planning workflow.

Each activity selects a focused evidence and advice playbook. For example, mining planning can locate owned mining-capable ships, compare the work needed to retrieve them, examine recent mining and skills, compare routes to accessible public markets, and recommend a resource only when price, demand, logistics, and capability support it. Factional-warfare planning checks enrollment, skills, owned ships, budget, war-zone and route evidence, then provides enrollment, staging, ship, and in-game FW-map guidance. Loyalty-point recommendations require current in-game offer details because ESI does not expose the LP Store catalogue.

The model can resolve exact names/IDs, request explicit character sections, and use the bounded public market workflow without relying on memorized route names. Generic questions still use search, inspect, and call. `call_esi` always remains one page; when its validated page count is available, another page can be requested with the returned `pagination.nextCall`.

Character context is not an atomic snapshot: each requested section reports its own source and freshness, and successful public profile retrieval can coexist with a protected-section authentication failure. Skill and skill-queue results retain ESI's warning that completed queue entries may not appear in the skills endpoint until the next character login.

Market snapshots cover the public regional orders endpoint only. `locationId` is an exact local filter over those regional rows, not access to private structure markets. Completeness means all reported pages were accepted within the selected page/byte bounds without detected inconsistency; it does not mean prices are real-time, universally accessible, or executable. Buy-order range and minimum volume still apply, and an observed spread is not guaranteed profit.

## Schema monitoring

[`esi-schema-monitor.yml`](.github/workflows/esi-schema-monitor.yml) runs daily and on demand. It downloads CCP's current schema, canonicalizes it, compares SHA-256 hashes and operation definitions, and creates one deduplicated GitHub issue describing added, removed, and modified routes. Further detections comment on the open issue rather than creating noise.

After reviewing an update:

```sh
npm run schema:update
npm run validate
```

Review any new non-GET operation manually. Read-only `POST` routes are deliberately allowlisted in `src/openapi.ts`; a new route is not exposed until its semantics are verified.

## Publishing to npm and GitHub Packages

[`release.yml`](.github/workflows/release.yml) runs on every push to `main` and on explicit dispatches from the maintenance automation. Release Please maintains a release pull request using Conventional Commit history; use subjects such as `fix: repair release workflow` or `feat: add route planning`. Dependabot uses `fix(deps):` and `fix(deps-dev):` subjects so dependency maintenance produces patch releases. A verified release pull request from the dedicated release app is approved and squash-merged automatically after required checks pass. That pull request updates `package.json`, `package-lock.json`, and `CHANGELOG.md` together. Merging it creates the matching Git tag and GitHub Release, then validates and packs the project inside the devcontainer and publishes that exact version as `eve-online-mcp` on npmjs and `@hammotime/eve-online-mcp` on GitHub Packages. A guarded assertion compares the release version, Git tag, and the tagged `package.json` before publishing. Registry-specific checks make reruns safe after a partial publish and also bootstrap an existing matching GitHub Release when either registry is missing its package version.

Publishing to npmjs uses npm trusted publishing through GitHub OIDC and produces provenance. On npm, configure the trusted publisher as repository `HammoTime/eve-online-mcp`, workflow `release.yml`, and environment `npmjs.com`, with direct publishing allowed. Because an unclaimed package cannot have trusted publishing configured yet, its first release requires a granular npm automation token stored as the `NPM_TOKEN` GitHub secret. That one-time bootstrap publish does not request provenance, which also permits recovery of a historical tag whose repository metadata predates the current GitHub owner. After the initial publish, configure trusted publishing and remove the secret; subsequent OIDC releases publish provenance. GitHub Packages publishing uses the workflow's short-lived `GITHUB_TOKEN` with `packages: write`; no additional package secret is required.

## Test suite

Vitest covers catalog filtering, local `$ref` resolution, safe URL and header construction, schema validation, OAuth refresh and scopes, caching, response limits, error handling, schema diffing, and end-to-end MCP tool/resource/prompt calls over an in-memory transport. Coverage gates require at least 80% for statements, lines, functions, and branches. GitHub CI executes the same `npm run validate` command inside the devcontainer image.

Licensed under the [GNU AGPL v3](LICENSE).
