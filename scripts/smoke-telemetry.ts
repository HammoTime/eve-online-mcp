import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillFixture } from "../lib/test/skill-fixtures.js";

const sent: string[] = [];
const collector = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
  });
  request.on("end", () => {
    sent.push(body);
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
});
await new Promise<void>((resolve) => {
  collector.listen(0, "127.0.0.1", resolve);
});
const address = collector.address();
assert.ok(address && typeof address !== "string");
const directory = await mkdtemp(join(tmpdir(), "eve-stdio-telemetry-"));
const timeout = setTimeout(() => {
  console.error("Stdio telemetry smoke timed out");
  process.exit(1);
}, 90000);
try {
  const data = skillFixture();
  await mkdir(join(directory, "sde"));
  await writeFile(
    join(directory, "sde", "catalog-v1.json"),
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      etag: null,
      sha256: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
      catalog: data,
    }),
  );
  for (const mode of ["eof", "signal"] as const) {
    const child = spawn(process.execPath, ["dist/index.js"], {
      env: {
        ...process.env,
        EVE_DISABLE_AUTO_SSO: "1",
        EVE_SDE_CACHE_DIR: join(directory, "sde"),
        EVE_DIAGNOSTICS_DIR: join(directory, mode),
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
        OTEL_EXPORTER_OTLP_HEADERS: "{}",
      },
      stdio: "pipe",
    });
    const exited = new Promise<number | null>((resolve) =>
      child.once("exit", resolve),
    );
    const messages = new Map<number, Record<string, unknown>>();
    let buffered = "",
      errors = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      errors += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      for (;;) {
        const end = buffered.indexOf("\n");
        if (end < 0) break;
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        const message = JSON.parse(line) as Record<string, unknown>;
        if (typeof message.id === "number") messages.set(message.id, message);
      }
    });
    const request = async (
      id: number,
      method: string,
      params: Record<string, unknown>,
    ) => {
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
      for (let attempt = 0; attempt < 1500 && !messages.has(id); attempt++) {
        assert.equal(child.exitCode, null, `Server exited: ${errors}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const message = messages.get(id);
      assert.ok(message, `No response to ${method}: ${errors}`);
      return message;
    };
    try {
      await request(1, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "smoke", version: "1" },
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) + "\n",
      );
      const message = await request(2, "tools/call", {
        name: "get_skill_dependencies",
        arguments: { target: { typeId: 400 } },
      });
      const result = message.result as {
        isError?: boolean;
        _meta?: Record<string, string>;
      };
      assert.notEqual(result.isError, true);
      assert.match(result._meta?.["eve/trace-id"] ?? "", /^[a-f0-9]{32}$/u);
      if (mode === "eof") child.stdin.end();
      else child.kill("SIGTERM");
      assert.equal(await exited, 0);
      const files = await readdir(join(directory, mode));
      const capture = files.find((name) => /^[a-f0-9]{32}\.json$/u.test(name));
      assert.ok(capture, `No diagnostic capture on ${mode}`);
      const body = await readFile(join(directory, mode, capture), "utf8");
      assert.ok(body.includes("static_catalog"));
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
  const payload = sent.join("");
  for (const expected of [
    "tools/call get_skill_dependencies",
    "eve.input.target.typeId",
    "diagnostic.capture_complete",
    "explicitBounds",
  ])
    assert.ok(payload.includes(expected), `Missing ${expected}`);
  console.log(
    "Built stdio server exported correlated spans, logs, delta metrics and catalog artifacts on EOF and SIGTERM; stdout contained only JSON-RPC.",
  );
} finally {
  clearTimeout(timeout);
  await rm(directory, { recursive: true, force: true });
  await new Promise<void>((resolve, reject) => {
    collector.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
