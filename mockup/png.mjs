/**
 * PNG pixels for the /mockup runtime, with nothing but Node's zlib: enough to draw a remark's
 * mark on the shot a headless Chromium took, which is what the runtime does for a remark made
 * on the live page, where no viewer is open to draw it (`annotate.js` draws it in a browser).
 *
 * It reads what Chromium writes: 8 bits a channel, RGB or RGBA, not interlaced. Any other PNG
 * is refused. The pixels are kept as the rows the file holds them in, each behind its filter
 * byte, so an image is unpacked once and never copied.
 */

import { promisify } from "node:util";
import zlib from "node:zlib";

const inflate = promisify(zlib.inflate);
const deflate = promisify(zlib.deflate);

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 2: 3, 6: 4 };
const COLOR_TYPE = { 3: 2, 4: 6 };
const MAX_SIDE = 65535;
const INK = [0xf4, 0x3f, 0x5e];
const HALO = [0xff, 0xff, 0xff];

/** The Paeth predictor of the PNG filter 4: whichever of `a`, `b` and `c` is nearest `a + b - c`. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Undo the filter of each row of `rows` in place, `stride` bytes a row behind a filter byte,
 * `bpp` bytes a pixel, and leave every row as filter 0.
 */
function unfilter(rows, stride, bpp) {
  const step = stride + 1;
  for (let at = 0; at < rows.length; at += step) {
    const filter = rows[at];
    const row = at + 1;
    const up = row - step;
    if (filter > 4) throw new Error(`not a PNG this reads: filter ${filter}`);
    for (let i = 0; i < stride && filter; i += 1) {
      const a = i >= bpp ? rows[row + i - bpp] : 0;
      const b = up > 0 ? rows[up + i] : 0;
      const c = up > 0 && i >= bpp ? rows[up + i - bpp] : 0;
      const add = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c);
      rows[row + i] = (rows[row + i] + add) & 0xff;
    }
    rows[at] = 0;
  }
}

/**
 * The pixels of the PNG `bytes`, `{ width, height, channels, rows }`: `channels` 3 (RGB) or 4
 * (RGBA), `rows` the image row by row, each `width * channels` bytes behind one zero byte.
 * Rejects for anything that is not an 8-bit RGB or RGBA PNG without interlace.
 */
export async function decodePng(bytes) {
  if (!bytes.subarray(0, SIGNATURE.length).equals(SIGNATURE)) throw new Error("not a PNG");
  let head = null;
  const data = [];
  for (let at = SIGNATURE.length; at + 12 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const chunk = bytes.subarray(at + 8, at + 8 + length);
    if (chunk.length !== length) break;
    if (type === "IHDR") head = chunk;
    else if (type === "IDAT") data.push(chunk);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (!head || head.length < 13) throw new Error("not a PNG: no header");
  const width = head.readUInt32BE(0);
  const height = head.readUInt32BE(4);
  const channels = CHANNELS[head[9]];
  if (head[8] !== 8 || !channels || head[12] !== 0) {
    throw new Error("not a PNG this reads: it takes 8-bit RGB or RGBA without interlace");
  }
  const stride = width * channels;
  const rows = await inflate(Buffer.concat(data));
  if (!width || !height || rows.length !== (stride + 1) * height) throw new Error("not a PNG: its pixels are cut short");
  unfilter(rows, stride, channels);
  return { width, height, channels, rows };
}

/** One PNG chunk of `type` holding `data`. */
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** The PNG of an image as `decodePng` gives it, `{ width, height, channels, rows }`. */
export async function encodePng({ width, height, channels, rows }) {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8;
  head[9] = COLOR_TYPE[channels];
  return Buffer.concat([SIGNATURE, chunk("IHDR", head), chunk("IDAT", await deflate(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * An image of `width` by `height` pixels of one colour, `rgb` (`[r, g, b]`, white without it),
 * as `decodePng` gives one.
 */
export function blankImage(width, height, rgb = HALO) {
  if (!(width >= 1 && height >= 1 && width <= MAX_SIDE && height <= MAX_SIDE)) throw new Error("an image is 1 to 65535 pixels a side");
  const stride = width * 3;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rows.set(rgb, y * (stride + 1) + 1 + x * 3);
  }
  return { width, height, channels: 3, rows };
}

/** The colour of the pixel at `x`, `y` of `image`, `[r, g, b]`. */
export function pixelAt({ width, channels, rows }, x, y) {
  const at = y * (width * channels + 1) + 1 + x * channels;
  return [rows[at], rows[at + 1], rows[at + 2]];
}

/** Paint the pixels of `image` from `x0`, `y0` up to but not `x1`, `y1`, cut to it, in `rgb`, opaque. */
function fill(image, x0, y0, x1, y1, rgb) {
  const { width, height, channels, rows } = image;
  const left = Math.max(0, Math.round(x0));
  const right = Math.min(width, Math.round(x1));
  const bottom = Math.min(height, Math.round(y1));
  for (let y = Math.max(0, Math.round(y0)); y < bottom; y += 1) {
    let at = y * (width * channels + 1) + 1 + left * channels;
    for (let x = left; x < right; x += 1) {
      rows[at] = rgb[0];
      rows[at + 1] = rgb[1];
      rows[at + 2] = rgb[2];
      if (channels === 4) rows[at + 3] = 0xff;
      at += channels;
    }
  }
}

/**
 * Draw the region `anchor` (`{ x, y, w, h }`, normalized to the image) on `image` as a frame,
 * red over a white halo so it shows on any still, as wide as the viewer draws it (`annotate.js`).
 */
export function drawFrame(image, anchor) {
  const { width, height } = image;
  const line = Math.max(2, Math.round(Math.min(width, height) / 200));
  const x0 = anchor.x * width;
  const y0 = anchor.y * height;
  const x1 = x0 + anchor.w * width;
  const y1 = y0 + anchor.h * height;
  for (const [half, rgb] of [[line * 1.25, HALO], [line * 0.75, INK]]) {
    fill(image, x0 - half, y0 - half, x1 + half, y0 + half, rgb);
    fill(image, x0 - half, y1 - half, x1 + half, y1 + half, rgb);
    fill(image, x0 - half, y0 + half, x0 + half, y1 - half, rgb);
    fill(image, x1 - half, y0 + half, x1 + half, y1 - half, rgb);
  }
}

/** The PNG `bytes` with the region `anchor` drawn on it (see `drawFrame`), as a PNG. */
export async function markedPng(bytes, anchor) {
  const image = await decodePng(bytes);
  drawFrame(image, anchor);
  return encodePng(image);
}
