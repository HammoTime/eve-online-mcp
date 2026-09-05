import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  diffDocuments,
  documentHash,
} from "../src/schema-diff.js";
import { fixtureDocument } from "./fixtures.js";

describe("schema diff", () => {
  it("canonicalizes object key order", () => {
    const left = fixtureDocument();
    const right = JSON.parse(JSON.stringify(left)) as typeof left;
    right.info = { version: "2020-01-01", title: "Fixture ESI" };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(documentHash(left)).toBe(documentHash(right));
  });

  it("reports added, removed, and modified operations", () => {
    const before = fixtureDocument();
    const after = fixtureDocument();
    const statusOperation = after.paths["/status"]?.get;
    if (!statusOperation)
      throw new Error("Fixture status operation is missing");
    statusOperation.summary = "Changed";
    delete after.paths["/characters/{character_id}/assets"];
    after.paths["/new"] = { get: { operationId: "GetNew", summary: "New" } };
    expect(diffDocuments(before, after)).toMatchObject({
      changed: true,
      added: ["GET /new"],
      removed: [
        "GET /characters/{character_id}/assets",
        "POST /characters/{character_id}/assets",
      ],
      modified: ["GET /status"],
    });
  });
});
