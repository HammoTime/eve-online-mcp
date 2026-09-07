import { openPromise } from "yauzl";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import * as z from "zod/v4";
import {
  decodeRequirements,
  type StaticCatalog,
  type StaticType,
  typeId,
  validateCatalog,
} from "./skill-data.js";

export async function* jsonLines(
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number,
): AsyncGenerator {
  const decoder = new StringDecoder("utf8");
  let bytes = 0;
  let remaining = "";
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error("Static data exceeds byte limit");
    remaining += decoder.write(Buffer.from(chunk));
    let index: number;
    while ((index = remaining.indexOf("\n")) >= 0) {
      const line = remaining.slice(0, index).trim();
      remaining = remaining.slice(index + 1);
      if (line.length > 2_000_000)
        throw new Error("SDE record exceeds line limit");
      if (line) yield JSON.parse(line) as unknown;
    }
    if (remaining.length > 2_000_000)
      throw new Error("SDE record exceeds line limit");
  }
  remaining += decoder.end();
  if (remaining.trim()) yield JSON.parse(remaining) as unknown;
}

const rawId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const groupSchema = z.object({ _key: rawId, categoryID: rawId });
const typeSchema = z.object({
  _key: rawId,
  groupID: rawId,
  published: z.boolean(),
  name: z.object({ en: z.string() }),
});
const dogmaSchema = z.object({
  _key: typeId,
  dogmaAttributes: z
    .array(z.object({ attributeID: typeId, value: z.number() }))
    .default([]),
});
const FILES = ["groups.jsonl", "types.jsonl", "typeDogma.jsonl"];

/** Select known entries by exact name; never extract archive paths onto the filesystem. */
export async function readStaticArchive(
  path: string,
  metadata: Omit<StaticCatalog, "schemaVersion" | "types">,
): Promise<StaticCatalog> {
  const zip = await openPromise(path, {
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  const groups = new Map<number, number>();
  const rawTypes: z.infer<typeof typeSchema>[] = [];
  const dogma = new Map<
    number,
    { requirements: StaticType["requirements"]; rank: number | null }
  >();
  const seen = new Set<string>();
  try {
    for await (const entry of zip.eachEntry()) {
      if (!FILES.includes(entry.fileName)) continue;
      if (seen.has(entry.fileName))
        throw new Error("Duplicate SDE archive entry");
      seen.add(entry.fileName);
      if (entry.uncompressedSize > 512_000_000)
        throw new Error("SDE archive entry exceeds byte limit");
      const stream: Readable = await zip.openReadStreamPromise(entry);
      let count = 0;
      try {
        for await (const row of jsonLines(stream, 512_000_000)) {
          if (++count > 200_000)
            throw new Error("SDE record count exceeds limit");
          if (entry.fileName === "groups.jsonl") {
            const group = groupSchema.parse(row);
            if (groups.has(group._key))
              throw new Error("Duplicate SDE group ID");
            groups.set(group._key, group.categoryID);
          } else if (entry.fileName === "types.jsonl")
            rawTypes.push(typeSchema.parse(row));
          else {
            const type = dogmaSchema.parse(row);
            if (dogma.has(type._key))
              throw new Error("Duplicate SDE dogma type ID");
            const attributes = new Map<number, number>();
            for (const attribute of type.dogmaAttributes) {
              if (attributes.has(attribute.attributeID))
                throw new Error("Duplicate SDE dogma attribute");
              attributes.set(attribute.attributeID, attribute.value);
            }
            // Only skill/ship prerequisites are relevant. Retain malformed rows as unavailable,
            // so a malformed unrelated item cannot masquerade as having no requirements.
            let requirements: StaticType["requirements"] = null;
            try {
              requirements = decodeRequirements(attributes);
            } catch {
              /* validated for selected types below */
            }
            dogma.set(type._key, {
              requirements,
              rank: attributes.get(275) ?? null,
            });
          }
        }
      } finally {
        stream.destroy();
      }
    }
  } finally {
    zip.close();
  }
  if (seen.size !== FILES.length)
    throw new Error("SDE archive is missing required files");
  const types = rawTypes
    .filter((type) => {
      const category = groups.get(type.groupID);
      if (category === undefined)
        throw new Error(`Missing SDE group ${type.groupID}`);
      return [6, 16].includes(category);
    })
    .map((type) => {
      const categoryId = groups.get(type.groupID);
      if (categoryId === undefined)
        throw new Error(`Missing SDE group ${type.groupID}`);
      const details = dogma.get(type._key);
      return {
        id: type._key,
        name: type.name.en,
        groupId: type.groupID,
        categoryId,
        published: type.published,
        requirements: details?.requirements ?? null,
        rank: details?.rank ?? null,
      };
    });
  return validateCatalog({ schemaVersion: 1, ...metadata, types });
}
