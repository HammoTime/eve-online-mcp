import {
  CredentialStore,
  defaultCredentialPath,
  sameCredential,
  type CharacterCredential,
} from "./credential-store.js";
import { loginWithEveSso, type SsoLoginOptions } from "./sso.js";
import {
  createTokenVerifier,
  type TokenVerifier,
  type TokenIdentity,
} from "./token-identity.js";

import {
  AuthenticationError,
  DEFAULT_EVE_CLIENT_ID,
  RefreshTokenProvider,
  StaticTokenProvider,
  type TokenProvider,
} from "../lib/src/auth.js";
export * from "../lib/src/auth.js";

export class StoredCredentialTokenProvider implements TokenProvider {
  private readonly providers = new Map<
    number,
    { credential: CharacterCredential; provider: RefreshTokenProvider }
  >();

  constructor(
    private readonly store: CredentialStore,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly verify: TokenVerifier = createTokenVerifier(
      fetchImplementation,
    ),
  ) {}

  async getAccessToken(
    requiredScopes: string[] = [],
    characterId?: number,
  ): Promise<string | undefined> {
    let file = await this.store.read();
    if (
      file.legacyCredential &&
      (characterId === undefined ||
        !file.characters.some((entry) => entry.characterId === characterId))
    ) {
      await this.store.withRefreshLock("legacy", async () => {
        const legacy = (await this.store.read()).legacyCredential;
        if (!legacy) return;
        let identity: TokenIdentity | undefined;
        let refreshToken = legacy.refreshToken;
        const provider = new RefreshTokenProvider(
          legacy.clientId,
          refreshToken,
          undefined,
          this.fetchImplementation,
          (replacement) => {
            refreshToken = replacement;
          },
          async (token) => {
            identity = await this.verify(token, legacy.clientId);
          },
        );
        await provider.getAccessToken();
        if (!identity)
          throw new Error(
            "EVE SSO did not return a verified character identity.",
          );
        await this.store.migrateLegacy(legacy, {
          ...legacy,
          ...identity,
          refreshToken,
        });
      });
      file = await this.store.read();
    }
    const characters = file.characters;
    const selected =
      characterId ??
      file.defaultCharacterId ??
      (characters.length === 1 ? characters[0]?.characterId : undefined);
    if (selected === undefined) {
      if (characters.length > 1)
        throw new AuthenticationError(
          "Choose an authorized character for this protected operation using select_eve_character.",
          "CHARACTER_SELECTION_REQUIRED",
        );
      return undefined;
    }
    return this.store.withRefreshLock(selected, async () => {
      const credential = (await this.store.read()).characters.find(
        (entry) => entry.characterId === selected,
      );
      if (!credential) {
        this.providers.delete(selected);
        return undefined;
      }
      const missingScopes = requiredScopes.filter(
        (scope) => !credential.scopes.includes(scope),
      );
      if (missingScopes.length)
        throw new AuthenticationError(
          `Character ${selected} lacks required scopes; use authorize_eve_character to grant access.`,
          "MISSING_SCOPES",
          { characterId: selected, missingScopes },
        );
      let cached = this.providers.get(selected);
      if (!cached || !sameCredential(cached.credential, credential)) {
        const entry = {
          credential,
          provider: new RefreshTokenProvider(
            credential.clientId,
            credential.refreshToken,
            undefined,
            this.fetchImplementation,
            async (refreshToken) => {
              entry.credential = await this.store.rotate(
                entry.credential,
                refreshToken,
              );
            },
            async (token) => {
              const identity = await this.verify(token, credential.clientId);
              if (identity.characterId !== selected)
                throw new AuthenticationError(
                  `The saved credential for character ${selected} authenticated character ${identity.characterId}; authorize the requested character again.`,
                  "CHARACTER_MISMATCH",
                  {
                    characterId: selected,
                    authenticatedCharacterId: identity.characterId,
                  },
                );
              const missingScopes = credential.scopes.filter(
                (scope) => !identity.scopes.includes(scope),
              );
              if (missingScopes.length)
                throw new AuthenticationError(
                  "The refreshed EVE authorization lacks saved scopes; authorize the character again.",
                  "MISSING_SCOPES",
                  { characterId: selected, missingScopes },
                );
            },
          ),
        };
        cached = entry;
        this.providers.set(selected, cached);
      }
      try {
        const token = await cached.provider.getAccessToken();
        // Refresh verification and rotation both await external work. Recheck
        // even for a cached token or a response without refresh-token rotation.
        await this.store.assertCurrent(cached.credential);
        return token;
      } catch (error) {
        this.providers.delete(selected);
        throw error;
      }
    });
  }
}

export class InteractiveSsoTokenProvider implements TokenProvider {
  private readonly storedProvider: StoredCredentialTokenProvider;
  private loginTail: Promise<unknown> = Promise.resolve();

  constructor(
    readonly store: CredentialStore,
    private readonly clientId: string,
    private readonly scopes: string[],
    fetchImplementation: typeof fetch = fetch,
    private readonly loginImplementation: (
      options: SsoLoginOptions,
    ) => Promise<unknown> = loginWithEveSso,
    verify: TokenVerifier = createTokenVerifier(fetchImplementation),
    private readonly redirectUri?: string,
  ) {
    this.storedProvider = new StoredCredentialTokenProvider(
      store,
      fetchImplementation,
      verify,
    );
  }

  async getAccessToken(
    requiredScopes: string[] = [],
    characterId?: number,
  ): Promise<string> {
    const existing = await this.storedProvider.getAccessToken(
      requiredScopes,
      characterId,
    );
    if (existing) return existing;
    await this.enqueueLogin(async () => {
      if (await this.storedProvider.getAccessToken(requiredScopes, characterId))
        return;
      await this.login(characterId);
    });
    const token = await this.storedProvider.getAccessToken(
      requiredScopes,
      characterId,
    );
    if (!token)
      throw new Error("EVE SSO completed without storing a credential");
    return token;
  }

  async authorizeCharacter(characterId: number): Promise<void> {
    await this.enqueueLogin(async () => {
      await this.login(characterId);
    });
  }

  private async login(characterId?: number): Promise<void> {
    await this.loginImplementation({
      clientId: this.clientId,
      scopes: this.scopes,
      store: this.store,
      ...(characterId === undefined
        ? {}
        : { expectedCharacterId: characterId }),
      ...(this.redirectUri === undefined
        ? {}
        : { redirectUri: this.redirectUri }),
    });
  }

  private async enqueueLogin(action: () => Promise<void>): Promise<void> {
    const pending = this.loginTail.then(action);
    this.loginTail = pending.catch(() => undefined);
    await pending;
  }
}

export function tokenProviderFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImplementation: typeof fetch = fetch,
  options: { clientId?: string; scopes?: string[]; interactive?: boolean } = {},
): TokenProvider {
  if (environment.EVE_ACCESS_TOKEN)
    return new StaticTokenProvider(environment.EVE_ACCESS_TOKEN);
  if (environment.EVE_CLIENT_ID && environment.EVE_REFRESH_TOKEN) {
    const clientId = environment.EVE_CLIENT_ID;
    const verify = createTokenVerifier(fetchImplementation);
    return new RefreshTokenProvider(
      environment.EVE_CLIENT_ID,
      environment.EVE_REFRESH_TOKEN,
      environment.EVE_CLIENT_SECRET,
      fetchImplementation,
      undefined,
      async (token) => {
        await verify(token, clientId);
      },
    );
  }
  const store = new CredentialStore(defaultCredentialPath(environment));
  if (options.interactive !== false && options.scopes?.length) {
    return new InteractiveSsoTokenProvider(
      store,
      environment.EVE_CLIENT_ID ?? options.clientId ?? DEFAULT_EVE_CLIENT_ID,
      options.scopes,
      fetchImplementation,
      loginWithEveSso,
      createTokenVerifier(fetchImplementation),
      environment.EVE_SSO_REDIRECT_URI,
    );
  }
  return new StoredCredentialTokenProvider(store, fetchImplementation);
}
