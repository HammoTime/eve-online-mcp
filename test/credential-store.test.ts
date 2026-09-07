import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialStore,
  defaultCredentialPath,
} from "../src/credential-store.js";
import { testCredential } from "./auth-fixtures.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryStore(): Promise<CredentialStore> {
  const directory = await mkdtemp(join(tmpdir(), "eve-online-mcp-test-"));
  temporaryDirectories.push(directory);
  return new CredentialStore(join(directory, "nested", "credentials.json"));
}

const credential = testCredential(42);

describe("CredentialStore", () => {
  it("uses an explicit path or platform config directory", () => {
    expect(
      defaultCredentialPath({ EVE_CREDENTIALS_PATH: "/custom.json" }),
    ).toBe("/custom.json");
    expect(defaultCredentialPath({ APPDATA: "/config" })).toBe(
      join("/config", "eve-online-mcp", "credentials.json"),
    );
  });

  it("writes, reads, and removes a refresh credential", async () => {
    const store = await temporaryStore();
    await expect(store.read()).resolves.toEqual({ version: 2, characters: [] });
    await store.write(credential);
    await expect(store.read()).resolves.toEqual({
      version: 2,
      characters: [credential],
    });
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect(await readFile(store.path, "utf8")).not.toContain("accessToken");
    await expect(store.remove()).resolves.toBe(true);
    await expect(store.remove()).resolves.toBe(false);
  });

  it("rejects malformed credential files", async () => {
    const store = await temporaryStore();
    await store.write(credential);
    await writeFile(store.path, JSON.stringify({ clientId: "client" }));
    await expect(store.read()).rejects.toThrow(/Invalid EVE credential/u);
  });

  it("preserves other characters during concurrent additions, rotation, and deletion", async () => {
    const store = await temporaryStore();
    await Promise.all(
      [42, 43, 44, 45].map((id) =>
        new CredentialStore(store.path).write(testCredential(id)),
      ),
    );
    await store.select(43);
    await Promise.all([
      store.rotate(testCredential(42), "fake-replacement"),
      store.remove(44),
    ]);
    expect(
      (await store.read()).characters.map((entry) => entry.characterId).sort(),
    ).toEqual([42, 43, 45]);
    expect((await store.read()).defaultCharacterId).toBe(43);
    await store.remove(43);
    expect((await store.read()).defaultCharacterId).toBeUndefined();
    await expect(store.remove(999)).resolves.toBe(false);
    await expect(store.select(999)).rejects.toThrow("No saved authorization");
    await expect(
      store.rotate(testCredential(42), "stale-replacement"),
    ).rejects.toThrow("changed during refresh");
    await store.write({
      ...testCredential(42),
      refreshToken: "fake-new-login",
    });
    expect((await store.read()).characters).toHaveLength(2);
  });

  it("keeps legacy credentials when adding a new login before migration", async () => {
    const store = await temporaryStore();
    await store.write(credential);
    const legacy = {
      clientId: "test-client",
      refreshToken: "fake-legacy",
      scopes: [],
      createdAt: "test-date",
    };
    await writeFile(store.path, JSON.stringify(legacy));
    await store.write(testCredential(43));
    expect((await store.read()).legacyCredential).toEqual(legacy);
    await store.migrateLegacy(legacy, credential);
    expect((await store.read()).characters).toHaveLength(2);
    expect((await store.read()).legacyCredential).toBeUndefined();
    await store.migrateLegacy(legacy, testCredential(99));
    expect((await store.read()).characters).toHaveLength(2);
  });

  it.each([
    { version: 2, characters: [credential, credential] },
    { version: 2, characters: [credential], defaultCharacterId: 99 },
    { version: 2, characters: [{ ...credential, characterId: 0 }] },
    { version: 3, characters: [] },
    {
      version: 2,
      characters: [{ ...credential, accessToken: "sensitive-marker" }],
    },
  ])(
    "rejects invalid versioned stores without exposing their contents",
    async (value) => {
      const store = await temporaryStore();
      await store.write(credential);
      await writeFile(store.path, JSON.stringify(value));
      await expect(store.read()).rejects.toThrow("Invalid EVE credential file");
      await writeFile(store.path, 'sensitive-marker{"invalid');
      await expect(store.read()).rejects.not.toThrow("sensitive-marker");
    },
  );
});
