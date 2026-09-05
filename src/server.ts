import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { EsiClient, EsiRequestError, type EsiCallInput } from "./esi-client.js";
import { OperationCatalog, publicOperation } from "./openapi.js";
import type { JsonValue, ParameterObject } from "./types.js";

const jsonRecord = z.record(z.string(), z.json()).optional();

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function errorResult(error: unknown) {
  const body =
    error instanceof EsiRequestError
      ? {
          error: error.message,
          status: error.status ?? null,
          details: error.details ?? null,
        }
      : { error: error instanceof Error ? error.message : String(error) };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
    isError: true as const,
  };
}

function publicParameter(
  catalog: OperationCatalog,
  parameter: ParameterObject,
): Record<string, JsonValue> {
  return {
    name: parameter.name,
    in: parameter.in,
    required: parameter.required ?? false,
    description: parameter.description ?? "",
    schema: catalog.schemaFor(parameter) as unknown as JsonValue,
  };
}

export function createEveServer(
  catalog: OperationCatalog,
  client: EsiClient,
): McpServer {
  const server = new McpServer({ name: "eve-online-mcp", version: "0.1.0" });

  server.registerTool(
    "search_esi_operations",
    {
      title: "Search ESI operations",
      description:
        "Find read-only EVE Online ESI operations by natural-language keywords, exact tag, or authentication requirement. Start here when choosing which game data to retrieve.",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe(
            "Keywords matched across operation IDs, paths, summaries, descriptions, tags, and scopes",
          ),
        tag: z
          .string()
          .optional()
          .describe(
            "Exact ESI tag, such as Character, Skills, Market, Routes, or Universe",
          ),
        authenticated: z
          .boolean()
          .optional()
          .describe(
            "true for character/corporation data; false for public data",
          ),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    ({ query, tag, authenticated, limit }) => {
      const operations = catalog
        .search({
          ...(query === undefined ? {} : { query }),
          ...(tag === undefined ? {} : { tag }),
          ...(authenticated === undefined ? {} : { authenticated }),
          limit,
        })
        .map(publicOperation);
      return textResult({ count: operations.length, operations });
    },
  );

  server.registerTool(
    "get_esi_operation",
    {
      title: "Inspect an ESI operation",
      description:
        "Return the exact path/query/header parameters, OAuth scopes, cache hints, and rate-limit metadata for one read-only ESI operation before calling it.",
      inputSchema: z.object({ operationId: z.string().min(1) }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    ({ operationId }) => {
      try {
        const operation = catalog.get(operationId);
        return textResult({
          ...publicOperation(operation),
          parameters: operation.parameters.map((parameter) =>
            publicParameter(catalog, parameter),
          ),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "call_esi",
    {
      title: "Call a read-only ESI operation",
      description:
        "Execute an ESI GET/HEAD operation selected by operationId. Only parameters declared by the pinned OpenAPI schema are accepted. Mutating ESI operations cannot be selected.",
      inputSchema: z.object({
        operationId: z.string().min(1),
        path: jsonRecord.describe(
          "Path parameter values keyed by their schema names",
        ),
        query: jsonRecord.describe(
          "Query parameter values keyed by their schema names",
        ),
        headers: jsonRecord.describe(
          "Optional declared ESI headers (for example Accept-Language or If-None-Match); Authorization cannot be supplied here",
        ),
        body: z
          .json()
          .optional()
          .describe(
            "JSON body for explicitly audited, semantically read-only bulk lookup POST operations",
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ operationId, path, query, headers, body }) => {
      try {
        return textResult(
          await client.call({
            operationId,
            ...(path ? { path } : {}),
            ...(query ? { query } : {}),
            ...(headers ? { headers } : {}),
            ...(body === undefined ? {} : { body }),
          } satisfies EsiCallInput),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerResource(
    "esi-catalog",
    "eve-esi://catalog",
    {
      title: "EVE ESI read-only API catalog",
      description:
        "Summary of the pinned ESI schema and the operations this server exposes",
      mimeType: "application/json",
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              openapi: catalog.document.openapi,
              compatibilityDate: catalog.document.info.version,
              readOnlyOperations: catalog.operations.length,
              excludedMutatingOperations:
                catalog.excludedMutatingOperationCount,
              tags: catalog.tags,
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerPrompt(
    "plan_eve_adventure",
    {
      title: "Plan an EVE adventure",
      description:
        "Guide the model to use live ESI data when helping decide what to do next in EVE Online",
      argsSchema: z.object({
        goal: z
          .string()
          .describe(
            "What kind of experience, progress, or decision the capsuleer wants",
          ),
        characterId: z
          .string()
          .optional()
          .describe(
            "EVE character ID, when authenticated character context should be used",
          ),
        constraints: z
          .string()
          .optional()
          .describe(
            "Time, budget, risk tolerance, location, ship, group size, or other limits",
          ),
      }),
    },
    ({ goal, characterId, constraints }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Help me plan my next EVE Online adventure. My goal is: ${goal}.`,
              characterId
                ? `My character ID is ${characterId}.`
                : "Ask for my character ID only if authenticated character data is necessary.",
              constraints ? `Constraints: ${constraints}.` : "",
              "Use search_esi_operations to identify relevant live data, inspect unfamiliar operations before calling them, and call only the minimum useful endpoints.",
              "Distinguish facts returned by ESI from strategic inferences. Account for route security, current location, skills, assets, wallet, market conditions, standings, and recent activity when relevant.",
              "Offer two or three concrete options with prerequisites, likely cost/risk, travel or preparation steps, and a recommended first action. Never claim that ESI data is real-time when cache metadata says otherwise.",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        },
      ],
    }),
  );

  return server;
}
