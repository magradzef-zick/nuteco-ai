import { loadKnowledgeBase } from "../knowledge/loader";

/** Same job as the knowledge-base loader (read a directory of .md, concatenate, cache), so it reuses it. */
export function loadSystemPrompt(promptsDir: string, options?: { forceReload?: boolean }): string {
  return loadKnowledgeBase({ knowledgeDir: promptsDir, forceReload: options?.forceReload });
}
