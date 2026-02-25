import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BreatheHRClient } from '../../lib/breathehr';
import { FlipClient } from '../../lib/flip';
import { UserMappingService } from '../../lib/user-mapping';

/**
 * Debug endpoint to inspect balance data from both systems
 *
 * GET /api/debug/balances
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
    const lukeMapping = mappings[0]; // Luke is the only mapped user

    if (!lukeMapping) {
      res.status(200).json({ error: 'No user mappings found' });
      return;
    }

    // Get BreatheHR employee data
    const empResult = await breathe.getEmployee(lukeMapping.breatheEmployeeId);
    const employee = empResult.employees?.[0];

    // Get BreatheHR absences
    const absences = await breathe.getAllEmployeeAbsences(lukeMapping.breatheEmployeeId);

    // Get BreatheHR holiday allowances
    const allowances = await breathe.listHolidayAllowances();

    // Get Flip policies
    const policies = await flip.getAbsencePolicies();

    // Get Flip balances for Luke
    const flipBalances = await flip.getBalances({ userId: lukeMapping.flipUserId });

    res.status(200).json({
      mapping: lukeMapping,
      breathehr: {
        employee_holiday_allowance: employee?.holiday_allowance,
        absences_count: absences.length,
        absences_sample: absences.slice(0, 3),
        holiday_allowances: allowances,
      },
      flip: {
        policies: policies.items,
        balances: flipBalances,
      },
    });
  } catch (error) {
    res.status(500).json({
      error: 'Debug failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
