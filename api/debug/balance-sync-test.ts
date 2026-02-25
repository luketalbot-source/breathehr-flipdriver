import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FlipClient } from '../../lib/flip';
import { getConfig } from '../../lib/config';

/**
 * Debug endpoint to test balance sync with raw HTTP response capture
 *
 * GET /api/debug/balance-sync-test
 *
 * Makes a direct balance sync call and returns the full HTTP response details
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  try {
    const flip = new FlipClient();
    const config = getConfig();

    // Get the Annual Leave policy
    const policiesResult = await flip.getAbsencePolicies('annual_leave');
    const annualLeavePolicy = policiesResult.items?.[0];

    if (!annualLeavePolicy) {
      res.status(200).json({ error: 'Annual Leave policy not found' });
      return;
    }

    // Prepare the balance payload
    const payload = {
      items: [
        {
          user_id: '3d32eb7a-65d7-4f45-8b48-5de62a92adc5', // Luke
          policy: {
            id: annualLeavePolicy.id,
            external_id: annualLeavePolicy.external_id || 'annual_leave',
          },
          balance: {
            external_id: 'breathehr_2160859_annual_leave',
            total: 20.0,
            available: 6.0,
            taken: 14.0,
            unlimited: false,
            time_unit: 'DAYS',
          },
        },
      ],
    };

    // Get token
    const token = await flip.getAccessToken();

    // Make the raw HTTP call to capture full response
    const url = `${config.flip.baseUrl}/api/hr/v4/integration/balances/sync`;

    console.log(`[BalanceSyncTest] POST ${url}`);
    console.log(`[BalanceSyncTest] Payload: ${JSON.stringify(payload, null, 2)}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    // Capture ALL response details
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const responseBody = await response.text();

    // Also try GET balances endpoint
    let getBalancesResponse;
    try {
      const getResp = await fetch(
        `${config.flip.baseUrl}/api/hr/v4/integration/balances?user_id=3d32eb7a-65d7-4f45-8b48-5de62a92adc5`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json',
          },
        }
      );
      const getHeaders: Record<string, string> = {};
      getResp.headers.forEach((value, key) => {
        getHeaders[key] = value;
      });
      const getBody = await getResp.text();
      getBalancesResponse = {
        status: getResp.status,
        statusText: getResp.statusText,
        headers: getHeaders,
        body: getBody,
      };
    } catch (error) {
      getBalancesResponse = {
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // Also try: POST to update a specific balance (need to know the balance_id though)
    // Let's try to see what other balance-related endpoints exist

    res.status(200).json({
      sync_request: {
        url,
        payload,
      },
      sync_response: {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: responseBody,
        body_length: responseBody.length,
      },
      get_balances_response: getBalancesResponse,
      policy: {
        id: annualLeavePolicy.id,
        name: annualLeavePolicy.name,
        external_id: annualLeavePolicy.external_id,
        time_unit: annualLeavePolicy.time_unit,
        time_units: annualLeavePolicy.time_units,
      },
    });
  } catch (error) {
    res.status(500).json({
      error: 'Test failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
