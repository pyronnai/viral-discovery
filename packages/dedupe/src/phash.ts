/* eslint-disable @typescript-eslint/no-non-null-assertion --
   typed-array pixel loops: every index is bounded by the loop that produces it. */
/**
 * 64-bit DCT perceptual hash (pHash) of a decoded thumbnail. Pure and
 * deterministic. Robust to re-encoding, rescaling and uniform letter/pillar
 * boxes (trimmed first — YouTube Shorts thumbnails are often a 9:16 frame inside
 * black bars, while TikTok serves the bare 9:16 frame). Not robust to crops,
 * mirrored or different frames — a missing match is never evidence of difference.
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

export const HASH_SIZE = 32;
const LOW = 8;
/** A 32×32 grayscale thumbnail flatter than this carries no identity (black frame, solid card). */
const MIN_STDDEV = 6;
/** Borders are trimmed only while at most this share of each dimension is removed per side. */
const MAX_TRIM = 0.4;

export type HashOutcome = { kind: 'hashed'; hash: string } | { kind: 'uninformative' };

function luminance(img: RgbaImage): Float32Array {
  const out = new Float32Array(img.width * img.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * img.data[p]! + 0.587 * img.data[p + 1]! + 0.114 * img.data[p + 2]!;
  }
  return out;
}

function lineStats(
  gray: Float32Array,
  width: number,
  fixed: number,
  from: number,
  to: number,
  horizontal: boolean,
) {
  let sum = 0;
  let sq = 0;
  const n = to - from;
  for (let k = from; k < to; k++) {
    const v = horizontal ? gray[fixed * width + k]! : gray[k * width + fixed]!;
    sum += v;
    sq += v * v;
  }
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
}

/** Crop box after removing uniform bars (any colour) along each edge. */
export function contentBox(gray: Float32Array, width: number, height: number) {
  let top = 0;
  let bottom = height;
  let left = 0;
  let right = width;
  const uniform = (s: { mean: number; std: number }, ref: number) =>
    s.std < 8 && Math.abs(s.mean - ref) < 12;

  const refTop = lineStats(gray, width, 0, 0, width, true);
  if (refTop.std < 8)
    while (
      top < height * MAX_TRIM &&
      uniform(lineStats(gray, width, top, left, right, true), refTop.mean)
    )
      top++;
  const refBottom = lineStats(gray, width, height - 1, 0, width, true);
  if (refBottom.std < 8)
    while (
      bottom > height * (1 - MAX_TRIM) &&
      uniform(lineStats(gray, width, bottom - 1, left, right, true), refBottom.mean)
    )
      bottom--;
  const refLeft = lineStats(gray, width, 0, top, bottom, false);
  if (refLeft.std < 8)
    while (
      left < width * MAX_TRIM &&
      uniform(lineStats(gray, width, left, top, bottom, false), refLeft.mean)
    )
      left++;
  const refRight = lineStats(gray, width, width - 1, top, bottom, false);
  if (refRight.std < 8)
    while (
      right > width * (1 - MAX_TRIM) &&
      uniform(lineStats(gray, width, right - 1, top, bottom, false), refRight.mean)
    )
      right--;
  return { top, bottom, left, right };
}

/** Area-average downscale of the crop box to size×size. */
function resize(
  gray: Float32Array,
  width: number,
  box: { top: number; bottom: number; left: number; right: number },
  size: number,
): Float32Array {
  const out = new Float32Array(size * size);
  const bw = box.right - box.left;
  const bh = box.bottom - box.top;
  for (let y = 0; y < size; y++) {
    const y0 = box.top + Math.floor((y * bh) / size);
    const y1 = Math.max(y0 + 1, box.top + Math.floor(((y + 1) * bh) / size));
    for (let x = 0; x < size; x++) {
      const x0 = box.left + Math.floor((x * bw) / size);
      const x1 = Math.max(x0 + 1, box.left + Math.floor(((x + 1) * bw) / size));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) sum += gray[yy * width + xx]!;
      out[y * size + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

const COS = (() => {
  const table = new Float64Array(LOW * HASH_SIZE);
  for (let u = 0; u < LOW; u++)
    for (let x = 0; x < HASH_SIZE; x++)
      table[u * HASH_SIZE + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * HASH_SIZE));
  return table;
})();

export function perceptualHash(img: RgbaImage): HashOutcome {
  if (img.width < 8 || img.height < 8) return { kind: 'uninformative' };
  const gray = luminance(img);
  const box = contentBox(gray, img.width, img.height);
  const small = resize(gray, img.width, box, HASH_SIZE);

  let mean = 0;
  for (const v of small) mean += v;
  mean /= small.length;
  let variance = 0;
  for (const v of small) variance += (v - mean) ** 2;
  if (Math.sqrt(variance / small.length) < MIN_STDDEV) return { kind: 'uninformative' };

  // Lowest 8×8 DCT-II frequencies of the 32×32 image.
  const coefficients: number[] = [];
  for (let v = 0; v < LOW; v++) {
    for (let u = 0; u < LOW; u++) {
      let sum = 0;
      for (let y = 0; y < HASH_SIZE; y++) {
        const cy = COS[v * HASH_SIZE + y]!;
        for (let x = 0; x < HASH_SIZE; x++)
          sum += small[y * HASH_SIZE + x]! * COS[u * HASH_SIZE + x]! * cy;
      }
      coefficients.push(sum);
    }
  }
  // Median of the AC terms (the DC term only encodes overall brightness).
  const ac = coefficients.slice(1).sort((a, b) => a - b);
  const median = (ac[31]! + ac[32]!) / 2;
  let bits = 0n;
  for (const c of coefficients) bits = (bits << 1n) | (c > median ? 1n : 0n);
  return { kind: 'hashed', hash: bits.toString(16).padStart(16, '0') };
}

export function isHash(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);
}

export function hammingDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (x) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/**
 * Eight one-byte bands. By the pigeonhole principle two hashes within Hamming
 * distance 7 share at least one band exactly, so an indexed band-overlap query
 * finds every "very close" thumbnail without comparing against all videos.
 */
export function hashBands(hash: string): string[] {
  return Array.from({ length: 8 }, (_, i) => `${i}:${hash.slice(i * 2, i * 2 + 2)}`);
}
