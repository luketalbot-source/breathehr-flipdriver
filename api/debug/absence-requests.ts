import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FlipClient } from '../../lib/flip';

/**
 * Debug endpoint to list absence requests from Flip
 *
 * GET /api/debug/absence-requests
 * GET /api/debug/absence-requests?user_id=xxx  — for a specific user
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  try {
    const flip = new FlipClient();
    const token = await flip.getAccessToken();
    const flipBaseUrl = process.env.FLIP_BASE_URL || 'https://show.flipnext.de';
    const userId = req.query.user_id as string | undefined;

    // Try fetching absence requests for the user
    const url = userId
      ? `${flipBaseUrl}/api/hr/v4/absence-requests?user_id=${userId}`
      : `${flipBaseUrl}/api/hr/v4/absence-requests`;

    console.log(`[Debug] Fetching absence requests: ${url}`);

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    });

    const body = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }

    res.status(200).json({
      status: response.ok ? 'ok' : 'error',
      http_status: response.status,
      url,
      data: parsed,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch absence requests',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
