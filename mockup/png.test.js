/**
 * Unit tests for the PNG pixels of the /mockup runtime (`png.mjs`).
 * Run with `npm test` from mockup/.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { blankImage, decodePng, drawFrame, encodePng, markedPng, pixelAt } from "./png.mjs";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const INK = [0xf4, 0x3f, 0x5e];
const WHITE = [255, 255, 255];

/** One PNG chunk of `type` holding `data`. */
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** The Paeth predictor. */
function paeth(a, b, c) {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * A PNG of `pixels`, rows of `width * channels` bytes, whose row `y` is written with the filter
 * `filters[y]`, its pixel data split over two IDAT chunks, with the header fields of `head` over
 * the ones it would have.
 */
function filtered(pixels, width, channels, filters, head = {}) {
  const stride = width * channels;
  const height = pixels.length / stride;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const filter = filters[y];
    rows[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i += 1) {
      const at = y * stride + i;
      const a = i >= channels ? pixels[at - channels] : 0;
      const b = y ? pixels[at - stride] : 0;
      const c = y && i >= channels ? pixels[at - stride - channels] : 0;
      const guess = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
      rows[y * (stride + 1) + 1 + i] = (pixels[at] - guess) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = head.depth ?? 8;
  ihdr[9] = head.color ?? (channels === 4 ? 6 : 2);
  ihdr[12] = head.interlace ?? 0;
  const data = zlib.deflateSync(rows);
  const half = data.length >> 1;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("sRGB", Buffer.from([0])),
    chunk("IDAT", data.subarray(0, half)),
    chunk("IDAT", data.subarray(half)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("decodePng reads every filter of an RGB and an RGBA PNG, and encodePng writes it back", async () => {
  for (const channels of [3, 4]) {
    const width = 7;
    const pixels = Buffer.from(Array.from({ length: width * channels * 5 }, (_, i) => (i * 37 + (i >> 3) * 11) & 0xff));
    const image = await decodePng(filtered(pixels, width, channels, [0, 1, 2, 3, 4]));
    assert.deepEqual([image.width, image.height, image.channels], [width, 5, channels]);
    const read = Buffer.concat(Array.from({ length: 5 }, (_, y) => image.rows.subarray(y * (width * channels + 1) + 1, (y + 1) * (width * channels + 1))));
    assert.ok(read.equals(pixels), `${channels} channels`);
    assert.deepEqual(pixelAt(image, 2, 3), [...pixels.subarray((3 * width + 2) * channels, (3 * width + 2) * channels + 3)]);
    const again = await decodePng(await encodePng(image));
    assert.ok(again.rows.equals(image.rows));
  }
});

test("decodePng refuses what is not an 8-bit RGB or RGBA PNG without interlace, or is cut short", async () => {
  const pixels = Buffer.alloc(4 * 3 * 2, 9);
  const good = filtered(pixels, 4, 3, [0, 0]);
  await assert.rejects(decodePng(Buffer.from("GIF89a")), /not a PNG/);
  await assert.rejects(decodePng(SIGNATURE), /no header/);
  await assert.rejects(decodePng(filtered(pixels, 4, 3, [0, 0], { depth: 16 })), /8-bit RGB or RGBA/);
  await assert.rejects(decodePng(filtered(pixels, 4, 3, [0, 0], { color: 3 })), /8-bit RGB or RGBA/);
  await assert.rejects(decodePng(filtered(pixels, 4, 3, [0, 0], { interlace: 1 })), /8-bit RGB or RGBA/);
  await assert.rejects(decodePng(filtered(pixels, 4, 3, [0, 7])), /filter 7/);
  await assert.rejects(decodePng(filtered(pixels.subarray(0, 12), 4, 4, [0])), /cut short/);
  await assert.rejects(decodePng(good.subarray(0, good.length - 30)));
  assert.equal((await decodePng(good)).height, 2);
});

test("drawFrame frames a region in red over a white halo, cut to the image, and leaves the rest", () => {
  const image = blankImage(400, 200, [10, 20, 30]);
  drawFrame(image, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  const back = [10, 20, 30];
  assert.deepEqual([pixelAt(image, 100, 50), pixelAt(image, 300, 150), pixelAt(image, 200, 50), pixelAt(image, 100, 100)], [INK, INK, INK, INK]);
  assert.deepEqual([pixelAt(image, 200, 100), pixelAt(image, 104, 54), pixelAt(image, 95, 45)], [back, back, back]);
  assert.deepEqual([pixelAt(image, 98, 100), pixelAt(image, 102, 100), pixelAt(image, 200, 152)], [WHITE, WHITE, WHITE]);
  const whole = blankImage(40, 40, back);
  drawFrame(whole, { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual([pixelAt(whole, 0, 0), pixelAt(whole, 39, 39), pixelAt(whole, 20, 20)], [INK, INK, back]);
  assert.throws(() => blankImage(0, 10), /1 to 65535/);
});

test("markedPng draws a region on a PNG with alpha and keeps its size", async () => {
  const pixels = Buffer.alloc(300 * 200 * 4, 0x80);
  const marked = await decodePng(await markedPng(filtered(pixels, 300, 4, Array(200).fill(4)), { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }));
  assert.deepEqual([marked.width, marked.height, marked.channels], [300, 200, 4]);
  assert.deepEqual([pixelAt(marked, 30, 20), pixelAt(marked, 45, 30)], [INK, [0x80, 0x80, 0x80]]);
  assert.equal(marked.rows[20 * 1201 + 1 + 30 * 4 + 3], 0xff);
});
