import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BreatheHRClient } from '../../lib/breathehr';
import { FlipClient } from '../../lib/flip';
import { UserMappingService } from '../../lib/user-mapping';
import { logWebhook, getWebhookLogs } from '../../lib/webhook-log';
import type {
  AbsenceCreatedWebhookData,
  AbsenceCancelledWebhookData,
} from '../../lib/types';

const breathe = new BreatheHRClient();
const flip = new FlipClient();
const userMapping = new UserMappingService(breathe, flip);

/**
 * Webhook handler for absence request events from Flip
 *
 * GET  /api/webhooks/absence-request  → View recent webhook logs
 * POST /api/webhooks/absence-request  → Handle webhook events
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
      'x-webhook-id': req.headers['x-webhook-id'] as string || '',
      'x-webhook-signature': req.headers['x-webhook-signature'] as string || '',
    },
    body: req.body,
    result: undefined as string | undefined,
    error: undefined as string | undefined,
  };

  try {
    const payload = req.body;
    const eventType = payload?.event_type || payload?.type || '';

    console.log(`[Webhook] Received event: ${eventType}`);
    console.log(`[Webhook] Payload:`, JSON.stringify(payload, null, 2));

    switch (eventType) {
      case 'hr.absence-request.created':
      case 'absence_request.created':
      case 'absence_request_created':
        await handleAbsenceCreated(payload.data || payload);
        break;

      case 'hr.absence-request.cancelled':
      case 'absence_request.cancelled':
      case 'absence_request_cancelled':
        await handleAbsenceCancelled(payload.data || payload);
        break;

      default:
        console.log(`[Webhook] Unknown event type: ${eventType}`);
        logEntry.result = `ignored: unknown event_type "${eventType}"`;
        logWebhook(logEntry);
        res.status(200).json({ status: 'ignored', event_type: eventType });
        return;
    }

    logEntry.result = 'ok';
    logWebhook(logEntry);
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('[Webhook] Error processing webhook:', error);
    logEntry.error = error instanceof Error ? error.message : String(error);
    logWebhook(logEntry);

    // Try to set error status on the absence request in Flip
    try {
      const absenceRequestId =
        req.body?.data?.absence_request_id || req.body?.absence_request_id;
      if (absenceRequestId) {
        await flip.setAbsenceRequestError({
          absence_request_id: absenceRequestId,
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
 * Flow:
 * 1. Look up BreatheHR employee from Flip user ID
 * 2. Map the absence policy to a BreatheHR leave reason
 * 3. Create a leave request in BreatheHR
 * 4. Store the BreatheHR leave request ID as external_id in Flip
 * 5. Auto-approve in Flip (BreatheHR will handle its own approval flow)
 */
async function handleAbsenceCreated(data: AbsenceCreatedWebhookData): Promise<void> {
  const {
    absence_request_id,
    user_id,
    policy_id,
    starts_from,
    ends_at,
    requestor_comment,
    policy_external_id,
  } = data;

  console.log(
    `[Webhook] Processing absence creation: request=${absence_request_id}, user=${user_id}`
  );

  // 1. Map Flip user to BreatheHR employee
  const breatheEmployeeId = await userMapping.getBreatheEmployeeId(user_id);
  if (!breatheEmployeeId) {
    console.error(`[Webhook] No BreatheHR mapping found for Flip user ${user_id}`);
    await flip.setAbsenceRequestError({
      absence_request_id,
    });
    throw new Error(`No BreatheHR employee mapping for Flip user ${user_id}`);
  }

  // 2. Determine the BreatheHR leave reason ID from the policy external_id
  // The external_id on the policy corresponds to the BreatheHR leave reason ID
  const leaveReasonId = policy_external_id
    ? parseInt(policy_external_id, 10)
    : undefined;

  // 3. Map half-day types
  const halfStart = starts_from?.type === 'SECOND_HALF';
  const halfEnd = ends_at?.type === 'FIRST_HALF';

  // 4. Create leave request in BreatheHR
  const result = await breathe.createLeaveRequest(
    breatheEmployeeId,
    starts_from.date,
    ends_at.date,
    {
      halfStart,
      halfEnd,
      notes: requestor_comment || undefined,
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

  // 5. Patch the Flip absence request with BreatheHR's leave request ID
  await flip.patchAbsenceRequestExternalId(
    absence_request_id,
    String(leaveRequest.id)
  );

  // 6. Auto-approve in Flip (BreatheHR handles its own workflow)
  // The driver acts as the approver for Flip's side
  await flip.approveAbsenceRequest(user_id, {
    absence_request_id,
  });

  console.log(
    `[Webhook] Absence request ${absence_request_id} approved in Flip, linked to BreatheHR ${leaveRequest.id}`
  );
}

/**
 * Handle absence request cancelled by user in Flip MiniApp
 *
 * Flow:
 * 1. Look up the BreatheHR absence ID from the external_id
 * 2. Cancel the absence in BreatheHR
 */
async function handleAbsenceCancelled(data: AbsenceCancelledWebhookData): Promise<void> {
  const { absence_request_id, user_id, external_id } = data;

  console.log(
    `[Webhook] Processing absence cancellation: request=${absence_request_id}, user=${user_id}`
  );

  if (!external_id) {
    console.warn(
      `[Webhook] No external_id on absence request ${absence_request_id}, cannot cancel in BreatheHR`
    );
    return;
  }

  const breatheAbsenceId = parseInt(external_id, 10);
  if (isNaN(breatheAbsenceId)) {
    throw new Error(`Invalid BreatheHR absence ID: ${external_id}`);
  }

  // Cancel in BreatheHR
  await breathe.cancelAbsence(breatheAbsenceId);

  console.log(
    `[Webhook] Cancelled BreatheHR absence ${breatheAbsenceId} (Flip request ${absence_request_id})`
  );
}
