// Plain Node 22.13 JavaScript: this script travels with the tarball, not source
// dependencies. Typed ESLint covers the application; lint syntax-checks this file.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const toolNames = [
  "authorize_eve_character",
  "call_esi",
  "generate_skill_plan",
  "get_character_context",
  "get_esi_operation",
  "get_market_snapshot",
  "get_skill_dependencies",
  "initialize_static_data",
  "list_eve_characters",
  "render_eve_map",
  "resolve_eve_entities",
  "resolve_skill_plan_targets",
  "search_esi_operations",
  "select_eve_character",
];

function npm(args, options = {}) {
  // Invoke the npm shipped beside setup-node's executable, avoiding npm.cmd
  // shell quoting (especially Windows paths containing spaces).
  const cli = resolve(
    dirname(process.execPath),
    process.platform === "win32"
      ? "node_modules/npm/bin/npm-cli.js"
      : "../lib/node_modules/npm/bin/npm-cli.js",
  );
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 8_000_000,
    ...options,
  });
}

function environment(directory, install = false) {
  // Never inherit EVE/OTel tokens, NODE_OPTIONS, npm auth, proxy credentials,
  // personal home/config paths or a browser command from the invoking process.
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(SystemRoot|WINDIR|ComSpec|PATHEXT)$/iu.test(key),
      ),
    ),
    ...(install ? { PATH: dirname(process.execPath) } : {}),
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: directory,
    LOCALAPPDATA: directory,
    XDG_CONFIG_HOME: directory,
    XDG_CACHE_HOME: directory,
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
    NPM_CONFIG_USERCONFIG: join(directory, "npmrc"),
    NPM_CONFIG_GLOBALCONFIG: join(directory, "global-npmrc"),
    NPM_CONFIG_CACHE: join(directory, "npm-cache"),
    EVE_DISABLE_AUTO_SSO: "1",
    EVE_CREDENTIALS_PATH: join(directory, "credentials.json"),
    EVE_SDE_CACHE_DIR: join(directory, "sde"),
    EVE_MAP_ARTIFACT_DIR: join(directory, "maps"),
  };
}

async function prepare(artifact) {
  assert.deepEqual(await readdir(artifact), [], "Artifact must start empty");
  const manifest = await json("package.json");
  const revision = (directory) => {
    const git = (...args) =>
      execFileSync("git", ["-C", directory, ...args], {
        encoding: "utf8",
      }).trim();
    const sha = git("rev-parse", "HEAD");
    assert.match(sha, /^[a-f0-9]{40}$/u);
    return git("status", "--porcelain", "--untracked-files=normal")
      ? `${sha}-dirty`
      : sha;
  };
  const build = {
    server: revision("."),
    library: revision("lib"),
    openapi: sha256(await readFile("lib/openapi/esi-openapi.json")),
  };
  assert.deepEqual(await json("dist/diagnostic-build.json"), build);
  assert.equal((await json("dist/package.json")).version, manifest.version);
  const packs = JSON.parse(
    npm(["pack", "--ignore-scripts", "--json", "--pack-destination", artifact]),
  );
  assert.equal(packs.length, 1);
  const pack = packs[0];
  assert.equal(pack.name, "eve-online-mcp");
  assert.equal(pack.version, manifest.version);
  assert.match(pack.filename, /^eve-online-mcp-[\d.]+(?:-[\w.-]+)?\.tgz$/u);
  for (const { path } of pack.files) {
    assert.ok(
      /^(?:dist\/|package\.json$|README\.md$|LICENSE$)/u.test(path),
      `Unexpected packaged path: ${path}`,
    );
    assert.ok(
      !/(?:^|\/)(?:node_modules|test|coverage|\.env[^/]*|\.dev\.vars[^/]*)(?:\/|$)|\.(?:sqlite|tgz|zip)$/u.test(
        path,
      ),
      `Unsafe packaged path: ${path}`,
    );
  }
  await writeFile(
    join(artifact, "expected.json"),
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      build,
      filename: pack.filename,
      sha256: sha256(await readFile(join(artifact, pack.filename))),
    }),
  );
  await copyFile(
    fileURLToPath(import.meta.url),
    join(artifact, "smoke-package.mjs"),
  );
  console.log(
    `Packed ${manifest.name}@${manifest.version}; ${pack.files.length} reviewed package paths`,
  );
}

async function install(artifact, prefix) {
  const expected = await json(join(artifact, "expected.json"));
  assert.equal(expected.name, "eve-online-mcp");
  assert.match(expected.filename, /^eve-online-mcp-[\d.]+(?:-[\w.-]+)?\.tgz$/u);
  const tarball = join(artifact, expected.filename);
  assert.equal(sha256(await readFile(tarball)), expected.sha256);
  // mkdir without recursive/force prevents reusing an existing developer prefix.
  await mkdir(prefix);
  const home = join(prefix, "install-home");
  await mkdir(home);
  await writeFile(join(home, "npmrc"), "");
  await writeFile(join(home, "global-npmrc"), "");
  await writeFile(join(prefix, "package.json"), '{"private":true}');
  npm(
    [
      "install",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--omit=dev",
      "--no-save",
      "--package-lock=false",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
      tarball,
    ],
    { cwd: prefix, env: environment(home, true), stdio: "inherit" },
  );
}

// Preloaded before ANY application import. This is a regression tripwire, not
// an OS sandbox: Linux can additionally run the installed smoke with --network none.
async function offlineBootstrap() {
  const { syncBuiltinESMExports } = await import("node:module");
  const sqlite = (await import("node:sqlite")).default;
  const handles = new Set();
  let attempts = 0;
  const blocked = () => {
    attempts++;
    throw new Error("PACKAGE_SMOKE_BLOCKED_NETWORK_OR_BROWSER");
  };
  globalThis.fetch = blocked;
  globalThis.WebSocket = blocked;
  for (const [name, methods] of [
    ["node:http", ["request", "get"]],
    ["node:https", ["request", "get"]],
    ["node:net", ["connect", "createConnection"]],
    ["node:tls", ["connect"]],
    ["node:dgram", ["createSocket"]],
    [
      "node:child_process",
      [
        "spawn",
        "spawnSync",
        "exec",
        "execSync",
        "execFile",
        "execFileSync",
        "fork",
      ],
    ],
  ]) {
    const module = (await import(name)).default;
    for (const method of methods) module[method] = blocked;
  }
  const net = (await import("node:net")).default;
  net.Socket.prototype.connect = blocked;
  net.Server.prototype.listen = blocked;
  // Node 22.13 does not sync SQLite's named constructor export. All package
  // stores configure/query their connections, so observe the shared prototype.
  const prototype = sqlite.DatabaseSync.prototype;
  for (const name of ["exec", "prepare", "open"]) {
    const original = prototype[name];
    prototype[name] = function (...args) {
      const result = Reflect.apply(original, this, args);
      handles.add(this);
      return result;
    };
  }
  const close = prototype.close;
  prototype.close = function () {
    Reflect.apply(close, this, []);
    handles.delete(this);
  };
  syncBuiltinESMExports();
  process.on("exit", () => {
    if (attempts || handles.size) {
      console.error(
        `PACKAGE_SMOKE_GUARD attempts=${attempts} openDatabases=${handles.size}`,
      );
      process.exitCode = 1;
    }
  });
}

const preload = `data:text/javascript,${encodeURIComponent(`await (${offlineBootstrap.toString()})();`)}`;

async function checkGuard(directory) {
  for (const [source, code, marker] of [
    [
      'try { await fetch("https://network-must-not-run.invalid"); } catch {}',
      1,
      "attempts=1 openDatabases=0",
    ],
    [
      'const { DatabaseSync } = await import("node:sqlite"); const db = new DatabaseSync(":memory:"); db.exec("SELECT 1");',
      1,
      "attempts=0 openDatabases=1",
    ],
    [
      'const { DatabaseSync } = await import("node:sqlite"); const db = new DatabaseSync(":memory:"); db.exec("SELECT 1"); db.close();',
      0,
      undefined,
    ],
  ]) {
    const child = spawn(
      process.execPath,
      ["--import", preload, "--input-type=module", "--eval", source],
      {
        cwd: directory,
        env: environment(directory),
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      },
    );
    let stderr = "",
      stdout = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(
      exit,
      code,
      `Offline/SQLite guard self-check failed: ${stderr}`,
    );
    assert.equal(stdout, "");
    if (marker)
      assert.ok(stderr.includes(`PACKAGE_SMOKE_GUARD ${marker}`), stderr);
  }
}

async function fixtures(packagePath, directory) {
  const load = (path) =>
    import(pathToFileURL(join(packagePath, "dist", path)).href);
  const { SkillStore, skillBuildSourceUrl } = await load("src/skill-store.js");
  const { LocalMapStore } = await load("src/map-store.js");
  const { MapCatalog } = await load("lib/src/cartography/catalog.js");
  const checkedAt = new Date().toISOString();
  const metadata = {
    schemaVersion: 1,
    buildNumber: 123,
    releaseDate: "2026-09-01T00:00:00Z",
    fetchedAt: checkedAt,
    sourceUrl: skillBuildSourceUrl(123),
  };
  const sde = join(directory, "sde");
  await mkdir(sde);
  await writeFile(
    join(directory, "credentials.json"),
    '{"version":2,"characters":[]}',
  );
  const skills = new SkillStore(sde);
  assert.equal(
    skills.publish({
      catalog: {
        ...metadata,
        types: [
          {
            id: 100,
            name: "Smoke Mining",
            groupId: 10,
            categoryId: 16,
            rank: 1,
            published: true,
            requirements: [],
          },
          {
            id: 200,
            name: "Smoke Exhumers",
            groupId: 10,
            categoryId: 16,
            rank: 1,
            published: true,
            requirements: [{ skillId: 100, level: 2 }],
          },
          {
            id: 400,
            name: "Smoke Hull",
            groupId: 20,
            categoryId: 6,
            rank: null,
            published: true,
            requirements: [{ skillId: 200, level: 1 }],
          },
        ],
      },
      checkedAt,
      etag: null,
    }).accepted,
    true,
  );
  const snapshot = skills.acquire();
  try {
    assert.equal(snapshot.catalog.getType(400).name, "Smoke Hull");
    assert.equal(snapshot.saved.metadata.typeCount, 3);
  } finally {
    snapshot.release();
  }
  assert.throws(() => snapshot.catalog.getType(400), /closed/u);
  new LocalMapStore(sde).publish(
    new MapCatalog({
      ...metadata,
      regions: [{ id: 1000, name: "Smoke Region" }],
      constellations: [
        { id: 2000, name: "Smoke Constellation", regionId: 1000 },
      ],
      systems: [
        "Smoke Alpha",
        "Smoke Beta",
        "Smoke Gamma",
        "Smoke Outside",
      ].map((name, index) => ({
        id: index + 1,
        name,
        regionId: 1000,
        constellationId: 2000,
        position: {
          x: index * 9_460_730_472_580_800,
          y: 0,
          z: (index % 2) * 9_460_730_472_580_800,
        },
        position2D: { x: index, y: index % 2 },
        securityStatus: 0.5,
      })),
      gates: [
        { id: 10, systemId: 1, destinationId: 2, destinationGateId: 11 },
        { id: 11, systemId: 2, destinationId: 1, destinationGateId: 10 },
        { id: 12, systemId: 3, destinationId: 1, destinationGateId: 13 },
        { id: 14, systemId: 2, destinationId: 4, destinationGateId: 15 },
      ],
    }),
    {
      checkedAt,
      etag: null,
      archiveSha256: sha256(
        "synthetic smoke fixture, not a downloaded archive",
      ),
    },
  );
}

async function stdio(
  packagePath,
  directory,
  expected,
  preload,
  previousArtifact,
) {
  const child = spawn(
    process.execPath,
    ["--import", preload, join(packagePath, "dist/index.js")],
    {
      cwd: directory,
      env: environment(directory),
      stdio: "pipe",
    },
  );
  let closed = false;
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });
  // Attach immediately, including while awaiting an MCP response.
  let failure;
  void exited.catch((error) => {
    failure = error;
  });
  child.stdin.on("error", (error) => {
    failure = error;
  });
  const messages = new Map();
  let buffer = "",
    stderr = "",
    id = 0,
    bytes = 0;
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > 64_000) {
      failure = new Error("Unbounded server stderr");
      child.kill();
    }
  });
  child.stdout.on("data", (chunk) => {
    try {
      assert.ok(
        (bytes += Buffer.byteLength(chunk)) <= 20_000_000,
        "Unbounded server stdout",
      );
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        assert.equal(
          message.jsonrpc,
          "2.0",
          "stdout must contain only JSON-RPC",
        );
        assert.ok(
          Number.isInteger(message.id),
          "Unexpected stdout notification",
        );
        assert.ok(
          message.id > 0 && message.id <= id && !messages.has(message.id),
        );
        messages.set(message.id, message);
      }
    } catch (error) {
      failure = error;
      child.kill();
    }
  });
  const request = async (method, params) => {
    const current = ++id;
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: current, method, params }) + "\n",
    );
    const deadline = Date.now() + 30_000;
    while (!messages.has(current)) {
      if (failure) throw failure;
      assert.ok(!closed, `Server exited during ${method}: ${stderr}`);
      assert.ok(Date.now() < deadline, `Timed out during ${method}: ${stderr}`);
      await delay(10);
    }
    const message = messages.get(current);
    assert.equal(message.error, undefined, JSON.stringify(message.error));
    assert.ok(message.result);
    return message.result;
  };
  const call = async (name, args = {}, isError = false) => {
    const result = await request("tools/call", { name, arguments: args });
    assert.equal(
      result.isError === true,
      isError,
      `${name}: ${JSON.stringify(result.structuredContent)}`,
    );
    assert.ok(
      result.structuredContent && !Array.isArray(result.structuredContent),
    );
    assert.deepEqual(
      JSON.parse(result.content.find((part) => part.type === "text").text),
      result.structuredContent,
    );
    return result;
  };
  const readSvg = async (uri) => {
    const result = await request("resources/read", { uri });
    assert.equal(result.contents.length, 1);
    assert.equal(result.contents[0].mimeType, "image/svg+xml");
    const svg = result.contents[0].text;
    assert.match(svg, /<svg\b/u);
    for (const name of ["Smoke Alpha", "Smoke Beta", "Smoke Gamma"])
      assert.ok(svg.includes(name));
    assert.ok(
      !svg.includes("Smoke Outside"),
      "Neighborhood must exclude two-hop systems",
    );
    return svg;
  };
  let artifact;
  try {
    const init = await request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "package-runtime-acceptance", version: "1" },
    });
    assert.deepEqual(init.serverInfo, {
      name: expected.name,
      version: expected.version,
    });
    assert.equal(init.protocolVersion, "2025-11-25");
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
    const listed = await request("tools/list", {});
    assert.equal(listed.nextCursor, undefined);
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), toolNames);
    for (const tool of listed.tools) {
      assert.equal(tool.inputSchema.type, "object", `${tool.name} input root`);
      assert.equal(
        tool.outputSchema.type,
        "object",
        `${tool.name} output root`,
      );
    }
    const characters = (await call("list_eve_characters")).structuredContent;
    assert.deepEqual(characters.characters, []);
    assert.equal(characters.defaultCharacterId, null);
    assert.equal(characters.legacyCredentialPendingMigration, false);
    const status = (await call("initialize_static_data")).structuredContent;
    assert.equal(status.buildNumber, 123);
    assert.equal(status.typeCount, 3);
    assert.equal(status.skillCount, 2);
    assert.equal(status.stale, false);
    assert.equal(status.warning, undefined);
    if (previousArtifact)
      assert.equal(
        sha256(await readSvg(previousArtifact.uri)),
        previousArtifact.sha256,
      );
    for (let repeat = 0; repeat < 3; repeat++) {
      const resolved = (
        await call("resolve_skill_plan_targets", {
          targets: [" smoke hull ", "Smoke Mining II"],
        })
      ).structuredContent;
      assert.deepEqual(
        resolved.targets.map(({ status, typeId }) => ({ status, typeId })),
        [
          { status: "resolved", typeId: 400 },
          { status: "resolved", typeId: 100 },
        ],
      );
      assert.deepEqual(resolved.targets[1].requirements, [
        { skillId: 100, level: 2 },
      ]);
      const dependencies = (
        await call("get_skill_dependencies", { target: { typeId: 400 } })
      ).structuredContent;
      assert.equal(dependencies.status, "complete");
      assert.equal(dependencies.staticData.stale, false);
      assert.deepEqual(
        dependencies.graph.nodes.map(({ key }) => key),
        ["100:1", "100:2", "200:1"],
      );
      assert.deepEqual(dependencies.graph.edges, [
        { from: "100:1", to: "100:2" },
        { from: "100:2", to: "200:1" },
      ]);
      const map = await call("render_eve_map", {
        boundary: { kind: "neighborhood", center: "Smoke Alpha", jumps: 1 },
        pointsOfInterest: [],
        layout: "geographic",
        preview: "png",
      });
      const result = map.structuredContent;
      assert.equal(result.status, "ready");
      assert.equal(
        result.preview.status,
        "ready",
        "Native resvg PNG must load without install scripts",
      );
      assert.equal(result.summary.systemCount, 3);
      assert.equal(result.summary.edgeCount, 2);
      assert.equal(result.completeness.boundaryConnections, 1);
      assert.equal(result.sources.staticData.stale, false);
      assert.deepEqual(
        result.warnings.map(({ code }) => code),
        ["CALLER_SUPPLIED_PLANS", "BOUNDARY_CONNECTIONS"],
      );
      const png = Buffer.from(
        map.content.find(
          (part) => part.type === "image" && part.mimeType === "image/png",
        ).data,
        "base64",
      );
      assert.deepEqual(
        png.subarray(0, 8),
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      assert.equal(png.readUInt32BE(16), result.preview.width);
      assert.equal(png.readUInt32BE(20), result.preview.height);
      const svg = await readSvg(result.artifact.uri);
      artifact = { uri: result.artifact.uri, sha256: sha256(svg) };
    }
    const unknown = await call(
      "call_esi",
      { operationId: "not_a_real_operation" },
      true,
    );
    assert.equal(unknown.structuredContent.code, "UNKNOWN_OPERATION");
    const operation = (
      await call("get_esi_operation", {
        operationId: "GetCharactersCharacterIdSkills",
      })
    ).structuredContent;
    assert.equal(operation.method, "GET");
    assert.equal(operation.path, "/characters/{character_id}/skills");
    assert.equal(operation.authenticated, true);
    const protectedCall = await call(
      "call_esi",
      {
        operationId: operation.operationId,
        path: { character_id: 90000001 },
      },
      true,
    );
    assert.equal(
      protectedCall.structuredContent.code,
      "AUTHENTICATION_REQUIRED",
    );
    child.stdin.end();
    const deadline = Date.now() + 10_000;
    while (!closed && Date.now() < deadline) await delay(10);
    assert.ok(
      closed,
      "EOF shutdown must release handles without forced termination",
    );
    assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
    if (failure) throw failure;
    assert.equal(buffer, "", "No unterminated stdout diagnostics");
    // Node 22.13 legitimately reports experimental SQLite on stderr only.
    for (const line of stderr.split(/\r?\n/u).filter(Boolean)) {
      assert.match(
        line,
        /^(?:\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time|\(Use .+--trace-warnings.+ to show where the warning was created\))$/u,
      );
    }
    return artifact;
  } finally {
    if (!closed) child.kill("SIGKILL");
    await exited;
  }
}

async function run(artifact, prefix, nodeVersion) {
  assert.equal(
    process.versions.node,
    nodeVersion,
    "Use the exact matrix runtime",
  );
  const expected = await json(join(artifact, "expected.json"));
  const packagePath = join(prefix, "node_modules", "eve-online-mcp");
  const manifest = await json(join(packagePath, "package.json"));
  assert.equal(manifest.name, expected.name);
  assert.equal(manifest.version, expected.version);
  assert.equal(
    (await json(join(packagePath, "dist/package.json"))).version,
    expected.version,
  );
  assert.deepEqual(
    await json(join(packagePath, "dist/diagnostic-build.json")),
    expected.build,
  );
  assert.equal(
    sha256(
      await readFile(join(packagePath, "dist/lib/openapi/esi-openapi.json")),
    ),
    expected.build.openapi,
  );
  for (const name of [
    "tsx",
    "typescript",
    "vitest",
    "eslint",
    "@modelcontextprotocol/client",
  ]) {
    for (const root of [prefix, packagePath]) {
      await assert.rejects(access(join(root, "node_modules", name)), {
        code: "ENOENT",
      });
    }
  }
  const directory = await mkdtemp(join(prefix, "runtime fixture with spaces-"));
  try {
    await checkGuard(directory);
    // Fixture imports are guarded and credential-isolated too, not just stdio.
    assert.equal(
      execFileSync(
        process.execPath,
        [
          "--import",
          preload,
          fileURLToPath(import.meta.url),
          "fixtures",
          packagePath,
          directory,
        ],
        {
          cwd: directory,
          env: environment(directory),
          encoding: "utf8",
          timeout: 30_000,
          stdio: ["ignore", "pipe", "inherit"],
        },
      ),
      "",
    );
    const first = await stdio(packagePath, directory, expected, preload);
    await stdio(packagePath, directory, expected, preload, first);
    assert.deepEqual(await json(join(directory, "credentials.json")), {
      version: 2,
      characters: [],
    });
  } finally {
    // No retries: Windows must permit immediate deletion after graceful exit,
    // and parent fixture readers must also have closed their SQLite handles.
    await rm(directory, { recursive: true });
  }
  await assert.rejects(access(directory), { code: "ENOENT" });
  console.log(
    `Package acceptance passed: ${expected.name}@${expected.version}, ${process.platform}/${process.arch}, Node ${process.versions.node}; 14 tool schemas, SQLite queries, PNG/SVG, restart, offline guard and immediate cleanup`,
  );
}

const [command, artifactArgument, prefixArgument, nodeVersion] =
  process.argv.slice(2);
assert.ok(
  artifactArgument,
  "Usage: smoke-package.mjs prepare ARTIFACT | install ARTIFACT PREFIX | run ARTIFACT PREFIX NODE_VERSION",
);
const artifact = resolve(artifactArgument);
if (command === "prepare") await prepare(artifact);
else if (command === "check-guard") await checkGuard(artifact);
else {
  assert.ok(prefixArgument, "An isolated temporary install prefix is required");
  const prefix = resolve(prefixArgument);
  if (command === "fixtures") await fixtures(artifact, prefix);
  else if (command === "install") await install(artifact, prefix);
  else if (command === "run") await run(artifact, prefix, nodeVersion);
  else throw new Error("Unknown package smoke command");
}
