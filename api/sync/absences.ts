import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BreatheHRClient } from '../../lib/breathehr';
import { FlipClient } from '../../lib/flip';
import { UserMappingService } from '../../lib/user-mapping';
import type {
  FlipSyncAbsenceRequest,
  AbsenceRequestStatus,
  BreatheAbsence,
} from '../../lib/types';

/**
 * Sync absence requests from BreatheHR to Flip
 *
 * POST /api/sync/absences
 *
 * Uses Flip's sync lifecycle:
 * 1. Start sync → get sync_id
 * 2. Push absence request items
 * 3. Complete sync
 *
 * This ensures Flip has a consistent view of all absences from BreatheHR.
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let syncId: string | null = null;

  try {
    console.log('[SyncAbsences] Starting absence sync...');

    const breathe = new BreatheHRClient();
    const flip = new FlipClient();
    const userMapping = new UserMappingService(breathe, flip);

    // 1. Get all user mappings
    const mappings = await userMapping.getAllMappings();
    console.log(`[SyncAbsences] Processing ${mappings.length} mapped users`);

    // 2. Get the policies from Flip so we can map leave reasons
    const policiesResult = await flip.getAbsencePolicies();
    const policies = policiesResult.items || [];
    const policyByExternalId = new Map(
      policies.filter((p) => p.external_id).map((p) => [p.external_id!, p.id])
    );

    // 3. Start the sync in Flip
    const syncResult = await flip.startAbsenceRequestSync();
    syncId = syncResult.sync_id;
    console.log(`[SyncAbsences] Started sync: ${syncId}`);

    // 4. Fetch absences from BreatheHR and build sync items
    const syncItems: FlipSyncAbsenceRequest[] = [];
    let successCount = 0;
    let errorCount = 0;

    for (const mapping of mappings) {
      try {
        const absences = await breathe.getAllEmployeeAbsences(
          mapping.breatheEmployeeId
        );

        for (const absence of absences) {
          const syncItem = mapBreatheAbsenceToFlipSync(
            absence,
            mapping.flipUserId,
            policyByExternalId
          );
          if (syncItem) {
            syncItems.push(syncItem);
            successCount++;
          }
        }
      } catch (error) {
        console.error(
          `[SyncAbsences] Error fetching absences for employee ${mapping.breatheEmployeeId}:`,
          error
        );
        errorCount++;
      }
    }

    // 5. Push items in batches
    const batchSize = 100;
    for (let i = 0; i < syncItems.length; i += batchSize) {
      const batch = syncItems.slice(i, i + batchSize);
      await flip.syncAbsenceRequests(syncId, batch);
      console.log(
        `[SyncAbsences] Pushed batch ${Math.floor(i / batchSize) + 1} (${batch.length} items)`
      );
    }

    // 6. Complete the sync
    await flip.completeAbsenceRequestSync(syncId);
    console.log(
      `[SyncAbsences] Sync complete. Synced: ${successCount}, Errors: ${errorCount}`
    );

    res.status(200).json({
      status: 'ok',
      sync_id: syncId,
      synced: successCount,
      errors: errorCount,
    });
  } catch (error) {
    console.error('[SyncAbsences] Error:', error);

    // Cancel the sync if it was started
    if (syncId) {
      try {
        const flip = new FlipClient();
        await flip.cancelAbsenceRequestSync(syncId);
        console.log(`[SyncAbsences] Cancelled sync ${syncId} due to error`);
      } catch (cancelError) {
        console.error('[SyncAbsences] Failed to cancel sync:', cancelError);
      }
    }

    res.status(500).json({
      error: 'Absence sync failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Map a BreatheHR absence to Flip's sync format
 */
function mapBreatheAbsenceToFlipSync(
  absence: BreatheAbsence,
  flipUserId: string,
  policyByExternalId: Map<string, string>
): FlipSyncAbsenceRequest | null {
  // Map the status
  const status = mapAbsenceStatus(absence.status);
  if (!status) {
    console.log(
      `[SyncAbsences] Skipping absence ${absence.id} with unmappable status: ${absence.status}`
    );
    return null;
  }

  // Determine the policy
  // If the absence has a leave_reason, try to find the matching Flip policy
  // Otherwise default to "annual_leave"
  let policyExternalId = 'annual_leave';
  if (absence.leave_reason) {
    // The leave_reason name or ID might match a synced policy
    // We use the BreatheHR leave reason ID as the external_id
    const leaveReasonId =
      (absence as Record<string, unknown>).leave_reason_id ||
      (absence as Record<string, unknown>).other_leave_reason_id;
    if (leaveReasonId && policyByExternalId.has(String(leaveReasonId))) {
      policyExternalId = String(leaveReasonId);
    }
  }

  // Map half-day information
  const startsFromType = absence.half_start ? 'SECOND_HALF' : undefined;
  const endsAtType = absence.half_end ? 'FIRST_HALF' : undefined;

  return {
    id: null, // New item, let Flip assign ID
    external_id: String(absence.id),
    approver: null,
    absentee: flipUserId,
    duration: absence.deducted
      ? { amount: absence.deducted, unit: 'DAYS' }
      : undefined,
    policy: {
      external_id: policyExternalId,
    },
    requestor_comment: absence.notes || null,
    status,
    last_updated: absence.updated_at || null,
    starts_from: {
      date: absence.start_date,
      type: startsFromType,
    },
    ends_at: {
      date: absence.end_date,
      type: endsAtType,
    },
  };
}

/**
 * Map BreatheHR absence status to Flip status
 */
function mapAbsenceStatus(
  breatheStatus?: string
): AbsenceRequestStatus | null {
  if (!breatheStatus) return null;

  const normalised = breatheStatus.toLowerCase().trim();

  switch (normalised) {
    case 'approved':
    case 'taken':
      return 'APPROVED';
    case 'pending':
    case 'requested':
      return 'PENDING';
    case 'rejected':
    case 'declined':
      return 'REJECTED';
    case 'cancelled':
    case 'canceled':
      return 'CANCELLED';
    default:
      console.log(`[SyncAbsences] Unknown BreatheHR status: ${breatheStatus}`);
      return null;
  }
}
