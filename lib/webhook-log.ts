/**
 * Simple in-memory webhook log for debugging.
 * Stores the last 20 webhook payloads received.
 * Note: This resets on each cold start (serverless), but useful for debugging.
 */

interface WebhookLogEntry {
  timestamp: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  result?: string;
  error?: string;
}

const MAX_ENTRIES = 20;
const entries: WebhookLogEntry[] = [];

export function logWebhook(entry: WebhookLogEntry): void {
  entries.unshift(entry); // newest first
  if (entries.length > MAX_ENTRIES) {
    entries.pop();
  }
}

export function getWebhookLogs(): WebhookLogEntry[] {
  return [...entries];
}
