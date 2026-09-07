import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  characterIdFromToken,
  createTokenVerifier,
} from "../src/token-identity.js";

let key: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
  key = await generateKeyPair("RS256");
});
async function signedToken(overrides: JWTPayload = {}) {
  return new SignJWT({
    sub: "CHARACTER:EVE:42",
    name: "Test Pilot",
    scp: ["scope.one"],
    iss: "https://login.eveonline.com/",
    aud: ["EVE Online", "test-client"],
    exp: Math.floor(Date.now() / 1000) + 1200,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .sign(key.privateKey);
}
async function verifier() {
  const jwk = {
    ...(await exportJWK(key.publicKey)),
    kid: "test-key",
    alg: "RS256",
  };
  const fetchMock = vi.fn<typeof fetch>((url) =>
    Promise.resolve(
      new Response(
        JSON.stringify(
          (url instanceof Request ? url.url : url.toString()).includes(
            ".well-known",
          )
            ? { jwks_uri: "https://login.eveonline.com/oauth/jwks" }
            : { keys: [jwk] },
        ),
        { headers: { "content-type": "application/json" } },
      ),
    ),
  );
  return { verify: createTokenVerifier(fetchMock), fetchMock };
}

describe("verified EVE character identity", () => {
  it("verifies signature, issuer, both audiences, expiry, identity and granted scopes; caches signing keys", async () => {
    const { verify, fetchMock } = await verifier();
    const token = await signedToken();
    expect(await verify(token, "test-client")).toEqual({
      characterId: 42,
      characterName: "Test Pilot",
      scopes: ["scope.one"],
    });
    await verify(token, "test-client");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(characterIdFromToken(token)).toBe(42);
    expect(characterIdFromToken("opaque")).toBeUndefined();
  });

  it.each([
    { sub: "CHARACTER:EVE:0" },
    { sub: "CHARACTER:EVE:9007199254740992" },
    { sub: "other" },
    { name: 42 },
    { scp: "scope.one" },
    { scp: [42] },
    { aud: ["EVE Online", "other-client"] },
    { aud: ["test-client"] },
    { iss: "https://other.test" },
    { exp: 1 },
  ])("rejects invalid claims without echoing the token", async (claims) => {
    const { verify } = await verifier();
    const token = await signedToken(claims);
    await expect(verify(token, "test-client")).rejects.toThrow(
      "Could not verify EVE SSO",
    );
    await expect(verify(token, "test-client")).rejects.not.toThrow(token);
  });

  it("rejects a tampered signature and untrusted signing-key discovery", async () => {
    const { verify } = await verifier();
    const token = await signedToken();
    const parts = token.split(".");
    parts[2] = Buffer.alloc(256).toString("base64url");
    await expect(verify(parts.join("."), "test-client")).rejects.toThrow(
      "Could not verify",
    );
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ jwks_uri: "https://attacker.test/keys" }),
        ),
      ),
    );
    await expect(
      createTokenVerifier(fetchMock)(token, "test-client"),
    ).rejects.toThrow("Could not verify");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
