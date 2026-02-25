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
 * 4. Pushes the balance to Flip
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

    // Get the Flip "Annual Leave" policy to reference
    const policiesResult = await flip.getAbsencePolicies('annual_leave');
    const annualLeavePolicy = policiesResult.items?.[0];

    if (!annualLeavePolicy) {
      throw new Error('Annual Leave policy not found in Flip. Run policy sync first.');
    }

    // Fetch ALL holiday allowances from BreatheHR upfront
    // The employee record only has { name, id } — the amount is in this list
    const allowancesResult = await breathe.listHolidayAllowances();
    const allowanceMap = new Map<number, { amount: number; units: string }>();
    for (const ha of allowancesResult.holiday_allowances || []) {
      allowanceMap.set(ha.id, {
        amount: parseFloat(ha.amount) || 0,
        units: ha.units || 'days',
      });
    }

    console.log(`[SyncBalances] Loaded ${allowanceMap.size} holiday allowances from BreatheHR`);

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

        const totalDays = allowanceDetails?.amount || 0;
        const isHours = allowanceDetails?.units === 'hours';
        const timeUnit = isHours ? 'HOURS' : 'DAYS';

        // Get absences to calculate taken days
        const absences = await breathe.getAllEmployeeAbsences(mapping.breatheEmployeeId);

        // Calculate taken days (sum of deducted days from non-cancelled absences)
        // BreatheHR doesn't have a "status" field — absences are either active or cancelled
        // deducted is returned as a string like "2.0"
        const takenDays = absences
          .filter((a: Record<string, unknown>) => {
            return a.cancelled !== true && a.cancelled !== 'true';
          })
          .reduce((sum: number, a: Record<string, unknown>) => {
            return sum + (parseFloat(String(a.deducted || '0')) || 0);
          }, 0);

        const availableDays = Math.max(0, totalDays - takenDays);

        const balance: FlipSyncBalance = {
          user_id: mapping.flipUserId,
          policy: {
            external_id: 'annual_leave',
          },
          balance: {
            total: totalDays,
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
            `total=${totalDays}, taken=${takenDays}, available=${availableDays} ${timeUnit}`
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
    const batchSize = 100;
    for (let i = 0; i < balances.length; i += batchSize) {
      const batch = balances.slice(i, i + batchSize);
      await flip.syncBalances(batch);
      console.log(
        `[SyncBalances] Pushed batch ${Math.floor(i / batchSize) + 1} (${batch.length} balances)`
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
      balances_sent: balances.map(b => ({
        user: b.user_id,
        total: b.balance.total,
        taken: b.balance.taken,
        available: b.balance.available,
      })),
    });
  } catch (error) {
    console.error('[SyncBalances] Error:', error);
    res.status(500).json({
      error: 'Balance sync failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
