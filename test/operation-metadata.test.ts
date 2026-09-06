import { beforeAll, describe, expect, it } from "vitest";
import { operationGuidance } from "../src/operation-metadata.js";
import {
  loadOpenApiDocument,
  OperationCatalog,
  publicOperation,
} from "../src/openapi.js";

let catalog: OperationCatalog;

beforeAll(async () => {
  catalog = new OperationCatalog(await loadOpenApiDocument());
});

describe("operation guidance", () => {
  it("documents required inputs, client defaults, pages, and safe examples", () => {
    const operation = catalog.get("GetMarketsRegionIdOrders");
    const metadata = operationGuidance(catalog, operation);
    expect(metadata).toMatchObject({
      invocation: {
        tool: "call_esi",
        operationId: "GetMarketsRegionIdOrders",
        requiredCallerInputs: {
          path: [{ name: "region_id", in: "path" }],
          query: [],
          headers: [],
          body: null,
        },
        declaredDefaults: { query: { order_type: "all" } },
      },
      pagination: { mode: "page", parameterName: "page" },
      exampleCall: {
        arguments: {
          operationId: "GetMarketsRegionIdOrders",
          path: { region_id: 10_000_002 },
          query: { order_type: "all", page: 1, type_id: 34 },
        },
      },
    });
    expect(JSON.stringify(metadata).toLowerCase()).not.toContain(
      "authorization",
    );
  });

  it("retains request-body contracts and resolves their local schema references", () => {
    const operation = catalog.get("PostUniverseNames");
    expect(publicOperation(operation)).toMatchObject({
      requestBodyRequired: true,
      requestBodySchema: { type: "array", maxItems: 1000 },
    });
    expect(operationGuidance(catalog, operation)).toMatchObject({
      invocation: {
        requiredCallerInputs: {
          body: { type: "array", items: { type: "integer" } },
        },
      },
      pagination: { mode: "none" },
      exampleCall: {
        arguments: { operationId: "PostUniverseNames", body: [34] },
      },
    });
  });
});
