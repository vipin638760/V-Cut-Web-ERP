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

  // Custom date range — when both are set, it overrides the month/year filter.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const customRangeActive = Boolean(dateFrom && dateTo);

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
  const plabel = customRangeActive
    ? `${dateFrom} → ${dateTo}`
    : periodLabel(filterMode, filterYear, filterMonth);
  const inPeriod = (d) => {
    if (!d) return false;
    if (customRangeActive) return d >= dateFrom && d <= dateTo;
    return filterMode === "month" ? d.startsWith(filterPrefix) : d.startsWith(String(filterYear));
  };

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

  // ── Quick date range helpers (Mon-Sun weeks + rolling windows) ──
  const iso = (d) => d.toISOString().slice(0, 10);
  const applyWeek = (offset = 0) => {
    const today = new Date();
    const dow = today.getDay(); // 0 = Sun, 1 = Mon, ... 6 = Sat
    const diffToMon = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(today);
    monday.setDate(today.getDate() + diffToMon + offset * 7);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    setDateFrom(iso(monday));
    setDateTo(iso(sunday));
  };
  const applyRollingDays = (n) => {
    const today = new Date();
    const from = new Date(today);
    from.setDate(today.getDate() - (n - 1));
    setDateFrom(iso(from));
    setDateTo(iso(today));
  };
  const applyThisMonth = () => {
    const today = new Date();
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    setDateFrom(iso(first));
    setDateTo(iso(today));
  };

  // ── Print Collection Slip ──
  // Opens a new window with a simple printable slip: one row per selected branch
  // with Expected / Collected / Carry-forward / Signature columns so the cashier
  // can fill it in on the visit and get each counter handler to sign.
  const printCollectionSlip = () => {
    if (branchRows.length === 0) return;
    const rowsHtml = branchRows.map((r, i) => `
      <tr>
        <td style="text-align:center;">${i + 1}</td>
        <td>${(r.b.name || "").replace(/</g, "&lt;")}</td>
        <td style="text-align:right;">${INR(r.cih)}</td>
        <td style="text-align:right;">&nbsp;</td>
        <td style="text-align:right;">&nbsp;</td>
        <td>&nbsp;</td>
      </tr>
    `).join("");
    const totalExpected = branchRows.reduce((s, r) => s + r.cih, 0);
    const collectorName = (currentUser?.name || "").replace(/</g, "&lt;");
    const printedOn = new Date().toLocaleString();
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>V-Cut Salon — Cash Collection Slip</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; color: #000; padding: 24px; font-size: 12px; }
    h1 { text-align: center; margin: 0 0 4px; font-size: 18px; letter-spacing: 1px; }
    .sub { text-align: center; color: #555; font-size: 11px; margin-bottom: 18px; }
    .meta { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
    .meta div { flex: 1; }
    .fill { display: inline-block; border-bottom: 1px solid #000; min-width: 180px; padding: 0 6px; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border: 1px solid #000; padding: 8px 10px; font-size: 12px; vertical-align: middle; }
    th { background: #f2f2f2; text-align: left; }
    tfoot td { font-weight: bold; background: #fafafa; }
    .sigs { margin-top: 36px; display: flex; justify-content: space-between; gap: 24px; }
    .sigs div { flex: 1; border-top: 1px solid #000; padding-top: 6px; text-align: center; font-size: 11px; }
    .note { margin-top: 18px; font-size: 10.5px; color: #555; line-height: 1.5; }
    .actions { margin-top: 20px; text-align: center; }
    .actions button { padding: 8px 18px; font-size: 12px; border: 1px solid #333; background: #f06464; color: #fff; border-radius: 4px; cursor: pointer; }
    @media print { .actions { display: none; } body { padding: 0; } }
  </style>
</head>
<body>
  <h1>V-CUT SALON — CASH COLLECTION SLIP</h1>
  <div class="sub">Printed on ${printedOn}</div>
  <div class="meta">
    <div>Period: <span class="fill">${plabel}</span></div>
    <div>Visit date: <span class="fill">&nbsp;</span></div>
    <div>Collector: <span class="fill">${collectorName || "&nbsp;"}</span></div>
  </div>
  <table>
    <thead>
      <tr>
        <th style="width:32px;text-align:center;">#</th>
        <th>Branch</th>
        <th style="width:110px;text-align:right;">Expected (₹)</th>
        <th style="width:110px;text-align:right;">Collected (₹)</th>
        <th style="width:110px;text-align:right;">Carry-fwd (₹)</th>
        <th style="width:150px;">Counter Signature</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
    <tfoot>
      <tr>
        <td colspan="2" style="text-align:right;">TOTAL</td>
        <td style="text-align:right;">${INR(totalExpected)}</td>
        <td style="text-align:right;">&nbsp;</td>
        <td style="text-align:right;">&nbsp;</td>
        <td>&nbsp;</td>
      </tr>
    </tfoot>
  </table>
  <div class="note">
    Collector fills the Collected amount at each branch; Carry-fwd = Expected − Collected. The counter handler signs against their branch row. The bottom signatures are for the collector and the HO cashier on handover.
  </div>
  <div class="sigs">
    <div>Collector Signature</div>
    <div>HO Cashier Signature</div>
  </div>
  <div class="actions">
    <button onclick="window.print()">Print slip</button>
  </div>
</body>
</html>`;
    const w = window.open("", "_blank", "width=900,height=800");
    if (!w) return;
    w.document.open();
    w.document.write(html);
    w.document.close();
    setTimeout(() => { try { w.focus(); w.print(); } catch { /* ignore */ } }, 350);
  };

  // Daily/monthly cashflow rows for a single branch in current period
  const flowRowsFor = (bEntries) => {
    if (customRangeActive || filterMode === "month") {
      // Daily rows — one per entry date in range
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

      {/* Custom date range — overrides the period widget when both dates are set */}
      <Card style={{ marginTop: 12, marginBottom: 12, padding: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>
            Custom range
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>From</label>
            <input type="date" value={dateFrom} max={dateTo || undefined} onChange={e => setDateFrom(e.target.value)}
              style={{ padding: "7px 10px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12 }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>To</label>
            <input type="date" value={dateTo} min={dateFrom || undefined} onChange={e => setDateTo(e.target.value)}
              style={{ padding: "7px 10px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12 }} />
          </div>
          {(dateFrom || dateTo) && (
            <button onClick={() => { setDateFrom(""); setDateTo(""); }}
              style={{ padding: "7px 12px", borderRadius: 8, fontSize: 11, fontWeight: 700, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", cursor: "pointer" }}>
              Clear
            </button>
          )}
          {customRangeActive && (
            <span style={{ fontSize: 11, color: "var(--accent)", fontWeight: 700, background: "rgba(var(--accent-rgb),0.12)", padding: "4px 10px", borderRadius: 6 }}>
              Active · overriding {filterMode === "month" ? "monthly" : "yearly"} filter
            </span>
          )}
          {!customRangeActive && (dateFrom || dateTo) && (
            <span style={{ fontSize: 11, color: "var(--text3)" }}>Pick both dates to apply</span>
          )}
        </div>
        {/* Quick presets — one-click week / rolling window selection */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, alignSelf: "center", marginRight: 4 }}>Quick:</span>
          {[
            ["This week", () => applyWeek(0)],
            ["Last week", () => applyWeek(-1)],
            ["Last 7 days", () => applyRollingDays(7)],
            ["Last 14 days", () => applyRollingDays(14)],
            ["This month", applyThisMonth],
          ].map(([label, fn]) => (
            <button key={label} onClick={fn}
              style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11, fontWeight: 700, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", cursor: "pointer" }}>
              {label}
            </button>
          ))}
        </div>
      </Card>

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
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", fontWeight: 700, color: "var(--gold)", fontSize: 12, textTransform: "uppercase", letterSpacing: 1, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span>Per-branch cash flow · {plabel}</span>
          <button onClick={printCollectionSlip} disabled={branchRows.length === 0}
            title="Open a printable cash collection slip for the current selection"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 8, fontSize: 11, fontWeight: 800, letterSpacing: 0.5, background: branchRows.length === 0 ? "var(--bg4)" : "linear-gradient(135deg, var(--accent), var(--gold2))", color: branchRows.length === 0 ? "var(--text3)" : "#000", border: "none", cursor: branchRows.length === 0 ? "not-allowed" : "pointer", textTransform: "uppercase", opacity: branchRows.length === 0 ? 0.5 : 1 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 6 2 18 2 18 9"/>
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
              <rect x="6" y="14" width="12" height="8"/>
            </svg>
            Print Collection Slip
          </button>
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
                          <span>{(customRangeActive || filterMode === "month") ? "Daily breakdown" : "Monthly breakdown"}</span>
                          <span style={{ color: "var(--text3)", textTransform: "none", letterSpacing: 0, fontSize: 10, fontWeight: 500 }}>{flow.length} row{flow.length === 1 ? "" : "s"}</span>
                        </div>
                        {flow.length === 0 ? (
                          <div style={{ padding: 16, color: "var(--text3)", fontSize: 11 }}>No entries in {plabel}</div>
                        ) : (
                          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 11.5 }}>
                            <thead>
                              <tr>
                                <TH>{(customRangeActive || filterMode === "month") ? "Date" : "Month"}</TH>
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
