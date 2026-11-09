/** Invoices and quotes may carry negative discount lines but the document total can never go below zero. */
export function assertNonNegativeTotal(t: { total_minor: number; subtotal_minor: number }): void {
  if (t.total_minor < 0 || t.subtotal_minor < 0) throw new Error("Discounts cannot make the document total negative");
}
