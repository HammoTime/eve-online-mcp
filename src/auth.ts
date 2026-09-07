import {
  CredentialStore,
  defaultCredentialPath,
  type CharacterCredential,
} from "./credential-store.js";
import { loginWithEveSso, type SsoLoginOptions } from "./sso.js";
import {
  createTokenVerifier,
  type TokenVerifier,
  type TokenIdentity,
} from "./token-identity.js";

export const DEFAULT_EVE_CLIENT_ID = "6a65f1e650d240659dafbad29fb55e05";

export interface TokenProvider {
  getAccessToken(
    requiredScopes?: string[],
    characterId?: number,
  ): Promise<string | undefined>;
}

export class AuthenticationError extends Error {
  constructor(
    message: string,
    readonly code:
      "CHARACTER_MISMATCH" | "CHARACTER_SELECTION_REQUIRED" | "MISSING_SCOPES",
    readonly details: {
      characterId?: number;
      authenticatedCharacterId?: number;
      missingScopes?: string[];
    } = {},
  ) {
    super(message);
  }
}

export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly token: string | undefined) {}

  getAccessToken(): Promise<string | undefined> {
    return Promise.resolve(this.token);
  }
}

interface RefreshResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

export class RefreshTokenProvider implements TokenProvider {
  private cached?: { token: string; expiresAt: number };
  private currentRefreshToken: string;
  private pending: Promise<string> | undefined;

  constructor(
    private readonly clientId: string,
    refreshToken: string,
    private readonly clientSecret: string | undefined,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly onRefreshToken?: (
      refreshToken: string,
    ) => Promise<void> | void,
    private readonly verifyAccessToken?: (token: string) => Promise<void>,
  ) {
    this.currentRefreshToken = refreshToken;
  }

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now() + 60_000)
      return this.cached.token;

    this.pending ??= this.refresh().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async refresh(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.currentRefreshToken,
    });
    const headers = new Headers({
      "content-type": "application/x-www-form-urlencoded",
    });
    if (this.clientSecret) {
      headers.set(
        "authorization",
        `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
      );
    } else {
      body.set("client_id", this.clientId);
    }

    const response = await this.fetchImplementation(
      "https://login.eveonline.com/v2/oauth/token",
      {
        method: "POST",
        headers,
        body,
      },
    );
    if (!response.ok)
      throw new Error(
        `EVE SSO token refresh failed with HTTP ${response.status}`,
      );
    const value = (await response.json()) as RefreshResponse;
    if (
      typeof value.access_token !== "string" ||
      !value.access_token ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 0 ||
      (value.refresh_token !== undefined &&
        (typeof value.refresh_token !== "string" || !value.refresh_token))
    )
      throw new Error("EVE SSO returned an invalid token response");
    await this.verifyAccessToken?.(value.access_token);
    if (
      value.refresh_token &&
      value.refresh_token !== this.currentRefreshToken
    ) {
      await this.onRefreshToken?.(value.refresh_token);
      this.currentRefreshToken = value.refresh_token;
    }
    this.cached = {
      token: value.access_token,
      expiresAt: Date.now() + value.expires_in * 1000,
    };
    return value.access_token;
  }
}

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
      if (
        cached?.credential.refreshToken !== credential.refreshToken ||
        cached.credential.clientId !== credential.clientId ||
        cached.credential.createdAt !== credential.createdAt ||
        JSON.stringify(cached.credential.scopes) !==
          JSON.stringify(credential.scopes)
      ) {
        const entry = {
          credential,
          provider: new RefreshTokenProvider(
            credential.clientId,
            credential.refreshToken,
            undefined,
            this.fetchImplementation,
            async (refreshToken) => {
              await this.store.rotate(entry.credential, refreshToken);
              entry.credential = { ...entry.credential, refreshToken };
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
            },
          ),
        };
        cached = entry;
        this.providers.set(selected, cached);
      }
      return cached.provider.getAccessToken();
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

export function missingTokenScopes(
  token: string,
  requiredScopes: string[],
): string[] {
  if (requiredScopes.length === 0) return [];
  const payload = token.split(".")[1];
  if (!payload) return [];
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { scp?: string | string[] };
    if (!decoded.scp) return [];
    const granted = new Set(
      Array.isArray(decoded.scp) ? decoded.scp : decoded.scp.split(" "),
    );
    return requiredScopes.filter((scope) => !granted.has(scope));
  } catch {
    return [];
  }
}
