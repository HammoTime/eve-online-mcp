import { beforeAll, describe, expect, it, vi } from "vitest";
import type { TokenProvider } from "../src/auth.js";
import { getCharacterContext } from "../src/character-context.js";
import { EsiClient } from "../src/esi-client.js";
import { loadOpenApiDocument, OperationCatalog } from "../src/openapi.js";

let catalog: OperationCatalog;

beforeAll(async () => {
  catalog = new OperationCatalog(await loadOpenApiDocument());
});

function jwt(scopes: string[]): string {
  return `h.${Buffer.from(JSON.stringify({ scp: scopes })).toString("base64url")}.s`;
}

function clientWith(
  provider: TokenProvider,
  fetchImplementation: typeof fetch,
) {
  return new EsiClient(catalog, provider, {
    baseUrl: "http://localhost",
    fetchImplementation,
  });
}

describe("character context", () => {
  it("fetches only selected public sections without authentication", async () => {
    const provider = {
      getAccessToken: vi.fn<TokenProvider["getAccessToken"]>(),
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"name":"Pilot"}'));
    const result = await getCharacterContext(
      clientWith(provider, fetchImplementation),
      catalog,
      { characterId: 42, sections: ["profile"] },
    );
    expect(result).toMatchObject({
      status: "complete",
      requestedSections: ["profile"],
      sections: { profile: { status: "ok", data: { name: "Pilot" } } },
      atomic: false,
    });
    expect(Object.keys(result.sections as object)).toEqual(["profile"]);
    expect(provider.getAccessToken).not.toHaveBeenCalled();
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("preflights the union of protected scopes exactly once", async () => {
    const scopes = [
      "esi-location.read_location.v1",
      "esi-location.read_ship_type.v1",
      "esi-wallet.read_character_wallet.v1",
    ];
    const provider = {
      getAccessToken: vi.fn(() => Promise.resolve(jwt(scopes))),
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(new Response("{}")));
    const result = await getCharacterContext(
      clientWith(provider, fetchImplementation),
      catalog,
      { characterId: 42, sections: ["location", "ship", "wallet"] },
    );
    expect(result.status).toBe("complete");
    expect(provider.getAccessToken).toHaveBeenCalledOnce();
    expect(provider.getAccessToken).toHaveBeenCalledWith([...scopes].sort());
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it("does not repeat failed consent and still retrieves public profile data", async () => {
    const provider = {
      getAccessToken: vi.fn(() =>
        Promise.reject(new Error("consent declined")),
      ),
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"name":"Pilot"}'));
    const result = await getCharacterContext(
      clientWith(provider, fetchImplementation),
      catalog,
      { characterId: 42, sections: ["location", "ship", "profile"] },
    );
    expect(result).toMatchObject({
      status: "partial",
      sections: {
        location: { status: "error" },
        ship: { status: "error" },
        profile: { status: "ok" },
      },
    });
    expect(Object.keys(result.sections as object)).toEqual([
      "location",
      "ship",
      "profile",
    ]);
    expect(provider.getAccessToken).toHaveBeenCalledOnce();
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("marks missing scopes as all failed without spending upstream calls", async () => {
    const provider = {
      getAccessToken: vi.fn(() => Promise.resolve(jwt(["other.scope"]))),
    };
    const fetchImplementation = vi.fn<typeof fetch>();
    const result = await getCharacterContext(
      clientWith(provider, fetchImplementation),
      catalog,
      { characterId: 42, sections: ["skills", "skillQueue"] },
    );
    expect(result).toMatchObject({
      status: "failed",
      sections: {
        skills: { error: { code: "MISSING_SCOPES" } },
        skillQueue: { error: { code: "MISSING_SCOPES" } },
      },
    });
    expect(result.caveats).toEqual(
      expect.arrayContaining([expect.stringMatching(/next logs in/u)]),
    );
    expect(provider.getAccessToken).toHaveBeenCalledOnce();
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("retains earlier sections when a later section or aggregate bound fails", async () => {
    const provider = {
      getAccessToken: vi.fn(() =>
        Promise.resolve(jwt(["esi-location.read_location.v1"])),
      ),
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"name":"Pilot"}'))
      .mockResolvedValueOnce(
        new Response('{"error":"unavailable"}', { status: 503 }),
      );
    const partial = await getCharacterContext(
      clientWith(provider, fetchImplementation),
      catalog,
      { characterId: 42, sections: ["profile", "location"] },
    );
    expect(partial).toMatchObject({
      status: "partial",
      sections: {
        profile: { status: "ok" },
        location: { status: "error", error: { code: "UPSTREAM_ERROR" } },
      },
    });

    const bounded = await getCharacterContext(
      clientWith(
        {
          getAccessToken: vi.fn<TokenProvider["getAccessToken"]>(),
        },
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response(JSON.stringify({ blob: "x".repeat(500) })),
          ),
      ),
      catalog,
      { characterId: 42, sections: ["profile"] },
      { maxResultBytes: 100 },
    );
    expect(bounded).toMatchObject({
      status: "failed",
      sections: { profile: { error: { code: "RESPONSE_LIMIT" } } },
    });
  });
});
