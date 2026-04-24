/**
 * V-Cut Salon - Core calculation utilities
 * Ported 1:1 from legacy_index.html
 */

export const ROLES = ['Mens Hairdresser', 'Unisex Hairdresser', 'Beautician', 'Captain', 'Manager', 'Trainee'];
export const INR = (v) => { const n = Math.round(v || 0); return (n < 0 ? '-₹' : '₹') + Math.abs(n).toLocaleString('en-IN'); };
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MASK = '•••••';

// Parse a YYYY-MM-DD string as *local* midnight. `new Date("2026-04-22")` is
// UTC midnight, which in IST resolves to 05:30 on the same calendar date —
// when compared against a locally-constructed date (e.g. `new Date(y, m, d)`)
// this looks like "later" and breaks same-day join/exit comparisons (Ayan
// joined Apr 22 but salary computed as 0 because effectiveStart > effectiveEnd).
export const parseLocalDate = (ymd) => (ymd ? new Date(ymd + "T00:00") : null);

// Canonical Cash-in-Hand formula. Mirrors the Daily Entry form so the listing,
// the Excel export, P&L rollups, and the Recalculate job all agree.
// Formula: cash + tipsInCash − tipsPaidCash − incentivesTaken − others − petrol
// - `others` and `petrol` come out of the branch drawer on the day and are
//   subtracted here. (Legacy entries stored petrol separately; new ones keep
//   petrol at 0 and track it in `daily_expenses` instead, so this is a no-op
//   for new data.)
// - `incentivesTaken` only counts staff billing rows where `incentive_taken`
//   is not explicitly false. For unisex branches this defaults to hairdresser
//   roles only; for mens it defaults to everyone. Entries from before that
//   flag existed fall back to "taken".
// Pass in `branch` (optional) so the unisex-vs-mens default can be resolved;
// if you skip it, the default is "taken" which matches the form's default.
export function computeCashInHand(entry, { branch = null, staffList = [] } = {}) {
  if (!entry) return 0;
  const cash = Number(entry.cash) || 0;
  const sb = entry.staff_billing || [];
  const isUnisex = ((branch?.type) || "").toLowerCase() === "unisex";
  let tipsInCash = 0, tipsPaidCash = 0, takenInc = 0;
  for (const r of sb) {
    const tips = Number(r.tips) || 0;
    if ((r.tip_in || "online") === "cash") tipsInCash += tips;
    if ((r.tip_paid || "cash") === "cash") tipsPaidCash += tips;
    let taken;
    if (r.incentive_taken !== undefined) {
      taken = r.incentive_taken !== false;
    } else {
      const staffRec = staffList.find(x => x.id === r.staff_id);
      const role = (staffRec?.role || "").toLowerCase();
      taken = isUnisex ? (role.includes("hairdresser") || role.includes("hair dresser")) : true;
    }
    if (taken) takenInc += (Number(r.incentive) || 0) + (Number(r.mat_incentive) || 0);
  }
  const others = Number(entry.others) || 0;
  const petrol = Number(entry.petrol) || 0;
  return cash + tipsInCash - tipsPaidCash - takenInc - others - petrol;
}

// Physically-present cash-in-hand. Prefers the counted `actual_cash` when the
// accountant recorded it on reconciliation, otherwise falls back to the
// theoretical expected `cash_in_hand`. Use this for anything that models real
// money (collections, outstanding, cashflow), not theoretical totals.
export function effectiveCashInHand(entry) {
  if (!entry) return 0;
  if (entry.actual_cash !== null && entry.actual_cash !== undefined && entry.actual_cash !== "") {
    return Number(entry.actual_cash) || 0;
  }
  return Number(entry.cash_in_hand) || 0;
}

/** Get staff salary for a given month from salary_history or fallback to base */
export function getStaffSalaryForMonth(staffId, monthStr, salaryHistory, staffList) {
  const s = staffList?.find(x => x.id === staffId);
  if (!s) return 0;
  if (!salaryHistory || salaryHistory.length === 0) return s.salary || 0;

  // Find the most recent history entry effective ON or BEFORE monthStr
  const relevant = salaryHistory
    .filter(h => h.staff_id === staffId && h.effective_from && h.effective_from <= (monthStr + '-31'))
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from));

  if (relevant.length > 0) return relevant[0].salary || s.salary || 0;
  return s.salary || 0;
}

/** Pro-rata salary for a staff member in a given month
 *  Leaves: pass an array of leaves docs ({staff_id, date, days, type, status}) to deduct unpaid leaves.
 *  - Paid allowance is pro-rated based on the active portion of the month.
 *  - Each approved leave consumes the paid allowance first; the remainder is unpaid and reduces salary.
 */
// Pro-rata salary policy:
//   • No week-offs — every calendar day in the month is a potential pay day.
//   • Denominator is always daysInMonth (so per-day rate = salary / daysInMonth).
//   • Paid-leave quota scales with the active window, ceil'd in the employee's favour
//     (e.g. 3 leaves / month × 5 active days / 30 = 0.5 → 1 day allowance).
//   • Approved leaves beyond that ceil'd quota are LOP and deduct whole days of pay.
//   • For the *current* month the window is capped to yesterday, so the number reflects
//     what's actually been earned so far — today's shift hasn't happened yet.
export function proRataSalary(st, monthStr, branches, salaryHistory, staffList, globalSettings = {}, leaves = []) {
  const salary = getStaffSalaryForMonth(st.id, monthStr, salaryHistory, staffList);
  if (!salary) return 0;

  const [yr, mo] = monthStr.split('-').map(Number);
  const daysInMonth = new Date(yr, mo, 0).getDate();

  const branch = branches?.find(b => b.id === st.branch_id);
  let quotaPerMonth = branch && branch.type === 'unisex' ? 3 : 2;
  if (globalSettings) {
    if (branch?.type === 'mens' && globalSettings.mens_leaves !== undefined) quotaPerMonth = globalSettings.mens_leaves;
    if (branch?.type === 'unisex' && globalSettings.unisex_leaves !== undefined) quotaPerMonth = globalSettings.unisex_leaves;
  }

  const monthStart = new Date(yr, mo - 1, 1);
  const monthEnd = new Date(yr, mo, 0);
  const joinDate = parseLocalDate(st.join);
  const exitDate = parseLocalDate(st.exit_date);

  // For the current month, cap the effective end to yesterday.
  const now = new Date();
  const isCurrentMonth = now.getFullYear() === yr && now.getMonth() + 1 === mo;
  let capEnd = monthEnd;
  if (isCurrentMonth) {
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (y < monthStart) return 0;
    if (y < monthEnd) capEnd = y;
  }

  const effectiveStart = (joinDate && joinDate > monthStart) ? joinDate : monthStart;
  const effectiveEnd = (exitDate && exitDate < capEnd) ? exitDate : capEnd;
  if (effectiveStart > effectiveEnd) return 0;

  const calDays = Math.round((effectiveEnd - effectiveStart) / 86400000) + 1;
  // Pro-rata allowance ceil'd so fractional entitlement never costs the employee a day.
  const proPaidLeave = Math.ceil(quotaPerMonth * calDays / daysInMonth);

  const approvedLeaves = (leaves || []).filter(l =>
    l.staff_id === st.id && l.status === 'approved' && l.date && l.date.startsWith(monthStr)
  );
  const totalLeaveDays = approvedLeaves.reduce((s, l) => s + (Number(l.days) || 1), 0);
  const unpaidLeaveDays = Math.max(0, totalLeaveDays - proPaidLeave);

  const payableDays = Math.max(0, calDays - unpaidLeaveDays);
  return Math.round((salary / daysInMonth) * payableDays);
}

/** Staff overall status — active/inactive relative to a given month */
export function staffOverallStatus(st, forMonth) {
  if (!st.exit_date) return 'active';
  const exit = parseLocalDate(st.exit_date);
  if (forMonth) {
    const [yr, mo] = forMonth.split('-').map(Number);
    return exit < new Date(yr, mo - 1, 1) ? 'inactive' : 'active';
  }
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  return exit < todayStart ? 'inactive' : 'active';
}

/** Staff status detail for a specific month (active/partial/inactive + days worked) */
// Opts:
//   capToYesterday — for the CURRENT month, clamp the end to (today - 1).
//     Reason: today's entries haven't been captured yet, so showing full-month
//     working days is misleading in attendance / "Partial: N working days" UI.
//     Payroll and targets keep the full-month view, so this is opt-in.
export function staffStatusForMonth(st, monthStr, opts = {}) {
  const { capToYesterday = false } = opts;
  const [yr, mo] = monthStr.split('-').map(Number);
  const daysInMonth = new Date(yr, mo, 0).getDate();
  const monthStart = new Date(yr, mo - 1, 1);
  let monthEnd = new Date(yr, mo, 0);
  let fullMonth = true;

  if (capToYesterday) {
    const now = new Date();
    const isCurrentMonth = now.getFullYear() === yr && now.getMonth() + 1 === mo;
    if (isCurrentMonth) {
      const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      if (y < monthStart) return { status: 'active', daysWorked: 0, calDays: 0, toDate: true };
      if (y < monthEnd) { monthEnd = y; fullMonth = false; }
    }
  }

  const joinDate = parseLocalDate(st.join);
  const exitDate = parseLocalDate(st.exit_date);

  if (joinDate && joinDate > monthEnd) return { status: 'inactive', daysWorked: 0 };
  if (exitDate && exitDate < monthStart) return { status: 'inactive', daysWorked: 0 };

  if ((!joinDate || joinDate <= monthStart) && (!exitDate || exitDate >= monthEnd) && fullMonth) {
    return { status: 'active', daysWorked: daysInMonth };
  }

  const effStart = (joinDate && joinDate > monthStart) ? joinDate : monthStart;
  const effEnd = (exitDate && exitDate < monthEnd) ? exitDate : monthEnd;
  const calDays = Math.round((effEnd - effStart) / 86400000) + 1;
  // No week-off concept — every calendar day in the active window counts.
  const worked = Math.max(0, calDays);
  const spansFullWindow = (!joinDate || joinDate <= monthStart) && (!exitDate || exitDate >= monthEnd);
  return {
    status: spansFullWindow && !fullMonth ? 'active' : 'partial',
    daysWorked: worked,
    calDays,
    toDate: !fullMonth,
    joinedOn: st.join,
    exitedOn: st.exit_date,
  };
}

/** Count approved leaves for a staff member in a given month string (YYYY-MM) */
export function staffLeavesInMonth(sid, monthStr, leaves) {
  return (leaves || []).filter(l =>
    l.staff_id === sid && l.status === 'approved' && l.date && l.date.startsWith(monthStr)
  ).reduce((s, l) => s + (l.days || 1), 0);
}

/** Staff billing achieved in a given period */
export function staffBillingInPeriod(sid, entries, filterPrefix, filterMode, filterYear) {
  const filtered = entries.filter(e => {
    if (!e.date) return false;
    if (filterMode === 'month') return e.date.startsWith(filterPrefix);
    return e.date.startsWith(String(filterYear));
  });
  let billing = 0;
  filtered.forEach(e => {
    const sb = (e.staff_billing || []).find(x => x.staff_id === sid);
    if (sb) billing += (sb.billing || 0);
  });
  return billing;
}

/** Last month billing & incentive for a staff member */
export function lastMonthData(sid, entries) {
  const now = new Date();
  const lmYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const lmMonth = now.getMonth() === 0 ? 12 : now.getMonth();
  const prefix = lmYear + '-' + String(lmMonth).padStart(2, '0');
  const lmEntries = entries.filter(e => e.date && e.date.startsWith(prefix));
  let billing = 0, incentive = 0;
  lmEntries.forEach(e => {
    const sb = (e.staff_billing || []).find(x => x.staff_id === sid);
    if (sb) { billing += (sb.billing || 0); incentive += (sb.incentive || 0); }
  });
  return { billing, incentive, achieved: billing };
}

/** Total branch income for a given period */
export function branchIncomeInPeriod(bid, entries, filterPrefix, filterMode, filterYear) {
  return entries.filter(e => {
    if (!e.date || e.branch_id !== bid) return false;
    if (filterMode === 'month') return e.date.startsWith(filterPrefix);
    return e.date.startsWith(String(filterYear));
  }).reduce((s, e) => {
    const inc = e.income || {};
    return s + (inc.cash || 0) + (inc.upi || 0) + (inc.card || 0);
  }, 0);
}

/** Filter prefix helper */
export function makeFilterPrefix(filterYear, filterMonth) {
  return filterYear + '-' + String(filterMonth).padStart(2, '0');
}

/** Period label */
export function periodLabel(filterMode, filterYear, filterMonth) {
  if (filterMode === 'month') {
    return new Date(filterYear, filterMonth - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  }
  return String(filterYear);
}

/** Resolve a staff member's effective branch on a given date, honoring active transfers */
export function effectiveBranchOnDate(st, dateStr, transfers = []) {
  if (!st) return null;
  const t = (transfers || []).find(x =>
    x.staff_id === st.id && x.status === 'active' &&
    (!x.start_date || x.start_date <= dateStr) &&
    (!x.end_date || x.end_date >= dateStr)
  );
  return t ? t.to_branch_id : (st.branch_id || null);
}

/** Get all staff members whose effective branch on the given date is `branchId` */
export function staffAtBranchOnDate(branchId, dateStr, staffList = [], transfers = []) {
  return (staffList || []).filter(s => effectiveBranchOnDate(s, dateStr, transfers) === branchId);
}

/** Get approved advances for a staff member in a given month */
export function staffAdvancesInMonth(sid, monthStr, advances = []) {
  return advances
    .filter(a => a.staff_id === sid && a.status === 'approved' && (a.month_str === monthStr || (a.date && a.date.startsWith(monthStr))))
    .reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
}

/** Get total incentives earned by a staff member in a given period */
export function staffIncentivesInPeriod(sid, entries, filterPrefix, filterMode, filterYear) {
  const filtered = entries.filter(e => {
    if (!e.date) return false;
    if (filterMode === 'month') return e.date.startsWith(filterPrefix);
    return e.date.startsWith(String(filterYear));
  });
  let incTotal = 0;
  filtered.forEach(e => {
    const sb = (e.staff_billing || []).find(x => x.staff_id === sid);
    if (sb) incTotal += ((sb.incentive || 0) + (sb.mat_incentive || 0));
  });
  return incTotal;
}
