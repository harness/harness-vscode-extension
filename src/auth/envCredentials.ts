// Environment variable credential reader
// Reads HARNESS_* env vars for power users who prefer shell-based auth

export interface EnvCredentials {
  allPresent: boolean;
  baseUrl: string | null;
  apiKey: string | null;
  accountId: string | null;
}

/**
 * Read Harness credentials from environment variables.
 * Reads once per session, never writes to disk.
 *
 * @returns Object with allPresent=true only when all three vars are non-empty strings
 */
export function readEnvCredentials(): EnvCredentials {
  const baseUrl = (process.env.HARNESS_BASE_URL || '').trim() || null;
  const apiKey = (process.env.HARNESS_API_KEY || '').trim() || null;
  const accountId = (process.env.HARNESS_ACCOUNT_ID || '').trim() || null;

  return {
    allPresent: baseUrl !== null && apiKey !== null && accountId !== null,
    baseUrl,
    apiKey,
    accountId,
  };
}
