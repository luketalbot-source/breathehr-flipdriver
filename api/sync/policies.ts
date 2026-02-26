import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BreatheHRClient } from '../../lib/breathehr';
import { FlipClient } from '../../lib/flip';
import { UserMappingService } from '../../lib/user-mapping';
import type { FlipAbsencePolicySync } from '../../lib/types';

/**
 * Sync absence policies from BreatheHR to Flip
 *
 * POST /api/sync/policies
 *
 * Maps BreatheHR leave types to Flip absence policies:
 * - "Annual Leave" (the default holiday type) → policy with time_unit DAYS
 * - "Other Leave Reasons" from BreatheHR → additional policies
 *
 * Each policy uses the BreatheHR ID as external_id for linking.
 * After syncing policies, assigns them to all mapped Flip users.
 *
 * Also detects stale policies in Flip (removed from BreatheHR) —
 * Flip's API has no delete endpoint so they must be removed manually.
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    console.log('[SyncPolicies] Starting policy sync...');

    const breathe = new BreatheHRClient();
    const flip = new FlipClient();
    const userMapping = new UserMappingService(breathe, flip);

    const syncedPolicies: string[] = [];

    // 1. Sync the default "Annual Leave" / Holiday policy
    const holidayPolicy: FlipAbsencePolicySync = {
      name: 'Annual Leave',
      half_days_allowed: true,
      time_unit: 'DAYS',
      time_units: ['DAYS'],
      external_id: 'annual_leave',
    };

    const annualLeaveResult = await flip.syncAbsencePolicy(holidayPolicy);
    syncedPolicies.push(`Annual Leave (${annualLeaveResult.id})`);
    console.log(`[SyncPolicies] Synced Annual Leave policy: ${annualLeaveResult.id}`);

    // 2. Fetch "other leave reasons" from BreatheHR and create policies for each
    const leaveReasonsResult = await breathe.listOtherLeaveReasons();
    const leaveReasons = leaveReasonsResult.other_leave_reasons || [];

    console.log(`[SyncPolicies] Found ${leaveReasons.length} other leave reasons in BreatheHR`);

    // Track valid external_ids so we can detect stale policies
    const validExternalIds = new Set<string>(['annual_leave']);
    const policyIds: string[] = [annualLeaveResult.id];

    for (const reason of leaveReasons) {
      const externalId = String(reason.id);
      validExternalIds.add(externalId);

      const policy: FlipAbsencePolicySync = {
        name: reason.name,
        half_days_allowed: true,
        time_unit: 'DAYS',
        time_units: ['DAYS'],
        external_id: externalId,
      };

      const result = await flip.syncAbsencePolicy(policy);
      policyIds.push(result.id);
      syncedPolicies.push(`${reason.name} (${result.id})`);
      console.log(`[SyncPolicies] Synced policy "${reason.name}": ${result.id}`);
    }

    // 3. Assign only active BreatheHR policies to all mapped users
    const mappings = await userMapping.getAllMappings();
    const flipUserIds = mappings.map((m) => m.flipUserId);

    if (flipUserIds.length > 0) {
      for (const policyId of policyIds) {
        await flip.assignPolicyToUsers(policyId, flipUserIds);
        console.log(
          `[SyncPolicies] Assigned policy ${policyId} to ${flipUserIds.length} users`
        );
      }
    }

    // 4. Detect stale policies in Flip that no longer exist in BreatheHR
    const allFlipPolicies = await flip.getAbsencePolicies();
    const stalePolicies: Array<{ id: string; name: string; external_id: string }> = [];

    for (const fp of allFlipPolicies.items || []) {
      // Only flag policies whose external_id looks like a BreatheHR numeric ID
      // (skip ones from other integrations that use different naming)
      if (
        fp.external_id &&
        !validExternalIds.has(fp.external_id) &&
        /^\d+$/.test(fp.external_id)
      ) {
        stalePolicies.push({
          id: fp.id,
          name: fp.name,
          external_id: fp.external_id,
        });
      }
    }

    if (stalePolicies.length > 0) {
      console.warn(
        `[SyncPolicies] Found ${stalePolicies.length} stale policies in Flip ` +
        `(removed from BreatheHR, no delete API available):`
      );
      for (const sp of stalePolicies) {
        console.warn(`[SyncPolicies]   - "${sp.name}" (external_id=${sp.external_id})`);
      }
    }

    console.log(`[SyncPolicies] Policy sync complete. Synced ${syncedPolicies.length} policies.`);

    res.status(200).json({
      status: 'ok',
      synced_policies: syncedPolicies,
      assigned_users: flipUserIds.length,
      stale_policies: stalePolicies.length > 0 ? stalePolicies : undefined,
      stale_note: stalePolicies.length > 0
        ? 'These policies were removed from BreatheHR but cannot be deleted via Flip API. Remove them manually in Flip admin.'
        : undefined,
    });
  } catch (error) {
    console.error('[SyncPolicies] Error:', error);
    res.status(500).json({
      error: 'Policy sync failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
