import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAuthCommand } from "../src/cli.js";
import { CredentialStore } from "../src/credential-store.js";
import { OperationCatalog } from "../src/openapi.js";
import { fixtureDocument } from "./fixtures.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

async function environment(): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(join(tmpdir(), "eve-cli-test-"));
  temporaryDirectories.push(directory);
  return { EVE_CREDENTIALS_PATH: join(directory, "credential.json") };
}

describe("auth CLI", () => {
  it("ignores non-auth commands and rejects unknown auth commands", async () => {
    const catalog = new OperationCatalog(fixtureDocument());
    await expect(
      runAuthCommand([], catalog, await environment()),
    ).resolves.toBe(false);
    await expect(
      runAuthCommand(["auth", "unknown"], catalog, await environment()),
    ).rejects.toThrow(/Usage/u);
  });

  it("reports status and removes local credentials", async () => {
    const catalog = new OperationCatalog(fixtureDocument());
    const env = await environment();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(
      runAuthCommand(["auth", "status"], catalog, env),
    ).resolves.toBe(true);
    expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining("not configured"),
    );

    const store = new CredentialStore(env.EVE_CREDENTIALS_PATH);
    await store.write({
      clientId: "client",
      refreshToken: "refresh",
      scopes: ["one", "two"],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await runAuthCommand(["auth", "status"], catalog, env);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("2 scopes"));
    await runAuthCommand(["auth", "logout"], catalog, env);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("Removed"));
    await runAuthCommand(["auth", "logout"], catalog, env);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("No locally"));
  });
});
