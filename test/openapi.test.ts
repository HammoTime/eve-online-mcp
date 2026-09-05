import { describe, expect, it } from "vitest";
import { OperationCatalog, resolveReference } from "../src/openapi.js";
import { fixtureDocument } from "./fixtures.js";

describe("OperationCatalog", () => {
  it("indexes only read-only operations and reports excluded mutations", () => {
    const catalog = new OperationCatalog(fixtureDocument());
    expect(
      catalog.operations.map((operation) => operation.operationId),
    ).toEqual(["GetCharacterAssets", "GetStatus", "PostUniverseNames"]);
    expect(catalog.excludedMutatingOperationCount).toBe(1);
    expect(() => catalog.get("MoveCharacterAssets")).toThrow(/non-read-only/u);
  });

  it("searches descriptions, tags, auth state, and clamps limits", () => {
    const catalog = new OperationCatalog(fixtureDocument());
    expect(
      catalog
        .search({ query: "owned character", authenticated: true })
        .map((value) => value.operationId),
    ).toEqual(["GetCharacterAssets"]);
    expect(
      catalog.search({ tag: "status", authenticated: false, limit: 500 }),
    ).toHaveLength(1);
    expect(catalog.tags).toEqual(["Assets", "Status", "Universe"]);
  });

  it("resolves JSON pointers and detects invalid references", () => {
    const document = fixtureDocument();
    expect(
      resolveReference(document, { $ref: "#/components/schemas/CharacterId" }),
    ).toMatchObject({ type: "integer" });
    expect(() =>
      resolveReference(document, { $ref: "https://example.test/schema" }),
    ).toThrow(/local/u);
    expect(() =>
      resolveReference(document, { $ref: "#/components/schemas/Missing" }),
    ).toThrow(/Unresolvable/u);
  });
});
