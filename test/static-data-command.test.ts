import { describe, expect, it, vi } from "vitest";
import { runStaticDataCommand } from "../src/static-data-command.js";
import { fixtureSource } from "./skill-fixtures.js";

describe("operator static-data refresh", () => {
  it("does not initialize for ordinary MCP startup or invalid commands", async () => {
    const source = fixtureSource();
    const initialize = vi.spyOn(source, "initialize");
    expect(await runStaticDataCommand([], source)).toBe(false);
    await expect(
      runStaticDataCommand(["static-data", "unknown"], source),
    ).rejects.toThrow("Usage:");
    expect(initialize).not.toHaveBeenCalled();
  });
  it("forces a check and releases the snapshot even when output fails", async () => {
    const snapshot = await fixtureSource().initialize();
    const release = vi.fn();
    const source = {
      initialize: vi.fn(() => Promise.resolve({ ...snapshot, release })),
    };
    const write = vi.fn();
    expect(
      await runStaticDataCommand(["static-data", "refresh"], source, write),
    ).toBe(true);
    expect(source.initialize).toHaveBeenCalledWith(true);
    expect(write).toHaveBeenCalledWith(JSON.stringify(snapshot.status));
    expect(release).toHaveBeenCalledOnce();
    await expect(
      runStaticDataCommand(["static-data", "refresh"], source, () => {
        throw new Error("output failed");
      }),
    ).rejects.toThrow("output failed");
    expect(release).toHaveBeenCalledTimes(2);
  });
});
