import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify } from "jose";

export const SSO_METADATA_URL =
  "https://login.eveonline.com/.well-known/oauth-authorization-server";

export interface TokenIdentity {
  characterId: number;
  characterName: string;
  scopes: string[];
}

export function characterIdFromToken(token: string): number | undefined {
  try {
    return characterIdFromSubject(decodeJwt(token).sub);
  } catch {
    return undefined;
  }
}

function characterIdFromSubject(subject: unknown): number | undefined {
  if (typeof subject !== "string" || !/^CHARACTER:EVE:[1-9]\d*$/u.test(subject))
    return undefined;
  const value = Number(subject.slice("CHARACTER:EVE:".length));
  return Number.isSafeInteger(value) ? value : undefined;
}

export type TokenVerifier = (
  token: string,
  clientId: string,
) => Promise<TokenIdentity>;

export function createTokenVerifier(
  fetchImplementation: typeof fetch = fetch,
): TokenVerifier {
  let keys: ReturnType<typeof createRemoteJWKSet> | undefined;
  return async (token, clientId) => {
    try {
      if (!keys) {
        const response = await fetchImplementation(SSO_METADATA_URL, {
          redirect: "error",
        });
        if (!response.ok) throw new Error("SSO discovery failed");
        const metadata = (await response.json()) as { jwks_uri?: string };
        const url = new URL(metadata.jwks_uri ?? "");
        if (
          url.origin !== "https://login.eveonline.com" ||
          url.username ||
          url.password
        )
          throw new Error("Invalid SSO signing-key origin");
        keys = createRemoteJWKSet(url, { [customFetch]: fetchImplementation });
      }
      const { payload } = await jwtVerify(token, keys, {
        algorithms: ["RS256"],
        issuer: [
          "login.eveonline.com",
          "https://login.eveonline.com",
          "https://login.eveonline.com/",
        ],
        audience: clientId,
        requiredClaims: ["exp", "sub", "name", "scp"],
      });
      const characterId = characterIdFromSubject(payload.sub);
      if (
        !characterId ||
        typeof payload.name !== "string" ||
        !payload.name.trim() ||
        !Array.isArray(payload.aud) ||
        !payload.aud.includes("EVE Online") ||
        !Array.isArray(payload.scp) ||
        !payload.scp.every((scope) => typeof scope === "string")
      )
        throw new Error("Invalid SSO identity claims");
      return {
        characterId,
        characterName: payload.name,
        scopes: [...new Set(payload.scp)].sort(),
      };
    } catch {
      throw new Error(
        "Could not verify EVE SSO token identity, audience, scopes, or expiration; sign in again.",
      );
    }
  };
}
