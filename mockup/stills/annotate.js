/**
 * Draws the annotated still of a remark: the revision's image with the remark's mark on it, as
 * the PNG the viewer posts with the `thread` event and the runtime keeps as
 * `review/annotated/<id>.png`, so the agent reads one image.
 *
 * The image is drawn at its own size, scaled down to the 16 million pixels a phone's canvas
 * holds; a PNG whose data URL would decode to more than the runtime's `MAX_ANNOTATED_BYTES` is
 * drawn again at 70% of the scale, up to four times.
 */

import { MAX_ANNOTATED_BYTES, PNG_URL } from "./state.js";

const MAX_PIXELS = 16_000_000;
const MAX_CHARS = PNG_URL.length + Math.floor(MAX_ANNOTATED_BYTES / 3) * 4;
const TRIES = 4;
const SHRINK = 0.7;
const INK = "#f43f5e";
const HALO = "#ffffff";

/**
 * Draw `anchor` on the 2D context `c` of a canvas `width` by `height`: a region as a frame, a
 * pin as a ring around its point, in red over a white halo so it shows on any still.
 */
function drawMark(c, anchor, width, height) {
  const line = Math.max(2, Math.round(Math.min(width, height) / 200));
  const x = anchor.x * width;
  const y = anchor.y * height;
  const trace = () => {
    c.beginPath();
    if (anchor.w === undefined) c.arc(x, y, line * 5, 0, 2 * Math.PI);
    else c.rect(x, y, anchor.w * width, anchor.h * height);
    c.stroke();
  };
  c.lineJoin = "round";
  c.strokeStyle = HALO;
  c.lineWidth = line * 2.5;
  trace();
  c.strokeStyle = INK;
  c.lineWidth = line * 1.5;
  trace();
  if (anchor.w !== undefined) return;
  c.fillStyle = INK;
  c.beginPath();
  c.arc(x, y, line * 1.5, 0, 2 * Math.PI);
  c.fill();
}

/**
 * The image at `url` with `anchor` (a pin `{ x, y }` or a region `{ x, y, w, h }`, normalized
 * to the image) drawn on it, as a `data:image/png;base64,` URL; null when no size of it fits
 * the upload. Rejects when the image does not load or the canvas cannot be read.
 */
export async function annotate(url, anchor) {
  const image = new Image();
  image.src = url;
  await image.decode();
  const { naturalWidth, naturalHeight } = image;
  let scale = Math.min(1, Math.sqrt(MAX_PIXELS / (naturalWidth * naturalHeight)));
  for (let turn = 0; turn < TRIES; turn++) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(naturalHeight * scale));
    const c = canvas.getContext("2d");
    c.drawImage(image, 0, 0, canvas.width, canvas.height);
    drawMark(c, anchor, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/png");
    if (!data.startsWith(PNG_URL)) throw new Error("the canvas could not be read as a PNG");
    if (data.length <= MAX_CHARS) return data;
    scale *= SHRINK;
  }
  return null;
}
