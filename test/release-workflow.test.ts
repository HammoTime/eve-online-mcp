import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("release workflow", () => {
  it("publishes downloaded npm tarballs as unambiguous local paths", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).not.toContain("npm publish package-artifact/*.tgz");
    expect(
      workflow.match(/tarballs=\(package-artifact\/\*\.tgz\)/g),
    ).toHaveLength(3);
    expect(
      workflow.match(/npm publish "\.\/\$\{tarballs\[0\]\}"/g),
    ).toHaveLength(2);
  });
});
