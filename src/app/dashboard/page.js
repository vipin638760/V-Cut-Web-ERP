"use client";
import { useEffect, useState, useRef, useMemo } from "react";
import { collection, onSnapshot, query, orderBy, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR, staffBillingInPeriod, makeFilterPrefix, periodLabel, proRataSalary, staffLeavesInMonth, staffStatusForMonth, staffIncentivesInPeriod, MASK } from "@/lib/calculations";
import { PeriodWidget, ToggleGroup, Card, Pill, TH, TD, Icon, Modal, TabNav, ProgressBar, useToast } from "@/components/ui";
import { useRouter } from "next/navigation";
// ExcelJS is ~200KB — load only when Export is actually used.
let _excelJSPromise = null;
const loadExcelJS = () => {
  if (!_excelJSPromise) _excelJSPromise = import("exceljs").then(m => m.default || m);
  return _excelJSPromise;
};

const NOW = new Date();

const PremiumStatCard = ({ label, value, sub, icon, color = "var(--accent)", trend }) => (
  <div style={{
    background: "var(--bg3)",
    borderRadius: 16,
    padding: "22px 24px",
    flex: 1,
    minWidth: 220,
    position: "relative",
    overflow: "hidden",
    border: "1px solid rgba(72,72,71,0.1)",
  }}>
    <div style={{ position: "absolute", top: -15, right: -15, width: 80, height: 80, background: color, filter: "blur(40px)", opacity: 0.06, borderRadius: "50%" }} />
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", position: "relative", zIndex: 1 }}>
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 10, fontFamily: "var(--font-body, var(--font-outfit))" }}>{label}</div>
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
  const [loading, setLoading]     = useState(true);

  // Period
  const [filterMode, setFilterMode]   = useState("month");
  const [filterYear, setFilterYear]   = useState(NOW.getFullYear());
  const [filterMonth, setFilterMonth] = useState(NOW.getMonth() + 1);

  const [showAdvLog, setShowAdvLog]   = useState(false);

  // Dashboard view controls
  const [dashView, setDashView]         = useState("all");
  const [brFilter, setBrFilter]         = useState("all");
  const [brTypeFilter, setBrTypeFilter] = useState("all");
  const [brSortCol, setBrSortCol]       = useState("name");
  const [brSortDir, setBrSortDir]       = useState("asc");
  const [brView, setBrView]             = useState("card");
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

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "branches"), sn =>
        setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "staff"), sn =>
        setStaff(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "leaves"), sn =>
        setLeaves(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "salary_history"), sn =>
        setSalHistory(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(doc(db, "settings", "global"), sn => setGlobalSettings(sn.data() || {})),
      onSnapshot(
        query(collection(db, "entries"), orderBy("date", "desc")),
        sn => {
          setEntries(sn.docs.map(d => ({ ...d.data(), id: d.id })));
          setLoading(false);
        }
      ),
      onSnapshot(collection(db, "staff_advances"), sn =>
        setAdvances(sn.docs.map(d => ({ ...d.data(), id: d.id })))
      ),
      onSnapshot(
        query(collection(db, "staff_reviews"), orderBy("date", "desc")),
        sn => setReviews(sn.docs.map(d => ({ ...d.data(), id: d.id })))
      ),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  const filterPrefix = makeFilterPrefix(filterYear, filterMonth);
  const plabel       = periodLabel(filterMode, filterYear, filterMonth);

  const inPeriod = (dateStr) => {
    if (!dateStr) return false;
    return filterMode === "month"
      ? dateStr.startsWith(filterPrefix)
      : dateStr.startsWith(String(filterYear));
  };

  const getIncome = (bid) =>
    entries.filter(e => e.branch_id === bid && inPeriod(e.date))
      .reduce((s, e) => s + (e.online || 0) + (e.cash || 0) +
        (e.staff_billing || []).reduce((ss, sb) => ss + (sb.material || 0), 0), 0);

  const getExpenses = (bid) =>
    entries.filter(e => e.branch_id === bid && inPeriod(e.date))
      .reduce((s, e) => s +
        (e.staff_billing || []).reduce((ss, sb) => ss + (sb.incentive || 0) + (sb.mat_incentive || 0), 0) +
        (e.mat_expense || 0) + (e.others || 0) + (e.petrol || 0), 0);

  // Prorata Factor for Fixed Costs
  const isYearly = filterMode === "year";
  const factor = (isYearly && filterYear === NOW.getFullYear()) ? (NOW.getMonth() + 1) : (isYearly ? 12 : 1);

  const tI   = branches.reduce((s, b) => s + getIncome(b.id), 0);
  const tVE  = branches.reduce((s, b) => s + getExpenses(b.id), 0);
  const tFE  = branches.reduce((s, b) => s + ((b.shop_rent || 0) + (b.room_rent || 0) + (b.wifi || 0) + (b.shop_elec || 0) + (b.room_elec || 0) + (b.salary_budget || 0)) * factor, 0);
  const tE   = tVE + tFE;
  
  const tG   = entries.filter(e => inPeriod(e.date)).reduce((s, e) => s + (e.total_gst || 0), 0);
  const net  = tI - tE;
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
    const vMatE  = bEntries.reduce((s, e) => s + (e.mat_expense || 0), 0);
    const vOther = bEntries.reduce((s, e) => s + (e.others || 0) + (e.petrol || 0), 0);
    const vPetrol = bEntries.reduce((s, e) => s + (e.petrol || 0), 0);
    
    // Fixed costs
    const fShopRent = (b.shop_rent || 0) * factor;
    const fRoomRent = (b.room_rent || 0) * factor;
    const fWifi     = (b.wifi || 0) * factor;
    const fElec     = ((b.shop_elec || 0) + (b.room_elec || 0)) * factor;
    const fFixedTot = fShopRent + fRoomRent + fWifi + fElec;

    // Payroll (Actual)
    let actualSalary = 0;
    let actualLeaves = 0;
    const startM = isYearly ? 1 : filterMonth;
    const endM   = isYearly ? factor : filterMonth;
    for (let m = startM; m <= endM; m++) {
      const mPrefix = `${filterYear}-${String(m).padStart(2, '0')}`;
      const activeStaffInMonth = staff.filter(s => s.branch_id === b.id && staffStatusForMonth(s, mPrefix).status !== 'inactive');
      actualSalary += activeStaffInMonth.reduce((s, st) => s + proRataSalary(st, mPrefix, branches, salHistory, staff, globalSettings), 0);
      actualLeaves += activeStaffInMonth.reduce((s, st) => s + staffLeavesInMonth(st.id, mPrefix, leaves), 0);
    }

    const expenses = vInc + vMatE + vOther + fFixedTot + actualSalary;
    const net      = income - expenses;
    const totalGst = bEntries.reduce((s, ent) => s + (ent.total_gst || 0), 0);

    return { 
      b, 
      i: income, 
      e: expenses, 
      n: net, 
      staffCount: staff.filter(s => s.branch_id === b.id).length, 
      vInc, vMatE, vOther, vPetrol,
      fShopRent, fRoomRent, fWifi, fElec,
      actualSalary, actualLeaves,
      totalGst, factor 
    };
  });
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

  // Staff leaderboard
  const staffData = staff
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 20, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: 28, fontWeight: 800, color: "var(--text)", letterSpacing: -0.5, margin: 0, fontFamily: "var(--font-headline, var(--font-outfit))" }}>Organizational Pulse</h2>
          <p style={{ fontSize: 13, color: "var(--text3)", fontWeight: 500, marginTop: 6 }}>System oversight and branch network analytics.</p>
        </div>
        <PeriodWidget filterMode={filterMode} setFilterMode={setFilterMode} filterYear={filterYear} setFilterYear={setFilterYear} filterMonth={filterMonth} setFilterMonth={setFilterMonth} />
      </div>

      {/* Admin Metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        <PremiumStatCard label="Gross Revenue" value={INR(tI)} sub="Total turnover" icon="trending" color="var(--green)" />
        <PremiumStatCard label="Operating Cost" value={INR(tE)} sub="Salary + Overheads" icon="wallet" color="var(--red)" />
        <PremiumStatCard label="Net P&L" value={INR(net)} sub="Bottom line earnings" icon="pie" color={net >= 0 ? "var(--green)" : "var(--red)"} />
        <PremiumStatCard label="Service Force" value={staff.length} sub="Active stylists" icon="users" color="var(--accent)" />
      </div>

      {/* Main Admin Grid */}
      <div style={{ display: "grid", gridTemplateColumns: dashView === "all" ? "1.6fr 1fr" : "1fr", gap: 24 }}>

        {/* Branch Section */}
        {(dashView === "all" || dashView === "shop") && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
               <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0, fontFamily: "var(--font-headline, var(--font-outfit))" }}>Branch Performance</h3>
               <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                 <ToggleGroup options={[["all","Mixed"],["shop","Branch Only"],["staff","Staff Only"]]} value={dashView} onChange={setDashView} />
                 <ToggleGroup options={[["all","All"],["profit","Profit"],["loss","Loss"]]} value={brFilter} onChange={setBrFilter}
                   colors={{ all: "var(--blue)", profit: "var(--green)", loss: "var(--red)" }} />
                 <ToggleGroup options={[["card","Grid"],["table","List"]]} value={brView} onChange={setBrView} />
                 {isAdmin && (
                   <button onClick={exportBranchPerformance} disabled={exporting} title="Export branch performance to Excel (one tab per branch)"
                     style={{ padding: "6px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", cursor: exporting ? "wait" : "pointer", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: "var(--green)", textTransform: "uppercase", letterSpacing: 0.5, opacity: exporting ? 0.6 : 1 }}>
                     <Icon name="save" size={13} /> {exporting ? "Exporting..." : "Export"}
                   </button>
                 )}
               </div>
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
              <DraggableCardGrid branchData={branchData} isAdmin={isAdmin} isYearly={isYearly} factor={factor} cardOrder={cardOrder} setCardOrder={setCardOrder} dragId={dragId} onCardClick={(bid) => router.push(`/dashboard/branches?branchId=${bid}`)} />
            )}
          </div>
        )}

        {/* Staff Section */}
        {(dashView === "all" || dashView === "staff") && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
             <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0, fontFamily: "var(--font-headline, var(--font-outfit))" }}>Top Performers</h3>
             <Card style={{ padding: 0, overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
                  <thead>
                    <tr><TH>#</TH><TH>Name</TH><TH right>Billing</TH></tr>
                  </thead>
                  <tbody>
                    {staffData.map((s, i) => (
                      <tr key={s.s.id} style={{ transition: "background 0.15s" }}
                        onMouseEnter={e => e.currentTarget.style.background = "var(--bg4)"}
                        onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                        <TD style={{ color: "var(--text3)", fontWeight: 600, fontSize: 12 }}>{i+1}</TD>
                        <TD style={{ fontWeight: 600 }}>{s.s.name}</TD>
                        <TD right style={{ fontWeight: 700, color: "var(--accent)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(s.sale)}</TD>
                      </tr>
                    ))}
                  </tbody>
                </table>
             </Card>
          </div>
        )}
      </div>
      {ToastContainer}
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
function DraggableCardGrid({ branchData, isAdmin, isYearly, factor, cardOrder, setCardOrder, dragId, onCardClick }) {
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
              borderLeft: `3px solid ${n >= 0 ? "var(--green)" : "var(--red)"}`,
            }}
            onMouseEnter={ev => { if (!isDragging) ev.currentTarget.style.background = "var(--bg4)"; }}
            onMouseLeave={ev => { if (!isDragging && !isOver) ev.currentTarget.style.background = "var(--bg3)"; }}
          >
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 4, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{b.name}</div>
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
