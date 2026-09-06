import { beforeAll, describe, expect, it } from "vitest";
import { searchOperationsDetailed } from "../src/operation-search.js";
import { loadOpenApiDocument, OperationCatalog } from "../src/openapi.js";

let catalog: OperationCatalog;

beforeAll(async () => {
  catalog = new OperationCatalog(await loadOpenApiDocument());
});

describe("detailed operation search", () => {
  it.each([
    ["where am I", "GetCharactersCharacterIdLocation"],
    ["current ship", "GetCharactersCharacterIdShip"],
    ["what am I flying", "GetCharactersCharacterIdShip"],
    ["training queue", "GetCharactersCharacterIdSkillqueue"],
    ["trained skills", "GetCharactersCharacterIdSkills"],
    ["wallet balance", "GetCharactersCharacterIdWallet"],
    ["how much ISK", "GetCharactersCharacterIdWallet"],
    ["what do I own", "GetCharactersCharacterIdAssets"],
    ["my assets", "GetCharactersCharacterIdAssets"],
  ])("maps %s to %s", (query, operationId) => {
    const result = searchOperationsDetailed(catalog, { query, limit: 10 });
    expect(result.matches[0]?.operation.operationId).toBe(operationId);
    expect(result.matches[0]?.matchReasons[0]).toMatch(/recognized phrase/u);
  });

  it("prioritizes exact IDs and paths while applying hard filters", () => {
    const exactId = searchOperationsDetailed(catalog, {
      query: "GetCharactersCharacterIdLocation",
    });
    expect(exactId.matches[0]?.operation.operationId).toBe(
      "GetCharactersCharacterIdLocation",
    );
    expect(exactId.matches[0]?.matchReasons).toContain("exact operation ID");

    const exactPath = searchOperationsDetailed(catalog, {
      query: "/markets/{region_id}/orders",
    });
    expect(exactPath.matches[0]?.operation.operationId).toBe(
      "GetMarketsRegionIdOrders",
    );
    expect(exactPath.matches[0]?.matchReasons).toContain("exact path");

    expect(
      searchOperationsDetailed(catalog, {
        query: "where am I",
        authenticated: false,
      }).totalMatches,
    ).toBe(0);
    expect(
      searchOperationsDetailed(catalog, {
        query: "GetMarketsRegionIdOrders",
        tag: "Character",
      }).totalMatches,
    ).toBe(0);
  });

  it("paginates deterministic alphabetical blank results and rejects noise", () => {
    const all = searchOperationsDetailed(catalog, {
      authenticated: false,
      limit: 2,
      offset: 1,
    });
    expect(all.matches).toHaveLength(2);
    expect(all.offset).toBe(1);
    expect(all.totalMatches).toBeGreaterThan(3);
    expect(all.hasMore).toBe(true);
    expect(all.nextOffset).toBe(3);
    expect(all.matches.map((match) => match.operation.operationId)).toEqual(
      [...all.matches]
        .map((match) => match.operation.operationId)
        .sort((left, right) => left.localeCompare(right)),
    );
    expect(
      searchOperationsDetailed(catalog, { query: "frobnicate quux" }),
    ).toMatchObject({ totalMatches: 0, hasMore: false, nextOffset: null });
    expect(
      searchOperationsDetailed(catalog, { query: "what is the" }),
    ).toMatchObject({ totalMatches: 0 });
  });
});
