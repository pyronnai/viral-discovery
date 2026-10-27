import { handleMediaRequest } from '../../../../../lib/download.ts';
import { mediaDeps } from '../../../../../lib/media-server.ts';

export const dynamic = 'force-dynamic';

/**
 * GET /api/candidates/:clusterId/download[?video=<videoId>]
 * Streams the candidate's official/authorized media asset as a browser file
 * download (Content-Disposition: attachment) and records "obtained".
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ clusterId: string }> },
): Promise<Response> {
  const { clusterId } = await params;
  return handleMediaRequest(mediaDeps(), request, clusterId, 'download');
}
