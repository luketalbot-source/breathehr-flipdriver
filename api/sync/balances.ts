import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BreatheHRClient } from '../../lib/breathehr';
import { FlipClient } from '../../lib/flip';
import { UserMappingService } from '../../lib/user-mapping';
import type { FlipSyncBalance, BreatheEmployee } from '../../lib/types';

/**
 * Sync leave balances from BreatheHR to Flip
 *
 * POST /api/sync/balances
 *
 * For each mapped user:
 * 1. Gets their holiday allowance from BreatheHR
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

    const balances: FlipSyncBalance[] = [];
    let successCount = 0;
    let errorCount = 0;

    for (const mapping of mappings) {
      try {
        // Get employee details from BreatheHR (includes holiday_allowance)
        const empResult = await breathe.getEmployee(mapping.breatheEmployeeId);
        const employee: BreatheEmployee | undefined =
          empResult.employees?.[0];

        if (!employee) {
          console.warn(
            `[SyncBalances] Employee ${mapping.breatheEmployeeId} not found in BreatheHR`
          );
          errorCount++;
          continue;
        }

        // Extract holiday allowance
        const allowance = employee.holiday_allowance;
        const totalDays = allowance?.amount || 0;

        // Get absences to calculate taken days
        const absences = await breathe.getAllEmployeeAbsences(mapping.breatheEmployeeId);

        // Calculate taken days (sum of deducted days from approved absences)
        const takenDays = absences
          .filter((a) => a.status === 'approved' || a.status === 'Approved')
          .reduce((sum, a) => sum + (a.deducted || 0), 0);

        const availableDays = Math.max(0, totalDays - takenDays);

        // Determine the time unit from BreatheHR
        const isHours = allowance?.units === 'hours';
        const timeUnit = isHours ? 'HOURS' : 'DAYS';

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
    });
  } catch (error) {
    console.error('[SyncBalances] Error:', error);
    res.status(500).json({
      error: 'Balance sync failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
