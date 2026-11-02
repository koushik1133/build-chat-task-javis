/** Thrown by metering when credits are enforced and the balance is exhausted. Client-safe. */
export class InsufficientCreditsError extends Error {
  readonly code = "INSUFFICIENT_CREDITS";
  constructor(public readonly balance: number) {
    super(
      balance < 0
        ? `AI credits exhausted (balance ${balance} credits). Buy a credit pack in Settings → AI to continue.`
        : "AI credits exhausted. Buy a credit pack in Settings → AI to continue."
    );
    this.name = "InsufficientCreditsError";
  }
}

export function isInsufficientCreditsError(err: unknown): err is InsufficientCreditsError {
  return err instanceof InsufficientCreditsError || (err instanceof Error && err.name === "InsufficientCreditsError");
}
