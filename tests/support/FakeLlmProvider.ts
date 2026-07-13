import type { LlmProvider, LlmReplyRequest, LlmReplyResult } from "../../src/llm/LlmProvider";

/** A fake LlmProvider that returns a scripted sequence of replies and records every request it received, for tests that need to assert on exactly what the Conversation Engine sent the model. */
export class FakeLlmProvider implements LlmProvider {
  readonly requests: LlmReplyRequest[] = [];
  private readonly scriptedReplies: string[];
  /** Message indices (0-based, in scriptedReplies order) whose reply should be returned as truncated -- for tests exercising the truncation guardrail. */
  private readonly truncatedIndices: Set<number>;
  private callIndex = 0;

  constructor(scriptedReplies: string[], truncatedIndices: number[] = []) {
    this.scriptedReplies = scriptedReplies;
    this.truncatedIndices = new Set(truncatedIndices);
  }

  async generateReply(request: LlmReplyRequest): Promise<LlmReplyResult> {
    this.requests.push(request);
    const text = this.scriptedReplies[this.callIndex] ?? this.scriptedReplies[this.scriptedReplies.length - 1];
    const truncated = this.truncatedIndices.has(this.callIndex);
    this.callIndex++;
    return { text, truncated };
  }

  async checkHealth(): Promise<void> {
    // no-op for tests
  }
}
