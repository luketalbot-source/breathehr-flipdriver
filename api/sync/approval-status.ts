import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BreatheHRClient } from '../../lib/breathehr';
import { FlipClient } from '../../lib/flip';
import { UserMappingService } from '../../lib/user-mapping';
import type { BreatheAbsence } from '../../lib/types';

/**
 * Check approval status of pending absence requests and trigger Flip notifications
 *
 * POST /api/sync/approval-status
 *
 * Problem: Flip's bulk sync endpoint does NOT trigger user notifications.
 * Only the individual approve/reject endpoints send notifications.
 *
 * Flow:
 * 1. User books vacation in Flip → webhook → creates BreatheHR leave request
 *    → patches Flip absence request with external_id = BreatheHR leave_request.id
 *    → Flip absence request stays PENDING
 *
 * 2. Manager approves/rejects in BreatheHR
 *
 * 3. This endpoint detects the status change and calls Flip's
 *    approve/reject endpoints → triggers push notification to user
 *
 * IMPORTANT: BreatheHR leave_request IDs ≠ absence IDs.
 * The webhook stores the leave_request.id as external_id in Flip.
 * When approved, a separate absence record is created with a different ID.
 * After approving in Flip, we update the external_id to the absence ID
 * so the bulk absence sync doesn't create duplicates.
 *
 * This runs BEFORE the bulk absence sync in the cron job.
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
    console.log('[ApprovalStatus] Starting approval status check...');

    const breathe = new BreatheHRClient();
    const flip = new FlipClient();
    const userMapping = new UserMappingService(breathe, flip);

    const mappings = await userMapping.getAllMappings();
    console.log(`[ApprovalStatus] Checking ${mappings.length} mapped users`);

    let approvedCount = 0;
    let rejectedCount = 0;
    let stillPending = 0;
    let errorCount = 0;
    const details: string[] = [];

    for (const mapping of mappings) {
      try {
        // Pre-fetch absences for this employee (used for both approval
        // detection and external_id reconciliation after approval)
        const absences = await breathe.getAllEmployeeAbsences(
          mapping.breatheEmployeeId
        );

        console.log(
          `[ApprovalStatus] Employee ${mapping.breatheEmployeeId}: ` +
            `${absences.length} absences`
        );

        // ---------------------------------------------------------------
        // STEP 1: Check BreatheHR LEAVE REQUESTS for status changes
        // ---------------------------------------------------------------
        // The webhook stores leave_request.id as external_id in Flip.
        // When the leave request is approved/rejected in BreatheHR,
        // we call Flip's approve/reject endpoints to trigger notifications.
        //
        // After approving, we also update the external_id to the
        // corresponding BreatheHR absence ID (which is different from
        // the leave request ID) to prevent the bulk sync from creating
        // duplicate entries.
        // ---------------------------------------------------------------

        try {
          const leaveRequests = await breathe.getAllEmployeeLeaveRequests(
            mapping.breatheEmployeeId
          );

          console.log(
            `[ApprovalStatus] Employee ${mapping.breatheEmployeeId}: ` +
              `${leaveRequests.length} leave requests`
          );

          for (const lr of leaveRequests) {
            const rawStatus = (lr.status || '') as string;
            const rawAction = (lr.action || '') as string;
            const status = rawStatus.toLowerCase();
            const action = rawAction.toLowerCase();

            console.log(
              `[ApprovalStatus] Leave request ${lr.id}: status="${rawStatus}", action="${rawAction}"`
            );

            // Check if rejected
            const isRejected =
              status === 'rejected' ||
              status === 'declined' ||
              action === 'reject' ||
              action === 'decline' ||
              action === 'declined';

            // Check if approved
            const isApproved =
              status === 'approved' ||
              action === 'approve' ||
              action === 'approved';

            if (!isRejected && !isApproved) {
              if (status === 'pending' || status === '' || !status) {
                stillPending++;
              }
              continue;
            }

            // Try to find matching PENDING Flip absence request
            try {
              const flipRequest = await flip.getAbsenceRequestByExternalId(
                String(lr.id)
              );

              if (!flipRequest || flipRequest.status !== 'PENDING') {
                // Already processed or not a webhook-created request
                continue;
              }

              if (isApproved) {
                console.log(
                  `[ApprovalStatus] Leave request ${lr.id} approved in BreatheHR → ` +
                    `approving Flip request ${flipRequest.id}`
                );

                await flip.approveAbsenceRequest(mapping.flipUserId, {
                  external_id: String(lr.id),
                });

                approvedCount++;
                details.push(
                  `approved: LR ${lr.id} → Flip ${flipRequest.id} (${lr.start_date} - ${lr.end_date})`
                );
                console.log(
                  `[ApprovalStatus] ✓ Approved in Flip — notification sent`
                );

                // -------------------------------------------------------
                // RECONCILE: Update external_id to match the BreatheHR
                // absence ID so the bulk absence sync doesn't create
                // a duplicate entry.
                //
                // BreatheHR leave_request.id ≠ absence.id
                // The webhook stored leave_request.id, but the absence
                // sync uses absence.id. We update to the absence ID.
                // -------------------------------------------------------
                await reconcileExternalId(
                  flip,
                  flipRequest.id,
                  lr,
                  absences,
                  mapping.breatheEmployeeId
                );
              } else if (isRejected) {
                console.log(
                  `[ApprovalStatus] Leave request ${lr.id} rejected in BreatheHR → ` +
                    `rejecting Flip request ${flipRequest.id}`
                );

                await flip.rejectAbsenceRequest(mapping.flipUserId, {
                  external_id: String(lr.id),
                });

                rejectedCount++;
                details.push(
                  `rejected: LR ${lr.id} → Flip ${flipRequest.id}`
                );
                console.log(
                  `[ApprovalStatus] ✗ Rejected in Flip — notification sent`
                );
              }
            } catch {
              // No matching Flip request — this leave request wasn't
              // created via our webhook (most common case)
            }
          }
        } catch (leaveError) {
          console.log(
            `[ApprovalStatus] Could not fetch leave requests for employee ` +
              `${mapping.breatheEmployeeId}: ` +
              `${leaveError instanceof Error ? leaveError.message : leaveError}`
          );
        }

        // ---------------------------------------------------------------
        // STEP 2: Safety net — check absences by absence ID
        // ---------------------------------------------------------------
        // In case the external_id was set to the absence ID (not leave
        // request ID), also check absences directly. This handles edge
        // cases and manually created entries.
        // ---------------------------------------------------------------

        for (const absence of absences) {
          const isCancelled =
            (absence as Record<string, unknown>).cancelled === true ||
            (absence as Record<string, unknown>).cancelled === 'true';
          if (isCancelled) continue;

          try {
            const flipRequest = await flip.getAbsenceRequestByExternalId(
              String(absence.id)
            );

            if (flipRequest && flipRequest.status === 'PENDING') {
              console.log(
                `[ApprovalStatus] Found PENDING Flip request by absence ID ${absence.id} → approving`
              );

              await flip.approveAbsenceRequest(mapping.flipUserId, {
                external_id: String(absence.id),
              });

              approvedCount++;
              details.push(
                `approved: absence ${absence.id} (${absence.start_date} - ${absence.end_date})`
              );
              console.log(
                `[ApprovalStatus] ✓ Approved absence ${absence.id} in Flip`
              );
            }
          } catch {
            // No matching Flip request by absence ID — expected for most
          }
        }
      } catch (error) {
        console.error(
          `[ApprovalStatus] Error processing user ${mapping.flipUserId}:`,
          error
        );
        errorCount++;
      }
    }

    console.log(
      `[ApprovalStatus] Complete. ` +
        `Approved: ${approvedCount}, Rejected: ${rejectedCount}, ` +
        `Still pending: ${stillPending}, Errors: ${errorCount}`
    );

    res.status(200).json({
      status: 'ok',
      approved: approvedCount,
      rejected: rejectedCount,
      still_pending: stillPending,
      errors: errorCount,
      details: details.length > 0 ? details : undefined,
    });
  } catch (error) {
    console.error('[ApprovalStatus] Error:', error);
    res.status(500).json({
      error: 'Approval status check failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * After approving a Flip absence request, update its external_id from the
 * BreatheHR leave_request.id to the BreatheHR absence.id.
 *
 * This prevents the bulk absence sync from creating a duplicate entry
 * (since the sync uses absence IDs, not leave request IDs).
 */
async function reconcileExternalId(
  flip: FlipClient,
  flipRequestId: string,
  leaveRequest: { id: number; start_date: string; end_date: string },
  absences: BreatheAbsence[],
  employeeId: number
): Promise<void> {
  // Find the BreatheHR absence that matches this leave request's dates
  const matchingAbsence = absences.find(
    (a) =>
      a.start_date === leaveRequest.start_date &&
      a.end_date === leaveRequest.end_date &&
      !((a as Record<string, unknown>).cancelled === true ||
        (a as Record<string, unknown>).cancelled === 'true')
  );

  if (matchingAbsence) {
    console.log(
      `[ApprovalStatus] Reconciling external_id: ` +
        `leave_request ${leaveRequest.id} → absence ${matchingAbsence.id} ` +
        `(${leaveRequest.start_date} - ${leaveRequest.end_date})`
    );

    try {
      await flip.patchAbsenceRequestExternalId(
        flipRequestId,
        String(matchingAbsence.id)
      );
      console.log(
        `[ApprovalStatus] ✓ Updated external_id to ${matchingAbsence.id}`
      );
    } catch (error) {
      console.warn(
        `[ApprovalStatus] Could not update external_id: ` +
          `${error instanceof Error ? error.message : error}`
      );
    }
  } else {
    console.log(
      `[ApprovalStatus] No matching absence found for leave request ${leaveRequest.id} ` +
        `(employee ${employeeId}, ${leaveRequest.start_date} - ${leaveRequest.end_date}). ` +
        `The absence may not exist yet. Will reconcile on next cron run.`
    );
  }
}
