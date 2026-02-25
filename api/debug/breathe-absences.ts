import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BreatheHRClient } from '../../lib/breathehr';

/**
 * Debug endpoint to see raw BreatheHR absences for Luke
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  try {
    const breathe = new BreatheHRClient();

    // Luke's BreatheHR employee ID
    const employeeId = 2160859;

    const absences = await breathe.getAllEmployeeAbsences(employeeId);

    res.status(200).json({
      employee_id: employeeId,
      total_absences: absences.length,
      absences: absences,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
