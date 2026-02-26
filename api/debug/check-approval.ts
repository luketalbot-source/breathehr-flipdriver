import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BreatheHRClient } from '../../lib/breathehr';
import { FlipClient } from '../../lib/flip';
import { UserMappingService } from '../../lib/user-mapping';

/**
 * Debug endpoint to check the approval status flow
 *
 * GET /api/debug/check-approval
 *
 * Shows what the approval-status sync would find:
 * - BreatheHR absences and leave_requests for each mapped user
 * - Whether each has a matching Flip absence request
 * - The status of each Flip absence request
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  try {
    const breathe = new BreatheHRClient();
    const flip = new FlipClient();
    const userMapping = new UserMappingService(breathe, flip);

    const mappings = await userMapping.getAllMappings();

    const report: Record<string, unknown>[] = [];

    for (const mapping of mappings) {
      const userReport: Record<string, unknown> = {
        flipUserId: mapping.flipUserId,
        breatheEmployeeId: mapping.breatheEmployeeId,
        breatheRef: mapping.breatheRef,
        absences: [],
        leaveRequests: [],
      };

      // Check absences
      const absences = await breathe.getAllEmployeeAbsences(mapping.breatheEmployeeId);
      const absenceChecks: Record<string, unknown>[] = [];

      for (const absence of absences) {
        const check: Record<string, unknown> = {
          breathe_id: absence.id,
          dates: `${absence.start_date} - ${absence.end_date}`,
          cancelled: (absence as Record<string, unknown>).cancelled,
          notes: (absence.notes || '').substring(0, 50),
        };

        // Try to find matching Flip absence request
        try {
          const flipRequest = await flip.getAbsenceRequestByExternalId(String(absence.id));
          check.flip_request = {
            id: flipRequest.id,
            status: flipRequest.status,
            external_id: flipRequest.external_id,
            absentee: flipRequest.absentee,
          };
          check.action_needed = flipRequest.status === 'PENDING' ? 'APPROVE' : 'none';
        } catch (e) {
          check.flip_request = null;
          check.flip_error = e instanceof Error ? e.message : String(e);
          check.action_needed = 'none (no Flip request)';
        }

        absenceChecks.push(check);
      }
      userReport.absences = absenceChecks;

      // Check leave requests
      try {
        const leaveRequests = await breathe.getAllEmployeeLeaveRequests(mapping.breatheEmployeeId);
        const lrChecks: Record<string, unknown>[] = [];

        for (const lr of leaveRequests) {
          const check: Record<string, unknown> = {
            breathe_id: lr.id,
            dates: `${lr.start_date} - ${lr.end_date}`,
            status: lr.status,
            action: lr.action,
            notes: (lr.notes || '').substring(0, 50),
          };

          // Try to find matching Flip absence request
          try {
            const flipRequest = await flip.getAbsenceRequestByExternalId(String(lr.id));
            check.flip_request = {
              id: flipRequest.id,
              status: flipRequest.status,
              external_id: flipRequest.external_id,
            };
          } catch (e) {
            check.flip_request = null;
          }

          lrChecks.push(check);
        }
        userReport.leaveRequests = lrChecks;
      } catch (e) {
        userReport.leaveRequests = {
          error: e instanceof Error ? e.message : String(e),
        };
      }

      report.push(userReport);
    }

    res.status(200).json({ status: 'ok', report });
  } catch (error) {
    res.status(500).json({
      error: 'Check failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
