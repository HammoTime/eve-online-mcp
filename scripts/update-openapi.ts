import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultOpenApiPath } from "../src/openapi.js";
import { canonicalJson, fetchOpenApi } from "../src/schema-diff.js";

const destination = defaultOpenApiPath();
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, canonicalJson(await fetchOpenApi()), "utf8");
console.log(`Updated ${destination}`);
