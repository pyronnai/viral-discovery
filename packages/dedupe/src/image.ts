/**
 * Bounded image decoding for thumbnails. The FORMAT is sniffed from the bytes
 * (never trusted from a header); dimensions are capped before decoding so a
 * small file cannot expand into a huge bitmap.
 */
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import type { RgbaImage } from './phash.ts';

export const MAX_MEGAPIXELS = 12;

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'gif';

export function sniffFormat(bytes: Uint8Array): ImageFormat | null {
  const b = (i: number) => bytes[i] ?? -1;
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'jpeg';
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'png';
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return 'gif';
  if (
    b(0) === 0x52 &&
    b(1) === 0x49 &&
    b(2) === 0x46 &&
    b(3) === 0x46 &&
    b(8) === 0x57 &&
    b(9) === 0x45
  )
    return 'webp';
  return null;
}

export type DecodeResult =
  | { ok: true; image: RgbaImage; format: ImageFormat }
  | {
      ok: false;
      status: 'not_an_image' | 'unsupported_format' | 'decode_failed' | 'too_large';
      reason: string;
    };

export function decodeImage(bytes: Uint8Array): DecodeResult {
  const format = sniffFormat(bytes);
  if (!format)
    return { ok: false, status: 'not_an_image', reason: 'bytes are not a known image format' };
  try {
    if (format === 'jpeg') {
      const img = jpeg.decode(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        tolerantDecoding: true,
        maxResolutionInMP: MAX_MEGAPIXELS,
        maxMemoryUsageInMB: 256,
      });
      return { ok: true, format, image: { width: img.width, height: img.height, data: img.data } };
    }
    if (format === 'png') {
      // IHDR width/height (big-endian) precede any pixel data.
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes.byteLength < 24)
        return { ok: false, status: 'decode_failed', reason: 'truncated PNG' };
      if ((view.getUint32(16) * view.getUint32(20)) / 1e6 > MAX_MEGAPIXELS) {
        return { ok: false, status: 'too_large', reason: 'image dimensions exceed the limit' };
      }
      const png = PNG.sync.read(Buffer.from(bytes));
      return {
        ok: true,
        format,
        image: { width: png.width, height: png.height, data: new Uint8Array(png.data) },
      };
    }
    return {
      ok: false,
      status: 'unsupported_format',
      reason: `${format} thumbnails are not decoded`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 'decode_failed',
      reason: err instanceof Error ? err.message.slice(0, 200) : 'decode failed',
    };
  }
}
