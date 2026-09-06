import { describe, expect, it, vi } from "vitest";
import { resolveEveEntities } from "../src/entity-resolution.js";
import { EsiClient } from "../src/esi-client.js";
import { OperationCatalog } from "../src/openapi.js";
import { fixtureDocument } from "./fixtures.js";

function resolverClient(response: Response) {
  const tokenProvider = {
    getAccessToken: vi.fn(() => Promise.resolve("token")),
  };
  const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(response);
  return {
    client: new EsiClient(
      new OperationCatalog(fixtureDocument()),
      tokenProvider,
      { baseUrl: "http://localhost", fetchImplementation },
    ),
    tokenProvider,
    fetchImplementation,
  };
}

describe("entity resolution", () => {
  it("preserves name inputs while deduplicating the exact public batch", async () => {
    const { client, tokenProvider, fetchImplementation } = resolverClient(
      new Response(
        JSON.stringify({
          inventory_types: [{ id: 34, name: "Tritanium" }],
          unexpected_kind: [{ id: 99, name: "Tritanium" }],
        }),
      ),
    );
    const result = await resolveEveEntities(client, {
      names: ["Tritanium", "tritanium", "Missing"],
    });
    expect(result).toMatchObject({
      matchMode: "exact",
      results: [
        {
          input: "Tritanium",
          status: "ambiguous",
          candidates: [
            { id: 34, category: "inventory_type" },
            { id: 99, category: "unexpected_kind" },
          ],
        },
        { input: "tritanium", status: "ambiguous" },
        { input: "Missing", status: "unresolved", candidates: [] },
      ],
    });
    const [, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(init?.body).toBe('["Tritanium","Missing"]');
    expect(tokenProvider.getAccessToken).not.toHaveBeenCalled();
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("maps IDs in original order and preserves unknown categories", async () => {
    const { client, tokenProvider, fetchImplementation } = resolverClient(
      new Response(
        JSON.stringify([
          { id: 34, name: "Tritanium", category: "inventory_type" },
          { id: 7, name: "Oddity", category: "future_category" },
        ]),
      ),
    );
    const result = await resolveEveEntities(client, { ids: [34, 7, 34, 8] });
    expect(result).toMatchObject({
      results: [
        { input: 34, status: "resolved", candidates: [{ name: "Tritanium" }] },
        {
          input: 7,
          status: "resolved",
          candidates: [{ category: "future_category" }],
        },
        { input: 34, status: "resolved" },
        { input: 8, status: "unresolved", candidates: [] },
      ],
    });
    expect(fetchImplementation.mock.calls[0]?.[1]?.body).toBe("[34,7,8]");
    expect(tokenProvider.getAccessToken).not.toHaveBeenCalled();
  });

  it("propagates a failed batch instead of inventing unresolved answers", async () => {
    const { client } = resolverClient(
      new Response('{"error":"bad batch"}', { status: 400 }),
    );
    await expect(
      resolveEveEntities(client, { ids: [999] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects malformed successful batches", async () => {
    const { client } = resolverClient(new Response('{"characters":"bad"}'));
    await expect(
      resolveEveEntities(client, { names: ["Pilot"] }),
    ).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
  });
});
