import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BreatheHRClient } from '../../lib/breathehr';

/**
 * Debug endpoint: list BreatheHR employees
 *
 * GET /api/debug/employees
 *
 * Useful to discover the exact field name for the "Ref" field.
 * Returns the first 5 employees with all their fields.
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
    const result = await breathe.listEmployees(1, 5);

    // Return all fields so we can identify the "Ref" field name
    res.status(200).json({
      status: 'ok',
      note: 'Inspect the fields below to find the exact "Ref" field name',
      employees: result.employees,
    });
  } catch (error) {
    console.error('[Debug] Error fetching employees:', error);
    res.status(500).json({
      error: 'Failed to fetch employees',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
