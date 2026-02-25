import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BreatheHRClient } from '../../lib/breathehr';
import { FlipClient } from '../../lib/flip';
import { UserMappingService } from '../../lib/user-mapping';
import type { FlipSyncBalance } from '../../lib/types';

/**
 * Sync leave balances from BreatheHR to Flip
 *
 * POST /api/sync/balances
 *
 * For each mapped user:
 * 1. Gets their holiday allowance from BreatheHR (via allowances list)
 * 2. Gets their taken absences from BreatheHR
 * 3. Calculates available balance
 * 4. Pushes the balance to Flip using the policy's Flip UUID
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
    console.log('[SyncBalances] Starting balance sync...');

    const breathe = new BreatheHRClient();
    const flip = new FlipClient();
    const userMapping = new UserMappingService(breathe, flip);

    // Get all user mappings
    const mappings = await userMapping.getAllMappings();
    console.log(`[SyncBalances] Processing ${mappings.length} mapped users`);

    // Get the Flip "Annual Leave" policy to get its UUID
    const policiesResult = await flip.getAbsencePolicies('annual_leave');
    const annualLeavePolicy = policiesResult.items?.[0];

    if (!annualLeavePolicy) {
      throw new Error('Annual Leave policy not found in Flip. Run policy sync first.');
    }

    console.log(
      `[SyncBalances] Annual Leave policy: id=${annualLeavePolicy.id}, ` +
      `external_id=${annualLeavePolicy.external_id}, ` +
      `time_unit=${annualLeavePolicy.time_unit}`
    );

    // Fetch ALL holiday allowances from BreatheHR upfront
    // The employee record only has { name, id } — the amount is in this list
    const allowancesResult = await breathe.listHolidayAllowances();
    const allowanceMap = new Map<number, { amount: number; units: string }>();
    for (const ha of allowancesResult.holiday_allowances || []) {
      allowanceMap.set(ha.id, {
        amount: parseFloat(String(ha.amount)) || 0,
        units: ha.units || 'days',
      });
    }

    console.log(`[SyncBalances] Loaded ${allowanceMap.size} holiday allowances from BreatheHR`);
    console.log(`[SyncBalances] Allowances: ${JSON.stringify(Object.fromEntries(allowanceMap))}`);

    const balances: FlipSyncBalance[] = [];
    let successCount = 0;
    let errorCount = 0;

    for (const mapping of mappings) {
      try {
        // Get employee details from BreatheHR
        const empResult = await breathe.getEmployee(mapping.breatheEmployeeId);
        const employee = empResult.employees?.[0];

        if (!employee) {
          console.warn(
            `[SyncBalances] Employee ${mapping.breatheEmployeeId} not found in BreatheHR`
          );
          errorCount++;
          continue;
        }

        // Look up the allowance amount from the allowances list
        const empAllowanceId = employee.holiday_allowance?.id;
        const allowanceDetails = empAllowanceId
          ? allowanceMap.get(empAllowanceId)
          : undefined;

        const totalAllowance = allowanceDetails?.amount || 0;
        const isHours = allowanceDetails?.units === 'hours';
        const timeUnit = isHours ? 'HOURS' : 'DAYS';

        console.log(
          `[SyncBalances] Employee ${employee.first_name} ${employee.last_name}: ` +
          `allowanceId=${empAllowanceId}, totalAllowance=${totalAllowance}, units=${allowanceDetails?.units}`
        );

        // Get absences to calculate taken days
        const absences = await breathe.getAllEmployeeAbsences(mapping.breatheEmployeeId);

        console.log(`[SyncBalances] Found ${absences.length} absences for employee ${mapping.breatheEmployeeId}`);

        // Calculate taken days (sum of deducted days from non-cancelled absences)
        // BreatheHR doesn't have a "status" field — absences are either active or cancelled
        // deducted is returned as a string like "2.0"
        const takenDays = absences
          .filter((a: Record<string, unknown>) => {
            return a.cancelled !== true && a.cancelled !== 'true';
          })
          .reduce((sum: number, a: Record<string, unknown>) => {
            const deducted = parseFloat(String(a.deducted || '0')) || 0;
            if (deducted > 0) {
              console.log(
                `[SyncBalances]   Absence ${a.id}: deducted=${a.deducted} (parsed=${deducted}), ` +
                `cancelled=${a.cancelled}, start=${a.start_date}, end=${a.end_date}`
              );
            }
            return sum + deducted;
          }, 0);

        // Available = total allowance - taken
        // Note: BreatheHR also has "adjustments" but we can't easily get those via API,
        // so we report what we can. The formula is: available = total - taken.
        const availableDays = Math.max(0, totalAllowance - takenDays);

        // Use BOTH policy id (UUID) and external_id for reliable matching
        // Also include external_id on the balance itself for linking
        const balance: FlipSyncBalance = {
          user_id: mapping.flipUserId,
          policy: {
            id: annualLeavePolicy.id,
            external_id: annualLeavePolicy.external_id || 'annual_leave',
          },
          balance: {
            external_id: `breathehr_${mapping.breatheEmployeeId}_annual_leave`,
            total: totalAllowance,
            available: availableDays,
            taken: takenDays,
            unlimited: false,
            time_unit: timeUnit,
          },
        };

        balances.push(balance);
        successCount++;

        console.log(
          `[SyncBalances] ${employee.first_name} ${employee.last_name}: ` +
            `total=${totalAllowance}, taken=${takenDays}, available=${availableDays} ${timeUnit}`
        );
      } catch (error) {
        console.error(
          `[SyncBalances] Error processing employee ${mapping.breatheEmployeeId}:`,
          error
        );
        errorCount++;
      }
    }

    // Push all balances to Flip in batches
    console.log(`[SyncBalances] Sending ${balances.length} balances to Flip...`);
    console.log(`[SyncBalances] Payload: ${JSON.stringify({ items: balances }, null, 2)}`);

    const batchSize = 100;
    const syncResults: unknown[] = [];
    for (let i = 0; i < balances.length; i += batchSize) {
      const batch = balances.slice(i, i + batchSize);
      const result = await flip.syncBalances(batch);
      syncResults.push(result);
      console.log(
        `[SyncBalances] Pushed batch ${Math.floor(i / batchSize) + 1} ` +
        `(${batch.length} balances), response: ${JSON.stringify(result)}`
      );
    }

    console.log(
      `[SyncBalances] Balance sync complete. Success: ${successCount}, Errors: ${errorCount}`
    );

    res.status(200).json({
      status: 'ok',
      synced: successCount,
      errors: errorCount,
      total_users: mappings.length,
      policy_used: {
        id: annualLeavePolicy.id,
        external_id: annualLeavePolicy.external_id,
        name: annualLeavePolicy.name,
        time_unit: annualLeavePolicy.time_unit,
      },
      balances_sent: balances.map(b => ({
        user: b.user_id,
        policy: b.policy,
        total: b.balance.total,
        taken: b.balance.taken,
        available: b.balance.available,
        time_unit: b.balance.time_unit,
      })),
      flip_response: syncResults,
    });
  } catch (error) {
    console.error('[SyncBalances] Error:', error);
    res.status(500).json({
      error: 'Balance sync failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
