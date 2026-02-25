import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BreatheHRClient } from '../../lib/breathehr';
import { FlipClient } from '../../lib/flip';
import { UserMappingService } from '../../lib/user-mapping';

/**
 * Debug endpoint to inspect balance data from both systems
 *
 * GET /api/debug/balances
 *
 * Also queries Flip's GET balances API to see what's actually stored
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
    const allowancesResult = await breathe.listHolidayAllowances();
    const allowanceMap = new Map<number, { amount: number; units: string }>();
    for (const ha of allowancesResult.holiday_allowances || []) {
      allowanceMap.set(ha.id, {
        amount: parseFloat(String(ha.amount)) || 0,
        units: ha.units || 'days',
      });
    }

    // Get Flip policies
    const annualLeavePolicies = await flip.getAbsencePolicies('annual_leave');
    const annualLeavePolicy = annualLeavePolicies.items?.[0];

    // Calculate balance from BreatheHR data
    const empAllowanceId = employee?.holiday_allowance?.id;
    const allowanceDetails = empAllowanceId ? allowanceMap.get(empAllowanceId) : undefined;
    const totalDays = allowanceDetails?.amount || 0;

    const takenDays = absences
      .filter((a: Record<string, unknown>) => a.cancelled !== true && a.cancelled !== 'true')
      .reduce((sum: number, a: Record<string, unknown>) => {
        return sum + (parseFloat(String(a.deducted || '0')) || 0);
      }, 0);

    const availableDays = Math.max(0, totalDays - takenDays);

    // Try to query Flip's GET balances API
    let flipBalances: unknown = null;
    let flipBalancesError: string | null = null;
    try {
      flipBalances = await flip.getBalances({
        userId: lukeMapping.flipUserId,
      });
    } catch (error) {
      flipBalancesError = error instanceof Error ? error.message : String(error);
    }

    // Also try with policy_id
    let flipBalancesByPolicy: unknown = null;
    let flipBalancesByPolicyError: string | null = null;
    if (annualLeavePolicy) {
      try {
        flipBalancesByPolicy = await flip.getBalances({
          policyId: annualLeavePolicy.id,
          userId: lukeMapping.flipUserId,
        });
      } catch (error) {
        flipBalancesByPolicyError = error instanceof Error ? error.message : String(error);
      }
    }

    res.status(200).json({
      mapping: lukeMapping,
      breathehr: {
        employee_name: `${employee?.first_name} ${employee?.last_name}`,
        holiday_allowance_on_employee: employee?.holiday_allowance,
        holiday_allowance_from_list: allowanceDetails,
        absences_count: absences.length,
        absences: absences.map((a: Record<string, unknown>) => ({
          id: a.id,
          cancelled: a.cancelled,
          start_date: a.start_date,
          end_date: a.end_date,
          deducted: a.deducted,
          type: a.type,
          leave_reason: a.leave_reason,
        })),
        calculated: {
          total: totalDays,
          taken: takenDays,
          available: availableDays,
        },
      },
      flip: {
        annual_leave_policy: annualLeavePolicy ? {
          id: annualLeavePolicy.id,
          name: annualLeavePolicy.name,
          external_id: annualLeavePolicy.external_id,
          time_unit: annualLeavePolicy.time_unit,
          time_units: annualLeavePolicy.time_units,
        } : null,
        get_balances_by_user: flipBalances,
        get_balances_by_user_error: flipBalancesError,
        get_balances_by_policy_and_user: flipBalancesByPolicy,
        get_balances_by_policy_and_user_error: flipBalancesByPolicyError,
        balance_we_would_sync: {
          user_id: lukeMapping.flipUserId,
          policy: {
            id: annualLeavePolicy?.id,
            external_id: 'annual_leave',
          },
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
