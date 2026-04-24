"use client";
import { useEffect, useState, useRef, useMemo } from "react";
import { collection, onSnapshot, query, orderBy, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR, staffBillingInPeriod, makeFilterPrefix, periodLabel, proRataSalary, staffLeavesInMonth, staffStatusForMonth, staffIncentivesInPeriod, parseLocalDate, MASK } from "@/lib/calculations";
import { PeriodWidget, ToggleGroup, Card, Pill, TH, TD, Icon, Modal, TabNav, ProgressBar, useToast } from "@/components/ui";
import { useRouter } from "next/navigation";
// ExcelJS is ~200KB — load only when Export is actually used.
let _excelJSPromise = null;
const loadExcelJS = () => {
  if (!_excelJSPromise) _excelJSPromise = import("exceljs").then(m => m.default || m);
  return _excelJSPromise;
};

const NOW = new Date();

const PremiumStatCard = ({ label, value, sub, icon, color = "var(--accent)", trend, onClick, linkLabel }) => (
  <div
    onClick={onClick}
    role={onClick ? "button" : undefined}
    tabIndex={onClick ? 0 : undefined}
    onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
    style={{
      background: "var(--bg3)",
      borderRadius: 16,
      padding: "22px 24px",
      flex: 1,
      minWidth: 220,
      position: "relative",
      overflow: "hidden",
      border: "1px solid rgba(72,72,71,0.1)",
      cursor: onClick ? "pointer" : "default",
      transition: "transform .15s, box-shadow .15s, border-color .15s",
    }}
    onMouseEnter={onClick ? (e) => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = `0 6px 20px ${color}33`; e.currentTarget.style.borderColor = `${color}55`; } : undefined}
    onMouseLeave={onClick ? (e) => { e.currentTarget.style.transform = "none"; e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.borderColor = "rgba(72,72,71,0.1)"; } : undefined}>
    <div style={{ position: "absolute", top: -15, right: -15, width: 80, height: 80, background: color, filter: "blur(40px)", opacity: 0.06, borderRadius: "50%" }} />
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", position: "relative", zIndex: 1 }}>
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 10, fontFamily: "var(--font-body, var(--font-outfit))", display: "flex", alignItems: "center", gap: 6 }}>
          {label}
          {onClick && <span title={linkLabel || "Open details"} style={{ color: color, fontSize: 11, opacity: 0.9 }}>↗</span>}
        </div>
        <div style={{ fontSize: 28, fontWeight: 800, color: color, letterSpacing: -0.5, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{value}</div>
        {sub && <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 500, marginTop: 4 }}>{sub}</div>}
      </div>
      <div style={{ background: "var(--bg4)", padding: 10, borderRadius: 12, color: color, opacity: 0.7 }}>
        <Icon name={icon} size={20} />
      </div>
    </div>
    {trend && (
      <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, color: trend.startsWith('+') ? "var(--green)" : "var(--red)" }}>
        <Icon name={trend.startsWith('+') ? "trending" : "arrowUp"} size={12} />
        {trend} from last month
      </div>
    )}
  </div>
);

const ActivityItem = ({ title, sub, time, icon, color = "var(--accent)" }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 0", borderBottom: "1px solid rgba(72,72,71,0.08)" }}>
    <div style={{ background: "var(--bg4)", padding: 10, borderRadius: 12, color: color }}>
      <Icon name={icon} size={16} />
    </div>
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{title}</div>
      <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 500 }}>{sub}</div>
    </div>
    <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase" }}>{time}</div>
  </div>
);

export default function DashboardPage() {
  const [branches, setBranches]   = useState([]);
  const [staff, setStaff]         = useState([]);
  const [entries, setEntries]     = useState([]);
  const [leaves, setLeaves]       = useState([]);
  const [advances, setAdvances]   = useState([]);
  const [reviews, setReviews]     = useState([]);
  const [salHistory, setSalHistory] = useState([]);
  const [globalSettings, setGlobalSettings] = useState(null);
  const [materialAllocations, setMaterialAllocations] = useState([]);
  const [loading, setLoading]     = useState(true);

  // Period
  const [filterMode, setFilterMode]   = useState("month");
  const [filterYear, setFilterYear]   = useState(NOW.getFullYear());
  const [filterMonth, setFilterMonth] = useState(NOW.getMonth() + 1);

  const [showAdvLog, setShowAdvLog]   = useState(false);
  const [showProjBreakdown, setShowProjBreakdown] = useState(false);

  // Dashboard view controls
  const [dashView, setDashView]         = useState("all");
  const [brFilter, setBrFilter]         = useState("all");
  const [brTypeFilter, setBrTypeFilter] = useState("all");
  const [brSortCol, setBrSortCol]       = useState("name");
  const [brSortDir, setBrSortDir]       = useState("asc");
  const [brView, setBrView]             = useState("card");
  const [staffView, setStaffView]       = useState("chart"); // 'chart' | 'table'
  const [staffChartLimit, setStaffChartLimit] = useState(10);
  const [exporting, setExporting] = useState(false);
  const { toast, ToastContainer } = useToast();
  // Drag-and-drop order for branch cards
  const [cardOrder, setCardOrder] = useState([]);
  const dragId = useRef(null);

  const router = useRouter();
  const currentUser = useCurrentUser() || {};
  const isAdmin = currentUser?.role === "admin";
  const isEmployee = currentUser?.role === "employee";
  const [empActiveTab, setEmpActiveTab] = useState("stats");
  const [kpiSection, setKpiSection] = useState("all");

  const [subTick, setSubTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // Listen for the Command Bar's Refresh button: re-subscribe + show progress
  useEffect(() => {
    const onRefresh = () => {
      setRefreshing(true);
      setSubTick(t => t + 1);
      setTimeout(() => setRefreshing(false), 1200);
    };
    window.addEventListener("app:refresh", onRefresh);
    return () => window.removeEventListener("app:refresh", onRefresh);
  }, []);

  useEffect(() => {
    if (!db) return;
    const err = (name) => (e) => console.warn(`${name} sync error:`, e);
    const unsubs = [
      onSnapshot(collection(db, "branches"),
        sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id }))),
        err("branches")),
      onSnapshot(collection(db, "staff"),
        sn => setStaff(sn.docs.map(d => ({ ...d.data(), id: d.id }))),
        err("staff")),
      onSnapshot(collection(db, "leaves"),
        sn => setLeaves(sn.docs.map(d => ({ ...d.data(), id: d.id }))),
        err("leaves")),
      onSnapshot(collection(db, "salary_history"),
        sn => setSalHistory(sn.docs.map(d => ({ ...d.data(), id: d.id }))),
        err("salary_history")),
      onSnapshot(doc(db, "settings", "global"),
        sn => setGlobalSettings(sn.data() || {}),
        err("settings")),
      onSnapshot(
        query(collection(db, "entries"), orderBy("date", "desc")),
        sn => {
          setEntries(sn.docs.map(d => ({ ...d.data(), id: d.id })));
          setLoading(false);
        },
        err("entries")
      ),
      onSnapshot(collection(db, "staff_advances"),
        sn => setAdvances(sn.docs.map(d => ({ ...d.data(), id: d.id }))),
        err("staff_advances")),
      onSnapshot(
        query(collection(db, "staff_reviews"), orderBy("date", "desc")),
        sn => setReviews(sn.docs.map(d => ({ ...d.data(), id: d.id }))),
        err("staff_reviews")
      ),
      onSnapshot(
        query(collection(db, "material_allocations"), orderBy("transferred_at", "desc")),
        sn => setMaterialAllocations(sn.docs.map(d => ({ ...d.data(), id: d.id }))),
        err("material_allocations")
      ),
    ];
    return () => unsubs.forEach(u => u());
  }, [subTick]);

  const filterPrefix = makeFilterPrefix(filterYear, filterMonth);
  const plabel       = periodLabel(filterMode, filterYear, filterMonth);

  const inPeriod = (dateStr) => {
    if (!dateStr) return false;
    return filterMode === "month"
      ? dateStr.startsWith(filterPrefix)
      : dateStr.startsWith(String(filterYear));
  };

  // Material source toggles from Master Setup → Material Expense Source.
  const matUseAllocations = globalSettings?.mat_use_allocations !== false;
  const matUseLumpsum = globalSettings?.mat_use_lumpsum === true;
  const allocsTotal = (arr) => arr.reduce((s, a) => s + (Number(a.total) || (a.items || []).reduce((ss, it) => ss + (Number(it.line_total) || (Number(it.qty) * Number(it.price_at_transfer)) || 0), 0)), 0);

  // Prorata Factor for Fixed Costs
  const isYearly = filterMode === "year";
  const factor = (isYearly && filterYear === NOW.getFullYear()) ? (NOW.getMonth() + 1) : (isYearly ? 12 : 1);

  // Network totals are derived from branchData below so Operating Cost =
  // Full Net P&L's expense side: vInc + vMatE + vOther + fixed + actual
  // salary + GST estimate. Earlier these were computed ad-hoc with
  // b.salary_budget × factor and no GST, causing a ~5–10% mismatch with
  // the branch-detail and Summary-view totals.
  const tG   = entries.filter(e => inPeriod(e.date)).reduce((s, e) => s + (e.total_gst || 0), 0);
  const pLeaveDays = leaves.filter(l => l.status === "pending")
    .reduce((s, l) => s + (parseInt(l.days) || 1), 0);

  // Build + filter + sort branch data
  let branchData = branches.map(b => {
    const bEntries = entries.filter(ent => ent.branch_id === b.id && inPeriod(ent.date));

    // Aggregates
    const iOnline = bEntries.reduce((s, e) => s + (e.online || 0), 0);
    const iCash   = bEntries.reduce((s, e) => s + (e.cash || 0), 0);
    const iMatS   = bEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.material || 0), 0), 0);
    const income  = iOnline + iCash + iMatS;

    const vInc   = bEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.incentive || 0) + (sb.mat_incentive || 0), 0), 0);
    // Material cost respects Master Setup → Material Expense Source toggles.
    const vMatAlloc = allocsTotal(materialAllocations.filter(a => a.branch_id === b.id && inPeriod(a.date || (a.transferred_at || "").slice(0, 10))));
    const vMatLump = bEntries.reduce((s, e) => s + (Number(e.mat_expense) || 0), 0);
    const vMatE = (matUseAllocations ? vMatAlloc : 0) + (matUseLumpsum ? vMatLump : 0);
    const vOther = bEntries.reduce((s, e) => s + (e.others || 0) + (e.petrol || 0), 0);
    const vPetrol = bEntries.reduce((s, e) => s + (e.petrol || 0), 0);

    // Fixed costs — charge the full period (rent / wifi / electricity accrue
    // whether the shop operated that day or not). Matches the branch detail
    // 'Fixed Costs' KPI so the card P&L lines up with Full Net P&L.
    const fShopRent = (b.shop_rent || 0) * factor;
    const fRoomRent = (b.room_rent || 0) * factor;
    const fWifi     = (b.wifi || 0) * factor;
    const fElec     = ((b.shop_elec || 0) + (b.room_elec || 0)) * factor;
    const fFixedTot = fShopRent + fRoomRent + fWifi + fElec;

    // Payroll (Actual) — full monthly pro-rata across every month in range.
    // Salary is a contractual cost, not proportional to days the shop opened,
    // so we do not cut it by active days here either.
    let actualSalary = 0;
    let actualLeaves = 0;
    // Projected salary mirrors `actualSalary` but skips proRataSalary's yesterday cap
    // so the current month is valued through month-end. Past months + year mode are
    // unaffected (cap only applies to the active month).
    let projectedSalary = 0;
    const startM = isYearly ? 1 : filterMonth;
    const endM   = isYearly ? factor : filterMonth;
    for (let m = startM; m <= endM; m++) {
      const mPrefix = `${filterYear}-${String(m).padStart(2, '0')}`;
      const [yr, mo] = mPrefix.split('-').map(Number);
      const daysInMo = new Date(yr, mo, 0).getDate();
      const mStart = new Date(yr, mo - 1, 1);
      const mEnd = new Date(yr, mo, 0);
      const activeStaffInMonth = staff.filter(s => s.branch_id === b.id && staffStatusForMonth(s, mPrefix).status !== 'inactive');
      actualSalary += activeStaffInMonth.reduce((s, st) => s + proRataSalary(st, mPrefix, branches, salHistory, staff, globalSettings), 0);
      actualLeaves += activeStaffInMonth.reduce((s, st) => s + staffLeavesInMonth(st.id, mPrefix, leaves), 0);
      projectedSalary += activeStaffInMonth.reduce((s, st) => {
        const baseSal = Number(st.salary) || 0;
        if (!baseSal) return s;
        const jd = parseLocalDate(st.join);
        const ed = parseLocalDate(st.exit_date);
        const effStart = (jd && jd > mStart) ? jd : mStart;
        const effEnd = (ed && ed < mEnd) ? ed : mEnd;
        if (effStart > effEnd) return s;
        const cal = Math.round((effEnd - effStart) / 86400000) + 1;
        let q = b.type === 'unisex' ? 3 : 2;
        if (b.type === 'mens' && globalSettings?.mens_leaves !== undefined) q = globalSettings.mens_leaves;
        if (b.type === 'unisex' && globalSettings?.unisex_leaves !== undefined) q = globalSettings.unisex_leaves;
        const proPaid = Math.ceil(q * cal / daysInMo);
        const mL = staffLeavesInMonth(st.id, mPrefix, leaves);
        const unpaid = Math.max(0, mL - proPaid);
        const payable = Math.max(0, cal - unpaid);
        return s + Math.round((baseSal / daysInMo) * payable);
      }, 0);
    }

    // GST is derived from online revenue at the configured global rate so it
    // matches the branch detail's totalGstEst (which uses the same formula).
    // Falling back to stored entry.total_gst hides entries that were saved
    // before the field was populated.
    const gstPct = globalSettings?.gst_pct || 0;
    const totalGst = (iOnline * gstPct) / 100;
    const expenses = vInc + vMatE + vOther + fFixedTot + actualSalary;
    // Net = Full Net P&L (income − variable − fixed − salary − GST), matching
    // the branch detail KPI so the card border and the Profit/Loss filter
    // reflect the same number you see inside the branch.
    const net = income - expenses - totalGst;

    return {
      b,
      i: income,
      e: expenses,
      n: net,
      staffCount: staff.filter(s => s.branch_id === b.id).length,
      vInc, vMatE, vOther, vPetrol,
      fShopRent, fRoomRent, fWifi, fElec,
      actualSalary, actualLeaves, projectedSalary,
      // Projected expense = what Operating Cost will be once the current month finishes —
      // same formula as `e + totalGst` but uses the un-capped salary.
      projectedExp: vInc + vMatE + vOther + fFixedTot + projectedSalary + totalGst,
      totalGst, factor
    };
  });

  // Network totals computed from the pre-filter branchData so the top KPIs
  // stay stable regardless of the Profit/Loss/Type filter selection. The
  // expense side mirrors branchData's Full Net P&L formula (actual salary +
  // GST estimate + variable + fixed) — this is what the Summary view's
  // Total Expense card uses, so the two now agree.
  const tI  = branchData.reduce((s, d) => s + d.i, 0);
  const tE  = branchData.reduce((s, d) => s + d.e + d.totalGst, 0);
  const tEProjected = branchData.reduce((s, d) => s + d.projectedExp, 0);
  const net = branchData.reduce((s, d) => s + d.n, 0);

  if (brFilter === "profit") branchData = branchData.filter(d => d.n >= 0);
  if (brFilter === "loss")   branchData = branchData.filter(d => d.n < 0);
  if (brTypeFilter === "mens")   branchData = branchData.filter(d => d.b.type === "mens");
  if (brTypeFilter === "unisex") branchData = branchData.filter(d => d.b.type === "unisex");
  branchData.sort((a, b) => {
    if (brSortCol === "income")  return brSortDir === "desc" ? b.i - a.i : a.i - b.i;
    if (brSortCol === "pl")      return brSortDir === "desc" ? b.n - a.n : a.n - b.n;
    if (brSortCol === "expense") return brSortDir === "desc" ? b.e - a.e : a.e - b.e;
    return brSortDir === "desc"
      ? b.b.name.localeCompare(a.b.name)
      : a.b.name.localeCompare(b.b.name);
  });

  // Branch lookup — memoized so per-staff resolution in the leaderboard is O(1).
  const branchesById = useMemo(() => {
    const m = new Map();
    branches.forEach(b => m.set(b.id, b));
    return m;
  }, [branches]);

  // Staff leaderboard — honours the same Mens/Unisex filter as branch cards
  const staffData = staff
    .filter(s => {
      if (brTypeFilter === "all") return true;
      const sb = branchesById.get(s.branch_id);
      return sb?.type === brTypeFilter;
    })
    .map(s => {
      const sale = staffBillingInPeriod(s.id, entries, filterPrefix, filterMode, filterYear);
      const baseTgt = s.target || 50000;
      const tgt = baseTgt * factor;
      const b    = branchesById.get(s.branch_id);

      // Aggregate Salary & Leaves for the period
      let periodSalary = 0;
      let periodLeaves = 0;
      const startM = isYearly ? 1 : filterMonth;
      const endM   = isYearly ? factor : filterMonth; // factor is (NOW.getMonth() + 1) for current year
      
      // Since factor for yearly might be less than 12 for the current year, 
      // we loop up to factor (which is the effective number of months passed)
      for (let m = startM; m <= endM; m++) {
        const mPrefix = `${filterYear}-${String(m).padStart(2, '0')}`;
        periodSalary += proRataSalary(s, mPrefix, branches, salHistory, staff, globalSettings);
        periodLeaves += staffLeavesInMonth(s.id, mPrefix, leaves);
      }

      return { s, b, sale, tgt, pct: Math.min(Math.round(sale / tgt * 100), 100), periodSalary, periodLeaves };
    })
    .sort((a, b) => b.sale - a.sale);

  // ── Top Performers reconciliation ────────────────────────────────────
  // Gross Revenue = online + cash + sum(sb.material), across all entries in period.
  // Total Billing (Top Performers) = sum of sb.billing for staff that exist
  // *and* pass the branch-type filter. The difference is broken down so the
  // gap is explainable rather than a mystery.
  const staffIdSet = new Set(staff.map(s => s.id));
  const visibleStaffIdSet = new Set(staffData.map(r => r.s.id));
  const periodEntries = entries.filter(e => inPeriod(e.date));
  let reconMaterial = 0;
  let reconOnlineCash = 0;
  let reconBillingAll = 0;
  let reconBillingAttributed = 0;
  let reconBillingOrphaned = 0;        // staff_id has no matching staff doc
  let reconBillingFilteredOut = 0;     // matches a real staff but filtered out by type
  periodEntries.forEach(e => {
    reconOnlineCash += (e.online || 0) + (e.cash || 0);
    (e.staff_billing || []).forEach(sb => {
      const bill = Number(sb.billing) || 0;
      reconMaterial += Number(sb.material) || 0;
      reconBillingAll += bill;
      if (sb.staff_id && visibleStaffIdSet.has(sb.staff_id)) reconBillingAttributed += bill;
      else if (sb.staff_id && staffIdSet.has(sb.staff_id)) reconBillingFilteredOut += bill;
      else reconBillingOrphaned += bill;
    });
  });
  const reconGross = reconOnlineCash + reconMaterial;
  // Anything paid that didn't end up in any staff_billing[].billing row —
  // tips, rounding, services without a stylist split.
  const reconUnattributed = Math.max(0, reconOnlineCash - reconBillingAll);
  const recon = {
    gross: reconGross,
    attributed: reconBillingAttributed,
    diff: reconGross - reconBillingAttributed,
    material: reconMaterial,
    orphaned: reconBillingOrphaned,
    filteredOut: reconBillingFilteredOut,
    unattributed: reconUnattributed,
    onlineCash: reconOnlineCash,
    billingAll: reconBillingAll,
  };

  if (loading) return (
    <div style={{ textAlign: "center", color: "var(--gold)", fontWeight: 700, padding: 40 }}>
      Loading Dashboard...
    </div>
  );

  if (isEmployee) {
    const isYearly = filterMode === "year";
    const myProfile = staff.find(s =>
      (currentUser.staff_id && s.id === currentUser.staff_id) ||
      s.id === currentUser.id ||
      s.name?.toLowerCase().trim() === currentUser.name?.toLowerCase().trim()
    );

    if (!myProfile) return (
       <div style={{ padding: 40, textAlign: "center", color: "var(--red)" }}>
         Your user account is not linked to any active staff profile. Please contact Admin.
       </div>
    );

    // Calculations
    const currentM = NOW.getMonth() + 1;
    const currentMPrefix = `${filterYear}-${String(currentM).padStart(2, '0')}`;
    const isCurrentYear = filterYear === NOW.getFullYear();
    const currentMonthSalary = proRataSalary(myProfile, isYearly ? currentMPrefix : filterPrefix, branches, salHistory, staff, globalSettings);
    
    const isMyAdvance = (a) => a.staff_id === myProfile.id || a.staff_id === currentUser.id || a.staff_id === currentUser.staff_id;
    const targetPrefix = isYearly ? currentMPrefix : filterPrefix;
    const [cyr, cmo] = targetPrefix.split('-').map(Number);
    const daysInTargetMonth = new Date(cyr, cmo, 0).getDate();
    const daysElapsed = (cyr === NOW.getFullYear() && cmo === NOW.getMonth() + 1) ? NOW.getDate() : daysInTargetMonth;
    const earnedSoFar = Math.round(currentMonthSalary * daysElapsed / daysInTargetMonth);
    
    const myAdvancesAllStatus = advances.filter(a => isMyAdvance(a) && ((a.month_str && inPeriod(a.month_str)) || (a.date && inPeriod(a.date))));
    const totalAdvances = myAdvancesAllStatus.filter(a => a.status === 'approved').reduce((sum, a) => sum + Number(a.amount), 0);
    const totalAdvancesPending = myAdvancesAllStatus.filter(a => a.status === 'pending').reduce((sum, a) => sum + Number(a.amount), 0);
    const remainingThisMonth = earnedSoFar - totalAdvances;

    const baseTgt = myProfile.target || 50000;
    const tgt = baseTgt * factor;
    const sale = staffBillingInPeriod(myProfile.id, entries, filterPrefix, filterMode, filterYear);
    const pct = Math.min(Math.round(sale / tgt * 100), 100);

    const myReviews = reviews.filter(r => r.staff_id === myProfile.id && ((r.date && r.date.startsWith(String(filterYear))) || !r.date));
    const avgRating = myReviews.length ? (myReviews.reduce((sum, r) => sum + Number(r.rating || 0), 0) / myReviews.length).toFixed(1) : "0.0";

    const yearAdvances = advances.filter(a => isMyAdvance(a) &&
      ((a.month_str && a.month_str.startsWith(String(filterYear))) || (a.date && a.date.startsWith(String(filterYear))))
    ).sort((a, b) => (b.created_at?.seconds || 0) - (a.created_at?.seconds || 0));

    const empTabs = [
      { id: "stats", icon: "grid", label: "My Stats" },
      { id: "leaderboard", icon: "trending", label: "Leaderboard" },
      { id: "reviews", icon: "pie", label: "Reviews" }
    ];

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
        {/* Header Section */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div>
            <h2 style={{ fontSize: 32, fontWeight: 950, color: "var(--text)", letterSpacing: -1.5, margin: 0 }}>Curated Insights</h2>
            <p style={{ fontSize: 13, color: "var(--text3)", fontWeight: 600, marginTop: 4 }}>Welcome back, {currentUser.name}. Here's your performance overlook.</p>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <PeriodWidget filterMode={filterMode} setFilterMode={setFilterMode} filterYear={filterYear} setFilterYear={setFilterYear} filterMonth={filterMonth} setFilterMonth={setFilterMonth} />
            <button onClick={() => setShowAdvLog(true)} style={{ background: "rgba(212,175,55, 0.1)", border: "1px solid var(--border)", color: "var(--gold)", padding: "10px 18px", borderRadius: 16, cursor: "pointer", display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 800, transition: "all .2s" }}>
              <Icon name="clock" size={16} /> Advance Log
            </button>
          </div>
        </div>

        <TabNav tabs={empTabs} activeTab={empActiveTab} onTabChange={setEmpActiveTab} />

        {empActiveTab === "stats" && (
          <>
            {/* KPI Metrics */}
            <div style={{ display: "flex", gap: 24 }}>
              <PremiumStatCard label="Net Payable" value={INR(remainingThisMonth)} sub="Available withdrawal" icon="wallet" trend="+12%" color="var(--accent)" />
              <PremiumStatCard label="Sales Target" value={`${pct}%`} sub={`${INR(sale)} of ${INR(tgt)}`} icon="trending" trend="+5.4%" color="var(--gold)" />
              <PremiumStatCard label="Review Score" value={`${avgRating} / 5`} sub={`From ${myReviews.length} customers`} icon="pie" color="var(--accent)" />
            </div>

            {/* Content Body Grid */}
            <div style={{ display: "grid", gridTemplateColumns: "1.8fr 1fr", gap: 32 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
                <Card style={{ padding: 32, marginBottom: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
                    <h3 style={{ fontSize: 18, fontWeight: 900, color: "var(--text)", margin: 0 }}>Recent Activity</h3>
                    <Pill label="Live Feed" color="blue" />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <ActivityItem title="Advance Request" sub="Sent ₹5,000 request for branch manager approval." time="1h ago" icon="clock" color="var(--blue)" />
                    <ActivityItem title="Performance Bonus" sub="You've earned an additional ₹1,500 incentive." time="Yesterday" icon="checkCircle" color="var(--green)" />
                    <ActivityItem title="Incentive Update" sub="New material incentive added for Premium Grooming." time="2d ago" icon="trending" color="var(--accent)" />
                  </div>
                </Card>

                <Card style={{ padding: 32, marginBottom: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 }}>
                     <h3 style={{ fontSize: 18, fontWeight: 900, color: "var(--text)", margin: 0 }}>Financial Flow</h3>
                     <div style={{ display: "flex", gap: 8 }}>
                        <Pill label="Income" color="blue" />
                        <Pill label="Payout" color="red" />
                     </div>
                  </div>
                  <div style={{ height: 180, display: "flex", alignItems: "flex-end", gap: 20, paddingBottom: 10 }}>
                     {[40, 65, 35, 90, 70, 55, 80].map((h, i) => (
                       <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12, height: "100%", justifyContent: "flex-end" }}>
                          <div style={{ height: `${h}%`, width: "100%", background: i === 3 ? "var(--accent)" : "rgba(34,211,238,0.15)", borderRadius: 8 }}></div>
                          <div style={{ textAlign: "center", fontSize: 10, fontWeight: 800, color: "var(--text3)" }}>{['M','T','W','T','F','S','S'][i]}</div>
                       </div>
                     ))}
                  </div>
                </Card>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
                <div style={{ background: "linear-gradient(135deg, var(--bg2), var(--bg3))", border: "1px solid var(--accent)", borderRadius: 32, padding: 32, position: "relative", overflow: "hidden" }}>
                  <div style={{ position: "absolute", top: -50, right: -50, width: 220, height: 220, background: "var(--accent)", filter: "blur(100px)", opacity: 0.15 }}></div>
                  <h4 style={{ fontSize: 12, fontWeight: 900, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 2, marginBottom: 16 }}>Expansion Roadmap</h4>
                  <h3 style={{ fontSize: 24, fontWeight: 950, color: "var(--text)", lineHeight: 1.2, marginBottom: 16 }}>Unlock Flagship <br/>Privileges</h3>
                  <p style={{ fontSize: 13, color: "var(--text3)", fontWeight: 600, lineHeight: 1.6, marginBottom: 24 }}>Top performing staff are prioritized for the upcoming V-Cut Select flagship launch.</p>
                  <button style={{ width: "100%", padding: "16px", background: "var(--accent)", color: "#000", border: "none", borderRadius: 16, fontWeight: 900, fontSize: 12, textTransform: "uppercase", letterSpacing: 1, cursor: "pointer" }}>Inquire Status</button>
                </div>

                <Card style={{ padding: 24 }}>
                  <h4 style={{ fontSize: 14, fontWeight: 900, color: "var(--text)", marginBottom: 20 }}>Quick Actions</h4>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <button onClick={() => router.push('/dashboard/apply-leave')} style={{ display: "flex", alignItems: "center", gap: 12, padding: 16, background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)", borderRadius: 16, color: "var(--text)", fontSize: 13, fontWeight: 750, cursor: "pointer" }}>
                       <Icon name="clock" size={18} color="var(--blue)" /> Time-Off Request
                    </button>
                    <button onClick={() => router.push('/dashboard/my-payroll')} style={{ display: "flex", alignItems: "center", gap: 12, padding: 16, background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)", borderRadius: 16, color: "var(--text)", fontSize: 13, fontWeight: 750, cursor: "pointer" }}>
                       <Icon name="wallet" size={18} color="var(--gold)" /> Pay Statement
                    </button>
                  </div>
                </Card>
              </div>
            </div>
          </>
        )}

        {empActiveTab === "leaderboard" && (
          <Card style={{ padding: 0 }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
              <thead>
                <tr>
                  <TH>Rank</TH><TH>Staff Member</TH><TH>Branch</TH><TH right>Sales Volume</TH><TH right>Performance</TH>
                </tr>
              </thead>
              <tbody>
                {staffData.slice(0, 50).map(({ s, b, sale, tgt, pct }, index) => (
                  <tr key={s.id} style={{ background: s.id === myProfile.id ? "rgba(34,211,238,0.05)" : "transparent" }}>
                    <TD style={{ textAlign: "center", width: 80 }}>{index + 1 <= 3 ? ["🥇","🥈","🥉"][index] : `#${index + 1}`}</TD>
                    <TD style={{ fontWeight: 800 }}>{s.name} {s.id === myProfile.id && <Pill label="YOU" color="blue" />}</TD>
                    <TD style={{ fontSize: 12, color: "var(--text3)", textTransform: "uppercase" }}>{b?.name?.replace('V-CUT ', '') || "—"}</TD>
                    <TD right style={{ color: "var(--accent)", fontWeight: 900 }}>{INR(sale)}</TD>
                    <TD right>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, justifyContent: "flex-end" }}>
                        <div style={{ width: 100, height: 6, background: "var(--border)", borderRadius: 10, overflow: "hidden" }}>
                          <div style={{ width: `${pct}%`, height: "100%", background: pct >= 100 ? "var(--green)" : "var(--blue)" }}></div>
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 900 }}>{pct}%</span>
                      </div>
                    </TD>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {empActiveTab === "reviews" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(350px, 1fr))", gap: 24 }}>
            {myReviews.map(r => (
              <Card key={r.id} style={{ padding: 24 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
                  <div style={{ fontWeight: 900, color: "var(--text)" }}>{r.customer_name || "Guest Client"}</div>
                  <div style={{ fontSize: 12, color: "var(--text3)", fontWeight: 600 }}>{r.date}</div>
                </div>
                <div style={{ marginBottom: 16, color: "var(--gold)", letterSpacing: 2 }}>{'★'.repeat(Math.round(r.rating || 0))}{'☆'.repeat(5 - Math.round(r.rating || 0))}</div>
                <p style={{ fontSize: 13, color: "var(--text2)", lineHeight: 1.6, margin: 0, fontStyle: "italic" }}>"{r.feedback}"</p>
              </Card>
            ))}
          </div>
        )}

        {showAdvLog && (
          <Modal isOpen={true} title="Advance History" onClose={() => setShowAdvLog(false)}>
             <div style={{ maxHeight: '60vh', overflowY: "auto" }}>
               <table style={{ width: "100%" }}>
                 <thead><tr><TH>Date</TH><TH>Amount</TH><TH>Status</TH><TH>Reason</TH></tr></thead>
                 <tbody>
                   {yearAdvances.map(a => (
                     <tr key={a.id}>
                       <TD>{a.date || "—"}</TD>
                       <TD style={{ color: "var(--red)", fontWeight: 800 }}>{INR(a.amount)}</TD>
                       <TD><Pill label={a.status} color={a.status === 'approved' ? 'green' : 'orange'} /></TD>
                       <TD style={{ fontSize: 12, color: "var(--text3)" }}>{a.reason}</TD>
                     </tr>
                   ))}
                 </tbody>
               </table>
             </div>
          </Modal>
        )}
      </div>
    );
  }

  // Export Branch Performance — each branch in its own tab
  const exportBranchPerformance = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const ExcelJS = await loadExcelJS();
      const wb = new ExcelJS.Workbook();
      wb.creator = "V-Cut";
      wb.created = new Date();

      const periodText = filterMode === "year"
        ? String(filterYear)
        : `${String(filterMonth).padStart(2, "0")}-${filterYear}`;

      const headerFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0891B2" } };
      const headerFont = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      const moneyFmt = '₹#,##0;[Red]-₹#,##0';
      const thin = { style: "thin", color: { argb: "FFCBD5E1" } };
      const border = { top: thin, left: thin, bottom: thin, right: thin };

      // Summary sheet with all branches
      const summary = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 3 }] });
      summary.mergeCells("A1:K1");
      const t = summary.getCell("A1");
      t.value = `V-CUT — Branch Performance (${periodText})`;
      t.font = { bold: true, size: 16, color: { argb: "FF0891B2" } };
      t.alignment = { vertical: "middle", horizontal: "center" };
      summary.getRow(1).height = 28;

      const headers = ["Branch", "Income", "P&L", "Salary", "Inc/Mat", "Rent (Shop)", "Rent (Room)", "Travel", "Elec/Wifi", "Leaves", "Staff"];
      const hr = summary.getRow(3);
      headers.forEach((h, i) => {
        const c = hr.getCell(i + 1);
        c.value = h;
        c.font = headerFont;
        c.fill = headerFill;
        c.alignment = { vertical: "middle", horizontal: i === 0 ? "left" : "right" };
        c.border = border;
      });
      hr.height = 22;

      branchData.forEach((d, idx) => {
        const r = summary.getRow(4 + idx);
        const vals = [
          d.b.name.replace("V-CUT ", ""),
          d.i, d.n, d.actualSalary, d.vInc + d.vMatE,
          d.fShopRent, d.fRoomRent, d.vOther, d.fElec + d.fWifi,
          d.actualLeaves, d.staffCount
        ];
        vals.forEach((v, i) => {
          const c = r.getCell(i + 1);
          c.value = v;
          c.border = border;
          if (i === 0) {
            c.font = { bold: true };
          } else if (i >= 1 && i <= 8) {
            c.numFmt = moneyFmt;
            c.alignment = { horizontal: "right" };
          } else {
            c.alignment = { horizontal: "right" };
          }
        });
      });

      summary.columns = [
        { width: 22 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 },
        { width: 14 }, { width: 14 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 8 }
      ];

      // Per-branch sheet — rich view with summary + staff + breakdown + recent + monthly log
      const isYearlyX = filterMode === "year";
      const curY = NOW.getFullYear();
      const curM = NOW.getMonth() + 1;

      const inPeriod = (dateStr) => isYearlyX ? dateStr.startsWith(String(filterYear)) : dateStr.startsWith(filterPrefix);

      const sectionHeader = (ws, row, text, color = "FF0891B2") => {
        ws.mergeCells(`A${row}:L${row}`);
        const c = ws.getCell(`A${row}`);
        c.value = text;
        c.font = { bold: true, size: 12, color: { argb: color } };
        c.alignment = { vertical: "middle", horizontal: "left" };
        ws.getRow(row).height = 22;
      };

      const writeHeaderRow = (ws, rowNum, cols) => {
        const r = ws.getRow(rowNum);
        cols.forEach((h, i) => {
          const c = r.getCell(i + 1);
          c.value = h;
          c.font = headerFont;
          c.fill = headerFill;
          c.alignment = { vertical: "middle", horizontal: i === 0 ? "left" : "right" };
          c.border = border;
        });
        r.height = 22;
      };

      const writeDataRow = (ws, rowNum, values, moneyCols = []) => {
        const r = ws.getRow(rowNum);
        values.forEach((v, i) => {
          const c = r.getCell(i + 1);
          c.value = v;
          c.border = border;
          if (i === 0) {
            c.font = { bold: true };
          } else {
            c.alignment = { horizontal: "right" };
            if (moneyCols.includes(i) && typeof v === "number") c.numFmt = moneyFmt;
          }
        });
      };

      branchData.forEach(d => {
        const b = d.b;
        const safeName = (b.name.replace("V-CUT ", "") || "Branch").slice(0, 31).replace(/[\\\/\?\*\[\]:]/g, "");
        const ws = wb.addWorksheet(safeName);
        let row = 1;

        // Title
        ws.mergeCells(`A${row}:L${row}`);
        const title = ws.getCell(`A${row}`);
        title.value = `${b.name} — ${periodText}`;
        title.font = { bold: true, size: 16, color: { argb: "FF0891B2" } };
        title.alignment = { vertical: "middle", horizontal: "center" };
        ws.getRow(row).height = 28;
        row += 2;

        // Summary
        sectionHeader(ws, row, "Summary"); row++;
        writeHeaderRow(ws, row, ["Metric", "Value"]); row++;
        const summaryRows = [
          ["Branch Type", b.type || "—"],
          ["Staff Count", d.staffCount],
          ["Leaves (days)", d.actualLeaves],
          ["Income", d.i],
          ["Net P&L", d.n],
          ["Salary", d.actualSalary],
          ["Incentives + Material", d.vInc + d.vMatE],
          ["Shop Rent", d.fShopRent],
          ["Room Rent", d.fRoomRent],
          ["Travel / Other", d.vOther],
          ["Electricity", d.fElec],
          ["Wifi", d.fWifi],
        ];
        summaryRows.forEach((r2, i) => {
          const rr = ws.getRow(row);
          const a = rr.getCell(1); const bb = rr.getCell(2);
          a.value = r2[0]; bb.value = r2[1];
          a.border = border; bb.border = border;
          a.font = { bold: true };
          if (typeof r2[1] === "number" && i >= 3) { bb.numFmt = moneyFmt; bb.alignment = { horizontal: "right" }; }
          row++;
        });
        row++;

        // Branch Staff table
        const branchStaff = staff.filter(s => s.branch_id === b.id);
        const periodEntries = entries.filter(e => e.branch_id === b.id && inPeriod(e.date));
        const quotaPerMonth = (b.type === 'unisex' ? globalSettings?.unisex_leaves : globalSettings?.mens_leaves) || (b.type === 'unisex' ? 3 : 2);
        const isPastYear = filterYear < curY;
        const endMonth = isPastYear ? 12 : ((isYearlyX && filterYear === curY) ? curM : (isYearlyX ? 12 : filterMonth));
        const startMonthX = isYearlyX ? 1 : filterMonth;
        const factorX = (endMonth - startMonthX + 1);

        sectionHeader(ws, row, `Branch Staff (${branchStaff.length})`); row++;
        writeHeaderRow(ws, row, ["#", "Name", "Role", "Salary", "Leaves Taken", "Leaves Left", "Billing", "Staff T.Inc", "Staff T.Sale"]); row++;
        branchStaff.forEach((s, i) => {
          let billing = 0, matSale = 0, tips = 0, staffTInc = 0;
          let curSalary = 0, leavesTaken = 0;
          if (filterMode === 'month') {
            curSalary = proRataSalary(s, filterPrefix, branches, salHistory, staff, globalSettings);
            leavesTaken = staffLeavesInMonth(s.id, filterPrefix, leaves);
          } else {
            for (let m = 1; m <= endMonth; m++) {
              const mPrefix = `${filterYear}-${String(m).padStart(2, '0')}`;
              curSalary += proRataSalary(s, mPrefix, branches, salHistory, staff, globalSettings);
              leavesTaken += staffLeavesInMonth(s.id, mPrefix, leaves);
            }
          }
          const quota = quotaPerMonth * factorX;
          const leavesLeft = Math.max(0, quota - leavesTaken);
          periodEntries.forEach(e => {
            const sb = (e.staff_billing || []).find(x => x.staff_id === s.id);
            if (sb) {
              billing += (sb.billing || 0);
              matSale += (sb.material || 0);
              tips += (sb.tips || 0);
              staffTInc += (sb.staff_total_inc || (sb.incentive || 0) + (sb.mat_incentive || 0) + (sb.tips || 0));
            }
          });
          const totalSale = billing + matSale + tips;
          writeDataRow(ws, row, [i + 1, s.name, s.role || "—", curSalary, leavesTaken, leavesLeft, billing, staffTInc, totalSale], [3, 6, 7, 8]);
          row++;
        });
        row++;

        // Breakdown (monthly or daily)
        const breakdown = [];
        if (filterMode === "month") {
          const daysCount = new Date(filterYear, filterMonth, 0).getDate();
          const isFutureMonth = (filterYear > curY) || (filterYear === curY && filterMonth > curM);
          const endDay = isFutureMonth ? 0 : ((filterYear === curY && filterMonth === curM) ? NOW.getDate() : daysCount);
          const dayFactor = 1 / daysCount;
          for (let dd = 1; dd <= endDay; dd++) {
            const dayPrefix = `${filterYear}-${String(filterMonth).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
            const dEntries = entries.filter(e => e.branch_id === b.id && e.date === dayPrefix);
            const dOnline = dEntries.reduce((s, e) => s + (e.online || 0), 0);
            const dCash = dEntries.reduce((s, e) => s + (e.cash || 0), 0);
            const dMatInc = dEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.material || 0), 0), 0);
            const dIncExp = dEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.incentive || 0) + (sb.mat_incentive || 0), 0), 0);
            const dMatExp = dEntries.reduce((s, e) => s + (e.mat_expense || 0), 0);
            const dOtherExp = dEntries.reduce((s, e) => s + (e.others || 0) + (e.petrol || 0), 0);
            const mFixed = (b.shop_rent || 0) + (b.room_rent || 0) + (b.wifi || 0) + (b.shop_elec || 0) + (b.room_elec || 0);
            const dFixed = mFixed * dayFactor;
            const activeSt = staff.filter(s => s.branch_id === b.id && staffStatusForMonth(s, filterPrefix).status !== 'inactive');
            const mActualSal = activeSt.reduce((s, st) => s + proRataSalary(st, filterPrefix, branches, salHistory, staff, globalSettings), 0);
            const dSalary = mActualSal * dayFactor;
            const dLeaves = leaves.filter(l => activeSt.some(as => as.id === l.staff_id) && l.status === 'approved' && l.date === dayPrefix).reduce((s, l) => s + (l.days || 1), 0);
            const dIncome = dOnline + dCash + dMatInc;
            const dExpenses = dIncExp + dMatExp + dOtherExp + dFixed + dSalary;
            breakdown.push({ label: dayPrefix, income: dIncome, incentives: dIncExp, material: dMatExp, others: dOtherExp, shopRent: (b.shop_rent || 0) * dayFactor, roomRent: (b.room_rent || 0) * dayFactor, elec: ((b.shop_elec || 0) + (b.room_elec || 0)) * dayFactor, wifi: (b.wifi || 0) * dayFactor, salary: dSalary, leaves: dLeaves, pl: dIncome - dExpenses });
          }
        } else {
          for (let m = 1; m <= endMonth; m++) {
            const monthPrefix = `${filterYear}-${String(m).padStart(2, '0')}`;
            const mEntries = entries.filter(e => e.branch_id === b.id && e.date.startsWith(monthPrefix));
            const mOnline = mEntries.reduce((s, e) => s + (e.online || 0), 0);
            const mCash = mEntries.reduce((s, e) => s + (e.cash || 0), 0);
            const mMatInc = mEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.material || 0), 0), 0);
            const mIncExp = mEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.incentive || 0) + (sb.mat_incentive || 0), 0), 0);
            const mMatExp = mEntries.reduce((s, e) => s + (e.mat_expense || 0), 0);
            const mOtherExp = mEntries.reduce((s, e) => s + (e.others || 0) + (e.petrol || 0), 0);
            const mFixed = (b.shop_rent || 0) + (b.room_rent || 0) + (b.wifi || 0) + (b.shop_elec || 0) + (b.room_elec || 0);
            const activeSt = staff.filter(s => s.branch_id === b.id && staffStatusForMonth(s, monthPrefix).status !== 'inactive');
            const mActualSal = activeSt.reduce((s, st) => s + proRataSalary(st, monthPrefix, branches, salHistory, staff, globalSettings), 0);
            const mLeaves = activeSt.reduce((s, st) => s + staffLeavesInMonth(st.id, monthPrefix, leaves), 0);
            const mIncome = mOnline + mCash + mMatInc;
            const mExpenses = mIncExp + mMatExp + mOtherExp + mFixed + mActualSal;
            breakdown.push({ label: new Date(filterYear, m - 1).toLocaleString('default', { month: 'short' }) + ` ${filterYear}`, income: mIncome, incentives: mIncExp, material: mMatExp, others: mOtherExp, shopRent: (b.shop_rent || 0), roomRent: (b.room_rent || 0), elec: (b.shop_elec || 0) + (b.room_elec || 0), wifi: (b.wifi || 0), salary: mActualSal, leaves: mLeaves, pl: mIncome - mExpenses });
          }
        }

        sectionHeader(ws, row, `${filterMode === "month" ? "Daily" : "Monthly"} Performance Breakdown (${filterYear})`); row++;
        writeHeaderRow(ws, row, [filterMode === "month" ? "Date" : "Month", "Income", "Inc.", "Mat.", "Petrol", "Rent (S)", "Rent (R)", "Elec.", "WiFi", "Salary", "Leaves", "Net P&L"]); row++;
        breakdown.forEach(m => {
          writeDataRow(ws, row, [m.label, m.income, m.incentives, m.material, m.others, m.shopRent, m.roomRent, m.elec, m.wifi, m.salary, m.leaves, m.pl], [1, 2, 3, 4, 5, 6, 7, 8, 9, 11]);
          row++;
        });
        if (breakdown.length > 0) {
          const rr = ws.getRow(row);
          const totals = [`TOTAL (${periodText})`, breakdown.reduce((s, m) => s + m.income, 0), breakdown.reduce((s, m) => s + m.incentives, 0), breakdown.reduce((s, m) => s + m.material, 0), breakdown.reduce((s, m) => s + m.others, 0), breakdown.reduce((s, m) => s + m.shopRent, 0), breakdown.reduce((s, m) => s + m.roomRent, 0), breakdown.reduce((s, m) => s + m.elec, 0), breakdown.reduce((s, m) => s + m.wifi, 0), breakdown.reduce((s, m) => s + m.salary, 0), breakdown.reduce((s, m) => s + m.leaves, 0), breakdown.reduce((s, m) => s + m.pl, 0)];
          totals.forEach((v, i) => {
            const c = rr.getCell(i + 1);
            c.value = v;
            c.border = border;
            c.font = { bold: true };
            c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
            c.alignment = { horizontal: i === 0 ? "left" : "right" };
            if (i >= 1 && i <= 9) c.numFmt = moneyFmt;
            if (i === 11) c.numFmt = moneyFmt;
          });
          row++;
        }
        row++;

        // Recent Entries
        sectionHeader(ws, row, "Recent Entries"); row++;
        writeHeaderRow(ws, row, ["Date", "Online", "Cash", "GST", "Billing", "Incentive", "Staff T.Inc", "Staff T.Sale", "Cash in Hand"]); row++;
        periodEntries.slice(0, 50).forEach(e => {
          const totalBillingE = (e.staff_billing || []).reduce((s, sb) => s + (sb.billing || 0), 0);
          const totalMatE = (e.staff_billing || []).reduce((s, sb) => s + (sb.material || 0), 0);
          const totalIncE = (e.staff_billing || []).reduce((s, sb) => s + (sb.incentive || 0) + (sb.mat_incentive || 0), 0);
          const totalTipsE = (e.staff_billing || []).reduce((s, sb) => s + (sb.tips || 0), 0);
          const staffTIncE = (e.staff_billing || []).reduce((s, sb) => s + (sb.staff_total_inc || 0), 0);
          const staffTSaleE = totalBillingE + totalMatE + totalTipsE;
          const cih = e.cash_in_hand !== undefined ? e.cash_in_hand : (e.cash || 0) - totalIncE - totalTipsE - (e.others || 0);
          writeDataRow(ws, row, [e.date, e.online || 0, e.cash || 0, e.total_gst || 0, totalBillingE, totalIncE, staffTIncE, staffTSaleE, cih], [1, 2, 3, 4, 5, 6, 7, 8]);
          row++;
        });
        row++;

        // Per-staff log — monthly breakup only in Year mode; single-month summary in Month mode
        if (filterMode === "year") {
          sectionHeader(ws, row, `Staff Monthly Log (${filterYear})`, "FF0891B2"); row++;
          branchStaff.forEach(s => {
            sectionHeader(ws, row, `→ ${s.name} (${s.role || "—"})`, "FF475569"); row++;
            writeHeaderRow(ws, row, ["Month", "Status", "Days Worked", "Leaves", "Billing", "Incentives", "Salary Drawn"]); row++;
            let tLeaves = 0, tBilling = 0, tInc = 0, tSal = 0;
            for (let m = 1; m <= 12; m++) {
              if (!isPastYear && m > curM && filterYear === curY) break;
              const mPrefix = `${filterYear}-${String(m).padStart(2, '0')}`;
              const status = staffStatusForMonth(s, mPrefix);
              const mSal = proRataSalary(s, mPrefix, branches, salHistory, staff, globalSettings);
              const mLeaves = staffLeavesInMonth(s.id, mPrefix, leaves);
              const mEntries = entries.filter(e => e.branch_id === b.id && e.date.startsWith(mPrefix));
              let mBilling = 0, mInc = 0;
              mEntries.forEach(ent => {
                const sb = (ent.staff_billing || []).find(x => x.staff_id === s.id);
                if (sb) {
                  mBilling += (sb.billing || 0);
                  mInc += (sb.staff_total_inc || (sb.incentive || 0) + (sb.mat_incentive || 0) + (sb.tips || 0));
                }
              });
              tLeaves += mLeaves; tBilling += mBilling; tInc += mInc; tSal += mSal;
              writeDataRow(ws, row, [new Date(mPrefix + "-01").toLocaleString('default', { month: 'long' }), status.status, status.daysWorked, mLeaves, mBilling, mInc, mSal], [4, 5, 6]);
              row++;
            }
            const tr = ws.getRow(row);
            const totals = ["YEARLY TOTAL", "", "", tLeaves, tBilling, tInc, tSal];
            totals.forEach((v, i) => {
              const c = tr.getCell(i + 1);
              c.value = v;
              c.border = border;
              c.font = { bold: true };
              c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
              c.alignment = { horizontal: i === 0 ? "left" : "right" };
              if (i >= 4) c.numFmt = moneyFmt;
            });
            row += 2;
          });
        } else {
          // Month mode — single-month staff log for the selected month
          const monthLabel = new Date(filterPrefix + "-01").toLocaleString('default', { month: 'long', year: 'numeric' });
          sectionHeader(ws, row, `Staff Log — ${monthLabel}`, "FF0891B2"); row++;
          writeHeaderRow(ws, row, ["Name", "Role", "Status", "Days Worked", "Leaves", "Billing", "Incentives", "Salary Drawn"]); row++;
          branchStaff.forEach(s => {
            const status = staffStatusForMonth(s, filterPrefix);
            const mSal = proRataSalary(s, filterPrefix, branches, salHistory, staff, globalSettings);
            const mLeaves = staffLeavesInMonth(s.id, filterPrefix, leaves);
            const mEntries = entries.filter(e => e.branch_id === b.id && e.date.startsWith(filterPrefix));
            let mBilling = 0, mInc = 0;
            mEntries.forEach(ent => {
              const sb = (ent.staff_billing || []).find(x => x.staff_id === s.id);
              if (sb) {
                mBilling += (sb.billing || 0);
                mInc += (sb.staff_total_inc || (sb.incentive || 0) + (sb.mat_incentive || 0) + (sb.tips || 0));
              }
            });
            writeDataRow(ws, row, [s.name, s.role || "—", status.status, status.daysWorked, mLeaves, mBilling, mInc, mSal], [5, 6, 7]);
            row++;
          });
          row++;
        }

        ws.columns = [
          { width: 22 }, { width: 18 }, { width: 14 }, { width: 14 }, { width: 14 },
          { width: 14 }, { width: 14 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 14 }
        ];
        ws.views = [{ state: "frozen", ySplit: 1 }];
      });

      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const fileName = `V-Cut_Branch_Performance_${periodText}.xlsx`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast({ title: "Exported", message: `${fileName} downloaded.`, type: "success" });
    } catch (err) {
      console.error("Export error:", err);
      toast({ title: "Export Error", message: err.message || "Unknown error", type: "error" });
    } finally {
      setExporting(false);
    }
  };

  // ── ADMIN VIEW ──
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      {/* Admin Header */}
      {/* Top progress bar during refresh (listens to Refresh button in Command Bar) */}
      {refreshing && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, height: 3, background: "transparent", zIndex: 1200, overflow: "hidden" }}>
          <style>{`@keyframes refreshSlide { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }`}</style>
          <div style={{ height: "100%", width: "40%", background: "linear-gradient(90deg, transparent, var(--accent), var(--gold2), transparent)", animation: "refreshSlide 1.1s linear infinite" }} />
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 20, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: 28, fontWeight: 800, color: "var(--text)", letterSpacing: -0.5, margin: 0, fontFamily: "var(--font-headline, var(--font-outfit))" }}>Organizational Pulse</h2>
          <p style={{ fontSize: 13, color: "var(--text3)", fontWeight: 500, marginTop: 6 }}>System oversight and branch network analytics.</p>
        </div>
        <PeriodWidget filterMode={filterMode} setFilterMode={setFilterMode} filterYear={filterYear} setFilterYear={setFilterYear} filterMonth={filterMonth} setFilterMonth={setFilterMonth} />
      </div>

      {/* Admin Metrics — actuals row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <PremiumStatCard label="Gross Revenue" value={INR(tI)} sub="Total turnover" icon="trending" color="var(--green)" />
        <PremiumStatCard label="Operating Cost" value={INR(tE)} sub="Salary + Overheads" icon="wallet" color="var(--red)"
          onClick={() => router.push("/dashboard/branches?view=summary")} linkLabel="See expense breakdown" />
        <PremiumStatCard label="Net P&L" value={INR(net)} sub="Bottom line earnings" icon="pie" color={net >= 0 ? "var(--green)" : "var(--red)"} />
        <PremiumStatCard label="Service Force" value={staff.length} sub="Active stylists" icon="users" color="var(--accent)" />
        {/* Missing Entries — branch×day pairs with no entry from period start
            through yesterday. Today is excluded (accountant may still be entering). */}
        {(() => {
          const now = new Date();
          const yStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate() - 1).padStart(2, "0")}`;
          // Build period day list, identical to the branches page card.
          const ds = [];
          if (filterMode === "month") {
            const count = new Date(filterYear, filterMonth, 0).getDate();
            for (let d = 1; d <= count; d++) ds.push(`${filterPrefix}-${String(d).padStart(2, "0")}`);
          } else {
            for (let m = 1; m <= 12; m++) {
              const pref = `${filterYear}-${String(m).padStart(2, "0")}`;
              const count = new Date(filterYear, m, 0).getDate();
              for (let d = 1; d <= count; d++) ds.push(`${pref}-${String(d).padStart(2, "0")}`);
            }
          }
          const have = new Set(entries.filter(e => e.branch_id && e.date).map(e => `${e.branch_id}|${e.date}`));
          let missingCount = 0, daysWithGaps = 0;
          ds.forEach(d => {
            if (d > yStr) return;
            let dayGaps = 0;
            branches.forEach(b => { if (!have.has(`${b.id}|${d}`)) dayGaps += 1; });
            if (dayGaps > 0) { missingCount += dayGaps; daysWithGaps += 1; }
          });
          const complete = missingCount === 0;
          return (
            <PremiumStatCard
              label="Missing Entries"
              value={complete ? "None" : missingCount}
              sub={complete ? `Complete through ${yStr}` : `${daysWithGaps} day${daysWithGaps === 1 ? "" : "s"} with gaps`}
              icon="edit"
              color={complete ? "var(--green)" : "var(--red)"}
              onClick={() => router.push("/dashboard/branches?view=summary&tab=dailycash&expand=missing")}
              linkLabel="See which branches owe entries"
            />
          );
        })()}
      </div>

      {/* Month-end forecast row — projected cost + revenue gap to break even. */}
      {(() => {
        const projectedToEarn = Math.max(0, tEProjected - tI);
        const surplus = tI - tEProjected;
        // Days still outstanding between yesterday and month-end — drives the
        // "N days salary" breakout in Projected Cost's sub label.
        const nowD = new Date();
        const isCurMo = filterMode === "month" && filterYear === nowD.getFullYear() && filterMonth === nowD.getMonth() + 1;
        const daysInMonth = new Date(filterYear, filterMonth, 0).getDate();
        const daysRemaining = isCurMo ? Math.max(0, daysInMonth - (nowD.getDate() - 1)) : 0;
        const delta = tEProjected - tE;
        const projSub = delta > 0 && daysRemaining > 0
          ? `${INR(tE)} operating + ${daysRemaining}d salary ${INR(delta)}`
          : `Month-end forecast${delta > 0 ? ` · +${INR(delta)}` : ""}`;
        return (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
            <PremiumStatCard label="Projected Cost" value={INR(tEProjected)} sub={projSub} icon="trending" color="var(--orange)"
              onClick={() => setShowProjBreakdown(true)} linkLabel="See projected cost breakdown" />
            <PremiumStatCard
              label="Projected To Earn"
              value={projectedToEarn > 0 ? INR(projectedToEarn) : INR(0)}
              sub={projectedToEarn > 0
                ? `Revenue needed to break even at forecast`
                : `Target met · ${INR(surplus)} surplus`}
              icon="pie"
              color={projectedToEarn > 0 ? "var(--purple, #c084fc)" : "var(--green)"}
            />
          </div>
        );
      })()}

      {/* Persistent filter bar — stays visible across Mixed / Branch Only / Staff Only */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, padding: "14px 16px", background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, marginRight: 4 }}>View</div>
          <ToggleGroup options={[["all","Mixed"],["shop","Branch Only"],["staff","Staff Only"]]} value={dashView} onChange={setDashView} />
          <div style={{ width: 1, height: 22, background: "var(--border2)", margin: "0 4px" }} />
          <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, marginRight: 4 }}>Type</div>
          <ToggleGroup options={[["all","All"],["mens","Mens"],["unisex","Unisex"]]} value={brTypeFilter} onChange={setBrTypeFilter}
            colors={{ all: "var(--blue)", mens: "var(--accent)", unisex: "#c084fc" }} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {(dashView === "all" || dashView === "shop") && (
            <>
              <ToggleGroup options={[["all","All"],["profit","Profit"],["loss","Loss"]]} value={brFilter} onChange={setBrFilter}
                colors={{ all: "var(--blue)", profit: "var(--green)", loss: "var(--red)" }} />
              <ToggleGroup options={[["card","Grid"],["table","List"]]} value={brView} onChange={setBrView} />
            </>
          )}
          {isAdmin && (dashView === "all" || dashView === "shop") && (
            <button onClick={exportBranchPerformance} disabled={exporting} title="Export branch performance to Excel (one tab per branch)"
              style={{ padding: "6px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", cursor: exporting ? "wait" : "pointer", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: "var(--green)", textTransform: "uppercase", letterSpacing: 0.5, opacity: exporting ? 0.6 : 1 }}>
              <Icon name="save" size={13} /> {exporting ? "Exporting..." : "Export"}
            </button>
          )}
        </div>
      </div>

      {/* Daily business bar chart — month mode only */}
      {filterMode === "month" && (dashView === "all" || dashView === "shop") && (
        <DailyBusinessChart entries={entries} branches={branches} filterYear={filterYear} filterMonth={filterMonth} />
      )}

      {/* Monthly business bar chart — year mode only (12 bars instead of 365) */}
      {filterMode === "year" && (dashView === "all" || dashView === "shop") && (
        <MonthlyBusinessChart entries={entries} branches={branches} filterYear={filterYear} />
      )}

      {/* Daily material consumption bar chart — respects the global
          material-source toggles so it lines up with what P&L uses. */}
      {filterMode === "month" && (dashView === "all" || dashView === "shop") && (
        <DailyMaterialChart
          entries={entries}
          allocations={materialAllocations}
          branches={branches}
          filterYear={filterYear}
          filterMonth={filterMonth}
          useAllocations={matUseAllocations}
          useLumpsum={matUseLumpsum}
        />
      )}

      {/* Main Admin Grid */}
      <div style={{ display: "grid", gridTemplateColumns: dashView === "all" ? "1.6fr 1fr" : "1fr", gap: 24 }}>

        {/* Branch Section */}
        {(dashView === "all" || dashView === "shop") && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
               <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0, fontFamily: "var(--font-headline, var(--font-outfit))" }}>
                 Branch Performance
                 {brTypeFilter !== "all" && (
                   <span style={{ marginLeft: 10, fontSize: 11, fontWeight: 700, color: brTypeFilter === "mens" ? "var(--accent)" : "#c084fc", textTransform: "uppercase", letterSpacing: 1 }}>· {brTypeFilter}</span>
                 )}
               </h3>
               <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>{branchData.length} branch{branchData.length === 1 ? "" : "es"}</div>
            </div>

            {brView === "table" ? (
              <Card style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
                  <thead>
                    <tr>
                      <TH>Branch</TH>
                      <TH right>Income</TH>
                      <TH right>P&L</TH>
                      {isAdmin && <TH right>Salary</TH>}
                      <TH right>Inc/Mat</TH>
                      <TH right>Rent (S)</TH>
                      <TH right>Rent (R)</TH>
                      <TH right>Travel</TH>
                      <TH right>Elec/Wifi</TH>
                      <TH right>Leaves</TH>
                      <TH right>Staff</TH>
                    </tr>
                  </thead>
                  <tbody>
                    {branchData.map(d => {
                      const mono = { fontFamily: "var(--font-headline, var(--font-outfit))" };
                      return (
                        <tr key={d.b.id} onClick={() => router.push(`/dashboard/branches?branchId=${d.b.id}`)} style={{ cursor: "pointer", transition: "background 0.15s" }}
                          onMouseEnter={e => e.currentTarget.style.background = "var(--bg4)"}
                          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <TD style={{ fontWeight: 700 }}>{d.b.name.replace('V-CUT ', '')}</TD>
                          <TD right style={{ color: "var(--green)", fontWeight: 700, ...mono }}>{INR(d.i)}</TD>
                          <TD right style={{ color: d.n >= 0 ? "var(--green)" : "var(--red)", fontWeight: 700, ...mono }}>{INR(d.n)}</TD>
                          {isAdmin && <TD right style={{ color: "var(--blue)", fontWeight: 600, ...mono }}>{INR(d.actualSalary)}</TD>}
                          <TD right style={{ color: "var(--red)", fontWeight: 600, ...mono }}>{INR(d.vInc + d.vMatE)}</TD>
                          <TD right style={{ color: "var(--orange)", fontWeight: 600, ...mono }}>{INR(d.fShopRent)}</TD>
                          <TD right style={{ color: "var(--orange)", fontWeight: 600, ...mono }}>{INR(d.fRoomRent)}</TD>
                          <TD right style={{ color: "var(--red)", fontWeight: 600, ...mono }}>{INR(d.vOther)}</TD>
                          <TD right style={{ color: "var(--orange)", fontWeight: 600, ...mono }}>{INR(d.fElec + d.fWifi)}</TD>
                          <TD right style={{ color: "var(--text3)", fontWeight: 600 }}>{d.actualLeaves} d</TD>
                          <TD right style={{ color: "var(--text3)" }}>{d.staffCount}</TD>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </Card>
            ) : (
              <DraggableCardGrid branchData={branchData} isAdmin={isAdmin} isYearly={isYearly} factor={factor} cardOrder={cardOrder} setCardOrder={setCardOrder} dragId={dragId}
                onCardClick={(bid) => router.push(`/dashboard/branches?branchId=${bid}`)}
                onCalendarClick={(bid) => router.push(`/dashboard/branches?branchId=${bid}&calendar=1`)} />
            )}
          </div>
        )}

        {/* Staff Section */}
        {(dashView === "all" || dashView === "staff") && (
          <TopPerformersSection
            staffData={staffData}
            branchesById={branchesById}
            brTypeFilter={brTypeFilter}
            staffView={staffView}
            setStaffView={setStaffView}
            staffChartLimit={staffChartLimit}
            setStaffChartLimit={setStaffChartLimit}
            recon={recon}
          />
        )}
      </div>
      {ToastContainer}
      {/* Projected-cost breakdown modal — leads with Operating Cost as the summary row,
          then its components, then the forecast delta (remaining salary) on top. */}
      {showProjBreakdown && (() => {
        const totals = branchData.reduce((acc, d) => {
          acc.vInc += d.vInc;
          acc.vMatE += d.vMatE;
          acc.vOther += d.vOther;
          acc.fShopRent += d.fShopRent;
          acc.fRoomRent += d.fRoomRent;
          acc.fWifi += d.fWifi;
          acc.fElec += d.fElec;
          acc.projectedSalary += d.projectedSalary;
          acc.actualSalary += d.actualSalary;
          acc.totalGst += d.totalGst;
          return acc;
        }, { vInc: 0, vMatE: 0, vOther: 0, fShopRent: 0, fRoomRent: 0, fWifi: 0, fElec: 0, projectedSalary: 0, actualSalary: 0, totalGst: 0 });
        const remainingSalary = totals.projectedSalary - totals.actualSalary;
        const operatingCost = totals.vInc + totals.vMatE + totals.vOther
          + totals.fShopRent + totals.fRoomRent + totals.fWifi + totals.fElec
          + totals.actualSalary + totals.totalGst;
        const operatingSubRows = [
          { label: "Variable — Staff Incentives", value: totals.vInc, hint: "Sum of incentive + mat_incentive on every entry in the period", color: "var(--red)" },
          { label: "Variable — Material Cost", value: totals.vMatE, hint: "Per Master Setup → Material Expense Source (allocations / lumpsum / both)", color: "var(--red)" },
          { label: "Variable — Other / Petrol", value: totals.vOther, hint: "others + petrol lines on daily entries", color: "var(--red)" },
          { label: "Fixed — Shop Rent", value: totals.fShopRent, hint: "Charged for the full period regardless of working days", color: "var(--orange)" },
          { label: "Fixed — Room Rent", value: totals.fRoomRent, hint: "Full-period accrual", color: "var(--orange)" },
          { label: "Fixed — Electricity", value: totals.fElec, hint: "Shop + room electricity", color: "var(--orange)" },
          { label: "Fixed — WiFi", value: totals.fWifi, hint: "Full-period accrual", color: "var(--orange)" },
          { label: "Salary — Accrued (capped yesterday)", value: totals.actualSalary, hint: "Pro-rata salary × (days elapsed / days in month)", color: "var(--blue)" },
          { label: "GST Estimate", value: totals.totalGst, hint: "GST extracted from online revenue at the configured rate", color: "var(--red)" },
        ];
        const grand = operatingCost + remainingSalary;
        return (
          <div onClick={() => setShowProjBreakdown(false)}
            style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(6px)", zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
            <div onClick={ev => ev.stopPropagation()}
              style={{ width: "100%", maxWidth: 640, maxHeight: "90vh", overflowY: "auto", background: "var(--bg2)", borderRadius: 16, boxShadow: "0 24px 80px rgba(0,0,0,0.5)" }}>
              <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, position: "sticky", top: 0, background: "var(--bg2)", zIndex: 1 }}>
                <div>
                  <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Breakdown</div>
                  <div style={{ fontSize: 17, fontWeight: 800, color: "var(--orange)", marginTop: 2 }}>Projected Cost — {INR(grand)}</div>
                  <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4 }}>Network · {filterMode === "month" ? `${new Date(filterYear, filterMonth - 1).toLocaleString("default", { month: "long", year: "numeric" })}` : filterYear}</div>
                </div>
                <button onClick={() => setShowProjBreakdown(false)}
                  style={{ background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text2)", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontSize: 14, fontWeight: 700 }}>✕</button>
              </div>

              <div style={{ padding: "14px 22px 18px" }}>
                {/* Section 1 — Operating Cost summary + its components nested below */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.3)", borderRadius: 10, padding: "12px 14px", marginBottom: 4 }}>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Operating Cost</div>
                    <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>What&apos;s accrued so far (the Operating Cost card value)</div>
                  </div>
                  <span style={{ fontSize: 17, fontWeight: 800, color: "var(--red)", whiteSpace: "nowrap" }}>{INR(operatingCost)}</span>
                </div>
                <div style={{ padding: "0 6px", borderLeft: "2px solid var(--border2)", margin: "0 4px 14px" }}>
                  {operatingSubRows.map(r => (
                    <div key={r.label} style={{ padding: "10px 10px", borderBottom: "1px solid var(--border)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text2)" }}>{r.label}</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: r.color, whiteSpace: "nowrap" }}>{INR(r.value)}</span>
                      </div>
                      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>{r.hint}</div>
                    </div>
                  ))}
                </div>

                {/* Section 2 — Forecast addition on top of Operating Cost */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(192,132,252,0.08)", border: "1px solid rgba(192,132,252,0.3)", borderRadius: 10, padding: "12px 14px" }}>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Forecast addition</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginTop: 4 }}>Salary — Remaining till month-end</div>
                    <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>Full-month pro-rata minus what&apos;s accrued — the only delta from Operating Cost</div>
                  </div>
                  <span style={{ fontSize: 17, fontWeight: 800, color: "var(--purple, #c084fc)", whiteSpace: "nowrap" }}>+{INR(remainingSalary)}</span>
                </div>

                {/* Grand total */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, paddingTop: 12, borderTop: "2px solid var(--border2)" }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>TOTAL PROJECTED</span>
                  <span style={{ fontSize: 20, fontWeight: 800, color: "var(--orange)" }}>{INR(grand)}</span>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function KPICard({ label, value, color, sub }) {
  return (
    <div style={{ background: "var(--bg3)", borderRadius: 12, padding: 16, position: "relative", overflow: "hidden", border: "1px solid rgba(72,72,71,0.08)" }}>
      <div style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || "var(--text)", letterSpacing: "-.5px", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 6, fontWeight: 500 }}>{sub}</div>}
    </div>
  );
}

// ─── Draggable Branch Card Grid ───────────────────────────────────────────────
function DraggableCardGrid({ branchData, isAdmin, isYearly, factor, cardOrder, setCardOrder, dragId, onCardClick, onCalendarClick }) {
  const [dragOver, setDragOver] = useState(null);
  const [dragging, setDragging] = useState(null);
  const wasDragged = useRef(false);

  // Build ordered list using cardOrder (array of branch ids), fallback to branchData order
  const ordered = (() => {
    if (cardOrder.length === 0) return branchData;
    const map = Object.fromEntries(branchData.map(d => [d.b.id, d]));
    const ordered = cardOrder.map(id => map[id]).filter(Boolean);
    // Add any new branches not in cardOrder
    branchData.forEach(d => { if (!cardOrder.includes(d.b.id)) ordered.push(d); });
    return ordered;
  })();

  const handleDragStart = (e, bid) => {
    wasDragged.current = true;
    dragId.current = bid;
    setDragging(bid);
    // Required for Firefox
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", bid);
    }
  };

  const handleDragOver = (e, bid) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (dragId.current !== bid) setDragOver(bid);
  };

  const handleDrop = (e, targetId) => {
    e.preventDefault();
    const srcId = dragId.current;
    if (!srcId || srcId === targetId) { setDragOver(null); return; }
    const ids = ordered.map(d => d.b.id);
    const srcIdx = ids.indexOf(srcId);
    const tgtIdx = ids.indexOf(targetId);
    const newIds = [...ids];
    newIds.splice(srcIdx, 1);
    newIds.splice(tgtIdx, 0, srcId);
    setCardOrder(newIds);
    setDragOver(null);
  };

  const handleDragEnd = () => {
    dragId.current = null;
    setDragging(null);
    setDragOver(null);
    setTimeout(() => { wasDragged.current = false; }, 100);
  };

  const handleClick = (e, bid) => {
    if (wasDragged.current) {
      e.preventDefault();
      return;
    }
    onCardClick(bid);
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      {ordered.map(({ b, i, e, vInc, vMatE, vOther, fShopRent, fRoomRent, fWifi, fElec, actualSalary, actualLeaves, n, staffCount }) => {
        const hasData = i !== 0 || e !== 0;
        const isDragging = dragging === b.id;
        const isOver = dragOver === b.id;
        return (
          <div key={b.id}
            draggable="true"
            onDragStart={(ev) => handleDragStart(ev, b.id)}
            onDragOver={ev => handleDragOver(ev, b.id)}
            onDrop={ev => handleDrop(ev, b.id)}
            onDragEnd={handleDragEnd}
            onClick={(ev) => handleClick(ev, b.id)}
            style={{
              background: "var(--bg3)",
              borderRadius: 12,
              padding: 14,
              cursor: isDragging ? "grabbing" : "pointer",
              opacity: isDragging ? 0.4 : hasData ? 1 : 0.5,
              transition: "all .2s ease",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              transform: isOver ? "scale(1.02)" : "scale(1)",
              userSelect: "none",
              borderTop: isOver ? "1px solid rgba(var(--accent-rgb),0.3)" : "1px solid rgba(72,72,71,0.08)",
              borderRight: isOver ? "1px solid rgba(var(--accent-rgb),0.3)" : "1px solid rgba(72,72,71,0.08)",
              borderBottom: isOver ? "1px solid rgba(var(--accent-rgb),0.3)" : "1px solid rgba(72,72,71,0.08)",
              borderLeft: `3px solid ${n > 0 ? "var(--green)" : "var(--red)"}`,
              boxShadow: isOver ? "0 8px 24px rgba(var(--accent-rgb),0.25)" : n > 0 ? "0 0 18px rgba(74,222,128,.35)" : "0 0 18px rgba(248,113,113,.35)",
            }}
            onMouseEnter={ev => { if (!isDragging) ev.currentTarget.style.background = "var(--bg4)"; }}
            onMouseLeave={ev => { if (!isDragging && !isOver) ev.currentTarget.style.background = "var(--bg3)"; }}
          >
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-headline, var(--font-outfit))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</div>
                  <button onClick={ev => { ev.stopPropagation(); onCalendarClick?.(b.id); }}
                    title="Attendance calendar"
                    style={{ background: "rgba(var(--accent-rgb),0.1)", border: "1px solid rgba(var(--accent-rgb),0.35)", color: "var(--accent)", borderRadius: 6, padding: "2px 8px", cursor: "pointer", fontSize: 13, lineHeight: 1, flexShrink: 0 }}>📅</button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 9, fontWeight: 600, padding: "2px 7px", borderRadius: 6, textTransform: "uppercase", letterSpacing: ".5px",
                    background: b.type === "unisex" ? "rgba(168,85,247,0.06)" : "rgba(96,165,250,0.06)",
                    color: b.type === "unisex" ? "#a855f7" : "var(--blue)",
                  }}>{b.type === "unisex" ? "Unisex" : "Mens"}</span>
                  {staffCount > 0 && <span style={{ fontSize: 10, color: "var(--text3)", fontWeight: 500 }}>· {staffCount} staff</span>}
                </div>
              </div>
              <div style={{ color: "var(--text3)", fontSize: 10, opacity: 0.3, cursor: "grab", padding: "2px 4px" }}>⠿</div>
            </div>

            {/* Breakdown Grid */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 2, background: "var(--bg4)", borderRadius: 10, padding: "8px 6px" }}>
              <CompactStat label="Income" val={INR(i)} col="var(--green)" />
              <CompactStat label="P&L" val={isAdmin ? (INR(n)) : "•••"} col={n >= 0 ? "var(--green)" : "var(--red)"} bold />
              {isAdmin && <CompactStat label="Salary" val={INR(actualSalary)} col="var(--blue)" />}
              <CompactStat label="Inc/Mat" val={INR(vInc + vMatE)} col="var(--red)" />
              <CompactStat label="Rent (S)" val={INR(fShopRent)} col="var(--orange)" />
              <CompactStat label="Rent (R)" val={INR(fRoomRent)} col="var(--orange)" />
              <CompactStat label="Travel" val={INR(vOther)} col="var(--red)" />
              <CompactStat label="Elec/Wifi" val={INR(fElec + fWifi)} col="var(--orange)" />
              <CompactStat label="Leaves" val={actualLeaves + " d"} col="var(--text3)" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CompactStat({ label, val, col, bold }) {
  return (
    <div style={{ textAlign: "center", padding: "4px 2px" }}>
      <div style={{ fontSize: 8, color: "var(--text3)", textTransform: "uppercase", fontWeight: 600, marginBottom: 2, letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 11, fontWeight: bold ? 700 : 600, color: col, whiteSpace: "nowrap", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{val}</div>
    </div>
  );
}

// ─── Daily business bar chart — x: day-of-month, y: total business ────────

// ─── Top Performers: chart + table + KPI strip ────────────────────────────────
function TopPerformersSection({ staffData, branchesById, brTypeFilter, staffView, setStaffView, staffChartLimit, setStaffChartLimit, recon }) {
  const [showRecon, setShowRecon] = useState(false);
  const totalBilling = staffData.reduce((s, r) => s + (r.sale || 0), 0);
  const nonZero = staffData.filter(r => (r.sale || 0) > 0);
  const avg = nonZero.length ? Math.round(totalBilling / nonZero.length) : 0;
  const top = staffData[0];
  const topN = Math.min(staffChartLimit, staffData.length);
  const topNShare = totalBilling > 0 ? staffData.slice(0, topN).reduce((s, r) => s + r.sale, 0) / totalBilling : 0;
  const chartRows = staffData.slice(0, topN);
  const chartMax = Math.max(1, ...chartRows.map(r => r.sale || 0));

  // Rank badge color: gold / silver / bronze for 1/2/3, neutral after.
  const rankColor = (i) => i === 0 ? "var(--gold)" : i === 1 ? "#d4d4d8" : i === 2 ? "#c9884a" : "var(--text3)";
  const rankGlow = (i) => i === 0 ? "0 0 14px rgba(255,215,0,0.35)" : "none";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0, fontFamily: "var(--font-headline, var(--font-outfit))" }}>
          Top Performers
          {brTypeFilter !== "all" && (
            <span style={{ marginLeft: 10, fontSize: 11, fontWeight: 700, color: brTypeFilter === "mens" ? "var(--accent)" : "#c084fc", textTransform: "uppercase", letterSpacing: 1 }}>· {brTypeFilter}</span>
          )}
          <span style={{ marginLeft: 10, fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>{staffData.length} stylist{staffData.length === 1 ? "" : "s"}</span>
        </h3>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {staffView === "chart" && (
            <div style={{ display: "inline-flex", gap: 2, background: "var(--bg4)", padding: 3, borderRadius: 8, border: "1px solid var(--border)" }}>
              {[5, 10, 20, 30].map(n => (
                <button key={n} onClick={() => setStaffChartLimit(n)}
                  style={{ padding: "4px 12px", borderRadius: 6, fontSize: 10, fontWeight: 800, letterSpacing: 0.5, background: staffChartLimit === n ? "var(--accent)" : "transparent", color: staffChartLimit === n ? "#000" : "var(--text3)", border: "none", cursor: "pointer" }}>
                  Top {n}
                </button>
              ))}
            </div>
          )}
          <ToggleGroup options={[["chart", "Chart"], ["table", "Table"]]} value={staffView} onChange={setStaffView} />
        </div>
      </div>

      {/* KPI strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10 }}>
        <MiniKPI label="Total Billing" value={INR(totalBilling)} color="var(--green)" sub={`${nonZero.length} active · ${staffData.length - nonZero.length} idle`} />
        <MiniKPI label="Top Performer" value={top ? top.s.name : "—"} color="var(--gold)" sub={top ? INR(top.sale) : ""} />
        <MiniKPI label="Avg per Active Stylist" value={INR(avg)} color="var(--accent)" sub="Excludes zero-billing" />
        <MiniKPI label={`Top ${topN} Share`} value={`${Math.round(topNShare * 100)}%`} color="var(--blue, #60a5fa)" sub={`${INR(chartRows.reduce((s, r) => s + r.sale, 0))} of ${INR(totalBilling)}`} />
      </div>

      {/* Reconciliation banner — expands to an exact break-up of the
          Gross Revenue ⇄ Total Billing gap. */}
      {recon && recon.diff !== 0 && (
        <div style={{ borderRadius: 10, border: "1px dashed var(--border2)", background: "var(--bg3)" }}>
          <button onClick={() => setShowRecon(v => !v)}
            style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: "transparent", border: "none", color: "var(--text2)", cursor: "pointer", fontSize: 12, textAlign: "left" }}>
            <span>
              <span style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginRight: 8 }}>Gross Revenue ↔ Total Billing</span>
              <span style={{ color: "var(--green)", fontWeight: 700 }}>{INR(recon.gross)}</span>
              <span style={{ color: "var(--text3)", margin: "0 6px" }}>−</span>
              <span style={{ color: "var(--accent)", fontWeight: 700 }}>{INR(recon.attributed)}</span>
              <span style={{ color: "var(--text3)", margin: "0 6px" }}>=</span>
              <span style={{ color: recon.diff >= 0 ? "var(--orange)" : "var(--red)", fontWeight: 800 }}>{recon.diff >= 0 ? INR(recon.diff) : `-${INR(Math.abs(recon.diff))}`}</span>
            </span>
            <span style={{ fontSize: 10, color: "var(--accent)", fontWeight: 800, textTransform: "uppercase", letterSpacing: 1 }}>
              {showRecon ? "Hide ▲" : "Break down ▼"}
            </span>
          </button>
          {showRecon && (
            <div style={{ padding: "0 14px 14px", borderTop: "1px solid var(--border)" }}>
              <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
                <ReconRow label="Material sales" value={recon.material} hint="In Gross Revenue; excluded from stylist billing" color="#c084fc" />
                <ReconRow label="Unattributed service pay" value={recon.unattributed} hint="online + cash left over after summing every staff_billing[].billing row — tips, walk-ins without a staff split, rounding" color="var(--orange)" />
                <ReconRow label="Orphaned billing" value={recon.orphaned} hint="staff_billing rows whose staff_id no longer matches any staff record" color="var(--red)" />
                {recon.filteredOut > 0 && (
                  <ReconRow label={`Filtered out (${brTypeFilter})`} value={recon.filteredOut} hint="Real staff hidden by the Mens / Unisex filter" color="var(--text3)" />
                )}
              </div>
              <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 8, background: "var(--bg4)", fontSize: 11, color: "var(--text2)", lineHeight: 1.5 }}>
                <strong style={{ color: "var(--text)" }}>Check:&nbsp;</strong>
                Material {INR(recon.material)} + Unattributed {INR(recon.unattributed)} + Orphaned {INR(recon.orphaned)}
                {recon.filteredOut > 0 ? ` + Filtered ${INR(recon.filteredOut)}` : ""}
                {" = "}
                <strong style={{ color: "var(--orange)" }}>{INR(recon.material + recon.unattributed + recon.orphaned + recon.filteredOut)}</strong>
                {(recon.material + recon.unattributed + recon.orphaned + recon.filteredOut) === recon.diff
                  ? <span style={{ color: "var(--green)", fontWeight: 700 }}> ✓ matches the gap</span>
                  : <span style={{ color: "var(--red)", fontWeight: 700 }}> (residual {INR(recon.diff - (recon.material + recon.unattributed + recon.orphaned + recon.filteredOut))} = rounding on per-row totals)</span>
                }
              </div>
            </div>
          )}
        </div>
      )}

      {staffView === "chart" ? (
        <Card style={{ padding: 16 }}>
          {chartRows.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: "var(--text3)", fontSize: 13, fontStyle: "italic" }}>No billing recorded for the selected period.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {chartRows.map((row, i) => {
                const pct = chartMax > 0 ? (row.sale / chartMax) * 100 : 0;
                const shareOfTotal = totalBilling > 0 ? (row.sale / totalBilling) * 100 : 0;
                const b = branchesById.get(row.s.branch_id);
                const branchName = b ? b.name.replace("V-CUT ", "") : "";
                return (
                  <div key={row.s.id} style={{ display: "grid", gridTemplateColumns: "28px minmax(130px, 200px) 1fr auto", alignItems: "center", gap: 10 }}>
                    <div style={{
                      width: 26, height: 26, borderRadius: 8,
                      background: i < 3 ? `linear-gradient(135deg, rgba(255,215,0,0.15), rgba(255,215,0,0.02))` : "var(--bg4)",
                      border: `1px solid ${i < 3 ? "rgba(255,215,0,0.35)" : "var(--border)"}`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 11, fontWeight: 900, color: rankColor(i),
                      boxShadow: rankGlow(i),
                    }}>
                      {i + 1}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.s.name}</div>
                      {branchName && <div style={{ fontSize: 9.5, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{branchName}</div>}
                    </div>
                    <div style={{ position: "relative", height: 22, background: "rgba(255,255,255,0.025)", borderRadius: 6, overflow: "hidden" }}>
                      <div style={{
                        width: `${pct}%`, height: "100%",
                        background: i === 0
                          ? "linear-gradient(90deg, rgba(255,215,0,0.8), rgba(255,215,0,0.35))"
                          : i < 3
                            ? "linear-gradient(90deg, rgba(34,211,238,0.75), rgba(34,211,238,0.3))"
                            : "linear-gradient(90deg, rgba(34,211,238,0.5), rgba(34,211,238,0.18))",
                        borderRadius: 6,
                        transition: "width 0.4s ease",
                      }} />
                      <div style={{ position: "absolute", top: 0, bottom: 0, left: 8, display: "flex", alignItems: "center", fontSize: 10, color: "var(--text3)", fontWeight: 600, pointerEvents: "none" }}>
                        {shareOfTotal >= 1 ? `${shareOfTotal.toFixed(1)}%` : ""}
                      </div>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: i === 0 ? "var(--gold)" : "var(--accent)", fontFamily: "var(--font-headline, var(--font-outfit))", minWidth: 90, textAlign: "right" }}>
                      {INR(row.sale)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {staffData.length > topN && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--text3)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>+{staffData.length - topN} more stylists below the cut-off</span>
              <button onClick={() => setStaffView("table")} style={{ background: "transparent", border: "1px solid var(--border2)", color: "var(--accent)", padding: "5px 12px", borderRadius: 6, fontSize: 10, fontWeight: 800, letterSpacing: 0.5, cursor: "pointer", textTransform: "uppercase" }}>View full list →</button>
            </div>
          )}
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
            <thead>
              <tr><TH>#</TH><TH>Name</TH><TH>Branch</TH><TH right>Billing</TH><TH right>Share</TH></tr>
            </thead>
            <tbody>
              {staffData.map((row, i) => {
                const b = branchesById.get(row.s.branch_id);
                const shareOfTotal = totalBilling > 0 ? (row.sale / totalBilling) * 100 : 0;
                return (
                  <tr key={row.s.id} style={{ transition: "background 0.15s" }}
                    onMouseEnter={e => e.currentTarget.style.background = "var(--bg4)"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <TD style={{ color: rankColor(i), fontWeight: 800, fontSize: 12 }}>{i + 1}</TD>
                    <TD style={{ fontWeight: 600 }}>{row.s.name}</TD>
                    <TD style={{ color: "var(--text3)", fontSize: 11 }}>{b ? b.name.replace("V-CUT ", "") : "—"}</TD>
                    <TD right style={{ fontWeight: 700, color: "var(--accent)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(row.sale)}</TD>
                    <TD right style={{ color: "var(--text3)", fontSize: 11, fontWeight: 600 }}>{shareOfTotal > 0 ? `${shareOfTotal.toFixed(1)}%` : "—"}</TD>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function ReconRow({ label, value, hint, color }) {
  return (
    <div style={{ padding: "8px 10px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text2)" }}>{label}</span>
        <span style={{ fontSize: 13, fontWeight: 800, color: color || "var(--text)" }}>{INR(value || 0)}</span>
      </div>
      {hint && <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2, lineHeight: 1.4 }}>{hint}</div>}
    </div>
  );
}

function MiniKPI({ label, value, sub, color }) {
  return (
    <div style={{ padding: "12px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border)" }}>
      <div style={{ fontSize: 9, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.2 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color: color || "var(--text)", marginTop: 4, fontFamily: "var(--font-headline, var(--font-outfit))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ─── Daily Material Consumption chart ───────────────────────────────────────
// Source obeys the global settings: `mat_use_allocations` (default on) pulls
// from the material_allocations collection; `mat_use_lumpsum` pulls from
// entry.mat_expense (the lumpsum number typed into Daily Entry). If both are
// on, the stack shows them as two colours so the mix is visible.
function DailyMaterialChart({ entries, allocations, branches = [], filterYear, filterMonth, useAllocations, useLumpsum }) {
  const [hover, setHover] = useState(null);
  const prefix = `${filterYear}-${String(filterMonth).padStart(2, "0")}`;
  const daysInMonth = new Date(filterYear, filterMonth, 0).getDate();
  const NOW = new Date();
  const todayStr = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, "0")}-${String(NOW.getDate()).padStart(2, "0")}`;

  const byDayAlloc = new Array(daysInMonth).fill(0);
  const byDayLump = new Array(daysInMonth).fill(0);
  // Branch-level rollups so we can show "who consumed the most".
  const byBranch = new Map(); // id -> { name, alloc, lump, total }
  // Per-day per-branch breakdown — feeds the hover tooltip so the user can
  // see which branches drove the spike on a given day.
  // dayBreakdown[dIdx] = Map<branchId, { name, alloc, lump, total }>
  const dayBreakdown = Array.from({ length: daysInMonth }, () => new Map());

  const bumpBranch = (id, key, amt) => {
    const row = byBranch.get(id) || { name: branches.find(b => b.id === id)?.name || "—", alloc: 0, lump: 0, total: 0 };
    row[key] += amt;
    row.total += amt;
    byBranch.set(id, row);
  };
  const bumpDayBranch = (dIdx, id, key, amt) => {
    const dayMap = dayBreakdown[dIdx];
    const row = dayMap.get(id) || { name: branches.find(b => b.id === id)?.name || "—", alloc: 0, lump: 0, total: 0 };
    row[key] += amt;
    row.total += amt;
    dayMap.set(id, row);
  };

  if (useAllocations) {
    allocations.forEach(a => {
      const date = a.date || (a.transferred_at || "").slice(0, 10);
      if (!date || !date.startsWith(prefix)) return;
      const dIdx = Number(date.slice(8, 10)) - 1;
      if (dIdx < 0 || dIdx >= daysInMonth) return;
      const total = Number(a.total) || (a.items || []).reduce((s, it) => s + (Number(it.line_total) || (Number(it.qty) * Number(it.price_at_transfer)) || 0), 0);
      byDayAlloc[dIdx] += total;
      if (a.branch_id) {
        bumpBranch(a.branch_id, "alloc", total);
        bumpDayBranch(dIdx, a.branch_id, "alloc", total);
      }
    });
  }
  if (useLumpsum) {
    entries.forEach(e => {
      if (!e.date || !e.date.startsWith(prefix)) return;
      const dIdx = Number(e.date.slice(8, 10)) - 1;
      if (dIdx < 0 || dIdx >= daysInMonth) return;
      const amt = Number(e.mat_expense) || 0;
      if (amt <= 0) return;
      byDayLump[dIdx] += amt;
      if (e.branch_id) {
        bumpBranch(e.branch_id, "lump", amt);
        bumpDayBranch(dIdx, e.branch_id, "lump", amt);
      }
    });
  }
  // Ensure every branch shows up — even ones with zero consumption.
  // Heaviest first; zero-spend branches sort to the bottom alphabetically.
  branches.forEach(b => {
    if (!byBranch.has(b.id)) byBranch.set(b.id, { name: b.name, alloc: 0, lump: 0, total: 0 });
  });
  const branchRows = Array.from(byBranch.values())
    .sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name));

  const byDay = byDayAlloc.map((v, i) => v + byDayLump[i]);
  const max = Math.max(1, ...byDay);
  const total = byDay.reduce((s, v) => s + v, 0);
  const totalAlloc = byDayAlloc.reduce((s, v) => s + v, 0);
  const totalLump = byDayLump.reduce((s, v) => s + v, 0);
  const workingDays = byDay.filter(v => v > 0).length;
  const avg = workingDays ? Math.round(total / workingDays) : 0;
  const bestIdx = byDay.indexOf(Math.max(...byDay));
  const monthLabel = new Date(filterYear, filterMonth - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });

  // Chart dims — mirror the Daily Business chart for visual rhythm.
  const H = 200;
  const BAR_W = 22;
  const GAP = 10;
  const LEFT = 52;
  const PAD_TOP = 22;
  const PAD_BOTTOM = 38;
  const W = LEFT + daysInMonth * (BAR_W + GAP) + 8;
  const yTicks = 4;
  const BAR_R = 6;

  const dayOfWeek = (d) => new Date(filterYear, filterMonth - 1, d).toLocaleDateString("en-US", { weekday: "short" });

  const sourceLabel = useAllocations && useLumpsum
    ? "Allocations + Daily Entry (lumpsum)"
    : useAllocations
      ? "Allocations"
      : useLumpsum
        ? "Daily Entry (lumpsum)"
        : "No source enabled";

  // Neither source on? Render a clean disabled state.
  if (!useAllocations && !useLumpsum) {
    return (
      <Card style={{ padding: 18, marginBottom: 24, overflow: "visible" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 6 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, color: "#d7a6ff", textTransform: "uppercase", letterSpacing: 2 }}>Material Consumption</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "var(--gold)", fontFamily: "var(--font-headline, var(--font-outfit))", marginTop: 2 }}>{monthLabel}</div>
          </div>
        </div>
        <div style={{ padding: 30, textAlign: "center", color: "var(--text3)", fontSize: 13, fontStyle: "italic" }}>
          Both material sources are disabled in Master Setup. Turn on <strong>Allocations</strong> or <strong>Daily Entry (lumpsum)</strong> to populate this chart.
        </div>
      </Card>
    );
  }

  return (
    <Card style={{ padding: 18, marginBottom: 24, overflow: "visible" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: "#d7a6ff", textTransform: "uppercase", letterSpacing: 2 }}>Material Consumption</span>
            <span title={`Pulled from: ${sourceLabel}`} style={{ fontSize: 9, fontWeight: 800, padding: "2px 8px", borderRadius: 10, background: "rgba(192,132,252,0.12)", color: "#d7a6ff", border: "1px solid rgba(192,132,252,0.35)", textTransform: "uppercase", letterSpacing: 0.8 }}>
              {sourceLabel}
            </span>
          </div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "var(--gold)", fontFamily: "var(--font-headline, var(--font-outfit))", marginTop: 4 }}>{monthLabel}</div>
        </div>
        <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>Total</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#d7a6ff" }}>{INR(total)}</div>
          </div>
          {useAllocations && useLumpsum && (
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>Alloc · Lumpsum</div>
              <div style={{ fontSize: 13, fontWeight: 800 }}>
                <span style={{ color: "#d7a6ff" }}>{INR(totalAlloc)}</span>
                <span style={{ color: "var(--text3)", margin: "0 4px" }}>·</span>
                <span style={{ color: "var(--accent)" }}>{INR(totalLump)}</span>
              </div>
            </div>
          )}
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>Daily Avg</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "var(--blue)" }}>{INR(avg)}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>Heaviest Day</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "var(--orange)" }}>{byDay[bestIdx] > 0 ? `${bestIdx + 1} · ${INR(byDay[bestIdx])}` : "—"}</div>
          </div>
        </div>
      </div>

      {total === 0 ? (
        <div style={{ height: H, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text3)", fontStyle: "italic", fontSize: 13 }}>
          No material consumption recorded for {monthLabel} yet.
        </div>
      ) : (
        <div style={{ position: "relative", overflowX: "auto" }}>
          <svg width={W} height={H + PAD_TOP + PAD_BOTTOM} style={{ display: "block" }}>
            <defs>
              <linearGradient id="mat-purple" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#e0b3ff" />
                <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.8" />
              </linearGradient>
              <linearGradient id="mat-teal" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#5de8ff" />
                <stop offset="100%" stopColor="#0891a8" stopOpacity="0.8" />
              </linearGradient>
              <linearGradient id="mat-sheen" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(255,255,255,0.22)" />
                <stop offset="60%" stopColor="rgba(255,255,255,0)" />
              </linearGradient>
            </defs>

            {/* Y gridlines */}
            {Array.from({ length: yTicks + 1 }, (_, i) => {
              const frac = i / yTicks;
              const y = PAD_TOP + (1 - frac) * H;
              const v = Math.round(max * frac);
              const isBaseline = i === 0;
              return (
                <g key={i}>
                  <line x1={LEFT} y1={y} x2={W - 4} y2={y}
                    stroke={isBaseline ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.04)"}
                    strokeDasharray={isBaseline ? undefined : "2 4"}
                    strokeWidth={1} />
                  {!isBaseline && (
                    <text x={LEFT - 8} y={y + 3} fontSize={9} fill="var(--text3)" textAnchor="end" fontWeight={600}>
                      {v >= 1000 ? `${Math.round(v / 1000)}k` : v}
                    </text>
                  )}
                </g>
              );
            })}

            {byDay.map((v, i) => {
              const x = LEFT + i * (BAR_W + GAP);
              const hasValue = v > 0;
              const totalH = hasValue ? Math.max(2, (v / max) * H) : 2;
              const allocH = hasValue ? (byDayAlloc[i] / max) * H : 0;
              const lumpH = Math.max(0, totalH - allocH);
              const yTop = PAD_TOP + H - totalH;
              const yLump = PAD_TOP + H - lumpH;
              const baselineY = PAD_TOP + H;
              const dateStr = `${prefix}-${String(i + 1).padStart(2, "0")}`;
              const isToday = dateStr === todayStr;
              const isHovered = hover && hover.i === i;
              const isBest = i === bestIdx && hasValue;
              const dow = dayOfWeek(i + 1);
              const isWeekend = dow === "Sat" || dow === "Sun";
              const clipId = `mat-clip-${filterYear}-${filterMonth}-${i}`;
              const dim = hover && hover.i !== i ? 0.35 : 1;
              return (
                <g key={i}
                  onMouseEnter={() => hasValue && setHover({
                    i, v, alloc: byDayAlloc[i], lump: byDayLump[i], dateStr,
                    dayBranches: Array.from(dayBreakdown[i].values()).sort((a, b) => b.total - a.total),
                  })}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: hasValue ? "pointer" : "default", transition: "opacity .15s" }}
                  opacity={dim}>
                  <defs>
                    <clipPath id={clipId}>
                      <path d={`M${x},${yTop + BAR_R}
                                Q${x},${yTop} ${x + BAR_R},${yTop}
                                H${x + BAR_W - BAR_R}
                                Q${x + BAR_W},${yTop} ${x + BAR_W},${yTop + BAR_R}
                                V${baselineY}
                                H${x}
                                Z`} />
                    </clipPath>
                  </defs>
                  {hasValue ? (
                    <g clipPath={`url(#${clipId})`}>
                      {allocH > 0 && (
                        <rect x={x} y={PAD_TOP + H - allocH} width={BAR_W} height={allocH} fill="url(#mat-purple)" />
                      )}
                      {lumpH > 0 && (
                        <rect x={x} y={yTop} width={BAR_W} height={lumpH} fill="url(#mat-teal)" />
                      )}
                      {allocH > 0 && lumpH > 0 && (
                        <rect x={x} y={yLump - 0.5} width={BAR_W} height={1} fill="rgba(255,255,255,0.18)" />
                      )}
                      <rect x={x} y={yTop} width={BAR_W} height={Math.min(totalH * 0.35, 20)} fill="url(#mat-sheen)" />
                    </g>
                  ) : (
                    <rect x={x} y={baselineY - 2} width={BAR_W} height={2} rx={1} fill="rgba(255,255,255,0.06)" />
                  )}
                  {isToday && hasValue && (
                    <rect x={x - 1.5} y={yTop - 1.5} width={BAR_W + 3} height={totalH + 3} rx={BAR_R + 1.5} ry={BAR_R + 1.5}
                      fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="3 3" opacity={0.75} />
                  )}
                  {(isBest || isHovered) && hasValue && (
                    (() => {
                      const label = v >= 100000 ? `₹${(v / 100000).toFixed(1)}L` : v >= 1000 ? `₹${Math.round(v / 1000)}k` : `₹${v}`;
                      const chipW = label.length * 6 + 10;
                      const chipX = x + BAR_W / 2 - chipW / 2;
                      const chipY = Math.max(2, yTop - 16);
                      const chipColor = isHovered && !isBest ? "var(--accent)" : "#d7a6ff";
                      return (
                        <g>
                          <rect x={chipX} y={chipY} width={chipW} height={14} rx={7}
                            fill="var(--bg4)" stroke={chipColor} strokeWidth={1} opacity={0.95} />
                          <text x={x + BAR_W / 2} y={chipY + 10} fontSize={9} fontWeight={800}
                            fill={chipColor} textAnchor="middle">{label}</text>
                        </g>
                      );
                    })()
                  )}
                  <text x={x + BAR_W / 2} y={baselineY + 14} fontSize={9.5}
                    fill={isBest ? "#d7a6ff" : isToday ? "var(--accent)" : isWeekend ? "var(--orange)" : "var(--text3)"}
                    textAnchor="middle" fontWeight={(isBest || isToday || isWeekend) ? 800 : 600}>{i + 1}</text>
                  <text x={x + BAR_W / 2} y={baselineY + 26} fontSize={8}
                    fill={isWeekend ? "var(--orange)" : "var(--text3)"}
                    textAnchor="middle" opacity={isWeekend ? 0.85 : 0.5}
                    fontWeight={isWeekend ? 700 : 500}>
                    {dow.slice(0, 1)}
                  </text>
                </g>
              );
            })}
          </svg>

          {hover && (
            <div style={{
              position: "absolute",
              left: Math.min(LEFT + hover.i * (BAR_W + GAP) + BAR_W + 10, W - 240),
              top: 4, pointerEvents: "none",
              background: "var(--bg4)", border: "1px solid rgba(192,132,252,0.35)", borderRadius: 8,
              padding: "8px 12px", boxShadow: "0 6px 20px rgba(0,0,0,0.5)", fontSize: 11, zIndex: 3, minWidth: 220, maxWidth: 260,
            }}>
              <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>{hover.dateStr} · {dayOfWeek(hover.i + 1)}</div>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#d7a6ff", marginTop: 2 }}>{INR(hover.v)}</div>
              {useAllocations && useLumpsum && (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 10, marginTop: 4 }}>
                    <span style={{ color: "#d7a6ff", fontWeight: 700 }}>Allocations</span>
                    <span style={{ color: "#d7a6ff" }}>{INR(hover.alloc || 0)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 10 }}>
                    <span style={{ color: "var(--accent)", fontWeight: 700 }}>Daily Entry</span>
                    <span style={{ color: "var(--accent)" }}>{INR(hover.lump || 0)}</span>
                  </div>
                </>
              )}
              {hover.dayBranches && hover.dayBranches.length > 0 && (
                <div style={{ marginTop: 8, paddingTop: 6, borderTop: "1px dashed rgba(255,255,255,0.08)" }}>
                  <div style={{ fontSize: 8.5, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.2, fontWeight: 800, marginBottom: 4 }}>
                    Branches ({hover.dayBranches.length})
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 200, overflowY: "auto" }}>
                    {hover.dayBranches.slice(0, 12).map((br, idx) => (
                      <div key={idx} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 10 }}>
                        <span style={{ color: "var(--text2)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{br.name.replace("V-CUT ", "")}</span>
                        <span style={{ color: "var(--text)", fontWeight: 700, whiteSpace: "nowrap" }}>{INR(br.total)}</span>
                      </div>
                    ))}
                    {hover.dayBranches.length > 12 && (
                      <div style={{ fontSize: 9, color: "var(--text3)", fontStyle: "italic", marginTop: 2 }}>
                        +{hover.dayBranches.length - 12} more
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Per-branch consumption leaderboard — shows who burned the most
          material in this window, using the same source(s) as the chart. */}
      {branchRows.length > 0 && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: "#d7a6ff", textTransform: "uppercase", letterSpacing: 1.4 }}>
              Branch consumption · {monthLabel}
            </span>
            <span style={{ fontSize: 10, color: "var(--text3)", fontWeight: 600 }}>
              {branchRows.length} branch{branchRows.length === 1 ? "" : "es"} · heaviest first
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {branchRows.map((r, i) => {
              const topTotal = branchRows[0].total;
              const pct = topTotal > 0 ? (r.total / topTotal) * 100 : 0;
              const shareOfTotal = total > 0 ? (r.total / total) * 100 : 0;
              const name = r.name.replace("V-CUT ", "");
              const isZero = r.total <= 0;
              const rankColor = isZero ? "var(--text3)" : i === 0 ? "#d7a6ff" : i === 1 ? "var(--accent)" : i === 2 ? "#ffb877" : "var(--text2)";
              // The "X% of total" chip lives outside the bar so it's always readable,
              // regardless of how short the filled portion is. Right-floats when the bar
              // is long enough to host it inline without collisions.
              const pctLabel = shareOfTotal >= 0.05 ? `${shareOfTotal.toFixed(1)}%` : isZero ? "" : "<0.1%";
              return (
                <div key={r.name + i} style={{ display: "grid", gridTemplateColumns: "22px minmax(120px, 170px) 1fr 48px auto", alignItems: "center", gap: 10, opacity: isZero ? 0.55 : 1 }}>
                  <div style={{ width: 20, height: 20, borderRadius: 6, background: isZero ? "var(--bg4)" : i < 3 ? "rgba(192,132,252,0.12)" : "var(--bg4)", border: `1px solid ${isZero ? "var(--border)" : i < 3 ? "rgba(192,132,252,0.35)" : "var(--border)"}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 900, color: rankColor }}>
                    {i + 1}
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: isZero ? "var(--text3)" : "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.name}>
                    {name}
                  </div>
                  <div style={{ position: "relative", height: 18, background: "rgba(255,255,255,0.03)", border: isZero ? "1px dashed var(--border)" : "1px solid transparent", borderRadius: 5, overflow: "hidden", display: "flex" }}>
                    {useAllocations && r.alloc > 0 && (
                      <div style={{ width: `${pct * (r.alloc / r.total)}%`, height: "100%", background: "linear-gradient(90deg, rgba(215,166,255,0.9), rgba(139,92,246,0.55))" }} />
                    )}
                    {useLumpsum && r.lump > 0 && (
                      <div style={{ width: `${pct * (r.lump / r.total)}%`, height: "100%", background: "linear-gradient(90deg, rgba(93,232,255,0.8), rgba(8,145,168,0.45))" }} />
                    )}
                  </div>
                  <div style={{ fontSize: 10.5, color: isZero ? "var(--text3)" : "var(--text2)", fontWeight: 700, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {pctLabel || (isZero ? "—" : "")}
                  </div>
                  <div style={{ fontSize: 12.5, fontWeight: 800, color: rankColor, fontFamily: "var(--font-headline, var(--font-outfit))", minWidth: 80, textAlign: "right" }}>
                    {isZero ? "—" : INR(r.total)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}

function DailyBusinessChart({ entries, branches = [], filterYear, filterMonth }) {
  const [hover, setHover] = useState(null);
  const [showAvg, setShowAvg] = useState(false);
  const prefix = `${filterYear}-${String(filterMonth).padStart(2, "0")}`;
  const daysInMonth = new Date(filterYear, filterMonth, 0).getDate();
  const NOW = new Date();
  const todayStr = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, "0")}-${String(NOW.getDate()).padStart(2, "0")}`;

  // Split cash vs non-cash so the stacked bar shows the mix at a glance.
  // Non-cash bucket = online + material sale (the "digital + upsell" portion).
  // Per-branch per-day sale is tracked too so the hover tooltip can show
  // which branch contributed what — the user's primary verification signal.
  const byDay = new Array(daysInMonth).fill(0);
  const byDayCash = new Array(daysInMonth).fill(0);
  const byDayNonCash = new Array(daysInMonth).fill(0);
  const byDayOnline = new Array(daysInMonth).fill(0);
  const byDayMat = new Array(daysInMonth).fill(0);
  // `${branchId}|${dIdx}` → sale on that day for that branch (online + cash + mat)
  const byDayBranch = new Map();
  entries.forEach(e => {
    if (!e.date || !e.date.startsWith(prefix)) return;
    const dIdx = Number(e.date.slice(8, 10)) - 1;
    if (dIdx < 0 || dIdx >= daysInMonth) return;
    const matSale = (e.staff_billing || []).reduce((s, sb) => s + (sb.material || 0), 0);
    const sale = (e.online || 0) + (e.cash || 0) + matSale;
    byDayCash[dIdx] += (e.cash || 0);
    byDayOnline[dIdx] += (e.online || 0);
    byDayMat[dIdx] += matSale;
    byDayNonCash[dIdx] += (e.online || 0) + matSale;
    byDay[dIdx] += sale;
    if (e.branch_id) {
      const k = `${e.branch_id}|${dIdx}`;
      byDayBranch.set(k, (byDayBranch.get(k) || 0) + sale);
    }
  });

  const max = Math.max(1, ...byDay);
  const totalBusiness = byDay.reduce((s, v) => s + v, 0);
  const totalCash = byDayCash.reduce((s, v) => s + v, 0);
  const totalNonCash = byDayNonCash.reduce((s, v) => s + v, 0);
  const workingDays = byDay.filter(v => v > 0).length;
  const avg = workingDays ? Math.round(totalBusiness / workingDays) : 0;
  const bestIdx = byDay.indexOf(Math.max(...byDay));
  const monthLabel = new Date(filterYear, filterMonth - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });

  // Chart dims — a touch more air between bars + softer baseline.
  const H = 230;               // plot height
  const BAR_W = 22;
  const GAP = 10;
  const LEFT = 52;             // y-axis label gutter
  const PAD_TOP = 22;          // reserves headroom for "best day" value chip
  const PAD_BOTTOM = 38;       // space for day + weekday labels
  const W = LEFT + daysInMonth * (BAR_W + GAP) + 8;
  const yTicks = 4;
  const BAR_R = 6;             // top-corner radius of each bar

  const dayOfWeek = (d) => {
    const dt = new Date(filterYear, filterMonth - 1, d);
    return dt.toLocaleDateString("en-US", { weekday: "short" });
  };

  return (
    <Card style={{ padding: 18, marginBottom: 24, overflow: "visible" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 2 }}>Daily Business</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "var(--gold)", fontFamily: "var(--font-headline, var(--font-outfit))", marginTop: 2 }}>{monthLabel}</div>
        </div>
        <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>Total</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "var(--green)" }}>{INR(totalBusiness)}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>Cash / Online+Mat</div>
            <div style={{ fontSize: 13, fontWeight: 800 }}>
              <span style={{ color: "#c084fc" }}>{INR(totalCash)}</span>
              <span style={{ color: "var(--text3)", margin: "0 4px" }}>·</span>
              <span style={{ color: "var(--blue)" }}>{INR(totalNonCash)}</span>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>Daily Avg</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "var(--blue)" }}>{INR(avg)}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>Best Day</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "var(--green)" }}>{byDay[bestIdx] > 0 ? `${bestIdx + 1} · ${INR(byDay[bestIdx])}` : "—"}</div>
          </div>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "6px 10px", background: showAvg ? "rgba(96,165,250,0.12)" : "var(--bg3)", border: `1px solid ${showAvg ? "rgba(96,165,250,0.4)" : "var(--border)"}`, borderRadius: 8, fontSize: 10, fontWeight: 700, color: showAvg ? "var(--blue)" : "var(--text3)", textTransform: "uppercase", letterSpacing: 1, userSelect: "none" }}>
            <input type="checkbox" checked={showAvg} onChange={e => setShowAvg(e.target.checked)} style={{ accentColor: "var(--blue, #60a5fa)", cursor: "pointer" }} />
            Avg line
          </label>
        </div>
      </div>

      {totalBusiness === 0 ? (
        <div style={{ height: H, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text3)", fontStyle: "italic", fontSize: 13 }}>No business entries recorded for {monthLabel} yet.</div>
      ) : (
        // Outer wrapper is position:relative with visible overflow so a long
        // hover card (up to ~500px tall with 15 branches) doesn't get clipped.
        // SVG sits in its own scroll container so wide charts still scroll X.
        <div style={{ position: "relative" }}>
          <div style={{ overflowX: "auto" }}>
          <svg width={W} height={H + PAD_TOP + PAD_BOTTOM} style={{ display: "block" }}>
            <defs>
              {/* Palette — softer gradients with more restrained contrast. */}
              <linearGradient id="bar-blue" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#38d9f2" />
                <stop offset="100%" stopColor="#0891a8" stopOpacity="0.75" />
              </linearGradient>
              <linearGradient id="bar-accent" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#5de8ff" />
                <stop offset="100%" stopColor="#12a5bf" stopOpacity="0.85" />
              </linearGradient>
              <linearGradient id="bar-green" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#7df094" />
                <stop offset="100%" stopColor="#22a354" stopOpacity="0.85" />
              </linearGradient>
              <linearGradient id="bar-orange" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ffb877" />
                <stop offset="100%" stopColor="#d97a2c" stopOpacity="0.8" />
              </linearGradient>
              <linearGradient id="bar-purple" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#d7a6ff" stopOpacity="0.95" />
                <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.8" />
              </linearGradient>
              {/* Subtle highlight sheen overlayed at the top of each bar for a "lit" look. */}
              <linearGradient id="bar-sheen" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(255,255,255,0.22)" />
                <stop offset="60%" stopColor="rgba(255,255,255,0)" />
              </linearGradient>
              <filter id="best-glow" x="-40%" y="-40%" width="180%" height="180%">
                <feGaussianBlur stdDeviation="4" />
              </filter>
            </defs>

            {/* Y-axis gridlines + labels */}
            {Array.from({ length: yTicks + 1 }, (_, i) => {
              const frac = i / yTicks;
              const y = PAD_TOP + (1 - frac) * H;
              const v = Math.round(max * frac);
              const isBaseline = i === 0;
              return (
                <g key={i}>
                  <line x1={LEFT} y1={y} x2={W - 4} y2={y}
                    stroke={isBaseline ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.04)"}
                    strokeDasharray={isBaseline ? undefined : "2 4"}
                    strokeWidth={isBaseline ? 1 : 1} />
                  {!isBaseline && (
                    <text x={LEFT - 8} y={y + 3} fontSize={9} fill="var(--text3)" textAnchor="end" fontWeight={600}>
                      {v >= 1000 ? `${Math.round(v / 1000)}k` : v}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Bars — one <g> per day. Unified rounded-top shape via clipPath so
                cash + non-cash read as a single pill with a clean internal seam. */}
            {byDay.map((v, i) => {
              const x = LEFT + i * (BAR_W + GAP);
              const hasValue = v > 0;
              const totalH = hasValue ? Math.max(2, (v / max) * H) : 2;
              const cashH = hasValue ? (byDayCash[i] / max) * H : 0;
              const topH = Math.max(0, totalH - cashH);
              const yTop = PAD_TOP + H - totalH;
              const yCash = PAD_TOP + H - cashH;
              const baselineY = PAD_TOP + H;
              const dateStr = `${prefix}-${String(i + 1).padStart(2, "0")}`;
              const isToday = dateStr === todayStr;
              const isBest = i === bestIdx && hasValue;
              const dow = dayOfWeek(i + 1);
              const isWeekend = dow === "Sat" || dow === "Sun";
              const isHovered = hover && hover.i === i;
              const topFill = isBest
                ? "url(#bar-green)"
                : isToday
                  ? "url(#bar-accent)"
                  : isWeekend
                    ? "url(#bar-orange)"
                    : "url(#bar-blue)";
              const dim = hover && hover.i !== i ? 0.35 : 1;
              const dayLabelColor = isBest ? "var(--green)" : isToday ? "var(--accent)" : isWeekend ? "var(--orange)" : "var(--text3)";
              const dayWeight = (isBest || isToday || isWeekend) ? 800 : 600;
              const clipId = `bar-clip-${filterYear}-${filterMonth}-${i}`;
              return (
                <g key={i}
                  onMouseEnter={() => hasValue && setHover({
                    i, v, cash: byDayCash[i], online: byDayOnline[i], mat: byDayMat[i], nonCash: byDayNonCash[i], dateStr,
                    // Per-branch split for this day, highest first. Every branch
                    // the chain knows about appears — zero-sale ones are dimmed
                    // so gaps are obvious during verification.
                    byBranch: branches
                      .map(b => ({ id: b.id, name: (b.name || "").replace("V-CUT ", ""), v: byDayBranch.get(`${b.id}|${i}`) || 0 }))
                      .sort((a, b) => b.v - a.v),
                  })}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: hasValue ? "pointer" : "default", transition: "opacity .15s" }}
                  opacity={dim}>
                  {/* Subtle weekend column tint to telegraph the rhythm of the month. */}
                  {isWeekend && hasValue && (
                    <rect x={x - 2} y={PAD_TOP} width={BAR_W + 4} height={H}
                      fill="rgba(251,146,60,0.04)" />
                  )}

                  {/* Clip — rounded top corners for the entire bar column. */}
                  <defs>
                    <clipPath id={clipId}>
                      <path d={`M${x},${yTop + BAR_R}
                                Q${x},${yTop} ${x + BAR_R},${yTop}
                                H${x + BAR_W - BAR_R}
                                Q${x + BAR_W},${yTop} ${x + BAR_W},${yTop + BAR_R}
                                V${baselineY}
                                H${x}
                                Z`} />
                    </clipPath>
                  </defs>

                  {hasValue ? (
                    <g clipPath={`url(#${clipId})`}>
                      {isBest && (
                        <rect x={x - 4} y={yTop - 4} width={BAR_W + 8} height={totalH + 8}
                          fill="rgba(74,222,128,0.35)" filter="url(#best-glow)" />
                      )}
                      {topH > 0 && (
                        <rect x={x} y={yTop} width={BAR_W} height={topH} fill={topFill} />
                      )}
                      {cashH > 0 && (
                        <rect x={x} y={yCash} width={BAR_W} height={cashH} fill="url(#bar-purple)" />
                      )}
                      {/* Thin seam between cash and non-cash for visual separation. */}
                      {cashH > 0 && topH > 0 && (
                        <rect x={x} y={yCash - 0.5} width={BAR_W} height={1} fill="rgba(255,255,255,0.18)" />
                      )}
                      {/* Sheen along the top ~25% of the bar. */}
                      <rect x={x} y={yTop} width={BAR_W} height={Math.min(totalH * 0.35, 20)} fill="url(#bar-sheen)" />
                    </g>
                  ) : (
                    <rect x={x} y={baselineY - 2} width={BAR_W} height={2} rx={1} fill="rgba(255,255,255,0.06)" />
                  )}

                  {/* Today ring — drawn above the bar, not clipped. */}
                  {isToday && hasValue && (
                    <rect x={x - 1.5} y={yTop - 1.5} width={BAR_W + 3} height={totalH + 3} rx={BAR_R + 1.5} ry={BAR_R + 1.5}
                      fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="3 3" opacity={0.75} />
                  )}

                  {/* Value chip on best day (and on hovered bar). */}
                  {(isBest || isHovered) && hasValue && (
                    (() => {
                      const label = v >= 100000 ? `₹${(v / 100000).toFixed(1)}L` : v >= 1000 ? `₹${Math.round(v / 1000)}k` : `₹${v}`;
                      const chipW = label.length * 6 + 10;
                      const chipX = x + BAR_W / 2 - chipW / 2;
                      const chipY = Math.max(2, yTop - 16);
                      const chipColor = isHovered && !isBest ? "var(--accent)" : "var(--green)";
                      return (
                        <g>
                          <rect x={chipX} y={chipY} width={chipW} height={14} rx={7}
                            fill="var(--bg4)" stroke={chipColor} strokeWidth={1} opacity={0.95} />
                          <text x={x + BAR_W / 2} y={chipY + 10} fontSize={9} fontWeight={800}
                            fill={chipColor} textAnchor="middle">{label}</text>
                        </g>
                      );
                    })()
                  )}

                  {/* Day-of-month number. */}
                  <text x={x + BAR_W / 2} y={baselineY + 14} fontSize={9.5} fill={dayLabelColor}
                    textAnchor="middle" fontWeight={dayWeight}>{i + 1}</text>
                  {/* Weekday letter — single-letter, muted. */}
                  <text x={x + BAR_W / 2} y={baselineY + 26} fontSize={8}
                    fill={isWeekend ? "var(--orange)" : "var(--text3)"}
                    textAnchor="middle" opacity={isWeekend ? 0.85 : 0.5}
                    fontWeight={isWeekend ? 700 : 500}>
                    {dow.slice(0, 1)}
                  </text>
                </g>
              );
            })}

            {/* Optional average reference line — only drawn when the checkbox is ticked. */}
            {showAvg && avg > 0 && (() => {
              const yAvg = PAD_TOP + H - (avg / max) * H;
              return (
                <g>
                  <line x1={LEFT} y1={yAvg} x2={W - 4} y2={yAvg} stroke="var(--blue, #60a5fa)" strokeWidth={1.4} strokeDasharray="5 4" opacity={0.9} />
                  <rect x={LEFT + 4} y={yAvg - 9} width={76} height={14} rx={3} fill="rgba(96,165,250,0.18)" stroke="rgba(96,165,250,0.45)" />
                  <text x={LEFT + 8} y={yAvg + 1} fontSize={9} fill="var(--blue, #60a5fa)" fontWeight={800}>AVG {INR(avg)}</text>
                </g>
              );
            })()}
          </svg>
          </div>

          {hover && (() => {
            const TIP_W = 320;
            // Keep the tooltip on screen — align to the right of the bar when
            // there's room, otherwise flip to the left. Clamp so the card never
            // overflows the chart container.
            const barCenter = LEFT + hover.i * (BAR_W + GAP) + BAR_W / 2;
            const preferRight = barCenter + BAR_W / 2 + 10 + TIP_W <= W;
            const left = preferRight
              ? Math.min(barCenter + BAR_W / 2 + 10, W - TIP_W - 4)
              : Math.max(4, barCenter - BAR_W / 2 - 10 - TIP_W);
            const filled = (hover.byBranch || []).filter(b => b.v > 0);
            const empty = (hover.byBranch || []).filter(b => b.v === 0);
            return (
              <div style={{
                position: "absolute",
                left, top: 4, pointerEvents: "none",
                width: TIP_W,
                background: "linear-gradient(160deg, rgba(18,22,30,0.98), rgba(12,14,20,0.98))",
                border: "1px solid rgba(var(--accent-rgb),0.45)",
                borderRadius: 12,
                padding: "14px 16px",
                boxShadow: "0 12px 40px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04)",
                fontSize: 12, zIndex: 5,
              }}>
                {/* Header — date + grand total */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.2, fontWeight: 700 }}>{dayOfWeek(hover.i + 1)}</div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{hover.dateStr}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.2, fontWeight: 700 }}>Total</div>
                    <div style={{ fontSize: 18, fontWeight: 900, color: "var(--green)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(hover.v)}</div>
                  </div>
                </div>

                {/* Stream split chips */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 10 }}>
                  <div style={{ padding: "6px 8px", borderRadius: 8, background: "rgba(96,165,250,0.10)", border: "1px solid rgba(96,165,250,0.3)" }}>
                    <div style={{ fontSize: 8.5, color: "var(--blue, #60a5fa)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 800 }}>Online</div>
                    <div style={{ fontSize: 11.5, fontWeight: 800, color: "var(--blue, #60a5fa)" }}>{INR(hover.online || 0)}</div>
                  </div>
                  <div style={{ padding: "6px 8px", borderRadius: 8, background: "rgba(192,132,252,0.10)", border: "1px solid rgba(192,132,252,0.3)" }}>
                    <div style={{ fontSize: 8.5, color: "#c084fc", textTransform: "uppercase", letterSpacing: 1, fontWeight: 800 }}>Cash</div>
                    <div style={{ fontSize: 11.5, fontWeight: 800, color: "#c084fc" }}>{INR(hover.cash || 0)}</div>
                  </div>
                  <div style={{ padding: "6px 8px", borderRadius: 8, background: "rgba(251,146,60,0.10)", border: "1px solid rgba(251,146,60,0.3)" }}>
                    <div style={{ fontSize: 8.5, color: "var(--orange)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 800 }}>Material</div>
                    <div style={{ fontSize: 11.5, fontWeight: 800, color: "var(--orange)" }}>{INR(hover.mat || 0)}</div>
                  </div>
                </div>

                {/* Per-branch breakdown with share bars */}
                <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.2, fontWeight: 700, marginBottom: 6 }}>
                  Branch-wise ({filled.length}/{(hover.byBranch || []).length} reported)
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {filled.length === 0 && (
                    <div style={{ fontSize: 11, color: "var(--text3)", fontStyle: "italic" }}>No branch-level records for this day.</div>
                  )}
                  {filled.map(b => {
                    const pct = hover.v > 0 ? Math.round((b.v / hover.v) * 100) : 0;
                    return (
                      <div key={b.id} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, fontSize: 11.5 }}>
                          <span style={{ color: "var(--text)", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
                          <span style={{ display: "flex", alignItems: "baseline", gap: 6, flexShrink: 0 }}>
                            <span style={{ fontSize: 9.5, color: "var(--text3)", fontWeight: 700 }}>{pct}%</span>
                            <span style={{ color: "var(--accent)", fontWeight: 800 }}>{INR(b.v)}</span>
                          </span>
                        </div>
                        <div style={{ height: 3, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg, var(--blue, #60a5fa), var(--accent))", borderRadius: 2 }} />
                        </div>
                      </div>
                    );
                  })}
                  {empty.length > 0 && (
                    <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px dashed rgba(255,255,255,0.08)", fontSize: 10, color: "var(--text3)" }}>
                      <div style={{ fontWeight: 700, marginBottom: 2, color: "var(--red)", textTransform: "uppercase", letterSpacing: 1, fontSize: 9 }}>No entry: {empty.length}</div>
                      <div style={{ lineHeight: 1.5 }}>{empty.map(b => b.name).join(" · ")}</div>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </Card>
  );
}

// Year-mode twin of DailyBusinessChart — 12 bars, one per month, with the same
// stacked cash / non-cash split and a hover popup that breaks down Online,
// Cash, and Material for quick month-to-month verification.
function MonthlyBusinessChart({ entries, branches = [], filterYear }) {
  const [hover, setHover] = useState(null);
  const [showAvg, setShowAvg] = useState(false);
  const NOW = new Date();
  const currentYm = NOW.getFullYear() === filterYear ? NOW.getMonth() : 11;

  const byMo = new Array(12).fill(0);
  const byMoCash = new Array(12).fill(0);
  const byMoNonCash = new Array(12).fill(0);
  const byMoOnline = new Array(12).fill(0);
  const byMoMat = new Array(12).fill(0);
  // `${branchId}|${mIdx}` → sale on that month for that branch
  const byMoBranch = new Map();
  entries.forEach(e => {
    if (!e.date || !e.date.startsWith(String(filterYear))) return;
    const mIdx = Number(e.date.slice(5, 7)) - 1;
    if (mIdx < 0 || mIdx > 11) return;
    const matSale = (e.staff_billing || []).reduce((s, sb) => s + (sb.material || 0), 0);
    const sale = (e.online || 0) + (e.cash || 0) + matSale;
    byMoCash[mIdx] += (e.cash || 0);
    byMoOnline[mIdx] += (e.online || 0);
    byMoMat[mIdx] += matSale;
    byMoNonCash[mIdx] += (e.online || 0) + matSale;
    byMo[mIdx] += sale;
    if (e.branch_id) {
      const k = `${e.branch_id}|${mIdx}`;
      byMoBranch.set(k, (byMoBranch.get(k) || 0) + sale);
    }
  });

  const max = Math.max(1, ...byMo);
  const totalBusiness = byMo.reduce((s, v) => s + v, 0);
  const totalCash = byMoCash.reduce((s, v) => s + v, 0);
  const totalNonCash = byMoNonCash.reduce((s, v) => s + v, 0);
  // Active months = months with any entries — used as avg denominator so a
  // half-finished year doesn't dilute the average with empty months.
  const activeMonths = byMo.filter(v => v > 0).length;
  const avg = activeMonths ? Math.round(totalBusiness / activeMonths) : 0;
  const bestIdx = byMo.indexOf(Math.max(...byMo));

  const H = 230;
  const BAR_W = 40;
  const GAP = 20;
  const LEFT = 56;
  const PAD_TOP = 22;
  const PAD_BOTTOM = 34;
  const W = LEFT + 12 * (BAR_W + GAP) + 8;
  const yTicks = 4;
  const BAR_R = 7;
  const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  return (
    <Card style={{ padding: 18, marginBottom: 24, overflow: "visible" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 2 }}>Monthly Business</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "var(--gold)", fontFamily: "var(--font-headline, var(--font-outfit))", marginTop: 2 }}>{filterYear}</div>
        </div>
        <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>Total</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "var(--green)" }}>{INR(totalBusiness)}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>Cash / Online+Mat</div>
            <div style={{ fontSize: 13, fontWeight: 800 }}>
              <span style={{ color: "#c084fc" }}>{INR(totalCash)}</span>
              <span style={{ color: "var(--text3)", margin: "0 4px" }}>·</span>
              <span style={{ color: "var(--blue)" }}>{INR(totalNonCash)}</span>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>Monthly Avg</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "var(--blue)" }}>{INR(avg)}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>Best Month</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "var(--green)" }}>{byMo[bestIdx] > 0 ? `${MONTHS_SHORT[bestIdx]} · ${INR(byMo[bestIdx])}` : "—"}</div>
          </div>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "6px 10px", background: showAvg ? "rgba(96,165,250,0.12)" : "var(--bg3)", border: `1px solid ${showAvg ? "rgba(96,165,250,0.4)" : "var(--border)"}`, borderRadius: 8, fontSize: 10, fontWeight: 700, color: showAvg ? "var(--blue)" : "var(--text3)", textTransform: "uppercase", letterSpacing: 1, userSelect: "none" }}>
            <input type="checkbox" checked={showAvg} onChange={e => setShowAvg(e.target.checked)} style={{ accentColor: "var(--blue, #60a5fa)", cursor: "pointer" }} />
            Avg line
          </label>
        </div>
      </div>

      {totalBusiness === 0 ? (
        <div style={{ height: H, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text3)", fontStyle: "italic", fontSize: 13 }}>No business entries recorded for {filterYear} yet.</div>
      ) : (
        // Same nested wrapper as DailyBusinessChart — outer is visible so the
        // hover tooltip can extend below the chart card; inner handles X scroll.
        <div style={{ position: "relative" }}>
          <div style={{ overflowX: "auto" }}>
          <svg width={W} height={H + PAD_TOP + PAD_BOTTOM} style={{ display: "block" }}>
            <defs>
              <linearGradient id="mbar-blue" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#38d9f2" /><stop offset="100%" stopColor="#0891a8" stopOpacity="0.75" /></linearGradient>
              <linearGradient id="mbar-accent" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#5de8ff" /><stop offset="100%" stopColor="#12a5bf" stopOpacity="0.85" /></linearGradient>
              <linearGradient id="mbar-green" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#7df094" /><stop offset="100%" stopColor="#22a354" stopOpacity="0.85" /></linearGradient>
              <linearGradient id="mbar-purple" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#d7a6ff" stopOpacity="0.95" /><stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.8" /></linearGradient>
              <linearGradient id="mbar-sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="rgba(255,255,255,0.22)" /><stop offset="60%" stopColor="rgba(255,255,255,0)" /></linearGradient>
              <filter id="mbest-glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="4" /></filter>
            </defs>
            {Array.from({ length: yTicks + 1 }, (_, i) => {
              const frac = i / yTicks;
              const y = PAD_TOP + (1 - frac) * H;
              const v = Math.round(max * frac);
              const isBaseline = i === 0;
              return (
                <g key={i}>
                  <line x1={LEFT} y1={y} x2={W - 4} y2={y}
                    stroke={isBaseline ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.04)"}
                    strokeDasharray={isBaseline ? undefined : "2 4"} strokeWidth={1} />
                  {!isBaseline && (
                    <text x={LEFT - 8} y={y + 3} fontSize={9} fill="var(--text3)" textAnchor="end" fontWeight={600}>
                      {v >= 100000 ? `${(v / 100000).toFixed(1)}L` : v >= 1000 ? `${Math.round(v / 1000)}k` : v}
                    </text>
                  )}
                </g>
              );
            })}
            {byMo.map((v, i) => {
              const x = LEFT + i * (BAR_W + GAP);
              const hasValue = v > 0;
              const totalH = hasValue ? Math.max(2, (v / max) * H) : 2;
              const cashH = hasValue ? (byMoCash[i] / max) * H : 0;
              const topH = Math.max(0, totalH - cashH);
              const yTop = PAD_TOP + H - totalH;
              const yCash = PAD_TOP + H - cashH;
              const baselineY = PAD_TOP + H;
              const isCurrent = i === currentYm;
              const isBest = i === bestIdx && hasValue;
              const isHovered = hover && hover.i === i;
              const topFill = isBest ? "url(#mbar-green)" : isCurrent ? "url(#mbar-accent)" : "url(#mbar-blue)";
              const dim = hover && hover.i !== i ? 0.35 : 1;
              const monthLabelColor = isBest ? "var(--green)" : isCurrent ? "var(--accent)" : "var(--text3)";
              const monthWeight = (isBest || isCurrent) ? 800 : 600;
              const clipId = `mbar-clip-${filterYear}-${i}`;
              return (
                <g key={i}
                  onMouseEnter={() => hasValue && setHover({
                    i, v, cash: byMoCash[i], online: byMoOnline[i], mat: byMoMat[i], nonCash: byMoNonCash[i],
                    byBranch: branches
                      .map(b => ({ id: b.id, name: (b.name || "").replace("V-CUT ", ""), v: byMoBranch.get(`${b.id}|${i}`) || 0 }))
                      .sort((a, b) => b.v - a.v),
                  })}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: hasValue ? "pointer" : "default", transition: "opacity .15s" }}
                  opacity={dim}>
                  <defs>
                    <clipPath id={clipId}>
                      <path d={`M${x},${yTop + BAR_R}
                                Q${x},${yTop} ${x + BAR_R},${yTop}
                                H${x + BAR_W - BAR_R}
                                Q${x + BAR_W},${yTop} ${x + BAR_W},${yTop + BAR_R}
                                V${baselineY}
                                H${x}
                                Z`} />
                    </clipPath>
                  </defs>
                  {hasValue ? (
                    <g clipPath={`url(#${clipId})`}>
                      {isBest && (
                        <rect x={x - 4} y={yTop - 4} width={BAR_W + 8} height={totalH + 8}
                          fill="rgba(74,222,128,0.35)" filter="url(#mbest-glow)" />
                      )}
                      {topH > 0 && <rect x={x} y={yTop} width={BAR_W} height={topH} fill={topFill} />}
                      {cashH > 0 && <rect x={x} y={yCash} width={BAR_W} height={cashH} fill="url(#mbar-purple)" />}
                      {cashH > 0 && topH > 0 && <rect x={x} y={yCash - 0.5} width={BAR_W} height={1} fill="rgba(255,255,255,0.18)" />}
                      <rect x={x} y={yTop} width={BAR_W} height={Math.min(totalH * 0.35, 20)} fill="url(#mbar-sheen)" />
                    </g>
                  ) : (
                    <rect x={x} y={baselineY - 2} width={BAR_W} height={2} rx={1} fill="rgba(255,255,255,0.06)" />
                  )}
                  {isCurrent && hasValue && (
                    <rect x={x - 1.5} y={yTop - 1.5} width={BAR_W + 3} height={totalH + 3} rx={BAR_R + 1.5} ry={BAR_R + 1.5}
                      fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="3 3" opacity={0.75} />
                  )}
                  {(isBest || isHovered) && hasValue && (() => {
                    const label = v >= 10000000 ? `₹${(v / 10000000).toFixed(2)}Cr` : v >= 100000 ? `₹${(v / 100000).toFixed(1)}L` : v >= 1000 ? `₹${Math.round(v / 1000)}k` : `₹${v}`;
                    const chipW = label.length * 6.5 + 12;
                    const chipX = x + BAR_W / 2 - chipW / 2;
                    const chipY = Math.max(2, yTop - 16);
                    const chipColor = isHovered && !isBest ? "var(--accent)" : "var(--green)";
                    return (
                      <g>
                        <rect x={chipX} y={chipY} width={chipW} height={14} rx={7}
                          fill="var(--bg4)" stroke={chipColor} strokeWidth={1} opacity={0.95} />
                        <text x={x + BAR_W / 2} y={chipY + 10} fontSize={9} fontWeight={800}
                          fill={chipColor} textAnchor="middle">{label}</text>
                      </g>
                    );
                  })()}
                  <text x={x + BAR_W / 2} y={baselineY + 16} fontSize={11} fill={monthLabelColor}
                    textAnchor="middle" fontWeight={monthWeight}>{MONTHS_SHORT[i]}</text>
                </g>
              );
            })}
            {showAvg && avg > 0 && (() => {
              const yAvg = PAD_TOP + H - (avg / max) * H;
              return (
                <g>
                  <line x1={LEFT} y1={yAvg} x2={W - 4} y2={yAvg} stroke="var(--blue, #60a5fa)" strokeWidth={1.4} strokeDasharray="5 4" opacity={0.9} />
                  <rect x={LEFT + 4} y={yAvg - 9} width={84} height={14} rx={3} fill="rgba(96,165,250,0.18)" stroke="rgba(96,165,250,0.45)" />
                  <text x={LEFT + 8} y={yAvg + 1} fontSize={9} fill="var(--blue, #60a5fa)" fontWeight={800}>AVG {INR(avg)}</text>
                </g>
              );
            })()}
          </svg>
          </div>

          {hover && (() => {
            const TIP_W = 320;
            const barCenter = LEFT + hover.i * (BAR_W + GAP) + BAR_W / 2;
            const preferRight = barCenter + BAR_W / 2 + 10 + TIP_W <= W;
            const left = preferRight
              ? Math.min(barCenter + BAR_W / 2 + 10, W - TIP_W - 4)
              : Math.max(4, barCenter - BAR_W / 2 - 10 - TIP_W);
            const filled = (hover.byBranch || []).filter(b => b.v > 0);
            const empty = (hover.byBranch || []).filter(b => b.v === 0);
            return (
              <div style={{
                position: "absolute",
                left, top: 4, pointerEvents: "none",
                width: TIP_W,
                background: "linear-gradient(160deg, rgba(18,22,30,0.98), rgba(12,14,20,0.98))",
                border: "1px solid rgba(var(--accent-rgb),0.45)",
                borderRadius: 12,
                padding: "14px 16px",
                boxShadow: "0 12px 40px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.04)",
                fontSize: 12, zIndex: 5,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.2, fontWeight: 700 }}>{filterYear}</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: "var(--text)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{MONTHS_SHORT[hover.i]}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.2, fontWeight: 700 }}>Total</div>
                    <div style={{ fontSize: 18, fontWeight: 900, color: "var(--green)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(hover.v)}</div>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 10 }}>
                  <div style={{ padding: "6px 8px", borderRadius: 8, background: "rgba(96,165,250,0.10)", border: "1px solid rgba(96,165,250,0.3)" }}>
                    <div style={{ fontSize: 8.5, color: "var(--blue, #60a5fa)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 800 }}>Online</div>
                    <div style={{ fontSize: 11.5, fontWeight: 800, color: "var(--blue, #60a5fa)" }}>{INR(hover.online || 0)}</div>
                  </div>
                  <div style={{ padding: "6px 8px", borderRadius: 8, background: "rgba(192,132,252,0.10)", border: "1px solid rgba(192,132,252,0.3)" }}>
                    <div style={{ fontSize: 8.5, color: "#c084fc", textTransform: "uppercase", letterSpacing: 1, fontWeight: 800 }}>Cash</div>
                    <div style={{ fontSize: 11.5, fontWeight: 800, color: "#c084fc" }}>{INR(hover.cash || 0)}</div>
                  </div>
                  <div style={{ padding: "6px 8px", borderRadius: 8, background: "rgba(251,146,60,0.10)", border: "1px solid rgba(251,146,60,0.3)" }}>
                    <div style={{ fontSize: 8.5, color: "var(--orange)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 800 }}>Material</div>
                    <div style={{ fontSize: 11.5, fontWeight: 800, color: "var(--orange)" }}>{INR(hover.mat || 0)}</div>
                  </div>
                </div>
                <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.2, fontWeight: 700, marginBottom: 6 }}>
                  Branch-wise ({filled.length}/{(hover.byBranch || []).length} reported)
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {filled.length === 0 && (
                    <div style={{ fontSize: 11, color: "var(--text3)", fontStyle: "italic" }}>No branch-level records for this month.</div>
                  )}
                  {filled.map(b => {
                    const pct = hover.v > 0 ? Math.round((b.v / hover.v) * 100) : 0;
                    return (
                      <div key={b.id} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, fontSize: 11.5 }}>
                          <span style={{ color: "var(--text)", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
                          <span style={{ display: "flex", alignItems: "baseline", gap: 6, flexShrink: 0 }}>
                            <span style={{ fontSize: 9.5, color: "var(--text3)", fontWeight: 700 }}>{pct}%</span>
                            <span style={{ color: "var(--accent)", fontWeight: 800 }}>{INR(b.v)}</span>
                          </span>
                        </div>
                        <div style={{ height: 3, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg, var(--blue, #60a5fa), var(--accent))", borderRadius: 2 }} />
                        </div>
                      </div>
                    );
                  })}
                  {empty.length > 0 && (
                    <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px dashed rgba(255,255,255,0.08)", fontSize: 10, color: "var(--text3)" }}>
                      <div style={{ fontWeight: 700, marginBottom: 2, color: "var(--red)", textTransform: "uppercase", letterSpacing: 1, fontSize: 9 }}>No entry: {empty.length}</div>
                      <div style={{ lineHeight: 1.5 }}>{empty.map(b => b.name).join(" · ")}</div>
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </Card>
  );
}
