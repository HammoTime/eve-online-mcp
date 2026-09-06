import type { EsiCallInput } from "./esi-client.js";
import type { OperationCatalog } from "./openapi.js";
import type {
  JsonValue,
  OperationDescriptor,
  ParameterObject,
} from "./types.js";

const CLIENT_SUPPLIED_HEADERS = new Set(["x-compatibility-date"]);

const EXAMPLES: Record<string, Omit<EsiCallInput, "operationId">> = {
  PostUniverseIds: { body: ["Tritanium"] },
  PostUniverseNames: { body: [34] },
  GetCharactersCharacterId: { path: { character_id: 2_112_625_428 } },
  GetCharactersCharacterIdLocation: {
    path: { character_id: 2_112_625_428 },
  },
  GetCharactersCharacterIdShip: {
    path: { character_id: 2_112_625_428 },
  },
  GetCharactersCharacterIdSkills: {
    path: { character_id: 2_112_625_428 },
  },
  GetCharactersCharacterIdSkillqueue: {
    path: { character_id: 2_112_625_428 },
  },
  GetCharactersCharacterIdWallet: {
    path: { character_id: 2_112_625_428 },
  },
  GetMarketsRegionIdOrders: {
    path: { region_id: 10_000_002 },
    query: { order_type: "all", page: 1, type_id: 34 },
  },
};

function publicParameter(
  catalog: OperationCatalog,
  parameter: ParameterObject,
): Record<string, JsonValue> {
  return {
    name: parameter.name,
    in: parameter.in,
    required: parameter.required ?? false,
    description: parameter.description ?? "",
    schema: catalog.resolvedSchema(
      parameter.schema ?? {},
    ) as unknown as JsonValue,
  };
}

export function operationPagination(
  catalog: OperationCatalog,
  operation: OperationDescriptor,
): {
  mode: "page" | "none";
  parameterName: string | null;
  instructions: string | null;
} {
  const page = operation.parameters.find((parameter) => {
    const type = catalog.resolvedSchema(parameter.schema ?? {}).type;
    return (
      parameter.in === "query" &&
      parameter.name === "page" &&
      (type === "integer" || (Array.isArray(type) && type.includes("integer")))
    );
  });
  return page
    ? {
        mode: "page",
        parameterName: page.name,
        instructions:
          "call_esi returns one page. Follow pagination.nextCall while hasMore is true.",
      }
    : { mode: "none", parameterName: null, instructions: null };
}

function notesFor(
  operation: OperationDescriptor,
  compatibilityDate: string,
): string[] {
  const notes = [
    `Contract comes from pinned ESI compatibility date ${compatibilityDate}; examples are illustrative, not guaranteed entities.`,
  ];
  if (operation.operationId === "PostUniverseNames")
    notes.push("One invalid ID can cause ESI to reject the entire batch.");
  if (
    [
      "GetCharactersCharacterIdSkills",
      "GetCharactersCharacterIdSkillqueue",
    ].includes(operation.operationId)
  )
    notes.push(
      "Completed skill-queue entries can precede updates to the skills endpoint until the character next logs in.",
    );
  if (operation.operationId === "GetMarketsRegionIdOrders")
    notes.push(
      "This is the public regional market endpoint; it does not grant access to private structure markets.",
    );
  return notes;
}

export function operationGuidance(
  catalog: OperationCatalog,
  operation: OperationDescriptor,
): Record<string, JsonValue> {
  const grouped = {
    path: [] as Record<string, JsonValue>[],
    query: [] as Record<string, JsonValue>[],
    headers: [] as Record<string, JsonValue>[],
  };
  const defaults: {
    query: Record<string, JsonValue>;
    headers: Record<string, JsonValue>;
  } = {
    query: {},
    headers: {},
  };
  for (const parameter of operation.parameters) {
    const schema = catalog.resolvedSchema(parameter.schema ?? {});
    if (parameter.in === "cookie") continue;
    const location = parameter.in === "header" ? "headers" : parameter.in;
    const serverSupplied =
      parameter.in === "header" &&
      CLIENT_SUPPLIED_HEADERS.has(parameter.name.toLowerCase());
    if (parameter.required && !serverSupplied && schema.default === undefined)
      grouped[location].push(publicParameter(catalog, parameter));
    if (
      schema.default !== undefined &&
      (location === "query" || location === "headers")
    )
      defaults[location][parameter.name] = schema.default;
  }
  const example = EXAMPLES[operation.operationId];
  return {
    invocation: {
      tool: "call_esi",
      operationId: operation.operationId,
      requiredCallerInputs: {
        ...grouped,
        body: operation.requestBodyRequired
          ? catalog.resolvedSchema(operation.requestBodySchema ?? {})
          : null,
      },
      declaredDefaults: defaults,
      suppliedByClient: ["X-Compatibility-Date", "Accept", "User-Agent"],
    },
    pagination: operationPagination(catalog, operation),
    notes: notesFor(operation, catalog.document.info.version ?? "unknown"),
    ...(example
      ? {
          exampleCall: {
            label:
              "Illustrative only; IDs and names are examples, not guaranteed existing entities.",
            arguments: { operationId: operation.operationId, ...example },
          },
        }
      : {}),
  } as Record<string, JsonValue>;
}
