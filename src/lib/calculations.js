/**
 * V-Cut Salon - Core calculation utilities
 * Ported 1:1 from legacy_index.html
 */

export const ROLES = ['Mens Hairdresser', 'Unisex Hairdresser', 'Beautician', 'Captain', 'Manager', 'Trainee'];
export const INR = (v) => { const n = Math.round(v || 0); return (n < 0 ? '-₹' : '₹') + Math.abs(n).toLocaleString('en-IN'); };
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MASK = '•••••';

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
export function proRataSalary(st, monthStr, branches, salaryHistory, staffList, globalSettings = {}, leaves = []) {
  const salary = getStaffSalaryForMonth(st.id, monthStr, salaryHistory, staffList);
  if (!salary) return 0;

  const [yr, mo] = monthStr.split('-').map(Number);
  const daysInMonth = new Date(yr, mo, 0).getDate();
  const weeklyOffs = Math.floor(daysInMonth / 7) * 2 + (daysInMonth % 7 >= 6 ? 1 : 0);
  const workingDays = daysInMonth - weeklyOffs;

  const branch = branches?.find(b => b.id === st.branch_id);
  // Use global settings if available, else fallback to legacy defaults
  let paidLeave = branch && branch.type === 'unisex' ? 3 : 2;
  if (globalSettings) {
    if (branch?.type === 'mens' && globalSettings.mens_leaves !== undefined) paidLeave = globalSettings.mens_leaves;
    if (branch?.type === 'unisex' && globalSettings.unisex_leaves !== undefined) paidLeave = globalSettings.unisex_leaves;
  }

  const monthStart = new Date(yr, mo - 1, 1);
  const monthEnd = new Date(yr, mo, 0);
  const joinDate = st.join ? new Date(st.join) : null;
  const exitDate = st.exit_date ? new Date(st.exit_date) : null;

  // Full month
  if ((!joinDate || joinDate <= monthStart) && (!exitDate || exitDate >= monthEnd)) {
    return salary;
  }

  // Pro-rata
  const effectiveStart = (joinDate && joinDate > monthStart) ? joinDate : monthStart;
  const effectiveEnd = (exitDate && exitDate < monthEnd) ? exitDate : monthEnd;

  if (effectiveStart > effectiveEnd) return 0;

  const calDays = Math.round((effectiveEnd - effectiveStart) / 86400000) + 1;
  const periodOffs = Math.floor(calDays / 7) * 2 + (calDays % 7 >= 6 ? 1 : 0);
  const periodWorkDays = Math.max(0, calDays - periodOffs);
  const proPaidLeave = Math.round(paidLeave * calDays / daysInMonth);
  const fullPayBasis = workingDays + paidLeave;

  // Approved leaves in this month for this staff
  const approvedLeaves = (leaves || []).filter(l =>
    l.staff_id === st.id && l.status === 'approved' && l.date && l.date.startsWith(monthStr)
  );
  const totalLeaveDays = approvedLeaves.reduce((s, l) => s + (Number(l.days) || 1), 0);
  // Paid allowance covers up to proPaidLeave days; the rest is unpaid (reduces salary).
  const unpaidLeaveDays = Math.max(0, totalLeaveDays - proPaidLeave);
  const payableDays = Math.max(
    0,
    Math.min(periodWorkDays + proPaidLeave, workingDays + paidLeave) - unpaidLeaveDays
  );

  return Math.round(salary * payableDays / fullPayBasis);
}

/** Staff overall status — active/inactive relative to a given month */
export function staffOverallStatus(st, forMonth) {
  if (!st.exit_date) return 'active';
  const exit = new Date(st.exit_date);
  if (forMonth) {
    const [yr, mo] = forMonth.split('-').map(Number);
    return exit < new Date(yr, mo - 1, 1) ? 'inactive' : 'active';
  }
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  return exit < todayStart ? 'inactive' : 'active';
}

/** Staff status detail for a specific month (active/partial/inactive + days worked) */
export function staffStatusForMonth(st, monthStr) {
  const [yr, mo] = monthStr.split('-').map(Number);
  const daysInMonth = new Date(yr, mo, 0).getDate();
  const monthStart = new Date(yr, mo - 1, 1);
  const monthEnd = new Date(yr, mo, 0);
  const joinDate = st.join ? new Date(st.join) : null;
  const exitDate = st.exit_date ? new Date(st.exit_date) : null;

  if (joinDate && joinDate > monthEnd) return { status: 'inactive', daysWorked: 0 };
  if (exitDate && exitDate < monthStart) return { status: 'inactive', daysWorked: 0 };

  if ((!joinDate || joinDate <= monthStart) && (!exitDate || exitDate >= monthEnd)) {
    return { status: 'active', daysWorked: daysInMonth };
  }

  const effStart = (joinDate && joinDate > monthStart) ? joinDate : monthStart;
  const effEnd = (exitDate && exitDate < monthEnd) ? exitDate : monthEnd;
  const calDays = Math.round((effEnd - effStart) / 86400000) + 1;
  const offDays = Math.floor(calDays / 7) * 2 + (calDays % 7 >= 6 ? 1 : 0);
  const worked = Math.max(0, calDays - offDays);
  return { status: 'partial', daysWorked: worked, calDays, joinedOn: st.join, exitedOn: st.exit_date };
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
