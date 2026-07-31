import { existsSync } from "node:fs";

/**
 * Loads a .env file if it exists, no-op otherwise.
 *
 * Node's `--env-file` flag throws when the file is missing, which breaks
 * Docker: .env is excluded from the image and the variables are already
 * in the environment by then.
 */
export function loadEnvIfPresent(path = ".env"): void {
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}
