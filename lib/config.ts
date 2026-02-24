/**
 * Environment configuration with validation
 */
export interface Config {
  breathehr: {
    apiKey: string;
    baseUrl: string;
  };
  flip: {
    clientId: string;
    clientSecret: string;
    baseUrl: string;
    organization: string;
    webhookSecret?: string;
  };
  sync: {
    batchSize: number;
  };
}

export function getConfig(): Config {
  const breathehrApiKey = process.env.BREATHEHR_API_KEY;
  const flipClientId = process.env.FLIP_CLIENT_ID;
  const flipClientSecret = process.env.FLIP_CLIENT_SECRET;
  const flipBaseUrl = process.env.FLIP_BASE_URL;
  const flipOrg = process.env.FLIP_ORG;

  if (!breathehrApiKey) throw new Error('BREATHEHR_API_KEY is required');
  if (!flipClientId) throw new Error('FLIP_CLIENT_ID is required');
  if (!flipClientSecret) throw new Error('FLIP_CLIENT_SECRET is required');
  if (!flipBaseUrl) throw new Error('FLIP_BASE_URL is required');
  if (!flipOrg) throw new Error('FLIP_ORG is required');

  return {
    breathehr: {
      apiKey: breathehrApiKey,
      baseUrl: process.env.BREATHEHR_BASE_URL || 'https://api.breathehr.com/v1',
    },
    flip: {
      clientId: flipClientId,
      clientSecret: flipClientSecret,
      baseUrl: flipBaseUrl.replace(/\/$/, ''),
      organization: flipOrg,
      webhookSecret: process.env.FLIP_WEBHOOK_SECRET || undefined,
    },
    sync: {
      batchSize: parseInt(process.env.SYNC_BATCH_SIZE || '100', 10),
    },
  };
}
