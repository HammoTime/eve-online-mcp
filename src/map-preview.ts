import { fileURLToPath } from "node:url";
import type { MapPreview } from "../lib/src/cartography/service.js";
import { MapError, MAP_LIMITS } from "../lib/src/cartography/types.js";

/** Rasterization is a local adapter, never a shared-core or discovery dependency. */
export class LocalMapPreview implements MapPreview {
  private active = 0;
  async render(svg: string, width: number, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.active >= 2)
      throw new MapError(
        "MAP_PREVIEW_BUSY",
        "Preview capacity reached; the SVG remains available.",
      );
    if (
      Buffer.byteLength(svg) > MAP_LIMITS.svgBytes ||
      ![1440, 1600].includes(width)
    )
      throw new MapError(
        "MAP_PREVIEW_LIMIT",
        "Invalid preview dimensions or byte size.",
      );
    this.active++;
    try {
      const { renderAsync } = await import("@resvg/resvg-js");
      const font = fileURLToPath(
        import.meta.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf"),
      );
      const bold = fileURLToPath(
        import.meta.resolve("dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf"),
      );
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      for (const outputWidth of [width, 1000]) {
        bounded.throwIfAborted();
        const rendered = await renderAsync(
          svg,
          {
            font: {
              loadSystemFonts: false,
              fontFiles: [font, bold],
              defaultFontFamily: "DejaVu Sans",
              sansSerifFamily: "DejaVu Sans",
            },
            fitTo: { mode: "width", value: outputWidth },
            logLevel: "off",
          },
          bounded,
        );
        const png = rendered.asPng();
        if (png.byteLength <= MAP_LIMITS.previewBytes)
          return {
            data: png.toString("base64"),
            bytes: png.byteLength,
            width: rendered.width,
            height: rendered.height,
          };
      }
      throw new MapError(
        "MAP_PREVIEW_LIMIT",
        "Preview exceeds its byte budget.",
      );
    } finally {
      this.active--;
    }
  }
}
