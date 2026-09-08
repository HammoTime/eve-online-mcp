import { afterEach, it, expect, vi } from "vitest";
import { context, trace } from "@opentelemetry/api";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localTelemetry, pruneLocalDiagnostics } from "../src/telemetry.js";
import { withSpan } from "../lib/src/telemetry.js";
import { captureOptions } from "../lib/src/diagnostics.js";
import { skillFixture } from "../lib/test/skill-fixtures.js";

afterEach(() => {
  vi.unstubAllGlobals();
  context.disable();
});
it("writes private local artifacts, exports completion, and closes idempotently", async () => {
  expect(await localTelemetry({})).toBeUndefined();
  const directory = await mkdtemp(join(tmpdir(), "eve-telemetry-"));
  const sent: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (_url, init) => {
      sent.push(await new Response(init?.body).text());
      return new Response("{}");
    }),
  );
  const telemetry = await localTelemetry({
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.test",
    OTEL_EXPORTER_OTLP_HEADERS: "{}",
    EVE_DIAGNOSTICS_DIR: directory,
  });
  if (!telemetry) throw new Error("Missing local runtime");
  try {
    await telemetry.run(() =>
      withSpan("test.request", {}, async () => {
        const options = captureOptions();
        if (!options) throw new Error("Missing capture options");
        const catalog = await options.saveCatalog?.(skillFixture());
        expect(catalog?.key).toMatch(/^catalogs\//u);
        expect((await options.saveDependency?.("[]"))?.key).toMatch(
          /^dependencies\//u,
        );
        const traceId = trace.getSpan(context.active())?.spanContext().traceId;
        if (!traceId) throw new Error("Missing trace ID");
        options.save({
          schemaVersion: 1,
          policyVersion: 1,
          traceId,
          boundary: "mcp",
          status: "partial",
          reasons: ["missing_versions"],
          versions: options.versions,
          request: {
            method: "tools/call",
            tool: "initialize_static_data",
            arguments: {},
          },
          dependencies: [],
          catalogs: [],
          expected: {},
        });
      }),
    );
    const close = telemetry.close();
    expect(telemetry.close()).toBe(close);
    await close;
    const file = (await readdir(directory)).find((name) =>
      /^[a-f0-9]{32}\.json$/u.test(name),
    );
    expect(file).toBeDefined();
    expect(
      await readFile(join(directory, file ?? "missing"), "utf8"),
    ).toContain('"status":"partial"');
    expect(sent.join("")).toContain("diagnostic.capture_complete");
    expect(sent.join("")).toContain("explicitBounds");
    const old = join(directory, `${"a".repeat(32)}.json`),
      recent = join(directory, `${"b".repeat(32)}.json`),
      keep = join(directory, "operator-notes.txt");
    await Promise.all([
      writeFile(old, "{}"),
      writeFile(recent, "{}"),
      writeFile(keep, "notes"),
    ]);
    await utimes(old, 0, 0);
    await utimes(keep, 0, 0);
    await pruneLocalDiagnostics(directory);
    const names = await readdir(directory);
    expect(names).not.toContain(`${"a".repeat(32)}.json`);
    expect(names).toContain(`${"b".repeat(32)}.json`);
    expect(names).toContain("operator-notes.txt");
  } finally {
    await telemetry.close();
    await rm(directory, { recursive: true, force: true });
  }
});
