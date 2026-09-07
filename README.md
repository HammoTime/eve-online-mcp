# EVE Online MCP

A read-only [Model Context Protocol](https://modelcontextprotocol.io/) server for the complete EVE Online ESI API surface. It lets an AI assistant discover live ESI capabilities, inspect exact parameters and OAuth requirements, retrieve public or character data, and turn that context into practical plans for your next adventure.

The server is generated at runtime from a pinned copy of CCP's OpenAPI 3.1 document. Today it exposes all `GET`/`HEAD` routes plus an explicitly audited allowlist of semantically read-only `POST` lookups (bulk ID/name resolution, affiliations, CSPA calculation, and asset name/location lookup). Every state-changing operation is excluded.

## What the MCP server exposes

- `list_eve_characters` lists saved character IDs, names, and granted scopes without exposing credentials.
- `authorize_eve_character` opens browser consent for a specific character, verifies the selected identity, and stores that character's refresh credential. `select_eve_character` chooses a saved character for protected operations that do not name one. These tools manage local authentication only; they never change game state.
- `search_esi_operations` ranks endpoints using deterministic lexical and curated intent matching, supports hard tag/authentication filters and offsets, and explains every match.
- `get_esi_operation` returns exact parameters, request-body schema, required caller inputs, defaults, pagination guidance, OAuth scopes, cache hints, safe examples where available, and rate-limit metadata.
- `call_esi` invokes one page of one catalogued read operation. It rejects undeclared parameters, validates values, fixes the origin to ESI, supplies compatibility headers, and never accepts an Authorization header from a tool call.
- `resolve_eve_entities` performs one exact-only public batch lookup from names to every matching ID/category, or from IDs to names/categories. Ambiguous and unresolved values remain explicit.
- `get_character_context` retrieves only the requested `profile`, `location`, `ship`, `skills`, `skillQueue`, and/or `wallet` sections for an explicit character ID, with per-section data, freshness, and errors.
- `get_market_snapshot` collects bounded pages of public regional orders for one type, optionally filters one exact location, and returns observed aggregates with honest completeness warnings.
- `initialize_static_data` downloads and validates CCP's official static data into a local cache, reports its build/freshness, and checks for updates on request. Startup also initializes in the background.
- `resolve_skill_plan_targets` resolves exact skill/ship names or type IDs against the cache, including explicit skill levels and unique singular skill names. Ambiguous or unresolved inputs return candidates.
- `get_skill_dependencies` returns a public prerequisite graph with skill-level nodes and prerequisite-to-dependent edges, without login.
- `generate_skill_plan` computes a personalized, dependency-checked plan from cached requirements and scoped character skills/queue, removes completed levels, and returns training text and estimated remaining SP.
- `eve-esi://catalog` describes pinned API coverage, excluded operation count, and guidance for the generic and focused workflows.
- `plan_eve_adventure` is a prompt for evidence-based recommendations with costs, preparation, risk, travel, and a concrete first action. Its optional activity playbooks cover exploration, factional warfare, mining, industry, trading, hauling, agent missions, PvE, and PvP.
- `plan_eve_skills` interprets activity/class goals, resolves material choices, and calls the deterministic planning tools. It explains practical support, optional upgrades and eligibility limits.

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

During MCP initialization, the server reports the version from its installed `package.json`, so MCP host diagnostics identify the running package release.

### Discovery in Codex and other MCP hosts

Installing the npm package makes the executable available; the MCP host must also be configured to launch it. For [Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), register the stdio server with:

```sh
codex mcp add eve-online -- npx -y eve-online-mcp
codex mcp list
```

The server advertises EVE Online use cases in every tool's title and description, and returns workflow guidance in the MCP initialization `instructions` field. This lets hosts recognize character sheets, skills, skill queues, markets and other ESI data requests before a prompt or catalog resource is opened. Codex reads these instructions; other hosts may handle them differently. Tool selection remains the host's decision.

For a named character's training plan, use `resolve_eve_entities` to select the character-category ID, `resolve_skill_plan_targets` to verify goals, then `generate_skill_plan` with that explicit character ID. The planner retrieves skills and queue itself. `get_character_context` remains available for character inspection, and other ESI questions use `search_esi_operations`, `get_esi_operation`, then `call_esi`. Public discovery needs no login; protected data uses EVE SSO. ESI does not expose Omega subscription status or saved in-game skill plans, and skill injector recommendations require current game rules and explicit assumptions in addition to character data.

To check discovery after updating the configured server, reconnect it or start a fresh host session and confirm that its tool list contains EVE Online tool titles. Try a request such as: "Use EVE Online data to review the character sheet, skills and skill queue for <exact character name>, and suggest a hauling training plan." The host should discover the EVE tools and resolve the name before retrieving the needed sections. Inspect the tool-call trace to verify that it uses MCP for ESI-covered data before inspecting the game client. This is a manual host check; the automated tests verify initialization metadata and tool listings, not model selection behavior.

If the host still overlooks the server, capture the exact prompt, host/model version, configured server command and arguments, initialization instructions, tool listing and relevant tool-call sequence. Exclude credentials, tokens and private character responses from a shared report. This distinguishes a connection or stale-metadata problem from a host tool-selection problem.

### EVE SSO

Public ESI routes need no credentials and never trigger login. Ask Codex for a character's protected data: when that character has no saved authorization, the server automatically opens EVE SSO in the browser. Select the requested character and approve access; the server verifies the identity, saves its separate refresh credential, and continues the request. Repeat for another character on the same or a different EVE account. Previously authorized characters remain available. No commands, client secret, or manual token handling are required.

Credentials are stored per character, not per EVE account. Both `call_esi` and `get_character_context` select the credential matching the requested `character_id`/`characterId`. A wrong-character browser selection saves nothing and reports the requested and selected IDs. Tokens with a different or unreadable character subject are rejected before making a protected character request. A remaining upstream 403 identifies the character and required scopes; ownership or corporation roles can still deny access even with the correct character.

Codex can inspect saved authorizations using `list_eve_characters` and renew consent using `authorize_eve_character` when scopes are missing or a grant has expired or been revoked. For corporation, fleet, or structure operations without a character path parameter, a sole saved character is used automatically. With multiple saved characters and no default, the server asks Codex to use `select_eve_character` for the intended character. This default never overrides a character-specific request. Login dialogs are serialized, and simultaneous requests for the same missing character share a successful login.

The versioned credential file lives in the user's OS configuration directory. Each entry stores a character ID/name, client ID, granted scopes, creation time, and refresh token. Access tokens stay in memory. Login and refresh validate EVE's signature, issuer, audiences, expiration, and character claims. Refresh-token rotation updates only the matching character; writes use a restricted-permission temporary file, atomic replacement, and locks to coordinate concurrent processes. Running servers reread the store to notice new consent or removal. Old single-credential files migrate on their next protected use after the character identity is verified; adding a new character before migration preserves the legacy credential.

The package ships with this public PKCE client configuration:

- Client ID: `6a65f1e650d240659dafbad29fb55e05`
- Callback URL: `http://localhost:52765/callback`

The callback must match the EVE application registration exactly. PKCE is intended for local applications that cannot keep a client secret, so never distribute or commit the client secret. Optional maintenance commands are available, but are not needed for the Codex workflow. `auth logout` removes all local character credentials:

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

`EVE_ACCESS_TOKEN`, `EVE_REFRESH_TOKEN`, `EVE_CLIENT_ID`, and `EVE_CLIENT_SECRET` remain supported as non-default overrides for automation or existing credentials. An environment token override represents one character and takes precedence over the local store; browser authorization tools are unavailable in that mode. Character requests still check the token subject and required scopes before spending an ESI request. Remove the token override to use automatic multi-character login.

Optional settings:

| Variable                 | Purpose                                                   |
| ------------------------ | --------------------------------------------------------- |
| `ESI_USER_AGENT`         | Optional override for a downstream app's identity/contact |
| `ESI_MAX_RESPONSE_BYTES` | Overrides the 5,000,000-byte response ceiling             |
| `ESI_OPENAPI_PATH`       | Loads a different local OpenAPI document for development  |
| `EVE_CREDENTIALS_PATH`   | Overrides the OS credential file location                 |
| `EVE_DISABLE_AUTO_SSO`   | Set to `1` to prevent browser login on protected calls    |
| `EVE_SSO_REDIRECT_URI`   | Overrides the localhost callback for a custom application |
| `EVE_SDE_CACHE_DIR`      | Overrides the local CCP static-data cache directory       |

Do not commit tokens or client secrets. Tool responses never include the token, and callers cannot override the ESI origin or inject arbitrary headers.

## Suggested usage

### Character skill training plans

The executable planner supports published skills and ship hulls from CCP's [official JSONL SDE](https://developers.eveonline.com/docs/services/static-data/). On first startup it downloads the archive in the background; planning waits for initialization. The archive is roughly 95 MB at the verified build and can change in size. The cache retains the ZIP and a compact, validated skill/ship index. No character snapshots or credentials are written to this cache.

Defaults are `%LOCALAPPDATA%\eve-online-mcp\sde` on Windows, `~/Library/Caches/eve-online-mcp/sde` on macOS, and `$XDG_CACHE_HOME/eve-online-mcp/sde` or `~/.cache/eve-online-mcp/sde` on Linux. Set `EVE_SDE_CACHE_DIR` in the MCP server environment for a different location. In a container this is a container path: mount a persistent volume there to retain data between runs.

Each initialization checks CCP's latest-build manifest when the last successful check is at least five minutes old; `initialize_static_data` with `{"refresh":true}` checks immediately. Conditional ETag requests avoid unchanged downloads. Cache publication is atomic and the index has a SHA-256 integrity check. A failed refresh returns the last validated build with a stale warning. A missing/corrupt cache plus download failure prevents planning rather than supplying empty requirements. Downloads use fixed CCP URLs, bounded streaming and selected ZIP entries, without extracting archive paths.

Example MCP tool arguments (replace `42` with the intended, verified character ID):

```text
initialize_static_data {}
resolve_skill_plan_targets {"target":"exhumer"}
get_skill_dependencies {"target":"Hulk"}
generate_skill_plan {"characterId":42,"target":"Mining II"}
generate_skill_plan {"characterId":42,"target":"exhumer"}
generate_skill_plan {"characterId":42,"targets":[{"typeId":3386,"level":2},"Hulk"],"queuePolicy":"reorder"}
```

`target` and `targets` are mutually exclusive; at most 50 targets are accepted. Names match case-insensitively, with surrounding whitespace removed. Skills accept Roman or numeric levels I–V / 1–5. A bare skill defaults to I, so `exhumer` resolves to **Exhumers I**, not a guessed Hulk fit. Exact ship names produce minimum hull requirements; training the class skill alone does not establish that every hull can be flown. Partial names return suggestions without selecting one. Modules, rigs and complete fitting plans are outside the engine's scope.

The graph uses `(skillId, level)` nodes, all six dogma prerequisite slots, and preceding-level edges. An iterative dependency traversal deduplicates shared nodes, then Kahn's topological sort orders them in **O(V + E)** time and memory for the expanded graph. A separate replay checks every step against the source requirements. Cycles and missing prerequisite metadata fail closed. Already satisfied permanent levels prune completed branches; requesting another level checks current requirements.

`generate_skill_plan` requires both `esi-skills.read_skills.v1` and `esi-skills.read_skillqueue.v1` for the chosen character, checked together before either ESI request. It validates complete skills and queue snapshots, credits partial SP once, and distinguishes trained levels from active restrictions. `queuePolicy=preserve` (default) keeps the observed queue and returns **additions after that queue**, using a conditional projected baseline. `reorder` returns a proposed replacement that includes unrelated queued commitments. Future queue rows never become observed completion; contradictory past completion requires refreshed evidence. Neither policy edits the live queue.

Results contain resolved targets, SDE build/freshness, character source timestamps, retained queue, ordered `plan`, graph edges, estimated missing SP, acquisition checks, and copyable `trainingText`. An empty plan means no additional levels under its declared baseline. Estimates do not establish Alpha/Omega eligibility, fit validity, budget, training duration, or optimal milestone timing. Formula rounding may differ by one SP; source caveats are returned with the result. Review the in-game import preview and available queue slots before applying text.

#### Natural-language goals

Select the `plan_eve_skills` MCP prompt in your host. It requires `character` (an exact character name or ID, as a string) and `goal` (a role, hull/fit, doctrine, or target skill list). Optional `constraints` captures the time horizon, Alpha/Omega state, budget, and preferences. Optional `queuePolicy` is `preserve` by default, or `reorder` to request a proposed new order while retaining unrelated commitments.

Example prompt arguments:

```json
{
  "character": "Exact Character Name",
  "goal": "Build a practical hauling training plan with an early usable milestone",
  "constraints": "Omega; prioritize the first two weeks; no remap or paid skill points",
  "queuePolicy": "preserve"
}
```

The prompt handles requests such as "I want to fly Jump Freighters" by distinguishing the class skill from a specific racial hull and asking for a material choice when needed. It verifies selected targets and calls `generate_skill_plan` for dependencies, progress subtraction, ordering and SP estimates. It separates mandatory hull unlocks, practical support and discretionary upgrades, labels eligibility and timing gaps, and preserves the tool's training text unchanged. The model does not reconstruct the dependency graph or perform a second calculation.

Fetching the prompt does not fetch private data or trigger SSO. The host model subsequently uses the read-only tools. The prompt cannot change a queue, save an in-game plan, purchase/inject skills, or allocate SP. Goal interpretation and discretionary recommendations still depend on the host model; dependency expansion and personalized plan computation execute in tested code. See the [research, algorithm rationale and review scenarios](docs/skill-plan-research.md) for provenance and limits.

### Adventure planning

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

Publishing to npmjs uses npm trusted publishing through GitHub OIDC and produces provenance. On npm, configure the trusted publisher as repository `HammoTime/eve-online-mcp`, workflow `release.yml`, and environment `npmjs.com`, with direct publishing allowed. Because an unclaimed package cannot have trusted publishing configured yet, its first release requires a granular npm automation token stored as the `NPM_TOKEN` GitHub secret. That one-time bootstrap publish does not request provenance, which also permits recovery of a historical tag whose repository metadata predates the current GitHub owner. After the initial publish, configure trusted publishing and remove the secret; subsequent OIDC releases publish provenance. The separate GitHub Packages job deploys to the `github.com` environment and uses the workflow's short-lived `GITHUB_TOKEN` with `packages: write`; no additional package secret is required.

## Test suite

Vitest covers catalog filtering, local `$ref` resolution, safe URL and header construction, schema validation, OAuth refresh and scopes, caching, response limits, error handling, schema diffing, and end-to-end MCP tool/resource/prompt calls over an in-memory transport. Coverage gates require at least 80% for statements, lines, functions, and branches. GitHub CI executes the same `npm run validate` command inside the devcontainer image.

Licensed under the [GNU AGPL v3](LICENSE).
