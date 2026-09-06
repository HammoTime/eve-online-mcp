import { beforeAll, describe, expect, it, vi } from "vitest";
import { EsiClient } from "../src/esi-client.js";
import { getMarketSnapshot } from "../src/market-snapshot.js";
import { loadOpenApiDocument, OperationCatalog } from "../src/openapi.js";

let catalog: OperationCatalog;

beforeAll(async () => {
  catalog = new OperationCatalog(await loadOpenApiDocument());
});

function order(
  orderId: number,
  values: Partial<{
    type_id: number;
    location_id: number;
    volume_remain: number;
    price: number;
    is_buy_order: boolean;
  }> = {},
) {
  return {
    order_id: orderId,
    type_id: 34,
    location_id: 60003760,
    volume_remain: 10,
    price: 5,
    is_buy_order: true,
    ...values,
  };
}

function marketClient(fetchImplementation: typeof fetch) {
  return new EsiClient(
    catalog,
    { getAccessToken: vi.fn() },
    {
      baseUrl: "http://localhost",
      fetchImplementation,
    },
  );
}

describe("market snapshot", () => {
  it("collects complete pages, filters location, and computes observed arithmetic", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            order(1, { price: 5, volume_remain: 10 }),
            order(2, { price: 9, volume_remain: 2, is_buy_order: false }),
            order(3, {
              location_id: 99,
              price: 1,
              volume_remain: 100,
              is_buy_order: false,
            }),
          ]),
          { headers: { "x-pages": "2" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            order(4, { price: 6, volume_remain: 3 }),
            order(5, { price: 8, volume_remain: 4, is_buy_order: false }),
          ]),
          { headers: { "x-pages": "2" } },
        ),
      );
    const result = await getMarketSnapshot(marketClient(fetchImplementation), {
      regionId: 10_000_002,
      typeId: 34,
      locationId: 60_003_760,
      maxPages: 3,
    });
    expect(result).toMatchObject({
      scope: "public regional market orders only",
      pagesFetched: 2,
      observedPageCount: 2,
      complete: true,
      stopReason: "allPagesFetched",
      aggregates: {
        buyOrderCount: 2,
        sellOrderCount: 2,
        buyVolumeRemaining: 13,
        sellVolumeRemaining: 6,
        highestObservedBuy: 6,
        lowestObservedSell: 8,
        observedSpread: 2,
      },
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    for (const [url] of fetchImplementation.mock.calls) {
      const href =
        url instanceof URL ? url.href : typeof url === "string" ? url : url.url;
      expect(href).toContain("/markets/10000002/orders");
      expect(href).not.toContain("structures");
    }
  });

  it("returns honest empty and max-page-limited results", async () => {
    const empty = await getMarketSnapshot(
      marketClient(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response("[]", { headers: { "x-pages": "1" } }),
          ),
      ),
      { regionId: 1, typeId: 34, maxPages: 3 },
    );
    expect(empty).toMatchObject({
      complete: true,
      aggregates: {
        buyOrderCount: 0,
        sellOrderCount: 0,
        highestObservedBuy: null,
        lowestObservedSell: null,
        observedSpread: null,
      },
    });

    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([order(1)]), {
        headers: { "x-pages": "3" },
      }),
    );
    const limited = await getMarketSnapshot(marketClient(fetchImplementation), {
      regionId: 1,
      typeId: 34,
      maxPages: 1,
    });
    expect(limited).toMatchObject({
      pagesFetched: 1,
      complete: false,
      stopReason: "maxPages",
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("stops on missing or changing page counts", async () => {
    const missingFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify([order(1)])));
    const missing = await getMarketSnapshot(marketClient(missingFetch), {
      regionId: 1,
      typeId: 34,
      maxPages: 3,
    });
    expect(missing).toMatchObject({
      pagesFetched: 1,
      observedPageCount: null,
      complete: false,
      stopReason: "unknownPageCount",
    });

    const changingFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([order(1)]), {
          headers: { "x-pages": "3" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([order(2)]), {
          headers: { "x-pages": "4" },
        }),
      );
    const changing = await getMarketSnapshot(marketClient(changingFetch), {
      regionId: 1,
      typeId: 34,
      maxPages: 3,
    });
    expect(changing).toMatchObject({
      pagesFetched: 2,
      observedPageCount: 3,
      complete: false,
      stopReason: "pageCountChanged",
    });
    expect(changingFetch).toHaveBeenCalledTimes(2);
  });

  it("preserves accepted pages after later failures or byte truncation", async () => {
    const failedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([order(1)]), {
          headers: { "x-pages": "2" },
        }),
      )
      .mockResolvedValueOnce(new Response("failure", { status: 503 }));
    const failed = await getMarketSnapshot(marketClient(failedFetch), {
      regionId: 1,
      typeId: 34,
      maxPages: 3,
    });
    expect(failed).toMatchObject({
      pagesFetched: 1,
      complete: false,
      stopReason: "pageError",
      aggregates: { buyOrderCount: 1 },
    });

    const firstRaw = JSON.stringify([order(1)]);
    const byteFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(firstRaw, { headers: { "x-pages": "2" } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([order(2)]), {
          headers: { "x-pages": "2" },
        }),
      );
    const bounded = await getMarketSnapshot(
      marketClient(byteFetch),
      {
        regionId: 1,
        typeId: 34,
        maxPages: 3,
      },
      { maxAggregateBytes: Buffer.byteLength(firstRaw) + 1 },
    );
    expect(bounded).toMatchObject({
      pagesFetched: 1,
      complete: false,
      stopReason: "byteLimit",
      aggregates: { buyOrderCount: 1 },
    });
  });

  it("deduplicates conflicts and rejects malformed first pages", async () => {
    const conflictingFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([order(1, { price: 5 })]), {
          headers: { "x-pages": "2" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([order(1, { price: 6 })]), {
          headers: { "x-pages": "2" },
        }),
      );
    const conflicting = await getMarketSnapshot(
      marketClient(conflictingFetch),
      { regionId: 1, typeId: 34, maxPages: 3 },
    );
    expect(conflicting).toMatchObject({
      complete: false,
      stopReason: "inconsistentData",
      aggregates: { buyOrderCount: 1, highestObservedBuy: 5 },
    });
    expect(conflicting.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/Conflicting duplicate/u)]),
    );

    await expect(
      getMarketSnapshot(
        marketClient(
          vi.fn<typeof fetch>().mockResolvedValue(
            new Response('[{"order_id":1}]', {
              headers: { "x-pages": "1" },
            }),
          ),
        ),
        { regionId: 1, typeId: 34, maxPages: 3 },
      ),
    ).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
  });
});
