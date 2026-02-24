import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Run all syncs in sequence
 *
 * POST /api/sync/all
 *
 * This is called by the Vercel cron (every 15 minutes) and can also
 * be triggered manually. It runs syncs in the correct order:
 * 1. Policies (must exist before balances/absences can reference them)
 * 2. Balances
 * 3. Absences
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const results: Record<string, unknown> = {};
  const baseUrl = `https://${req.headers.host}`;

  try {
    console.log('[SyncAll] Starting full sync...');

    // 1. Sync policies
    console.log('[SyncAll] Step 1/3: Syncing policies...');
    try {
      const policyRes = await fetch(`${baseUrl}/api/sync/policies`, {
        method: 'POST',
      });
      results.policies = await policyRes.json();
      console.log('[SyncAll] Policies sync result:', results.policies);
    } catch (error) {
      results.policies = {
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      console.error('[SyncAll] Policies sync failed:', error);
    }

    // 2. Sync balances
    console.log('[SyncAll] Step 2/3: Syncing balances...');
    try {
      const balanceRes = await fetch(`${baseUrl}/api/sync/balances`, {
        method: 'POST',
      });
      results.balances = await balanceRes.json();
      console.log('[SyncAll] Balances sync result:', results.balances);
    } catch (error) {
      results.balances = {
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      console.error('[SyncAll] Balances sync failed:', error);
    }

    // 3. Sync absences
    console.log('[SyncAll] Step 3/3: Syncing absences...');
    try {
      const absenceRes = await fetch(`${baseUrl}/api/sync/absences`, {
        method: 'POST',
      });
      results.absences = await absenceRes.json();
      console.log('[SyncAll] Absences sync result:', results.absences);
    } catch (error) {
      results.absences = {
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      console.error('[SyncAll] Absences sync failed:', error);
    }

    console.log('[SyncAll] Full sync complete.');

    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      results,
    });
  } catch (error) {
    console.error('[SyncAll] Error:', error);
    res.status(500).json({
      error: 'Full sync failed',
      message: error instanceof Error ? error.message : 'Unknown error',
      results,
    });
  }
}
