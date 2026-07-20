import { existsSync } from "node:fs";

/**
 * Loads a .env file into process.env if it exists; does nothing otherwise.
 *
 * Node's own `--env-file` CLI flag does the same thing but throws hard if
 * the file is missing -- correct for local development (where `.env` is
 * always expected to exist per the README setup steps) but wrong for
 * anything that also needs to run inside Docker, where `.env` is
 * deliberately excluded from the image (see .dockerignore) and env vars
 * are already injected via docker-compose's `env_file` directive by the
 * time this process starts. Calling this instead of relying on
 * `--env-file` lets the exact same entrypoint work in both places: it
 * loads the file locally, and is a no-op when the variables are already
 * present in the environment.
 */
export function loadEnvIfPresent(path = ".env"): void {
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}
