"use client";
import { useEffect, useState, useMemo } from "react";
import { collection, onSnapshot, query, where, orderBy } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { INR } from "@/lib/calculations";
import { Card, TH, TD } from "@/components/ui";
import VLoader from "@/components/VLoader";

export default function IncentiveCalculatorPage() {
  const [entries, setEntries] = useState([]);
  const [branches, setBranches] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [mode, setMode] = useState("period");
  const [branchFilter, setBranchFilter] = useState("");
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setDate(1);
    return d.toISOString().slice(0, 10);
  });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "staff"), sn => { setStaff(sn.docs.map(d => ({ ...d.data(), id: d.id }))); setLoading(false); }),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  useEffect(() => {
    if (!db || !dateFrom || !dateTo) return;
    try {
      const q = query(
        collection(db, "entries"),
        where("date", ">=", dateFrom),
        where("date", "<=", dateTo),
        orderBy("date", "desc"),
      );
      const unsub = onSnapshot(q,
        sn => setEntries(sn.docs.map(d => ({ ...d.data(), id: d.id }))),
        err => { console.warn("Entries query error:", err); setError(err.message); }
      );
      return () => unsub();
    } catch (err) {
      console.warn("Entries query setup error:", err);
      setError(err.message);
    }
  }, [dateFrom, dateTo]);

  const branchesById = useMemo(() => new Map(branches.map(b => [b.id, b])), [branches]);
  const staffById = useMemo(() => new Map(staff.map(s => [s.id, s])), [staff]);

  const filtered = useMemo(() => {
    if (!branchFilter) return entries;
    return entries.filter(e => e.branch_id === branchFilter);
  }, [entries, branchFilter]);

  const incentiveData = useMemo(() => {
    const map = {};
    filtered.forEach(entry => {
      (entry.staff_billing || []).forEach(sb => {
        if (!sb.staff_id) return;
        const totalInc = (Number(sb.incentive) || 0) + (Number(sb.mat_incentive) || 0);
        if (totalInc <= 0) return;
        if (!map[sb.staff_id]) {
          const s = staffById.get(sb.staff_id);
          map[sb.staff_id] = {
            name: s?.name || sb.staff_id,
            role: s?.role || "",
            branch_id: sb.home_branch_id || s?.branch_id || "",
            incentive_pct: s?.incentive_pct ?? 10,
            totalIncentive: 0, takenIncentive: 0, pendingIncentive: 0,
            days: 0, entries: [],
          };
        }
        const d = map[sb.staff_id];
        d.totalIncentive += totalInc;
        const taken = sb.incentive_taken !== false;
        if (taken) d.takenIncentive += totalInc;
        else d.pendingIncentive += totalInc;
        d.days++;
        d.entries.push({ date: entry.date, branch: branchesById.get(entry.branch_id)?.name || "", billing: sb.billing || 0, incentive: totalInc, taken });
      });
    });
    return Object.entries(map).map(([id, d]) => ({ id, ...d }));
  }, [filtered, staffById, branchesById]);

  const periodCollectors = incentiveData.filter(d => d.pendingIncentive > 0);
  const dailyCollectors = incentiveData.filter(d => d.pendingIncentive === 0 && d.takenIncentive > 0);
  const displayed = mode === "daily" ? dailyCollectors : periodCollectors;
  const totalPending = displayed.reduce((s, d) => s + d.pendingIncentive, 0);
  const totalTaken = displayed.reduce((s, d) => s + d.takenIncentive, 0);
  const totalAll = displayed.reduce((s, d) => s + d.totalIncentive, 0);

  const [expandedStaff, setExpandedStaff] = useState(null);

  if (loading) return <VLoader fullscreen label="Loading Incentive Data" />;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 2 }}>Incentive</div>
        <div style={{ fontSize: 24, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>Incentive Calculator</div>
      </div>

      {error && (
        <div style={{ padding: 14, borderRadius: 10, background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)", color: "var(--red)", fontSize: 12, marginBottom: 16 }}>
          Query error: {error}. Entries may not load until a Firestore index is created.
        </div>
      )}

      <Card style={{ marginBottom: 20, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 3, background: "var(--bg4)", padding: 3, borderRadius: 10 }}>
            {[["period", "Period Collectors"], ["daily", "Daily Collectors"]].map(([val, label]) => (
              <button key={val} onClick={() => setMode(val)}
                style={{ padding: "8px 16px", borderRadius: 7, fontSize: 11, fontWeight: 700, border: "none", cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5, background: mode === val ? "linear-gradient(135deg, var(--accent), var(--gold2))" : "transparent", color: mode === val ? "#000" : "var(--text3)" }}>
                {label}
              </button>
            ))}
          </div>
          <select value={branchFilter} onChange={e => setBranchFilter(e.target.value)}
            style={{ padding: "8px 12px", border: "1px solid var(--border2)", borderRadius: 10, fontSize: 13, background: "var(--bg3)", color: "var(--text)", minWidth: 160 }}>
            <option value="">All Branches</option>
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>From:</span>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border2)", background: "var(--bg3)", color: "var(--text)", fontSize: 12 }} />
            <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>To:</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border2)", background: "var(--bg3)", color: "var(--text)", fontSize: 12 }} />
          </div>
        </div>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 20 }}>
        {[
          ["Staff", displayed.length, "var(--accent)"],
          ["Total Incentive", INR(totalAll), "var(--gold)"],
          [mode === "daily" ? "Taken (Daily)" : "Pending Payout", mode === "daily" ? INR(totalTaken) : INR(totalPending), mode === "daily" ? "var(--green)" : "var(--orange)"],
          ["Entries in Range", filtered.length, "var(--blue, #60a5fa)"],
        ].map(([l, v, c]) => (
          <Card key={l} style={{ padding: 14 }}>
            <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: c, marginTop: 4 }}>{v}</div>
          </Card>
        ))}
      </div>

      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", minWidth: 800, borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--bg4)" }}>
              <TH>Staff</TH><TH>Role</TH><TH>Branch</TH><TH>Rate</TH>
              <TH right>Days</TH><TH right>Total Incentive</TH><TH right>Taken</TH><TH right>Pending</TH><TH style={{ width: 30 }}></TH>
            </tr>
          </thead>
          <tbody>
            {displayed.length === 0 && (
              <tr><td colSpan={9} style={{ textAlign: "center", padding: 30, color: "var(--text3)", fontSize: 13 }}>No {mode === "daily" ? "daily" : "period"} collectors found in the selected range.</td></tr>
            )}
            {displayed.map(d => {
              const expanded = expandedStaff === d.id;
              const bName = (branchesById.get(d.branch_id)?.name || "—").replace("V-CUT ", "");
              return (
                <tr key={d.id} style={{ cursor: "pointer", borderBottom: "1px solid var(--border)" }} onClick={() => setExpandedStaff(expanded ? null : d.id)}>
                  <TD style={{ fontWeight: 700 }}>{d.name}</TD>
                  <TD style={{ color: "var(--text3)" }}>{d.role || "—"}</TD>
                  <TD>{bName}</TD>
                  <TD>{d.incentive_pct}%</TD>
                  <TD right>{d.days}</TD>
                  <TD right style={{ fontWeight: 700, color: "var(--gold)" }}>{INR(d.totalIncentive)}</TD>
                  <TD right style={{ color: "var(--green)" }}>{INR(d.takenIncentive)}</TD>
                  <TD right style={{ fontWeight: 800, color: d.pendingIncentive > 0 ? "var(--orange)" : "var(--text3)" }}>{d.pendingIncentive > 0 ? INR(d.pendingIncentive) : "—"}</TD>
                  <TD style={{ fontSize: 10, color: "var(--accent)" }}>{expanded ? "▲" : "▼"}</TD>
                </tr>
              );
            })}
            {displayed.length > 0 && (
              <tr style={{ background: "var(--bg3)", fontWeight: 700, borderTop: "2px solid var(--border2)" }}>
                <TD>TOTALS</TD><TD></TD><TD></TD><TD></TD>
                <TD right>{displayed.reduce((s, d) => s + d.days, 0)}</TD>
                <TD right style={{ color: "var(--gold)" }}>{INR(totalAll)}</TD>
                <TD right style={{ color: "var(--green)" }}>{INR(totalTaken)}</TD>
                <TD right style={{ color: "var(--orange)", fontWeight: 800 }}>{totalPending > 0 ? INR(totalPending) : "—"}</TD>
                <TD></TD>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {expandedStaff && (() => {
        const d = displayed.find(x => x.id === expandedStaff);
        if (!d) return null;
        return (
          <Card style={{ marginTop: 12, padding: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text)", marginBottom: 10 }}>{d.name} — Day-by-day breakdown</div>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
              <thead>
                <tr style={{ background: "var(--bg4)" }}>
                  <TH>Date</TH><TH>Branch</TH><TH right>Billing</TH><TH right>Incentive</TH><TH>Status</TH>
                </tr>
              </thead>
              <tbody>
                {d.entries.sort((a, b) => b.date.localeCompare(a.date)).map((e, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                    <TD>{e.date}</TD>
                    <TD>{(e.branch || "—").replace("V-CUT ", "")}</TD>
                    <TD right>{INR(e.billing)}</TD>
                    <TD right style={{ fontWeight: 700, color: "var(--gold)" }}>{INR(e.incentive)}</TD>
                    <TD>
                      <span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: e.taken ? "rgba(74,222,128,0.12)" : "rgba(251,146,60,0.12)", color: e.taken ? "var(--green)" : "var(--orange)" }}>
                        {e.taken ? "TAKEN" : "PENDING"}
                      </span>
                    </TD>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        );
      })()}
    </div>
  );
}
