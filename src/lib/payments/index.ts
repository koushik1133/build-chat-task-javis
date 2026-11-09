import type { PaymentProvider, PaymentProviderId } from "./types";
import { simulatedProvider } from "./simulated";
import { stripeProvider } from "./stripe";
import { razorpayProvider } from "./razorpay";

export type { PaymentProvider, PaymentProviderId, PaymentEvent, CreateCheckoutInput, RefundInput, RefundResult } from "./types";

const PROVIDERS: Record<PaymentProviderId, PaymentProvider> = {
  simulated: simulatedProvider,
  stripe: stripeProvider,
  razorpay: razorpayProvider,
};

export function isProviderId(v: unknown): v is PaymentProviderId {
  return v === "simulated" || v === "stripe" || v === "razorpay";
}

/** Active provider id from PAYMENTS_PROVIDER (default "simulated"). */
export function activeProviderId(): PaymentProviderId {
  const v = process.env.PAYMENTS_PROVIDER?.trim().toLowerCase();
  return isProviderId(v) ? v : "simulated";
}

/**
 * The simulated provider moves no money, so anyone holding a checkout token could mark
 * their own invoice paid. Outside production it is always allowed; in production it needs an
 * explicit opt-in (PAYMENTS_ALLOW_SIMULATED=true), e.g. for a staging deployment.
 */
export function simulatedPaymentsAllowed(env: Record<string, string | undefined> = process.env): boolean {
  if (env.NODE_ENV !== "production") return true;
  return (env.PAYMENTS_ALLOW_SIMULATED ?? "").trim().toLowerCase() === "true";
}

export function getProvider(id?: string | null): PaymentProvider {
  const pid = isProviderId(id) ? id : activeProviderId();
  return PROVIDERS[pid];
}

export function describeProviders(): Array<{ id: PaymentProviderId; configured: boolean; active: boolean }> {
  const active = activeProviderId();
  return (Object.keys(PROVIDERS) as PaymentProviderId[]).map((id) => ({
    id,
    configured: PROVIDERS[id].configured(),
    active: id === active,
  }));
}
