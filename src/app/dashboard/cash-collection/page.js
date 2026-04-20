"use client";
import { useEffect, useState } from "react";
import { collection, onSnapshot, query, orderBy } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR, makeFilterPrefix, periodLabel } from "@/lib/calculations";
import { Card, PeriodWidget, TH, TD } from "@/components/ui";
import VLoader from "@/components/VLoader";

const NOW = new Date();

export default function CashCollectionPage() {
  const currentUser = useCurrentUser() || {};
  const canView = ["admin", "accountant"].includes(currentUser?.role);

  const [branches, setBranches] = useState([]);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);

  const [filterMode, setFilterMode] = useState("month");
  const [filterYear, setFilterYear] = useState(NOW.getFullYear());
  const [filterMonth, setFilterMonth] = useState(NOW.getMonth() + 1);

  const [selected, setSelected] = useState(new Set());
  const [expanded, setExpanded] = useState(null); // branch_id whose daily view is open

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(query(collection(db, "entries"), orderBy("date", "desc")), sn => {
        setEntries(sn.docs.map(d => ({ ...d.data(), id: d.id })));
        setLoading(false);
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  const filterPrefix = makeFilterPrefix(filterYear, filterMonth);
  const plabel = periodLabel(filterMode, filterYear, filterMonth);
  const inPeriod = (d) => filterMode === "month" ? d?.startsWith(filterPrefix) : d?.startsWith(String(filterYear));

  const allRows = branches.map(b => {
    const bEntries = entries.filter(e => e.branch_id === b.id && inPeriod(e.date));
    const cash = bEntries.reduce((s, e) => s + (e.cash || 0), 0);
    const online = bEntries.reduce((s, e) => s + (e.online || 0), 0);
    const cih = bEntries.reduce((s, e) => s + (e.cash_in_hand || 0), 0);
    return { b, entries: bEntries, cash, online, cih };
  });
  const branchRows = (selected.size === 0 ? allRows : allRows.filter(r => selected.has(r.b.id)))
    .slice()
    .sort((a, b) => a.b.name.localeCompare(b.b.name));

  const totals = branchRows.reduce((acc, r) => ({
    cash: acc.cash + r.cash,
    online: acc.online + r.online,
    cih: acc.cih + r.cih,
  }), { cash: 0, online: 0, cih: 0 });

  const toggle = (id) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const selectAll = () => setSelected(new Set(branches.map(b => b.id)));
  const clearAll = () => setSelected(new Set());

  // Daily/monthly cashflow rows for a single branch in current period
  const flowRowsFor = (bEntries) => {
    if (filterMode === "month") {
      return [...bEntries]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(e => ({ label: e.date, cash: e.cash || 0, online: e.online || 0, cih: e.cash_in_hand || 0 }));
    }
    const months = [];
    const currentYear = NOW.getFullYear();
    const currentMonth = NOW.getMonth() + 1;
    const endMonth = filterYear < currentYear ? 12 : (filterYear === currentYear ? currentMonth : 0);
    for (let m = 1; m <= endMonth; m++) {
      const monthPrefix = `${filterYear}-${String(m).padStart(2, '0')}`;
      const mEntries = bEntries.filter(e => e.date?.startsWith(monthPrefix));
      if (mEntries.length === 0) continue;
      months.push({
        label: new Date(filterYear, m - 1).toLocaleString('default', { month: 'short' }),
        cash: mEntries.reduce((s, e) => s + (e.cash || 0), 0),
        online: mEntries.reduce((s, e) => s + (e.online || 0), 0),
        cih: mEntries.reduce((s, e) => s + (e.cash_in_hand || 0), 0),
      });
    }
    return months;
  };

  if (!canView) return (
    <div style={{ padding: 40, textAlign: "center", color: "var(--red)" }}>Only admin and accountant can view Cash Collection.</div>
  );
  if (loading) return <VLoader fullscreen label="Loading cash flow…" />;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>Cash Collection</div>
        <span style={{ fontSize: 12, color: "var(--text3)" }}>Match bank deposits and track left-over branch cash for {plabel}</span>
      </div>

      <PeriodWidget filterMode={filterMode} setFilterMode={setFilterMode} filterYear={filterYear} setFilterYear={setFilterYear} filterMonth={filterMonth} setFilterMonth={setFilterMonth} />

      {/* Branch multi-select */}
      <Card style={{ marginTop: 12, marginBottom: 16, padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>
            Select branches {selected.size > 0 && <span style={{ color: "var(--accent)" }}>({selected.size} selected)</span>}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={selectAll} style={{ padding: "6px 12px", borderRadius: 7, fontSize: 11, fontWeight: 700, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", cursor: "pointer" }}>Select all</button>
            <button onClick={clearAll} disabled={selected.size === 0} style={{ padding: "6px 12px", borderRadius: 7, fontSize: 11, fontWeight: 700, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", cursor: selected.size === 0 ? "default" : "pointer", opacity: selected.size === 0 ? 0.4 : 1 }}>Clear</button>
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {branches.sort((a, b) => a.name.localeCompare(b.name)).map(b => {
            const on = selected.has(b.id);
            return (
              <button key={b.id} onClick={() => toggle(b.id)}
                style={{
                  padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: 700,
                  background: on ? "rgba(var(--accent-rgb),0.18)" : "var(--bg4)",
                  border: `1px solid ${on ? "rgba(var(--accent-rgb),0.5)" : "var(--border2)"}`,
                  color: on ? "var(--accent)" : "var(--text2)", cursor: "pointer",
                  display: "inline-flex", alignItems: "center", gap: 6,
                }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, border: `1.5px solid ${on ? "var(--accent)" : "var(--text3)"}`, background: on ? "var(--accent)" : "transparent", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {on && <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="4"><polyline points="20 6 9 17 4 12"/></svg>}
                </span>
                {b.name.replace("V-CUT ", "")}
              </button>
            );
          })}
        </div>
      </Card>

      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12, marginBottom: 16 }}>
        {[
          ["Total Cash Sales", INR(totals.cash), "var(--green)", "Received across all selected branches"],
          ["Total Online / UPI", INR(totals.online), "var(--blue, #60a5fa)", "Directly credited to accounts"],
          ["Cash In Hand (Left Over)", INR(totals.cih), totals.cih >= 0 ? "var(--gold)" : "var(--red)", "Still sitting at branches · to collect"],
        ].map(([l, v, c, sub]) => (
          <Card key={l} style={{ padding: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: c, marginTop: 6 }}>{v}</div>
            <div style={{ fontSize: 10.5, color: "var(--text3)", marginTop: 4 }}>{sub}</div>
          </Card>
        ))}
      </div>

      {/* Per-branch table with expandable daily view */}
      <Card style={{ overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", fontWeight: 700, color: "var(--gold)", fontSize: 12, textTransform: "uppercase", letterSpacing: 1 }}>
          Per-branch cash flow · {plabel}
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5, minWidth: 560 }}>
            <thead>
              <tr>
                <TH>Branch</TH>
                <TH right>Cash Sales</TH>
                <TH right>Online / UPI</TH>
                <TH right>Cash In Hand</TH>
                <TH style={{ width: 28 }}></TH>
              </tr>
            </thead>
            <tbody>
              {branchRows.length === 0 && (
                <tr><td colSpan={5} style={{ padding: 24, textAlign: "center", color: "var(--text3)" }}>No branch data in {plabel}</td></tr>
              )}
              {branchRows.flatMap(r => {
                const isOpen = expanded === r.b.id;
                const flow = isOpen ? flowRowsFor(r.entries) : [];
                const rows = [
                  <tr key={`row-${r.b.id}`} onClick={() => setExpanded(isOpen ? null : r.b.id)}
                    style={{ cursor: "pointer", borderBottom: "1px solid var(--border)" }}>
                    <TD style={{ fontWeight: 700 }}>{r.b.name}</TD>
                    <TD right style={{ color: "var(--green)" }}>{INR(r.cash)}</TD>
                    <TD right style={{ color: "var(--blue, #60a5fa)" }}>{INR(r.online)}</TD>
                    <TD right style={{ color: r.cih >= 0 ? "var(--gold)" : "var(--red)", fontWeight: 700 }}>{INR(r.cih)}</TD>
                    <TD style={{ fontSize: 10, color: "var(--accent)", textAlign: "center" }}>{isOpen ? "▲" : "▼"}</TD>
                  </tr>
                ];
                if (isOpen) {
                  rows.push(
                    <tr key={`detail-${r.b.id}`}>
                      <td colSpan={5} style={{ padding: 0, background: "var(--bg3)" }}>
                        <div style={{ padding: "10px 16px", fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <span>{filterMode === "month" ? "Daily breakdown" : "Monthly breakdown"}</span>
                          <span style={{ color: "var(--text3)", textTransform: "none", letterSpacing: 0, fontSize: 10, fontWeight: 500 }}>{flow.length} row{flow.length === 1 ? "" : "s"}</span>
                        </div>
                        {flow.length === 0 ? (
                          <div style={{ padding: 16, color: "var(--text3)", fontSize: 11 }}>No entries in {plabel}</div>
                        ) : (
                          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 11.5 }}>
                            <thead>
                              <tr>
                                <TH>{filterMode === "month" ? "Date" : "Month"}</TH>
                                <TH right>Cash Sales</TH>
                                <TH right>Online / UPI</TH>
                                <TH right>Cash In Hand</TH>
                                <TH style={{ width: 28 }}></TH>
                              </tr>
                            </thead>
                            <tbody>
                              {flow.map((row, i) => (
                                <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                                  <TD style={{ fontWeight: 600 }}>{row.label}</TD>
                                  <TD right style={{ color: "var(--green)" }}>{INR(row.cash)}</TD>
                                  <TD right style={{ color: "var(--blue, #60a5fa)" }}>{INR(row.online)}</TD>
                                  <TD right style={{ color: row.cih >= 0 ? "var(--gold)" : "var(--red)", fontWeight: 700 }}>{INR(row.cih)}</TD>
                                  <TD></TD>
                                </tr>
                              ))}
                              <tr style={{ background: "var(--bg4)" }}>
                                <TD style={{ fontWeight: 800, color: "var(--gold)" }}>TOTAL</TD>
                                <TD right style={{ fontWeight: 800, color: "var(--green)" }}>{INR(r.cash)}</TD>
                                <TD right style={{ fontWeight: 800, color: "var(--blue, #60a5fa)" }}>{INR(r.online)}</TD>
                                <TD right style={{ fontWeight: 800, color: "var(--gold)" }}>{INR(r.cih)}</TD>
                                <TD></TD>
                              </tr>
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  );
                }
                return rows;
              })}
              {branchRows.length > 0 && (
                <tr style={{ background: "var(--bg3)", borderTop: "2px solid var(--border2)" }}>
                  <TD style={{ fontWeight: 800, color: "var(--gold)" }}>TOTAL</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--green)" }}>{INR(totals.cash)}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--blue, #60a5fa)" }}>{INR(totals.online)}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--gold)" }}>{INR(totals.cih)}</TD>
                  <TD></TD>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
