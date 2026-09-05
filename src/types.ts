export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ReferenceObject {
  $ref: string;
}

export interface SchemaObject {
  type?: string | string[];
  description?: string;
  default?: JsonValue;
  enum?: JsonValue[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  pattern?: string;
  items?: SchemaObject | ReferenceObject;
  properties?: Record<string, SchemaObject | ReferenceObject>;
  required?: string[];
  [key: string]: unknown;
}

export interface ParameterObject {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  description?: string;
  required?: boolean;
  explode?: boolean;
  style?: string;
  schema?: SchemaObject | ReferenceObject;
}

export interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: (ParameterObject | ReferenceObject)[];
  requestBody?:
    | ReferenceObject
    | {
        required?: boolean;
        content?: Record<string, { schema?: SchemaObject | ReferenceObject }>;
      };
  security?: Record<string, string[]>[];
  responses?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PathItemObject {
  parameters?: (ParameterObject | ReferenceObject)[];
  get?: OperationObject;
  head?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
  [key: string]: unknown;
}

export interface OpenApiDocument {
  openapi: string;
  info: { title?: string; version?: string; [key: string]: unknown };
  servers?: { url: string; [key: string]: unknown }[];
  paths: Record<string, PathItemObject>;
  security?: Record<string, string[]>[];
  components?: {
    parameters?: Record<string, ParameterObject | ReferenceObject>;
    schemas?: Record<string, SchemaObject | ReferenceObject>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OperationDescriptor {
  operationId: string;
  method: "GET" | "HEAD" | "POST";
  path: string;
  summary: string;
  description: string;
  tags: string[];
  parameters: ParameterObject[];
  requiredScopes: string[];
  requestBodySchema?: SchemaObject;
  requestBodyRequired?: boolean;
  cacheSeconds?: number;
  rateLimit?: unknown;
}
