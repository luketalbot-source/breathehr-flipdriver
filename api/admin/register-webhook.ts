import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FlipClient } from '../../lib/flip';

/**
 * Admin endpoint for webhook management in Flip.
 *
 * GET  /api/admin/register-webhook  → List existing webhooks
 * POST /api/admin/register-webhook  → Register absence request webhook
 *
 * Flip event types use dot-separated prefixes (e.g. "hr.absence-request").
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  try {
    const flip = new FlipClient();
    const token = await flip.getAccessToken();
    const flipBaseUrl = process.env.FLIP_BASE_URL || 'https://show.flipnext.de';

    // GET: List existing webhooks
    if (req.method === 'GET') {
      const response = await fetch(
        `${flipBaseUrl}/api/webhooks/v4/webhooks?show_authentication=true`,
        {
          headers: { 'Authorization': `Bearer ${token}` },
        }
      );
      const body = await response.json();
      res.status(response.status).json(body);
      return;
    }

    // DELETE: Delete a webhook by ID (pass ?id=xxx)
    if (req.method === 'DELETE') {
      const webhookId = req.query.id as string;
      if (!webhookId) {
        res.status(400).json({ error: 'Missing ?id= parameter' });
        return;
      }
      const delResp = await fetch(`${flipBaseUrl}/api/webhooks/v4/webhooks/${webhookId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      res.status(delResp.status).json({
        status: delResp.ok ? 'deleted' : 'error',
        webhook_id: webhookId,
      });
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed. Use GET, POST, or DELETE.' });
      return;
    }

    // POST: Register webhook
    const host = req.headers['x-forwarded-host'] || req.headers['host'];
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const webhookUrl = `${protocol}://${host}/api/webhooks/absence-request`;

    // Allow overriding event types via request body for testing
    const eventTypes = req.body?.event_types || ['hr.absence-request'];

    console.log(`[Admin] Registering webhook URL: ${webhookUrl}`);
    console.log(`[Admin] Event types: ${JSON.stringify(eventTypes)}`);

    const response = await fetch(`${flipBaseUrl}/api/webhooks/v4/webhooks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: webhookUrl,
        subscription: {
          event_types: eventTypes,
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
      console.error(`[Admin] Webhook registration failed: ${response.status}`, parsed);
      res.status(response.status).json({
        error: 'Flip webhook registration failed',
        status: response.status,
        attempted_event_types: eventTypes,
        details: parsed,
      });
      return;
    }

    console.log('[Admin] Webhook registered successfully:', parsed);

    res.status(200).json({
      status: 'ok',
      message: 'Webhook registered successfully',
      webhook_url: webhookUrl,
      event_types: eventTypes,
      flip_response: parsed,
    });
  } catch (error) {
    console.error('[Admin] Error:', error);
    res.status(500).json({
      error: 'Failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
