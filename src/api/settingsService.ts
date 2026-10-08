import { HarnessConfig } from '../config/configManager';
import { logger } from '../utils/logger';

/** Default timeout for a settings lookup. Kept short so a slow Settings API never stalls the UI. */
export const SETTINGS_TIMEOUT_MS = 5000;

export interface HarnessSetting {
  valueType?: string;
  value: string;
}

interface SettingResponse {
  status?: string;
  data?: { valueType?: string; value?: unknown } | null;
}

/**
 * Reads a single Harness setting scoped to the configured account/org/project.
 * GET /ng/api/settings/{identifier}?accountIdentifier=...&orgIdentifier=...&projectIdentifier=...
 *
 * Returns `null` when the setting could not be read (HTTP error, timeout, network
 * failure, or a response without `data.value`). Callers decide what "unknown" means.
 */
export async function getSetting(
  config: HarnessConfig,
  identifier: string,
  timeoutMs: number = SETTINGS_TIMEOUT_MS
): Promise<HarnessSetting | null> {
  const qs = new URLSearchParams({
    accountIdentifier: config.accountIdentifier,
    orgIdentifier: config.orgIdentifier,
    projectIdentifier: config.projectIdentifier,
  });
  const url = `${config.baseUrl}/ng/api/settings/${encodeURIComponent(identifier)}?${qs}`;
  logger.debug('SettingsService', `getSetting(${identifier}) →`, url);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        'x-api-key': config.apiKey,
        'Content-Type': 'application/json',
        'Harness-Account': config.accountIdentifier,
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn('SettingsService', `getSetting(${identifier}) HTTP ${res.status}:`, text.slice(0, 200));
      return null;
    }

    const json = (await res.json()) as SettingResponse;
    const value = json?.data?.value;
    if (value === undefined || value === null) {
      logger.warn('SettingsService', `getSetting(${identifier}) response had no data.value`);
      return null;
    }

    logger.debug('SettingsService', `getSetting(${identifier}) value:`, String(value));
    return { valueType: json.data?.valueType, value: String(value) };
  } catch (err) {
    const aborted = (err as Error)?.name === 'AbortError';
    logger.warn(
      'SettingsService',
      aborted
        ? `getSetting(${identifier}) timed out after ${timeoutMs}ms`
        : `getSetting(${identifier}) failed:`,
      aborted ? undefined : err
    );
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Three-state boolean lookup:
 *  - `true`  → the setting is exactly "true"
 *  - `false` → the setting is exactly "false"
 *  - `null`  → unknown (error, timeout, or an unrecognised value)
 *
 * Use this when the caller needs to tell "admin said no" apart from "couldn't ask"
 * (e.g. to keep retrying only in the second case).
 */
export async function fetchBooleanSetting(
  config: HarnessConfig,
  identifier: string,
  timeoutMs: number = SETTINGS_TIMEOUT_MS
): Promise<boolean | null> {
  const setting = await getSetting(config, identifier, timeoutMs);
  if (!setting) return null;

  const normalized = setting.value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

  logger.warn('SettingsService', `Setting ${identifier} has non-boolean value:`, setting.value);
  return null;
}

/**
 * Convenience wrapper: only an explicit "true" yields `true`. Anything else,
 * including errors and timeouts, yields `false`.
 */
export async function getBooleanSetting(
  config: HarnessConfig,
  identifier: string,
  timeoutMs: number = SETTINGS_TIMEOUT_MS
): Promise<boolean> {
  return (await fetchBooleanSetting(config, identifier, timeoutMs)) === true;
}
