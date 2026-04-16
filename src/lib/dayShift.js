/**
 * V-Cut day-opening / day-closing helpers.
 * Doc shape — stored in `day_openings/{branch_id}_{date}`:
 *   branch_id, date (YYYY-MM-DD)
 *   opening_cash, opened_by, opened_by_id, opened_at
 *   closing_cash_counted, closed_by, closed_by_id, closed_at
 *   summary: { bills_count, services_total, cash_total, online_total,
 *              tips_total, incentive_total, expense_total, expected_cash }
 */

export const shiftId = (branchId, date) => `${branchId}_${date}`;

/** Previous ISO date (YYYY-MM-DD). */
export function prevDate(dateStr) {
  const d = new Date(dateStr + "T00:00");
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Compute the day summary from in-memory settled invoices + staffRows + expenses. */
export function computeDaySummary({ settledInvoices = [], staffRows = {}, petrol = 0, otherExp = 0, openingCash = 0 }) {
  const bills_count = settledInvoices.length;
  const cash_total = settledInvoices.reduce((s, i) => s + (Number(i.cash) || 0), 0);
  const online_total = settledInvoices.reduce((s, i) => s + (Number(i.online) || 0), 0);
  const services_total = settledInvoices.reduce((s, i) => s + (Number(i.total) || Number(i.subtotal) || 0), 0);

  let tips_total = 0;
  let incentive_total = 0;
  let tips_in_cash = 0;
  let tips_paid_cash = 0;
  Object.values(staffRows).forEach(r => {
    const t = Number(r?.tips) || 0;
    tips_total += t;
    if ((r?.tip_in || "online") === "cash") tips_in_cash += t;
    if ((r?.tip_paid || "cash") === "cash") tips_paid_cash += t;
    incentive_total += (Number(r?.incentive) || 0) + (Number(r?.mat_incentive) || 0);
  });

  const expense_total = (Number(petrol) || 0) + (Number(otherExp) || 0);
  const expected_cash = (Number(openingCash) || 0)
    + cash_total + tips_in_cash - tips_paid_cash - incentive_total - expense_total;

  return {
    bills_count,
    services_total,
    cash_total,
    online_total,
    tips_total,
    tips_in_cash,
    tips_paid_cash,
    incentive_total,
    expense_total,
    expected_cash,
  };
}
