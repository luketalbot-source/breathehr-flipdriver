import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BreatheHRClient } from '../../lib/breathehr';
import { FlipClient } from '../../lib/flip';
import { UserMappingService } from '../../lib/user-mapping';

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
        // ---------------------------------------------------------------
        // STEP 1: Check BreatheHR ABSENCES for approved leave
        // ---------------------------------------------------------------
        // In BreatheHR, approved leave requests become "absences".
        // For each absence, check if the corresponding Flip request
        // is still PENDING → if so, approve it via the proper endpoint.
        // ---------------------------------------------------------------

        const absences = await breathe.getAllEmployeeAbsences(
          mapping.breatheEmployeeId
        );

        console.log(
          `[ApprovalStatus] Employee ${mapping.breatheEmployeeId}: ` +
          `${absences.length} absences`
        );

        for (const absence of absences) {
          // Skip cancelled absences
          const isCancelled =
            (absence as Record<string, unknown>).cancelled === true ||
            (absence as Record<string, unknown>).cancelled === 'true';
          if (isCancelled) continue;

          // Try to find matching PENDING Flip absence request
          try {
            const flipRequest = await flip.getAbsenceRequestByExternalId(
              String(absence.id)
            );

            if (flipRequest && flipRequest.status === 'PENDING') {
              console.log(
                `[ApprovalStatus] Found PENDING Flip request for BreatheHR absence ${absence.id} → approving`
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
            // No matching Flip request — normal for absences not created
            // via our webhook (e.g., historical data synced via bulk sync)
          }
        }

        // ---------------------------------------------------------------
        // STEP 2: Check BreatheHR LEAVE REQUESTS for rejections
        // ---------------------------------------------------------------
        // Rejected leave requests don't become absences, so we need to
        // check the leave_requests endpoint separately.
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
            // Log the raw status fields so we can see what BreatheHR returns
            const rawStatus = (lr.status || '') as string;
            const rawAction = (lr.action || '') as string;
            const status = rawStatus.toLowerCase();
            const action = rawAction.toLowerCase();

            if (status || action) {
              console.log(
                `[ApprovalStatus] Leave request ${lr.id}: status="${rawStatus}", action="${rawAction}"`
              );
            }

            // Check if rejected
            const isRejected =
              status === 'rejected' ||
              status === 'declined' ||
              action === 'reject' ||
              action === 'decline' ||
              action === 'declined';

            // Also check if approved via leave request status
            // (some leave requests might show approved status before
            // appearing in the absences endpoint)
            const isApproved =
              status === 'approved' ||
              action === 'approve' ||
              action === 'approved';

            if (!isRejected && !isApproved) {
              // Still pending or unknown status
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

              if (flipRequest && flipRequest.status === 'PENDING') {
                if (isRejected) {
                  console.log(
                    `[ApprovalStatus] Found PENDING Flip request for rejected leave request ${lr.id} → rejecting`
                  );

                  await flip.rejectAbsenceRequest(mapping.flipUserId, {
                    external_id: String(lr.id),
                  });

                  rejectedCount++;
                  details.push(`rejected: leave request ${lr.id}`);
                  console.log(
                    `[ApprovalStatus] ✗ Rejected leave request ${lr.id} in Flip`
                  );
                } else if (isApproved) {
                  // Approve via leave request (backup for step 1)
                  console.log(
                    `[ApprovalStatus] Found PENDING Flip request for approved leave request ${lr.id} → approving`
                  );

                  await flip.approveAbsenceRequest(mapping.flipUserId, {
                    external_id: String(lr.id),
                  });

                  approvedCount++;
                  details.push(`approved: leave request ${lr.id}`);
                  console.log(
                    `[ApprovalStatus] ✓ Approved leave request ${lr.id} in Flip`
                  );
                }
              }
            } catch {
              // No matching Flip request — this leave request wasn't
              // created via our webhook
            }
          }
        } catch (leaveError) {
          // The employee leave_requests endpoint might not exist
          // or the employee might not have permission
          console.log(
            `[ApprovalStatus] Could not fetch leave requests for employee ${mapping.breatheEmployeeId}: ` +
            `${leaveError instanceof Error ? leaveError.message : leaveError}`
          );
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
