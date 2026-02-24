import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BreatheHRClient } from '../../lib/breathehr';
import { FlipClient } from '../../lib/flip';
import { UserMappingService } from '../../lib/user-mapping';

/**
 * Debug endpoint: view user mappings
 *
 * GET /api/debug/mappings
 *
 * Shows all user mappings between Flip and BreatheHR.
 * Useful for debugging and verifying the ExtHRRef ↔ Ref mapping.
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
    const breathe = new BreatheHRClient();
    const flip = new FlipClient();
    const userMapping = new UserMappingService(breathe, flip);

    // Force refresh
    const mappings = await userMapping.refreshMappings();

    res.status(200).json({
      status: 'ok',
      total_mappings: mappings.length,
      mappings: mappings.map((m) => ({
        flip_user_id: m.flipUserId,
        breathe_employee_id: m.breatheEmployeeId,
        breathe_ref: m.breatheRef,
      })),
    });
  } catch (error) {
    console.error('[Debug] Error fetching mappings:', error);
    res.status(500).json({
      error: 'Failed to fetch mappings',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
