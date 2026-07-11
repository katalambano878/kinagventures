/**
 * Shared helpers for the split-payment ("50% deposit, 50% on delivery/pickup")
 * checkout flow.
 *
 * The customer can opt to pay only a deposit through Moolre and settle the
 * balance in cash / mobile money when the order is delivered or picked up (or
 * online later via the /complete-payment page). We keep all the math here so the
 * checkout UI, the Moolre initiate / callback / verify routes, and the admin
 * pages all agree.
 */

/**
 * Plans:
 *  - 'full':       customer pays the whole order at checkout.
 *  - 'deposit_50': fixed 50% online deposit + 50% balance on delivery/pickup.
 *  - 'partial':    arbitrary partial payment. The actual amount paid lives in
 *                  metadata.deposit_amount. Reserved for future POS/manual use.
 */
export type PaymentPlan = 'full' | 'deposit_50' | 'partial';

export const DEPOSIT_RATIO = 0.5;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * True for any plan where the customer leaves owing the store money.
 * Use this in branch points that don't care *how* the partial was computed,
 * only that the order should be marked `partially_paid` instead of `paid`.
 */
export function isPartialPlan(plan: PaymentPlan): boolean {
  return plan !== 'full';
}

/**
 * Compute the amount a customer pays online for a given plan + order total.
 * `deposit_50` is a fixed 50%; `partial` requires the caller to pass an
 * explicit amount. For unknown / missing partial amounts we fall back to the
 * full total (safer than under-billing).
 */
export function computeDeposit(
  total: number,
  plan: PaymentPlan,
  explicitAmount?: number | null,
): {
  depositAmount: number;
  balanceDue: number;
  upfrontAmount: number;
} {
  const safeTotal = Math.max(0, Number(total) || 0);
  if (plan === 'deposit_50') {
    const depositAmount = round2(safeTotal * DEPOSIT_RATIO);
    const balanceDue = round2(safeTotal - depositAmount);
    return { depositAmount, balanceDue, upfrontAmount: depositAmount };
  }
  if (plan === 'partial') {
    const raw = Number(explicitAmount);
    if (Number.isFinite(raw) && raw > 0 && raw < safeTotal) {
      const depositAmount = round2(raw);
      const balanceDue = round2(safeTotal - depositAmount);
      return { depositAmount, balanceDue, upfrontAmount: depositAmount };
    }
    return { depositAmount: safeTotal, balanceDue: 0, upfrontAmount: safeTotal };
  }
  return { depositAmount: safeTotal, balanceDue: 0, upfrontAmount: safeTotal };
}

/**
 * Normalise an arbitrary plan string from an API caller into a known plan
 * value. Anything we don't recognise falls back to 'full' so we never
 * accidentally underbill.
 */
export function normalizePaymentPlan(raw: unknown): PaymentPlan {
  if (raw === 'deposit_50') return 'deposit_50';
  if (raw === 'partial') return 'partial';
  return 'full';
}

/**
 * Pull plan + deposit / balance info from an order row. Reads either the
 * top-level metadata fields we persisted at checkout or computes a fallback
 * from the order total so the caller never has to special-case missing data.
 */
export function readPaymentPlan(order: any): {
  plan: PaymentPlan;
  depositAmount: number;
  balanceDue: number;
} {
  const meta = (order && (order.metadata || order.meta)) || {};
  const plan = normalizePaymentPlan(meta.payment_plan);
  const total = Number(order?.total) || 0;

  if (isPartialPlan(plan)) {
    const depositAmount = Number(meta.deposit_amount);
    const balanceDue = Number(meta.balance_due);
    if (Number.isFinite(depositAmount) && Number.isFinite(balanceDue)) {
      return { plan, depositAmount, balanceDue };
    }
    const computed = computeDeposit(total, plan, meta.deposit_amount);
    return { plan, depositAmount: computed.depositAmount, balanceDue: computed.balanceDue };
  }

  return { plan: 'full', depositAmount: total, balanceDue: 0 };
}

export const PAYMENT_PLAN_LABELS: Record<PaymentPlan, string> = {
  full: 'Pay in full',
  deposit_50: 'Pay 50% deposit',
  partial: 'Partial payment',
};
