import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import open from "open";
import { CredentialStore, type StoredCredential } from "./credential-store.js";

const SSO_METADATA_URL =
  "https://login.eveonline.com/.well-known/oauth-authorization-server";
export const DEFAULT_REDIRECT_URI = "http://localhost:52765/callback";

interface SsoMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
}

interface AuthorizationTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
}

export interface SsoLoginOptions {
  clientId: string;
  scopes: string[];
  redirectUri?: string;
  store?: CredentialStore;
  fetchImplementation?: typeof fetch;
  openBrowser?: (url: string) => Promise<void>;
  timeoutMs?: number;
}

export interface SsoLoginResult {
  credentialPath: string;
  scopes: string[];
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function createAuthorizationUrl(
  endpoint: string,
  options: {
    clientId: string;
    redirectUri: string;
    scopes: string[];
    state: string;
    challenge: string;
  },
): URL {
  const url = new URL(endpoint);
  if (url.protocol !== "https:")
    throw new Error("EVE SSO authorization endpoint must use HTTPS");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    scope: options.scopes.join(" "),
    state: options.state,
    code_challenge: options.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url;
}

async function discoverSso(
  fetchImplementation: typeof fetch,
): Promise<SsoMetadata> {
  const response = await fetchImplementation(SSO_METADATA_URL, {
    headers: { accept: "application/json" },
  });
  if (!response.ok)
    throw new Error(`Could not discover EVE SSO: HTTP ${response.status}`);
  const metadata = (await response.json()) as Partial<SsoMetadata>;
  if (!metadata.authorization_endpoint || !metadata.token_endpoint)
    throw new Error("EVE SSO metadata is missing required endpoints");
  if (
    new URL(metadata.authorization_endpoint).protocol !== "https:" ||
    new URL(metadata.token_endpoint).protocol !== "https:"
  ) {
    throw new Error("EVE SSO metadata endpoints must use HTTPS");
  }
  return metadata as SsoMetadata;
}

function validateRedirectUri(value: string): URL {
  const redirect = new URL(value);
  if (
    redirect.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(redirect.hostname) ||
    !redirect.port
  ) {
    throw new Error(
      "The SSO redirect must be an http://localhost or http://127.0.0.1 URL with an explicit port",
    );
  }
  return redirect;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function receiveAuthorizationCode(
  redirect: URL,
  expectedState: string,
  onReady: () => Promise<void>,
  timeoutMs: number,
): Promise<string> {
  let settle: ((value: string) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  const result = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const server = createServer((request, response) => {
    const requestUrl = new URL(
      request.url ?? "/",
      `${redirect.protocol}//${redirect.host}`,
    );
    if (requestUrl.pathname !== redirect.pathname) {
      response.writeHead(404).end("Not found");
      return;
    }
    if (requestUrl.searchParams.get("state") !== expectedState) {
      response
        .writeHead(400)
        .end("Invalid OAuth state. You can close this window.");
      fail?.(new Error("EVE SSO callback state did not match"));
      return;
    }
    const oauthError = requestUrl.searchParams.get("error");
    const code = requestUrl.searchParams.get("code");
    if (oauthError || !code) {
      response
        .writeHead(400)
        .end("EVE authorization was not completed. You can close this window.");
      fail?.(
        new Error(
          `EVE SSO authorization failed${oauthError ? `: ${oauthError}` : ""}`,
        ),
      );
      return;
    }
    response
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(
        "<!doctype html><title>EVE Online MCP</title><p>Authorization complete. You can close this window.</p>",
      );
    settle?.(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(redirect.port), redirect.hostname, resolve);
  });
  const timer = setTimeout(() => {
    fail?.(new Error("Timed out waiting for EVE SSO authorization"));
  }, timeoutMs);
  timer.unref();
  try {
    await onReady();
    return await result;
  } finally {
    clearTimeout(timer);
    await closeServer(server);
  }
}

async function exchangeAuthorizationCode(
  endpoint: string,
  values: {
    clientId: string;
    redirectUri: string;
    code: string;
    verifier: string;
  },
  fetchImplementation: typeof fetch,
): Promise<AuthorizationTokenResponse> {
  const response = await fetchImplementation(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: values.clientId,
      redirect_uri: values.redirectUri,
      code: values.code,
      code_verifier: values.verifier,
    }),
  });
  if (!response.ok)
    throw new Error(
      `EVE SSO token exchange failed with HTTP ${response.status}`,
    );
  const token = (await response.json()) as Partial<AuthorizationTokenResponse>;
  if (!token.access_token || !token.refresh_token || !token.expires_in)
    throw new Error("EVE SSO returned an invalid authorization response");
  return token as AuthorizationTokenResponse;
}

export async function loginWithEveSso(
  options: SsoLoginOptions,
): Promise<SsoLoginResult> {
  if (!options.clientId.trim())
    throw new Error("An EVE SSO client ID is required");
  if (options.scopes.length === 0)
    throw new Error("At least one EVE SSO scope is required");
  const redirectUri = options.redirectUri ?? DEFAULT_REDIRECT_URI;
  const redirect = validateRedirectUri(redirectUri);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const store = options.store ?? new CredentialStore();
  const scopes = [...new Set(options.scopes)].sort();
  const metadata = await discoverSso(fetchImplementation);
  const { verifier, challenge } = createPkce();
  const state = randomBytes(24).toString("base64url");
  const authorizationUrl = createAuthorizationUrl(
    metadata.authorization_endpoint,
    {
      clientId: options.clientId,
      redirectUri,
      scopes,
      state,
      challenge,
    },
  );
  const code = await receiveAuthorizationCode(
    redirect,
    state,
    async () => {
      console.error(
        `Open this URL to sign in with EVE Online:\n${authorizationUrl.href}\n`,
      );
      await (options.openBrowser ?? (async (url) => open(url)))(
        authorizationUrl.href,
      ).catch(() => {
        console.error(
          "The browser could not be opened automatically; use the URL above.",
        );
      });
    },
    options.timeoutMs ?? 300_000,
  );
  const token = await exchangeAuthorizationCode(
    metadata.token_endpoint,
    { clientId: options.clientId, redirectUri, code, verifier },
    fetchImplementation,
  );
  const credential: StoredCredential = {
    clientId: options.clientId,
    refreshToken: token.refresh_token,
    scopes,
    createdAt: new Date().toISOString(),
  };
  await store.write(credential);
  return { credentialPath: store.path, scopes: credential.scopes };
}
