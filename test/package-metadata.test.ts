import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ESI_USER_AGENT,
  SCHEMA_CHECK_USER_AGENT,
} from "../src/package-metadata.js";

interface PackageMetadata {
  name: string;
  version: string;
}

describe("package User-Agents", () => {
  it("identifies the installed version, contact, and source repository", () => {
    const metadata = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as PackageMetadata;
    const contact =
      "adam@hammo.dev; +https://github.com/HammoTime/eve-online-mcp";

    expect(DEFAULT_ESI_USER_AGENT).toBe(
      `${metadata.name}/${metadata.version} (${contact})`,
    );
    expect(SCHEMA_CHECK_USER_AGENT).toBe(
      `${metadata.name}-schema-check/${metadata.version} (${contact})`,
    );
  });
});
