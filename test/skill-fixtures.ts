import { crc32 } from "node:zlib";
import type { StaticDataSource } from "../src/static-data.js";
import {
  SkillCatalog,
  type StaticCatalog,
  type StaticType,
  type Requirement,
} from "../src/skill-data.js";

export function skill(
  id: number,
  name: string,
  requirements: Requirement[] = [],
): StaticType {
  return {
    id,
    name,
    requirements,
    groupId: 10,
    categoryId: 16,
    rank: 1,
    published: true,
  };
}
export function skillFixture(types?: StaticType[]): StaticCatalog {
  return {
    schemaVersion: 1,
    buildNumber: 123,
    releaseDate: "2026-09-01T00:00:00Z",
    sourceUrl:
      "https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-123-jsonl.zip",
    fetchedAt: "2026-09-07T00:00:00Z",
    types: types ?? [
      skill(100, "Mining"),
      skill(200, "Exhumers", [{ skillId: 100, level: 2 }]),
      skill(300, "Hauling", [{ skillId: 100, level: 2 }]),
      {
        id: 400,
        name: "Test Hull",
        groupId: 20,
        categoryId: 6,
        published: true,
        rank: null,
        requirements: [
          { skillId: 200, level: 1 },
          { skillId: 300, level: 1 },
        ],
      },
    ],
  };
}
export function fixtureSource(data = skillFixture()): StaticDataSource {
  const catalog = new SkillCatalog(data);
  return {
    initialize: () =>
      Promise.resolve({
        catalog,
        status: { buildNumber: data.buildNumber, stale: false },
      }),
  };
}

/** Tiny stored ZIP fixture writer; files are synthetic, never downloaded during unit tests. */
export function zipFixture(entries: [string, string][]): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [filename, text] of entries) {
    const name = Buffer.from(filename),
      data = Buffer.from(text),
      crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export function archiveEntries(): [string, string][] {
  return [
    [
      "groups.jsonl",
      JSON.stringify({ _key: 0, categoryID: 0 }) +
        "\n" +
        JSON.stringify({ _key: 10, categoryID: 16 }),
    ],
    [
      "types.jsonl",
      JSON.stringify({
        _key: 100,
        groupID: 10,
        name: { en: "Mining" },
        published: true,
      }),
    ],
    [
      "typeDogma.jsonl",
      JSON.stringify({
        _key: 100,
        dogmaAttributes: [{ attributeID: 275, value: 1 }],
      }),
    ],
  ];
}
