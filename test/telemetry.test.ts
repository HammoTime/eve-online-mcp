import { afterEach, it, expect, vi } from "vitest";
import { context, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "node:http";
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
import {
  cancellationSignal,
  operationContext,
  withSpan,
} from "../lib/src/telemetry.js";
import { captureOptions } from "../lib/src/diagnostics.js";
import { fixtureSource, skillFixture } from "../lib/test/skill-fixtures.js";
import { EsiClient } from "../src/esi-client.js";
import { OperationCatalog } from "../src/openapi.js";
import { createEveServer } from "../lib/src/server.js";
import { fixtureDocument } from "./fixtures.js";
import { TelemetryRuntime } from "../lib/adapters/telemetry-runtime.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  context.disable();
});
it("writes private local artifacts, exports completion, and closes idempotently", async () => {
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

it("propagates isolated request cancellation without enabling telemetry and releases repeated initialization", async () => {
  const register = vi.spyOn(context, "setGlobalContextManager");
  const disable = vi.spyOn(context, "disable");
  const timer = vi.spyOn(globalThis, "setInterval");
  const sdk = vi.spyOn(TelemetryRuntime.prototype, "run");
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  const first = await localTelemetry({});
  const second = await localTelemetry({});
  expect(register).toHaveBeenCalledOnce();
  try {
    await Promise.all(
      [first, second].map(async (runtime) => {
        const abort = new AbortController();
        await runtime.run(() =>
          context.with(
            operationContext(ROOT_CONTEXT, new Set(), abort.signal),
            async () => {
              await new Promise<void>((resolve) => setImmediate(resolve));
              expect(cancellationSignal()).toBe(abort.signal);
              expect(captureOptions()).toBeUndefined();
              expect(
                trace.getTracer("test").startSpan("test").isRecording(),
              ).toBe(false);
            },
          ),
        );
      }),
    );
    const closing = first.close();
    expect(first.close()).toBe(closing);
    await closing;
    expect(disable).not.toHaveBeenCalled();
    const probe = ROOT_CONTEXT.setValue(Symbol(), true);
    expect(second.run(() => context.with(probe, () => context.active()))).toBe(
      probe,
    );
    await second.close();
    expect(disable).toHaveBeenCalledOnce();
    expect(context.with(probe, () => context.active())).not.toBe(probe);
    const third = await localTelemetry({});
    expect(register).toHaveBeenCalledTimes(2);
    await third.close();
    expect(timer).not.toHaveBeenCalled();
    expect(sdk).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

it.each(["existing", "replacement"] as const)(
  "does not disable an %s embedding context manager",
  async (mode) => {
    const external = new AsyncLocalStorageContextManager().enable();
    if (mode === "existing") context.setGlobalContextManager(external);
    const register = vi.spyOn(context, "setGlobalContextManager");
    const externalDisable = vi.spyOn(external, "disable");
    const runtime = await localTelemetry({});
    if (mode === "existing") expect(register).not.toHaveBeenCalled();
    else {
      context.disable();
      context.setGlobalContextManager(external);
    }
    await runtime.close();
    expect(externalDisable).not.toHaveBeenCalled();
    const probe = ROOT_CONTEXT.setValue(Symbol(), true);
    await context.with(probe, async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(context.active()).toBe(probe);
    });
  },
);

it("keeps an export-enabled runtime active when a default runtime closes", async () => {
  const first = await localTelemetry({});
  const register = vi.spyOn(context, "setGlobalContextManager");
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(() => Promise.resolve(new Response("{}"))),
  );
  const second = await localTelemetry({
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.test",
  });
  try {
    expect(register).not.toHaveBeenCalled();
    await first.close();
    await second.run(() =>
      withSpan("test.request", {}, async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(trace.getSpan(context.active())?.isRecording()).toBe(true);
        expect(captureOptions()).toBeDefined();
      }),
    );
  } finally {
    await first.close();
    await second.close();
  }
});

it("releases its context lease when export setup or shutdown fails", async () => {
  const badEnv = {
    get OTEL_EXPORTER_OTLP_ENDPOINT(): string {
      throw new Error("test setup failure");
    },
  };
  await expect(localTelemetry(badEnv)).rejects.toThrow("test setup failure");
  const probe = ROOT_CONTEXT.setValue(Symbol(), true);
  expect(context.with(probe, () => context.active())).not.toBe(probe);
  const runtime = await localTelemetry({
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.test",
  });
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with its runtime receiver below.
  const shutdown = TelemetryRuntime.prototype.shutdown;
  vi.spyOn(TelemetryRuntime.prototype, "shutdown").mockImplementationOnce(
    async function (this: TelemetryRuntime) {
      await shutdown.call(this);
      throw new Error("test shutdown failure");
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(() => Promise.resolve(new Response("{}"))),
  );
  await expect(runtime.close()).rejects.toThrow("test shutdown failure");
  expect(context.with(probe, () => context.active())).not.toBe(probe);
});

it("aborts a real ESI fetch on MCP cancellation with default telemetry disabled and no authentication", async () => {
  let requested = false;
  let disconnected = false;
  const upstream = createServer((_request, response) => {
    requested = true;
    response.on("close", () => {
      disconnected = true;
    });
    // Leave the response pending until cancellation closes the socket.
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test listener");
  const stdout = vi.spyOn(process.stdout, "write");
  const fetchMock = vi.fn<typeof fetch>(fetch);
  vi.stubGlobal("fetch", fetchMock);
  const runtime = await localTelemetry({});
  const getAccessToken = vi.fn<() => Promise<string | undefined>>();
  const catalog = new OperationCatalog(fixtureDocument());
  const esi = new EsiClient(
    catalog,
    { getAccessToken },
    {
      baseUrl: `http://127.0.0.1:${address.port}`,
      fetchImplementation: fetchMock,
    },
  );
  const server = runtime.run(() =>
    createEveServer(catalog, esi, {
      identity: { name: "test", version: "1" },
      staticData: fixtureSource(),
      protocolVersionHint: "2025-11-25",
    }),
  );
  const client = new Client({ name: "test", version: "1" });
  const [outbound, inbound] = InMemoryTransport.createLinkedPair();
  try {
    await runtime.run(() => server.connect(inbound));
    await client.connect(outbound);
    await outbound.send({
      jsonrpc: "2.0",
      id: 500,
      method: "tools/call",
      params: { name: "call_esi", arguments: { operationId: "GetStatus" } },
    });
    await vi.waitFor(() => {
      expect(requested).toBe(true);
    });
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    await outbound.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 500 },
    });
    await vi.waitFor(() => {
      expect(disconnected).toBe(true);
    });
    expect(signal?.aborted).toBe(true);
    await expect(fetchMock.mock.results[0]?.value).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("authorization"),
    ).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(stdout).not.toHaveBeenCalled();
  } finally {
    await client.close();
    await server.close();
    await runtime.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
});
