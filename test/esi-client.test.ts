import { describe, expect, it, vi } from "vitest";
import { StaticTokenProvider } from "../src/auth.js";
import {
  EsiClient,
  EsiRequestError,
  publicEsiError,
} from "../src/esi-client.js";
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
      code: "AUTHENTICATION_REQUIRED",
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
      code: "MISSING_SCOPES",
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
    ).rejects.toMatchObject({ code: "RESPONSE_LIMIT", retryable: false });
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

  it("preserves original fetch time on cache hits and returns validated next calls", async () => {
    let now = new Date("2026-09-06T00:00:00.000Z");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("[]", {
        status: 200,
        headers: {
          "cache-control": "max-age=60",
          "last-modified": "Sat, 05 Sep 2026 23:59:00 GMT",
          "x-pages": "3",
        },
      }),
    );
    const client = new EsiClient(
      new OperationCatalog(fixtureDocument()),
      new StaticTokenProvider(scopedJwt()),
      {
        baseUrl: "http://localhost",
        fetchImplementation: fetchMock,
        clock: () => now,
      },
    );
    const input = {
      operationId: "GetCharacterAssets",
      path: { character_id: 42 },
      query: { page: 2 },
      headers: { "If-None-Match": '"old"' },
    };
    const first = await client.call(input);
    now = new Date("2026-09-06T00:00:10.000Z");
    const cached = await client.call(input);
    expect(first.freshness).toEqual({
      fetchedAt: "2026-09-06T00:00:00.000Z",
      servedAt: "2026-09-06T00:00:00.000Z",
      expiresAt: "2026-09-06T00:01:00.000Z",
      sourceLastModified: "2026-09-05T23:59:00.000Z",
    });
    expect(cached.freshness.fetchedAt).toBe(first.freshness.fetchedAt);
    expect(cached.freshness.servedAt).toBe("2026-09-06T00:00:10.000Z");
    expect(first.pagination).toMatchObject({
      mode: "page",
      currentPage: 2,
      totalPages: 3,
      hasMore: true,
      nextCall: {
        operationId: "GetCharacterAssets",
        path: { character_id: 42 },
        query: { page: 3 },
        headers: {},
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["no-store", "no-cache"])(
    "does not cache cache-control %s responses",
    async (directive) => {
      let calls = 0;
      const client = new EsiClient(
        new OperationCatalog(fixtureDocument()),
        new StaticTokenProvider(undefined),
        {
          baseUrl: "http://localhost",
          clock: () => new Date("2026-09-06T00:00:00.000Z"),
          fetchImplementation: vi.fn<typeof fetch>().mockImplementation(() => {
            calls += 1;
            return Promise.resolve(
              new Response("{}", {
                status: 200,
                headers: { "cache-control": directive },
              }),
            );
          }),
        },
      );
      const first = await client.call({ operationId: "GetStatus" });
      await client.call({ operationId: "GetStatus" });
      expect(calls).toBe(2);
      expect(first.freshness.expiresAt).toBe(first.freshness.fetchedAt);
    },
  );

  it("reports invalid dates/page counts as unknown", async () => {
    const client = new EsiClient(
      new OperationCatalog(fixtureDocument()),
      new StaticTokenProvider(scopedJwt()),
      {
        baseUrl: "http://localhost",
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
          new Response("[]", {
            headers: {
              expires: "not-a-date",
              "last-modified": "also-not-a-date",
              "x-pages": "3.5",
            },
          }),
        ),
      },
    );
    const response = await client.call({
      operationId: "GetCharacterAssets",
      path: { character_id: 1 },
    });
    expect(response.freshness).toMatchObject({
      expiresAt: null,
      sourceLastModified: null,
    });
    expect(response.pagination).toMatchObject({
      currentPage: 1,
      totalPages: null,
      hasMore: null,
      nextCall: null,
    });
  });

  it("isolates protected caches across token contexts", async () => {
    const token = (marker: string) =>
      `h.${Buffer.from(JSON.stringify({ scp: ["esi-assets.read_assets.v1"], marker })).toString("base64url")}.s`;
    let current = token("one");
    const provider = { getAccessToken: vi.fn(() => Promise.resolve(current)) };
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response("[]", {
          headers: { "cache-control": "max-age=60" },
        }),
      ),
    );
    const client = new EsiClient(
      new OperationCatalog(fixtureDocument()),
      provider,
      { baseUrl: "http://localhost", fetchImplementation: fetchMock },
    );
    const input = {
      operationId: "GetCharacterAssets",
      path: { character_id: 1 },
    };
    await client.call(input);
    current = token("two");
    await client.call(input);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(await client.call(input))).not.toContain(current);
  });

  it("classifies throttling, network, unknown-operation, and response-limit errors", async () => {
    const catalog = new OperationCatalog(fixtureDocument());
    const throttled = new EsiClient(
      catalog,
      new StaticTokenProvider(undefined),
      {
        baseUrl: "http://localhost",
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
          new Response('{"error":"slow down"}', {
            status: 429,
            headers: { "retry-after": "7" },
          }),
        ),
      },
    );
    await expect(
      throttled.call({ operationId: "GetStatus" }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(publicEsiError(error)).toMatchObject({
        code: "THROTTLED",
        retryable: true,
        retryAfterSeconds: 7,
      });
      return true;
    });
    expect(
      publicEsiError(
        (() => {
          try {
            catalog.get("Missing");
          } catch (error) {
            return error;
          }
        })(),
      ),
    ).toMatchObject({ code: "UNKNOWN_OPERATION", retryable: false });

    const network = new EsiClient(catalog, new StaticTokenProvider(undefined), {
      baseUrl: "http://localhost",
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("offline")),
    });
    await expect(
      network.call({ operationId: "GetStatus" }),
    ).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      retryable: true,
    });

    for (const [status, code] of [
      [403, "FORBIDDEN"],
      [404, "NOT_FOUND"],
    ] as const) {
      const client = new EsiClient(
        catalog,
        new StaticTokenProvider(undefined),
        {
          baseUrl: "http://localhost",
          fetchImplementation: vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response("{}", { status })),
        },
      );
      await expect(
        client.call({ operationId: "GetStatus" }),
      ).rejects.toMatchObject({ code, retryable: false });
    }
  });
});
