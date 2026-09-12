import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { context } from "@opentelemetry/api";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  opendir,
  lstat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { TelemetryRuntime } from "../lib/adapters/telemetry-runtime.js";
import { diagnostic } from "../lib/src/telemetry.js";
import { PACKAGE_VERSION } from "./package-metadata.js";
import type { ReplayManifest } from "../lib/src/diagnostics.js";

let ownedContext:
  { manager: AsyncLocalStorageContextManager; users: number } | undefined;

function acquireRequestContext(): () => void {
  const probe = context.active().setValue(Symbol(), true);
  const isGlobal = (manager: AsyncLocalStorageContextManager) =>
    manager.with(probe, () => context.active() === probe);
  let owned = ownedContext;
  if (!owned || !isGlobal(owned.manager)) {
    // Respect an embedding application's manager; do not attempt a duplicate
    // global registration (or unregister a manager we do not own).
    if (context.with(probe, () => context.active() === probe))
      return () => {
        /* The embedding application owns this manager. */
      };
    const manager = new AsyncLocalStorageContextManager().enable();
    if (!context.setGlobalContextManager(manager)) {
      manager.disable();
      return () => {
        /* Registration did not transfer ownership. */
      };
    }
    owned = { manager, users: 0 };
    ownedContext = owned;
  }
  owned.users++;
  const lease = owned;
  return () => {
    if (--lease.users !== 0) return;
    if (isGlobal(lease.manager)) context.disable();
    else lease.manager.disable();
    if (ownedContext === lease) ownedContext = undefined;
  };
}

export async function localTelemetry(env: NodeJS.ProcessEnv = process.env) {
  const release = acquireRequestContext();
  try {
    const runtime = await exportingTelemetry(env);
    let closing: Promise<void> | undefined;
    return {
      run: <T>(operation: () => T): T =>
        runtime ? runtime.run(operation) : operation(),
      close: () =>
        (closing ??= Promise.resolve()
          .then(() => runtime?.close())
          .finally(release)),
    };
  } catch (error) {
    release();
    throw error;
  }
}

export async function pruneLocalDiagnostics(
  directory: string,
  now = Date.now(),
) {
  for (const part of ["", "catalogs", "dependencies"]) {
    const path = join(directory, part);
    let entries;
    try {
      if (!(await lstat(path)).isDirectory()) continue;
      entries = await opendir(path);
    } catch {
      continue;
    }
    for await (const entry of entries) {
      if (
        !entry.isFile() ||
        !/^(?:[a-f0-9]{32}|[a-f0-9]{64})\.(?:json|pending)$/u.test(entry.name)
      )
        continue;
      const file = join(path, entry.name),
        info = await lstat(file);
      if (info.isFile() && now - info.mtimeMs > 14 * 86400000)
        await unlink(file);
    }
  }
}

async function exportingTelemetry(env: NodeJS.ProcessEnv) {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) return undefined;
  let versions = {
    server: PACKAGE_VERSION,
    library: "development",
    openapi: "development",
  };
  try {
    versions = JSON.parse(
      await readFile(
        new URL("../diagnostic-build.json", import.meta.url),
        "utf8",
      ),
    ) as typeof versions;
  } catch {
    /* Source execution has no release identity; captures stay partial. */
  }
  const directory = resolve(
    env.EVE_DIAGNOSTICS_DIR ??
      join(homedir(), ".eve-online-mcp", "diagnostics"),
  );
  const writes = new Set<Promise<void>>();
  await pruneLocalDiagnostics(directory).catch(() => {
    console.error('{"event":"diagnostic.retention_failed"}');
  });
  async function saveArtifact(
    body: string,
    prefix: "catalogs" | "dependencies",
  ) {
    if (Buffer.byteLength(body) > 8 * 1024 * 1024)
      throw new Error("Diagnostic artifact budget");
    const sha256 = createHash("sha256").update(body).digest("hex"),
      key = `${prefix}/${sha256}.json`;
    await mkdir(join(directory, prefix), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, key), body, { mode: 0o600 });
    return { sha256, key };
  }
  async function save(manifest: ReplayManifest): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!/^[a-f0-9]{32}$/u.test(manifest.traceId))
      throw new Error("Invalid diagnostic ID");
    const body = JSON.stringify(manifest),
      digest = createHash("sha256").update(body).digest("hex");
    const temporary = join(directory, `${manifest.traceId}.pending`),
      final = join(directory, `${manifest.traceId}.json`);
    await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
    await rename(temporary, final);
    diagnostic("diagnostic.capture_complete", {
      "eve.replay.artifact_id": manifest.traceId,
      "eve.replay.sha256": digest,
      "eve.replay.status": manifest.status,
    });
  }
  const runtime = new TelemetryRuntime({
    service: "eve-online-mcp",
    version: PACKAGE_VERSION,
    environment: env.OTEL_DEPLOYMENT_ENVIRONMENT ?? "local",
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    ...(env.OTEL_EXPORTER_OTLP_HEADERS
      ? { headers: env.OTEL_EXPORTER_OTLP_HEADERS }
      : {}),
    versions,
    failure: (reason) => {
      console.error(
        JSON.stringify({ event: "telemetry.delivery.failed", reason }),
      );
    },
    capture: {
      versions,
      save: (manifest) => {
        const write = save(manifest).catch(() => {
          diagnostic("diagnostic.capture_failed", {
            "eve.replay.failure": "local_write_failed",
          });
        });
        writes.add(write);
        void write.finally(() => writes.delete(write));
      },
      saveCatalog: (catalog) =>
        saveArtifact(JSON.stringify(catalog), "catalogs"),
      saveDependency: (body) => saveArtifact(body, "dependencies"),
    },
  });
  const timer = setInterval(() => {
    void runtime.flush();
  }, 5000);
  timer.unref();
  let closing: Promise<void> | undefined;
  return {
    run: <T>(operation: () => T) => runtime.run(operation),
    close: () => {
      closing ??= (async () => {
        clearInterval(timer);
        await Promise.all(writes);
        await runtime.shutdown();
      })();
      return closing;
    },
  };
}
