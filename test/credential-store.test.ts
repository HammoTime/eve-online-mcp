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
      characters: [{ ...credential, generation: expect.any(String) }],
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
    const previous = (await store.read()).characters.find(
      (entry) => entry.characterId === 42,
    );
    if (!previous) throw new Error("Missing fixture credential");
    await Promise.all([
      store.rotate(previous, "fake-replacement"),
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
    await expect(store.rotate(previous, "stale-replacement")).rejects.toThrow(
      "changed during refresh",
    );
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
    const saved = (await store.read()).legacyCredential;
    expect(saved).toEqual({ ...legacy, generation: expect.any(String) });
    if (!saved) throw new Error("Missing fixture credential");
    await store.migrateLegacy(saved, credential);
    expect((await store.read()).characters).toHaveLength(2);
    expect((await store.read()).legacyCredential).toBeUndefined();
    await expect(
      store.migrateLegacy(saved, testCredential(99)),
    ).rejects.toThrow("changed during refresh");
    expect((await store.read()).characters).toHaveLength(2);
  });

  it("migrates shipped v2 generations once across concurrent store readers", async () => {
    const store = await temporaryStore();
    await store.write(credential);
    await writeFile(
      store.path,
      JSON.stringify({
        version: 2,
        characters: [credential, testCredential(43)],
        defaultCharacterId: 42,
      }),
    );
    const files = await Promise.all([
      store.read(),
      new CredentialStore(store.path).read(),
    ]);
    expect(files[0]).toEqual(files[1]);
    expect(files[0].defaultCharacterId).toBe(42);
    const generations = files[0].characters.map((entry) => entry.generation);
    expect(generations).toEqual([expect.any(String), expect.any(String)]);
    expect(new Set(generations).size).toBe(2);
    expect(await store.read()).toEqual(files[0]);
    expect(JSON.parse(await readFile(store.path, "utf8"))).toEqual(files[0]);
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  });

  it.each(["logout", "reconnect", "legacy-replacement"] as const)(
    "does not revive or overwrite a legacy credential after %s",
    async (change) => {
      const store = await temporaryStore();
      await store.write(credential);
      const { clientId, refreshToken, scopes, createdAt } = credential;
      const legacy = { clientId, refreshToken, scopes, createdAt };
      await writeFile(store.path, JSON.stringify(legacy));
      const previous = (await store.read()).legacyCredential;
      if (!previous) throw new Error("Missing fixture credential");
      if (change === "logout") await store.remove();
      if (change === "reconnect") await store.write(credential);
      if (change === "legacy-replacement")
        await writeFile(store.path, JSON.stringify(legacy));
      const current = await store.read();
      await expect(store.migrateLegacy(previous, credential)).rejects.toThrow(
        "changed during refresh",
      );
      if (change === "reconnect") delete current.legacyCredential;
      expect(await store.read()).toEqual(current);
    },
  );

  it("fences identical reconnects, even if a caller reuses the old generation", async () => {
    const store = await temporaryStore();
    await store.write(credential);
    const previous = (await store.read()).characters[0];
    if (!previous) throw new Error("Missing fixture credential");
    await store.assertCurrent(previous);
    await store.remove();
    await store.write(previous);
    const current = (await store.read()).characters[0];
    expect(current?.generation).not.toBe(previous.generation);
    await expect(store.assertCurrent(previous)).rejects.toThrow(
      "changed during refresh",
    );
    await expect(store.rotate(previous, "fake-stale")).rejects.toThrow(
      "changed during refresh",
    );
    expect((await store.read()).characters[0]).toEqual(current);
  });

  it.each([
    { clientId: "other-test-client" },
    { characterId: 43 },
    { characterName: "Other test name" },
    { scopes: [] },
    { createdAt: "other-test-date" },
    { refreshToken: "fake-other-refresh" },
  ])(
    "rejects metadata changes even with an unchanged generation: %j",
    async (change) => {
      const store = await temporaryStore();
      await store.write(credential);
      const file = await store.read();
      const previous = file.characters[0];
      if (!previous) throw new Error("Missing fixture credential");
      file.characters[0] = { ...previous, ...change };
      await writeFile(store.path, JSON.stringify(file));
      await expect(store.assertCurrent(previous)).rejects.toThrow(
        "changed during refresh",
      );
      await expect(store.rotate(previous, "fake-stale")).rejects.toThrow(
        "changed during refresh",
      );
      expect(await store.read()).toEqual(file);
    },
  );

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
