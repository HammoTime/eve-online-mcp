import { createHash } from "node:crypto";
import { SCHEMA_CHECK_USER_AGENT } from "./package-metadata.js";
import type { OpenApiDocument } from "./types.js";

export const ESI_OPENAPI_URL = "https://esi.evetech.net/meta/openapi.json";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function canonicalJson(document: OpenApiDocument): string {
  return `${JSON.stringify(canonicalize(document), null, 2)}\n`;
}

export function documentHash(document: OpenApiDocument): string {
  return createHash("sha256").update(canonicalJson(document)).digest("hex");
}

function operationSignatures(document: OpenApiDocument): Map<string, string> {
  const signatures = new Map<string, string>();
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of [
      "get",
      "head",
      "post",
      "put",
      "patch",
      "delete",
    ] as const) {
      const operation = pathItem[method];
      if (!operation) continue;
      signatures.set(
        `${method.toUpperCase()} ${path}`,
        JSON.stringify(canonicalize(operation)),
      );
    }
  }
  return signatures;
}

export interface SchemaDiff {
  changed: boolean;
  currentHash: string;
  upstreamHash: string;
  added: string[];
  removed: string[];
  modified: string[];
}

export function diffDocuments(
  current: OpenApiDocument,
  upstream: OpenApiDocument,
): SchemaDiff {
  const currentHash = documentHash(current);
  const upstreamHash = documentHash(upstream);
  const before = operationSignatures(current);
  const after = operationSignatures(upstream);
  const added = [...after.keys()].filter((key) => !before.has(key)).sort();
  const removed = [...before.keys()].filter((key) => !after.has(key)).sort();
  const modified = [...after.keys()]
    .filter((key) => before.has(key) && before.get(key) !== after.get(key))
    .sort();
  return {
    changed: currentHash !== upstreamHash,
    currentHash,
    upstreamHash,
    added,
    removed,
    modified,
  };
}

export async function fetchOpenApi(
  fetchImplementation: typeof fetch = fetch,
): Promise<OpenApiDocument> {
  const response = await fetchImplementation(ESI_OPENAPI_URL, {
    headers: {
      accept: "application/openapi+json, application/json",
      "user-agent": SCHEMA_CHECK_USER_AGENT,
    },
  });
  if (!response.ok)
    throw new Error(
      `Could not download ESI OpenAPI schema: HTTP ${response.status}`,
    );
  return (await response.json()) as OpenApiDocument;
}
