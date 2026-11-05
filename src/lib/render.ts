// SVG → PNG for Telegram (which doesn't display SVG photos). resvg is a native renderer:
// no browser. It uses system fonts; the Docker image installs DejaVu Sans.

import { Resvg } from "@resvg/resvg-js";

export function svgToPng(svg: string, scale = 2): Uint8Array {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "zoom", value: scale },
    font: { loadSystemFonts: true, defaultFontFamily: "DejaVu Sans" },
  });
  return resvg.render().asPng();
}
