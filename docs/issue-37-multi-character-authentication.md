# Issue #37: per-character authorization

The previous provider held one refresh credential and reused its access token for every protected operation. A public profile lookup could therefore succeed for a second character while private training requests used the first character's token and failed with HTTP 403. The report does not establish whether scopes or other ESI restrictions also contributed.

EVE SSO grants consent for one selected character. The final design uses per-character storage, as requested during implementation, superseding the issue's initial account-grouping proposal. See [EVE SSO documentation](https://developers.eveonline.com/docs/services/sso/).

## User flow

1. Codex requests skills and queue for a character. Public operations remain credential-free.
2. The server selects the saved credential by the requested character ID. If absent, it launches PKCE browser consent for that character.
3. After consent, the server verifies the signed token's identity and granted scopes before saving. A different selected character fails without overwriting existing credentials.
4. The original request continues. Another character follows the same flow, without replacing earlier grants or requiring commands.
5. Codex can list non-secret character metadata or explicitly renew consent through MCP tools. A default can be selected for corporation or other operations lacking a character path parameter; ambiguous selection fails explicitly.

## Data and request boundaries

The version 2 document contains a `characters` array, an optional `defaultCharacterId`, and an optional pending `legacyCredential`. Character IDs are unique positive safe integers. Only refresh credentials and non-secret metadata are persisted; status/tool outputs project a narrower ID/name/scope view. Validation errors never quote credential file contents.

Both generic calls and composite character-context preflight pass the requested identity to the token provider. Reusing a preflight authorization for another character fails the same subject check as a direct call. The token hash remains part of protected response cache keys. Scope failures, character mismatches, ambiguous selection, and upstream access denials are distinguished without exposing tokens or guessing that a 403 proves a specific cause.

Login dialogs serialize within a provider and recheck the store before automatic consent. Failed consent does not poison later attempts. Refresh requests coalesce per provider; per-character file locks coordinate refresh-token rotation across processes. Store updates acquire a separate lock, reread the latest document, and atomically replace it. Rotation compares the previous credential so an in-flight refresh cannot restore a removed or superseded login. File locks time out after 30 seconds and never silently break a lock held by another process. A process terminated while holding a lock may require removal of its stale lock directory after confirming no authentication process still owns it.

Legacy files remain readable and are migrated after a verified refresh. If a user adds another character first, the legacy credential is retained until migration. A newer explicit login for the same character takes precedence. Migration failure leaves the original file unchanged.

Environment token overrides keep their existing precedence and represent one character. The browser-login tools are disabled while such overrides are active. Direct environment access tokens are checked for scopes and matching subject locally; ESI remains responsible for validating those caller-configured tokens. Login and refreshed tokens are verified against EVE SSO's signing keys.

## Validation

Automated coverage includes public calls without login; two-character skills/queue retrieval through in-memory MCP; automatic consent, cancellation and retry; wrong-character selection; scope failures; signed JWT validation; per-character rotation, concurrent writers, migration, default selection, and redacted MCP output. No EVE credentials or live character data are required by the test suite.
