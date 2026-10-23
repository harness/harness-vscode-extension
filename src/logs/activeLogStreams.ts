import { openLogStream, LogStreamHandle, LogStreamConfig } from '../api/logStream';
import { logger } from '../utils/logger';

/**
 * Tracks the one live tail per step node. Starting a new stream for a nodeId
 * closes any previous one first, so a re-expand or retry never doubles up.
 * The extension does not keep a stream open indefinitely — callers are
 * expected to stop() it once the step goes terminal (plus a short drain) or
 * the viewed execution changes.
 */
export class ActiveLogStreams {
  private streams = new Map<string, LogStreamHandle>();

  isActive(nodeId: string): boolean {
    return this.streams.has(nodeId);
  }

  activeNodeIds(): string[] {
    return [...this.streams.keys()];
  }

  start(
    nodeId: string,
    config: LogStreamConfig,
    key: string,
    onLines: (lines: string[]) => void,
  ): void {
    this.stop(nodeId);
    logger.debug('LogStream', 'tail started', { nodeId, key });
    const handle = openLogStream(
      config,
      key,
      {
        onLines,
        onDone: () => {
          logger.debug('LogStream', 'tail ended', { nodeId });
          this.streams.delete(nodeId);
        },
        onError: (err) => {
          logger.debug('LogStream', 'tail error', { nodeId, err: String(err) });
          this.streams.delete(nodeId);
        },
      },
    );
    this.streams.set(nodeId, handle);
  }

  stop(nodeId: string): void {
    const handle = this.streams.get(nodeId);
    if (!handle) return;
    handle.close();
    this.streams.delete(nodeId);
  }

  stopAll(): void {
    for (const handle of this.streams.values()) handle.close();
    this.streams.clear();
  }
}
