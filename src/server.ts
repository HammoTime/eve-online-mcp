import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  CHARACTER_SECTIONS,
  getCharacterContext,
  type CharacterSection,
} from "./character-context.js";
import { EsiClient, publicEsiError, type EsiCallInput } from "./esi-client.js";
import { resolveEveEntities } from "./entity-resolution.js";
import { getMarketSnapshot } from "./market-snapshot.js";
import { operationGuidance } from "./operation-metadata.js";
import { searchOperationsDetailed } from "./operation-search.js";
import { OperationCatalog, publicOperation } from "./openapi.js";

const jsonRecord = z.record(z.string(), z.json()).optional();
const positiveSafeInteger = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
    ...(isError ? { isError: true as const } : {}),
  };
}

function errorResult(error: unknown) {
  const body = publicEsiError(error);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
    isError: true as const,
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
        offset: z.number().int().min(0).default(0),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    ({ query, tag, authenticated, limit, offset }) => {
      const result = searchOperationsDetailed(catalog, {
        ...(query === undefined ? {} : { query }),
        ...(tag === undefined ? {} : { tag }),
        ...(authenticated === undefined ? {} : { authenticated }),
        limit,
        offset,
      });
      const operations = result.matches.map(({ operation, matchReasons }) => ({
        ...publicOperation(operation),
        matchReasons,
      }));
      return textResult({
        count: operations.length,
        operations,
        totalMatches: result.totalMatches,
        offset: result.offset,
        hasMore: result.hasMore,
        nextOffset: result.nextOffset,
      });
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
          parameters: operation.parameters.map((parameter) => ({
            name: parameter.name,
            in: parameter.in,
            required: parameter.required ?? false,
            description: parameter.description ?? "",
            schema: catalog.resolvedSchema(parameter.schema ?? {}),
          })),
          ...operationGuidance(catalog, operation),
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
        "Execute one request/page for a catalogued ESI GET/HEAD operation or an explicitly audited semantically read-only POST lookup. Only parameters declared by the pinned OpenAPI schema are accepted. Mutating operations cannot be selected.",
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

  server.registerTool(
    "resolve_eve_entities",
    {
      title: "Resolve EVE entities",
      description:
        "Resolve exact EVE names to all matching IDs/categories, or IDs to names/categories. No fuzzy matching or guessing is performed.",
      inputSchema: z
        .object({
          names: z.array(z.string().min(1).max(100)).min(1).max(500).optional(),
          ids: z.array(positiveSafeInteger).min(1).max(1000).optional(),
        })
        .strict()
        .refine(
          (value) => (value.names === undefined) !== (value.ids === undefined),
          "Supply exactly one of names or ids",
        ),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => {
      try {
        return textResult(
          await resolveEveEntities(
            client,
            input.names ? { names: input.names } : { ids: input.ids ?? [] },
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_character_context",
    {
      title: "Get selected character context",
      description:
        "Retrieve only explicitly selected public or scoped character sections. Each section reports its own data, freshness, and failure; the result is not an atomic snapshot.",
      inputSchema: z
        .object({
          characterId: positiveSafeInteger,
          sections: z
            .array(
              z.enum(
                Object.keys(CHARACTER_SECTIONS) as [
                  CharacterSection,
                  ...CharacterSection[],
                ],
              ),
            )
            .min(1)
            .max(Object.keys(CHARACTER_SECTIONS).length)
            .refine(
              (values) => new Set(values).size === values.length,
              "Character sections must be unique",
            ),
        })
        .strict(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ characterId, sections }) => {
      try {
        const result = await getCharacterContext(client, catalog, {
          characterId,
          sections,
        });
        return textResult(result, result.status === "failed");
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_market_snapshot",
    {
      title: "Get a public regional market snapshot",
      description:
        "Collect consecutive pages from the public regional orders endpoint within strict page and byte limits, optionally filter one exact location, and return observed aggregates rather than raw orders. Observed prices do not imply executable trades or profit.",
      inputSchema: z
        .object({
          regionId: positiveSafeInteger,
          typeId: positiveSafeInteger,
          locationId: positiveSafeInteger.optional(),
          maxPages: z.number().int().min(1).max(10).default(3),
        })
        .strict(),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ regionId, typeId, locationId, maxPages }) => {
      try {
        return textResult(
          await getMarketSnapshot(client, {
            regionId,
            typeId,
            ...(locationId === undefined ? {} : { locationId }),
            maxPages,
          }),
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
              usage: {
                genericFlow: [
                  "Search with search_esi_operations.",
                  "Inspect the chosen operation with get_esi_operation.",
                  "Invoke one operation and one page with call_esi.",
                ],
                workflows: {
                  resolve_eve_entities:
                    "Resolve exact EVE names or IDs without fuzzy guesses.",
                  get_character_context:
                    "Retrieve only explicitly selected character sections; characterId is always required.",
                  get_market_snapshot:
                    "Collect a bounded public regional order snapshot and observed aggregates.",
                },
                access:
                  "Public discovery and public operations never authenticate. Scoped character sections use EVE SSO.",
                freshness:
                  "Freshness records when each upstream response was fetched and served; completeness reports bounded multi-request coverage, not an atomic real-time observation.",
              },
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
              "Use resolve_eve_entities for exact names and IDs. When character data is useful, call get_character_context with this explicit character ID and only the sections needed for the goal; never infer an active character or request every section by default.",
              "Use get_market_snapshot for bounded public regional order evidence. For everything else, use search_esi_operations, inspect unfamiliar operations with get_esi_operation, and call only the minimum useful endpoints. Follow call_esi.pagination.nextCall explicitly when another raw page is genuinely required.",
              "Distinguish facts returned by ESI from strategic inferences. Account for route security, current location, skills, assets, wallet, market conditions, standings, and recent activity only when relevant and authorized.",
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
