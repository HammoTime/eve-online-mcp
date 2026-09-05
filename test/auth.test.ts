import { describe, expect, it, vi } from "vitest";
import {
  missingTokenScopes,
  RefreshTokenProvider,
  StaticTokenProvider,
  InteractiveSsoTokenProvider,
  StoredCredentialTokenProvider,
  tokenProviderFromEnvironment,
} from "../src/auth.js";
import { CredentialStore } from "../src/credential-store.js";

function jwt(scopes: string[]): string {
  return `header.${Buffer.from(JSON.stringify({ scp: scopes })).toString("base64url")}.signature`;
}

describe("token providers", () => {
  it("uses a static access token when configured", async () => {
    const provider = tokenProviderFromEnvironment({
      EVE_ACCESS_TOKEN: "access",
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
    const write = vi
      .fn<CredentialStore["write"]>()
      .mockResolvedValue(undefined);
    const store = {
      read: vi.fn<CredentialStore["read"]>().mockResolvedValue({
        clientId: "client",
        refreshToken: "old-refresh",
        scopes: ["one"],
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      write,
    } as unknown as CredentialStore;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "access",
          refresh_token: "new-refresh",
          expires_in: 1200,
        }),
        { status: 200 },
      ),
    );
    const provider = new StoredCredentialTokenProvider(store, fetchMock);
    await expect(provider.getAccessToken()).resolves.toBe("access");
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: "new-refresh" }),
    );
  });

  it("performs one interactive login when no stored credential exists", async () => {
    const read = vi
      .fn<CredentialStore["read"]>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({
        clientId: "shipped-client",
        refreshToken: "refresh",
        scopes: ["scope.one"],
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    const store = { read, write: vi.fn() } as unknown as CredentialStore;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "access", expires_in: 1200 }),
        {
          status: 200,
        },
      ),
    );
    const login = vi.fn().mockResolvedValue(undefined);
    const provider = new InteractiveSsoTokenProvider(
      store,
      "shipped-client",
      ["scope.one"],
      fetchMock,
      login,
    );
    await expect(provider.getAccessToken()).resolves.toBe("access");
    expect(login).toHaveBeenCalledOnce();
    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "shipped-client",
        scopes: ["scope.one"],
      }),
    );
  });
});
