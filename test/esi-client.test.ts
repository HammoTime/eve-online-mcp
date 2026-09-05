import { describe, expect, it, vi } from "vitest";
import { StaticTokenProvider } from "../src/auth.js";
import { EsiClient, EsiRequestError } from "../src/esi-client.js";
import { OperationCatalog } from "../src/openapi.js";
import { fixtureDocument } from "./fixtures.js";

function scopedJwt(): string {
  return `header.${Buffer.from(JSON.stringify({ scp: ["esi-assets.read_assets.v1"] })).toString("base64url")}.sig`;
}

describe("EsiClient", () => {
  it("constructs allowlisted requests, supplies defaults, authenticates, and caches", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([{ type_id: 34 }]), {
        status: 200,
        headers: {
          "cache-control": "public, max-age=60",
          "content-type": "application/json",
          "x-pages": "3",
        },
      }),
    );
    const client = new EsiClient(
      new OperationCatalog(fixtureDocument()),
      new StaticTokenProvider(scopedJwt()),
      {
        fetchImplementation: fetchMock,
        baseUrl: "http://localhost:3000",
        userAgent: "test/1.0",
      },
    );
    const input = {
      operationId: "GetCharacterAssets",
      path: { character_id: 42 },
      query: { page: 2, types: [34, 35] },
    };
    const first = await client.call(input);
    const second = await client.call(input);

    expect(first).toMatchObject({
      status: 200,
      cached: false,
      data: [{ type_id: 34 }],
      headers: { "x-pages": "3" },
    });
    expect(second.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const requestedUrl =
      url instanceof URL ? url.href : typeof url === "string" ? url : url?.url;
    expect(requestedUrl).toBe(
      "http://localhost:3000/characters/42/assets?page=2&types=34&types=35",
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${scopedJwt()}`);
    expect(headers.get("x-compatibility-date")).toBe("2020-01-01");
    expect(headers.get("user-agent")).toBe("test/1.0");
  });

  it("rejects missing auth, missing scopes, unsafe base URLs, and invalid parameters", async () => {
    const catalog = new OperationCatalog(fixtureDocument());
    const noAuth = new EsiClient(catalog, new StaticTokenProvider(undefined), {
      baseUrl: "http://localhost",
    });
    await expect(
      noAuth.call({
        operationId: "GetCharacterAssets",
        path: { character_id: 1 },
      }),
    ).rejects.toMatchObject({
      status: 401,
    });

    const wrongScope = `h.${Buffer.from(JSON.stringify({ scp: ["other"] })).toString("base64url")}.s`;
    const client = new EsiClient(catalog, new StaticTokenProvider(wrongScope), {
      baseUrl: "http://localhost",
    });
    await expect(
      client.call({
        operationId: "GetCharacterAssets",
        path: { character_id: 1 },
      }),
    ).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      client.call({ operationId: "GetStatus", query: { arbitrary: "value" } }),
    ).rejects.toThrow(/Unknown query/u);
    await expect(
      client.call({
        operationId: "GetStatus",
        headers: { Authorization: "bad" },
      }),
    ).rejects.toThrow(/Unknown header/u);
    await expect(
      client.call({
        operationId: "GetCharacterAssets",
        path: { character_id: 0 },
      }),
    ).rejects.toThrow(/>= 1/u);
    expect(
      () =>
        new EsiClient(catalog, new StaticTokenProvider(undefined), {
          baseUrl: "http://evil.example",
        }),
    ).toThrow(/HTTPS/u);
  });

  it("returns clear HTTP errors and enforces response limits", async () => {
    const catalog = new OperationCatalog(fixtureDocument());
    const errorClient = new EsiClient(
      catalog,
      new StaticTokenProvider(undefined),
      {
        baseUrl: "http://localhost",
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(JSON.stringify({ error: "unavailable" }), {
            status: 503,
            headers: { "retry-after": "2" },
          }),
        ),
      },
    );
    const request = errorClient.call({ operationId: "GetStatus" });
    await expect(request).rejects.toBeInstanceOf(EsiRequestError);
    await expect(request).rejects.toMatchObject({
      status: 503,
      details: { error: "unavailable" },
    });

    const largeClient = new EsiClient(
      catalog,
      new StaticTokenProvider(undefined),
      {
        baseUrl: "http://localhost",
        maxResponseBytes: 3,
        fetchImplementation: vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("1234", { status: 200 })),
      },
    );
    await expect(
      largeClient.call({ operationId: "GetStatus" }),
    ).rejects.toThrow(/safety limit/u);
  });

  it("allows only audited read-only POST lookups and validates their JSON bodies", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([{ id: 34, name: "Tritanium" }]), {
        status: 200,
      }),
    );
    const client = new EsiClient(
      new OperationCatalog(fixtureDocument()),
      new StaticTokenProvider(undefined),
      {
        baseUrl: "http://localhost",
        fetchImplementation: fetchMock,
      },
    );
    await expect(
      client.call({ operationId: "PostUniverseNames" }),
    ).rejects.toThrow(/requires a JSON body/u);
    await expect(
      client.call({ operationId: "PostUniverseNames", body: [34, 34] }),
    ).rejects.toThrow(/unique/u);
    await expect(
      client.call({ operationId: "PostUniverseNames", body: [34, 35, 36, 37] }),
    ).rejects.toThrow(/at most 3/u);
    await client.call({ operationId: "PostUniverseNames", body: [34] });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: "[34]",
    });
  });

  it("falls back to the document version when compatibility-date has no enum", async () => {
    const document = fixtureDocument();
    const compatibilityDate =
      document.components?.parameters?.CompatibilityDate;
    if (!compatibilityDate || "$ref" in compatibilityDate) {
      throw new Error("Fixture compatibility parameter is missing");
    }
    compatibilityDate.schema = { type: "string" };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const client = new EsiClient(
      new OperationCatalog(document),
      new StaticTokenProvider(undefined),
      { baseUrl: "http://localhost", fetchImplementation: fetchMock },
    );
    await client.call({ operationId: "GetStatus" });
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get(
        "x-compatibility-date",
      ),
    ).toBe("2020-01-01");
  });
});
