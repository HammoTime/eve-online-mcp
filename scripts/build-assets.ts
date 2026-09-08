import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
await mkdir("dist/lib/openapi", { recursive: true });
await copyFile(
  "lib/openapi/esi-openapi.json",
  "dist/lib/openapi/esi-openapi.json",
);
await copyFile("package.json", "dist/package.json");
function revision(directory: string) {
  const sha = execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const dirty = execFileSync(
    "git",
    ["-C", directory, "status", "--porcelain", "--untracked-files=normal"],
    { encoding: "utf8" },
  ).trim();
  return dirty ? `${sha}-dirty` : sha;
}
await writeFile(
  "dist/diagnostic-build.json",
  JSON.stringify({
    server: revision("."),
    library: revision("lib"),
    openapi: createHash("sha256")
      .update(await readFile("lib/openapi/esi-openapi.json"))
      .digest("hex"),
  }),
);
await writeFile(
  "dist/index.js",
  '#!/usr/bin/env node\nimport "./src/index.js";\n',
);
