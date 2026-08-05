import type { InstagramTransport } from "../../src/adapters/instagram/InstagramTransport";

export type RecordedCall =
  | { method: "sendMessage"; recipientId: string; text: string }
  | { method: "sendSenderAction"; recipientId: string; action: "typing_on" | "typing_off" }
  | { method: "getProfile" }
  | { method: "getUserProfile"; igsid: string }
  | { method: "subscribeWebhookFields"; fields: string[] };

/**
 * A fake InstagramTransport that records every call instead of touching
 * the network. Mirrors FakeTelegramTransport.ts's purpose exactly: used
 * by any test that needs a working transport (InstagramMessageSender, the
 * webhook integration test) without caring about
 * HttpInstagramTransport's own HTTP/retry details -- those have their own
 * dedicated tests.
 */
export class FakeInstagramTransport implements InstagramTransport {
  readonly calls: RecordedCall[] = [];
  getProfileResult: { id: string; username: string | null } = { id: "17841400000000000", username: "nuteco_test" };
  getProfileError: Error | null = null;
  /** Keyed by igsid, so different tests/customers in the same test can get different results. Defaults to "no profile info available" for any igsid not explicitly configured. */
  userProfilesByIgsid: Record<string, { username: string | null; name: string | null }> = {};
  getUserProfileError: Error | null = null;

  async sendMessage(recipientId: string, text: string): Promise<void> {
    this.calls.push({ method: "sendMessage", recipientId, text });
  }

  async sendSenderAction(recipientId: string, action: "typing_on" | "typing_off"): Promise<void> {
    this.calls.push({ method: "sendSenderAction", recipientId, action });
  }

  async getProfile(): Promise<{ id: string; username: string | null }> {
    this.calls.push({ method: "getProfile" });
    if (this.getProfileError) {
      throw this.getProfileError;
    }
    return this.getProfileResult;
  }

  async getUserProfile(igsid: string): Promise<{ username: string | null; name: string | null }> {
    this.calls.push({ method: "getUserProfile", igsid });
    if (this.getUserProfileError) {
      throw this.getUserProfileError;
    }
    return this.userProfilesByIgsid[igsid] ?? { username: null, name: null };
  }

  async subscribeWebhookFields(fields: string[]): Promise<void> {
    this.calls.push({ method: "subscribeWebhookFields", fields });
  }
}
