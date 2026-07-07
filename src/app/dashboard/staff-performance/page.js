"use client";
import { useEffect, useState, useMemo } from "react";
import { collection, onSnapshot, query, orderBy, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR, MONTHS, makeFilterPrefix, periodLabel, staffStatusForMonth, staffLeavesInMonth, proRataSalary, effectiveBranchOnDate, toTitleCase } from "@/lib/calculations";
import { PeriodWidget, Card, Pill, TH, TD, Icon, Modal, ToggleGroup } from "@/components/ui";
import VLoader from "@/components/VLoader";

const NOW = new Date();
const todayStr = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, "0")}-${String(NOW.getDate()).padStart(2, "0")}`;

// Sum a staff member's billing / incentive / material across a set of
// staff_billing rows. Incentive folds service + material incentive together to
// match staffIncentivesInPeriod's definition.
const rowTotals = (rows) => rows.reduce((a, x) => ({
  billing: a.billing + (Number(x.billing) || 0),
  incentive: a.incentive + (Number(x.incentive) || 0) + (Number(x.mat_incentive) || 0),
  material: a.material + (Number(x.material) || 0),
}), { billing: 0, incentive: 0, material: 0 });

export default function StaffPerformancePage() {
  const [branches, setBranches] = useState([]);
  const [staff, setStaff] = useState([]);
  const [entries, setEntries] = useState([]);
  const [leaves, setLeaves] = useState([]);
  const [salHistory, setSalHistory] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [globalSettings, setGlobalSettings] = useState(null);
  const [loading, setLoading] = useState(true);

  const [filterMode, setFilterMode] = useState("month");
  const [filterYear, setFilterYear] = useState(NOW.getFullYear());
  const [filterMonth, setFilterMonth] = useState(NOW.getMonth() + 1);

  const [search, setSearch] = useState("");
  const [sortCol, setSortCol] = useState("billing"); // billing | incentive | pct | name
  const [statusFilter, setStatusFilter] = useState("all"); // all | active | inactive
  const [typeFilter, setTypeFilter] = useState("all"); // all | mens | unisex
  const [selectedId, setSelectedId] = useState(null);

  const currentUser = useCurrentUser() || {};
  const isAdmin = currentUser?.role === "admin";

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "staff"), sn => setStaff(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "leaves"), sn => setLeaves(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "salary_history"), sn => setSalHistory(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "staff_transfers"), sn => setTransfers(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(doc(db, "settings", "global"), sn => setGlobalSettings(sn.data() || {})),
      onSnapshot(query(collection(db, "entries"), orderBy("date", "desc")), sn => {
        setEntries(sn.docs.map(d => ({ ...d.data(), id: d.id })));
        setLoading(false);
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  const filterPrefix = makeFilterPrefix(filterYear, filterMonth);
  const plabel = periodLabel(filterMode, filterYear, filterMonth);
  const isYearly = filterMode === "year";
  const factor = isYearly ? (filterYear === NOW.getFullYear() ? NOW.getMonth() + 1 : 12) : 1;
  // Active/inactive is measured for a single reference month: the selected month
  // in month mode, or the current month while viewing the running year.
  const statusMonth = isYearly ? `${filterYear}-${String(NOW.getMonth() + 1).padStart(2, "0")}` : filterPrefix;

  const branchesById = useMemo(() => {
    const m = new Map();
    branches.forEach(b => m.set(b.id, b));
    return m;
  }, [branches]);
  const branchName = (bid) => (branchesById.get(bid)?.name || "").replace("V-CUT ", "") || "—";

  const inPeriod = (dateStr) => {
    if (!dateStr) return false;
    return isYearly ? dateStr.startsWith(String(filterYear)) : dateStr.startsWith(filterPrefix);
  };

  // One pass over the period's entries → per-staff billing / incentive / material
  // + which days and branches they billed at.
  const periodAgg = useMemo(() => {
    const map = new Map();
    entries.forEach(e => {
      if (!inPeriod(e.date)) return;
      (e.staff_billing || []).forEach(sb => {
        if (!sb.staff_id) return;
        let a = map.get(sb.staff_id);
        if (!a) { a = { billing: 0, incentive: 0, material: 0, days: new Set(), branches: new Set() }; map.set(sb.staff_id, a); }
        a.billing += Number(sb.billing) || 0;
        a.incentive += (Number(sb.incentive) || 0) + (Number(sb.mat_incentive) || 0);
        a.material += Number(sb.material) || 0;
        a.days.add(e.date);
        if (e.branch_id) a.branches.add(e.branch_id);
      });
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, filterPrefix, filterMode, filterYear]);

  // Per-staff row for the selected period.
  const rows = useMemo(() => staff.map(s => {
    const agg = periodAgg.get(s.id) || { billing: 0, incentive: 0, material: 0, days: new Set(), branches: new Set() };

    let salary = 0, salaryFull = 0, leaveDays = 0;
    const startM = isYearly ? 1 : filterMonth;
    const endM = isYearly ? factor : filterMonth;
    for (let m = startM; m <= endM; m++) {
      const mp = `${filterYear}-${String(m).padStart(2, "0")}`;
      salary += proRataSalary(s, mp, branches, salHistory, staff, globalSettings, leaves, entries);
      // Final / full salary — the contractual base for every month the staff is
      // active, with no leave or partial-day proration applied.
      if (staffStatusForMonth(s, mp).status !== "inactive") salaryFull += Number(s.salary) || 0;
      leaveDays += staffLeavesInMonth(s.id, mp, leaves);
    }

    // Target = 3× the salary cost incurred so far (pro-rata). A stylist should
    // bill at least three times what they cost; as the period accrues, salary
    // and target grow together — e.g. ₹6,000 salary over 10 days → ₹18,000 target.
    const tgt = Math.round(salary * 3);
    const pct = tgt > 0 ? Math.min(Math.round(agg.billing / tgt * 100), 100) : 0;
    const shortfall = Math.max(0, tgt - agg.billing);

    const st = staffStatusForMonth(s, statusMonth);
    const branchId = effectiveBranchOnDate(s, todayStr, transfers) || s.branch_id;
    return {
      s, tgt, pct, shortfall, salary, salaryFull, leaveDays,
      billing: agg.billing, incentive: agg.incentive, material: agg.material,
      daysBilled: agg.days.size, branchesBilled: agg.branches.size,
      status: st.status, branchId,
    };
  }), [staff, periodAgg, branches, salHistory, globalSettings, leaves, entries, transfers, factor, filterMonth, filterYear, isYearly, statusMonth]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = rows;
    if (typeFilter !== "all") list = list.filter(r => branchesById.get(r.branchId)?.type === typeFilter);
    if (q) list = list.filter(r =>
      (r.s.name || "").toLowerCase().includes(q) ||
      branchName(r.branchId).toLowerCase().includes(q) ||
      (r.s.role || "").toLowerCase().includes(q));
    return [...list].sort((a, b) => {
      if (sortCol === "name") return (a.s.name || "").localeCompare(b.s.name || "");
      if (sortCol === "branch") return branchName(a.branchId).localeCompare(branchName(b.branchId)) || b.billing - a.billing;
      if (sortCol === "incentive") return b.incentive - a.incentive;
      if (sortCol === "pct") return b.pct - a.pct;
      return b.billing - a.billing;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, search, sortCol, typeFilter, branchesById]);

  const active = filtered.filter(r => r.status !== "inactive");
  const inactive = filtered.filter(r => r.status === "inactive");

  const typeOf = (r) => branchesById.get(r.branchId)?.type;
  const matchesSearch = (r, q) => !q
    || (r.s.name || "").toLowerCase().includes(q)
    || branchName(r.branchId).toLowerCase().includes(q)
    || (r.s.role || "").toLowerCase().includes(q);

  // Faceted counts — each control's numbers reflect the *other* filter plus the
  // search box, so the KPI band + Active/Inactive tallies follow whatever's
  // currently on screen (e.g. searching a branch scopes every total to it).
  const kpi = useMemo(() => {
    const q = search.trim().toLowerCase();
    const byType = rows.filter(r => (typeFilter === "all" || typeOf(r) === typeFilter) && matchesSearch(r, q));
    const act = byType.filter(r => r.status !== "inactive").length;
    return {
      totBill: byType.reduce((s, r) => s + r.billing, 0),
      totInc: byType.reduce((s, r) => s + r.incentive, 0),
      totSal: byType.reduce((s, r) => s + r.salary, 0),
      totSalFull: byType.reduce((s, r) => s + r.salaryFull, 0),
      totTgt: byType.reduce((s, r) => s + r.tgt, 0),
      totShort: byType.reduce((s, r) => s + r.shortfall, 0),
      act, inact: byType.length - act, total: byType.length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, typeFilter, branchesById, search]);

  const typeCounts = useMemo(() => {
    const q = search.trim().toLowerCase();
    const byStatus = rows.filter(r =>
      (statusFilter === "all" || (statusFilter === "active" ? r.status !== "inactive" : r.status === "inactive"))
      && matchesSearch(r, q));
    return {
      mens: byStatus.filter(r => typeOf(r) === "mens").length,
      unisex: byStatus.filter(r => typeOf(r) === "unisex").length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, statusFilter, branchesById, search]);

  const selected = selectedId ? staff.find(s => s.id === selectedId) : null;

  if (loading) return <VLoader fullscreen label="Loading Staff Performance" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 14 }}>
        <div>
          <h2 style={{ fontSize: 28, fontWeight: 950, color: "var(--text)", letterSpacing: -1, margin: 0 }}>Staff Performance</h2>
          <p style={{ fontSize: 12, color: "var(--text3)", fontWeight: 600, marginTop: 4 }}>
            Per-stylist billing, incentives & payroll · {plabel}
            {typeFilter !== "all" && <span style={{ color: typeFilter === "unisex" ? "#a855f7" : "var(--blue)", fontWeight: 800, textTransform: "capitalize" }}> · {typeFilter} only</span>}
          </p>
        </div>
        <PeriodWidget filterMode={filterMode} setFilterMode={setFilterMode} filterYear={filterYear} setFilterYear={setFilterYear} filterMonth={filterMonth} setFilterMonth={setFilterMonth} />
      </div>

      {/* KPI strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        <KpiTile label="Total Staff" value={kpi.total} color="var(--text)" />
        <KpiTile label="Active" value={kpi.act} color="var(--green)" sub={`in ${new Date(statusMonth + "-01").toLocaleDateString("en-US", { month: "short", year: "numeric" })}`} />
        <KpiTile label="Inactive" value={kpi.inact} color="var(--red)" sub={`in ${new Date(statusMonth + "-01").toLocaleDateString("en-US", { month: "short", year: "numeric" })}`} />
        <KpiTile label="Total Billing" value={INR(kpi.totBill)} color="var(--accent)" />
        <KpiTile label="Total Incentive" value={INR(kpi.totInc)} color="var(--gold)" />
        {isAdmin && <KpiTile label="Total Salary" value={INR(kpi.totSal)} color="var(--blue, #60a5fa)" sub="payroll cost · after proration" />}
        {isAdmin && <KpiTile label="Full Salary" value={INR(kpi.totSalFull)} color="var(--blue, #60a5fa)" sub="final · no proration" />}
        {isAdmin && <KpiTile label="Total Target" value={INR(kpi.totTgt)} color="var(--text)" sub="3× salary till date" />}
        {isAdmin && <KpiTile label="Target Shortfall" value={INR(kpi.totShort)} color={kpi.totShort > 0 ? "var(--red)" : "var(--green)"} sub={kpi.totShort > 0 ? "below 3× salary" : "target met ✓"} />}
      </div>

      {/* Controls */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: 1, maxWidth: 340, minWidth: 200 }}>
          <div style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--text3)", opacity: 0.6 }}><Icon name="search" size={15} /></div>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, branch or role…"
            style={{ width: "100%", background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px 10px 36px", color: "var(--text)", fontSize: 13, boxSizing: "border-box" }} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Show</span>
            <ToggleGroup options={[["all", `All (${kpi.total})`], ["active", `Active (${kpi.act})`], ["inactive", `Inactive (${kpi.inact})`]]} value={statusFilter} onChange={setStatusFilter}
              colors={{ all: "var(--blue)", active: "var(--green)", inactive: "var(--red)" }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Type</span>
            <ToggleGroup options={[["all", `All`], ["mens", `Mens (${typeCounts.mens})`], ["unisex", `Unisex (${typeCounts.unisex})`]]} value={typeFilter} onChange={setTypeFilter}
              colors={{ all: "var(--blue)", mens: "var(--blue)", unisex: "#a855f7" }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Sort</span>
            <ToggleGroup options={[["billing", "Billing"], ["incentive", "Incentive"], ["pct", "Target %"], ["name", "Name"], ["branch", "Branch"]]} value={sortCol} onChange={setSortCol} />
          </div>
        </div>
      </div>

      {/* Active section */}
      {statusFilter !== "inactive" && (
        <StaffSection title="Active" color="var(--green)" rows={active} isAdmin={isAdmin} branchName={branchName} onOpen={setSelectedId} />
      )}
      {/* Inactive section */}
      {statusFilter !== "active" && (
        <StaffSection title="Inactive" color="var(--red)" rows={inactive} isAdmin={isAdmin} branchName={branchName} onOpen={setSelectedId} />
      )}

      {/* Detail modal */}
      {selected && (
        <StaffHistoryModal
          staff={selected}
          entries={entries}
          branches={branches}
          branchesById={branchesById}
          branchName={branchName}
          transfers={transfers}
          leaves={leaves}
          salHistory={salHistory}
          globalSettings={globalSettings}
          staffList={staff}
          isAdmin={isAdmin}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function KpiTile({ label, value, color, sub }) {
  return (
    <Card style={{ padding: "16px 18px" }}>
      <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.2 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 900, color, marginTop: 4, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 600, marginTop: 2 }}>{sub}</div>}
    </Card>
  );
}

function StaffSection({ title, color, rows, isAdmin, branchName, onOpen }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />
        <h3 style={{ fontSize: 15, fontWeight: 800, color: "var(--text)", margin: 0, textTransform: "uppercase", letterSpacing: 1 }}>{title}</h3>
        <span style={{ fontSize: 11, fontWeight: 800, color, background: `${color}1a`, border: `1px solid ${color}44`, borderRadius: 20, padding: "2px 10px" }}>{rows.length} record{rows.length === 1 ? "" : "s"}</span>
      </div>
      {rows.length === 0 ? (
        <Card style={{ padding: 24, textAlign: "center", color: "var(--text3)", fontSize: 12, fontStyle: "italic" }}>No {title.toLowerCase()} staff for this period.</Card>
      ) : (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, minWidth: 720 }}>
              <thead>
                <tr>
                  <TH>Staff</TH><TH>Branch</TH><TH>Role</TH>
                  <TH right>Billing</TH><TH right>Incentive</TH><TH right>Material</TH>
                  {isAdmin && <TH right>Salary</TH>}
                  <TH right>Leaves</TH><TH right>Target</TH><TH right>Days</TH><TH></TH>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.s.id} onClick={() => onOpen(r.s.id)} style={{ cursor: "pointer", transition: "background .15s" }}
                    onMouseEnter={e => e.currentTarget.style.background = "var(--bg4)"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <TD style={{ fontWeight: 700 }}>
                      {toTitleCase(r.s.name)}
                      {r.status === "partial" && <Pill label="Partial" color="orange" />}
                    </TD>
                    <TD style={{ fontSize: 12, color: "var(--text3)", textTransform: "uppercase" }}>{branchName(r.branchId)}</TD>
                    <TD style={{ fontSize: 12, color: "var(--text3)" }}>{r.s.role || "—"}</TD>
                    <TD right style={{ color: "var(--accent)", fontWeight: 800 }}>{INR(r.billing)}</TD>
                    <TD right style={{ color: "var(--gold)", fontWeight: 700 }}>{INR(r.incentive)}</TD>
                    <TD right style={{ color: "#c084fc", fontWeight: 600 }}>{INR(r.material)}</TD>
                    {isAdmin && <TD right style={{ color: "var(--blue, #60a5fa)", fontWeight: 600 }}>{INR(r.salary)}</TD>}
                    <TD right style={{ color: "var(--text3)" }}>{r.leaveDays} d</TD>
                    <TD right>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                          <div style={{ width: 60, height: 5, background: "var(--border)", borderRadius: 6, overflow: "hidden" }}>
                            <div style={{ width: `${r.pct}%`, height: "100%", background: r.pct >= 100 ? "var(--green)" : "var(--blue, #60a5fa)" }} />
                          </div>
                          <span style={{ fontSize: 11, fontWeight: 800, color: r.pct >= 100 ? "var(--green)" : "var(--text2)" }}>{r.pct}%</span>
                        </div>
                        {isAdmin && r.tgt > 0 && (
                          <div style={{ fontSize: 10, fontWeight: 600, whiteSpace: "nowrap" }}>
                            <span style={{ color: "var(--text3)" }}>{INR(r.tgt)}</span>
                            {r.shortfall > 0
                              ? <span style={{ color: "var(--red)", fontWeight: 800 }}> · short {INR(r.shortfall)}</span>
                              : <span style={{ color: "var(--green)", fontWeight: 800 }}> · met ✓</span>}
                          </div>
                        )}
                      </div>
                    </TD>
                    <TD right style={{ color: "var(--text3)", fontSize: 12 }}>{r.daysBilled}</TD>
                    <TD right><span style={{ color: "var(--accent)", fontSize: 11, fontWeight: 800 }}>View →</span></TD>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

// Lifetime + month-by-month + branch-by-branch history for one staff member,
// scanning ALL entries (not just the selected period).
function StaffHistoryModal({ staff, entries, branchesById, branchName, transfers, leaves, salHistory, globalSettings, staffList, branches, isAdmin, onClose }) {
  const { byMonth, byBranch, lifetime } = useMemo(() => {
    const bm = new Map();   // 'YYYY-MM' → totals
    const bb = new Map();   // branchId → totals + span
    let life = { billing: 0, incentive: 0, material: 0, days: new Set() };
    entries.forEach(e => {
      if (!e.date) return;
      const mine = (e.staff_billing || []).filter(x => x.staff_id === staff.id);
      if (!mine.length) return;
      const t = rowTotals(mine);
      const mon = e.date.slice(0, 7);
      life.billing += t.billing; life.incentive += t.incentive; life.material += t.material; life.days.add(e.date);

      let mb = bm.get(mon);
      if (!mb) { mb = { billing: 0, incentive: 0, material: 0, days: new Set(), branches: new Set() }; bm.set(mon, mb); }
      mb.billing += t.billing; mb.incentive += t.incentive; mb.material += t.material; mb.days.add(e.date);
      if (e.branch_id) mb.branches.add(e.branch_id);

      if (e.branch_id) {
        let br = bb.get(e.branch_id);
        if (!br) { br = { billing: 0, incentive: 0, material: 0, days: new Set(), months: new Set(), first: e.date, last: e.date }; bb.set(e.branch_id, br); }
        br.billing += t.billing; br.incentive += t.incentive; br.material += t.material; br.days.add(e.date); br.months.add(mon);
        if (e.date < br.first) br.first = e.date;
        if (e.date > br.last) br.last = e.date;
      }
    });
    return { byMonth: bm, byBranch: bb, lifetime: life };
  }, [entries, staff.id]);

  const months = [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  const branchList = [...byBranch.entries()].sort((a, b) => b[1].billing - a[1].billing);

  const monthLabel = (mp) => {
    const [y, m] = mp.split("-").map(Number);
    return `${MONTHS[m - 1]} ${y}`;
  };
  const salaryForMonth = (mp) => isAdmin ? proRataSalary(staff, mp, branches, salHistory, staffList, globalSettings, leaves, entries) : 0;

  const currentBranch = effectiveBranchOnDate(staff, todayStr, transfers) || staff.branch_id;
  const st = staffStatusForMonth(staff, `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, "0")}`);

  return (
    <Modal isOpen={true} title={`${toTitleCase(staff.name)} · Full History`} onClose={onClose} width={920}>
      <div style={{ display: "flex", flexDirection: "column", gap: 18, maxHeight: "72vh", overflowY: "auto", padding: "2px 2px 4px" }}>
        {/* Profile chips */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <InfoChip label="Current branch" value={branchName(currentBranch)} />
          <InfoChip label="Role" value={staff.role || "—"} />
          <InfoChip label="Status (this month)" value={st.status} color={st.status === "inactive" ? "var(--red)" : st.status === "partial" ? "var(--orange)" : "var(--green)"} />
          <InfoChip label="Joined" value={staff.join || "—"} />
          {staff.exit_date && <InfoChip label="Exited" value={staff.exit_date} color="var(--red)" />}
          <InfoChip label="Target rule" value="3× salary" color="var(--accent)" />
        </div>

        {/* Lifetime totals */}
        <div>
          <SectionTitle>Lifetime</SectionTitle>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
            <KpiTile label="Total Billing" value={INR(lifetime.billing)} color="var(--accent)" />
            <KpiTile label="Total Incentive" value={INR(lifetime.incentive)} color="var(--gold)" />
            <KpiTile label="Material Sale" value={INR(lifetime.material)} color="#c084fc" />
            <KpiTile label="Days Billed" value={lifetime.days.size} color="var(--text)" />
            <KpiTile label="Branches Worked" value={byBranch.size} color="var(--blue, #60a5fa)" />
            <KpiTile label="Active Months" value={byMonth.size} color="var(--green)" />
          </div>
        </div>

        {/* Branches worked */}
        <div>
          <SectionTitle>Branches Worked ({branchList.length})</SectionTitle>
          <Card style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, minWidth: 640 }}>
                <thead><tr>
                  <TH>Branch</TH><TH right>Billing</TH><TH right>Incentive</TH><TH right>Material</TH><TH right>Days</TH><TH right>Months</TH><TH right>First</TH><TH right>Last</TH>
                </tr></thead>
                <tbody>
                  {branchList.map(([bid, v]) => (
                    <tr key={bid}>
                      <TD style={{ fontWeight: 700 }}>{branchName(bid)}</TD>
                      <TD right style={{ color: "var(--accent)", fontWeight: 700 }}>{INR(v.billing)}</TD>
                      <TD right style={{ color: "var(--gold)" }}>{INR(v.incentive)}</TD>
                      <TD right style={{ color: "#c084fc" }}>{INR(v.material)}</TD>
                      <TD right style={{ color: "var(--text3)" }}>{v.days.size}</TD>
                      <TD right style={{ color: "var(--text3)" }}>{v.months.size}</TD>
                      <TD right style={{ color: "var(--text3)", fontSize: 11 }}>{v.first}</TD>
                      <TD right style={{ color: "var(--text3)", fontSize: 11 }}>{v.last}</TD>
                    </tr>
                  ))}
                  {branchList.length === 0 && <tr><TD colSpan={8} style={{ textAlign: "center", color: "var(--text3)", fontStyle: "italic" }}>No billing history.</TD></tr>}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        {/* Month-by-month */}
        <div>
          <SectionTitle>Month-by-Month ({months.length})</SectionTitle>
          <Card style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, minWidth: 640 }}>
                <thead><tr>
                  <TH>Month</TH><TH right>Billing</TH><TH right>Incentive</TH><TH right>Material</TH>
                  {isAdmin && <TH right>Salary</TH>}<TH right>Days</TH><TH right>Leaves</TH><TH>Branches</TH>
                </tr></thead>
                <tbody>
                  {months.map(([mp, v]) => (
                    <tr key={mp}>
                      <TD style={{ fontWeight: 700 }}>{monthLabel(mp)}</TD>
                      <TD right style={{ color: "var(--accent)", fontWeight: 700 }}>{INR(v.billing)}</TD>
                      <TD right style={{ color: "var(--gold)" }}>{INR(v.incentive)}</TD>
                      <TD right style={{ color: "#c084fc" }}>{INR(v.material)}</TD>
                      {isAdmin && <TD right style={{ color: "var(--blue, #60a5fa)" }}>{INR(salaryForMonth(mp))}</TD>}
                      <TD right style={{ color: "var(--text3)" }}>{v.days.size}</TD>
                      <TD right style={{ color: "var(--text3)" }}>{staffLeavesInMonth(staff.id, mp, leaves)} d</TD>
                      <TD style={{ fontSize: 11, color: "var(--text3)" }}>{[...v.branches].map(branchName).join(", ") || "—"}</TD>
                    </tr>
                  ))}
                  {months.length === 0 && <tr><TD colSpan={isAdmin ? 8 : 7} style={{ textAlign: "center", color: "var(--text3)", fontStyle: "italic" }}>No monthly history.</TD></tr>}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>
    </Modal>
  );
}

function SectionTitle({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>{children}</div>;
}

function InfoChip({ label, value, color = "var(--text)" }) {
  return (
    <div style={{ padding: "6px 12px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border)" }}>
      <div style={{ fontSize: 8.5, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6 }}>{label}</div>
      <div style={{ fontSize: 12.5, fontWeight: 800, color, textTransform: label === "Role" || label.startsWith("Status") ? "capitalize" : "none" }}>{value}</div>
    </div>
  );
}
