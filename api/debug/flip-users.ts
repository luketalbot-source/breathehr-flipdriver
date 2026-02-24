import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FlipClient } from '../../lib/flip';

/**
 * Debug endpoint: search Flip users
 *
 * GET /api/debug/flip-users              — list first 10 users
 * GET /api/debug/flip-users?ref=0001     — search by ExtHRRef attribute
 * GET /api/debug/flip-users?search=Luke  — search by name/email
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const flip = new FlipClient();
    const ref = req.query.ref as string | undefined;
    const search = req.query.search as string | undefined;

    if (ref) {
      console.log(`[Debug] Searching Flip users with ExtHRRef="${ref}"`);
      const byAttribute = await flip.searchUsers({
        attributeName: 'ExtHRRef',
        attributeValue: ref,
        limit: 10,
      });

      res.status(200).json({
        status: 'ok',
        search_type: 'by_ExtHRRef',
        ref_value: ref,
        raw_response: byAttribute,
      });
    } else if (search) {
      console.log(`[Debug] Searching Flip users with term="${search}"`);
      const bySearch = await flip.searchUsers({
        searchTerm: search,
        limit: 10,
      });

      res.status(200).json({
        status: 'ok',
        search_type: 'by_search_term',
        search_term: search,
        raw_response: bySearch,
      });
    } else {
      console.log('[Debug] Listing first 10 Flip users');
      const allUsers = await flip.searchUsers({ limit: 10 });

      res.status(200).json({
        status: 'ok',
        search_type: 'list_all',
        raw_response: allUsers,
      });
    }
  } catch (error) {
    console.error('[Debug] Error:', error);
    res.status(500).json({
      error: 'Failed to search Flip users',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
