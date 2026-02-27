import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BreatheHRClient } from '../../lib/breathehr';
import { FlipClient } from '../../lib/flip';
import { UserMappingService } from '../../lib/user-mapping';

/**
 * Resolve the approver for a given Flip user.
 *
 * Looks up the user's "manger_id" attribute in Flip. If not found,
 * falls back to a hardcoded admin user. The approver MUST be different
 * from the absentee to ensure push notifications are triggered.
 */
async function resolveApprover(
  flip: FlipClient,
  flipUserId: string,
  managerCache: Map<string, string>
): Promise<string> {
  // Check cache first
  if (managerCache.has(flipUserId)) {
    return managerCache.get(flipUserId)!;
  }

  try {
    const user = await flip.getUser(flipUserId);
    // Flip returns attributes as an array of {name, value} objects
    const attrs = user.attributes as Array<{ name: string; value: string }> | undefined;
    if (attrs && Array.isArray(attrs)) {
      const managerAttr = attrs.find(
        (a) => a.name === 'manger_id' || a.name === 'manager_id'
      );
      if (managerAttr?.value) {
        console.log(
          `[ApprovalCheck] Resolved manager for ${flipUserId}: ${managerAttr.value}`
        );
        managerCache.set(flipUserId, managerAttr.value);
        return managerAttr.value;
      }
    }
  } catch (err) {
    console.warn(
      `[ApprovalCheck] Could not look up manager for ${flipUserId}:`,
      err instanceof Error ? err.message : err
    );
  }

  // Fallback: use the absentee themselves (less ideal but won't break)
  console.warn(
    `[ApprovalCheck] No manager found for ${flipUserId}, falling back to self-approval`
  );
  managerCache.set(flipUserId, flipUserId);
  return flipUserId;
}

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
 * IMPORTANT: The approver must NOT be the same as the absentee.
 * Self-approval may suppress notifications. We look up the user's
 * manager (from Flip user attributes "manger_id") and use them as
 * the approver. Falls back to a hardcoded admin if no manager is found.
 *
 * Flow:
 * 1. Get all mapped users (Flip ↔ BreatheHR)
 * 2. For each user, fetch their BreatheHR leave requests
 * 3. Find leave requests that are "approved" or "denied" (with action=request)
 * 4. Look up the corresponding Flip absence request by external_id
 * 5. Resolve the user's Flip manager to use as approver
 * 6. If the Flip request is still PENDING → call approve/reject endpoint
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

    // Cache manager lookups to avoid repeated API calls
    const managerCache = new Map<string, string>();

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
      approver?: string;
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

          // 3. Look up the corresponding Flip absence request
          // Many BreatheHR leave requests won't have Flip counterparts
          // (created in BreatheHR directly, not via Flip webhook) — skip silently
          let flipRequest;
          try {
            flipRequest =
              await flip.getAbsenceRequestByExternalId(externalId);
          } catch {
            // Not found in Flip — skip silently
            continue;
          }

          if (!flipRequest || !flipRequest.status) {
            continue;
          }

          // Only count items that have a Flip counterpart
          checked++;

          // 4. If Flip request is still PENDING, trigger the notification
          if (flipRequest.status === 'PENDING') {
            // 5. Resolve the approver — must be the manager, NOT the absentee
            const approverId = await resolveApprover(
              flip,
              mapping.flipUserId,
              managerCache
            );

            if (isApproved) {
              console.log(
                `[ApprovalCheck] 🔔 Approving Flip request ` +
                  `(ext=${externalId}, flip=${flipRequest.id}) — ` +
                  `BreatheHR approved, Flip still PENDING. ` +
                  `Approver: ${approverId} (absentee: ${mapping.flipUserId})`
              );

              await flip.approveAbsenceRequest(approverId, {
                external_id: externalId,
              });

              approved++;
              actions.push({
                external_id: externalId,
                breathe_status: lrStatus,
                flip_status: 'PENDING',
                action: 'APPROVED',
                approver: approverId,
              });
            } else if (isRejected) {
              console.log(
                `[ApprovalCheck] 🔔 Rejecting Flip request ` +
                  `(ext=${externalId}, flip=${flipRequest.id}) — ` +
                  `BreatheHR denied, Flip still PENDING. ` +
                  `Approver: ${approverId} (absentee: ${mapping.flipUserId})`
              );

              await flip.rejectAbsenceRequest(approverId, {
                external_id: externalId,
              });

              rejected++;
              actions.push({
                external_id: externalId,
                breathe_status: lrStatus,
                flip_status: 'PENDING',
                action: 'REJECTED',
                approver: approverId,
              });
            }
          } else {
            // Already processed — Flip status matches BreatheHR decision
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
