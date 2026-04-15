"use client";
import { useEffect, useState, useRef } from "react";
import { db } from "@/lib/firebase";
import { collection, onSnapshot, query, orderBy } from "firebase/firestore";
import { INR, MASK, MONTHS, proRataSalary, staffStatusForMonth } from "@/lib/calculations";
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
  const [costCenters, setCostCenters] = useState([]);
  const [salaryHistory, setSalaryHistory] = useState([]);
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
      onSnapshot(collection(db, "cost_centers"), s => setCostCenters(s.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "salary_history"), s => setSalaryHistory(s.docs.map(d => ({ ...d.data(), id: d.id })))),
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

  // Helper: Get fallback-aware fixed costs
  const getMonthlyFixed = (bid, monthStr) => {
    const rec = monthlyExpenses.find(m => m.branch_id === bid && m.month === monthStr);
    const b = branches.find(x => x.id === bid);
    if (!b) return { shop_rent: 0, room_rent: 0, shop_elec: 0, room_elec: 0, wifi: 0, water: 0, petrol: 0, maid: 0, dust: 0 };
    const fv = (recVal, branchVal) => (recVal !== undefined && recVal !== null) ? recVal : (branchVal || 0);
    return {
      shop_rent: fv(rec?.shop_rent, b.shop_rent),
      room_rent: fv(rec?.room_rent, b.room_rent),
      shop_elec: fv(rec?.shop_elec, b.shop_elec),
      room_elec: fv(rec?.room_elec, b.room_elec),
      wifi: fv(rec?.wifi, b.wifi),
      water: fv(rec?.water, b.water),
      petrol: fv(rec?.petrol, b.petrol),
      maid: fv(rec?.maid, b.maid),
      dust: fv(rec?.dust, b.dust),
    };
  };

  // Helper: Get active months in year
  const getActiveMonths = (year) => {
    const isCurrentYear = year === now.getFullYear();
    const endMonth = isCurrentYear ? now.getMonth() + 1 : 12;
    const months = [];
    for (let m = 1; m <= endMonth; m++) months.push(`${year}-${String(m).padStart(2, "0")}`);
    return months;
  };

  // Helper: Core Calculation Engine (Legacy Port)
  const calculateBranchStats = (bid, month) => {
    const b = branches.find(x => x.id === bid);
    if (!b) return null;

    const periodEnts = entries.filter(e => e.branch_id === bid && e.date && e.date.startsWith(month));
    const periodTxns = transactions.filter(t => t.branch_id === bid && ((t.date && t.date.startsWith(month)) || (t.month === month)));
    
    // Income
    const entInc = periodEnts.reduce((s, e) => s + (e.online || 0) + (e.cash || 0), 0);
    const txnInc = periodTxns.filter(t => t.cat === "income").reduce((s, t) => s + (t.amount || 0), 0);
    const sharedInc = transactions.filter(t => t.branch_id === "all" && t.cat === "income" && ((t.date && t.date.startsWith(month)) || (t.month === month))).reduce((s, t) => s + (t.amount || 0), 0) / Math.max(branches.length, 1);
    const totalIncome = entInc + txnInc + sharedInc;

    // Direct Expenses
    const incentives = periodEnts.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.incentive || 0) + (sb.mat_incentive || 0), 0), 0);
    const matExp = periodEnts.reduce((s, e) => s + (e.mat_expense || 0), 0);
    
    // Fixed Expenses
    const mf = getMonthlyFixed(bid, month);
    const fixedCost = mf.shop_rent + mf.room_rent + mf.shop_elec + mf.room_elec + mf.wifi + mf.water + (mf.petrol || 0) + (mf.maid || 0) + (mf.dust || 0);

    // Staff Salaries
    const activeStaff = staff.filter(s => s.branch_id === bid && staffStatusForMonth(s, month).status !== "inactive");
    const salaries = activeStaff.reduce((s, st) => s + proRataSalary(st, month, branches, salaryHistory, staff, globalSettings), 0);

    // Misc & Petrol from entries
    const miscEnt = periodEnts.reduce((s, e) => s + (e.tips || 0) + (e.others || 0) + (e.petrol || 0), 0);
    
    // Transactions
    const txnExp = periodTxns.filter(t => t.cat !== "income").reduce((s, t) => s + (t.amount || 0), 0);
    const sharedExp = transactions.filter(t => t.branch_id === "all" && t.cat !== "income" && ((t.date && t.date.startsWith(month)) || (t.month === month))).reduce((s, t) => s + (t.amount || 0), 0) / Math.max(branches.length, 1);

    // Cost Centers
    const ccTotal = costCenters.reduce((s, cc) => s + (cc.monthly_cost || 0), 0) / Math.max(branches.length, 1);

    const totalExpense = incentives + matExp + fixedCost + salaries + miscEnt + txnExp + sharedExp + ccTotal;

    return {
      income: totalIncome,
      salary: salaries,
      incentives: incentives,
      fixed: fixedCost,
      txns: txnExp + sharedExp,
      misc: miscEnt + matExp,
      cc: ccTotal,
      expense: totalExpense,
      pl: totalIncome - totalExpense
    };
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

      <div style={{ padding: "12px 20px", background: "rgba(255,255,255,0.03)", borderRadius: 12, border: "1px dashed var(--border)", fontSize: 11, color: "var(--text3)", lineHeight: 1.6 }}>
        <strong style={{ color: "var(--gold)" }}>AUDIT NOTES:</strong><br/>
        • Network shared costs (Cost Centers & "All Branch" transactions) are divided across active branches.<br/>
        • Salary is calculated pro-rata based on join/exit dates and approved leaves.<br/>
        • Fixed costs are calculated from monthly bills, falling back to branch-level defaults where records are missing.
      </div>
    </div>
  );
}
