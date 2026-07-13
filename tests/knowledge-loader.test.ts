import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKnowledgeBase, clearKnowledgeBaseCache } from "../src/knowledge/loader";

function makeTempKnowledgeDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "nuteco-kb-test-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf-8");
  }
  return dir;
}

test("combines all markdown files in the knowledge directory", () => {
  clearKnowledgeBaseCache();
  const dir = makeTempKnowledgeDir({
    "company.md": "Nuteco is a nut butter producer.",
    "products.md": "Almond flour costs 150.000 per kg.",
  });

  const text = loadKnowledgeBase({ knowledgeDir: dir, forceReload: true });

  assert.match(text, /Nuteco is a nut butter producer\./);
  assert.match(text, /Almond flour costs 150\.000 per kg\./);
  assert.match(text, /Source: company\.md/);
  assert.match(text, /Source: products\.md/);

  rmSync(dir, { recursive: true, force: true });
});

test("ignores non-markdown files", () => {
  clearKnowledgeBaseCache();
  const dir = makeTempKnowledgeDir({
    "company.md": "Real content.",
    "notes.txt": "Should not appear.",
  });

  const text = loadKnowledgeBase({ knowledgeDir: dir, forceReload: true });

  assert.match(text, /Real content\./);
  assert.doesNotMatch(text, /Should not appear\./);

  rmSync(dir, { recursive: true, force: true });
});

test("caches results until forceReload is used", () => {
  clearKnowledgeBaseCache();
  const dir = makeTempKnowledgeDir({ "company.md": "Version one." });

  const first = loadKnowledgeBase({ knowledgeDir: dir, forceReload: true });
  assert.match(first, /Version one\./);

  writeFileSync(join(dir, "company.md"), "Version two.", "utf-8");

  const cached = loadKnowledgeBase({ knowledgeDir: dir });
  assert.match(cached, /Version one\./, "should still return the cached value");

  const refreshed = loadKnowledgeBase({ knowledgeDir: dir, forceReload: true });
  assert.match(refreshed, /Version two\./, "forceReload should pick up the change");

  rmSync(dir, { recursive: true, force: true });
});

test("throws a clear, actionable error when the directory exists but has no markdown files", () => {
  clearKnowledgeBaseCache();
  const dir = makeTempKnowledgeDir({});

  assert.throws(
    () => loadKnowledgeBase({ knowledgeDir: dir, forceReload: true }),
    /exists but contains no \.md files/
  );

  rmSync(dir, { recursive: true, force: true });
});

test("throws a clear, actionable error (distinct from the empty-directory case) when the directory doesn't exist at all", () => {
  clearKnowledgeBaseCache();

  assert.throws(
    () => loadKnowledgeBase({ knowledgeDir: "/nonexistent/path/for/testing", forceReload: true }),
    /Could not read the directory/
  );
});

test("caching two different directories doesn't let one overwrite the other's cached content", () => {
  // Regression test: the cache used to be a single global slot, so calling
  // this function for a second directory (e.g. prompts/, once the Gemini
  // integration reuses this same loader) would silently return the wrong
  // directory's content if called within the same cache window.
  clearKnowledgeBaseCache();
  const dirA = makeTempKnowledgeDir({ "a.md": "Content A." });
  const dirB = makeTempKnowledgeDir({ "b.md": "Content B." });

  const textA = loadKnowledgeBase({ knowledgeDir: dirA, forceReload: true });
  const textB = loadKnowledgeBase({ knowledgeDir: dirB, forceReload: true });

  assert.match(textA, /Content A\./);
  assert.doesNotMatch(textA, /Content B\./);
  assert.match(textB, /Content B\./);
  assert.doesNotMatch(textB, /Content A\./);

  // Re-reading each from cache (no forceReload) must still return its own content.
  assert.match(loadKnowledgeBase({ knowledgeDir: dirA }), /Content A\./);
  assert.match(loadKnowledgeBase({ knowledgeDir: dirB }), /Content B\./);

  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

test("loads the real production knowledge base directory without error", () => {
  clearKnowledgeBaseCache();
  const realKnowledgeDir = join(__dirname, "..", "knowledge");

  const text = loadKnowledgeBase({ knowledgeDir: realKnowledgeDir, forceReload: true });

  assert.ok(text.length > 0, "the real knowledge base should not be empty");
  assert.match(text, /Source: products\.md/);
  assert.match(text, /Source: restrictions\.md/);
});
