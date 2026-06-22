/**
 * V-Cut Salon - Core calculation utilities
 * Ported 1:1 from legacy_index.html
 */

export const ROLES = ['Mens Hairdresser', 'Unisex Hairdresser', 'Beautician', 'Captain', 'Manager', 'Trainee'];
export const INR = (v) => { const n = Math.round(v || 0); return (n < 0 ? '-₹' : '₹') + Math.abs(n).toLocaleString('en-IN'); };
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MASK = '•••••';

// Display a name in Title Case, splitting on spaces / underscores / hyphens.
// Handles legacy DB rows like "SHEETAL", "NADeem", "SAJID_HSR" → "Sheetal",
// "Nadeem", "Sajid Hsr" so leaderboards and lists read consistently.
export const toTitleCase = (s) => (s || "")
  .toString()
  .toLowerCase()
  .replace(/[_-]+/g, " ")
  .replace(/(?:^|\s)\S/g, c => c.toUpperCase());

// Parse a YYYY-MM-DD string as *local* midnight. `new Date("2026-04-22")` is
// UTC midnight, which in IST resolves to 05:30 on the same calendar date —
// when compared against a locally-constructed date (e.g. `new Date(y, m, d)`)
// this looks like "later" and breaks same-day join/exit comparisons (Ayan
// joined Apr 22 but salary computed as 0 because effectiveStart > effectiveEnd).
export const parseLocalDate = (ymd) => (ymd ? new Date(ymd + "T00:00") : null);

// Incentive expense = raw 5% × billing + 5% × material across each staff
// row, plus the ceil-to-10 rounding bump that was actually paid out at
// release time (release.amount_released - release.total_incentive).
//
// **Why:** Entries store `staff_billing[].incentive` ceil-10 per-day, which
// inflates the period sum vs the real 5% (e.g. ₹1,810 vs ₹1,703 for 15 days).
// User wants the expense to read the actual earned (raw) until payout, then
// add only the rounding surplus that was actually paid. This formula gives:
//   • before payout: expense = raw (₹1,703)
//   • after payout:  expense = raw + bump = amount_released (₹1,710)
//
// **How to apply:** Filter entries + releases to the period/branch you care
// about, then call this. Pre-filtering keeps the helper period-agnostic.
export function computeIncentiveExpense(entries = [], staffById, releases = [], branchesById, globalSettings) {
  const MAT_PCT = 0.05;
  // Mirrors `staffIncRate` in entry/page.js: prefer per-staff override, then
  // global mens/unisex rate keyed off the branch type, then 10% default.
  // Without this fallback, staff records that never set incentive_pct drop
  // to 0% silently — which made expense plunge and the network P&L spike.
  const rateFor = (sb, entry) => {
    const s = staffById && (staffById.get ? staffById.get(sb.staff_id) : null);
    if (s?.incentive_pct !== undefined && s?.incentive_pct !== null && s.incentive_pct !== "") {
      return Number(s.incentive_pct) || 0;
    }
    const b = branchesById && (branchesById.get ? branchesById.get(entry.branch_id) : null);
    if (b && globalSettings) {
      return b.type === "unisex"
        ? Number(globalSettings.unisex_inc ?? 10) || 10
        : Number(globalSettings.mens_inc ?? 10) || 10;
    }
    return 10;
  };
  let raw = 0;
  entries.forEach(e => {
    (e.staff_billing || []).forEach(sb => {
      const incPct = rateFor(sb, e) / 100;
      raw += (Number(sb.billing) || 0) * incPct;
      raw += (Number(sb.material) || 0) * MAT_PCT;
    });
  });
  let bump = 0;
  releases.forEach(r => {
    const diff = (Number(r.amount_released) || 0) - (Number(r.total_incentive) || 0);
    if (diff > 0) bump += diff;
  });
  return raw + bump;
}

// Fixed-cost resolver — returns per-month fixed-cost figures for a branch.
// Override priority per field, highest wins:
//   1. `fixedExpenses` row from the Operational Expenses page (typed by name)
//   2. `monthlyExpenses` row from Master Setup → Fixed Exp tab (named field)
//   3. branch master default
// Missing fields fall back so a partial override (just shop_rent bumped up
// for one month) still uses defaults for everything else.
// Shape: { shop_rent, room_rent, shop_elec, room_elec, wifi, water, petrol, maid, dust }
// Shared by the Dashboard, P&L page, and branch-detail view so a bump
// entered on either expenses surface is honoured everywhere.
const FIXED_TYPE_TO_FIELD = {
  "Shop Rent": "shop_rent",
  "Room Rent": "room_rent",
  "Electricity Shop": "shop_elec",
  "Electricity Room": "room_elec",
  "WiFi Bill": "wifi",
  "Water Bill": "water",
};
export function getMonthlyFixed(branch, monthStr, monthlyExpenses = [], fixedExpenses = []) {
  const b = branch || {};
  const rec = (monthlyExpenses || []).find(m => m.branch_id === b.id && m.month === monthStr);
  // Build a per-field override map from `fixed_expenses` rows that match this
  // branch + month. Sums duplicate type rows so two entries for the same type
  // in one month accumulate instead of clobbering.
  const fxByField = {};
  (fixedExpenses || []).forEach(fx => {
    if (!fx || fx.branch_id !== b.id) return;
    if (!fx.date || fx.date.slice(0, 7) !== monthStr) return;
    const field = FIXED_TYPE_TO_FIELD[fx.type];
    if (!field) return;
    fxByField[field] = (fxByField[field] || 0) + (Number(fx.amount) || 0);
  });
  const fv = (field, branchVal) => {
    if (fxByField[field] !== undefined) return fxByField[field];
    const recVal = rec?.[field];
    if (recVal !== undefined && recVal !== null) return Number(recVal) || 0;
    return Number(branchVal) || 0;
  };
  return {
    shop_rent: fv("shop_rent", b.shop_rent),
    room_rent: fv("room_rent", b.room_rent),
    shop_elec: fv("shop_elec", b.shop_elec),
    room_elec: fv("room_elec", b.room_elec),
    wifi:      fv("wifi",      b.wifi),
    water:     fv("water",     b.water),
    petrol:    fv("petrol",    b.petrol),
    maid:      fv("maid",      b.maid),
    dust:      fv("dust",      b.dust),
  };
}

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

/** Get staff salary for a given month from salary_history or fallback to base.
 *
 * **Why the live-value override:** `s.salary` is the current contracted figure
 * (what Staff Management shows). `salary_history` is meant to hold superseded
 * values keyed by when they took effect. If a salary edit didn't get logged to
 * history — or a history row carries a stale amount — the most-recent applicable
 * row can disagree with `s.salary`, making the current month read an old number
 * while Staff Management reads the new one. So when the newest history row's
 * amount differs from `s.salary`, we treat `s.salary` as effective from the
 * current month onward: the current/future months use the live value, genuinely
 * past months keep their historical value. */
export function getStaffSalaryForMonth(staffId, monthStr, salaryHistory, staffList) {
  const s = staffList?.find(x => x.id === staffId);
  if (!s) return 0;
  const current = Number(s.salary) || 0;
  if (!salaryHistory || salaryHistory.length === 0) return current;

  const hist = salaryHistory
    .filter(h => h.staff_id === staffId && h.effective_from)
    .sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)));
  if (hist.length === 0) return current;

  // The newest logged amount disagrees with the live salary → the live value is
  // a later (unlogged) change; apply it from the current month onward.
  const newest = hist[0];
  if (Number(newest.salary) !== current) {
    const now = new Date();
    const nowMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (monthStr >= nowMonth) return current;
  }

  // Otherwise: most recent history entry effective ON or BEFORE monthStr.
  const applicable = hist.find(h => h.effective_from <= (monthStr + '-31'));
  if (applicable) return Number(applicable.salary) || current;
  return current;
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
// Attendance gate (opt-in via `entries`):
//   When the caller passes the entries array, a staff with NO presence on any day
//   of the month AND no approved leave that month earns ₹0 — they simply didn't
//   work, even if join/exit dates say they were "employed". Presence = appearing
//   in a day's staff_billing with present !== false. Pass `null`/omit to disable
//   gating (legacy behaviour: pay purely on join/exit window).
export function staffPresentDaysInMonth(stId, monthStr, entries) {
  if (!entries) return null;
  let n = 0;
  for (const e of entries) {
    if (!e.date || !e.date.startsWith(monthStr)) continue;
    if ((e.staff_billing || []).some(x => x.staff_id === stId && x.present !== false)) n += 1;
  }
  return n;
}

export function proRataSalary(st, monthStr, branches, salaryHistory, staffList, globalSettings = {}, leaves = [], entries = null) {
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

  const approvedLeaves = (leaves || []).filter(l =>
    l.staff_id === st.id && l.status === 'approved' && l.date && l.date.startsWith(monthStr)
  );
  const totalLeaveDays = approvedLeaves.reduce((s, l) => s + (Number(l.days) || 1), 0);

  // Attendance-based pay (preferred — caller supplies `entries`):
  //   payable = days actually present (in a day's staff_billing, present !== false)
  //           + paid-leave days (approved leaves capped at the monthly quota).
  //   per-day rate = salary / daysInMonth. A staff who never showed up and filed
  //   no leave earns ₹0, regardless of join/exit. Naturally "as of now" since only
  //   logged days exist — no need to cap to yesterday.
  if (entries) {
    const presentDays = staffPresentDaysInMonth(st.id, monthStr, entries) || 0;
    const paidLeaveDays = Math.min(totalLeaveDays, quotaPerMonth);
    const payableDays = presentDays + paidLeaveDays;
    if (payableDays <= 0) return 0;
    return Math.round((salary / daysInMonth) * payableDays);
  }

  // Legacy path (no entries supplied): pay across the join/exit calendar window.
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
  const unpaidLeaveDays = Math.max(0, totalLeaveDays - proPaidLeave);

  const payableDays = Math.max(0, calDays - unpaidLeaveDays);
  return Math.round((salary / daysInMonth) * payableDays);
}

// Distinct days a staff member was PRESENT at each branch in a month. Aligned
// with [[staffPresentDaysInMonth]]'s gate: a `staff_billing` row with
// `present !== false`. Borrowed/loan shifts land in the HOST branch's entry
// (sale attribution → host), so `entry.branch_id` is the real "worked here"
// branch. Returns Map<branchId, dayCount>. Pass the FULL entries array.
export function presentDaysByBranch(sid, monthStr, entries = []) {
  const sets = new Map();
  for (const e of entries) {
    if (!e || !e.date || !e.branch_id || !e.date.startsWith(monthStr)) continue;
    if (!(e.staff_billing || []).some(x => x.staff_id === sid && x.present !== false)) continue;
    let s = sets.get(e.branch_id);
    if (!s) { s = new Set(); sets.set(e.branch_id, s); }
    s.add(e.date);
  }
  const out = new Map();
  sets.forEach((s, bid) => out.set(bid, s.size));
  return out;
}

// Fraction of a staff member's month salary attributable to `branchId`, by days
// present there ÷ total present days that month. No presence anywhere → home
// branch carries the whole thing (1.0). Lets per-branch projections apply the
// same split as [[salaryByBranchForMonth]] without the realized map.
export function branchSalaryShare(sid, monthStr, branchId, entries = [], homeBranchId = null) {
  const days = presentDaysByBranch(sid, monthStr, entries);
  let total = 0;
  days.forEach(n => total += n);
  if (total === 0) return homeBranchId === branchId ? 1 : 0;
  return (days.get(branchId) || 0) / total;
}

// Allocate every staff member's attendance-gated month salary across branches by
// days actually present at each ([[presentDaysByBranch]]). The full amount comes
// from proRataSalary WITH entries, so it already reflects attendance (a no-show,
// no-leave month is ₹0). That total is then split by where the presence
// happened, so a staff borrowed 6 of 20 days to another branch carries 6/20 of
// the month's salary there. A pure paid-leave month (no presence anywhere) falls
// back to the home branch so salary is never dropped from branch P&L. Rounding
// drift lands on the largest share so per-branch parts re-sum to the full
// salary. Returns Map<branchId, salary>.
//
// **Why:** salary EXPENSE must follow where work physically happened, not the
// home/transfer branch. The EMPLOYEE payslip stays full (my-payroll keeps
// calling proRataSalary directly) — this only splits the COST across branch P&L.
//
// **How to apply:** call once per month with the full entries array, then read
// `.get(branchId) || 0` wherever a per-branch salary expense was previously
// `staff.filter(home===branch).reduce(proRataSalary)`. Network totals don't need
// it — sum-of-shares === full salary, so they're invariant.
export function salaryByBranchForMonth(monthStr, entries, branches, salaryHistory, staffList, globalSettings = {}, leaves = []) {
  const out = new Map();
  (staffList || []).forEach(st => {
    const full = proRataSalary(st, monthStr, branches, salaryHistory, staffList, globalSettings, leaves, entries);
    if (!full) return;
    const days = presentDaysByBranch(st.id, monthStr, entries);
    let total = 0;
    days.forEach(n => total += n);
    if (total === 0) {
      out.set(st.branch_id, (out.get(st.branch_id) || 0) + full);
      return;
    }
    const parts = [];
    let allocated = 0;
    days.forEach((n, bid) => {
      const amt = Math.round(full * n / total);
      parts.push([bid, amt]);
      allocated += amt;
    });
    const drift = full - allocated;
    if (drift !== 0) { parts.sort((a, b) => b[1] - a[1]); parts[0][1] += drift; }
    parts.forEach(([bid, amt]) => out.set(bid, (out.get(bid) || 0) + amt));
  });
  return out;
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
