import type { RenderedImage } from "@resvg/resvg-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalMapPreview } from "../src/map-preview.js";
import { MAP_LIMITS } from "../lib/src/cartography/types.js";

const { renderAsync } = vi.hoisted(() => ({
  renderAsync: vi.fn<typeof import("@resvg/resvg-js").renderAsync>(),
}));
vi.mock("@resvg/resvg-js", () => ({ renderAsync }));

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="720" viewBox="0 0 1440 720">
  <rect width="1440" height="720" fill="black"/>
  <g font-family="DejaVu Sans" fill="white">
    <text x="40" y="64" font-size="32" font-weight="bold">Synthetic Atlas</text>
    <text x="40" y="120" font-size="24">Jita | Perimeter</text>
    <text x="40" y="176" font-size="20">Route 1: 2 jumps</text>
  </g>
  <circle cx="720" cy="400" r="10" fill="#66ccff"/>
</svg>`;

function image(bytes = 16, width = 1440): RenderedImage {
  return {
    width,
    height: width / 2,
    pixels: Buffer.alloc(0),
    asPng: () => Buffer.alloc(bytes),
  };
}

describe("local map preview", () => {
  beforeEach(() => {
    renderAsync.mockReset();
    renderAsync.mockImplementation(async (...args) => {
      const actual =
        await vi.importActual<typeof import("@resvg/resvg-js")>(
          "@resvg/resvg-js",
        );
      return actual.renderAsync(...args);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([1440, 1600])(
    "rasterizes deterministic real PNGs at width %s with every synthetic label visible",
    async (width) => {
      const preview = new LocalMapPreview();
      const signal = new AbortController().signal;
      const result = await preview.render(svg, width, signal);
      const png = Buffer.from(result.data, "base64");
      expect(png.subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      expect(png.toString("ascii", 12, 16)).toBe("IHDR");
      expect(png.readUInt32BE(16)).toBe(width);
      expect(png.readUInt32BE(20)).toBe(width / 2);
      expect(result).toMatchObject({
        width,
        height: width / 2,
        bytes: png.byteLength,
      });
      expect(result.bytes).toBeLessThanOrEqual(MAP_LIMITS.previewBytes);
      expect(await preview.render(svg, width, signal)).toEqual(result);
      expect(renderAsync).toHaveBeenCalledTimes(2);
      expect(renderAsync).toHaveBeenCalledWith(
        svg,
        {
          font: {
            loadSystemFonts: false,
            fontFiles: [
              expect.stringMatching(/\/DejaVuSans\.ttf$/),
              expect.stringMatching(/\/DejaVuSans-Bold\.ttf$/),
            ],
            defaultFontFamily: "DejaVu Sans",
            sansSerifFamily: "DejaVu Sans",
          },
          fitTo: { mode: "width", value: width },
          logLevel: "off",
        },
        expect.any(AbortSignal),
      );

      // Inspect each disjoint label region in the native image used for the PNG.
      for (const call of renderAsync.mock.results) {
        const rendered = await call.value;
        const pixels = rendered.pixels;
        const scale = width / 1440;
        for (const [top, bottom] of [
          [30, 70],
          [90, 125],
          [145, 180],
        ] as const) {
          let visible = 0;
          for (
            let y = Math.ceil(top * scale);
            y < Math.floor(bottom * scale);
            y++
          ) {
            for (
              let x = Math.ceil(35 * scale);
              x < Math.floor(500 * scale);
              x++
            ) {
              if ((pixels[(y * width + x) * 4] ?? 0) > 128) visible++;
            }
          }
          expect(visible, `label region ${top}-${bottom}`).toBeGreaterThan(100);
        }
      }
    },
  );

  it("rejects invalid widths and oversized UTF-8 SVGs before invoking the rasterizer", async () => {
    const preview = new LocalMapPreview();
    for (const width of [0, -1440, 1000, 1440.5, NaN, Infinity]) {
      await expect(
        preview.render(svg, width, new AbortController().signal),
      ).rejects.toMatchObject({ code: "MAP_PREVIEW_LIMIT" });
    }
    const oversized = "\u00e9".repeat(MAP_LIMITS.svgBytes / 2 + 1);
    expect(oversized.length).toBeLessThan(MAP_LIMITS.svgBytes);
    await expect(
      preview.render(oversized, 1440, new AbortController().signal),
    ).rejects.toMatchObject({ code: "MAP_PREVIEW_LIMIT" });
    expect(renderAsync).not.toHaveBeenCalled();
  });

  it("accepts exactly the input and PNG byte budgets without downscaling", async () => {
    renderAsync.mockResolvedValue(image(MAP_LIMITS.previewBytes));
    const prefix = '<svg xmlns="http://www.w3.org/2000/svg"><!--';
    const suffix = "--></svg>";
    const exact =
      prefix +
      "x".repeat(MAP_LIMITS.svgBytes - prefix.length - suffix.length) +
      suffix;
    const result = await new LocalMapPreview().render(
      exact,
      1440,
      new AbortController().signal,
    );
    expect(result.bytes).toBe(MAP_LIMITS.previewBytes);
    expect(Buffer.from(result.data, "base64").byteLength).toBe(
      MAP_LIMITS.previewBytes,
    );
    expect(result.width).toBe(1440);
    expect(renderAsync).toHaveBeenCalledTimes(1);
  });

  it("retries oversized PNGs once at width 1000 and returns that raster's dimensions", async () => {
    renderAsync
      .mockResolvedValueOnce(image(MAP_LIMITS.previewBytes + 1, 1600))
      .mockResolvedValueOnce(image(100, 1000));
    const result = await new LocalMapPreview().render(
      svg,
      1600,
      new AbortController().signal,
    );
    expect(result).toEqual({
      data: Buffer.alloc(100).toString("base64"),
      bytes: 100,
      width: 1000,
      height: 500,
    });
    expect(renderAsync.mock.calls.map(([, options]) => options?.fitTo)).toEqual(
      [
        { mode: "width", value: 1600 },
        { mode: "width", value: 1000 },
      ],
    );
    const signals = renderAsync.mock.calls.map(([, , signal]) => signal);
    expect(signals[0]).toBe(signals[1]);
  });

  it("rejects output still oversized after fallback and releases the active slot", async () => {
    const preview = new LocalMapPreview();
    renderAsync.mockResolvedValue(image(MAP_LIMITS.previewBytes + 1));
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(
        preview.render(svg, 1440, new AbortController().signal),
      ).rejects.toMatchObject({ code: "MAP_PREVIEW_LIMIT" });
    }
    expect(renderAsync).toHaveBeenCalledTimes(6);
    renderAsync.mockResolvedValue(image());
    await expect(
      preview.render(svg, 1440, new AbortController().signal),
    ).resolves.toHaveProperty("bytes", 16);
  });

  it("allows two active renders, rejects a third, and admits work after completion", async () => {
    const preview = new LocalMapPreview();
    const complete: ((rendered: RenderedImage) => void)[] = [];
    renderAsync.mockImplementation(
      () => new Promise((resolve) => complete.push(resolve)),
    );
    const pending = [preview.render(svg, 1440, new AbortController().signal)];
    try {
      // Wait for lazy module loading before starting the second mocked job.
      await vi.waitFor(() => {
        expect(complete).toHaveLength(1);
      });
      pending.push(preview.render(svg, 1600, new AbortController().signal));
      await vi.waitFor(() => {
        expect(complete).toHaveLength(2);
      });
      await expect(
        preview.render(svg, 1440, new AbortController().signal),
      ).rejects.toMatchObject({ code: "MAP_PREVIEW_BUSY" });
      expect(renderAsync).toHaveBeenCalledTimes(2);
    } finally {
      for (const resolve of complete) resolve(image());
      await Promise.all(pending);
    }
    renderAsync.mockResolvedValue(image());
    await expect(
      preview.render(svg, 1440, new AbortController().signal),
    ).resolves.toHaveProperty("bytes", 16);
  });

  it("rejects pre-aborted requests without consuming raster capacity", async () => {
    const preview = new LocalMapPreview();
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    controller.abort(reason);
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(preview.render(svg, 1440, controller.signal)).rejects.toBe(
        reason,
      );
    }
    expect(renderAsync).not.toHaveBeenCalled();
    await expect(
      preview.render(svg, 1440, new AbortController().signal),
    ).resolves.toHaveProperty("width", 1440);
  });

  it("cancels a real native render in flight and permits a subsequent render", async () => {
    const preview = new LocalMapPreview();
    const controller = new AbortController();
    renderAsync.mockImplementationOnce(async (...args) => {
      const actual =
        await vi.importActual<typeof import("@resvg/resvg-js")>(
          "@resvg/resvg-js",
        );
      const pending = actual.renderAsync(...args);
      controller.abort();
      return pending;
    });
    await expect(
      preview.render(svg, 1440, controller.signal),
    ).rejects.toMatchObject({ code: "Cancelled", message: "AbortError" });
    await expect(
      preview.render(svg, 1440, new AbortController().signal),
    ).resolves.toHaveProperty("width", 1440);
  });

  it.each(["caller", "timeout"] as const)(
    "forwards %s cancellation through the 10-second budget and recovers capacity",
    async (kind) => {
      const preview = new LocalMapPreview();
      const caller = new AbortController();
      const budget = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValue(budget.signal);
      let bounded: AbortSignal | undefined;
      renderAsync.mockImplementation(
        (_svg, _options, signal) =>
          new Promise((_resolve, reject) => {
            if (!signal) throw new Error("Missing raster abort signal");
            bounded = signal;
            signal.addEventListener(
              "abort",
              () => {
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new Error("Raster cancelled"),
                );
              },
              { once: true },
            );
          }),
      );
      const pending = preview.render(svg, 1440, caller.signal);
      const reason = new DOMException(
        kind,
        kind === "timeout" ? "TimeoutError" : "AbortError",
      );
      const rejected = expect(pending).rejects.toBe(reason);
      try {
        await vi.waitFor(() => {
          expect(bounded).toBeDefined();
        });
        expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
        (kind === "timeout" ? budget : caller).abort(reason);
        await rejected;
        expect(bounded?.aborted).toBe(true);
        expect(renderAsync).toHaveBeenCalledTimes(1);
      } finally {
        caller.abort(reason);
        await rejected;
      }
      timeout.mockRestore();
      renderAsync.mockResolvedValue(image());
      await expect(
        preview.render(svg, 1440, new AbortController().signal),
      ).resolves.toHaveProperty("bytes", 16);
    },
  );

  it("propagates native invalid-SVG failures without leaking capacity", async () => {
    const preview = new LocalMapPreview();
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(
        preview.render("not SVG", 1440, new AbortController().signal),
      ).rejects.toThrow();
    }
    await expect(
      preview.render(svg, 1440, new AbortController().signal),
    ).resolves.toHaveProperty("width", 1440);
  });
});
