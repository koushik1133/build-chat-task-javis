/**
 * Payment provider abstraction.
 *
 * Money is always a minor-unit integer (cents, paise) plus an ISO 4217
 * currency code. Providers translate that into their own API shape.
 */

export type PaymentProviderId = "simulated" | "stripe" | "razorpay";

export interface CreateCheckoutInput {
  invoiceId: string;
  amountMinor: number;
  currency: string;
  description: string;
  successUrl: string;
  cancelUrl: string;
  /** Our own pay share-token; providers pass it through as metadata/reference. */
  token: string;
}

export interface CreateCheckoutResult {
  url: string;
  providerRef: string;
}

export type PaymentEventType = "payment.succeeded" | "payment.failed";

export interface PaymentEvent {
  type: PaymentEventType;
  /** Provider-side unique id for this event (used for idempotency). */
  eventId: string;
  /** Reference that ties the event back to our invoice (checkout/order id). */
  providerRef: string;
  /** Our invoice id when the provider echoes metadata back; otherwise null. */
  invoiceId: string | null;
  amountMinor: number;
  currency: string;
  raw: unknown;
}

export interface VerifyWebhookResult {
  ok: boolean;
  /** Undefined when the payload verified but is not a payment event we act on. */
  event?: PaymentEvent;
  error?: string;
}

export interface RefundInput {
  /** Provider reference of the original payment (checkout/order/payment id). */
  providerRef: string;
  amountMinor: number;
  currency: string;
  invoiceId: string;
  reason?: string | null;
}

export interface RefundResult {
  /** Provider-side refund id (or a synthetic one for the simulated provider). */
  refundRef: string;
  status: "succeeded" | "pending";
}

export interface PaymentProvider {
  id: PaymentProviderId;
  /** True when the env vars this provider needs are present. */
  configured(): boolean;
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;
  verifyWebhook(rawBody: string, headers: Headers): Promise<VerifyWebhookResult>;
  /** Return money to the payer. Throws when the provider cannot refund (not configured / unsupported). */
  refund(input: RefundInput): Promise<RefundResult>;
}
