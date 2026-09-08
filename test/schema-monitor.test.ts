import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

interface Call {
  args: string[];
  body?: string;
}
interface Reply {
  stdout?: string;
  code?: number;
}
async function report(
  replies: Reply[],
  body = "The upstream schema changed.\n\n`GET /status` and literal $(example).",
) {
  const directory = await mkdtemp(join(tmpdir(), "eve-schema-monitor-"));
  directories.push(directory);
  const log = join(directory, "calls.jsonl");
  await writeFile(
    join(directory, "gh"),
    `#!/usr/bin/env node
import { readFileSync, appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const log = process.env.MOCK_LOG;
let previous = [];
try { previous = readFileSync(log,"utf8").trim().split("\\n"); } catch {}
const bodyIndex = args.indexOf("--body-file");
const call = {args, ...(bodyIndex < 0 ? {} : {body: readFileSync(args[bodyIndex+1],"utf8")})};
appendFileSync(log,JSON.stringify(call)+"\\n");
const reply = JSON.parse(process.env.MOCK_REPLIES)[previous.length];
if (!reply) process.exit(99);
process.stdout.write(reply.stdout ?? "");
process.exit(reply.code ?? 0);
`,
    { mode: 0o755 },
  );
  let failed = false;
  try {
    await execute(
      "bash",
      [
        fileURLToPath(
          new URL("../scripts/report-schema-change.sh", import.meta.url),
        ),
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          GH_TOKEN: "test-only",
          ISSUE_BODY: body,
          MOCK_LOG: log,
          MOCK_REPLIES: JSON.stringify(replies),
        },
      },
    );
  } catch {
    failed = true;
  }
  const calls = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Call);
  return { calls, failed, body };
}

describe("schema issue reporting", () => {
  it("creates an issue in the explicit consumer repository from outside a checkout", async () => {
    const result = await report([
      { stdout: "" },
      { stdout: "https://github.com/HammoTime/eve-online-mcp/issues/1" },
    ]);
    expect(result.failed).toBe(false);
    expect(result.calls[0]?.args).toEqual([
      "api",
      "--paginate",
      "repos/HammoTime/eve-online-mcp/issues?state=open&per_page=100&sort=created&direction=asc",
      "--jq",
      '.[] | select(.pull_request == null and .title == "ESI OpenAPI schema update required") | .number',
    ]);
    expect(result.calls[1]?.args.slice(0, 6)).toEqual([
      "issue",
      "create",
      "--repo",
      "HammoTime/eve-online-mcp",
      "--title",
      "ESI OpenAPI schema update required",
    ]);
    expect(result.calls[1]?.body).toBe(result.body);
  });
  it("updates the oldest matching open issue without adding a comment", async () => {
    const result = await report([
      { stdout: "12\n25\n" },
      { stdout: "Older diff" },
      {},
    ]);
    expect(result.failed).toBe(false);
    expect(result.calls[1]?.args).toEqual([
      "issue",
      "view",
      "12",
      "--repo",
      "HammoTime/eve-online-mcp",
      "--json",
      "body",
      "--jq",
      ".body",
    ]);
    expect(result.calls[2]?.args.slice(0, 5)).toEqual([
      "issue",
      "edit",
      "12",
      "--repo",
      "HammoTime/eve-online-mcp",
    ]);
    expect(result.calls[2]?.body).toBe(result.body);
  });
  it("makes no write for an identical repeated detection", async () => {
    const body = "Same diff\n\nSame hashes";
    const result = await report(
      [{ stdout: "12\n" }, { stdout: body + "\n" }],
      body,
    );
    expect(result.failed).toBe(false);
    expect(result.calls).toHaveLength(2);
  });
  it.each([[{ code: 1 }], [{ stdout: "12\n" }, { code: 1 }]])(
    "does not create duplicates when GitHub lookup fails %#",
    async (...replies) => {
      const result = await report(replies);
      expect(result.failed).toBe(true);
      expect(
        result.calls.every(
          (call) =>
            !call.args.includes("create") && !call.args.includes("edit"),
        ),
      ).toBe(true);
    },
  );
});
