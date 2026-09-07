import type { CharacterCredential } from "../src/credential-store.js";
import type { TokenVerifier } from "../src/token-identity.js";

export const trainingScopes = [
  "esi-skills.read_skills.v1",
  "esi-skills.read_skillqueue.v1",
];

export function testCredential(
  characterId = 42,
  scopes = trainingScopes,
): CharacterCredential {
  return {
    characterId,
    characterName: `Test Pilot ${characterId}`,
    clientId: "test-client",
    refreshToken: `fake-refresh-${characterId}`,
    scopes,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

// Deliberately unsigned and unusable against EVE; signature validation has its own tests.
export function testToken(characterId = 42, scopes = trainingScopes): string {
  return `test.${Buffer.from(JSON.stringify({ sub: `CHARACTER:EVE:${characterId}`, scp: scopes })).toString("base64url")}.invalid`;
}

export const testVerifier: TokenVerifier = (token) => {
  const claims = JSON.parse(
    Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
  ) as { sub: string; scp: string[] };
  const characterId = Number(claims.sub.split(":")[2]);
  return Promise.resolve({
    characterId,
    characterName: `Test Pilot ${characterId}`,
    scopes: claims.scp,
  });
};
