import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BreatheHRClient } from '../../lib/breathehr';
import { FlipClient } from '../../lib/flip';
import { UserMappingService } from '../../lib/user-mapping';
import type { BreatheLeaveRequest } from '../../lib/types';

/**
 * Check approval status of pending absence requests and trigger Flip notifications
 *
 * POST /api/sync/approval-status
 *
 * Problem: Flip's bulk sync endpoint does NOT trigger user notifications.
 * Only the individual approve/reject endpoints send notifications.
 *
 * APPROVAL DETECTION STRATEGY:
 * We do NOT rely on BreatheHR leave_request.status being "approved" because
 * BreatheHR may remove approved leave requests from the leave_requests endpoint
 * (they become absences instead). Instead, we detect approval by:
 *   - A BreatheHR ABSENCE exists (proof of approval)
 *   - The corresponding Flip absence request is still PENDING
 *   - We match absence→leave_request by date range to find the external_id
 *
 * REJECTION DETECTION:
 * Rejected leave requests remain in the leave_requests endpoint with status
 * "denied". We check for that and call Flip's reject endpoint.
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
    // Track external_ids we've already processed to avoid double-processing
    const processedExternalIds = new Set<string>();

    for (const mapping of mappings) {
      try {
        // Fetch both absences and leave requests for this employee
        const absences = await breathe.getAllEmployeeAbsences(
          mapping.breatheEmployeeId
        );
        let leaveRequests: BreatheLeaveRequest[] = [];
        try {
          leaveRequests = await breathe.getAllEmployeeLeaveRequests(
            mapping.breatheEmployeeId
          );
        } catch (lrError) {
          console.log(
            `[ApprovalStatus] Could not fetch leave requests for employee ` +
              `${mapping.breatheEmployeeId}: ` +
              `${lrError instanceof Error ? lrError.message : lrError}`
          );
        }

        console.log(
          `[ApprovalStatus] Employee ${mapping.breatheEmployeeId}: ` +
            `${absences.length} absences, ${leaveRequests.length} leave requests`
        );

        // Build date→leave_request map for matching absences to leave requests
        // The webhook stores leave_request.id as external_id in Flip
        const leaveRequestsByDate = new Map<string, BreatheLeaveRequest[]>();
        for (const lr of leaveRequests) {
          if (lr.start_date && lr.end_date && lr.id) {
            const key = `${lr.start_date}|${lr.end_date}`;
            const existing = leaveRequestsByDate.get(key) || [];
            existing.push(lr);
            leaveRequestsByDate.set(key, existing);
          }
        }

        // ---------------------------------------------------------------
        // STEP 1: APPROVAL DETECTION (from absences)
        // ---------------------------------------------------------------
        // When a leave request is approved in BreatheHR, an absence record
        // is created. We detect approval by finding absences that have a
        // corresponding PENDING Flip request.
        //
        // We try two external_id lookups per absence:
        // a) leave_request.id (set by webhook — most common)
        // b) absence.id (fallback for non-webhook or legacy entries)
        // ---------------------------------------------------------------

        for (const absence of absences) {
          const isCancelled =
            (absence as Record<string, unknown>).cancelled === true ||
            (absence as Record<string, unknown>).cancelled === 'true';
          if (isCancelled) continue;

          // a) Try to find matching leave request by dates → use lr.id as external_id
          const dateKey = `${absence.start_date}|${absence.end_date}`;
          const matchingLRs = leaveRequestsByDate.get(dateKey) || [];

          let approvedViaLR = false;

          for (const matchingLR of matchingLRs) {
            const externalId = String(matchingLR.id);
            if (processedExternalIds.has(externalId)) continue;

            try {
              const flipRequest = await flip.getAbsenceRequestByExternalId(externalId);

              console.log(
                `[ApprovalStatus] Lookup by lr.id ${externalId}: ` +
                  `found Flip request ${flipRequest.id}, status=${flipRequest.status}`
              );

              if (flipRequest && flipRequest.status === 'PENDING') {
                console.log(
                  `[ApprovalStatus] Absence ${absence.id} exists → ` +
                    `leave request ${matchingLR.id} approved in BreatheHR → ` +
                    `approving Flip request ${flipRequest.id}`
                );

                await flip.approveAbsenceRequest(mapping.flipUserId, {
                  external_id: externalId,
                });

                approvedCount++;
                processedExternalIds.add(externalId);
                details.push(
                  `approved: LR ${matchingLR.id} / absence ${absence.id} → ` +
                    `Flip ${flipRequest.id} (${absence.start_date} - ${absence.end_date})`
                );
                console.log(
                  `[ApprovalStatus] ✓ Approved in Flip — notification sent`
                );

                approvedViaLR = true;
                break; // Don't try other LRs for this absence
              }
            } catch (lookupError) {
              console.log(
                `[ApprovalStatus] No Flip request found for lr.id ${externalId}: ` +
                  `${lookupError instanceof Error ? lookupError.message : 'not found'}`
              );
            }
          }

          // b) Fallback: try absence.id as external_id
          if (!approvedViaLR) {
            const absenceExternalId = String(absence.id);
            if (!processedExternalIds.has(absenceExternalId)) {
              try {
                const flipRequest = await flip.getAbsenceRequestByExternalId(absenceExternalId);

                console.log(
                  `[ApprovalStatus] Lookup by absence.id ${absenceExternalId}: ` +
                    `found Flip request ${flipRequest.id}, status=${flipRequest.status}`
                );

                if (flipRequest && flipRequest.status === 'PENDING') {
                  console.log(
                    `[ApprovalStatus] Found PENDING Flip request by absence ID ${absence.id} → approving`
                  );

                  await flip.approveAbsenceRequest(mapping.flipUserId, {
                    external_id: absenceExternalId,
                  });

                  approvedCount++;
                  processedExternalIds.add(absenceExternalId);
                  details.push(
                    `approved: absence ${absence.id} → Flip ${flipRequest.id} ` +
                      `(${absence.start_date} - ${absence.end_date})`
                  );
                  console.log(
                    `[ApprovalStatus] ✓ Approved absence ${absence.id} in Flip — notification sent`
                  );
                }
              } catch {
                // No matching Flip request by absence ID — expected for most absences
              }
            }
          }
        }

        // ---------------------------------------------------------------
        // STEP 2: REJECTION DETECTION (from leave requests)
        // ---------------------------------------------------------------
        // Rejected leave requests stay in BreatheHR's leave_requests endpoint
        // with status "denied" (BreatheHR's term for rejected).
        // We call Flip's reject endpoint to trigger the rejection notification.
        //
        // Also check for rejection reasons/comments from the manager to
        // include in the Flip update.
        // ---------------------------------------------------------------

        for (const lr of leaveRequests) {
          const rawStatus = ((lr.status || '') as string).toLowerCase();
          const rawAction = ((lr.action || '') as string).toLowerCase();

          console.log(
            `[ApprovalStatus] Leave request ${lr.id}: ` +
              `status="${lr.status}", action="${lr.action}"`
          );

          // Check if rejected
          const isRejected =
            rawStatus === 'rejected' ||
            rawStatus === 'declined' ||
            rawStatus === 'denied' ||
            rawAction === 'reject' ||
            rawAction === 'decline' ||
            rawAction === 'declined' ||
            rawAction === 'denied' ||
            rawAction === 'deny';

          if (!isRejected) {
            if (rawStatus === 'pending' || rawStatus === '' || !rawStatus) {
              stillPending++;
            }
            continue;
          }

          const externalId = String(lr.id);
          if (processedExternalIds.has(externalId)) continue;

          // Log all fields for denied leave requests (helps debug what
          // rejection reason fields BreatheHR provides)
          console.log(
            `[ApprovalStatus] DENIED leave request ${lr.id} raw data: ` +
              JSON.stringify(lr, null, 2)
          );

          // Try to find the manager's rejection reason/comment
          // BreatheHR may use various field names for this
          const raw = lr as Record<string, unknown>;
          const rejectionReason =
            (raw.rejection_reason as string) ||
            (raw.declined_reason as string) ||
            (raw.reject_reason as string) ||
            (raw.reviewer_notes as string) ||
            (raw.reviewer_comment as string) ||
            (raw.manager_comment as string) ||
            (raw.manager_notes as string) ||
            (raw.approver_comment as string) ||
            (raw.reason as string) ||
            (raw.denial_reason as string) ||
            null;

          if (rejectionReason) {
            console.log(
              `[ApprovalStatus] Rejection reason for LR ${lr.id}: "${rejectionReason}"`
            );
          }

          try {
            const flipRequest = await flip.getAbsenceRequestByExternalId(externalId);

            console.log(
              `[ApprovalStatus] Rejection lookup by lr.id ${externalId}: ` +
                `found Flip request ${flipRequest.id}, status=${flipRequest.status}`
            );

            if (!flipRequest || flipRequest.status !== 'PENDING') {
              // Already processed
              continue;
            }

            console.log(
              `[ApprovalStatus] Leave request ${lr.id} rejected in BreatheHR → ` +
                `rejecting Flip request ${flipRequest.id}`
            );

            await flip.rejectAbsenceRequest(mapping.flipUserId, {
              external_id: externalId,
            });

            rejectedCount++;
            processedExternalIds.add(externalId);
            details.push(
              `rejected: LR ${lr.id} → Flip ${flipRequest.id}` +
                (rejectionReason ? ` (reason: ${rejectionReason})` : '')
            );
            console.log(
              `[ApprovalStatus] ✗ Rejected in Flip — notification sent`
            );

            // If there's a rejection reason, store it for the absence sync
            // to include in the requestor_comment field
            if (rejectionReason) {
              console.log(
                `[ApprovalStatus] Rejection reason available: "${rejectionReason}". ` +
                  `This will be included in the absence sync's requestor_comment.`
              );
            }
          } catch (lookupError) {
            console.log(
              `[ApprovalStatus] No Flip request found for rejected lr.id ${externalId}: ` +
                `${lookupError instanceof Error ? lookupError.message : 'not found'}`
            );
          }
        }

        // ---------------------------------------------------------------
        // STEP 3 (secondary): Check for approved leave requests by status
        // ---------------------------------------------------------------
        // Some BreatheHR setups may keep approved leave requests visible
        // with status="approved". This is a secondary check in case
        // the absence-based detection (Step 1) missed something.
        // ---------------------------------------------------------------

        for (const lr of leaveRequests) {
          const rawStatus = ((lr.status || '') as string).toLowerCase();
          const rawAction = ((lr.action || '') as string).toLowerCase();

          const isApproved =
            rawStatus === 'approved' ||
            rawAction === 'approve' ||
            rawAction === 'approved';

          if (!isApproved) continue;

          const externalId = String(lr.id);
          if (processedExternalIds.has(externalId)) continue;

          try {
            const flipRequest = await flip.getAbsenceRequestByExternalId(externalId);

            if (flipRequest && flipRequest.status === 'PENDING') {
              console.log(
                `[ApprovalStatus] (secondary) Leave request ${lr.id} has status "approved" → ` +
                  `approving Flip request ${flipRequest.id}`
              );

              await flip.approveAbsenceRequest(mapping.flipUserId, {
                external_id: externalId,
              });

              approvedCount++;
              processedExternalIds.add(externalId);
              details.push(
                `approved (via LR status): LR ${lr.id} → Flip ${flipRequest.id} ` +
                  `(${lr.start_date} - ${lr.end_date})`
              );
              console.log(
                `[ApprovalStatus] ✓ Approved in Flip (secondary) — notification sent`
              );
            }
          } catch {
            // No matching Flip request
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
