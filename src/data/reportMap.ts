// Renders a static "project area" map image for the printable report by
// compositing raster basemap tiles + the selected TAZ polygons onto a 2D
// <canvas>, then exporting a PNG data URL embedded as a plain <img>.
//
// Why not an ArcGIS MapView screenshot? A WebGL MapView is unreliable for this:
// view.takeScreenshot() returns a BLANK buffer in some browsers (confirmed on
// ANGLE/Metal), and live WebGL canvases rasterize blank in window.print() /
// Save-as-PDF. A 2D canvas reads back via toDataURL() and prints reliably.
//
// No ArcGIS SDK needed: geometry comes from the feature service REST query, and
// the basemap from ArcGIS Online raster tiles. Tiles are loaded with
// crossOrigin="anonymous" (ArcGIS Online sends CORS headers), so the canvas
// stays untainted and toDataURL() works; a tile that fails CORS simply errors
// and is skipped rather than tainting the canvas.

import { TAZ_LAYER_URL } from "./agol";
import { MAP_STYLE } from "../config/mapStyle";

interface CaptureOpts {
  width?: number;
  height?: number;
  /** Fraction of the selection extent to pad on each side (default 0.15). */
  padding?: number;
}

const TILE = 256;
const ORIGIN_SHIFT = Math.PI * 6378137; // 20037508.342789244 (Web Mercator half-world, m)

// Raster street basemap (CORS-enabled, anonymous). The interactive map uses a
// vector basemap, but raster tiles are what we can composite onto a 2D canvas.
const TILE_URL = (z: number, x: number, y: number) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`;
const ATTRIBUTION = "Sources: Esri, HERE, Garmin, USGS, NGA";

// Web Mercator meters → normalized [0,1] (y inverted: north = 0).
const normX = (x: number) => (x + ORIGIN_SHIFT) / (2 * ORIGIN_SHIFT);
const normY = (y: number) => (ORIGIN_SHIFT - y) / (2 * ORIGIN_SHIFT);

const rgba = (c: number[]) =>
  `rgba(${c[0] ?? 0},${c[1] ?? 0},${c[2] ?? 0},${c[3] ?? 1})`;

function loadTile(z: number, x: number, y: number): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = TILE_URL(z, x, y);
  });
}

/** Pull the selected TAZ polygon rings (Web Mercator) from the feature service. */
async function fetchRings(tazIds: string[]): Promise<number[][][]> {
  const rings: number[][][] = [];
  const CHUNK = 150;
  for (let i = 0; i < tazIds.length; i += CHUNK) {
    const chunk = tazIds.slice(i, i + CHUNK);
    const idList = chunk.map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
    const params = new URLSearchParams({
      where: `taz_id IN (${idList})`,
      outFields: "taz_id",
      returnGeometry: "true",
      outSR: "102100",
      f: "json",
    });
    const resp = await fetch(`${TAZ_LAYER_URL}/query?${params.toString()}`);
    const json = await resp.json();
    for (const f of json.features ?? []) {
      for (const ring of f.geometry?.rings ?? []) rings.push(ring);
    }
  }
  return rings;
}

/**
 * Build a static project-area map (basemap + highlighted TAZs) and return a PNG
 * data URL, or null if there's nothing to show / the render fails.
 */
export async function captureProjectAreaMap(
  tazIds: string[],
  opts: CaptureOpts = {},
): Promise<string | null> {
  if (tazIds.length === 0) return null;
  const W = opts.width ?? 1280;
  const H = opts.height ?? 720;
  const pad = opts.padding ?? 0.15;

  try {
    const rings = await fetchRings(tazIds);
    if (rings.length === 0) return null;

    // Selection bounding box (Web Mercator meters).
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of rings) {
      for (const pt of ring) {
        if (pt[0] < minX) minX = pt[0];
        if (pt[0] > maxX) maxX = pt[0];
        if (pt[1] < minY) minY = pt[1];
        if (pt[1] > maxY) maxY = pt[1];
      }
    }
    if (!isFinite(minX)) return null;

    // Pad; guard against a zero-size extent (single tiny TAZ).
    let dx = maxX - minX, dy = maxY - minY;
    if (dx <= 0) dx = 1000;
    if (dy <= 0) dy = 1000;
    minX -= dx * pad; maxX += dx * pad;
    minY -= dy * pad; maxY += dy * pad;

    // Normalized extent (note y inversion: nMinY uses maxY).
    const nMinX = normX(minX), nMaxX = normX(maxX);
    const nMinY = normY(maxY), nMaxY = normY(minY);
    const nW = nMaxX - nMinX, nH = nMaxY - nMinY;

    // Largest zoom whose extent still fits the canvas (in tile pixels).
    const zForW = Math.log2(W / (nW * TILE));
    const zForH = Math.log2(H / (nH * TILE));
    const z = Math.max(0, Math.min(19, Math.floor(Math.min(zForW, zForH))));
    const world = TILE * Math.pow(2, z); // global pixel span at this zoom
    const n = Math.pow(2, z);            // tiles per axis

    // Global-pixel rect centered on the selection.
    const cx = ((nMinX + nMaxX) / 2) * world;
    const cy = ((nMinY + nMaxY) / 2) * world;
    const left = cx - W / 2, top = cy - H / 2;

    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#e8eef2";
    ctx.fillRect(0, 0, W, H);

    // Composite basemap tiles.
    const tx0 = Math.floor(left / TILE), tx1 = Math.floor((left + W) / TILE);
    const ty0 = Math.floor(top / TILE), ty1 = Math.floor((top + H) / TILE);
    const jobs: Promise<void>[] = [];
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
        const px = tx * TILE - left, py = ty * TILE - top;
        jobs.push(loadTile(z, tx, ty).then((img) => { if (img) ctx.drawImage(img, px, py); }));
      }
    }
    await Promise.all(jobs);

    // Draw the selected TAZ polygons (mercator → canvas px).
    const toPx = (x: number, y: number): [number, number] => [
      normX(x) * world - left,
      normY(y) * world - top,
    ];
    ctx.beginPath();
    for (const ring of rings) {
      if (ring.length === 0) continue;
      const [sx, sy] = toPx(ring[0][0], ring[0][1]);
      ctx.moveTo(sx, sy);
      for (let i = 1; i < ring.length; i++) {
        const [px, py] = toPx(ring[i][0], ring[i][1]);
        ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
    ctx.fillStyle = rgba(MAP_STYLE.selection.fillColor);
    ctx.fill("evenodd");
    ctx.lineWidth = MAP_STYLE.selection.outlineWidth;
    ctx.strokeStyle = rgba(MAP_STYLE.selection.outlineColor);
    ctx.stroke();

    // Basemap attribution (required by Esri terms).
    ctx.font = "11px system-ui, sans-serif";
    const tw = ctx.measureText(ATTRIBUTION).width;
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.fillRect(W - tw - 12, H - 18, tw + 12, 18);
    ctx.fillStyle = "#333";
    ctx.textBaseline = "middle";
    ctx.fillText(ATTRIBUTION, W - tw - 6, H - 9);

    return canvas.toDataURL("image/png");
  } catch (e) {
    console.warn("captureProjectAreaMap: failed to render project-area map", e);
    return null;
  }
}
