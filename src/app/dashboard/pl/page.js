"use client";
import { useEffect, useState, useRef } from "react";
import { db } from "@/lib/firebase";
import { collection, onSnapshot, query, orderBy } from "firebase/firestore";
import { INR, MASK, MONTHS, proRataSalary, staffStatusForMonth, getMonthlyFixed, computeIncentiveExpense } from "@/lib/calculations";
import { PeriodWidget, ToggleGroup, Card, Icon, TH, TD, Pill } from "@/components/ui";
import VLoader from "@/components/VLoader";


const CompactStat = ({ label, val, col, bold }) => (
  <div style={{ textAlign: "center" }}>
    <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", fontWeight: 700, marginBottom: 2, letterSpacing: 0.5 }}>{label}</div>
    <div style={{ fontSize: 13, fontWeight: bold ? 900 : 700, color: col, whiteSpace: "nowrap" }}>{val}</div>
  </div>
);

export default function PLReportPage() {
  const [branches, setBranches] = useState([]);
  const [staff, setStaff] = useState([]);
  const [entries, setEntries] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [monthlyExpenses, setMonthlyExpenses] = useState([]);
  const [fixedExpenses, setFixedExpenses] = useState([]);
  const [incentiveReleases, setIncentiveReleases] = useState([]);
  const [costCenters, setCostCenters] = useState([]);
  const [salaryHistory, setSalaryHistory] = useState([]);
  const [materialAllocations, setMaterialAllocations] = useState([]);
  const [globalSettings, setGlobalSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);

  // Filters
  const now = new Date();
  const [filterMode, setFilterMode] = useState("month");
  const [filterYear, setFilterYear] = useState(now.getFullYear());
  const [filterMonth, setFilterMonth] = useState(now.getMonth() + 1);

  useEffect(() => {
    const saved = localStorage.getItem("vcut_user");
    if (saved) setUser(JSON.parse(saved));

    const unsubs = [
      onSnapshot(collection(db, "branches"), s => setBranches(s.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "staff"), s => setStaff(s.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(query(collection(db, "entries"), orderBy("date", "desc")), s => setEntries(s.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "transactions"), s => setTransactions(s.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "monthly_expenses"), s => setMonthlyExpenses(s.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "fixed_expenses"), s => setFixedExpenses(s.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "incentive_releases"), s => setIncentiveReleases(s.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "cost_centers"), s => setCostCenters(s.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "salary_history"), s => setSalaryHistory(s.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "material_allocations"), s => setMaterialAllocations(s.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "settings"), s => {
        const data = {}; s.docs.forEach(d => data[d.id] = d.data());
        setGlobalSettings(data.global || {});
      })
    ];
    setTimeout(() => setLoading(false), 800);
    return () => unsubs.forEach(u => u());
  }, []);

  const isAdmin = user?.role === "admin";
  const filterPrefix = `${filterYear}-${String(filterMonth).padStart(2, "0")}`;


  // Helper: Get active months in year
  const getActiveMonths = (year) => {
    const isCurrentYear = year === now.getFullYear();
    const endMonth = isCurrentYear ? now.getMonth() + 1 : 12;
    const months = [];
    for (let m = 1; m <= endMonth; m++) months.push(`${year}-${String(m).padStart(2, "0")}`);
    return months;
  };

  // Per-branch per-month stats — mirrors the Dashboard's Operating Cost formula
  // so the two pages agree on a single "expense" number. Differences from the
  // previous (legacy) formula:
  //  - Material expense now respects mat_use_allocations / mat_use_lumpsum
  //    flags (was hardcoded lumpsum).
  //  - Fixed cost is branch-master only: shop_rent + room_rent + shop_elec +
  //    room_elec + wifi (dropped water / maid / dust / petrol double-counts).
  //  - Tips are no longer counted as an expense (they're tip-flow only).
  //  - Per-branch transactions and cost_centers are excluded — they now live
  //    in the "Shared Expenses" table below the main P&L grid.
  //  - GST estimate (online × gst_pct) is added to match Dashboard exactly.
  const calculateBranchStats = (bid, month) => {
    const b = branches.find(x => x.id === bid);
    if (!b) return null;

    const periodEnts = entries.filter(e => e.branch_id === bid && e.date && e.date.startsWith(month));

    // Income — raw online + cash. Material sale stays inside staff_billing and
    // is counted as income via iMatS (matches Dashboard's `income` field).
    const iOnline = periodEnts.reduce((s, e) => s + (e.online || 0), 0);
    const iCash   = periodEnts.reduce((s, e) => s + (e.cash || 0), 0);
    const iMatS   = periodEnts.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.material || 0), 0), 0);
    const totalIncome = iOnline + iCash + iMatS;

    // Variable — incentive + material cost (flag-aware) + other day-level costs.
    // Raw 5% per-day + ceil-10 rounding bump on releases that paid out for
    // this branch in this month. Pending entries count as raw; once paid the
    // rounding surplus is added.
    const monthReleases = incentiveReleases.filter(r => r.branch_id === bid && (r.period_from || (r.released_at || "").slice(0, 10)).startsWith(month));
    const staffByIdMap = new Map(staff.map(s => [s.id, s]));
    const branchesByIdMap = new Map(branches.map(br => [br.id, br]));
    const incentives = computeIncentiveExpense(periodEnts, staffByIdMap, monthReleases, branchesByIdMap, globalSettings);

    const matUseAllocations = globalSettings?.mat_use_allocations !== false;
    const matUseLumpsum = globalSettings?.mat_use_lumpsum === true;
    const allocsTotal = (arr) => arr.reduce((s, a) => s + (Number(a.total) || (a.items || []).reduce((ss, it) => ss + (Number(it.line_total) || (Number(it.qty) * Number(it.price_at_transfer)) || 0), 0)), 0);
    const vMatAlloc = allocsTotal(materialAllocations.filter(a => a.branch_id === bid && (a.date || (a.transferred_at || "").slice(0, 10)).startsWith(month)));
    const vMatLump = periodEnts.reduce((s, e) => s + (Number(e.mat_expense) || 0), 0);
    const matExp = (matUseAllocations ? vMatAlloc : 0) + (matUseLumpsum ? vMatLump : 0);

    const vOther = periodEnts.reduce((s, e) => s + (e.others || 0) + (e.petrol || 0), 0);

    // Fixed — honors per-month overrides from `monthly_expenses` (Master
    // Setup → Fixed Expenses); branch master fills in the gaps. Both
    // Dashboard and P&L now go through the same `getMonthlyFixed` helper
    // so a rent bump entered in one place is reflected in both totals.
    const mf = getMonthlyFixed(b, month, monthlyExpenses, fixedExpenses);
    const fixedCost = mf.shop_rent + mf.room_rent + mf.shop_elec + mf.room_elec + mf.wifi;

    // Salary
    const activeStaff = staff.filter(s => s.branch_id === bid && staffStatusForMonth(s, month).status !== "inactive");
    const salaries = activeStaff.reduce((s, st) => s + proRataSalary(st, month, branches, salaryHistory, staff, globalSettings), 0);

    // GST estimate — mirrors Dashboard's totalGst.
    const gstPct = globalSettings?.gst_pct || 0;
    const totalGst = (iOnline * gstPct) / 100;

    const totalExpense = incentives + matExp + vOther + fixedCost + salaries + totalGst;

    return {
      income: totalIncome,
      salary: salaries,
      incentives,
      fixed: fixedCost,
      txns: vOther,   // kept for column compatibility; now means Other + Petrol from entries
      misc: matExp,   // material cost (flag-aware)
      cc: totalGst,   // GST estimate
      expense: totalExpense,
      pl: totalIncome - totalExpense,
    };
  };

  // Shared expenses — `transactions` docs tagged with branch_id === "all" and
  // cost_centers entries (head office rent, office electricity, etc). Rendered
  // in a separate table so the admin can see them without them distorting
  // per-branch P&L.
  const getSharedExpensesForMonth = (month) => {
    const txnRows = transactions
      .filter(t => t.branch_id === "all" && t.cat !== "income" && ((t.date && t.date.startsWith(month)) || (t.month === month)))
      .map(t => ({
        id: t.id,
        source: "transaction",
        label: t.type || t.desc || "Shared Expense",
        amount: Number(t.amount) || 0,
        date: t.date || `${month}-01`,
        note: t.desc || "",
      }));
    const ccRows = costCenters.map(cc => ({
      id: `cc-${cc.id}-${month}`,
      source: "cost_center",
      label: cc.name || "Cost Center",
      amount: Number(cc.monthly_cost) || 0,
      date: `${month}-01`,
      note: cc.desc || "",
    }));
    return [...txnRows, ...ccRows].sort((a, b) => b.amount - a.amount);
  };

  if (loading) return <VLoader fullscreen label="GENESTATING P&L REPORT" />;

  const targetMonths = filterMode === "month" ? [filterPrefix] : getActiveMonths(filterYear);
  
  // Aggregate Branch Data for the selected period
  const reportData = branches.map(b => {
    const stats = targetMonths.reduce((sum, mon) => {
      const mStats = calculateBranchStats(b.id, mon);
      if (!mStats) return sum;
      return {
        income: sum.income + mStats.income,
        salary: sum.salary + mStats.salary,
        incentives: sum.incentives + mStats.incentives,
        fixed: sum.fixed + mStats.fixed,
        txns: sum.txns + mStats.txns,
        misc: sum.misc + mStats.misc,
        cc: sum.cc + mStats.cc,
        expense: sum.expense + mStats.expense,
        pl: sum.pl + mStats.pl,
        monthlyNet: { ...sum.monthlyNet, [mon]: mStats.pl }
      };
    }, { income: 0, salary: 0, incentives: 0, fixed: 0, txns: 0, misc: 0, cc: 0, expense: 0, pl: 0, monthlyNet: {} });
    return { branch: b, stats };
  });

  const netIncome = reportData.reduce((s, r) => s + r.stats.income, 0);
  const netExpense = reportData.reduce((s, r) => s + r.stats.expense, 0);
  const netPL = netIncome - netExpense;

  const formatINR = (v) => "₹" + Math.abs(Math.round(v || 0)).toLocaleString("en-IN");
  const M = (v) => isAdmin ? (v < 0 ? `(${formatINR(v)})` : formatINR(v)) : MASK;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>📊 P&L Report</div>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", marginTop: 4 }}>Consolidated Network Performance • {filterMode === "month" ? `${MONTHS[filterMonth - 1]} ${filterYear}` : filterYear}</div>
        </div>
      </div>

      <PeriodWidget filterMode={filterMode} setFilterMode={setFilterMode} filterYear={filterYear} setFilterYear={setFilterYear} filterMonth={filterMonth} setFilterMonth={setFilterMonth} />

      {/* KPI Hub */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
        <div style={{ background: "linear-gradient(135deg, var(--bg3), var(--bg2))", padding: 20, borderRadius: 16, border: "1px solid var(--border)", borderTop: "3px solid var(--green)", boxShadow: "0 10px 30px rgba(0,0,0,0.3)" }}>
          <CompactStat label="Total Income" val={formatINR(netIncome)} col="var(--green)" bold />
        </div>
        <div style={{ background: "linear-gradient(135deg, var(--bg3), var(--bg2))", padding: 20, borderRadius: 16, border: "1px solid var(--border)", borderTop: "3px solid var(--red)", boxShadow: "0 10px 30px rgba(0,0,0,0.3)" }}>
          <CompactStat label="Total Expenses" val={formatINR(netExpense)} col="var(--red)" bold />
        </div>
        <div style={{ background: "linear-gradient(135deg, var(--bg3), var(--bg2))", padding: 20, borderRadius: 16, border: "1px solid var(--border)", borderTop: `3px solid ${netPL >= 0 ? "var(--green)" : "var(--red)"}`, boxShadow: "0 10px 30px rgba(0,0,0,0.3)" }}>
          <CompactStat label="Network Net P&L" val={M(netPL)} col={netPL >= 0 ? "var(--green)" : "var(--red)"} bold />
        </div>
        <div style={{ background: "linear-gradient(135deg, var(--bg3), var(--bg2))", padding: 20, borderRadius: 16, border: "1px solid var(--border)", borderTop: "3px solid var(--gold)", boxShadow: "0 10px 30px rgba(0,0,0,0.3)" }}>
          <CompactStat label="Profit Margin" val={isAdmin ? (netIncome > 0 ? (netPL / netIncome * 100).toFixed(1) + "%" : "0%") : MASK} col="var(--gold)" bold />
        </div>
      </div>

      {/* Breakdown Table */}
      <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 16, overflowX: "auto", boxShadow: "0 10px 40px rgba(0,0,0,0.4)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead style={{ background: "var(--bg3)", borderBottom: "1px solid var(--border)" }}>
            <tr>
              <TH>Branch</TH>
              {filterMode === "month" ? (
                <>
                  <TH right>Income</TH>
                  <TH right>Salary</TH>
                  <TH right>Incentives</TH>
                  <TH right>Fixed Cost</TH>
                  <TH right>Txns/CC</TH>
                  <TH right>Misc</TH>
                  <TH right>Total Exp</TH>
                  <TH right color="var(--gold)">Net P&L</TH>
                </>
              ) : (
                <>
                  {targetMonths.map(mon => (
                    <TH key={mon} right>{MONTHS[parseInt(mon.split("-")[1]) - 1]}<br/>Net P&L</TH>
                  ))}
                  <TH right>Income</TH>
                  <TH right>Expense</TH>
                  <TH right color="var(--gold)">Total P&L</TH>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {reportData.map((r, idx) => (
              <tr key={r.branch.id} style={{ borderBottom: "1px solid var(--border)", background: idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)" }}>
                <TD style={{ fontWeight: 700 }}>{r.branch.name}</TD>
                {filterMode === "month" ? (
                  <>
                    <TD right style={{ color: "var(--green)" }}>{formatINR(r.stats.income)}</TD>
                    <TD right style={{ color: "var(--gold)" }}>{isAdmin ? formatINR(r.stats.salary) : MASK}</TD>
                    <TD right>{formatINR(r.stats.incentives)}</TD>
                    <TD right>{formatINR(r.stats.fixed)}</TD>
                    <TD right>{formatINR(r.stats.txns + r.stats.cc)}</TD>
                    <TD right style={{ color: "var(--text3)" }}>{formatINR(r.stats.misc)}</TD>
                    <TD right style={{ color: "var(--red)" }}>{formatINR(r.stats.expense)}</TD>
                    <TD right style={{ fontWeight: 800, color: r.stats.pl >= 0 ? "var(--green)" : "var(--red)" }}>{M(r.stats.pl)}</TD>
                  </>
                ) : (
                  <>
                    {targetMonths.map(mon => {
                      const mPL = r.stats.monthlyNet[mon] || 0;
                      return <TD key={mon} right style={{ color: mPL >= 0 ? "var(--green)" : "var(--red)", fontSize: 11, fontWeight: 600 }}>{isAdmin ? formatINR(mPL) : "—"}</TD>;
                    })}
                    <TD right style={{ color: "var(--green)" }}>{formatINR(r.stats.income)}</TD>
                    <TD right style={{ color: "var(--red)" }}>{formatINR(r.stats.expense)}</TD>
                    <TD right style={{ fontWeight: 800, color: r.stats.pl >= 0 ? "var(--green)" : "var(--red)" }}>{M(r.stats.pl)}</TD>
                  </>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot style={{ background: "var(--bg3)", borderTop: "2px solid var(--border2)" }}>
            <tr style={{ fontWeight: 800 }}>
              <td style={{ padding: "16px 20px", color: "var(--gold)" }}>TOTAL NETWORK</td>
              {filterMode === "month" ? (
                <>
                  <td style={{ padding: 14, textAlign: "right", color: "var(--green)" }}>{formatINR(netIncome)}</td>
                  <td style={{ padding: 14, textAlign: "right", color: "var(--gold)" }}>{isAdmin ? formatINR(reportData.reduce((s, r) => s + r.stats.salary, 0)) : MASK}</td>
                  <td style={{ padding: 14, textAlign: "right" }}>{formatINR(reportData.reduce((s, r) => s + r.stats.incentives, 0))}</td>
                  <td style={{ padding: 14, textAlign: "right" }}>{formatINR(reportData.reduce((s, r) => s + r.stats.fixed, 0))}</td>
                  <td style={{ padding: 14, textAlign: "right" }}>{formatINR(reportData.reduce((s, r) => s + (r.stats.txns + r.stats.cc), 0))}</td>
                  <td style={{ padding: 14, textAlign: "right" }}>{formatINR(reportData.reduce((s, r) => s + r.stats.misc, 0))}</td>
                  <td style={{ padding: 14, textAlign: "right", color: "var(--red)" }}>{formatINR(netExpense)}</td>
                  <td style={{ padding: 14, textAlign: "right", color: netPL >= 0 ? "var(--green)" : "var(--red)", fontSize: 16 }}>{M(netPL)}</td>
                </>
              ) : (
                <>
                  {targetMonths.map(mon => {
                    const mNetPL = reportData.reduce((s, r) => s + (r.stats.monthlyNet[mon] || 0), 0);
                    return <td key={mon} style={{ padding: 14, textAlign: "right", color: mNetPL >= 0 ? "var(--green)" : "var(--red)", fontSize: 11 }}>{isAdmin ? formatINR(mNetPL) : "—"}</td>;
                  })}
                  <td style={{ padding: 14, textAlign: "right", color: "var(--green)" }}>{formatINR(netIncome)}</td>
                  <td style={{ padding: 14, textAlign: "right", color: "var(--red)" }}>{formatINR(netExpense)}</td>
                  <td style={{ padding: 14, textAlign: "right", color: netPL >= 0 ? "var(--green)" : "var(--red)", fontSize: 16 }}>{M(netPL)}</td>
                </>
              )}
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Shared / Head-Office Expenses — not part of per-branch P&L above.
          These are business-wide costs (HO rent, office electricity, cost centers)
          so admin can see them side-by-side without distorting the branch columns. */}
      {(() => {
        const sharedByMonth = targetMonths.map(mon => ({
          month: mon,
          rows: getSharedExpensesForMonth(mon),
        }));
        const totalShared = sharedByMonth.reduce((s, m) => s + m.rows.reduce((ss, r) => ss + r.amount, 0), 0);
        const flat = sharedByMonth.flatMap(m => m.rows.map(r => ({ ...r, _month: m.month })));
        if (flat.length === 0) return null;
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 10 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 800, color: "#d7a6ff", textTransform: "uppercase", letterSpacing: 2 }}>Head Office</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "var(--gold)", letterSpacing: 0.5, fontFamily: "var(--font-headline, var(--font-outfit))", marginTop: 2 }}>
                  Shared Expenses <span style={{ fontSize: 12, color: "var(--text3)", fontWeight: 600, marginLeft: 6 }}>· {flat.length} line{flat.length === 1 ? "" : "s"}</span>
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.2 }}>Total</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "var(--red)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{formatINR(totalShared)}</div>
              </div>
            </div>

            <Card style={{ padding: 0, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "var(--bg4)" }}>
                    <TH>Source</TH>
                    <TH>Month</TH>
                    <TH>Description</TH>
                    <TH>Note</TH>
                    <TH right>Amount</TH>
                  </tr>
                </thead>
                <tbody>
                  {flat.map(r => (
                    <tr key={r.id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <TD>
                        <Pill label={r.source === "cost_center" ? "Cost Center" : "Transaction"} color={r.source === "cost_center" ? "purple" : "blue"} />
                      </TD>
                      <TD style={{ color: "var(--text3)", fontSize: 11, fontWeight: 700, letterSpacing: 0.5 }}>{r._month}</TD>
                      <TD style={{ fontWeight: 600 }}>{r.label}</TD>
                      <TD style={{ color: "var(--text3)", fontSize: 11 }}>{r.note || "—"}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--red)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{formatINR(r.amount)}</TD>
                    </tr>
                  ))}
                  <tr style={{ background: "var(--bg3)", borderTop: "2px solid var(--border2)", fontWeight: 800 }}>
                    <TD style={{ color: "var(--gold)" }}>TOTAL</TD>
                    <TD></TD><TD></TD><TD></TD>
                    <TD right style={{ color: "var(--red)", fontSize: 15 }}>{formatINR(totalShared)}</TD>
                  </tr>
                </tbody>
              </table>
            </Card>
            <div style={{ fontSize: 11, color: "var(--text3)", lineHeight: 1.5, fontStyle: "italic" }}>
              Shared costs are informational only — they&apos;re not added into the per-branch Total Expenses above.
              Toggle, split, or absorb them via Master Setup → Transactions / Cost Centers.
            </div>
          </div>
        );
      })()}

      <div style={{ padding: "12px 20px", background: "rgba(255,255,255,0.03)", borderRadius: 12, border: "1px dashed var(--border)", fontSize: 11, color: "var(--text3)", lineHeight: 1.6 }}>
        <strong style={{ color: "var(--gold)" }}>AUDIT NOTES:</strong><br/>
        • Per-branch Total Expenses now mirrors the Dashboard&apos;s <strong>Operating Cost</strong>: Incentives + Material (flag-aware) + Other + Fixed + Salary + GST.<br/>
        • Shared costs — head-office rent, office electricity, cost centers, &quot;All branch&quot; transactions — are listed below in their own table and <strong>excluded</strong> from per-branch P&amp;L.<br/>
        • Salary is pro-rata based on join/exit dates and approved leaves; fixed costs read branch-master fields (shop / room rent, electricity, Wi-Fi).
      </div>
    </div>
  );
}
