/**
 * Deterministic fixtures: synthetic thumbnails (seeded shapes, encoded as real
 * JPEGs) and an in-process Postgres with the real migrations. No network.
 * Imported by *.test.ts files (and other packages' tests) only.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import jpeg from 'jpeg-js';
import { MIGRATIONS_FOLDER, schema, type AnyDatabase } from '@vd/db';
import type { RgbaImage } from './phash.ts';
import { hashImageBytes, type ThumbnailHasher, type ThumbnailHashResult } from './thumbnail.ts';

export const NOW = new Date('2026-09-29T12:00:00Z');
export const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A "photo-like" image: a gradient background plus seeded coloured ellipses. */
export function syntheticImage(seed: number, width = 360, height = 640): RgbaImage {
  const rand = prng(seed);
  const data = new Uint8Array(width * height * 4);
  const bg = [rand() * 255, rand() * 255, rand() * 255];
  const shapes = Array.from({ length: 10 }, () => ({
    cx: rand() * width,
    cy: rand() * height,
    rx: 20 + rand() * width * 0.35,
    ry: 20 + rand() * height * 0.25,
    color: [rand() * 255, rand() * 255, rand() * 255],
  }));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let c = [bg[0]! * (1 - y / height), bg[1]!, bg[2]! * (x / width)];
      for (const s of shapes) {
        if (((x - s.cx) / s.rx) ** 2 + ((y - s.cy) / s.ry) ** 2 <= 1) c = s.color;
      }
      const p = (y * width + x) * 4;
      data[p] = c[0]!;
      data[p + 1] = c[1]!;
      data[p + 2] = c[2]!;
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Bilinear rescale. */
export function rescale(img: RgbaImage, width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = ((y + 0.5) * img.height) / height - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(img.height - 1, y0 + 1);
    const fy = Math.min(1, Math.max(0, sy - y0));
    for (let x = 0; x < width; x++) {
      const sx = ((x + 0.5) * img.width) / width - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(img.width - 1, x0 + 1);
      const fx = Math.min(1, Math.max(0, sx - x0));
      for (let k = 0; k < 4; k++) {
        const at = (xx: number, yy: number) => img.data[(yy * img.width + xx) * 4 + k]!;
        const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
        const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
        data[(y * width + x) * 4 + k] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return { width, height, data };
}

/** Places the image, scaled to fit, inside a black canvas (YouTube-style pillar/letterbox). */
export function boxed(img: RgbaImage, width: number, height: number): RgbaImage {
  const scale = Math.min(width / img.width, height / img.height);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const inner = rescale(img, w, h);
  const data = new Uint8Array(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const ox = Math.floor((width - w) / 2);
  const oy = Math.floor((height - h) / 2);
  for (let y = 0; y < h; y++) {
    data.set(inner.data.subarray(y * w * 4, (y + 1) * w * 4), ((y + oy) * width + ox) * 4);
  }
  return { width, height, data };
}

/** Adds a text-overlay-like bar and slight brightness change (a repost watermark). */
export function watermarked(img: RgbaImage): RgbaImage {
  const data = new Uint8Array(img.data);
  for (let y = Math.floor(img.height * 0.9); y < img.height * 0.94; y++) {
    for (let x = Math.floor(img.width * 0.05); x < img.width * 0.35; x++) {
      const p = (y * img.width + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = 250;
    }
  }
  for (let i = 0; i < data.length; i += 4) {
    for (let k = 0; k < 3; k++) data[i + k] = Math.min(255, data[i + k]! + 6);
  }
  return { width: img.width, height: img.height, data };
}

export function toJpeg(img: RgbaImage, quality = 85): Uint8Array {
  return new Uint8Array(
    jpeg.encode({ width: img.width, height: img.height, data: img.data }, quality).data,
  );
}

/** A hasher over an in-memory URL → bytes map (unknown URLs fail like an unreachable CDN). */
export function fakeHasher(
  images: Record<string, Uint8Array | ThumbnailHashResult>,
): ThumbnailHasher & {
  calls: string[];
} {
  const calls: string[] = [];
  const hasher = (url: string) => {
    calls.push(url);
    const entry = images[url];
    if (!entry)
      return Promise.resolve<ThumbnailHashResult>({
        status: 'http_error',
        hash: null,
        reason: 'HTTP 404',
      });
    return Promise.resolve(entry instanceof Uint8Array ? hashImageBytes(entry) : entry);
  };
  return Object.assign(hasher, { calls });
}

export async function createTestDb(): Promise<{ db: AnyDatabase; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: MIGRATIONS_FOLDER,
    migrationsSchema: 'drizzle',
    migrationsTable: '__drizzle_migrations',
  });
  return { db, close: () => client.close() };
}

export interface VideoSpec {
  platform: string;
  platformVideoId: string;
  title?: string | null;
  caption?: string | null;
  durationMs?: number | null;
  publishedAt?: Date | null;
  firstDiscoveredAt?: Date;
  creator?: string | null;
  thumbnailUrl?: string | null;
  availability?: 'available' | 'unknown' | 'private' | 'removed';
  /** Canonical metric snapshots (views only — never used for matching). */
  views?: number[];
  sightings?: { source: string; key: string; postUrl?: string }[];
  clusterCreatedAt?: Date;
}

export async function seedVideo(
  db: AnyDatabase,
  spec: VideoSpec,
): Promise<{ videoId: string; clusterId: string }> {
  const discovered = spec.firstDiscoveredAt ?? hoursAgo(6);
  const [video] = await db
    .insert(schema.videos)
    .values({
      platform: spec.platform,
      platformVideoId: spec.platformVideoId,
      canonicalUrl: `https://example.test/${spec.platform}/${spec.platformVideoId}`,
      title: spec.title ?? null,
      caption: spec.caption ?? null,
      durationMs: spec.durationMs ?? null,
      publishedAt: spec.publishedAt ?? null,
      firstDiscoveredAt: discovered,
      creatorDisplayName: spec.creator ?? null,
      thumbnailUrl: spec.thumbnailUrl ?? null,
      availability: spec.availability ?? 'available',
    })
    .returning();
  const [cluster] = await db
    .insert(schema.clusters)
    .values({ representativeVideoId: video!.id, createdAt: spec.clusterCreatedAt ?? discovered })
    .returning();
  await db
    .update(schema.videos)
    .set({ clusterId: cluster!.id })
    .where(eq(schema.videos.id, video!.id));
  for (const [i, views] of (spec.views ?? []).entries()) {
    await db.insert(schema.metricSnapshots).values({
      videoId: video!.id,
      capturedAt: new Date(discovered.getTime() + i * 3_600_000),
      views,
    });
  }
  for (const s of spec.sightings ?? []) {
    await db
      .insert(schema.sources)
      .values({ name: s.source, adapterId: s.source, enabled: true })
      .onConflictDoNothing();
    const [source] = await db
      .select()
      .from(schema.sources)
      .where(eq(schema.sources.name, s.source));
    await db.insert(schema.sightings).values({
      videoId: video!.id,
      sourceId: source!.id,
      observationKey: s.key,
      seenAt: discovered,
      context: s.postUrl ? { postUrl: s.postUrl } : {},
    });
  }
  return { videoId: video!.id, clusterId: cluster!.id };
}
