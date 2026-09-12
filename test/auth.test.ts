import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  missingTokenScopes,
  RefreshTokenProvider,
  StaticTokenProvider,
  InteractiveSsoTokenProvider,
  StoredCredentialTokenProvider,
  tokenProviderFromEnvironment,
} from "../src/auth.js";
import { CredentialStore } from "../src/credential-store.js";
import {
  testCredential,
  testToken,
  testVerifier,
  trainingScopes,
} from "./auth-fixtures.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function temporaryStore() {
  const path = await mkdtemp(join(tmpdir(), "eve-auth-"));
  directories.push(path);
  return new CredentialStore(join(path, "credentials.json"));
}
function refreshMock() {
  return vi.fn<typeof fetch>((_url, init) => {
    const refresh = (init?.body as URLSearchParams).get("refresh_token") ?? "";
    const id = Number(refresh.replace("fake-refresh-", "").split("-")[0]);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          access_token: testToken(id),
          refresh_token: `${refresh}-rotated`,
          expires_in: 1200,
        }),
      ),
    );
  });
}

function jwt(scopes: string[]): string {
  return `header.${Buffer.from(JSON.stringify({ scp: scopes })).toString("base64url")}.signature`;
}

describe("token providers", () => {
  it("keeps environment overrides and noninteractive mode available", async () => {
    const store = await temporaryStore();
    const environment = { EVE_CREDENTIALS_PATH: store.path };
    const noninteractive = tokenProviderFromEnvironment(environment, fetch, {
      interactive: false,
      scopes: trainingScopes,
    });
    expect(noninteractive).toBeInstanceOf(StoredCredentialTokenProvider);
    await expect(
      noninteractive.getAccessToken(trainingScopes, 42),
    ).resolves.toBeUndefined();
    expect(
      tokenProviderFromEnvironment(environment, fetch, {
        scopes: trainingScopes,
      }),
    ).toBeInstanceOf(InteractiveSsoTokenProvider);
    expect(
      tokenProviderFromEnvironment({
        EVE_CLIENT_ID: "test-client",
        EVE_REFRESH_TOKEN: "fake-refresh",
      }),
    ).toBeInstanceOf(RefreshTokenProvider);
  });
  it("uses a static access token when configured", async () => {
    const provider = tokenProviderFromEnvironment({
      EVE_ACCESS_TOKEN: "access",
      EVE_CLIENT_ID: "test-client",
      EVE_REFRESH_TOKEN: "fake-refresh",
    });
    await expect(provider.getAccessToken()).resolves.toBe("access");
    await expect(
      new StaticTokenProvider(undefined).getAccessToken(),
    ).resolves.toBeUndefined();
  });

  it("refreshes and caches an EVE SSO token with confidential client auth", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: "fresh", expires_in: 1200 }),
          { status: 200 },
        ),
      );
    const provider = new RefreshTokenProvider(
      "client",
      "refresh",
      "secret",
      fetchMock,
    );
    await expect(provider.getAccessToken()).resolves.toBe("fresh");
    await expect(provider.getAccessToken()).resolves.toBe("fresh");
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toMatch(/^Basic /u);
  });

  it("supports public clients and reports refresh errors", async () => {
    const success = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: "fresh", expires_in: 1200 }),
          { status: 200 },
        ),
      );
    await new RefreshTokenProvider(
      "client",
      "refresh",
      undefined,
      success,
    ).getAccessToken();
    const body = success.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect(
      body instanceof URLSearchParams ? body.get("client_id") : undefined,
    ).toBe("client");

    const failure = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("no", { status: 401 }));
    await expect(
      new RefreshTokenProvider(
        "client",
        "refresh",
        undefined,
        failure,
      ).getAccessToken(),
    ).rejects.toThrow("401");
  });

  it("checks JWT scopes without rejecting opaque tokens", () => {
    expect(
      missingTokenScopes(jwt(["scope.one"]), ["scope.one", "scope.two"]),
    ).toEqual(["scope.two"]);
    expect(missingTokenScopes("opaque", ["scope.one"])).toEqual([]);
    expect(missingTokenScopes(jwt([]), [])).toEqual([]);
  });

  it("loads stored SSO credentials and persists refresh-token rotation", async () => {
    const store = await temporaryStore();
    await store.write(testCredential(42));
    await store.write(testCredential(43));
    const fetchMock = refreshMock();
    const provider = new StoredCredentialTokenProvider(
      store,
      fetchMock,
      testVerifier,
    );
    const tokens = await Promise.all(
      [42, 43, 42].map((id) => provider.getAccessToken(trainingScopes, id)),
    );
    expect(tokens).toEqual([testToken(42), testToken(43), testToken(42)]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      (await store.read()).characters.map((entry) => entry.refreshToken).sort(),
    ).toEqual(["fake-refresh-42-rotated", "fake-refresh-43-rotated"]);
    await store.remove(42);
    await expect(
      provider.getAccessToken(trainingScopes, 42),
    ).resolves.toBeUndefined();
    await expect(provider.getAccessToken(trainingScopes, 43)).resolves.toBe(
      testToken(43),
    );
  });

  it("performs one interactive login when no stored credential exists", async () => {
    const store = await temporaryStore();
    const fetchMock = refreshMock();
    const login = vi.fn(async () => store.write(testCredential(42)));
    const provider = new InteractiveSsoTokenProvider(
      store,
      "shipped-client",
      ["scope.one"],
      fetchMock,
      login,
      testVerifier,
    );
    expect(
      await Promise.all([
        provider.getAccessToken([], 42),
        provider.getAccessToken([], 42),
      ]),
    ).toEqual([testToken(42), testToken(42)]);
    expect(login).toHaveBeenCalledOnce();
    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "shipped-client",
        scopes: ["scope.one"],
        expectedCharacterId: 42,
      }),
    );
  });

  it("automatically authorizes a missing second character and resets after declined consent", async () => {
    const store = await temporaryStore();
    await store.write(testCredential(42));
    const login = vi.fn(async (options: { expectedCharacterId?: number }) => {
      await store.write(testCredential(options.expectedCharacterId));
    });
    login.mockRejectedValueOnce(new Error("consent declined"));
    const provider = new InteractiveSsoTokenProvider(
      store,
      "test-client",
      trainingScopes,
      refreshMock(),
      login,
      testVerifier,
    );
    await expect(provider.getAccessToken(trainingScopes, 43)).rejects.toThrow(
      "consent declined",
    );
    await expect(provider.getAccessToken(trainingScopes, 43)).resolves.toBe(
      testToken(43),
    );
    await expect(provider.getAccessToken(trainingScopes, 42)).resolves.toBe(
      testToken(42),
    );
    expect(
      (await store.read()).characters.map((entry) => entry.characterId).sort(),
    ).toEqual([42, 43]);
    expect(login).toHaveBeenCalledTimes(2);
  });

  it("requires an explicit default for ambiguous non-character calls", async () => {
    const store = await temporaryStore();
    await store.write(testCredential(42));
    await store.write(testCredential(43));
    const provider = new StoredCredentialTokenProvider(
      store,
      refreshMock(),
      testVerifier,
    );
    await expect(provider.getAccessToken()).rejects.toMatchObject({
      code: "CHARACTER_SELECTION_REQUIRED",
    });
    await store.select(43);
    await expect(provider.getAccessToken()).resolves.toBe(testToken(43));
    await expect(provider.getAccessToken([], 42)).resolves.toBe(testToken(42));
  });

  it("rejects wrong identities and missing scopes before an ESI call", async () => {
    const store = await temporaryStore();
    await store.write(testCredential(42));
    const refresh = refreshMock();
    const provider = new StoredCredentialTokenProvider(store, refresh, () =>
      Promise.resolve({
        characterId: 99,
        characterName: "Wrong pilot",
        scopes: trainingScopes,
      }),
    );
    await expect(
      provider.getAccessToken(["missing"], 42),
    ).rejects.toMatchObject({
      code: "MISSING_SCOPES",
      details: { characterId: 42, missingScopes: ["missing"] },
    });
    expect(refresh).not.toHaveBeenCalled();
    await expect(provider.getAccessToken([], 42)).rejects.toMatchObject({
      code: "CHARACTER_MISMATCH",
    });
    expect((await store.read()).characters[0]?.refreshToken).toBe(
      "fake-refresh-42",
    );
  });

  it("migrates a legacy credential with verified identity and retains it when another character is requested", async () => {
    const store = await temporaryStore();
    const { clientId, refreshToken, scopes, createdAt } = testCredential(42);
    const legacy = { clientId, refreshToken, scopes, createdAt };
    await writeFile(store.path, JSON.stringify(legacy));
    const provider = new StoredCredentialTokenProvider(
      store,
      refreshMock(),
      testVerifier,
    );
    await expect(
      provider.getAccessToken(trainingScopes, 43),
    ).resolves.toBeUndefined();
    expect(await store.read()).toMatchObject({
      version: 2,
      characters: [
        { characterId: 42, refreshToken: "fake-refresh-42-rotated" },
      ],
    });
    expect((await store.read()).legacyCredential).toBeUndefined();
  });

  it.each(["superseded", "replacement"] as const)(
    "rejects an in-flight legacy migration while preserving the current %s generation",
    async (scenario) => {
      const store = await temporaryStore();
      const { clientId, refreshToken, scopes, createdAt } = testCredential(42);
      await writeFile(
        store.path,
        JSON.stringify({ clientId, refreshToken, scopes, createdAt }),
      );
      const legacy = (await store.read()).legacyCredential;
      if (!legacy) throw new Error("Missing fixture credential");
      const newer = {
        ...testCredential(42, [...trainingScopes, "scope.new"]),
        clientId: "new-test-client",
        characterName: "New test identity",
        refreshToken: "fake-refresh-42-new-login",
        createdAt: "2026-02-01T00:00:00.000Z",
      };
      const newToken = testToken(42, newer.scopes);
      const refresh = vi.fn<typeof fetch>((_url, init) => {
        const isNew =
          (init?.body as URLSearchParams).get("refresh_token") ===
          newer.refreshToken;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: isNew ? newToken : testToken(42),
              expires_in: 1200,
              ...(isNew ? {} : { refresh_token: "fake-refresh-42-rotated" }),
            }),
          ),
        );
      });
      let enter = () => {
        /* Assigned by the promise executor. */
      };
      let resume = () => {
        /* Assigned by the promise executor. */
      };
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const verify = vi
        .fn(testVerifier)
        .mockImplementationOnce(async (token, expectedClient) => {
          const identity = await testVerifier(token, expectedClient);
          enter();
          await gate;
          return identity;
        });
      const provider = new StoredCredentialTokenProvider(
        store,
        refresh,
        verify,
      );
      const pending = provider.getAccessToken(trainingScopes);
      const rejected = expect(pending).rejects.toThrow(
        "changed during refresh",
      );
      try {
        await entered;
        const other = new CredentialStore(store.path);
        await other.write(newer);
        await other.select(42);
        if (scenario === "replacement") {
          const current = await other.read();
          // Replace only the legacy generation, retaining the current login metadata.
          await writeFile(
            store.path,
            JSON.stringify({
              ...current,
              legacyCredential: { ...legacy, generation: randomUUID() },
            }),
          );
        }
        const expected = await other.read();
        if (scenario === "superseded") delete expected.legacyCredential;
        else
          expect(expected.legacyCredential?.generation).not.toBe(
            legacy.generation,
          );
        resume();
        await rejected;
        expect(await other.read()).toEqual(expected);
        expect(refresh).toHaveBeenCalledOnce();
        if (scenario === "superseded") {
          await expect(provider.getAccessToken(newer.scopes)).resolves.toBe(
            newToken,
          );
          expect(verify).toHaveBeenLastCalledWith(newToken, newer.clientId);
          expect(refresh).toHaveBeenCalledTimes(2);
          expect(await other.read()).toEqual(expected);
        }
      } finally {
        resume();
        await pending.catch(() => undefined);
      }
    },
  );

  it("reloads credentials changed by another process without overwriting rotation", async () => {
    const store = await temporaryStore();
    await store.write(testCredential(42));
    const refresh = refreshMock();
    const first = new StoredCredentialTokenProvider(
      store,
      refresh,
      testVerifier,
    );
    const second = new StoredCredentialTokenProvider(
      new CredentialStore(store.path),
      refresh,
      testVerifier,
    );
    await Promise.all([
      first.getAccessToken([], 42),
      second.getAccessToken([], 42),
    ]);
    expect((await store.read()).characters[0]?.refreshToken).toBe(
      "fake-refresh-42-rotated-rotated",
    );
    await new CredentialStore(store.path).write({
      ...testCredential(42),
      refreshToken: "fake-refresh-42-external",
    });
    await first.getAccessToken([], 42);
    expect((await store.read()).characters[0]?.refreshToken).toBe(
      "fake-refresh-42-external-rotated",
    );
  });

  it.each(["rotated", "unchanged", "omitted"] as const)(
    "rejects credential lifecycle changes during verification with %s refresh tokens",
    async (rotation) => {
      for (const change of [
        "logout",
        "logout-all",
        "reconnect",
        "client",
        "scopes",
      ] as const) {
        const store = await temporaryStore();
        await store.write(testCredential(42));
        let enter = () => {
          /* Assigned by the promise executor. */
        };
        let resume = () => {
          /* Assigned by the promise executor. */
        };
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          resume = resolve;
        });
        const refresh = vi.fn<typeof fetch>(() =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                access_token: testToken(42),
                expires_in: 1200,
                ...(rotation === "omitted"
                  ? {}
                  : {
                      refresh_token:
                        rotation === "rotated"
                          ? "fake-refresh-42-rotated"
                          : "fake-refresh-42",
                    }),
              }),
            ),
          ),
        );
        const provider = new StoredCredentialTokenProvider(
          store,
          refresh,
          async (token) => {
            enter();
            await gate;
            return testVerifier(token, "test-client");
          },
        );
        const pending = provider.getAccessToken(trainingScopes, 42);
        const rejected = expect(pending).rejects.toThrow(
          "changed during refresh",
        );
        try {
          await entered;
          const other = new CredentialStore(store.path);
          if (change === "logout" || change === "reconnect")
            await other.remove(42);
          if (change === "logout-all") await other.remove();
          if (change === "reconnect") await other.write(testCredential(42));
          if (change === "client")
            await other.write({
              ...testCredential(42),
              clientId: "other-test-client",
            });
          if (change === "scopes") await other.write(testCredential(42, []));
          const saved = await other.read();
          resume();
          await rejected;
          expect(await store.read()).toEqual(saved);
          if (change === "logout" || change === "logout-all") {
            await expect(
              provider.getAccessToken(trainingScopes, 42),
            ).resolves.toBeUndefined();
          } else if (change === "scopes") {
            await expect(
              provider.getAccessToken(trainingScopes, 42),
            ).rejects.toMatchObject({ code: "MISSING_SCOPES" });
          } else {
            await expect(
              provider.getAccessToken(trainingScopes, 42),
            ).resolves.toBe(testToken(42));
            expect(refresh).toHaveBeenCalledTimes(2);
          }
        } finally {
          resume();
          await pending.catch(() => undefined);
        }
      }
    },
  );

  it("rechecks after rotation persistence before returning or caching the token", async () => {
    const store = await temporaryStore();
    await store.write(testCredential(42));
    const rotate = store.rotate.bind(store);
    vi.spyOn(store, "rotate").mockImplementationOnce(
      async (previous, replacement) => {
        const current = await rotate(previous, replacement);
        await new CredentialStore(store.path).remove(42);
        return current;
      },
    );
    const provider = new StoredCredentialTokenProvider(
      store,
      refreshMock(),
      testVerifier,
    );
    await expect(provider.getAccessToken(trainingScopes, 42)).rejects.toThrow(
      "changed during refresh",
    );
    await expect(
      provider.getAccessToken(trainingScopes, 42),
    ).resolves.toBeUndefined();
  });

  it("invalidates cached access tokens on identical reconnects without relying on timestamps", async () => {
    const store = await temporaryStore();
    await store.write(testCredential(42));
    const refresh = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: testToken(42),
            expires_in: 1200,
          }),
        ),
      ),
    );
    const provider = new StoredCredentialTokenProvider(
      store,
      refresh,
      testVerifier,
    );
    await provider.getAccessToken(trainingScopes, 42);
    await provider.getAccessToken(trainingScopes, 42);
    expect(refresh).toHaveBeenCalledOnce();
    const other = new CredentialStore(store.path);
    await other.remove();
    await other.write(testCredential(42));
    await provider.getAccessToken(trainingScopes, 42);
    expect(refresh).toHaveBeenCalledTimes(2);

    const assertCurrent = store.assertCurrent.bind(store);
    vi.spyOn(store, "assertCurrent").mockImplementationOnce(
      async (previous) => {
        await other.remove();
        await assertCurrent(previous);
      },
    );
    await expect(provider.getAccessToken(trainingScopes, 42)).rejects.toThrow(
      "changed during refresh",
    );
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("rejects refreshed signed identities missing saved scopes without persisting rotation", async () => {
    const store = await temporaryStore();
    await store.write(testCredential(42));
    const saved = await store.read();
    const provider = new StoredCredentialTokenProvider(
      store,
      refreshMock(),
      () =>
        Promise.resolve({
          characterId: 42,
          characterName: "Test Pilot 42",
          scopes: [],
        }),
    );
    await expect(
      provider.getAccessToken(trainingScopes, 42),
    ).rejects.toMatchObject({ code: "MISSING_SCOPES" });
    expect(await store.read()).toEqual(saved);
  });
});
