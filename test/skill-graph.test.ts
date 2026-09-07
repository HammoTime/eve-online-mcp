import { describe, it, expect } from "vitest";
import {
  SkillCatalog,
  decodeRequirements,
  REQUIREMENT_ATTRIBUTES,
  validateCatalog,
} from "../src/skill-data.js";
import {
  buildSkillGraph,
  replayTraining,
  skillPoints,
  trainingText,
} from "../src/skill-graph.js";
import { skill, skillFixture } from "./skill-fixtures.js";

describe("deterministic skill target resolution", () => {
  const catalog = new SkillCatalog(skillFixture());
  it.each(["Mining II", "mining 2", " MINING II "])(
    "resolves explicit skill levels: %s",
    (target) => {
      expect(catalog.resolve(target)).toMatchObject({
        status: "resolved",
        typeId: 100,
        requirements: [{ skillId: 100, level: 2 }],
      });
    },
  );
  it("resolves unique singular skills and discloses the level-I default", () => {
    expect(catalog.resolve("exhumer")).toMatchObject({
      status: "resolved",
      match: "singular-skill-name",
      requirements: [{ skillId: 200, level: 1 }],
    });
    expect(catalog.resolve({ typeId: 200, level: 3 })).toMatchObject({
      requirements: [{ skillId: 200, level: 3 }],
    });
  });
  it("returns candidates without guessing a goal or treating invalid levels as I", () => {
    expect(catalog.resolve("min")).toMatchObject({
      status: "unresolved",
      candidates: [{ typeId: 100, name: "Mining" }],
    });
    expect(catalog.resolve("Mining VI").status).toBe("unresolved");
    expect(catalog.resolve("Mining 0").status).toBe("unresolved");
    expect(catalog.resolve({ typeId: 999 }).status).toBe("unresolved");
  });
  it("does not silently pick duplicate names or unpublished types", () => {
    const data = skillFixture();
    data.types.push(skill(101, "Mining"), {
      ...skill(102, "Hidden"),
      published: false,
    });
    const catalog = new SkillCatalog(data);
    expect(catalog.resolve("Mining")).toMatchObject({ status: "ambiguous" });
    expect(catalog.resolve("Hidden").status).toBe("unresolved");
  });
  it("distinguishes exact names ending in II and rejects levels on ships", () => {
    const data = skillFixture();
    data.types.push({ ...skill(401, "Test Hull II"), categoryId: 6 });
    expect(new SkillCatalog(data).resolve("Test Hull II")).toMatchObject({
      status: "resolved",
      typeId: 401,
      kind: "ship",
    });
    expect(() => catalog.resolve({ typeId: 400, level: 2 })).toThrow(
      "Levels apply only",
    );
    data.types.push({ ...skill(600, "Module"), categoryId: 7 });
    expect(new SkillCatalog(data).resolve("Module").status).toBe("unsupported");
  });
  it("decodes all six non-contiguous slots and fails on incomplete/conflicting data", () => {
    const attrs = new Map(
      REQUIREMENT_ATTRIBUTES.flatMap(
        ([id, level], index) =>
          [
            [id, 100 + index],
            [level, (index % 5) + 1],
          ] as [number, number][],
      ),
    );
    expect(decodeRequirements(attrs)).toHaveLength(6);
    expect(
      decodeRequirements(
        new Map([
          [1289, 100],
          [1287, 3],
        ]),
      ),
    ).toEqual([{ skillId: 100, level: 3 }]);
    for (const invalid of [
      new Map([[182, 100]]),
      new Map([[277, 1]]),
      new Map([
        [182, 100],
        [277, 6],
      ]),
      new Map([
        [182, 100],
        [277, 1],
        [183, 100],
        [278, 2],
      ]),
    ])
      expect(() => decodeRequirements(invalid)).toThrow();
  });
  it("rejects missing, duplicated, or non-skill metadata", () => {
    const data = skillFixture();
    data.types = data.types.map((type) =>
      type.id === 100 ? { ...type, requirements: null } : type,
    );
    expect(() => validateCatalog(data)).toThrow("Incomplete skill");
    expect(() =>
      validateCatalog(
        skillFixture([skill(1, "A", [{ skillId: 999, level: 1 }])]),
      ),
    ).toThrow("Missing or non-skill");
    expect(() =>
      validateCatalog(skillFixture([skill(1, "A"), skill(1, "A")])),
    ).toThrow("Duplicate");
    expect(() => catalog.skill(400)).toThrow("Missing complete skill");
    const ships = skillFixture();
    ships.types = ships.types.map((type) =>
      type.id === 400 ? { ...type, requirements: null } : type,
    );
    expect(() => new SkillCatalog(ships).resolve("Test Hull")).toThrow(
      "Missing requirement",
    );
  });
});
describe("prerequisite DAG and replay", () => {
  const catalog = new SkillCatalog(skillFixture());
  it("deduplicates diamond dependencies and removes only completed levels", () => {
    const targets = [
      { skillId: 200, level: 1 },
      { skillId: 300, level: 1 },
      { skillId: 200, level: 1 },
    ];
    const baseline = new Map([[100, 1]]);
    const graph = buildSkillGraph(catalog, targets, baseline);
    expect(graph.nodes.map((row) => row.key)).toEqual([
      "100:2",
      "200:1",
      "300:1",
    ]);
    expect(graph.edges).toEqual([
      { from: "100:2", to: "200:1" },
      { from: "100:2", to: "300:1" },
    ]);
    expect(trainingText(graph.nodes, catalog)).toBe(
      "Mining II\nExhumers I\nHauling I",
    );
    expect(buildSkillGraph(catalog, targets, baseline)).toEqual(graph);
  });
  it("merges conflicting target levels by including each required level once", () => {
    const graph = buildSkillGraph(catalog, [
      { skillId: 100, level: 2 },
      { skillId: 100, level: 4 },
    ]);
    expect(graph.nodes.map((row) => row.level)).toEqual([1, 2, 3, 4]);
    expect(skillPoints(1, 0)).toBe(0);
    expect(skillPoints(2, 2)).toBe(2829);
  });
  it("honors grandfathered completion, but checks prerequisites for further training", () => {
    const baseline = new Map([[200, 1]]);
    expect(
      buildSkillGraph(catalog, [{ skillId: 200, level: 1 }], baseline).nodes,
    ).toEqual([]);
    expect(
      buildSkillGraph(
        catalog,
        [{ skillId: 200, level: 2 }],
        baseline,
      ).nodes.map((row) => row.key),
    ).toEqual(["100:1", "100:2", "200:2"]);
  });
  it("detects cycles separately from shared dependencies", () => {
    const loop = new SkillCatalog(
      skillFixture([
        skill(1, "A", [{ skillId: 2, level: 1 }]),
        skill(2, "B", [{ skillId: 1, level: 1 }]),
      ]),
    );
    expect(() => buildSkillGraph(loop, [{ skillId: 1, level: 1 }])).toThrow(
      "cycle",
    );
  });
  it("rejects invalid replay orders independently of graph edges", () => {
    expect(() =>
      replayTraining(catalog, [{ skillId: 200, level: 1 }], new Map()),
    ).toThrow("Missing prerequisite");
    expect(() =>
      replayTraining(catalog, [{ skillId: 100, level: 2 }], new Map()),
    ).toThrow("preceding level");
    expect(
      replayTraining(
        catalog,
        [{ skillId: 100, level: 1 }],
        new Map([[100, 2]]),
      ).get(100),
    ).toBe(2);
  });
  it("handles long prerequisite chains without recursive stack growth", () => {
    const types = Array.from({ length: 3000 }, (_, i) =>
      skill(i + 1, `Skill ${i + 1}`, i ? [{ skillId: i, level: 1 }] : []),
    );
    const graph = buildSkillGraph(new SkillCatalog(skillFixture(types)), [
      { skillId: 3000, level: 1 },
    ]);
    expect(graph.nodes).toHaveLength(3000);
    expect(graph.nodes[0]?.skillId).toBe(1);
  });
});
