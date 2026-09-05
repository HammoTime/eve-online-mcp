# AGENTS.md

These instructions apply to the entire repository.

## AI-first operating model

This is an AI-first workspace. When the user states an outcome, own the implementation and repository operations needed to reach it. Do not hand routine edits, Git commands, GitHub operations, release steps, or failure investigation back to the user. Use the devcontainer for development and the connected GitHub integration for repository operations. Ask the user only for an authentication prompt, a secret that cannot be provisioned through the available integrations, or a product decision with materially different outcomes.

For an authorized change, continue through implementation, validation, a Conventional Commit, push, pull-request handling when required, CI observation, and repair of failures. Confirm the requested outcome in the external system instead of stopping after editing local files. Never expose credentials in source, logs, issues, pull requests, or chat.

## Project purpose

`eve-online-mcp` is a TypeScript MCP server that gives AI assistants safe, read-only access to the EVE Online ESI API. Preserve its core guarantees:

- Expose every ESI `GET` and `HEAD` operation from the pinned OpenAPI document.
- Expose a `POST` operation only when it has been manually verified to be semantically read-only and added to `SAFE_POST_OPERATION_IDS` in `src/openapi.ts`.
- Never expose ESI operations that change game state, send messages, alter UI state, or mutate character, corporation, fleet, fitting, contact, calendar, or mail data.
- Never accept an arbitrary URL, HTTP method, Authorization header, or undeclared OpenAPI parameter from an MCP caller.
- Keep public ESI operations credential-free. Authentication should occur only when an operation requires scopes.

## Development environment

Use `.devcontainer/devcontainer.json` for all development, dependency installation, formatting, builds, and tests. Do not rely on host-installed Node.js or npm behavior.

When a devcontainer-capable editor is unavailable, use the equivalent Docker environment:

```sh
docker build --target development -f .devcontainer/Dockerfile -t eve-online-mcp-dev .
docker run --rm --user node -v "$PWD:/workspace" -w /workspace eve-online-mcp-dev npm ci
```

Run repository commands inside that container. Keep `package-lock.json` synchronized with `package.json` by running `npm install` in the devcontainer when dependencies change.

## Architecture

- `src/index.ts` is the stdio and CLI entry point.
- `src/server.ts` defines MCP tools, resources, and prompts.
- `src/openapi.ts` loads the pinned schema, builds the operation catalog, and enforces the read-only operation allowlist.
- `src/esi-client.ts` validates parameters, constructs fixed-origin ESI requests, handles caching and response limits, and returns useful response metadata.
- `src/auth.ts`, `src/sso.ts`, and `src/credential-store.ts` implement PKCE login, token refresh, token rotation, and local credential persistence.
- `src/schema-diff.ts` and `scripts/` implement deterministic schema updates and monitoring.
- `openapi/esi-openapi.json` is the canonical, pinned upstream schema used at runtime.

Prefer small, testable modules and dependency injection for network, filesystem, browser, and time-dependent behavior. Do not write protocol messages or diagnostics to stdout while the MCP stdio server is running; stdout is reserved for MCP. Authentication diagnostics must use stderr.

## EVE SSO and credentials

The public client ID in `src/auth.ts` is intentionally distributable. The default callback is `http://localhost:52765/callback`, and the default authentication flow is Authorization Code with PKCE.

- Do not add or require a client secret for the default local flow.
- Never commit client secrets, access tokens, refresh tokens, authorization codes, or test fixtures that resemble usable credentials.
- Persist only the refresh credential and non-secret metadata. Keep access tokens in memory.
- Preserve refresh-token rotation: if EVE returns a new refresh token, store the replacement.
- Continue to support environment-based credentials for non-interactive automation without making them the default user experience.
- Any authentication change must include tests for public access without login, first protected-call login, scope validation, refresh behavior, and credential storage.

## OpenAPI changes

Use these commands in the devcontainer:

```sh
npm run schema:check
npm run schema:update
```

After `schema:update`, inspect the schema diff and operation counts. Review every new or changed non-GET operation manually. Do not infer that `POST` is safe from its scope name alone; confirm its documented behavior and request body before updating `SAFE_POST_OPERATION_IDS`.

Keep `.github/workflows/esi-schema-monitor.yml` deterministic and deduplicated so repeated detections update one open issue rather than creating issue spam.

## Quality requirements

Before finishing a change, run:

```sh
npm run validate
```

This must pass formatting, strict ESLint, TypeScript type checking, Vitest coverage thresholds, and a clean production build. Add or update tests for every behavioral change. Important coverage areas include:

- Read-only catalog filtering and safe POST classification.
- OpenAPI reference and parameter handling.
- URL, path, query, body, and header validation.
- Authentication, PKCE, scopes, token rotation, and credential storage.
- Cache variation, pagination/rate-limit metadata, response limits, and errors.
- MCP tool, resource, and prompt behavior through an in-memory transport.
- Schema canonicalization and change summaries.

For packaging changes, also run `npm pack --dry-run` in the devcontainer and inspect the file list. Generated `dist/`, coverage output, tarballs, credentials, and secrets must not be committed.

## Releases

Use Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, and `chore:`. `.github/workflows/release.yml` runs on pushes to `main`; Release Please owns version bumps, `CHANGELOG.md`, tags, and GitHub Releases. The publish job must verify that the Release Please version, Git tag, and `package.json` version match before publishing to npm.

Do not manually create a conflicting version tag or independently bump the npm version unless intentionally repairing the release process. Preserve npm trusted publishing through GitHub OIDC and provenance. The workflow may bootstrap an existing matching GitHub Release only when that exact version is absent from npm. The `NPM_TOKEN` secret is required for the first publication of an unclaimed package, not the preferred long-term authentication mechanism.

Agents own the release lifecycle end-to-end:

1. Inspect the current GitHub releases, tags, open Release Please pull request, npm version, and recent workflow runs before changing release state.
2. Implement and validate changes in the devcontainer, then create a Conventional Commit and push it. Do not ask the user to run Git commands.
3. Follow the resulting CI and release workflow runs to completion. Read failed job logs, repair in-scope problems, push the fix, and repeat until green.
4. Review the Release Please pull request for the intended SemVer bump, synchronized `package.json`/lockfile versions, and accurate changelog. Merge it when its required checks pass and the requested work is ready for release.
5. Follow the tag, GitHub Release, and npm publish jobs through completion. Verify the published npm version, package contents, provenance, and correspondence with the Git tag.
6. For the first publication only, use the repository's configured `NPM_TOKEN` secret if npm cannot yet establish trusted publishing. A bootstrap of a historical tag may omit provenance when that immutable tag predates corrected repository metadata. Once the package exists, configure or verify the `HammoTime/eve-online-mcp` trusted publisher for `.github/workflows/release.yml`, require provenance through OIDC for future releases, and remove obsolete long-lived publishing credentials when the integration permits it.
7. If permissions, required authentication, branch protection, npm policy, or an unavailable secret prevents completion, report the exact failed operation and the smallest user action needed. Resume and finish the lifecycle after that action instead of leaving a checklist for the user.

## Documentation

Keep `README.md` aligned with actual commands, MCP tools, callback URLs, environment variables, scope behavior, and release workflow filenames. When behavior changes, update documentation in the same change.
