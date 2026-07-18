import type { MessageSender } from "./MessageSender";

/**
 * Dispatches to the right platform-specific MessageSender based on the
 * "<platform>:<id>" prefix every customerId already carries (see
 * NormalizedMessage.ts). Exists so the Conversation Engine can keep
 * depending on a single MessageSender, unmodified, now that more than one
 * platform is wired up -- adding a platform means registering one more
 * entry with composition.ts, not touching the engine or duplicating its
 * logic.
 */
export class PlatformRoutingMessageSender implements MessageSender {
  private readonly sendersByPlatform: Map<string, MessageSender>;

  constructor(sendersByPlatform: Record<string, MessageSender>) {
    this.sendersByPlatform = new Map(Object.entries(sendersByPlatform));
  }

  async sendTyping(customerId: string): Promise<void> {
    await this.resolve(customerId).sendTyping(customerId);
  }

  async sendReply(customerId: string, messages: string[]): Promise<void> {
    await this.resolve(customerId).sendReply(customerId, messages);
  }

  private resolve(customerId: string): MessageSender {
    const platform = customerId.split(":", 1)[0];
    const sender = this.sendersByPlatform.get(platform);
    if (!sender) {
      throw new Error(
        `"${customerId}" has no registered MessageSender for platform "${platform}" (registered: ${[
          ...this.sendersByPlatform.keys(),
        ].join(", ")}).`
      );
    }
    return sender;
  }
}
