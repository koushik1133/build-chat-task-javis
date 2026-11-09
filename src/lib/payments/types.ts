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

export interface CreateCustomerInput {
  contactId: string;
  email: string | null;
  name: string;
}
export interface AttachPaymentMethodInput {
  customerRef: string;
  /** Simulated provider only: which kind of test card to put on file. */
  simulate?: "ok" | "decline";
  /** Real providers: id of the completed setup session. */
  setupRef?: string;
}
export interface SetupCheckoutInput {
  customerRef: string;
  successUrl: string;
  cancelUrl: string;
}
export interface ChargeSavedInput {
  paymentRef: string;
  amountMinor: number;
  currency: string;
  invoiceId: string;
  description: string;
  /** Stable per (subscription, period, attempt) so a retried call never double-charges. */
  idempotencyKey: string;
}
export interface ChargeSavedResult {
  status: "succeeded" | "failed";
  providerRef: string;
  error?: string | null;
}

export interface PaymentProvider {
  id: PaymentProviderId;
  /** True when the env vars this provider needs are present. */
  configured(): boolean;
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;
  verifyWebhook(rawBody: string, headers: Headers): Promise<VerifyWebhookResult>;
  /** Return money to the payer. Throws when the provider cannot refund (not configured / unsupported). */
  refund(input: RefundInput): Promise<RefundResult>;
  /** Create the provider-side customer that saved payment methods hang off. Throws "not configured" on stubs. */
  createCustomer(input: CreateCustomerInput): Promise<{ customerRef: string }>;
  /** Hosted page where the customer enters a payment method to keep on file. */
  createSetupCheckout(input: SetupCheckoutInput): Promise<{ url: string; setupRef: string }>;
  /** Store a payment method on the customer; returns the reference `chargeSaved` charges later. */
  attachPaymentMethod(input: AttachPaymentMethodInput): Promise<{ paymentRef: string }>;
  /** Off-session charge against a saved method. A decline is a `failed` result, not an exception. */
  chargeSaved(input: ChargeSavedInput): Promise<ChargeSavedResult>;
}
