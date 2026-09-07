import * as z from "zod/v4";

export const REQUIREMENT_ATTRIBUTES = [
  [182, 277],
  [183, 278],
  [184, 279],
  [1285, 1286],
  [1289, 1287],
  [1290, 1288],
] as const;
export const skillLevel = z.number().int().min(1).max(5);
export const typeId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const requirementSchema = z.object({
  skillId: typeId,
  level: skillLevel,
});
export type Requirement = z.infer<typeof requirementSchema>;
export const staticTypeSchema = z.object({
  id: typeId,
  name: z.string().min(1),
  groupId: typeId,
  categoryId: typeId,
  published: z.boolean(),
  requirements: z.array(requirementSchema).max(6).nullable(),
  rank: z.number().positive().nullable(),
});
export type StaticType = z.infer<typeof staticTypeSchema>;
export const staticCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  buildNumber: typeId,
  releaseDate: z.iso.datetime(),
  sourceUrl: z.url(),
  fetchedAt: z.iso.datetime(),
  types: z.array(staticTypeSchema).min(1).max(200_000),
});
export type StaticCatalog = z.infer<typeof staticCatalogSchema>;

export function decodeRequirements(
  attributes: Map<number, number>,
): Requirement[] {
  const requirements = new Map<number, number>();
  for (const [skillAttribute, levelAttribute] of REQUIREMENT_ATTRIBUTES) {
    const skillId = attributes.get(skillAttribute);
    const level = attributes.get(levelAttribute);
    if (skillId === undefined && level === undefined) continue;
    const requirement = requirementSchema.parse({ skillId, level });
    const previous = requirements.get(requirement.skillId);
    if (previous !== undefined && previous !== requirement.level)
      throw new Error("Conflicting prerequisite levels in SDE");
    requirements.set(requirement.skillId, requirement.level);
  }
  return [...requirements].map(([skillId, level]) => ({ skillId, level }));
}

export function validateCatalog(value: unknown): StaticCatalog {
  const catalog = staticCatalogSchema.parse(value);
  const types = new Map(catalog.types.map((type) => [type.id, type]));
  if (types.size !== catalog.types.length)
    throw new Error("Duplicate SDE type IDs");
  for (const type of catalog.types) {
    if (
      type.categoryId === 16 &&
      type.published &&
      (!type.requirements || type.rank === null)
    )
      throw new Error(`Incomplete skill metadata: ${type.id}`);
    for (const requirement of type.requirements ?? []) {
      if (types.get(requirement.skillId)?.categoryId !== 16)
        throw new Error(
          `Missing or non-skill prerequisite: ${requirement.skillId}`,
        );
    }
  }
  return catalog;
}

export const planTargetSchema = z.union([
  z.string().trim().min(1).max(200),
  z.object({ typeId, level: skillLevel.optional() }).strict(),
]);
export type PlanTarget = z.infer<typeof planTargetSchema>;
export const targetListSchema = z.array(planTargetSchema).min(1).max(50);
export const ROMAN_LEVELS = ["", "I", "II", "III", "IV", "V"] as const;

export class SkillCatalog {
  readonly types: Map<number, StaticType>;
  private readonly names = new Map<string, StaticType[]>();
  constructor(readonly data: StaticCatalog) {
    this.data = validateCatalog(data);
    this.types = new Map(this.data.types.map((type) => [type.id, type]));
    for (const type of this.data.types) {
      if (!type.published) continue;
      const key = type.name.toLowerCase();
      this.names.set(key, [...(this.names.get(key) ?? []), type]);
    }
  }
  skill(
    id: number,
  ): StaticType & { requirements: Requirement[]; rank: number } {
    const type = this.types.get(id);
    if (type?.categoryId !== 16 || !type.requirements || type.rank === null)
      throw new Error(`Missing complete skill metadata for ${id}`);
    return type as StaticType & { requirements: Requirement[]; rank: number };
  }
  resolve(target: PlanTarget) {
    let level: number | undefined;
    let matches: StaticType[];
    let match = "id";
    if (typeof target === "string") {
      let name = target.trim().toLowerCase();
      matches = this.names.get(name) ?? [];
      // Exact names win, so a module such as "... II" is never mistaken for a skill level.
      if (!matches.length) {
        const suffix = /^(.*)\s+(i{1,3}|iv|v|[1-5])$/i.exec(name);
        if (suffix) {
          name = suffix[1] ?? "";
          level = /^\d$/.test(suffix[2] ?? "")
            ? Number(suffix[2])
            : ROMAN_LEVELS.indexOf(suffix[2]?.toUpperCase() as "I");
          matches = this.names.get(name) ?? [];
        }
      }
      match = "exact-name";
      if (!matches.length) {
        matches = (this.names.get(`${name}s`) ?? []).filter(
          (type) => type.categoryId === 16,
        );
        match = "singular-skill-name";
      }
      if (!matches.length)
        return {
          status: "unresolved" as const,
          input: target,
          candidates: this.search(name),
          message:
            "Choose an exact published skill or ship; no target was inferred.",
        };
    } else {
      level = target.level;
      const type = this.types.get(target.typeId);
      matches = type?.published ? [type] : [];
      if (!matches.length)
        return {
          status: "unresolved" as const,
          input: target,
          candidates: [],
          message:
            "No published skill or ship with this type ID exists in the cached SDE.",
        };
    }
    if (matches.length !== 1)
      return {
        status: "ambiguous" as const,
        input: target,
        candidates: matches.map((type) => ({
          typeId: type.id,
          name: type.name,
          categoryId: type.categoryId,
        })),
      };
    const type = matches[0];
    if (!type || ![6, 16].includes(type.categoryId))
      return {
        status: "unsupported" as const,
        input: target,
        message:
          "Select a skill or ship. Fit, rig, drone and module-use rules are outside this planner.",
      };
    if (type.requirements === null)
      throw new Error(`Missing requirement metadata for ${type.id}`);
    if (type.categoryId !== 16 && level !== undefined)
      throw new Error("Levels apply only to skill targets");
    const requirements =
      type.categoryId === 16
        ? [{ skillId: type.id, level: level ?? 1 }]
        : type.requirements;
    return {
      status: "resolved" as const,
      input: target,
      typeId: type.id,
      name: type.name,
      kind: type.categoryId === 16 ? "skill" : "ship",
      match,
      requirements,
    };
  }
  search(query: string) {
    return [...this.types.values()]
      .filter(
        (type) =>
          type.published &&
          [6, 16].includes(type.categoryId) &&
          type.name.toLowerCase().includes(query.toLowerCase()),
      )
      .sort((a, b) => a.id - b.id)
      .slice(0, 20)
      .map((type) => ({
        typeId: type.id,
        name: type.name,
        categoryId: type.categoryId,
      }));
  }
}
