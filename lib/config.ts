/**
 * Environment configuration with validation
 */
export interface Config {
  breathehr: {
    apiKey: string;
    baseUrl: string;
  };
  flip: {
    apiToken: string;
    clientId: string;
    baseUrl: string;
    webhookSecret?: string;
  };
  sync: {
    batchSize: number;
  };
}

export function getConfig(): Config {
  const breathehrApiKey = process.env.BREATHEHR_API_KEY;
  const flipApiToken = process.env.FLIP_API_TOKEN;
  const flipClientId = process.env.FLIP_CLIENT_ID;
  const flipBaseUrl = process.env.FLIP_BASE_URL;

  if (!breathehrApiKey) throw new Error('BREATHEHR_API_KEY is required');
  if (!flipApiToken) throw new Error('FLIP_API_TOKEN is required');
  if (!flipClientId) throw new Error('FLIP_CLIENT_ID is required');
  if (!flipBaseUrl) throw new Error('FLIP_BASE_URL is required');

  return {
    breathehr: {
      apiKey: breathehrApiKey,
      baseUrl: process.env.BREATHEHR_BASE_URL || 'https://api.breathehr.com/v1',
    },
    flip: {
      apiToken: flipApiToken,
      clientId: flipClientId,
      baseUrl: flipBaseUrl.replace(/\/$/, ''), // strip trailing slash
      webhookSecret: process.env.FLIP_WEBHOOK_SECRET || undefined,
    },
    sync: {
      batchSize: parseInt(process.env.SYNC_BATCH_SIZE || '100', 10),
    },
  };
}
