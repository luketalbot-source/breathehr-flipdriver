import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FlipClient } from '../../lib/flip';

/**
 * Debug endpoint: search Flip users
 *
 * GET /api/debug/flip-users
 * GET /api/debug/flip-users?ref=0001
 *
 * Without params: lists first 10 Flip users with all their fields.
 * With ref param: searches for a user by ExtHRRef attribute.
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

    if (ref) {
      // Search by ExtHRRef attribute
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
        results: byAttribute,
      });
    } else {
      // List first 10 users
      console.log('[Debug] Listing first 10 Flip users');
      const allUsers = await flip.searchUsers({ limit: 10 });

      res.status(200).json({
        status: 'ok',
        search_type: 'list_all',
        results: allUsers,
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
