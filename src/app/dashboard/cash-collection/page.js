"use client";
import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, orderBy, addDoc, deleteDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR, makeFilterPrefix, periodLabel } from "@/lib/calculations";
import { Card, PeriodWidget, TH, TD, Modal, ToggleGroup, Icon, IconBtn, useConfirm, useToast } from "@/components/ui";
import VLoader from "@/components/VLoader";

const NOW = new Date();
// Denominations in descending order — the order they're shown in the grid
// and used to auto-suggest counts if user wants to reverse-fill.
const DENOMS = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1];

// FIFO allocator: given a branch's entries (each with a date and cih) and a
// list of collections for that branch, consumes the oldest positive cih first.
// Returns per-date rows { date, cih, collected, outstanding } plus a rollup.
function fifoConsume(entries, collections) {
  const queue = entries
    .filter(e => (e.cih || 0) > 0)
    .map(e => ({ date: e.date, cih: e.cih, collected: 0, pending: e.cih }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const cols = [...collections].sort((a, b) => (a.collected_on || "").localeCompare(b.collected_on || ""));

  let overcollected = 0;
  for (const c of cols) {
    let remaining = Number(c.amount) || 0;
    for (const row of queue) {
      if (remaining <= 0) break;
      if (row.pending <= 0) continue;
      const take = Math.min(row.pending, remaining);
      row.pending -= take;
      row.collected += take;
      remaining -= take;
    }
    if (remaining > 0) overcollected += remaining;
  }

  const byDate = new Map(queue.map(r => [r.date, { cih: r.cih, collected: r.collected, outstanding: r.pending }]));
  const totals = queue.reduce((acc, r) => ({
    cih: acc.cih + r.cih,
    collected: acc.collected + r.collected,
    outstanding: acc.outstanding + r.pending,
  }), { cih: 0, collected: 0, outstanding: 0 });

  return { byDate, totals, overcollected };
}

export default function CashCollectionPage() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const currentUser = useCurrentUser() || {};
  const canView = ["admin", "accountant"].includes(currentUser?.role);
  const canRecord = currentUser?.role === "admin" || currentUser?.role === "accountant";

  const [branches, setBranches] = useState([]);
  const [entries, setEntries] = useState([]);
  const [collections, setCollections] = useState([]);
  const [loading, setLoading] = useState(true);

  const [tab, setTab] = useState("overview"); // 'overview' | 'record'

  const [filterMode, setFilterMode] = useState("month");
  const [filterYear, setFilterYear] = useState(NOW.getFullYear());
  const [filterMonth, setFilterMonth] = useState(NOW.getMonth() + 1);

  // Custom date range — when both are set, it overrides the month/year filter.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const customRangeActive = Boolean(dateFrom && dateTo);

  const [selected, setSelected] = useState(new Set());
  const [expanded, setExpanded] = useState(null); // branch_id whose daily view is open

  // Record-collection form state — batch mode, all branches at once.
  // `rows[branch_id]` carries the per-branch collected + reason for excess/less.
  // `denoms` is for the whole batch (a single denomination count for the pooled cash).
  const [showForm, setShowForm] = useState(false);
  const blankDenoms = useMemo(() => Object.fromEntries(DENOMS.map(d => [d, ""])), []);
  const [batchForm, setBatchForm] = useState({
    collected_on: new Date().toISOString().slice(0, 10),
    note: "",
    rows: {},
    denoms: blankDenoms,
  });
  const batchTotal = Object.values(batchForm.rows).reduce((s, r) => s + (Number(r?.collected) || 0), 0);
  const denomTotal = DENOMS.reduce((s, d) => s + d * (Number(batchForm.denoms[d]) || 0), 0);

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(query(collection(db, "entries"), orderBy("date", "desc")), sn => {
        setEntries(sn.docs.map(d => ({ ...d.data(), id: d.id })));
        setLoading(false);
      }),
      onSnapshot(collection(db, "cash_collections"), sn => setCollections(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
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

    // Collections for this branch scoped to the same period as the entries.
    const bCollections = collections.filter(c => c.branch_id === b.id && inPeriod(c.collected_on));
    const fifoEntries = bEntries.map(e => ({ date: e.date, cih: e.cash_in_hand || 0 }));
    const fifo = fifoConsume(fifoEntries, bCollections);
    const collectedInPeriod = bCollections.reduce((s, c) => s + (Number(c.amount) || 0), 0);

    return { b, entries: bEntries, cash, online, cih, collections: bCollections, fifo, collectedInPeriod };
  });
  const branchRows = (selected.size === 0 ? allRows : allRows.filter(r => selected.has(r.b.id)))
    .slice()
    .sort((a, b) => a.b.name.localeCompare(b.b.name));

  const totals = branchRows.reduce((acc, r) => ({
    cash: acc.cash + r.cash,
    online: acc.online + r.online,
    cih: acc.cih + r.cih,
    collected: acc.collected + r.collectedInPeriod,
    outstanding: acc.outstanding + r.fifo.totals.outstanding,
  }), { cash: 0, online: 0, cih: 0, collected: 0, outstanding: 0 });

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

  // ── Record Collection helpers ──
  const resetBatch = () => setBatchForm({
    collected_on: new Date().toISOString().slice(0, 10),
    note: "",
    rows: {},
    denoms: blankDenoms,
  });

  const saveCollection = async () => {
    const entered = Object.entries(batchForm.rows)
      .map(([bid, r]) => ({ bid, collected: Number(r?.collected) || 0, reason: (r?.reason || "").trim() }))
      .filter(r => r.collected > 0 || r.reason);
    const nonZero = entered.filter(r => r.collected > 0);
    if (nonZero.length === 0) {
      toast({ title: "No amounts", message: "Enter a collected amount for at least one branch.", type: "warning" });
      return;
    }
    // Expected per branch — used to auto-compute excess/less without making the
    // user type the diff themselves.
    const expectedByBranch = new Map(branchRows.map(r => [r.b.id, r.fifo.totals.outstanding]));
    const missingReason = nonZero.find(r => {
      const expected = expectedByBranch.get(r.bid) ?? 0;
      const diff = r.collected - expected;
      return diff !== 0 && !r.reason;
    });
    if (missingReason) {
      const name = branches.find(b => b.id === missingReason.bid)?.name || "branch";
      toast({ title: "Reason required", message: `Enter a reason for the excess/less on ${name}.`, type: "warning" });
      return;
    }
    if (denomTotal > 0 && denomTotal !== batchTotal) {
      toast({ title: "Denominations mismatch", message: `Total denomination (${INR(denomTotal)}) ≠ total collected (${INR(batchTotal)}). Fix the counts or clear them.`, type: "warning" });
      return;
    }
    try {
      const batchDenoms = Object.fromEntries(DENOMS.map(d => [String(d), Number(batchForm.denoms[d]) || 0]));
      const batchRef = await addDoc(collection(db, "cash_collection_batches"), {
        collected_on: batchForm.collected_on,
        total_amount: batchTotal,
        denoms: batchDenoms,
        note: batchForm.note?.trim() || "",
        branch_count: nonZero.length,
        created_at: new Date().toISOString(),
        created_by: currentUser?.name || "user",
      });
      await Promise.all(nonZero.map(r => {
        const branch = branches.find(b => b.id === r.bid);
        const expected = expectedByBranch.get(r.bid) ?? 0;
        return addDoc(collection(db, "cash_collections"), {
          branch_id: r.bid,
          branch_name: branch?.name || "",
          collected_on: batchForm.collected_on,
          amount: r.collected,
          expected,
          excess: r.collected - expected,
          reason: r.reason || "",
          note: batchForm.note?.trim() || "",
          batch_id: batchRef.id,
          created_at: new Date().toISOString(),
          created_by: currentUser?.name || "user",
        });
      }));
      toast({ title: "Batch saved", message: `${INR(batchTotal)} collected across ${nonZero.length} branch${nonZero.length === 1 ? "" : "es"}.`, type: "success" });
      resetBatch();
      setShowForm(false);
    } catch (err) {
      toast({ title: "Error", message: err.message, type: "error" });
    }
  };

  const deleteCollection = (c) => {
    confirm({
      title: "Delete collection",
      message: `Delete <strong>${INR(c.amount)}</strong> collected on ${c.collected_on} from ${c.branch_name || "branch"}?`,
      confirmText: "Delete", type: "danger",
      onConfirm: async () => {
        await deleteDoc(doc(db, "cash_collections", c.id));
        toast({ title: "Deleted", message: "Collection removed.", type: "success" });
      },
    });
  };

  // Collections scoped to the period for the Record tab's list.
  const periodCollections = collections
    .filter(c => inPeriod(c.collected_on))
    .filter(c => selected.size === 0 || selected.has(c.branch_id))
    .sort((a, b) => (b.collected_on || "").localeCompare(a.collected_on || ""));

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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>Cash Collection</div>
          <span style={{ fontSize: 12, color: "var(--text3)" }}>Match bank deposits and track left-over branch cash for {plabel}</span>
        </div>
        <ToggleGroup
          options={[["overview", "Overview"], ["record", "Record Collection"]]}
          value={tab}
          onChange={setTab}
        />
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
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 12, marginBottom: 16 }}>
        {[
          ["Total Cash Sales", INR(totals.cash), "var(--green)", "Received across all selected branches"],
          ["Total Online / UPI", INR(totals.online), "var(--blue, #60a5fa)", "Directly credited to accounts"],
          ["Cash In Hand (Left Over)", INR(totals.cih), totals.cih >= 0 ? "var(--gold)" : "var(--red)", "Still sitting at branches · to collect"],
          ["Collected", INR(totals.collected), "var(--accent)", `Recorded via ${periodCollections.length} collection${periodCollections.length === 1 ? "" : "s"} in this period`],
          ["Outstanding", INR(totals.outstanding), totals.outstanding > 0 ? "var(--red)" : "var(--green)", totals.outstanding > 0 ? "Pending — oldest days first" : "All cleared"],
        ].map(([l, v, c, sub]) => (
          <Card key={l} style={{ padding: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: c, marginTop: 6 }}>{v}</div>
            <div style={{ fontSize: 10.5, color: "var(--text3)", marginTop: 4 }}>{sub}</div>
          </Card>
        ))}
      </div>

      {tab === "overview" && (
      /* Per-branch table with expandable daily view */
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
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5, minWidth: 720 }}>
            <thead>
              <tr>
                <TH>Branch</TH>
                <TH right>Cash Sales</TH>
                <TH right>Online / UPI</TH>
                <TH right>Cash In Hand</TH>
                <TH right>Collected</TH>
                <TH right>Outstanding</TH>
                <TH style={{ width: 28 }}></TH>
              </tr>
            </thead>
            <tbody>
              {branchRows.length === 0 && (
                <tr><td colSpan={7} style={{ padding: 24, textAlign: "center", color: "var(--text3)" }}>No branch data in {plabel}</td></tr>
              )}
              {branchRows.flatMap(r => {
                const isOpen = expanded === r.b.id;
                const flow = isOpen ? flowRowsFor(r.entries) : [];
                const fullyCollected = r.fifo.totals.outstanding <= 0 && r.fifo.totals.cih > 0;
                const partial = r.collectedInPeriod > 0 && r.fifo.totals.outstanding > 0;
                const rows = [
                  <tr key={`row-${r.b.id}`} onClick={() => setExpanded(isOpen ? null : r.b.id)}
                    style={{ cursor: "pointer", borderBottom: "1px solid var(--border)" }}>
                    <TD style={{ fontWeight: 700 }}>
                      {r.b.name}
                      {partial && <span style={{ marginLeft: 8, fontSize: 9, fontWeight: 800, color: "var(--red)", background: "rgba(248,113,113,0.12)", padding: "2px 6px", borderRadius: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Partial</span>}
                      {fullyCollected && <span style={{ marginLeft: 8, fontSize: 9, fontWeight: 800, color: "var(--green)", background: "rgba(74,222,128,0.12)", padding: "2px 6px", borderRadius: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Cleared</span>}
                    </TD>
                    <TD right style={{ color: "var(--green)" }}>{INR(r.cash)}</TD>
                    <TD right style={{ color: "var(--blue, #60a5fa)" }}>{INR(r.online)}</TD>
                    <TD right style={{ color: r.cih >= 0 ? "var(--gold)" : "var(--red)", fontWeight: 700 }}>{INR(r.cih)}</TD>
                    <TD right style={{ color: "var(--accent)", fontWeight: 700 }}>{INR(r.collectedInPeriod)}</TD>
                    <TD right style={{ color: r.fifo.totals.outstanding > 0 ? "var(--red)" : "var(--green)", fontWeight: 700 }}>{INR(r.fifo.totals.outstanding)}</TD>
                    <TD style={{ fontSize: 10, color: "var(--accent)", textAlign: "center" }}>{isOpen ? "▲" : "▼"}</TD>
                  </tr>
                ];
                if (isOpen) {
                  rows.push(
                    <tr key={`detail-${r.b.id}`}>
                      <td colSpan={7} style={{ padding: 0, background: "var(--bg3)" }}>
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
                                <TH right>Collected</TH>
                                <TH right>Outstanding</TH>
                                <TH style={{ width: 28 }}></TH>
                              </tr>
                            </thead>
                            <tbody>
                              {flow.map((row, i) => {
                                const fromFifo = r.fifo.byDate.get(row.label);
                                const collected = fromFifo?.collected || 0;
                                const outstanding = fromFifo?.outstanding ?? (row.cih > 0 ? row.cih : 0);
                                return (
                                  <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                                    <TD style={{ fontWeight: 600 }}>{row.label}</TD>
                                    <TD right style={{ color: "var(--green)" }}>{INR(row.cash)}</TD>
                                    <TD right style={{ color: "var(--blue, #60a5fa)" }}>{INR(row.online)}</TD>
                                    <TD right style={{ color: row.cih >= 0 ? "var(--gold)" : "var(--red)", fontWeight: 700 }}>{INR(row.cih)}</TD>
                                    <TD right style={{ color: collected > 0 ? "var(--accent)" : "var(--text3)" }}>{collected > 0 ? INR(collected) : "—"}</TD>
                                    <TD right style={{ color: outstanding > 0 ? "var(--red)" : "var(--green)", fontWeight: outstanding > 0 ? 700 : 500 }}>{outstanding > 0 ? INR(outstanding) : "✓"}</TD>
                                    <TD></TD>
                                  </tr>
                                );
                              })}
                              <tr style={{ background: "var(--bg4)" }}>
                                <TD style={{ fontWeight: 800, color: "var(--gold)" }}>TOTAL</TD>
                                <TD right style={{ fontWeight: 800, color: "var(--green)" }}>{INR(r.cash)}</TD>
                                <TD right style={{ fontWeight: 800, color: "var(--blue, #60a5fa)" }}>{INR(r.online)}</TD>
                                <TD right style={{ fontWeight: 800, color: "var(--gold)" }}>{INR(r.cih)}</TD>
                                <TD right style={{ fontWeight: 800, color: "var(--accent)" }}>{INR(r.collectedInPeriod)}</TD>
                                <TD right style={{ fontWeight: 800, color: r.fifo.totals.outstanding > 0 ? "var(--red)" : "var(--green)" }}>{INR(r.fifo.totals.outstanding)}</TD>
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
                  <TD right style={{ fontWeight: 800, color: "var(--accent)" }}>{INR(totals.collected)}</TD>
                  <TD right style={{ fontWeight: 800, color: totals.outstanding > 0 ? "var(--red)" : "var(--green)" }}>{INR(totals.outstanding)}</TD>
                  <TD></TD>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      )}

      {tab === "record" && (
        <Card style={{ overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700, color: "var(--gold)", fontSize: 12, textTransform: "uppercase", letterSpacing: 1 }}>
              Recorded collections · {plabel} · {periodCollections.length} entr{periodCollections.length === 1 ? "y" : "ies"}
            </span>
            {canRecord && (
              <button onClick={() => { resetBatch(); setShowForm(true); }}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, fontSize: 11, fontWeight: 800, letterSpacing: 0.5, background: "linear-gradient(135deg, var(--accent), var(--gold2))", color: "#000", border: "none", cursor: "pointer", textTransform: "uppercase" }}>
                <Icon name="plus" size={13} /> Add Collection
              </button>
            )}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5, minWidth: 820 }}>
              <thead>
                <tr>
                  <TH>Date</TH>
                  <TH>Branch</TH>
                  <TH right>Expected</TH>
                  <TH right>Collected</TH>
                  <TH right>Excess / Less</TH>
                  <TH>Reason</TH>
                  <TH>By</TH>
                  {canRecord && <TH style={{ width: 60, textAlign: "center" }}>Actions</TH>}
                </tr>
              </thead>
              <tbody>
                {periodCollections.length === 0 && (
                  <tr><td colSpan={canRecord ? 8 : 7} style={{ padding: 24, textAlign: "center", color: "var(--text3)" }}>No collections recorded for {plabel}.</td></tr>
                )}
                {periodCollections.map(c => {
                  const expected = Number(c.expected) || 0;
                  const excess = typeof c.excess === "number" ? c.excess : (Number(c.amount) || 0) - expected;
                  const excessLabel = excess > 0 ? `+${INR(excess)}` : excess < 0 ? `-${INR(Math.abs(excess))}` : "—";
                  const excessColor = excess > 0 ? "var(--green)" : excess < 0 ? "var(--red)" : "var(--text3)";
                  return (
                    <tr key={c.id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <TD style={{ fontWeight: 600 }}>{c.collected_on}</TD>
                      <TD>{(c.branch_name || branches.find(b => b.id === c.branch_id)?.name || "—").replace("V-CUT ", "")}</TD>
                      <TD right style={{ color: "var(--text3)" }}>{expected > 0 ? INR(expected) : "—"}</TD>
                      <TD right style={{ color: "var(--accent)", fontWeight: 800 }}>{INR(c.amount)}</TD>
                      <TD right style={{ color: excessColor, fontWeight: excess !== 0 ? 700 : 500 }}>{excessLabel}</TD>
                      <TD style={{ color: "var(--text3)", fontSize: 11 }}>{c.reason || c.note || "—"}</TD>
                      <TD style={{ color: "var(--text3)", fontSize: 11 }}>{c.created_by || "—"}</TD>
                      {canRecord && (
                        <TD style={{ textAlign: "center" }}>
                          <IconBtn name="del" variant="danger" onClick={() => deleteCollection(c)} title="Delete" />
                        </TD>
                      )}
                    </tr>
                  );
                })}
                {periodCollections.length > 0 && (
                  <tr style={{ background: "var(--bg3)", borderTop: "2px solid var(--border2)" }}>
                    <TD style={{ fontWeight: 800, color: "var(--gold)" }}>TOTAL</TD>
                    <TD></TD>
                    <TD></TD>
                    <TD right style={{ fontWeight: 800, color: "var(--accent)" }}>{INR(periodCollections.reduce((s, c) => s + (Number(c.amount) || 0), 0))}</TD>
                    <TD right style={{ fontWeight: 800, color: "var(--text2)" }}>{(() => {
                      const sum = periodCollections.reduce((s, c) => s + (typeof c.excess === "number" ? c.excess : 0), 0);
                      return sum === 0 ? "—" : (sum > 0 ? `+${INR(sum)}` : `-${INR(Math.abs(sum))}`);
                    })()}</TD>
                    <TD></TD><TD></TD>
                    {canRecord && <TD></TD>}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Batch Record Collection — all branches at once */}
      <Modal isOpen={showForm} onClose={() => setShowForm(false)} title="Record Cash Collection" width={980}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 12 }}>
            <div>
              <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Collected On *</label>
              <input type="date" value={batchForm.collected_on} onChange={e => setBatchForm(f => ({ ...f, collected_on: e.target.value }))}
                style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, marginTop: 4 }} />
            </div>
            <div>
              <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Note</label>
              <input type="text" placeholder="Collector name, handover reference, etc." value={batchForm.note} onChange={e => setBatchForm(f => ({ ...f, note: e.target.value }))}
                style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, marginTop: 4 }} />
            </div>
          </div>

          {/* Per-branch rows */}
          <div style={{ border: "1px solid var(--border2)", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ maxHeight: 340, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
                <thead style={{ position: "sticky", top: 0, background: "var(--bg4)", zIndex: 1 }}>
                  <tr>
                    <TH>Branch</TH>
                    <TH right>Expected</TH>
                    <TH right>Collected</TH>
                    <TH right>Excess / Less</TH>
                    <TH>Reason</TH>
                  </tr>
                </thead>
                <tbody>
                  {branchRows.length === 0 && (
                    <tr><td colSpan={5} style={{ padding: 24, textAlign: "center", color: "var(--text3)", fontSize: 12 }}>No branches available for {plabel}.</td></tr>
                  )}
                  {branchRows.map(r => {
                    const rowState = batchForm.rows[r.b.id] || {};
                    const expected = r.fifo.totals.outstanding;
                    const collected = Number(rowState.collected) || 0;
                    const diff = rowState.collected !== "" && rowState.collected !== undefined ? collected - expected : 0;
                    const diffLabel = diff > 0 ? `+${INR(diff)}` : diff < 0 ? `-${INR(Math.abs(diff))}` : "—";
                    const diffColor = diff > 0 ? "var(--green)" : diff < 0 ? "var(--red)" : "var(--text3)";
                    const reasonRequired = diff !== 0;
                    return (
                      <tr key={r.b.id} style={{ borderBottom: "1px solid var(--border)" }}>
                        <TD style={{ fontWeight: 600 }}>{r.b.name.replace("V-CUT ", "")}</TD>
                        <TD right style={{ color: expected > 0 ? "var(--gold)" : "var(--text3)" }}>{expected > 0 ? INR(expected) : "—"}</TD>
                        <TD right style={{ padding: "6px 10px" }}>
                          <input type="number" min="0" placeholder="0"
                            value={rowState.collected ?? ""}
                            onChange={e => setBatchForm(f => ({ ...f, rows: { ...f.rows, [r.b.id]: { ...(f.rows[r.b.id] || {}), collected: e.target.value } } }))}
                            style={{ width: 110, padding: "6px 8px", borderRadius: 6, background: "var(--bg3)", border: `1px solid ${collected > 0 ? "var(--accent)" : "var(--border)"}`, color: collected > 0 ? "var(--accent)" : "var(--text)", fontSize: 13, fontWeight: 700, outline: "none", textAlign: "right" }}
                          />
                        </TD>
                        <TD right style={{ color: diffColor, fontWeight: diff !== 0 ? 700 : 500 }}>{diffLabel}</TD>
                        <TD style={{ padding: "6px 10px" }}>
                          <input type="text"
                            placeholder={reasonRequired ? "Required — explain the diff" : "Optional"}
                            value={rowState.reason ?? ""}
                            onChange={e => setBatchForm(f => ({ ...f, rows: { ...f.rows, [r.b.id]: { ...(f.rows[r.b.id] || {}), reason: e.target.value } } }))}
                            style={{ width: "100%", padding: "6px 8px", borderRadius: 6, background: "var(--bg3)", border: `1px solid ${reasonRequired && !rowState.reason ? "var(--red)" : "var(--border)"}`, color: "var(--text)", fontSize: 12, outline: "none" }}
                          />
                        </TD>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ background: "var(--bg3)", borderTop: "2px solid var(--border2)" }}>
                    <TD style={{ fontWeight: 800, color: "var(--gold)", textTransform: "uppercase", letterSpacing: 0.5 }}>Total Collected</TD>
                    <TD right style={{ fontWeight: 700, color: "var(--text3)" }}>{INR(branchRows.reduce((s, r) => s + r.fifo.totals.outstanding, 0))}</TD>
                    <TD right style={{ fontWeight: 800, color: "var(--accent)", fontSize: 14 }}>{INR(batchTotal)}</TD>
                    <TD right></TD><TD></TD>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Batch-level denomination breakdown */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Denomination of total collected</label>
              <span style={{ fontSize: 11, color: "var(--text3)" }}>
                Denom total = <span style={{ color: denomTotal === 0 ? "var(--text3)" : denomTotal === batchTotal ? "var(--green)" : "var(--red)", fontWeight: 800 }}>{INR(denomTotal)}</span>
                {denomTotal > 0 && denomTotal !== batchTotal && (
                  <span style={{ marginLeft: 6, color: "var(--red)" }}>≠ {INR(batchTotal)}</span>
                )}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 8 }}>
              {DENOMS.map(d => {
                const count = Number(batchForm.denoms[d]) || 0;
                const sub = d * count;
                return (
                  <div key={d} style={{ background: "var(--bg4)", border: "1px solid var(--border2)", borderRadius: 8, padding: "8px 10px" }}>
                    <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, display: "flex", justifyContent: "space-between" }}>
                      <span>₹{d}</span>
                      {sub > 0 && <span style={{ color: "var(--accent)" }}>{INR(sub)}</span>}
                    </div>
                    <input
                      type="number" min="0" placeholder="0"
                      value={batchForm.denoms[d]}
                      onChange={e => setBatchForm(f => ({ ...f, denoms: { ...f.denoms, [d]: e.target.value } }))}
                      style={{ width: "100%", marginTop: 4, padding: "6px 8px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--border)", color: "var(--text)", fontSize: 14, fontWeight: 700, outline: "none", textAlign: "right" }}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginTop: 6 }}>
            <div style={{ fontSize: 11, color: "var(--text3)" }}>
              Each branch saves as its own collection · FIFO applied per branch · denomination recorded against the whole batch.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setShowForm(false)}
                style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text3)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Cancel</button>
              <button onClick={saveCollection} disabled={batchTotal <= 0}
                style={{ padding: "10px 22px", borderRadius: 10, background: batchTotal <= 0 ? "var(--bg4)" : "linear-gradient(135deg,var(--accent),var(--gold2))", color: batchTotal <= 0 ? "var(--text3)" : "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: batchTotal <= 0 ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
                Save Batch
              </button>
            </div>
          </div>
        </div>
      </Modal>

      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}
