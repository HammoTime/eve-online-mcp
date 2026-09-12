import { openPromise } from "yauzl";
import type { Readable } from "node:stream";
import { dirname } from "node:path";
import type { StaticCatalog } from "./skill-data.js";
import { SkillImport } from "./skill-store.js";
import {
  jsonLines,
  STATIC_DATA_FILES,
  type StaticDataEntry,
} from "../lib/src/static-data-parser.js";
export { jsonLines } from "../lib/src/static-data-parser.js";

/** Select exact known entries and stream them; never extract archive paths to disk. */
async function* staticEntries(path: string): AsyncGenerator<StaticDataEntry> {
  const zip = await openPromise(path, {
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  try {
    if (zip.entryCount > 10_000)
      throw new Error("SDE archive entry count exceeds limit");
    let count = 0;
    for await (const entry of zip.eachEntry()) {
      if (++count > 10_000)
        throw new Error("SDE archive entry count exceeds limit");
      if (!STATIC_DATA_FILES.includes(entry.fileName)) continue;
      if (entry.uncompressedSize > 512_000_000)
        throw new Error("SDE archive entry exceeds byte limit");
      const stream: Readable = await zip.openReadStreamPromise(entry);
      try {
        yield { name: entry.fileName, rows: jsonLines(stream, 512_000_000) };
      } finally {
        stream.destroy();
      }
    }
  } finally {
    zip.close();
  }
}

export async function readStaticArchive(
  path: string,
  metadata: Omit<StaticCatalog, "schemaVersion" | "types">,
): Promise<SkillImport> {
  const stage = new SkillImport(dirname(path), metadata);
  try {
    return await stage.import(staticEntries(path));
  } catch (error) {
    stage.dispose();
    throw error;
  }
}
