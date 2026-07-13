import type { Logger } from "../observability/logger";

/** How long to wait for an in-flight request / clean server close before giving up and forcing an exit. */
const DEFAULT_FORCE_EXIT_TIMEOUT_MS = 10_000;

export interface ShutdownDependencies {
  /** Just the piece of node:http's Server this needs -- narrowed for easy testing without a real server/socket. */
  server: { close: (callback: (err?: Error) => void) => void };
  /** Releases any other held resources (currently: the database connection). */
  closeResources: () => void | Promise<void>;
  logger: Logger;
  forceExitAfterMs?: number;
  /** Injectable so tests can observe the exit code instead of actually terminating the test process. */
  exit: (code: number) => void;
}

/**
 * Builds a signal handler that shuts the process down gracefully:
 * stop accepting new connections, let in-flight requests finish, release
 * resources, then exit cleanly. A second SIGINT/SIGTERM while this is
 * already in progress forces an immediate exit instead -- if graceful
 * shutdown is hanging, the operator needs a way out. A timer provides the
 * same guarantee even without a second signal (e.g. a stuck connection
 * that never closes on its own).
 */
export function createShutdownHandler(deps: ShutdownDependencies) {
  let isShuttingDown = false;

  return async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) {
      deps.logger.warn("shutdown.forced_by_repeated_signal", { signal });
      deps.exit(1);
      return;
    }
    isShuttingDown = true;

    deps.logger.info("shutdown.begin", { signal });

    const forceExitTimer = setTimeout(() => {
      deps.logger.error("shutdown.forced_after_timeout", {
        signal,
        timeoutMs: deps.forceExitAfterMs ?? DEFAULT_FORCE_EXIT_TIMEOUT_MS,
      });
      deps.exit(1);
    }, deps.forceExitAfterMs ?? DEFAULT_FORCE_EXIT_TIMEOUT_MS);
    forceExitTimer.unref?.();

    await new Promise<void>((resolve) => {
      deps.server.close((err) => {
        if (err) {
          deps.logger.error("shutdown.server_close_error", { error: err.message });
        }
        resolve();
      });
    });

    try {
      await deps.closeResources();
    } catch (error) {
      deps.logger.error("shutdown.resource_close_error", { error: (error as Error).message });
    }

    clearTimeout(forceExitTimer);
    deps.logger.info("shutdown.complete", { signal });
    deps.exit(0);
  };
}
