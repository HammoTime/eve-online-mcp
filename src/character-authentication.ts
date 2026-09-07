import type { InteractiveSsoTokenProvider } from "./auth.js";
import type { CredentialStore } from "./credential-store.js";

/** Only non-secret character metadata crosses the MCP boundary. */
export class CharacterAuthentication {
  constructor(
    private readonly store: CredentialStore,
    private readonly interactive?: InteractiveSsoTokenProvider,
  ) {}

  async list() {
    const file = await this.store.read();
    return {
      characters: file.characters.map(
        ({ characterId, characterName, scopes }) => ({
          characterId,
          characterName,
          scopes,
        }),
      ),
      defaultCharacterId: file.defaultCharacterId ?? null,
      legacyCredentialPendingMigration: !!file.legacyCredential,
      browserAuthorizationAvailable: !!this.interactive,
    };
  }

  async authorize(characterId: number) {
    if (!this.interactive)
      throw new Error(
        "Browser authorization is unavailable while environment token overrides are configured.",
      );
    await this.interactive.authorizeCharacter(characterId);
    return this.list();
  }

  async select(characterId: number) {
    if (!this.interactive)
      throw new Error(
        "Character selection is unavailable while environment token overrides are configured.",
      );
    await this.store.select(characterId);
    return this.list();
  }
}
