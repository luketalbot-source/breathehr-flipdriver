import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BreatheHRClient } from '../../lib/breathehr';
import { FlipClient } from '../../lib/flip';
import { UserMappingService } from '../../lib/user-mapping';
import { logWebhook, getWebhookLogs } from '../../lib/webhook-log';

const breathe = new BreatheHRClient();
const flip = new FlipClient();
const userMapping = new UserMappingService(breathe, flip);

/**
 * Webhook handler for absence request events from Flip
 *
 * GET  /api/webhooks/absence-request  → View recent webhook logs
 * POST /api/webhooks/absence-request  → Handle webhook events
 *
 * Flip sends batched webhook payloads:
 * {
 *   "id": "batch-uuid",
 *   "items": [
 *     {
 *       "type": "hr.absence.requested",
 *       "data": { "id": "...", "absentee": "user-uuid", ... },
 *       "timestamp": "..."
 *     }
 *   ],
 *   "recipient": "...",
 *   "tenant": "..."
 * }
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // GET: Return recent webhook logs for debugging
  if (req.method === 'GET') {
    res.status(200).json({ logs: getWebhookLogs() });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Log the raw incoming webhook
  const logEntry = {
    timestamp: new Date().toISOString(),
    method: req.method,
    headers: {
      'content-type': req.headers['content-type'] as string || '',
      'user-agent': req.headers['user-agent'] as string || '',
    },
    body: req.body,
    result: undefined as string | undefined,
    error: undefined as string | undefined,
  };

  try {
    const payload = req.body;
    const items = payload?.items || [];

    console.log(`[Webhook] Received batch ${payload?.id} with ${items.length} items`);
    console.log(`[Webhook] Payload:`, JSON.stringify(payload, null, 2));

    const results: string[] = [];

    for (const item of items) {
      const eventType = item.type || '';
      const data = item.data || {};

      console.log(`[Webhook] Processing event: ${eventType}`);

      switch (eventType) {
        case 'hr.absence.requested':
          await handleAbsenceCreated(data);
          results.push(`created: ${data.id}`);
          break;

        case 'hr.absence.cancelled':
        case 'hr.absence.canceled':
          await handleAbsenceCancelled(data);
          results.push(`cancelled: ${data.id}`);
          break;

        default:
          console.log(`[Webhook] Unknown event type: ${eventType}`);
          results.push(`ignored: ${eventType}`);
          break;
      }
    }

    logEntry.result = `ok: ${results.join(', ')}`;
    logWebhook(logEntry);
    res.status(200).json({ status: 'ok', processed: results });
  } catch (error) {
    console.error('[Webhook] Error processing webhook:', error);
    logEntry.error = error instanceof Error ? error.message : String(error);
    logWebhook(logEntry);

    // Try to set error status on the absence request in Flip
    try {
      const firstItem = req.body?.items?.[0]?.data;
      if (firstItem?.id) {
        await flip.setAbsenceRequestError({
          absence_request_id: firstItem.id,
        });
      }
    } catch (flipError) {
      console.error('[Webhook] Failed to set error status in Flip:', flipError);
    }

    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Handle new absence request created by user in Flip MiniApp
 *
 * Actual Flip webhook data format:
 * {
 *   "id": "absence-request-uuid",
 *   "absentee": "user-uuid",
 *   "policy_id": "policy-uuid",
 *   "policy_external_id": "annual_leave",
 *   "starts_from": { "date": "2026-03-10T00:00:00", "type": "FIRST_HALF" },
 *   "ends_at": { "date": "2026-03-12T00:00:00", "type": "SECOND_HALF" },
 *   "requestor_comment": "...",
 *   "status": "PENDING"
 * }
 */
async function handleAbsenceCreated(data: Record<string, unknown>): Promise<void> {
  const absenceRequestId = data.id as string;
  const userId = data.absentee as string;
  const policyId = data.policy_id as string;
  const policyExternalId = data.policy_external_id as string | null;
  const requestorComment = data.requestor_comment as string | null;
  const startsFrom = data.starts_from as { date: string; type: string } | undefined;
  const endsAt = data.ends_at as { date: string; type: string } | undefined;

  console.log(
    `[Webhook] Processing absence creation: request=${absenceRequestId}, user=${userId}, policy=${policyId}`
  );

  if (!absenceRequestId || !userId) {
    throw new Error(`Missing required fields: id=${absenceRequestId}, absentee=${userId}`);
  }

  // 1. Map Flip user to BreatheHR employee
  const breatheEmployeeId = await userMapping.getBreatheEmployeeId(userId);
  if (!breatheEmployeeId) {
    console.error(`[Webhook] No BreatheHR mapping found for Flip user ${userId}`);
    await flip.setAbsenceRequestError({
      absence_request_id: absenceRequestId,
    });
    throw new Error(`No BreatheHR employee mapping for Flip user ${userId}`);
  }

  // 2. Determine the BreatheHR leave reason ID from the policy external_id
  const leaveReasonId = policyExternalId
    ? parseInt(policyExternalId, 10)
    : undefined;

  // 3. Parse dates — Flip sends "2026-03-10T00:00:00", BreatheHR needs "2026-03-10"
  const startDate = startsFrom?.date?.split('T')[0] || '';
  const endDate = endsAt?.date?.split('T')[0] || '';

  // 4. Map half-day types
  const halfStart = startsFrom?.type === 'SECOND_HALF';
  const halfEnd = endsAt?.type === 'FIRST_HALF';

  // 5. Create leave request in BreatheHR
  const result = await breathe.createLeaveRequest(
    breatheEmployeeId,
    startDate,
    endDate,
    {
      halfStart,
      halfEnd,
      notes: requestorComment || undefined,
      leaveReasonId: leaveReasonId && !isNaN(leaveReasonId) ? leaveReasonId : undefined,
    }
  );

  const leaveRequest = result.leave_requests?.[0];
  if (!leaveRequest) {
    throw new Error('BreatheHR did not return a leave request');
  }

  console.log(
    `[Webhook] Created BreatheHR leave request ${leaveRequest.id} for employee ${breatheEmployeeId}`
  );

  // 6. Patch the Flip absence request with BreatheHR's leave request ID
  await flip.patchAbsenceRequestExternalId(
    absenceRequestId,
    String(leaveRequest.id)
  );

  // Note: Do NOT auto-approve in Flip here.
  // The request stays PENDING until BreatheHR's manager approves it.
  // Our periodic absence sync (every 30 mins) will detect the approval
  // in BreatheHR and update the status to APPROVED in Flip.

  console.log(
    `[Webhook] Absence request ${absenceRequestId} created in BreatheHR as ${leaveRequest.id} — awaiting approval`
  );
}

/**
 * Handle absence request cancelled by user in Flip MiniApp
 *
 * The external_id on the Flip request is the BreatheHR LEAVE REQUEST ID
 * (not the absence ID — they're different in BreatheHR).
 *
 * Two cases:
 * 1. Leave request is still PENDING → cancel/delete the leave request
 * 2. Leave request was APPROVED (absence exists) → find the absence and cancel it
 */
async function handleAbsenceCancelled(data: Record<string, unknown>): Promise<void> {
  const absenceRequestId = data.id as string;
  const userId = data.absentee as string;
  const externalId = data.external_id as string | null;

  // Also extract dates from the webhook data (used to find the absence if needed)
  const startsFrom = data.starts_from as { date: string } | undefined;
  const endsAt = data.ends_at as { date: string } | undefined;

  console.log(
    `[Webhook] Processing absence cancellation: request=${absenceRequestId}, ` +
      `user=${userId}, external_id=${externalId}`
  );

  if (!externalId) {
    console.warn(
      `[Webhook] No external_id on absence request ${absenceRequestId}, cannot cancel in BreatheHR`
    );
    return;
  }

  const breatheLeaveRequestId = parseInt(externalId, 10);
  if (isNaN(breatheLeaveRequestId)) {
    throw new Error(`Invalid BreatheHR leave request ID: ${externalId}`);
  }

  // Step 1: Try to cancel/delete the leave request directly
  // This works when the request is still pending in BreatheHR
  try {
    await breathe.cancelLeaveRequest(breatheLeaveRequestId);
    console.log(
      `[Webhook] Cancelled BreatheHR leave request ${breatheLeaveRequestId} (Flip ${absenceRequestId})`
    );
    return;
  } catch (leaveRequestError) {
    console.log(
      `[Webhook] Could not cancel leave request ${breatheLeaveRequestId}: ` +
        `${leaveRequestError instanceof Error ? leaveRequestError.message : leaveRequestError}. ` +
        `The request may have already been approved — trying to find and cancel the absence.`
    );
  }

  // Step 2: Leave request cancel failed — it was probably already approved
  // and became an absence. Find the matching absence by dates + employee.
  const breatheEmployeeId = await userMapping.getBreatheEmployeeId(userId);
  if (!breatheEmployeeId) {
    throw new Error(
      `Cannot cancel: no BreatheHR mapping for Flip user ${userId} ` +
        `and leave request cancel failed`
    );
  }

  // Try to find the absence that matches this leave request's dates
  const startDate = startsFrom?.date?.split('T')[0] || '';
  const endDate = endsAt?.date?.split('T')[0] || '';

  const absences = await breathe.getAllEmployeeAbsences(breatheEmployeeId);

  // Match by dates first, then fall back to checking the leave request for dates
  let matchingAbsence = absences.find(
    (a) =>
      a.start_date === startDate &&
      a.end_date === endDate &&
      !((a as Record<string, unknown>).cancelled === true ||
        (a as Record<string, unknown>).cancelled === 'true')
  );

  // If no date match from webhook data, try fetching the leave request for dates
  if (!matchingAbsence && breatheLeaveRequestId) {
    try {
      const lrResult = await breathe.getLeaveRequest(breatheLeaveRequestId);
      const lr = lrResult.leave_requests?.[0];
      if (lr) {
        matchingAbsence = absences.find(
          (a) =>
            a.start_date === lr.start_date &&
            a.end_date === lr.end_date &&
            !((a as Record<string, unknown>).cancelled === true ||
              (a as Record<string, unknown>).cancelled === 'true')
        );
      }
    } catch {
      console.log(
        `[Webhook] Could not fetch leave request ${breatheLeaveRequestId} for date matching`
      );
    }
  }

  if (matchingAbsence) {
    await breathe.cancelAbsence(matchingAbsence.id);
    console.log(
      `[Webhook] Cancelled BreatheHR absence ${matchingAbsence.id} ` +
        `(dates: ${matchingAbsence.start_date} - ${matchingAbsence.end_date}, ` +
        `Flip request ${absenceRequestId})`
    );
  } else {
    console.error(
      `[Webhook] Could not find matching BreatheHR absence for ` +
        `leave request ${breatheLeaveRequestId} ` +
        `(dates: ${startDate || 'unknown'} - ${endDate || 'unknown'}, ` +
        `employee ${breatheEmployeeId}). ` +
        `Manual intervention may be needed.`
    );
    throw new Error(
      `Could not cancel: leave request ${breatheLeaveRequestId} cancel failed ` +
        `and no matching absence found`
    );
  }
}
