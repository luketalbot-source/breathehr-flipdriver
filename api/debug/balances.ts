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

    // Show what balance sync WOULD send
    const allowance = employee?.holiday_allowance;
    const totalDays = allowance?.amount || 0;
    const takenDays = absences
      .filter((a: Record<string, unknown>) => a.status === 'approved' || a.status === 'Approved')
      .reduce((sum: number, a: Record<string, unknown>) => sum + ((a.deducted as number) || 0), 0);
    const availableDays = Math.max(0, totalDays - takenDays);

    res.status(200).json({
      mapping: lukeMapping,
      breathehr: {
        employee_name: `${employee?.first_name} ${employee?.last_name}`,
        holiday_allowance: employee?.holiday_allowance,
        absences_count: absences.length,
        absences: absences.slice(0, 5).map((a: Record<string, unknown>) => ({
          id: a.id,
          status: a.status,
          start_date: a.start_date,
          end_date: a.end_date,
          deducted: a.deducted,
          type: a.type,
          leave_reason: a.leave_reason,
        })),
        all_holiday_allowances: allowances,
        calculated: {
          total: totalDays,
          taken: takenDays,
          available: availableDays,
        },
      },
      flip: {
        policies_count: policies.items?.length,
        policies: policies.items?.map((p: Record<string, unknown>) => ({
          id: p.id,
          name: p.name,
          external_id: p.external_id,
        })),
        balance_would_send: {
          user_id: lukeMapping.flipUserId,
          policy: { external_id: 'annual_leave' },
          balance: {
            total: totalDays,
            available: availableDays,
            taken: takenDays,
            unlimited: false,
            time_unit: 'DAYS',
          },
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      error: 'Debug failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
