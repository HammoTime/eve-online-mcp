import { missingTokenScopes, type TokenProvider } from "./auth.js";
import { OperationCatalog } from "./openapi.js";
import { DEFAULT_ESI_USER_AGENT } from "./package-metadata.js";
import type {
  JsonValue,
  OperationDescriptor,
  ParameterObject,
  SchemaObject,
} from "./types.js";

export interface EsiCallInput {
  operationId: string;
  path?: Record<string, JsonValue>;
  query?: Record<string, JsonValue>;
  headers?: Record<string, JsonValue>;
  body?: JsonValue;
}

export interface EsiResponse {
  operationId: string;
  status: number;
  url: string;
  cached: boolean;
  headers: Record<string, string>;
  data: JsonValue | string | null;
}

export class EsiRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: JsonValue | string,
  ) {
    super(message);
    this.name = "EsiRequestError";
  }
}

interface CacheEntry {
  expiresAt: number;
  response: EsiResponse;
}

const RESPONSE_HEADERS = [
  "cache-control",
  "content-type",
  "etag",
  "expires",
  "last-modified",
  "retry-after",
  "x-esi-error-limit-remain",
  "x-esi-error-limit-reset",
  "x-pages",
  "x-ratelimit-group",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-used",
];

function valueTypeMatches(value: JsonValue, schema: SchemaObject): boolean {
  const types = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];
  if (types.length === 0) return true;
  return types.some((type) => {
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "object")
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    if (type === "integer")
      return typeof value === "number" && Number.isInteger(value);
    return typeof value === type;
  });
}

function validateValue(
  name: string,
  value: JsonValue,
  schema: SchemaObject,
): void {
  if (!valueTypeMatches(value, schema))
    throw new EsiRequestError(
      `Parameter ${name} does not match type ${String(schema.type)}`,
    );
  if (
    schema.enum &&
    !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))
  ) {
    throw new EsiRequestError(
      `Parameter ${name} must be one of: ${schema.enum.map(String).join(", ")}`,
    );
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      throw new EsiRequestError(
        `Parameter ${name} must be >= ${schema.minimum}`,
      );
    if (schema.maximum !== undefined && value > schema.maximum)
      throw new EsiRequestError(
        `Parameter ${name} must be <= ${schema.maximum}`,
      );
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      throw new EsiRequestError(`Parameter ${name} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      throw new EsiRequestError(`Parameter ${name} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value))
      throw new EsiRequestError(`Parameter ${name} has an invalid format`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      throw new EsiRequestError(
        `${name} requires at least ${schema.minItems} items`,
      );
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      throw new EsiRequestError(
        `${name} allows at most ${schema.maxItems} items`,
      );
    if (
      schema.uniqueItems &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    ) {
      throw new EsiRequestError(`${name} items must be unique`);
    }
    if (schema.items) {
      const itemSchema = schema.items as SchemaObject;
      value.forEach((item, index) => {
        validateValue(`${name}[${index}]`, item, itemSchema);
      });
    }
  }
}

function scalar(value: JsonValue): string {
  return typeof value === "object" && value !== null
    ? JSON.stringify(value)
    : String(value);
}

function valuesForQuery(
  value: JsonValue,
  parameter: ParameterObject,
): string[] {
  if (!Array.isArray(value)) return [scalar(value)];
  return parameter.explode === false
    ? [value.map(scalar).join(",")]
    : value.map(scalar);
}

function declaredByLocation(
  operation: OperationDescriptor,
  location: ParameterObject["in"],
): Map<string, ParameterObject> {
  return new Map(
    operation.parameters
      .filter((parameter) => parameter.in === location)
      .map((parameter) => [parameter.name.toLowerCase(), parameter]),
  );
}

function selectedHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    RESPONSE_HEADERS.flatMap((name) =>
      headers.has(name) ? [[name, headers.get(name) ?? ""]] : [],
    ),
  );
}

function cacheLifetime(
  headers: Headers,
  operation: OperationDescriptor,
): number {
  const cacheControl = headers.get("cache-control");
  const maxAge = cacheControl?.match(/(?:^|,)\s*max-age=(\d+)/iu)?.[1];
  if (maxAge) return Number(maxAge) * 1000;
  const expires = headers.get("expires");
  if (expires) return Math.max(Date.parse(expires) - Date.now(), 0);
  return Math.max(operation.cacheSeconds ?? 0, 0) * 1000;
}

export class EsiClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly baseUrl: string;

  constructor(
    private readonly catalog: OperationCatalog,
    private readonly tokenProvider: TokenProvider,
    private readonly options: {
      fetchImplementation?: typeof fetch;
      userAgent?: string;
      maxResponseBytes?: number;
      baseUrl?: string;
    } = {},
  ) {
    this.baseUrl = options.baseUrl ?? "https://esi.evetech.net";
    const parsed = new URL(this.baseUrl);
    if (
      parsed.protocol !== "https:" &&
      parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "localhost"
    ) {
      throw new Error(
        "ESI base URL must use HTTPS (except loopback URLs used by tests)",
      );
    }
  }

  async call(input: EsiCallInput): Promise<EsiResponse> {
    const operation = this.catalog.get(input.operationId);
    const url = this.buildUrl(operation, input.path ?? {}, input.query ?? {});
    const headers = this.buildHeaders(operation, input.headers ?? {});
    const token =
      operation.requiredScopes.length > 0
        ? await this.tokenProvider.getAccessToken(operation.requiredScopes)
        : undefined;
    if (operation.requiredScopes.length > 0 && !token) {
      throw new EsiRequestError(
        `Operation ${operation.operationId} requires EVE authentication. Run: eve-online-mcp auth login --client-id <your-client-id>`,
        401,
        {
          requiredScopes: operation.requiredScopes,
        },
      );
    }
    if (token) {
      const missingScopes = missingTokenScopes(token, operation.requiredScopes);
      if (missingScopes.length > 0)
        throw new EsiRequestError(
          "The EVE access token lacks required scopes",
          403,
          { missingScopes },
        );
      headers.set("authorization", `Bearer ${token}`);
    }
    let body: string | undefined;
    if (operation.requestBodyRequired && input.body === undefined)
      throw new EsiRequestError(
        `Operation ${operation.operationId} requires a JSON body`,
      );
    if (input.body !== undefined) {
      if (!operation.requestBodySchema)
        throw new EsiRequestError(
          `Operation ${operation.operationId} does not accept a JSON body`,
        );
      validateValue("body", input.body, operation.requestBodySchema);
      body = JSON.stringify(input.body);
      headers.set("content-type", "application/json");
    }

    const cacheHeaders = [...headers.entries()].filter(
      ([name]) => name !== "authorization" && name !== "user-agent",
    );
    const cacheKey = `${operation.method}:${url.href}:${token ? "authenticated" : "public"}:${JSON.stringify(cacheHeaders)}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now())
      return { ...cached.response, cached: true };

    const response = await (this.options.fetchImplementation ?? fetch)(url, {
      method: operation.method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    const limit = this.options.maxResponseBytes ?? 5_000_000;
    if (contentLength > limit)
      throw new EsiRequestError(
        `ESI response exceeds the ${limit} byte safety limit`,
        response.status,
      );

    const raw =
      operation.method === "HEAD" ||
      response.status === 204 ||
      response.status === 304
        ? ""
        : await response.text();
    if (Buffer.byteLength(raw) > limit)
      throw new EsiRequestError(
        `ESI response exceeds the ${limit} byte safety limit`,
        response.status,
      );
    let data: JsonValue | string | null = null;
    if (raw) {
      try {
        data = JSON.parse(raw) as JsonValue;
      } catch {
        data = raw;
      }
    }

    const result: EsiResponse = {
      operationId: operation.operationId,
      status: response.status,
      url: url.href,
      cached: false,
      headers: selectedHeaders(response.headers),
      data,
    };
    if (!response.ok && response.status !== 304) {
      throw new EsiRequestError(
        `ESI ${operation.operationId} failed with HTTP ${response.status}`,
        response.status,
        data ?? undefined,
      );
    }
    const ttl = cacheLifetime(response.headers, operation);
    if (operation.method === "GET" && response.ok && ttl > 0)
      this.cache.set(cacheKey, {
        expiresAt: Date.now() + ttl,
        response: result,
      });
    return result;
  }

  private buildUrl(
    operation: OperationDescriptor,
    pathValues: Record<string, JsonValue>,
    queryValues: Record<string, JsonValue>,
  ): URL {
    const pathParameters = declaredByLocation(operation, "path");
    this.rejectUnknown(pathValues, pathParameters, "path");
    let path = operation.path;
    for (const parameter of pathParameters.values()) {
      const value = pathValues[parameter.name];
      if (value === undefined || value === null)
        throw new EsiRequestError(
          `Missing required path parameter: ${parameter.name}`,
        );
      validateValue(parameter.name, value, this.catalog.schemaFor(parameter));
      path = path.replace(
        `{${parameter.name}}`,
        encodeURIComponent(scalar(value)),
      );
    }
    if (/\{[^}]+\}/u.test(path))
      throw new EsiRequestError(
        `Not all path parameters were supplied for ${operation.operationId}`,
      );

    const url = new URL(path, this.baseUrl);
    const queryParameters = declaredByLocation(operation, "query");
    this.rejectUnknown(queryValues, queryParameters, "query");
    for (const parameter of queryParameters.values()) {
      let value = queryValues[parameter.name];
      if (value === undefined && parameter.schema)
        value = this.catalog.schemaFor(parameter).default;
      if (value === undefined || value === null) {
        if (parameter.required)
          throw new EsiRequestError(
            `Missing required query parameter: ${parameter.name}`,
          );
        continue;
      }
      validateValue(parameter.name, value, this.catalog.schemaFor(parameter));
      for (const encoded of valuesForQuery(value, parameter))
        url.searchParams.append(parameter.name, encoded);
    }
    return url;
  }

  private buildHeaders(
    operation: OperationDescriptor,
    input: Record<string, JsonValue>,
  ): Headers {
    const parameters = declaredByLocation(operation, "header");
    const normalizedInput = Object.fromEntries(
      Object.entries(input).map(([name, value]) => [name.toLowerCase(), value]),
    );
    this.rejectUnknown(normalizedInput, parameters, "header");
    const headers = new Headers({
      accept: "application/json",
      "user-agent": this.options.userAgent ?? DEFAULT_ESI_USER_AGENT,
    });
    for (const parameter of parameters.values()) {
      let value = normalizedInput[parameter.name.toLowerCase()];
      const schema = this.catalog.schemaFor(parameter);
      if (value === undefined) value = schema.default;
      if (
        value === undefined &&
        parameter.name.toLowerCase() === "x-compatibility-date"
      ) {
        value =
          schema.enum?.[0] ?? this.catalog.document.info.version ?? undefined;
      }
      if (value === undefined || value === null) {
        if (parameter.required)
          throw new EsiRequestError(
            `Missing required header parameter: ${parameter.name}`,
          );
        continue;
      }
      validateValue(parameter.name, value, schema);
      headers.set(parameter.name, scalar(value));
    }
    return headers;
  }

  private rejectUnknown(
    values: Record<string, JsonValue>,
    parameters: Map<string, ParameterObject>,
    location: string,
  ): void {
    const unknown = Object.keys(values).filter(
      (name) => !parameters.has(name.toLowerCase()),
    );
    if (unknown.length > 0)
      throw new EsiRequestError(
        `Unknown ${location} parameter(s): ${unknown.join(", ")}`,
      );
  }
}
