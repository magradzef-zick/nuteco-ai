import { loadKnowledgeBase } from "../knowledge/loader";

/**
 * Loads the production system prompt from the `prompts/` directory. This
 * is a thin, purpose-named wrapper around the exact same generic
 * markdown-directory loader `knowledge/loader.ts` already uses -- reused
 * directly rather than re-implemented, including its caching and error
 * handling, since the underlying job (read every .md file in a directory,
 * concatenate it, cache briefly) is identical. See that file's doc comment
 * for why its cache is safe to share across two different directories.
 */
export function loadSystemPrompt(promptsDir: string, options?: { forceReload?: boolean }): string {
  return loadKnowledgeBase({ knowledgeDir: promptsDir, forceReload: options?.forceReload });
}
