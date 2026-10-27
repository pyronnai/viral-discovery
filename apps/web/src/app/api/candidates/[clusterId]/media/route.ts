import { handleMediaRequest } from '../../../../../lib/download.ts';
import { mediaDeps } from '../../../../../lib/media-server.ts';

export const dynamic = 'force-dynamic';

/**
 * GET /api/candidates/:clusterId/media[?video=<videoId>]
 * Same asset, served inline (with Range support) for the native player on the
 * detail page. Playing a preview never marks the clip obtained.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ clusterId: string }> },
): Promise<Response> {
  const { clusterId } = await params;
  return handleMediaRequest(mediaDeps(), request, clusterId, 'inline');
}
