import { getExportRows, toCsv, toJson, MAX_EXPORT } from '@vd/review';
import { effectiveView, parseFilters, type SearchParams } from '../../lib/filters.ts';
import { getContext } from '../../lib/server.ts';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /export?format=csv|json&ids=<id,id,…>  — the selected candidates, or
 * GET /export?format=csv|json&view=saved&…  — everything in a (filtered) view.
 * Metadata and source links only; never media files.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';
  const params: SearchParams = Object.fromEntries(url.searchParams.entries());
  const rawIds = url.searchParams.get('ids');
  const ctx = getContext();
  const now = new Date();
  try {
    let rows;
    if (rawIds !== null) {
      const ids = rawIds
        .split(',')
        .map((s) => s.trim())
        .filter((s) => UUID.test(s));
      if (!ids.length) return new Response('no valid candidate ids', { status: 400 });
      rows = await getExportRows(ctx.db, { clusterIds: ids.slice(0, MAX_EXPORT) });
    } else {
      const parsed = parseFilters(params);
      rows = await getExportRows(ctx.db, {
        filters: {
          ...parsed,
          view: effectiveView(parsed),
          viralNowHours: ctx.config.VIRAL_NOW_HOURS,
        },
        now,
      });
    }
    const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const body = format === 'json' ? toJson(rows, now) : toCsv(rows);
    return new Response(body, {
      headers: {
        'content-type':
          format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="viral-inbox-${stamp}.${format}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    ctx.logger.error({ err }, 'export failed');
    return new Response('export failed', { status: 500 });
  }
}
