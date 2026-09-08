import { copyFile, mkdir, writeFile } from "node:fs/promises";
await mkdir("dist/lib/openapi", { recursive: true });
await copyFile(
  "lib/openapi/esi-openapi.json",
  "dist/lib/openapi/esi-openapi.json",
);
await copyFile("package.json", "dist/package.json");
await writeFile(
  "dist/index.js",
  '#!/usr/bin/env node\nimport "./src/index.js";\n',
);
