import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BreatheHRClient } from '../../lib/breathehr';
import { FlipClient } from '../../lib/flip';
import { UserMappingService } from '../../lib/user-mapping';

/**
 * Approval Check — Lightweight polling endpoint
 *
 * GET/POST /api/sync/approval-check
 *
 * Runs frequently (every 2 minutes via Vercel cron) to detect when
 * BreatheHR approves or rejects a leave request, then immediately
 * calls the Flip approve/reject endpoint to trigger push notifications.
 *
 * This is separate from the full absence sync (/api/sync/absences) which
 * handles data consistency via Flip's bulk sync lifecycle. The bulk sync
 * does NOT trigger notifications — only the approve/reject endpoints do.
 *
 * Flow:
 * 1. Get all mapped users (Flip ↔ BreatheHR)
 * 2. For each user, fetch their BreatheHR leave requests
 * 3. Find leave requests that are "approved" or "denied" (with action=request)
 * 4. Look up the corresponding Flip absence request by external_id
 * 5. If the Flip request is still PENDING → call approve/reject endpoint
 *    (this triggers the push notification in Flip)
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
    console.log('[ApprovalCheck] Starting approval check...');

    const breathe = new BreatheHRClient();
    const flip = new FlipClient();
    const userMapping = new UserMappingService(breathe, flip);

    // 1. Get all user mappings
    const mappings = await userMapping.getAllMappings();
    console.log(
      `[ApprovalCheck] Checking ${mappings.length} mapped users`
    );

    let approved = 0;
    let rejected = 0;
    let checked = 0;
    let skipped = 0;
    let errors = 0;
    const actions: Array<{
      external_id: string;
      breathe_status: string;
      flip_status: string;
      action: string;
      error?: string;
    }> = [];

    for (const mapping of mappings) {
      try {
        // 2. Fetch BreatheHR leave requests for this user
        const leaveRequests = await breathe.getAllEmployeeLeaveRequests(
          mapping.breatheEmployeeId
        );

        for (const lr of leaveRequests) {
          const lrStatus = ((lr.status || '') as string).toLowerCase();
          const lrAction = ((lr.action || '') as string).toLowerCase();

          // Only check "request" actions (not "cancel" actions)
          if (lrAction !== 'request') continue;

          // Only check leave requests that BreatheHR has decided on
          const isApproved = lrStatus === 'approved';
          const isRejected =
            lrStatus === 'denied' ||
            lrStatus === 'rejected' ||
            lrStatus === 'declined';

          if (!isApproved && !isRejected) continue;

          const externalId = String(lr.id);
          checked++;

          // 3. Look up the corresponding Flip absence request
          try {
            const flipRequest =
              await flip.getAbsenceRequestByExternalId(externalId);

            if (!flipRequest || !flipRequest.status) {
              skipped++;
              continue;
            }

            // 4. If Flip request is still PENDING, trigger the notification
            if (flipRequest.status === 'PENDING') {
              if (isApproved) {
                console.log(
                  `[ApprovalCheck] 🔔 Approving Flip request ` +
                    `(ext=${externalId}, flip=${flipRequest.id}) — ` +
                    `BreatheHR approved, Flip still PENDING`
                );

                await flip.approveAbsenceRequest(mapping.flipUserId, {
                  external_id: externalId,
                });

                approved++;
                actions.push({
                  external_id: externalId,
                  breathe_status: lrStatus,
                  flip_status: 'PENDING',
                  action: 'APPROVED',
                });
              } else if (isRejected) {
                console.log(
                  `[ApprovalCheck] 🔔 Rejecting Flip request ` +
                    `(ext=${externalId}, flip=${flipRequest.id}) — ` +
                    `BreatheHR denied, Flip still PENDING`
                );

                await flip.rejectAbsenceRequest(mapping.flipUserId, {
                  external_id: externalId,
                });

                rejected++;
                actions.push({
                  external_id: externalId,
                  breathe_status: lrStatus,
                  flip_status: 'PENDING',
                  action: 'REJECTED',
                });
              }
            } else {
              // Already processed — Flip status matches BreatheHR decision
              skipped++;
            }
          } catch (flipErr) {
            // Not found in Flip — this leave request wasn't created via webhook
            // (e.g., it was created directly in BreatheHR, not through Flip)
            skipped++;
          }
        }
      } catch (userErr) {
        console.error(
          `[ApprovalCheck] Error checking employee ${mapping.breatheEmployeeId}:`,
          userErr
        );
        errors++;
      }
    }

    console.log(
      `[ApprovalCheck] Done. ` +
        `Checked: ${checked}, Approved: ${approved}, Rejected: ${rejected}, ` +
        `Skipped: ${skipped}, Errors: ${errors}`
    );

    res.status(200).json({
      status: 'ok',
      checked,
      approved,
      rejected,
      skipped,
      errors,
      actions,
    });
  } catch (error) {
    console.error('[ApprovalCheck] Error:', error);
    res.status(500).json({
      error: 'Approval check failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
