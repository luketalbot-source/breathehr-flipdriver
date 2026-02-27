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
 * Uses Flip's sync lifecycle (start → push → complete).
 * The sync is a FULL REPLACEMENT — items not in the push data get removed.
 *
 * CRITICAL: We must include ALL states in the sync data:
 * - APPROVED absences (from BreatheHR absences endpoint)
 * - PENDING leave requests (still awaiting manager approval)
 * - REJECTED/DENIED leave requests
 * - CANCELLED absences
 *
 * If we only push approved absences, PENDING and REJECTED Flip entries
 * created via the webhook get destroyed by the sync, which means:
 * - The approval-status checker can never find them to trigger notifications
 * - Rejected requests silently disappear instead of showing as rejected
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

    // 4. Fetch absences AND leave requests, build sync items
    const syncItems: FlipSyncAbsenceRequest[] = [];
    const seenExternalIds = new Set<string>();
    let absenceCount = 0;
    let pendingCount = 0;
    let rejectedCount = 0;
    let errorCount = 0;

    for (const mapping of mappings) {
      try {
        // Fetch both absences and leave requests
        const absences = await breathe.getAllEmployeeAbsences(
          mapping.breatheEmployeeId
        );
        const leaveRequests = await breathe.getAllEmployeeLeaveRequests(
          mapping.breatheEmployeeId
        );

        // Build date→leave_request_id map for external_id matching
        const leaveRequestMap = new Map<string, BreatheLeaveRequest>();
        for (const lr of leaveRequests) {
          if (lr.start_date && lr.end_date && lr.id) {
            const key = `${lr.start_date}|${lr.end_date}`;
            leaveRequestMap.set(key, lr);
          }
        }

        console.log(
          `[SyncAbsences] Employee ${mapping.breatheEmployeeId}: ` +
            `${absences.length} absences, ${leaveRequests.length} leave requests`
        );

        // ----------------------------------------------------------
        // A) Sync ABSENCES (approved/cancelled leave)
        // ----------------------------------------------------------
        for (const absence of absences) {
          const syncItem = mapBreatheAbsenceToFlipSync(
            absence,
            mapping.flipUserId,
            policyByExternalId,
            leaveRequestMap
          );
          if (syncItem && syncItem.external_id) {
            syncItems.push(syncItem);
            seenExternalIds.add(syncItem.external_id);
            absenceCount++;
          }
        }

        // ----------------------------------------------------------
        // B) Sync PENDING and DENIED leave requests
        // ----------------------------------------------------------
        // These don't appear in the absences endpoint but must be
        // included in the sync to preserve webhook-created Flip entries.
        for (const lr of leaveRequests) {
          const lrStatus = ((lr.status || '') as string).toLowerCase();
          const externalId = String(lr.id);

          // Skip if already included via an absence (approved leave requests
          // become absences and are handled in section A)
          if (seenExternalIds.has(externalId)) continue;

          if (lrStatus === 'pending') {
            // Include PENDING leave requests so they're preserved in Flip
            const syncItem = mapLeaveRequestToFlipSync(
              lr,
              mapping.flipUserId,
              'PENDING'
            );
            if (syncItem) {
              syncItems.push(syncItem);
              seenExternalIds.add(externalId);
              pendingCount++;
              console.log(
                `[SyncAbsences] Including PENDING leave request ${lr.id}: ` +
                  `${lr.start_date} - ${lr.end_date}`
              );
            }
          } else if (
            lrStatus === 'denied' ||
            lrStatus === 'rejected' ||
            lrStatus === 'declined'
          ) {
            // Include REJECTED leave requests so users see the rejection
            const syncItem = mapLeaveRequestToFlipSync(
              lr,
              mapping.flipUserId,
              'REJECTED'
            );
            if (syncItem) {
              syncItems.push(syncItem);
              seenExternalIds.add(externalId);
              rejectedCount++;
              console.log(
                `[SyncAbsences] Including REJECTED leave request ${lr.id}: ` +
                  `${lr.start_date} - ${lr.end_date}`
              );
            }
          }
        }
      } catch (error) {
        console.error(
          `[SyncAbsences] Error fetching data for employee ${mapping.breatheEmployeeId}:`,
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

    const totalSynced = absenceCount + pendingCount + rejectedCount;
    console.log(
      `[SyncAbsences] Sync complete. ` +
        `Absences: ${absenceCount}, Pending: ${pendingCount}, ` +
        `Rejected: ${rejectedCount}, Total: ${totalSynced}, Errors: ${errorCount}`
    );

    res.status(200).json({
      status: 'ok',
      sync_id: syncId,
      synced: totalSynced,
      absences: absenceCount,
      pending: pendingCount,
      rejected: rejectedCount,
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
 *
 * Uses leave_request.id as external_id when a matching leave request
 * exists (for webhook-created entries), otherwise falls back to absence.id.
 */
function mapBreatheAbsenceToFlipSync(
  absence: BreatheAbsence,
  flipUserId: string,
  policyByExternalId: Map<string, string>,
  leaveRequestMap: Map<string, BreatheLeaveRequest>
): FlipSyncAbsenceRequest | null {
  const isCancelled =
    (absence as Record<string, unknown>).cancelled === true ||
    (absence as Record<string, unknown>).cancelled === 'true';
  const status: AbsenceRequestStatus = isCancelled ? 'CANCELLED' : 'APPROVED';

  // Use leave_request.id as external_id when available (matches webhook entries)
  const dateKey = `${absence.start_date}|${absence.end_date}`;
  const matchingLR = leaveRequestMap.get(dateKey);
  const externalId = matchingLR ? String(matchingLR.id) : String(absence.id);

  // Determine the policy
  let policyExternalId = 'annual_leave';
  if (absence.leave_reason) {
    const leaveReasonId =
      (absence as Record<string, unknown>).leave_reason_id ||
      (absence as Record<string, unknown>).other_leave_reason_id;
    if (leaveReasonId && policyByExternalId.has(String(leaveReasonId))) {
      policyExternalId = String(leaveReasonId);
    }
  }

  const startsFromType = absence.half_start ? 'SECOND_HALF' : undefined;
  const endsAtType = absence.half_end ? 'FIRST_HALF' : undefined;

  return {
    id: null,
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

/**
 * Map a BreatheHR leave request (pending or rejected) to Flip's sync format
 *
 * Used for leave requests that haven't become absences yet (still pending)
 * or were rejected/denied. Including these in the sync prevents the
 * full-replacement lifecycle from destroying webhook-created Flip entries.
 */
function mapLeaveRequestToFlipSync(
  lr: BreatheLeaveRequest,
  flipUserId: string,
  status: AbsenceRequestStatus
): FlipSyncAbsenceRequest | null {
  if (!lr.start_date || !lr.end_date) return null;

  const startsFromType = (lr.half_start || lr.start_half_day)
    ? 'SECOND_HALF'
    : undefined;
  const endsAtType = (lr.half_end || lr.end_half_day)
    ? 'FIRST_HALF'
    : undefined;

  return {
    id: null,
    external_id: String(lr.id),
    approver: null,
    absentee: flipUserId,
    duration: undefined,
    policy: {
      external_id: 'annual_leave',
    },
    requestor_comment: lr.notes || null,
    status,
    last_updated: lr.updated_at || null,
    starts_from: {
      date: `${lr.start_date}T00:00:00`,
      type: startsFromType,
    },
    ends_at: {
      date: `${lr.end_date}T00:00:00`,
      type: endsAtType,
    },
  };
}
