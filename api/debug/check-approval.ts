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
 * - Full raw data for denied/rejected leave requests
 *
 * Also includes a "diagnosis" section explaining what the approval-status
 * checker WOULD do for each entry.
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

      // Build leave request map for date matching
      let leaveRequests: Array<Record<string, unknown>> = [];
      try {
        leaveRequests = await breathe.getAllEmployeeLeaveRequests(mapping.breatheEmployeeId) as Array<Record<string, unknown>>;
      } catch (e) {
        userReport.leaveRequestError = e instanceof Error ? e.message : String(e);
      }

      const leaveRequestsByDate = new Map<string, Array<Record<string, unknown>>>();
      for (const lr of leaveRequests) {
        if (lr.start_date && lr.end_date && lr.id) {
          const key = `${lr.start_date}|${lr.end_date}`;
          const existing = leaveRequestsByDate.get(key) || [];
          existing.push(lr);
          leaveRequestsByDate.set(key, existing);
        }
      }

      for (const absence of absences) {
        const isCancelled =
          (absence as Record<string, unknown>).cancelled === true ||
          (absence as Record<string, unknown>).cancelled === 'true';

        const check: Record<string, unknown> = {
          breathe_absence_id: absence.id,
          dates: `${absence.start_date} - ${absence.end_date}`,
          cancelled: isCancelled,
          notes: (absence.notes || '').substring(0, 80),
        };

        // Find matching leave request by dates
        const dateKey = `${absence.start_date}|${absence.end_date}`;
        const matchingLRs = leaveRequestsByDate.get(dateKey) || [];
        check.matching_leave_requests = matchingLRs.map((lr) => ({
          id: lr.id,
          status: lr.status,
          action: lr.action,
        }));

        // Try Flip lookup by each matching lr.id
        const flipLookups: Record<string, unknown>[] = [];
        for (const matchingLR of matchingLRs) {
          try {
            const flipRequest = await flip.getAbsenceRequestByExternalId(String(matchingLR.id));
            flipLookups.push({
              lookup_by: `lr.id=${matchingLR.id}`,
              flip_id: flipRequest.id,
              flip_status: flipRequest.status,
              flip_external_id: flipRequest.external_id,
              action_needed: flipRequest.status === 'PENDING' && !isCancelled ? 'APPROVE' : 'none',
            });
          } catch {
            flipLookups.push({
              lookup_by: `lr.id=${matchingLR.id}`,
              flip_request: null,
            });
          }
        }

        // Also try by absence.id
        try {
          const flipRequest = await flip.getAbsenceRequestByExternalId(String(absence.id));
          flipLookups.push({
            lookup_by: `absence.id=${absence.id}`,
            flip_id: flipRequest.id,
            flip_status: flipRequest.status,
            flip_external_id: flipRequest.external_id,
            action_needed: flipRequest.status === 'PENDING' && !isCancelled ? 'APPROVE' : 'none',
          });
        } catch {
          flipLookups.push({
            lookup_by: `absence.id=${absence.id}`,
            flip_request: null,
          });
        }

        check.flip_lookups = flipLookups;
        absenceChecks.push(check);
      }
      userReport.absences = absenceChecks;

      // Check leave requests — show full raw data for denied ones
      const lrChecks: Record<string, unknown>[] = [];
      for (const lr of leaveRequests) {
        const status = ((lr.status as string) || '').toLowerCase();
        const isDenied =
          status === 'denied' ||
          status === 'rejected' ||
          status === 'declined';

        const check: Record<string, unknown> = {
          breathe_lr_id: lr.id,
          dates: `${lr.start_date} - ${lr.end_date}`,
          status: lr.status,
          action: lr.action,
          notes: ((lr.notes as string) || '').substring(0, 80),
        };

        // For denied leave requests, include ALL raw fields so we can
        // discover what field BreatheHR uses for rejection reasons
        if (isDenied) {
          check.raw_data = lr;
        }

        // Try to find matching Flip absence request
        try {
          const flipRequest = await flip.getAbsenceRequestByExternalId(String(lr.id));
          check.flip_request = {
            id: flipRequest.id,
            status: flipRequest.status,
            external_id: flipRequest.external_id,
            action_needed:
              flipRequest.status === 'PENDING' && isDenied
                ? 'REJECT'
                : flipRequest.status === 'PENDING'
                  ? 'pending (awaiting BreatheHR decision)'
                  : 'none',
          };
        } catch {
          check.flip_request = null;
        }

        lrChecks.push(check);
      }
      userReport.leaveRequests = lrChecks;

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
