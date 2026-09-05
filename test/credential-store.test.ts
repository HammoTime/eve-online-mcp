import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialStore,
  defaultCredentialPath,
  type StoredCredential,
} from "../src/credential-store.js";

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

const credential: StoredCredential = {
  clientId: "client",
  refreshToken: "refresh",
  scopes: ["scope.one"],
  createdAt: "2026-01-01T00:00:00.000Z",
};

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
    await expect(store.read()).resolves.toBeUndefined();
    await store.write(credential);
    await expect(store.read()).resolves.toEqual(credential);
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
});
