import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FlipClient } from '../../lib/flip';

/**
 * Debug endpoint to test the approve flow end-to-end
 *
 * GET /api/debug/test-approve?external_id=40810846
 *
 * 1. Looks up the Flip request by external_id
 * 2. Shows the current status
 * 3. If PENDING, attempts to approve and shows the result
 * 4. If already APPROVED, tries to approve anyway and shows the error/result
 *
 * Also includes a "dry_run" mode (?dry_run=true) that only does the lookup.
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  try {
    const externalId = req.query.external_id as string;
    const dryRun = req.query.dry_run === 'true';
    const userId = (req.query.user_id as string) || '3d32eb7a-65d7-4f45-8b48-5de62a92adc5';

    if (!externalId) {
      res.status(400).json({ error: 'Missing external_id query parameter' });
      return;
    }

    const flip = new FlipClient();
    const result: Record<string, unknown> = {
      external_id: externalId,
      user_id: userId,
      dry_run: dryRun,
    };

    // Step 1: Look up the Flip request
    console.log(`[TestApprove] Looking up Flip request by external_id=${externalId}`);
    try {
      const flipRequest = await flip.getAbsenceRequestByExternalId(externalId);
      result.flip_request = {
        id: flipRequest.id,
        status: flipRequest.status,
        external_id: flipRequest.external_id,
        absentee: flipRequest.absentee,
        raw: flipRequest,
      };
      console.log(`[TestApprove] Found: id=${flipRequest.id}, status=${flipRequest.status}`);

      // Step 2: Try to approve (if not dry run)
      if (!dryRun) {
        console.log(`[TestApprove] Attempting to approve...`);
        console.log(`[TestApprove] Sending: approver=${userId}, identifier.external_id=${externalId}`);

        try {
          await flip.approveAbsenceRequest(userId, {
            external_id: externalId,
          });
          result.approve_result = 'SUCCESS (200)';
          console.log(`[TestApprove] Approve call succeeded`);
        } catch (approveError) {
          result.approve_result = 'FAILED';
          result.approve_error = approveError instanceof Error ? approveError.message : String(approveError);
          console.log(`[TestApprove] Approve call failed: ${result.approve_error}`);
        }

        // Also try with absence_request_id instead of external_id
        console.log(`[TestApprove] Also trying with absence_request_id=${flipRequest.id}`);
        try {
          await flip.approveAbsenceRequest(userId, {
            absence_request_id: flipRequest.id,
          });
          result.approve_by_id_result = 'SUCCESS (200)';
          console.log(`[TestApprove] Approve by ID succeeded`);
        } catch (approveIdError) {
          result.approve_by_id_result = 'FAILED';
          result.approve_by_id_error = approveIdError instanceof Error ? approveIdError.message : String(approveIdError);
          console.log(`[TestApprove] Approve by ID failed: ${result.approve_by_id_error}`);
        }
      }
    } catch (lookupError) {
      result.flip_request = null;
      result.lookup_error = lookupError instanceof Error ? lookupError.message : String(lookupError);
      console.log(`[TestApprove] Lookup failed: ${result.lookup_error}`);
    }

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
