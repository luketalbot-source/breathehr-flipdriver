import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FlipClient } from '../../lib/flip';
import { getConfig } from '../../lib/config';

/**
 * Debug: Test if Flip validates balance sync data or just accepts anything
 *
 * GET /api/debug/balance-validation-test
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  try {
    const flip = new FlipClient();
    const config = getConfig();
    const token = await flip.getAccessToken();
    const url = `${config.flip.baseUrl}/api/hr/v4/integration/balances/sync`;

    const tests: Array<{ name: string; payload: unknown; status?: number; body?: string }> = [];

    // Test 1: Valid payload (our normal sync)
    const test1Payload = {
      items: [{
        user_id: '3d32eb7a-65d7-4f45-8b48-5de62a92adc5',
        policy: { id: 'a94075d7-2ae9-436e-b003-eb186729481c' },
        balance: { total: 20, available: 6, taken: 14, unlimited: false, time_unit: 'DAYS' },
      }],
    };

    // Test 2: Invalid user ID
    const test2Payload = {
      items: [{
        user_id: '00000000-0000-0000-0000-000000000000',
        policy: { id: 'a94075d7-2ae9-436e-b003-eb186729481c' },
        balance: { total: 99, available: 99, taken: 0, unlimited: false, time_unit: 'DAYS' },
      }],
    };

    // Test 3: Invalid policy ID
    const test3Payload = {
      items: [{
        user_id: '3d32eb7a-65d7-4f45-8b48-5de62a92adc5',
        policy: { id: '00000000-0000-0000-0000-000000000000' },
        balance: { total: 99, available: 99, taken: 0, unlimited: false, time_unit: 'DAYS' },
      }],
    };

    // Test 4: Empty items
    const test4Payload = { items: [] };

    // Test 5: No items key
    const test5Payload = {};

    // Test 6: Garbage
    const test6Payload = { foo: 'bar' };

    const allPayloads = [
      { name: 'valid_payload', payload: test1Payload },
      { name: 'invalid_user', payload: test2Payload },
      { name: 'invalid_policy', payload: test3Payload },
      { name: 'empty_items', payload: test4Payload },
      { name: 'no_items', payload: test5Payload },
      { name: 'garbage', payload: test6Payload },
    ];

    for (const test of allPayloads) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify(test.payload),
        });
        const body = await response.text();
        tests.push({
          name: test.name,
          payload: test.payload,
          status: response.status,
          body: body || '(empty)',
        });
      } catch (error) {
        tests.push({
          name: test.name,
          payload: test.payload,
          body: error instanceof Error ? error.message : String(error),
        });
      }
    }

    res.status(200).json({ tests });
  } catch (error) {
    res.status(500).json({
      error: 'Test failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
