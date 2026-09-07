import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OperationCatalog } from "../src/openapi.js";
import {
  renderSkillPlanGuidance,
  SKILL_PLAN_OPERATIONS,
} from "../src/skill-plan-guidance.js";
import type { OpenApiDocument } from "../src/types.js";

describe("skill-plan prompt guidance", () => {
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
