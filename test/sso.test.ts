import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../src/credential-store.js";
import {
  createAuthorizationUrl,
  createPkce,
  loginWithEveSso,
} from "../src/sso.js";

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not reserve test port");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return address.port;
}

describe("EVE SSO", () => {
  it("creates RFC-compliant PKCE values and authorization URLs", () => {
    const pkce = createPkce();
    expect(pkce.verifier).toMatch(/^[\w-]{43}$/u);
    expect(pkce.challenge).toMatch(/^[\w-]{43}$/u);
    const url = createAuthorizationUrl(
      "https://login.eveonline.com/authorize",
      {
        clientId: "client",
        redirectUri: "http://localhost:52765/callback",
        scopes: ["one", "two"],
        state: "state",
        challenge: pkce.challenge,
      },
    );
    expect(url.searchParams.get("scope")).toBe("one two");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(() =>
      createAuthorizationUrl("http://example.test/authorize", {
        clientId: "client",
        redirectUri: "http://localhost:52765/callback",
        scopes: ["one"],
        state: "state",
        challenge: pkce.challenge,
      }),
    ).toThrow(/HTTPS/u);
  });

  it("completes a localhost PKCE login and stores only the refresh credential", async () => {
    const port = await unusedPort();
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const write = vi
      .fn<CredentialStore["write"]>()
      .mockResolvedValue(undefined);
    const store = {
      path: "/test/credentials.json",
      write,
    } as unknown as CredentialStore;
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url =
        input instanceof URL
          ? input.href
          : typeof input === "string"
            ? input
            : input.url;
      if (url.includes(".well-known")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              authorization_endpoint:
                "https://login.eveonline.com/v2/oauth/authorize",
              token_endpoint: "https://login.eveonline.com/v2/oauth/token",
            }),
            { status: 200 },
          ),
        );
      }
      expect(init?.method).toBe("POST");
      const body = init?.body;
      expect(body).toBeInstanceOf(URLSearchParams);
      expect(
        body instanceof URLSearchParams ? body.get("code_verifier") : null,
      ).toBeTruthy();
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "short-lived-access-token",
            refresh_token: "stored-refresh-token",
            expires_in: 1200,
          }),
          { status: 200 },
        ),
      );
    });

    const result = await loginWithEveSso({
      clientId: "client",
      scopes: ["scope.two", "scope.one", "scope.one"],
      redirectUri,
      store,
      fetchImplementation: fetchMock,
      verifyToken: () =>
        Promise.resolve({
          characterId: 42,
          characterName: "Test Pilot",
          scopes: ["scope.one", "scope.two"],
        }),
      openBrowser: async (authorizationUrl) => {
        const url = new URL(authorizationUrl);
        const callback = new URL(redirectUri);
        callback.searchParams.set("code", "authorization-code");
        callback.searchParams.set("state", url.searchParams.get("state") ?? "");
        await fetch(callback);
      },
    });

    expect(result).toEqual({
      credentialPath: "/test/credentials.json",
      characterId: 42,
      characterName: "Test Pilot",
      scopes: ["scope.one", "scope.two"],
    });
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "client",
        refreshToken: "stored-refresh-token",
        scopes: ["scope.one", "scope.two"],
      }),
    );
    expect(JSON.stringify(write.mock.calls)).not.toContain(
      "short-lived-access-token",
    );
  });

  it.each(["wrong character", "missing scopes", "invalid signature"])(
    "does not save credentials after %s",
    async (failure) => {
      const redirectUri = `http://127.0.0.1:${await unusedPort()}/callback`;
      const write = vi.fn<CredentialStore["write"]>();
      const store = {
        path: "/test/credentials.json",
        write,
      } as unknown as CredentialStore;
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              authorization_endpoint:
                "https://login.eveonline.com/v2/oauth/authorize",
              token_endpoint: "https://login.eveonline.com/v2/oauth/token",
            }),
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: "fake-access",
              refresh_token: "fake-refresh",
              expires_in: 1200,
            }),
          ),
        );
      await expect(
        loginWithEveSso({
          clientId: "test-client",
          scopes: ["scope.one"],
          expectedCharacterId: 42,
          redirectUri,
          store,
          fetchImplementation: fetchMock,
          verifyToken: () =>
            failure === "invalid signature"
              ? Promise.reject(new Error("invalid signature"))
              : Promise.resolve({
                  characterId: failure === "wrong character" ? 43 : 42,
                  characterName: "Test Pilot",
                  scopes: failure === "missing scopes" ? [] : ["scope.one"],
                }),
          openBrowser: async (url) => {
            const callback = new URL(redirectUri);
            callback.searchParams.set(
              "state",
              new URL(url).searchParams.get("state") ?? "",
            );
            callback.searchParams.set("code", "fake-code");
            await fetch(callback);
          },
        }),
      ).rejects.toThrow(
        failure === "wrong character"
          ? "character 42 was requested"
          : failure === "missing scopes"
            ? "did not grant"
            : "invalid signature",
      );
      expect(write).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid login configuration", async () => {
    await expect(
      loginWithEveSso({ clientId: "", scopes: ["one"] }),
    ).rejects.toThrow(/client ID/u);
    await expect(
      loginWithEveSso({ clientId: "client", scopes: [] }),
    ).rejects.toThrow(/scope/u);
    await expect(
      loginWithEveSso({
        clientId: "client",
        scopes: ["one"],
        redirectUri: "https://example.test/callback",
      }),
    ).rejects.toThrow(/localhost/u);

    const unavailable = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("unavailable", { status: 503 }));
    await expect(
      loginWithEveSso({
        clientId: "client",
        scopes: ["one"],
        fetchImplementation: unavailable,
      }),
    ).rejects.toThrow(/discover.*503/iu);

    const missingEndpoints = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(
      loginWithEveSso({
        clientId: "client",
        scopes: ["one"],
        fetchImplementation: missingEndpoints,
      }),
    ).rejects.toThrow(/missing required endpoints/u);

    const insecureEndpoints = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          authorization_endpoint: "http://example.test/authorize",
          token_endpoint: "https://login.eveonline.com/token",
        }),
        { status: 200 },
      ),
    );
    await expect(
      loginWithEveSso({
        clientId: "client",
        scopes: ["one"],
        fetchImplementation: insecureEndpoints,
      }),
    ).rejects.toThrow(/must use HTTPS/u);
  });
});
