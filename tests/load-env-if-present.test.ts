import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvIfPresent } from "../src/shared/loadEnvIfPresent";

test("loads variables from the file when it exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "load-env-test-"));
  const envPath = join(dir, ".env");
  const varName = "LOAD_ENV_TEST_VAR_" + Date.now();
  writeFileSync(envPath, `${varName}=hello\n`);

  try {
    assert.equal(process.env[varName], undefined, "sanity check -- must not already be set");
    loadEnvIfPresent(envPath);
    assert.equal(process.env[varName], "hello");
  } finally {
    delete process.env[varName];
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does nothing, and does not throw, when the file does not exist", () => {
  assert.doesNotThrow(() => loadEnvIfPresent("/definitely/does/not/exist/.env"));
});
