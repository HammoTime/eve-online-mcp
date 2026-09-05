import {
  CredentialStore,
  defaultCredentialPath,
  type StoredCredential,
} from "./credential-store.js";
import { loginWithEveSso, type SsoLoginOptions } from "./sso.js";

export const DEFAULT_EVE_CLIENT_ID = "6a65f1e650d240659dafbad29fb55e05";

export interface TokenProvider {
  getAccessToken(requiredScopes?: string[]): Promise<string | undefined>;
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

  constructor(
    private readonly clientId: string,
    refreshToken: string,
    private readonly clientSecret: string | undefined,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly onRefreshToken?: (refreshToken: string) => Promise<void>,
  ) {
    this.currentRefreshToken = refreshToken;
  }

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now() + 60_000)
      return this.cached.token;

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
    if (!value.access_token || !Number.isFinite(value.expires_in))
      throw new Error("EVE SSO returned an invalid token response");
    if (
      value.refresh_token &&
      value.refresh_token !== this.currentRefreshToken
    ) {
      this.currentRefreshToken = value.refresh_token;
      await this.onRefreshToken?.(value.refresh_token);
    }
    this.cached = {
      token: value.access_token,
      expiresAt: Date.now() + value.expires_in * 1000,
    };
    return value.access_token;
  }
}

export class StoredCredentialTokenProvider implements TokenProvider {
  private provider?: RefreshTokenProvider;

  constructor(
    private readonly store: CredentialStore,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async getAccessToken(): Promise<string | undefined> {
    if (!this.provider) {
      const credential = await this.store.read();
      if (!credential) return undefined;
      this.provider = new RefreshTokenProvider(
        credential.clientId,
        credential.refreshToken,
        undefined,
        this.fetchImplementation,
        async (refreshToken) => {
          const updated: StoredCredential = { ...credential, refreshToken };
          await this.store.write(updated);
        },
      );
    }
    return this.provider.getAccessToken();
  }
}

export class InteractiveSsoTokenProvider implements TokenProvider {
  private readonly storedProvider: StoredCredentialTokenProvider;
  private loginPromise?: Promise<void>;

  constructor(
    private readonly store: CredentialStore,
    private readonly clientId: string,
    private readonly scopes: string[],
    fetchImplementation: typeof fetch = fetch,
    private readonly loginImplementation: (
      options: SsoLoginOptions,
    ) => Promise<unknown> = loginWithEveSso,
  ) {
    this.storedProvider = new StoredCredentialTokenProvider(
      store,
      fetchImplementation,
    );
  }

  async getAccessToken(): Promise<string> {
    const existing = await this.storedProvider.getAccessToken();
    if (existing) return existing;
    this.loginPromise ??= this.loginImplementation({
      clientId: this.clientId,
      scopes: this.scopes,
      store: this.store,
    }).then(() => undefined);
    await this.loginPromise;
    const token = await this.storedProvider.getAccessToken();
    if (!token)
      throw new Error("EVE SSO completed without storing a credential");
    return token;
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
    return new RefreshTokenProvider(
      environment.EVE_CLIENT_ID,
      environment.EVE_REFRESH_TOKEN,
      environment.EVE_CLIENT_SECRET,
      fetchImplementation,
    );
  }
  const store = new CredentialStore(defaultCredentialPath(environment));
  if (options.interactive !== false && options.scopes?.length) {
    return new InteractiveSsoTokenProvider(
      store,
      environment.EVE_CLIENT_ID ?? options.clientId ?? DEFAULT_EVE_CLIENT_ID,
      options.scopes,
      fetchImplementation,
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
