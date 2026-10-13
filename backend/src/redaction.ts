import { createHash } from 'crypto';

/**
 * Strip control characters and newlines to prevent log injection.
 */
export function sanitizeMessage(raw: string): string {
  return raw.replace(/[\r\n\x00-\x1F\x7F]/g, ' ').trim();
}

/**
 * Redact sensitive data (bearer tokens, api keys, emails, card numbers).
 */
export function redactSecrets(message: string): string {
  let redacted = message;

  // Bearer tokens
  redacted = redacted.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [REDACTED]');

  // Common API key patterns (e.g. sk-..., apikey=...)
  redacted = redacted.replace(/sk-[A-Za-z0-9_\-]{16,}/gi, '[REDACTED_KEY]');
  redacted = redacted.replace(
    /(?:api_key|apikey|api-key|secret|token)\s*[:=]\s*['"]?[A-Za-z0-9_\-\.]+['"]?/gi,
    'api_key=[REDACTED_KEY]'
  );

  // Email addresses
  redacted = redacted.replace(
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    '[REDACTED_EMAIL]'
  );

  // Credit card-like sequences (13 to 16 digits, with optional spaces or dashes)
  redacted = redacted.replace(
    /\b(?:\d[ -]*?){13,16}\b/g,
    '[REDACTED_CARD]'
  );

  return redacted;
}

/**
 * Computes a deterministic SHA-256 hash of the cleaned message for clustering and deduplication.
 */
export function computeMessageHash(message: string): string {
  return createHash('sha256').update(message).digest('hex');
}
