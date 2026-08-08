import { useEffect } from "react";

/**
 * Polls a callback while `enabled` is true. Used to keep parsing progress
 * live — the interval mirrors the API sweeper's POLL_INTERVAL_MS default.
 * The callback must be stable (useCallback) so the timer isn't recreated.
 */
export function useInterval(callback: () => void, enabled: boolean, intervalMs = 5000): void {
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(callback, intervalMs);
    return () => clearInterval(timer);
  }, [callback, enabled, intervalMs]);
}
