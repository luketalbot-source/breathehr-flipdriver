import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FlipClient } from '../../lib/flip';

/**
 * One-time admin endpoint to register the webhook URL in Flip.
 *
 * POST /api/admin/register-webhook
 *
 * This calls Flip's POST /api/webhooks/v4/webhooks endpoint
 * to subscribe to absence_request events.
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  try {
    const flip = new FlipClient();

    // Get the base URL for the webhook callback
    // Use the x-forwarded-host header or fall back to the host header
    const host = req.headers['x-forwarded-host'] || req.headers['host'];
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const webhookUrl = `${protocol}://${host}/api/webhooks/absence-request`;

    console.log(`[Admin] Registering webhook URL: ${webhookUrl}`);

    // Get an access token (reuses the FlipClient's OAuth2 flow)
    const token = await flip.getAccessToken();

    // Register webhook with Flip
    const flipBaseUrl = process.env.FLIP_BASE_URL || 'https://show.flipnext.de';
    const response = await fetch(`${flipBaseUrl}/api/webhooks/v4/webhooks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: webhookUrl,
        subscription: {
          event_types: [
            'absence_request.created',
            'absence_request.cancelled',
          ],
        },
      }),
    });

    const responseBody = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseBody);
    } catch {
      parsed = responseBody;
    }

    if (!response.ok) {
      console.error(`[Admin] Flip webhook registration failed: ${response.status}`, parsed);
      res.status(response.status).json({
        error: 'Flip webhook registration failed',
        status: response.status,
        details: parsed,
      });
      return;
    }

    console.log('[Admin] Webhook registered successfully:', parsed);

    res.status(200).json({
      status: 'ok',
      message: 'Webhook registered successfully',
      webhook_url: webhookUrl,
      flip_response: parsed,
    });
  } catch (error) {
    console.error('[Admin] Error registering webhook:', error);
    res.status(500).json({
      error: 'Failed to register webhook',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
