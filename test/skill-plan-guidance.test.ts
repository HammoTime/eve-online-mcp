import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OperationCatalog } from "../src/openapi.js";
import {
  renderSkillPlanGuidance,
  SKILL_PLAN_OPERATIONS,
} from "../src/skill-plan-guidance.js";
import type { OpenApiDocument } from "../src/types.js";

describe("skill-plan prompt guidance", () => {
  it("delegates prerequisites and arithmetic to tools while preserving vague-goal interpretation", () => {
    const prompt = renderSkillPlanGuidance({
      character: "42",
      goal: "I want to fly Jump Freighters",
    });
    for (const tool of [
      "initialize_static_data",
      "resolve_skill_plan_targets",
      "get_skill_dependencies",
      "generate_skill_plan",
    ])
      expect(prompt).toContain(tool);
    expect(prompt).toContain("actual racial hull");
    expect(prompt).toContain("Do not reproduce any of these calculations");
    expect(prompt).toContain("do not emit an importable list");
    expect(prompt).toContain("trainingText unchanged");
    expect(prompt).toContain("time is not calculated");
  });
  it("preserves caller text as JSON data without changing fixed workflow guidance", () => {
    const request = {
      character: 'Pilot "Example"',
      goal: "Train hauling\nincluding a fit",
      constraints: 'Keep the queue; literal \\n and "quotes"',
    };
    const prompt = renderSkillPlanGuidance(request);
    const sections = prompt.split("\n\n");
    expect(JSON.parse(sections[2] ?? "")).toEqual({
      ...request,
      queuePolicy: "preserve",
    });
    const other = renderSkillPlanGuidance({
      character: "42",
      goal: "Exploration",
    });
    expect(sections.slice(3)).toEqual(other.split("\n\n").slice(3));
  });

  it("references only available read-only operations with the documented paths/scopes", () => {
    const document = JSON.parse(
      readFileSync(
        new URL("../openapi/esi-openapi.json", import.meta.url),
        "utf8",
      ),
    ) as OpenApiDocument;
    const catalog = new OperationCatalog(document);
    const expected = {
      type: ["type_id", []],
      group: ["group_id", []],
      dogmaAttribute: ["attribute_id", []],
      attributes: ["character_id", ["esi-skills.read_skills.v1"]],
      implants: ["character_id", ["esi-clones.read_implants.v1"]],
    } as const;
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
      const operation = catalog.get(SKILL_PLAN_OPERATIONS[key]);
      expect(operation.method).toBe("GET");
      expect(operation.parameters).toContainEqual(
        expect.objectContaining({
          in: "path",
          name: expected[key][0],
          required: true,
        }),
      );
      expect(operation.requiredScopes).toEqual(expected[key][1]);
    }
  });
});
