import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Run all syncs in sequence
 *
 * POST /api/sync/all
 *
 * This is called by the Vercel cron (every 30 minutes) and can also
 * be triggered manually. It runs syncs in the correct order:
 * 1. Policies (must exist before balances/absences can reference them)
 * 2. Balances
 * 3. Approval status check (uses approve/reject endpoints → triggers notifications)
 * 4. Absences (bulk sync for historical consistency)
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
    console.log('[SyncAll] Step 1/4: Syncing policies...');
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
    console.log('[SyncAll] Step 2/4: Syncing balances...');
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

    // 3. Check approval status (BEFORE absence sync)
    // This uses Flip's approve/reject endpoints which trigger user notifications.
    // Must run before the bulk sync so that the approve/reject calls go through
    // while the requests are still PENDING.
    console.log('[SyncAll] Step 3/4: Checking approval status...');
    try {
      const approvalRes = await fetch(`${baseUrl}/api/sync/approval-status`, {
        method: 'POST',
      });
      results.approval_status = await approvalRes.json();
      console.log('[SyncAll] Approval status result:', results.approval_status);
    } catch (error) {
      results.approval_status = {
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      console.error('[SyncAll] Approval status check failed:', error);
    }

    // 4. Sync absences (bulk sync for historical consistency)
    // This updates all absence data but does NOT trigger notifications.
    console.log('[SyncAll] Step 4/4: Syncing absences...');
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
