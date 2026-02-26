import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BreatheHRClient } from '../../lib/breathehr';
import { FlipClient } from '../../lib/flip';
import { UserMappingService } from '../../lib/user-mapping';
import type {
  FlipSyncAbsenceRequest,
  AbsenceRequestStatus,
  BreatheAbsence,
  BreatheLeaveRequest,
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
 * IMPORTANT: For absences created via our webhook (Flip → BreatheHR),
 * the Flip absence request's external_id is the BreatheHR leave_request.id
 * (NOT the absence.id). When syncing, we use the leave_request.id as
 * external_id for these absences so the sync preserves the webhook-created
 * entries and doesn't create duplicates.
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

        // Also fetch leave requests to build a date→leave_request_id map.
        // This ensures the sync uses the same external_id as the webhook-
        // created Flip entries (which use leave_request.id, not absence.id).
        const leaveRequestMap = await buildLeaveRequestMap(
          breathe,
          mapping.breatheEmployeeId
        );

        console.log(
          `[SyncAbsences] Found ${absences.length} absences, ` +
            `${leaveRequestMap.size} leave request mappings ` +
            `for employee ${mapping.breatheEmployeeId}`
        );

        for (const absence of absences) {
          const syncItem = mapBreatheAbsenceToFlipSync(
            absence,
            mapping.flipUserId,
            policyByExternalId,
            leaveRequestMap
          );
          if (syncItem) {
            syncItems.push(syncItem);
            successCount++;
            console.log(
              `[SyncAbsences] Mapped absence ${absence.id}: ` +
                `${absence.start_date} - ${absence.end_date}, ` +
                `status=${syncItem.status}, ` +
                `external_id=${syncItem.external_id}, ` +
                `policy=${syncItem.policy.external_id}`
            );
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
 * Build a map from (start_date|end_date) → leave_request.id
 *
 * This is used to determine the correct external_id for the sync.
 * When a leave request was created via our webhook, the Flip absence
 * request's external_id is the leave_request.id. We need to use the
 * same ID in the sync so Flip matches them correctly.
 */
async function buildLeaveRequestMap(
  breathe: BreatheHRClient,
  employeeId: number
): Promise<Map<string, number>> {
  const map = new Map<string, number>();

  try {
    const leaveRequests = await breathe.getAllEmployeeLeaveRequests(employeeId);

    for (const lr of leaveRequests) {
      if (lr.start_date && lr.end_date && lr.id) {
        // Use dates as the key to match against absences
        const key = `${lr.start_date}|${lr.end_date}`;
        map.set(key, lr.id);
      }
    }
  } catch (error) {
    console.log(
      `[SyncAbsences] Could not fetch leave requests for employee ${employeeId}: ` +
        `${error instanceof Error ? error.message : error}`
    );
  }

  return map;
}

/**
 * Map a BreatheHR absence to Flip's sync format
 *
 * Uses leave_request.id as external_id when a matching leave request
 * exists (for webhook-created entries), otherwise falls back to absence.id.
 */
function mapBreatheAbsenceToFlipSync(
  absence: BreatheAbsence,
  flipUserId: string,
  policyByExternalId: Map<string, string>,
  leaveRequestMap: Map<string, number>
): FlipSyncAbsenceRequest | null {
  // Map the status
  // BreatheHR doesn't have a "status" field — absences use a "cancelled" boolean
  const isCancelled =
    (absence as Record<string, unknown>).cancelled === true ||
    (absence as Record<string, unknown>).cancelled === 'true';
  const status: AbsenceRequestStatus = isCancelled ? 'CANCELLED' : 'APPROVED';

  // Determine the external_id
  // If there's a matching leave request, use its ID (matches webhook-created entries)
  // Otherwise use the absence ID
  const dateKey = `${absence.start_date}|${absence.end_date}`;
  const leaveRequestId = leaveRequestMap.get(dateKey);
  const externalId = leaveRequestId
    ? String(leaveRequestId)
    : String(absence.id);

  if (leaveRequestId) {
    console.log(
      `[SyncAbsences] Using leave_request.id ${leaveRequestId} as external_id ` +
        `(instead of absence.id ${absence.id}) for ${absence.start_date} - ${absence.end_date}`
    );
  }

  // Determine the policy
  // If the absence has a leave_reason, try to find the matching Flip policy
  // Otherwise default to "annual_leave"
  let policyExternalId = 'annual_leave';
  if (absence.leave_reason) {
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
    external_id: externalId,
    approver: null,
    absentee: flipUserId,
    duration: absence.deducted
      ? { amount: parseFloat(String(absence.deducted)) || 0, unit: 'DAYS' }
      : undefined,
    policy: {
      external_id: policyExternalId,
    },
    requestor_comment: absence.notes || null,
    status,
    last_updated: absence.updated_at || null,
    starts_from: {
      date: absence.start_date
        ? `${absence.start_date}T00:00:00`
        : absence.start_date,
      type: startsFromType,
    },
    ends_at: {
      date: absence.end_date
        ? `${absence.end_date}T00:00:00`
        : absence.end_date,
      type: endsAtType,
    },
  };
}
