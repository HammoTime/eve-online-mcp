import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  JsonValue,
  OpenApiDocument,
  OperationDescriptor,
  OperationObject,
  ParameterObject,
  ReferenceObject,
  SchemaObject,
} from "./types.js";

const SAFE_POST_OPERATION_IDS = new Set([
  "PostCharactersCharacterIdAssetsLocations",
  "PostCharactersCharacterIdAssetsNames",
  "PostCharactersCharacterIdCspa",
  "PostCharactersAffiliation",
  "PostCorporationsCorporationIdAssetsLocations",
  "PostCorporationsCorporationIdAssetsNames",
  "PostUniverseIds",
  "PostUniverseNames",
]);
const READ_METHODS = ["get", "head", "post"] as const;
const HTTP_METHOD_KEYS = [
  "get",
  "head",
  "post",
  "put",
  "patch",
  "delete",
] as const;

function isReference(value: unknown): value is ReferenceObject {
  return typeof value === "object" && value !== null && "$ref" in value;
}

function pointerSegments(reference: string): string[] {
  if (!reference.startsWith("#/")) {
    throw new Error(
      `Only local OpenAPI references are supported: ${reference}`,
    );
  }

  return reference
    .slice(2)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

export function resolveReference<T>(
  document: OpenApiDocument,
  value: T | ReferenceObject,
): T {
  let current: unknown = value;
  const visited = new Set<string>();

  while (isReference(current)) {
    if (visited.has(current.$ref)) {
      throw new Error(`Circular OpenAPI reference: ${current.$ref}`);
    }
    visited.add(current.$ref);
    let target: unknown = document;
    for (const segment of pointerSegments(current.$ref)) {
      if (
        typeof target !== "object" ||
        target === null ||
        !(segment in target)
      ) {
        throw new Error(`Unresolvable OpenAPI reference: ${current.$ref}`);
      }
      target = (target as Record<string, unknown>)[segment];
    }
    current = target;
  }

  return current as T;
}

function scopesFor(
  document: OpenApiDocument,
  operation: OperationObject,
): string[] {
  const security = operation.security ?? document.security ?? [];
  return [
    ...new Set(
      security.flatMap((requirement) => Object.values(requirement).flat()),
    ),
  ].sort();
}

function operationParameters(
  document: OpenApiDocument,
  pathParameters: (ParameterObject | ReferenceObject)[] | undefined,
  operationParametersValue: (ParameterObject | ReferenceObject)[] | undefined,
): ParameterObject[] {
  const byLocationAndName = new Map<string, ParameterObject>();
  for (const item of [
    ...(pathParameters ?? []),
    ...(operationParametersValue ?? []),
  ]) {
    const parameter = resolveReference<ParameterObject>(document, item);
    byLocationAndName.set(
      `${parameter.in}:${parameter.name.toLowerCase()}`,
      parameter,
    );
  }
  return [...byLocationAndName.values()];
}

function toDescriptor(
  document: OpenApiDocument,
  path: string,
  method: (typeof READ_METHODS)[number],
  operation: OperationObject,
  pathParameters: (ParameterObject | ReferenceObject)[] | undefined,
): OperationDescriptor {
  if (!operation.operationId) {
    throw new Error(
      `Read operation ${method.toUpperCase()} ${path} has no operationId`,
    );
  }

  const cacheSeconds =
    operation["x-client-cache-ttl"] ?? operation["x-cache-age"];
  const descriptor: OperationDescriptor = {
    operationId: operation.operationId,
    method: method.toUpperCase() as "GET" | "HEAD" | "POST",
    path,
    summary: operation.summary ?? operation.operationId,
    description: operation.description ?? "",
    tags: operation.tags ?? [],
    parameters: operationParameters(
      document,
      pathParameters,
      operation.parameters,
    ),
    requiredScopes: scopesFor(document, operation),
  };
  if (typeof cacheSeconds === "number") descriptor.cacheSeconds = cacheSeconds;
  if (operation["x-rate-limit"] !== undefined)
    descriptor.rateLimit = operation["x-rate-limit"];
  if (operation.requestBody) {
    const requestBody = resolveReference<
      NonNullable<Exclude<OperationObject["requestBody"], ReferenceObject>>
    >(document, operation.requestBody);
    const bodySchema = requestBody.content?.["application/json"]?.schema;
    if (bodySchema)
      descriptor.requestBodySchema = resolveReference<SchemaObject>(
        document,
        bodySchema,
      );
    if (requestBody.required !== undefined)
      descriptor.requestBodyRequired = requestBody.required;
  }
  return descriptor;
}

export class OperationCatalog {
  readonly operations: readonly OperationDescriptor[];
  private readonly byId: Map<string, OperationDescriptor>;

  constructor(readonly document: OpenApiDocument) {
    const operations: OperationDescriptor[] = [];
    for (const [path, pathItem] of Object.entries(document.paths)) {
      for (const method of READ_METHODS) {
        const operation = pathItem[method];
        if (
          operation &&
          (method !== "post" ||
            (operation.operationId &&
              SAFE_POST_OPERATION_IDS.has(operation.operationId)))
        ) {
          operations.push(
            toDescriptor(
              document,
              path,
              method,
              operation,
              pathItem.parameters,
            ),
          );
        }
      }
    }
    operations.sort((left, right) =>
      left.operationId.localeCompare(right.operationId),
    );
    this.operations = operations;
    this.byId = new Map(
      operations.map((operation) => [operation.operationId, operation]),
    );
    if (this.byId.size !== operations.length)
      throw new Error("Duplicate read operationId in ESI schema");
  }

  get(operationId: string): OperationDescriptor {
    const operation = this.byId.get(operationId);
    if (!operation) {
      throw new Error(`Unknown or non-read-only ESI operation: ${operationId}`);
    }
    return operation;
  }

  search(options: {
    query?: string;
    tag?: string;
    authenticated?: boolean;
    limit?: number;
  }): OperationDescriptor[] {
    const query = options.query?.trim().toLowerCase();
    const tag = options.tag?.trim().toLowerCase();
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

    return this.operations
      .filter((operation) => {
        if (
          options.authenticated !== undefined &&
          operation.requiredScopes.length > 0 !== options.authenticated
        ) {
          return false;
        }
        if (tag && !operation.tags.some((value) => value.toLowerCase() === tag))
          return false;
        if (!query) return true;
        const haystack = [
          operation.operationId,
          operation.path,
          operation.summary,
          operation.description,
          ...operation.tags,
          ...operation.requiredScopes,
        ]
          .join(" ")
          .toLowerCase();
        return query.split(/\s+/u).every((term) => haystack.includes(term));
      })
      .slice(0, limit);
  }

  get tags(): string[] {
    return [
      ...new Set(this.operations.flatMap((operation) => operation.tags)),
    ].sort();
  }

  get excludedMutatingOperationCount(): number {
    let count = 0;
    for (const pathItem of Object.values(this.document.paths)) {
      for (const method of HTTP_METHOD_KEYS) {
        const operation = pathItem[method];
        const isSafePost =
          method === "post" &&
          operation?.operationId &&
          SAFE_POST_OPERATION_IDS.has(operation.operationId);
        if (operation && method !== "get" && method !== "head" && !isSafePost)
          count += 1;
      }
    }
    return count;
  }

  schemaFor(parameter: ParameterObject): SchemaObject {
    return parameter.schema
      ? resolveReference<SchemaObject>(this.document, parameter.schema)
      : {};
  }
}

export function defaultOpenApiPath(): string {
  return fileURLToPath(new URL("../openapi/esi-openapi.json", import.meta.url));
}

export async function loadOpenApiDocument(
  path = process.env.ESI_OPENAPI_PATH ?? defaultOpenApiPath(),
): Promise<OpenApiDocument> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("paths" in parsed) ||
    !("openapi" in parsed)
  ) {
    throw new Error(`${path} is not an OpenAPI document`);
  }
  return parsed as OpenApiDocument;
}

export function publicOperation(
  operation: OperationDescriptor,
): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {
    operationId: operation.operationId,
    method: operation.method,
    path: operation.path,
    summary: operation.summary,
    tags: operation.tags,
    authenticated: operation.requiredScopes.length > 0,
    requiredScopes: operation.requiredScopes,
  };
  if (operation.description) output.description = operation.description;
  if (operation.cacheSeconds !== undefined)
    output.cacheSeconds = operation.cacheSeconds;
  if (operation.rateLimit !== undefined)
    output.rateLimit = operation.rateLimit as JsonValue;
  if (operation.requestBodySchema)
    output.requestBodySchema =
      operation.requestBodySchema as unknown as JsonValue;
  if (operation.requestBodyRequired !== undefined)
    output.requestBodyRequired = operation.requestBodyRequired;
  return output;
}
