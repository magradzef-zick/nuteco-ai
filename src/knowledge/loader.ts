import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Loads the Nuteco knowledge base from the `knowledge/` directory.
 *
 * Design notes:
 * - The entire knowledge base is injected into every LLM call ("full-context
 *   stuffing"), not retrieved from a vector database. This loader's only
 *   job is to read the current files and hand back one combined block of
 *   text -- there is no indexing, chunking-for-retrieval, or embedding step.
 * - `faq/FAQ.md` is intentionally NOT loaded here. It is a human-facing
 *   reference document, not a source the assistant reads from.
 * - Results are cached briefly (see CACHE_TTL_MS) so a burst of messages
 *   doesn't re-read the filesystem on every single one, while an edited
 *   price still takes effect within about a minute, with no redeploy.
 *
 * This function is intentionally generic underneath (read every .md file
 * in a directory, concatenate with a "Source:" header, cache the result) --
 * `src/prompts/loader.ts`'s `loadSystemPrompt` reuses it directly for the
 * `prompts/` directory rather than duplicating the same read/cache logic.
 * The cache is keyed by directory so that reuse is safe: two different
 * directories never silently overwrite each other's cached content.
 */

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  text: string;
  loadedAt: number;
}

const caches = new Map<string, CacheEntry>();

export interface KnowledgeBaseOptions {
  /** Absolute or relative path to the directory of markdown files to load. */
  knowledgeDir: string;
  /** Bypass the cache and re-read from disk. Mainly useful for tests. */
  forceReload?: boolean;
}

/**
 * Returns the combined content of every `.md` file in `options.knowledgeDir`,
 * with a clear "Source:" header before each file's content so the model
 * (and a human reading logs) can tell which file a fact came from.
 */
export function loadKnowledgeBase(options: KnowledgeBaseOptions): string {
  const now = Date.now();
  const cacheKey = resolve(options.knowledgeDir);
  const cached = caches.get(cacheKey);

  if (!options.forceReload && cached && now - cached.loadedAt < CACHE_TTL_MS) {
    return cached.text;
  }

  let fileNames: string[];
  try {
    fileNames = readdirSync(options.knowledgeDir)
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch (cause) {
    throw new Error(
      `Could not read the directory "${options.knowledgeDir}" -- it likely doesn't exist or this process ` +
        `doesn't have permission to read it. Check the configured path points at a real folder of .md files.`,
      { cause }
    );
  }

  if (fileNames.length === 0) {
    throw new Error(
      `The directory "${options.knowledgeDir}" exists but contains no .md files. The assistant cannot ` +
        "function without this content -- confirm the expected files actually live at this path."
    );
  }

  const sections = fileNames.map((fileName) => {
    const filePath = join(options.knowledgeDir, fileName);
    const content = readFileSync(filePath, "utf-8").trim();
    return `## Source: ${fileName}\n\n${content}`;
  });

  const text = sections.join("\n\n---\n\n");

  caches.set(cacheKey, { text, loadedAt: now });
  return text;
}

/** Clears the in-memory cache for every directory. Used by tests so one test can't see another's cached result. */
export function clearKnowledgeBaseCache(): void {
  caches.clear();
}
