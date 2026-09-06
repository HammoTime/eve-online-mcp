import { describe, expect, it } from "vitest";
import {
  EVE_ACTIVITY_TYPES,
  renderActivityGuidance,
} from "../src/activity-guidance.js";

describe("activity guidance", () => {
  it("provides a concrete evidence playbook for every supported activity", () => {
    expect(EVE_ACTIVITY_TYPES).toEqual([
      "exploration",
      "factional_warfare",
      "mining",
      "industry",
      "trading",
      "hauling",
      "missions",
      "pve",
      "pvp",
    ]);

    const evidenceMarkers = {
      exploration: "current cosmic signatures",
      factional_warfare: "loyalty-point store offer catalogue",
      mining: "GetCharactersCharacterIdMining",
      industry: "GetCharactersCharacterIdBlueprints",
      trading: "GetCharactersCharacterIdOrders",
      hauling: "GetCharactersCharacterIdContracts",
      missions: "GetCharactersCharacterIdStandings",
      pve: "GetIncursions",
      pvp: "GetCharactersCharacterIdKillmailsRecent",
    } as const;

    for (const activity of EVE_ACTIVITY_TYPES) {
      const rendered = renderActivityGuidance(activity);
      expect(rendered).toContain("Clarify only material gaps:");
      expect(rendered).toContain("Evidence workflow:");
      expect(rendered).toContain("Turn evidence into advice:");
      expect(rendered).toContain("Limits and in-game checks:");
      expect(rendered).toContain(evidenceMarkers[activity]);
    }
  });
});
