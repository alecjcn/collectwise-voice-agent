// Negotiation and verification policy for Atlas Recovery.
// These functions are the hard guardrails: tools call them, so the LLM cannot
// exceed the limits regardless of what the conversation says.

export const MAX_PLAN_MONTHS = 24;
export const MIN_SETTLEMENT_RATIO = 0.8;
export const MAX_VERIFICATION_ATTEMPTS = 3;

export interface InstallmentPlan {
  months: number;
  monthlyCents: number;
  finalCents: number;
  totalCents: number;
}

export function computeInstallmentPlan(balanceCents: number, months: number): InstallmentPlan {
  if (!Number.isInteger(balanceCents) || balanceCents <= 0) {
    throw new Error('Balance must be a positive integer number of cents.');
  }
  if (!Number.isInteger(months) || months < 1) {
    throw new Error('Plan length must be a whole number of months, at least 1.');
  }
  if (months > MAX_PLAN_MONTHS) {
    throw new Error(
      `Payment plans cannot exceed ${MAX_PLAN_MONTHS} months. Requested: ${months} months.`,
    );
  }
  const monthlyCents = Math.ceil(balanceCents / months);
  const finalCents = balanceCents - monthlyCents * (months - 1);
  return { months, monthlyCents, finalCents, totalCents: balanceCents };
}

export function minSettlementCents(balanceCents: number): number {
  return Math.ceil(balanceCents * MIN_SETTLEMENT_RATIO);
}

export interface SettlementValidation {
  acceptable: boolean;
  minCents: number;
  reason?: string;
}

export function validateSettlementOffer(
  balanceCents: number,
  offerCents: number,
): SettlementValidation {
  const minCents = minSettlementCents(balanceCents);
  if (!Number.isInteger(offerCents) || offerCents <= 0) {
    return { acceptable: false, minCents, reason: 'Offer must be a positive amount.' };
  }
  if (offerCents > balanceCents) {
    return {
      acceptable: false,
      minCents,
      reason: 'Offer exceeds the balance; use a payment in full instead of a settlement.',
    };
  }
  if (offerCents < minCents) {
    return { acceptable: false, minCents, reason: 'Offer is below the minimum settlement.' };
  }
  return { acceptable: true, minCents };
}

/** Reduce any spoken/stored account number format ("ATL 1003", "atl-1003") for comparison. */
export function normalizeAccountNumber(accountNumber: string): string {
  return accountNumber.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Reduce any spoken/stored phone format to its last 10 digits for comparison. */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '').slice(-10);
}

/** Mask a phone number for logs, keeping only the last 4 digits. */
export function maskPhone(phone: string): string {
  const total = phone.replace(/\D/g, '').length;
  let seen = 0;
  return phone.replace(/\d/g, (digit) => (++seen <= total - 4 ? '*' : digit));
}

export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
