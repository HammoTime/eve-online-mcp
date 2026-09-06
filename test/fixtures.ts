import type { OpenApiDocument } from "../src/types.js";

export function fixtureDocument(): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: { title: "Fixture ESI", version: "2020-01-01" },
    servers: [{ url: "https://esi.evetech.net" }],
    components: {
      parameters: {
        CompatibilityDate: {
          in: "header",
          name: "X-Compatibility-Date",
          required: true,
          schema: { type: "string", enum: ["2020-01-01"] },
        },
        IfNoneMatch: {
          in: "header",
          name: "If-None-Match",
          schema: { type: "string" },
        },
      },
      schemas: {
        CharacterId: { type: "integer", minimum: 1 },
      },
    },
    paths: {
      "/characters/{character_id}": {
        get: {
          operationId: "GetCharactersCharacterId",
          summary: "Get character profile",
          tags: ["Character"],
          parameters: [
            {
              name: "character_id",
              in: "path",
              required: true,
              schema: { $ref: "#/components/schemas/CharacterId" },
            },
            { $ref: "#/components/parameters/CompatibilityDate" },
          ],
        },
      },
      "/characters/{character_id}/location": {
        get: {
          operationId: "GetCharactersCharacterIdLocation",
          summary: "Get character location",
          tags: ["Location"],
          parameters: [
            {
              name: "character_id",
              in: "path",
              required: true,
              schema: { $ref: "#/components/schemas/CharacterId" },
            },
            { $ref: "#/components/parameters/CompatibilityDate" },
          ],
          security: [{ OAuth2: ["esi-location.read_location.v1"] }],
        },
      },
      "/characters/{character_id}/assets": {
        get: {
          operationId: "GetCharacterAssets",
          summary: "Get character assets",
          description: "Lists the assets owned by a character",
          tags: ["Assets"],
          parameters: [
            {
              name: "character_id",
              in: "path",
              required: true,
              schema: { $ref: "#/components/schemas/CharacterId" },
            },
            {
              name: "page",
              in: "query",
              schema: { type: "integer", minimum: 1 },
            },
            {
              name: "types",
              in: "query",
              explode: true,
              schema: { type: "array", items: { type: "integer" } },
            },
            { $ref: "#/components/parameters/CompatibilityDate" },
            { $ref: "#/components/parameters/IfNoneMatch" },
          ],
          security: [{ OAuth2: ["esi-assets.read_assets.v1"] }],
          "x-client-cache-ttl": 60,
          "x-rate-limit": { group: "assets", "max-tokens": 100 },
        },
        post: { operationId: "MoveCharacterAssets", summary: "Move assets" },
      },
      "/status": {
        get: {
          operationId: "GetStatus",
          summary: "Get server status",
          tags: ["Status"],
          parameters: [{ $ref: "#/components/parameters/CompatibilityDate" }],
        },
      },
      "/markets/{region_id}/orders": {
        get: {
          operationId: "GetMarketsRegionIdOrders",
          summary: "List regional orders",
          tags: ["Market"],
          parameters: [
            {
              name: "region_id",
              in: "path",
              required: true,
              schema: { type: "integer", minimum: 1 },
            },
            {
              name: "order_type",
              in: "query",
              required: true,
              schema: {
                type: "string",
                enum: ["buy", "sell", "all"],
                default: "all",
              },
            },
            {
              name: "type_id",
              in: "query",
              schema: { type: "integer", minimum: 1 },
            },
            {
              name: "page",
              in: "query",
              schema: { type: "integer", minimum: 1 },
            },
            { $ref: "#/components/parameters/CompatibilityDate" },
          ],
        },
      },
      "/universe/names": {
        post: {
          operationId: "PostUniverseNames",
          summary: "Bulk IDs to names",
          tags: ["Universe"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  minItems: 1,
                  maxItems: 3,
                  uniqueItems: true,
                  items: { type: "integer" },
                },
              },
            },
          },
        },
      },
      "/universe/ids": {
        post: {
          operationId: "PostUniverseIds",
          summary: "Bulk names to IDs",
          tags: ["Universe"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  minItems: 1,
                  maxItems: 500,
                  uniqueItems: true,
                  items: { type: "string", minLength: 1, maxLength: 100 },
                },
              },
            },
          },
        },
      },
    },
  };
}
