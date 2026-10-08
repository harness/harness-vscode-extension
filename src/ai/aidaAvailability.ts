import { HarnessConfig } from '../config/configManager';
import { fetchBooleanSetting } from '../api/settingsService';
import { logger } from '../utils/logger';

/**
 * - `checking`: no definitive answer yet for this org/project (first lookup in flight)
 * - `enabled`:  the admin setting is exactly "true"
 * - `disabled`: the setting is "false", or the lookup failed (fail closed)
 */
export type AidaStatus = 'checking' | 'enabled' | 'disabled';

/** Harness Settings API identifier that gates the native Harness AI chat. */
export const AIDA_SETTING_ID = 'aida';

/** Delay before each background retry. The last entry repeats indefinitely. */
export const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];

type Fetcher = (config: HarnessConfig, identifier: string) => Promise<boolean | null>;

/**
 * Tracks whether the admin has enabled Harness AI for the current org/project.
 *
 * Fails closed: only an explicit "true" enables it. When the Settings API cannot
 * be reached the status stays `disabled` and a background retry loop keeps
 * asking (5s, 15s, 30s, then every 60s) until it gets a real true/false answer.
 *
 * Never blocks callers during startup: `start()` returns immediately.
 */
export class AidaAvailability {
  private status: AidaStatus = 'checking';
  private generation = 0;
  private scopeKey: string | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private attempt = 0;

  constructor(
    private readonly onChange: (status: AidaStatus) => void,
    private readonly fetcher: Fetcher = fetchBooleanSetting
  ) {}

  getStatus(): AidaStatus {
    return this.status;
  }

  isEnabled(): boolean {
    return this.status === 'enabled';
  }

  /**
   * Begin (or restart) the background lookup for this config. Returns immediately.
   * The status only resets to `checking` when the org/project scope changed, so
   * unrelated settings changes don't make the footer flicker.
   */
  start(config: HarnessConfig): void {
    const generation = this.beginRun();
    const key = this.keyFor(config);
    if (key !== this.scopeKey) {
      this.scopeKey = key;
      this.setStatus('checking');
    }
    void this.run(config, generation);
  }

  /**
   * Fresh check, used right before opening the chat so an admin change is
   * picked up without a reload. Resolves `true` only for an explicit "true".
   * On error or timeout the status falls to `disabled` and the background
   * retry loop continues.
   */
  async refresh(config: HarnessConfig): Promise<boolean> {
    const generation = this.beginRun();
    this.scopeKey = this.keyFor(config);
    await this.run(config, generation);
    return this.status === 'enabled';
  }

  dispose(): void {
    this.generation++;
    this.clearRetry();
  }

  // ── internals ──────────────────────────────────────────────

  private keyFor(config: HarnessConfig): string {
    return [config.baseUrl, config.accountIdentifier, config.orgIdentifier, config.projectIdentifier].join('|');
  }

  /** Invalidates any in-flight lookup / pending retry and returns the new run id. */
  private beginRun(): number {
    this.clearRetry();
    this.attempt = 0;
    return ++this.generation;
  }

  private async run(config: HarnessConfig, generation: number): Promise<void> {
    let result: boolean | null;
    try {
      result = await this.fetcher(config, AIDA_SETTING_ID);
    } catch (err) {
      logger.warn('AidaAvailability', 'Lookup threw unexpectedly:', err);
      result = null;
    }

    // A newer start()/refresh()/dispose() superseded this lookup.
    if (generation !== this.generation) return;

    if (result === null) {
      this.setStatus('disabled');
      this.scheduleRetry(config, generation);
      return;
    }

    this.setStatus(result ? 'enabled' : 'disabled');
    logger.info('AidaAvailability', `Harness AI is ${result ? 'enabled' : 'disabled'} by admin setting`);
  }

  private scheduleRetry(config: HarnessConfig, generation: number): void {
    const delay = RETRY_DELAYS_MS[Math.min(this.attempt, RETRY_DELAYS_MS.length - 1)];
    this.attempt++;
    logger.debug('AidaAvailability', `Settings lookup failed; retrying in ${delay / 1000}s`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (generation !== this.generation) return;
      void this.run(config, generation);
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private setStatus(next: AidaStatus): void {
    if (next === this.status) return;
    this.status = next;
    this.onChange(next);
  }
}
