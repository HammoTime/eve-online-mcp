import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  withSdeArchive,
  type SdeArchiveOptions,
} from "../src/sde-archive-cache.js";

const directories: string[] = [];
const children: ChildProcess[] = [];
const releaseDate = "2026-09-01T00:00:00Z";
const unavailable = "Shared SDE archive is unavailable";
const digest = (body: string) =>
  createHash("sha256").update(body).digest("hex");
const source = (buildNumber = 123) => ({
  buildNumber,
  releaseDate,
  sourceUrl: `https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-${buildNumber}-jsonl.zip`,
});
function deferred<T = undefined>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "eve-shared-archive-"));
  directories.push(directory);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(new Response("archive")));
  const options: SdeArchiveOptions = {
    directory,
    source: source(),
    fetchImplementation: fetcher,
    userAgent: "test public SDE",
    maxArchiveBytes: 100,
  };
  return { directory, options, fetcher };
}
async function consume(path: string, sha256: string) {
  const content = await readFile(path, "utf8");
  expect(digest(content)).toBe(sha256);
  return { path, sha256, content };
}
function sql(directory: string, operation: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(
    join(directory, "sde-archives-v1", "index.sqlite"),
  );
  try {
    operation(db);
  } finally {
    db.close();
  }
}
async function zips(directory: string) {
  return (await readdir(join(directory, "sde-archives-v1")))
    .filter((name) => name.endsWith(".zip"))
    .sort();
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once("exit", () => {
          resolve();
        });
        child.kill("SIGKILL");
      });
    }),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("bounded shared CCP archive", () => {
  it("shares a simultaneous download, allows simultaneous readers, and retains it for sequential/restarted consumers", async () => {
    const { options, fetcher, directory } = await setup();
    const response = deferred<Response>();
    const started = deferred();
    const readers = deferred();
    let count = 0;
    fetcher.mockImplementationOnce(() => {
      started.resolve(undefined);
      return response.promise;
    });
    const callback = async (path: string, sha256: string) => {
      if (++count === 2) readers.resolve(undefined);
      await readers.promise;
      return consume(path, sha256);
    };
    const first = withSdeArchive(options, callback);
    await started.promise;
    const second = withSdeArchive({ ...options }, callback);
    response.resolve(new Response("archive"));
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(results[1]);
    expect(
      await withSdeArchive(
        { ...options, now: () => Number.MAX_SAFE_INTEGER },
        consume,
      ),
    ).toEqual(results[0]);
    expect(await zips(directory)).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(source().sourceUrl, {
      headers: { "User-Agent": "test public SDE" },
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });
  it("pins a reader's exact path through a newer build and fails quota rather than evicting active readers", async () => {
    const { options, directory, fetcher } = await setup();
    const started = deferred<string>();
    const finish = deferred();
    const old = withSdeArchive(options, async (path, sha256) => {
      started.resolve(path);
      await finish.promise;
      return consume(path, sha256);
    });
    const path = await started.promise;
    fetcher.mockResolvedValueOnce(new Response("new"));
    const next = await withSdeArchive(
      { ...options, source: source(124) },
      consume,
    );
    expect(next.path).not.toBe(path);
    expect(await readFile(path, "utf8")).toBe("archive");
    expect(await zips(directory)).toHaveLength(2);
    await expect(
      withSdeArchive({ ...options, source: source(125) }, consume),
    ).rejects.toThrow(unavailable);
    expect(fetcher).toHaveBeenCalledTimes(2);
    finish.resolve(undefined);
    await old;
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await zips(directory)).toHaveLength(1);
    await expect(withSdeArchive(options, consume)).rejects.toThrow(unavailable);
    await withSdeArchive({ ...options, source: source(125) }, consume);
    expect(await zips(directory)).toHaveLength(1);
  });
  it("does not replace a newer completed build when an older download finishes late", async () => {
    const { options, fetcher, directory } = await setup();
    const response = deferred<Response>();
    const started = deferred();
    fetcher.mockImplementationOnce(() => {
      started.resolve(undefined);
      return response.promise;
    });
    const old = withSdeArchive(options, consume);
    await started.promise;
    await withSdeArchive({ ...options, source: source(124) }, consume);
    response.resolve(new Response("older"));
    expect((await old).content).toBe("older");
    expect(await zips(directory)).toHaveLength(1);
    expect(
      (await withSdeArchive({ ...options, source: source(124) }, consume))
        .content,
    ).toBe("archive");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("retains complete bytes on callback failure, releases readers and does not touch legacy or unrelated files", async () => {
    const { options, directory, fetcher } = await setup();
    const sentinels = [
      "map-sde-123-legacy.zip",
      "map-catalog-v1.json",
      "sde-jsonl.zip",
      "catalog-v1.json",
      "credentials.json",
    ];
    for (const name of sentinels)
      await writeFile(join(directory, name), "sentinel");
    await expect(
      withSdeArchive(options, () => {
        throw new Error("PRIVATE callback details");
      }),
    ).rejects.toThrow(unavailable);
    const result = await withSdeArchive(options, consume);
    expect(result.content).toBe("archive");
    expect(fetcher).toHaveBeenCalledTimes(1);
    sql(directory, (db) => {
      expect(db.prepare("SELECT readers FROM archives").get()?.readers).toBe(0);
    });
    expect(await readdir(join(directory, "sde-archives-v1"))).toEqual(
      expect.arrayContaining(["index.sqlite", "archive-0.zip"]),
    );
    for (const name of sentinels)
      expect(await readFile(join(directory, name), "utf8")).toBe("sentinel");
  });
  it.each([0, -1, NaN, Infinity, 0.5, 256_000_001])(
    "rejects unsafe maxArchiveBytes %s before filesystem or fetch",
    async (maxArchiveBytes) => {
      const { options, fetcher, directory } = await setup();
      await expect(
        withSdeArchive({ ...options, maxArchiveBytes }, consume),
      ).rejects.toThrow(unavailable);
      expect(fetcher).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual([]);
    },
  );
  it.each([
    { buildNumber: 0 },
    { buildNumber: 1.5 },
    { releaseDate: "PRIVATE" },
    { sourceUrl: "https://example.invalid/PRIVATE" },
    { sourceUrl: `${source().sourceUrl}?token=PRIVATE` },
  ])("rejects untrusted source identity %#", async (changed) => {
    const { options, fetcher } = await setup();
    await expect(
      withSdeArchive(
        { ...options, source: { ...source(), ...changed } },
        consume,
      ),
    ).rejects.toThrow(unavailable);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("snapshots source identity before awaiting and rejects conflicting release metadata without refetch", async () => {
    const { options, fetcher } = await setup();
    const request = withSdeArchive(options, consume);
    options.source.sourceUrl = "https://example.invalid/PRIVATE";
    await request;
    expect(fetcher.mock.calls[0]?.[0]).toBe(source().sourceUrl);
    await expect(
      withSdeArchive(
        {
          ...options,
          source: { ...source(), releaseDate: "2026-09-02T00:00:00Z" },
        },
        consume,
      ),
    ).rejects.toThrow(unavailable);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    () => new Response(null),
    () => new Response("PRIVATE", { status: 500 }),
    () => new Response("x", { headers: { "content-length": "5" } }),
    () => new Response("x", { headers: { "content-length": "NaN" } }),
    () => new Response(""),
    () => new Response("large", { headers: { "content-length": "1" } }),
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(3));
            controller.enqueue(new Uint8Array(3));
            controller.close();
          },
        }),
      ),
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("PRIVATE body failure"));
          },
        }),
      ),
  ])(
    "bounds downloads before writes and removes failed spools %#",
    async (response) => {
      const { options, fetcher, directory } = await setup();
      const callback = vi.fn(consume);
      fetcher.mockResolvedValueOnce(response());
      await expect(
        withSdeArchive({ ...options, maxArchiveBytes: 4 }, callback),
      ).rejects.toThrow(unavailable);
      expect(callback).not.toHaveBeenCalled();
      expect(await zips(directory)).toEqual([]);
      sql(directory, (db) => {
        expect(
          db.prepare("SELECT count(*) AS count FROM archives").get()?.count,
        ).toBe(0);
      });
      await withSdeArchive(options, consume);
    },
  );
  it("enforces each waiter's tighter limit even when another consumer already retained the archive", async () => {
    const { options, fetcher } = await setup();
    await withSdeArchive(options, consume);
    await expect(
      withSdeArchive({ ...options, maxArchiveBytes: 4 }, consume),
    ).rejects.toThrow(unavailable);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("never overwrites or removes a slot file with no reservation", async () => {
    const { options, directory, fetcher } = await setup();
    await withSdeArchive(options, consume);
    const path = join(directory, "sde-archives-v1", "archive-1.zip");
    await writeFile(path, "unowned sentinel");
    await expect(
      withSdeArchive({ ...options, source: source(124) }, consume),
    ).rejects.toThrow(unavailable);
    expect(await readFile(path, "utf8")).toBe("unowned sentinel");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not write an over-limit chunk or grow reservations when partial-spool cleanup fails", async () => {
    const { options, directory, fetcher } = await setup();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    fetcher.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(value) {
            controller = value;
            controller.enqueue(new Uint8Array([1, 2, 3]));
          },
        }),
      ),
    );
    const pending = expect(
      withSdeArchive({ ...options, maxArchiveBytes: 4 }, consume),
    ).rejects.toThrow(unavailable);
    const cache = join(directory, "sde-archives-v1");
    const path = join(cache, "archive-0.zip");
    await vi.waitFor(async () => {
      expect(await readFile(path)).toEqual(Buffer.from([1, 2, 3]));
    });
    await chmod(cache, 0o500);
    try {
      controller.enqueue(new Uint8Array([4, 5, 6]));
      await pending;
      expect(await readFile(path)).toEqual(Buffer.from([1, 2, 3]));
    } finally {
      await chmod(cache, 0o700);
    }
    await withSdeArchive({ ...options, source: source(124) }, consume);
    await expect(
      withSdeArchive({ ...options, source: source(125) }, consume),
    ).rejects.toThrow(unavailable);
    expect(await zips(directory)).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("fences late publication and cleanup if the download reservation token changed", async () => {
    const { options, directory, fetcher } = await setup();
    const response = deferred<Response>();
    const started = deferred();
    fetcher.mockImplementationOnce(() => {
      started.resolve(undefined);
      return response.promise;
    });
    const callback = vi.fn(consume);
    const pending = expect(withSdeArchive(options, callback)).rejects.toThrow(
      unavailable,
    );
    await started.promise;
    sql(directory, (db) => {
      db.prepare("UPDATE archives SET token = ?").run(
        "00000000-0000-4000-8000-000000000000",
      );
    });
    response.resolve(new Response("archive"));
    await pending;
    expect(callback).not.toHaveBeenCalled();
    expect(await zips(directory)).toHaveLength(1);
    sql(directory, (db) => {
      expect(db.prepare("SELECT sha256, readers FROM archives").get()).toEqual({
        sha256: null,
        readers: 0,
      });
    });
  });
  it("bounds abandoned initialization waits without creating more files or reclaiming ownership", async () => {
    const { options, directory, fetcher } = await setup();
    await mkdir(join(directory, "sde-archives-v1.init"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (let attempt = 0; attempt < 2; attempt++) {
      const pending = expect(withSdeArchive(options, consume)).rejects.toThrow(
        unavailable,
      );
      await vi.advanceTimersByTimeAsync(180_000);
      await pending;
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual(["sde-archives-v1.init"]);
    expect(await readdir(join(directory, "sde-archives-v1.init"))).toEqual([]);
  });
  it.each(["same-size", "larger", "missing"])(
    "fails closed on %s archive corruption without downloading replacement bytes",
    async (kind) => {
      const { options, fetcher } = await setup();
      const { path } = await withSdeArchive(options, consume);
      if (kind === "same-size") await writeFile(path, "corrupt");
      if (kind === "larger") await truncate(path, 101);
      if (kind === "missing") await rm(path);
      const callback = vi.fn(consume);
      await expect(withSdeArchive(options, callback)).rejects.toThrow(
        unavailable,
      );
      expect(callback).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["future", "schema", "metadata", "nul", "empty", "corrupt"])(
    "leaves unknown/corrupt %s stores untouched and unavailable",
    async (kind) => {
      const { options, directory, fetcher } = await setup();
      await withSdeArchive(options, consume);
      const path = join(directory, "sde-archives-v1", "index.sqlite");
      if (kind === "empty" || kind === "corrupt")
        await writeFile(path, kind === "empty" ? "" : "PRIVATE database");
      else
        sql(directory, (db) => {
          if (kind === "future") db.exec("PRAGMA user_version = 99");
          if (kind === "schema") db.exec("CREATE TABLE unknown (id INTEGER)");
          if (kind === "metadata") db.exec("UPDATE archives SET readers = -1");
          if (kind === "nul")
            db.exec(
              "UPDATE archives SET release = release || char(0) || 'PRIVATE'",
            );
        });
      const before = await readFile(path);
      await expect(withSdeArchive(options, consume)).rejects.toThrow(
        unavailable,
      );
      expect(await readFile(path)).toEqual(before);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("times out a transport that ignores abort, consumes its late failure and cleans reservations", async () => {
    const { options, fetcher, directory } = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const response = deferred<Response>();
    const started = deferred();
    fetcher.mockImplementationOnce(() => {
      started.resolve(undefined);
      return response.promise;
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const pending = expect(withSdeArchive(options, consume)).rejects.toThrow(
        unavailable,
      );
      await started.promise;
      await vi.advanceTimersByTimeAsync(180_000);
      await pending;
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      const cancelled = vi.fn(() =>
        Promise.reject(new Error("PRIVATE late cancellation")),
      );
      response.resolve(new Response(new ReadableStream({ cancel: cancelled })));
      await vi.advanceTimersByTimeAsync(1);
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
      expect(await zips(directory)).toEqual([]);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
  it("closes a timed-out spool even if body read and cancellation never settle", async () => {
    const { options, fetcher, directory } = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reading = deferred();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    fetcher.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          pull() {
            reading.resolve(undefined);
          },
          cancel,
        }),
      ),
    );
    const pending = expect(withSdeArchive(options, consume)).rejects.toThrow(
      unavailable,
    );
    await reading.promise;
    await vi.advanceTimersByTimeAsync(180_000);
    await pending;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await zips(directory)).toEqual([]);
  });
});

function worker(directory: string, build = 123) {
  const messages: string[] = [];
  const code = `
    import { withSdeArchive } from ${JSON.stringify(new URL("../src/sde-archive-cache.ts", import.meta.url).href)};
    import { readFile } from 'node:fs/promises';
    const wait = () => new Promise(resolve => process.once('message', resolve));
    await withSdeArchive({ directory: process.argv[1], source: ${JSON.stringify(source(build))}, userAgent: 'test', maxArchiveBytes: 100,
      fetchImplementation: async () => { const ready = wait(); process.send('fetch'); await ready; return new Response('archive'); }
    }, async (path) => { const ready = wait(); process.send('reader'); await ready; if (await readFile(path, 'utf8') !== 'archive') throw Error('Invalid archive'); });
    process.send('done'); process.disconnect();
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", code, directory],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  children.push(child);
  child.on("message", (message: unknown) => {
    if (typeof message === "string") messages.push(message);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  return {
    child,
    messages,
    exited,
    wait: (message: string) =>
      vi.waitFor(
        () => {
          expect(messages).toContain(message);
        },
        { timeout: 10_000 },
      ),
  };
}

describe("cross-process archive ownership", () => {
  it("shares one ZIP across processes and a process restart, retaining active readers across newer builds", async () => {
    const { directory, options, fetcher } = await setup();
    const first = worker(directory);
    await first.wait("fetch");
    const second = worker(directory);
    first.child.send("download");
    await Promise.all([first.wait("reader"), second.wait("reader")]);
    expect(second.messages).not.toContain("fetch");
    await withSdeArchive({ ...options, source: source(124) }, consume);
    expect(await zips(directory)).toHaveLength(2);
    first.child.send("release");
    expect(await first.exited).toBe(0);
    expect(await zips(directory)).toHaveLength(2);
    second.child.send("release");
    expect(await second.exited).toBe(0);
    expect(await zips(directory)).toHaveLength(1);
    const restarted = worker(directory, 124);
    await restarted.wait("reader");
    expect(restarted.messages).not.toContain("fetch");
    restarted.child.send("release");
    expect(await restarted.exited).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  }, 30_000);
  it("never expires a crashed reader or grows beyond two reservations", async () => {
    const { directory, options, fetcher } = await setup();
    const crashed = worker(directory);
    await crashed.wait("fetch");
    crashed.child.send("download");
    await crashed.wait("reader");
    crashed.child.kill("SIGKILL");
    await crashed.exited;
    await withSdeArchive(
      { ...options, source: source(124), now: () => Number.MAX_SAFE_INTEGER },
      consume,
    );
    for (const build of [125, 126, 127])
      await expect(
        withSdeArchive(
          {
            ...options,
            source: source(build),
            now: () => Number.MAX_SAFE_INTEGER,
          },
          consume,
        ),
      ).rejects.toThrow(unavailable);
    expect(await zips(directory)).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  }, 30_000);
  it("keeps a crashed download reservation fenced rather than deleting its possible live owner's path", async () => {
    const { directory, options, fetcher } = await setup();
    const crashed = worker(directory);
    await crashed.wait("fetch");
    crashed.child.kill("SIGKILL");
    await crashed.exited;
    await withSdeArchive({ ...options, source: source(124) }, consume);
    await expect(
      withSdeArchive({ ...options, source: source(125) }, consume),
    ).rejects.toThrow(unavailable);
    sql(directory, (db) => {
      expect(
        db.prepare("SELECT count(*) AS count FROM archives").get()?.count,
      ).toBe(2);
      expect(
        db.prepare("SELECT sha256 FROM archives WHERE build = 123").get()
          ?.sha256,
      ).toBeNull();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  }, 30_000);
});
