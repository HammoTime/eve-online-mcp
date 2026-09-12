import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SkillImport, SkillStore } from "../src/skill-store.js";
import { jsonLines, readStaticArchive } from "../src/static-data-archive.js";
import { archiveEntries, skillFixture, zipFixture } from "./skill-fixtures.js";

const directories: string[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  releases.splice(0).forEach((release) => {
    release();
  });
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function parse(entries: [string, string][]) {
  const directory = await mkdtemp(join(tmpdir(), "eve-archive-test-"));
  directories.push(directory);
  const path = join(directory, "sde.zip");
  await writeFile(path, zipFixture(entries));
  const stage = await readStaticArchive(path, skillFixture());
  const store = new SkillStore(directory);
  try {
    store.publishImport(stage, skillFixture().fetchedAt, null);
  } finally {
    stage.dispose();
  }
  const snapshot = store.acquire();
  releases.push(snapshot.release);
  return snapshot.catalog;
}
function requiredEntry(entries: [string, string][], index: number) {
  const entry = entries[index];
  if (!entry) throw new Error("Missing test entry");
  return entry;
}
describe("bounded official JSONL archive reader", () => {
  it("bounds central-directory enumeration before consuming any required dataset", async () => {
    await expect(
      parse(
        Array.from({ length: 10_001 }, (_, id) => [`ignored-${id}.jsonl`, ""]),
      ),
    ).rejects.toThrow("entry count exceeds limit");
  });
  it("streams selected entries in any order, accepts raw placeholder IDs, and ignores other files", async () => {
    const result = await parse([
      ...archiveEntries().reverse(),
      ["irrelevant.jsonl", "not json"],
    ]);
    expect([result.getType(100)]).toEqual([
      {
        id: 100,
        name: "Mining",
        groupId: 10,
        categoryId: 16,
        published: true,
        requirements: [],
        rank: 1,
      },
    ]);
  });
  it("decodes all requirement slots and retains unavailable ship metadata", async () => {
    const entries = archiveEntries();
    requiredEntry(entries, 0)[1] +=
      "\n" + JSON.stringify({ _key: 20, categoryID: 6 });
    requiredEntry(entries, 1)[1] +=
      "\n" +
      JSON.stringify({
        _key: 200,
        groupID: 20,
        name: { en: "Ship" },
        published: true,
      });
    expect((await parse(entries)).getType(200)).toMatchObject({
      requirements: null,
      rank: null,
    });
    requiredEntry(entries, 2)[1] +=
      "\n" +
      JSON.stringify({
        _key: 200,
        dogmaAttributes: [
          { attributeID: 1290, value: 100 },
          { attributeID: 1288, value: 5 },
        ],
      });
    expect((await parse(entries)).getType(200)?.requirements).toEqual([
      { skillId: 100, level: 5 },
    ]);
  });
  it("never converts malformed prerequisites to an empty list", async () => {
    const entries = archiveEntries();
    requiredEntry(entries, 2)[1] = JSON.stringify({
      _key: 100,
      dogmaAttributes: [
        { attributeID: 275, value: 1 },
        { attributeID: 182, value: 100 },
      ],
    });
    await expect(parse(entries)).rejects.toThrow("Incomplete skill");
    requiredEntry(entries, 2)[1] = JSON.stringify({ _key: 100 });
    await expect(parse(entries)).rejects.toThrow("Incomplete skill");
  });
  it.each([0, 1, 2])("rejects missing selected file %i", async (index) => {
    const entries = archiveEntries();
    entries.splice(index, 1);
    await expect(parse(entries)).rejects.toThrow("missing required files");
  });
  it.each([0, 1, 2])(
    "rejects duplicate records in selected file %i",
    async (index) => {
      const entries = archiveEntries();
      const entry = requiredEntry(entries, index);
      entry[1] += "\n" + entry[1];
      await expect(parse(entries)).rejects.toThrow("Duplicate");
    },
  );
  it("rejects duplicate selected entries, missing groups, invalid attributes, and unsafe ZIP paths", async () => {
    const entries = archiveEntries();
    await expect(
      parse([...entries, requiredEntry(entries, 0)]),
    ).rejects.toThrow("Duplicate SDE archive entry");
    requiredEntry(entries, 0)[1] = JSON.stringify({ _key: 99, categoryID: 16 });
    await expect(parse(entries)).rejects.toThrow("Missing SDE group");
    const duplicate = archiveEntries();
    requiredEntry(duplicate, 2)[1] = JSON.stringify({
      _key: 100,
      dogmaAttributes: [
        { attributeID: 275, value: 1 },
        { attributeID: 275, value: 1 },
      ],
    });
    await expect(parse(duplicate)).rejects.toThrow(
      "Duplicate SDE dogma attribute",
    );
    await expect(
      parse([...archiveEntries(), ["../escape", "x"]]),
    ).rejects.toThrow();
  });
  it("handles split UTF-8, CRLF, blank lines and a final unterminated line", async () => {
    const data = Buffer.from('\n{"name":"Mín"}\r\n\n{"next":2}');
    const stream = Readable.from(
      Array.from(data, (byte) => Buffer.from([byte])),
    );
    const values = [];
    for await (const value of jsonLines(stream, 1000)) values.push(value);
    expect(values).toEqual([{ name: "Mín" }, { next: 2 }]);
  });
  it("stages bounded projections with no transaction spanning an await or full catalog construction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eve-stream-stage-"));
    directories.push(directory);
    const exec = Reflect.get(DatabaseSync.prototype, "exec");
    const prepare = Reflect.get(DatabaseSync.prototype, "prepare");
    let inTransaction = false,
      batch = 0,
      highWater = 0,
      inserted = 0;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (sql === "BEGIN IMMEDIATE") {
        inTransaction = true;
        batch = 0;
      }
      if (sql === "COMMIT") {
        inTransaction = false;
        highWater = Math.max(highWater, batch);
      }
      exec.call(this, sql);
    });
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (sql.startsWith("INSERT INTO raw_")) {
        batch++;
        inserted++;
      }
      expect(sql).not.toContain("catalog_json");
      return prepare.call(this, sql);
    });
    async function* rows(kind: string) {
      for (let id = 1; id <= 5000; id++) {
        await Promise.resolve();
        expect(inTransaction).toBe(false);
        if (kind === "types")
          yield {
            _key: id,
            groupID: 10,
            published: true,
            name: { en: `Skill ${id}` },
          };
        else
          yield { _key: id, dogmaAttributes: [{ attributeID: 275, value: 1 }] };
      }
    }
    async function* entries() {
      await Promise.resolve();
      yield { name: "typeDogma.jsonl", rows: rows("dogma") };
      yield { name: "types.jsonl", rows: rows("types") };
      yield {
        name: "groups.jsonl",
        rows: (async function* () {
          yield await Promise.resolve({ _key: 10, categoryID: 16 });
        })(),
      };
    }
    const stage = new SkillImport(directory, skillFixture());
    try {
      await stage.import(entries());
      expect(stage.result().metadata).toMatchObject({
        typeCount: 5000,
        skillCount: 5000,
      });
      expect(highWater).toBe(256);
      expect(inserted).toBe(10001);
      const store = new SkillStore(directory);
      store.publishImport(stage, skillFixture().fetchedAt, null);
      const snapshot = store.acquire();
      releases.push(snapshot.release);
      expect(snapshot.catalog.resolve("Skill 5000")).toMatchObject({
        status: "resolved",
        typeId: 5000,
      });
    } finally {
      stage.dispose();
    }
    expect(
      (await readdir(directory)).some((name) =>
        name.startsWith("skills-import"),
      ),
    ).toBe(false);
  });
  it.each([
    ["123", 2],
    ["x".repeat(2_000_001), 3_000_000],
    ["x".repeat(2_000_001) + "\n", 3_000_000],
  ])("rejects oversized byte/line inputs %#", async (text, limit) => {
    const consume = async () => {
      for await (const value of jsonLines(
        Readable.from([Buffer.from(text)]),
        limit,
      ))
        expect(value).toBeDefined();
    };
    await expect(consume()).rejects.toThrow("limit");
  });
});
