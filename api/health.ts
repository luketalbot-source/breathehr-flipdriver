import type { VercelRequest, VercelResponse } from '@vercel/node';
import { BreatheHRClient } from '../lib/breathehr';
import { FlipClient } from '../lib/flip';

/**
 * Health check endpoint
 *
 * GET /api/health
 *
 * Tests connectivity to both BreatheHR and Flip APIs.
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const breathe = new BreatheHRClient();
  const flip = new FlipClient();

  const [breatheOk, flipOk] = await Promise.all([
    breathe.healthCheck(),
    flip.healthCheck(),
  ]);

  const allOk = breatheOk && flipOk;

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    services: {
      breathehr: breatheOk ? 'connected' : 'error',
      flip: flipOk ? 'connected' : 'error',
    },
    version: '1.0.0',
  });
}
