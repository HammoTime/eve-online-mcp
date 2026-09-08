import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { OpenApiDocument } from "./types.js";
export * from "../lib/src/openapi.js";

export function defaultOpenApiPath(): string {
  return fileURLToPath(
    new URL("../lib/openapi/esi-openapi.json", import.meta.url),
  );
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
