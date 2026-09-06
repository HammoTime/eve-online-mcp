import { createHash } from "node:crypto";
import { missingTokenScopes, type TokenProvider } from "./auth.js";
import { OperationCatalog, UnknownOperationError } from "./openapi.js";
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
  freshness: {
    fetchedAt: string;
    servedAt: string;
    expiresAt: string | null;
    sourceLastModified: string | null;
  };
  pagination: {
    mode: "page" | "none";
    currentPage: number | null;
    totalPages: number | null;
    hasMore: boolean | null;
    nextCall: EsiCallInput | null;
  };
}

export type EsiErrorCode =
  | "UNKNOWN_OPERATION"
  | "VALIDATION_ERROR"
  | "AUTHENTICATION_REQUIRED"
  | "AUTHENTICATION_FAILED"
  | "MISSING_SCOPES"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "THROTTLED"
  | "NETWORK_ERROR"
  | "UPSTREAM_ERROR"
  | "RESPONSE_LIMIT"
  | "INVALID_UPSTREAM_RESPONSE";

export class EsiRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: JsonValue | string,
    readonly metadata: {
      code?: EsiErrorCode;
      retryable?: boolean;
      retryAfterSeconds?: number | null;
      suggestedAction?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "EsiRequestError";
  }

  get code(): EsiErrorCode {
    return this.metadata.code ?? codeForStatus(this.status);
  }

  get retryable(): boolean {
    return this.metadata.retryable ?? retryableForCode(this.code);
  }

  get retryAfterSeconds(): number | null {
    return this.metadata.retryAfterSeconds ?? null;
  }

  get suggestedAction(): string | null {
    if (this.metadata.suggestedAction !== undefined)
      return this.metadata.suggestedAction;
    return suggestedActionForCode(this.code);
  }
}

export interface EsiAuthorization {
  readonly authorizationContext: "esi";
}

interface CacheEntry {
  expiresAt: number;
  response: EsiResponse;
  byteLength: number;
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

function codeForStatus(status: number | undefined): EsiErrorCode {
  if (status === 401) return "AUTHENTICATION_REQUIRED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 420 || status === 429) return "THROTTLED";
  if (status !== undefined && status >= 500) return "UPSTREAM_ERROR";
  return "VALIDATION_ERROR";
}

function retryableForCode(code: EsiErrorCode): boolean {
  return ["THROTTLED", "NETWORK_ERROR", "UPSTREAM_ERROR"].includes(code);
}

function suggestedActionForCode(code: EsiErrorCode): string | null {
  switch (code) {
    case "AUTHENTICATION_REQUIRED":
    case "AUTHENTICATION_FAILED":
      return "Run `eve-online-mcp auth login`, then retry the protected operation.";
    case "MISSING_SCOPES":
      return "Log in again with the required read-only scopes listed in details.";
    case "THROTTLED":
      return "Wait for retryAfterSeconds when provided before trying again.";
    case "NETWORK_ERROR":
    case "UPSTREAM_ERROR":
      return "Retry later if the request is still needed.";
    case "RESPONSE_LIMIT":
      return "Request a smaller page or use a more selective operation.";
    case "UNKNOWN_OPERATION":
      return "Use search_esi_operations, then inspect the selected operation.";
    case "VALIDATION_ERROR":
      return "Inspect the operation contract and correct the supplied inputs.";
    case "NOT_FOUND":
      return "Verify the identifiers and access context before making another request.";
    case "FORBIDDEN":
      return "Verify ownership, roles, and endpoint access; authorization alone may not resolve this response.";
    case "INVALID_UPSTREAM_RESPONSE":
      return "The upstream response could not be safely interpreted; try again later.";
  }
}

export function publicEsiError(error: unknown): Record<string, unknown> {
  if (error instanceof UnknownOperationError) {
    return {
      error: error.message,
      status: null,
      details: null,
      code: "UNKNOWN_OPERATION",
      retryable: false,
      retryAfterSeconds: null,
      suggestedAction: suggestedActionForCode("UNKNOWN_OPERATION"),
    };
  }
  if (error instanceof EsiRequestError) {
    return {
      error: error.message,
      status: error.status ?? null,
      details: error.details ?? null,
      code: error.code,
      retryable: error.retryable,
      retryAfterSeconds: error.retryAfterSeconds,
      suggestedAction: error.suggestedAction,
    };
  }
  return {
    error: error instanceof Error ? error.message : String(error),
    status: null,
    details: null,
    code: "UPSTREAM_ERROR",
    retryable: false,
    retryAfterSeconds: null,
    suggestedAction: null,
  };
}

function validationError(message: string): EsiRequestError {
  return new EsiRequestError(message, undefined, undefined, {
    code: "VALIDATION_ERROR",
    retryable: false,
  });
}

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
    throw validationError(
      `Parameter ${name} does not match type ${String(schema.type)}`,
    );
  if (
    schema.enum &&
    !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))
  )
    throw validationError(
      `Parameter ${name} must be one of: ${schema.enum.map(String).join(", ")}`,
    );
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      throw validationError(`Parameter ${name} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      throw validationError(`Parameter ${name} must be <= ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      throw validationError(`Parameter ${name} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      throw validationError(`Parameter ${name} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value))
      throw validationError(`Parameter ${name} has an invalid format`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      throw validationError(
        `${name} requires at least ${schema.minItems} items`,
      );
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      throw validationError(`${name} allows at most ${schema.maxItems} items`);
    if (
      schema.uniqueItems &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    )
      throw validationError(`${name} items must be unique`);
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

function parseHttpDate(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cacheExpiry(
  headers: Headers,
  operation: OperationDescriptor,
  fetchedAt: number,
): { expiresAt: number | null; cacheable: boolean } {
  const cacheControl = headers.get("cache-control");
  if (
    cacheControl &&
    /(?:^|,)\s*(?:no-store|no-cache)(?:=|\s|,|$)/iu.test(cacheControl)
  )
    return { expiresAt: fetchedAt, cacheable: false };
  const maxAgeMatch = cacheControl?.match(
    /(?:^|,)\s*max-age\s*=\s*([^,\s]+)/iu,
  );
  if (maxAgeMatch) {
    const seconds = Number(maxAgeMatch[1]);
    const expiresAt = fetchedAt + seconds * 1000;
    if (
      Number.isFinite(seconds) &&
      seconds >= 0 &&
      Number.isFinite(new Date(expiresAt).getTime())
    )
      return {
        expiresAt,
        cacheable: seconds > 0,
      };
    return { expiresAt: null, cacheable: false };
  }
  const expires = headers.get("expires");
  if (expires) {
    const parsed = parseHttpDate(expires);
    return parsed === null
      ? { expiresAt: null, cacheable: false }
      : { expiresAt: parsed, cacheable: parsed > fetchedAt };
  }
  if (operation.cacheSeconds === undefined)
    return { expiresAt: null, cacheable: false };
  const expiresAt = fetchedAt + Math.max(operation.cacheSeconds, 0) * 1000;
  return { expiresAt, cacheable: expiresAt > fetchedAt };
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  if (/^\d+$/u.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  const date = parseHttpDate(value);
  return date === null ? null : Math.max(Math.ceil((date - now) / 1000), 0);
}

function validPageCount(value: string | undefined): number | null {
  if (!value || !/^\d+$/u.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 1 ? count : null;
}

export class EsiClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly authorizationTokens = new WeakMap<object, string>();
  private readonly responseSizes = new WeakMap<EsiResponse, number>();
  private readonly baseUrl: string;

  constructor(
    private readonly catalog: OperationCatalog,
    private readonly tokenProvider: TokenProvider,
    private readonly options: {
      fetchImplementation?: typeof fetch;
      userAgent?: string;
      maxResponseBytes?: number;
      baseUrl?: string;
      clock?: () => Date;
    } = {},
  ) {
    this.baseUrl = options.baseUrl ?? "https://esi.evetech.net";
    const parsed = new URL(this.baseUrl);
    if (
      parsed.protocol !== "https:" &&
      parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "localhost"
    )
      throw new Error(
        "ESI base URL must use HTTPS (except loopback URLs used by tests)",
      );
  }

  async authorize(requiredScopes: string[]): Promise<EsiAuthorization> {
    const scopes = [...new Set(requiredScopes)].sort();
    if (scopes.length === 0) return { authorizationContext: "esi" };
    let token: string | undefined;
    try {
      token = await this.tokenProvider.getAccessToken(scopes);
    } catch (error) {
      throw new EsiRequestError(
        error instanceof Error ? error.message : "EVE authentication failed",
        401,
        { requiredScopes: scopes },
        { code: "AUTHENTICATION_FAILED", retryable: false },
      );
    }
    const checkedToken = this.requireToken(token, scopes);
    const authorization: EsiAuthorization = { authorizationContext: "esi" };
    this.authorizationTokens.set(authorization, checkedToken);
    return authorization;
  }

  responseByteLength(response: EsiResponse): number {
    return (
      this.responseSizes.get(response) ??
      Buffer.byteLength(JSON.stringify(response.data))
    );
  }

  async call(
    input: EsiCallInput,
    authorization?: EsiAuthorization,
  ): Promise<EsiResponse> {
    const operation = this.catalog.get(input.operationId);
    const url = this.buildUrl(operation, input.path ?? {}, input.query ?? {});
    const headers = this.buildHeaders(operation, input.headers ?? {});
    let body: string | undefined;
    if (operation.requestBodyRequired && input.body === undefined)
      throw validationError(
        `Operation ${operation.operationId} requires a JSON body`,
      );
    if (input.body !== undefined) {
      if (!operation.requestBodySchema)
        throw validationError(
          `Operation ${operation.operationId} does not accept a JSON body`,
        );
      validateValue("body", input.body, operation.requestBodySchema);
      body = JSON.stringify(input.body);
      headers.set("content-type", "application/json");
    }

    const token = await this.tokenFor(operation, authorization);
    if (token) headers.set("authorization", `Bearer ${token}`);
    const cacheHeaders = [...headers.entries()].filter(
      ([name]) => name !== "authorization" && name !== "user-agent",
    );
    const credentialContext = token
      ? createHash("sha256").update(token).digest("base64url")
      : "public";
    const cacheKey = `${operation.method}:${url.href}:${credentialContext}:${JSON.stringify(cacheHeaders)}`;
    const servedAt = this.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > servedAt) {
      const result: EsiResponse = {
        ...cached.response,
        cached: true,
        freshness: {
          ...cached.response.freshness,
          servedAt: new Date(servedAt).toISOString(),
        },
      };
      this.responseSizes.set(result, cached.byteLength);
      return result;
    }

    let response: Response;
    try {
      response = await (this.options.fetchImplementation ?? fetch)(url, {
        method: operation.method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      throw new EsiRequestError(
        `ESI network request failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        undefined,
        { code: "NETWORK_ERROR", retryable: true },
      );
    }
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    const limit = this.options.maxResponseBytes ?? 5_000_000;
    if (Number.isFinite(contentLength) && contentLength > limit)
      throw new EsiRequestError(
        `ESI response exceeds the ${limit} byte safety limit`,
        response.status,
        undefined,
        { code: "RESPONSE_LIMIT", retryable: false },
      );

    const raw =
      operation.method === "HEAD" ||
      response.status === 204 ||
      response.status === 304
        ? ""
        : await response.text();
    const byteLength = Buffer.byteLength(raw);
    if (byteLength > limit)
      throw new EsiRequestError(
        `ESI response exceeds the ${limit} byte safety limit`,
        response.status,
        undefined,
        { code: "RESPONSE_LIMIT", retryable: false },
      );
    let data: JsonValue | string | null = null;
    if (raw) {
      try {
        data = JSON.parse(raw) as JsonValue;
      } catch {
        data = raw;
      }
    }

    const fetchedAt = this.now();
    const responseHeaders = selectedHeaders(response.headers);
    const policy = cacheExpiry(response.headers, operation, fetchedAt);
    const modifiedAt = parseHttpDate(response.headers.get("last-modified"));
    const result: EsiResponse = {
      operationId: operation.operationId,
      status: response.status,
      url: url.href,
      cached: false,
      headers: responseHeaders,
      data,
      freshness: {
        fetchedAt: new Date(fetchedAt).toISOString(),
        servedAt: new Date(fetchedAt).toISOString(),
        expiresAt:
          policy.expiresAt === null
            ? null
            : new Date(policy.expiresAt).toISOString(),
        sourceLastModified:
          modifiedAt === null ? null : new Date(modifiedAt).toISOString(),
      },
      pagination: this.paginationFor(operation, input, responseHeaders),
    };
    this.responseSizes.set(result, byteLength);
    if (!response.ok && response.status !== 304) {
      const code = codeForStatus(response.status);
      throw new EsiRequestError(
        `ESI ${operation.operationId} failed with HTTP ${response.status}`,
        response.status,
        data ?? undefined,
        {
          code,
          retryable: retryableForCode(code),
          retryAfterSeconds: parseRetryAfter(
            response.headers.get("retry-after"),
            fetchedAt,
          ),
        },
      );
    }
    if (
      operation.method === "GET" &&
      response.ok &&
      policy.cacheable &&
      policy.expiresAt !== null
    )
      this.cache.set(cacheKey, {
        expiresAt: policy.expiresAt,
        response: result,
        byteLength,
      });
    return result;
  }

  private now(): number {
    return (this.options.clock?.() ?? new Date()).getTime();
  }

  private requireToken(
    token: string | undefined,
    requiredScopes: string[],
  ): string {
    if (!token)
      throw new EsiRequestError(
        "This operation requires EVE authentication.",
        401,
        { requiredScopes },
        { code: "AUTHENTICATION_REQUIRED", retryable: false },
      );
    const missingScopes = missingTokenScopes(token, requiredScopes);
    if (missingScopes.length > 0)
      throw new EsiRequestError(
        "The EVE access token lacks required scopes",
        403,
        { missingScopes },
        { code: "MISSING_SCOPES", retryable: false },
      );
    return token;
  }

  private async tokenFor(
    operation: OperationDescriptor,
    authorization: EsiAuthorization | undefined,
  ): Promise<string | undefined> {
    if (operation.requiredScopes.length === 0) return undefined;
    let token = authorization
      ? this.authorizationTokens.get(authorization)
      : undefined;
    if (authorization && !token)
      throw validationError("Invalid ESI authorization context");
    if (!token) {
      try {
        token = await this.tokenProvider.getAccessToken(
          operation.requiredScopes,
        );
      } catch (error) {
        throw new EsiRequestError(
          error instanceof Error ? error.message : "EVE authentication failed",
          401,
          { requiredScopes: operation.requiredScopes },
          { code: "AUTHENTICATION_FAILED", retryable: false },
        );
      }
    }
    return this.requireToken(token, operation.requiredScopes);
  }

  private paginationFor(
    operation: OperationDescriptor,
    input: EsiCallInput,
    responseHeaders: Record<string, string>,
  ): EsiResponse["pagination"] {
    const pageParameter = operation.parameters.find((parameter) => {
      if (parameter.in !== "query" || parameter.name !== "page") return false;
      const type = this.catalog.schemaFor(parameter).type;
      return (
        type === "integer" || (Array.isArray(type) && type.includes("integer"))
      );
    });
    if (!pageParameter)
      return {
        mode: "none",
        currentPage: null,
        totalPages: null,
        hasMore: null,
        nextCall: null,
      };
    const suppliedPage = input.query?.[pageParameter.name];
    const defaultPage = this.catalog.schemaFor(pageParameter).default;
    const currentPage =
      typeof suppliedPage === "number"
        ? suppliedPage
        : typeof defaultPage === "number"
          ? defaultPage
          : 1;
    const totalPages = validPageCount(responseHeaders["x-pages"]);
    const hasMore = totalPages === null ? null : currentPage < totalPages;
    return {
      mode: "page",
      currentPage,
      totalPages,
      hasMore,
      nextCall:
        hasMore === true
          ? {
              operationId: input.operationId,
              ...(input.path ? { path: { ...input.path } } : {}),
              query: { ...input.query, [pageParameter.name]: currentPage + 1 },
              ...(input.headers
                ? {
                    headers: Object.fromEntries(
                      Object.entries(input.headers).filter(
                        ([name]) =>
                          !["if-none-match", "if-modified-since"].includes(
                            name.toLowerCase(),
                          ),
                      ),
                    ),
                  }
                : {}),
              ...(input.body === undefined ? {} : { body: input.body }),
            }
          : null,
    };
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
        throw validationError(
          `Missing required path parameter: ${parameter.name}`,
        );
      validateValue(parameter.name, value, this.catalog.schemaFor(parameter));
      path = path.replace(
        `{${parameter.name}}`,
        encodeURIComponent(scalar(value)),
      );
    }
    if (/\{[^}]+\}/u.test(path))
      throw validationError(
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
          throw validationError(
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
      )
        value =
          schema.enum?.[0] ?? this.catalog.document.info.version ?? undefined;
      if (value === undefined || value === null) {
        if (parameter.required)
          throw validationError(
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
      throw validationError(
        `Unknown ${location} parameter(s): ${unknown.join(", ")}`,
      );
  }
}
