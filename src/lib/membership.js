/**
 * V-Cut membership helpers. Tiers, validity checks, discount math.
 * Customer doc shape:
 *   is_member: bool
 *   member_tier: "1m" | "3m" | "6m" | "9m" | "1y"
 *   member_from: "YYYY-MM-DD"
 *   member_to:   "YYYY-MM-DD"
 *   member_history: [{ tier, from, to, invoice_id }]
 */

export const MEMBERSHIP_TIERS = [
  { key: "1m", label: "1 Month",  days: 30,  price: 999 },
  { key: "3m", label: "3 Months", days: 90,  price: 2499 },
  { key: "6m", label: "6 Months", days: 180, price: 4499 },
  { key: "9m", label: "9 Months", days: 270, price: 5999 },
  { key: "1y", label: "1 Year",   days: 365, price: 7499 },
];

export const DEFAULT_MEMBER_DISCOUNT_PCT = 5;
export const MAX_EXTRA_DISCOUNT_PCT = 5; // on top of default before requiring approval

export function tierByKey(key) {
  return MEMBERSHIP_TIERS.find(t => t.key === key) || null;
}

export function isActiveMember(customer, asOfDate = null) {
  if (!customer?.is_member || !customer.member_to) return false;
  const today = asOfDate || new Date().toISOString().slice(0, 10);
  return customer.member_to >= today;
}

export function daysUntilExpiry(customer, asOfDate = null) {
  if (!customer?.member_to) return 0;
  const today = asOfDate ? new Date(asOfDate) : new Date();
  const exp = new Date(customer.member_to + "T00:00");
  return Math.floor((exp - today) / (1000 * 60 * 60 * 24));
}

/** Compute member_to given a starting date (YYYY-MM-DD) and tier key. */
export function computeMemberToDate(fromDateStr, tierKey) {
  const tier = tierByKey(tierKey);
  if (!tier) return null;
  const d = new Date(fromDateStr + "T00:00");
  d.setDate(d.getDate() + tier.days);
  return d.toISOString().slice(0, 10);
}

/** Total-cap logic: returns { rate, needsApproval } given requested pct and defaults. */
export function resolveDiscountRate(requestedPct, defaultPct = DEFAULT_MEMBER_DISCOUNT_PCT, maxExtra = MAX_EXTRA_DISCOUNT_PCT) {
  const req = Number(requestedPct) || 0;
  const ceiling = defaultPct + maxExtra;
  if (req <= ceiling) return { rate: Math.max(0, req), needsApproval: false };
  return { rate: ceiling, needsApproval: true };
}
