"use client";
import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, orderBy, addDoc, deleteDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR, makeFilterPrefix, periodLabel, effectiveCashInHand } from "@/lib/calculations";
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
  const [selInit, setSelInit] = useState(false); // one-shot default/restore guard
  const [expanded, setExpanded] = useState(null); // branch_id whose daily view is open

  // Record-collection form state — batch mode, all branches at once.
  // `rows[branch_id]` carries the per-branch collected + reason for excess/less.
  // `denoms` is for the whole batch (a single denomination count for the pooled cash).
  const [showForm, setShowForm] = useState(false);
  const [branchSearch, setBranchSearch] = useState(""); // filters rows inside the record popup only
  const blankDenoms = useMemo(() => Object.fromEntries(DENOMS.map(d => [d, ""])), []);
  const [batchForm, setBatchForm] = useState({
    collected_on: new Date().toISOString().slice(0, 10),
    note: "",
    rows: {},
    denoms: blankDenoms,
  });
  const batchTotal = Object.values(batchForm.rows).reduce((s, r) => s + (Number(r?.collected) || 0), 0);
  const leftTotal = Object.values(batchForm.rows).reduce((s, r) => s + (Number(r?.leftInBranch) || 0), 0);
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
  // Concrete period bounds — used to compute each branch's opening balance
  // (everything that happened *before* periodStart). Custom range wins; else we
  // derive from filterMode. periodEnd is informational (the UI uses inPeriod).
  const periodStart = customRangeActive
    ? dateFrom
    : (filterMode === "month" ? `${filterPrefix}-01` : `${filterYear}-01-01`);
  const beforePeriod = (d) => d && d < periodStart;

  const allRows = branches.map(b => {
    const bEntries = entries.filter(e => e.branch_id === b.id && inPeriod(e.date));
    const cash = bEntries.reduce((s, e) => s + (e.cash || 0), 0);
    const online = bEntries.reduce((s, e) => s + (e.online || 0), 0);
    const cih = bEntries.reduce((s, e) => s + effectiveCashInHand(e), 0);

    // Opening Balance = everything the branch was holding *before* the period started.
    // It's the net of historical CIH minus historical collections. So when the weekly
    // range spans a month boundary, cash that accrued earlier still gets collected here.
    const priorCih = entries
      .filter(e => e.branch_id === b.id && beforePeriod(e.date))
      .reduce((s, e) => s + effectiveCashInHand(e), 0);
    const priorCollected = collections
      .filter(c => c.branch_id === b.id && beforePeriod(c.collected_on))
      .reduce((s, c) => s + (Number(c.amount) || 0), 0);
    const openingBalance = Math.max(0, priorCih - priorCollected);

    // Collections for this branch scoped to the same period as the entries.
    const bCollections = collections.filter(c => c.branch_id === b.id && inPeriod(c.collected_on));
    const fifoEntries = bEntries.map(e => ({ date: e.date, cih: effectiveCashInHand(e) }));
    const fifo = fifoConsume(fifoEntries, bCollections);
    const collectedInPeriod = bCollections.reduce((s, c) => s + (Number(c.amount) || 0), 0);
    const totalCash = openingBalance + cih; // physical cash the branch should be holding across the window

    return { b, entries: bEntries, cash, online, cih, collections: bCollections, fifo, collectedInPeriod, openingBalance, totalCash };
  });
  const branchRows = (selected.size === 0 ? allRows : allRows.filter(r => selected.has(r.b.id)))
    .slice()
    .sort((a, b) => a.b.name.localeCompare(b.b.name));

  // Per-row reconciliation for the Record Collection form. System Left is the
  // auto leftover (Total Cash − Collected); Diff compares the manually counted
  // leftover against it. Untouched rows contribute 0 to the diff totals.
  const rowCalc = (r) => {
    const st = batchForm.rows[r.b.id] || {};
    const collected = Number(st.collected) || 0;
    const left = Number(st.leftInBranch) || 0;
    const touched = (st.collected !== "" && st.collected !== undefined) || (st.leftInBranch !== "" && st.leftInBranch !== undefined);
    const autoLeft = r.totalCash - collected;
    const diff = touched ? left - autoLeft : 0;
    return { st, collected, left, touched, autoLeft, diff };
  };
  const diffTotal = branchRows.reduce((s, r) => s + rowCalc(r).diff, 0);
  const sumOpening = branchRows.reduce((s, r) => s + r.openingBalance, 0);
  const sumExpected = branchRows.reduce((s, r) => s + r.cih, 0);
  const sumTotalCash = branchRows.reduce((s, r) => s + r.totalCash, 0);
  // Search only narrows what's displayed in the popup — entered amounts stay
  // keyed by branch id, and the totals row keeps summing every branch.
  const modalRows = branchSearch.trim()
    ? branchRows.filter(r => r.b.name.toLowerCase().includes(branchSearch.trim().toLowerCase()))
    : branchRows;
  const hiddenTouched = branchSearch.trim()
    ? branchRows.filter(r => !modalRows.includes(r) && rowCalc(r).touched).length
    : 0;

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

  // Default: every branch checked. If a saved subset exists (from "Save"), restore
  // it instead. Runs once, after branches load.
  const BRANCHES_KEY = "vcut_cashcollection_branches";
  useEffect(() => {
    if (selInit || branches.length === 0) return;
    let saved = null;
    try { const raw = localStorage.getItem(BRANCHES_KEY); if (raw) saved = JSON.parse(raw); } catch {}
    const valid = Array.isArray(saved) ? saved.filter(id => branches.some(b => b.id === id)) : [];
    setSelected(new Set(valid.length ? valid : branches.map(b => b.id)));
    setSelInit(true);
  }, [branches, selInit]);

  const allSelected = branches.length > 0 && selected.size === branches.length;
  // Persist the current selection as the default. When all are ticked we clear
  // the saved subset so the page falls back to "all branches" again.
  const saveSelection = () => {
    try {
      if (allSelected || selected.size === 0) localStorage.removeItem(BRANCHES_KEY);
      else localStorage.setItem(BRANCHES_KEY, JSON.stringify([...selected]));
      toast({ title: "Saved", message: allSelected ? "All branches will show by default." : `${selected.size} branch${selected.size === 1 ? "" : "es"} saved as your default.`, type: "success" });
    } catch (err) {
      toast({ title: "Error", message: err.message, type: "error" });
    }
  };

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

  // ── Collection Slip ──
  // Opens a new window with a simple printable slip: one row per selected branch
  // with Expected / Collected / Carry-forward / Signature columns so the cashier
  // can fill it in on the visit and get each counter handler to sign.
  // Pass `autoPrint: true` to trigger the browser print dialog immediately; omit
  // (or false) to just preview the slip in a new tab.
  const openCollectionSlip = ({ autoPrint = false } = {}) => {
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
    if (autoPrint) {
      setTimeout(() => { try { w.focus(); w.print(); } catch { /* ignore */ } }, 350);
    } else {
      try { w.focus(); } catch { /* ignore */ }
    }
  };

  // ── Record Collection helpers ──
  const resetBatch = () => {
    setBranchSearch("");
    setBatchForm({
      collected_on: new Date().toISOString().slice(0, 10),
      note: "",
      rows: {},
      denoms: blankDenoms,
    });
  };

  const saveCollection = async () => {
    // Per-branch reconciliation totals — pulled from the current view so every
    // row knows its opening balance and in-period CIH.
    const rowInfo = new Map(branchRows.map(r => [r.b.id, { opening: r.openingBalance, expected: r.cih, total: r.totalCash }]));
    const entered = Object.entries(batchForm.rows)
      .map(([bid, r]) => ({
        bid,
        collected: Number(r?.collected) || 0,
        leftInBranch: Number(r?.leftInBranch) || 0,
        reason: (r?.reason || "").trim(),
      }))
      .filter(r => r.collected > 0 || r.leftInBranch > 0 || r.reason);
    const nonZero = entered.filter(r => r.collected > 0 || r.leftInBranch > 0);
    if (nonZero.length === 0) {
      toast({ title: "No amounts", message: "Enter a collected amount (or left-in-branch) for at least one branch.", type: "warning" });
      return;
    }
    // Excess/Less now compares physical reconciliation: (collected + left) vs total cash.
    const missingReason = nonZero.find(r => {
      const info = rowInfo.get(r.bid) || { total: 0 };
      const diff = (r.collected + r.leftInBranch) - info.total;
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
        period_start: periodStart,
        period_end: customRangeActive ? dateTo : null,
        total_amount: batchTotal,
        denoms: batchDenoms,
        note: batchForm.note?.trim() || "",
        branch_count: nonZero.length,
        created_at: new Date().toISOString(),
        created_by: currentUser?.name || "user",
      });
      await Promise.all(nonZero.map(r => {
        const branch = branches.find(b => b.id === r.bid);
        const info = rowInfo.get(r.bid) || { opening: 0, expected: 0, total: 0 };
        const autoLeft = info.total - r.collected;
        const excess = (r.collected + r.leftInBranch) - info.total; // = counted left − system left
        return addDoc(collection(db, "cash_collections"), {
          branch_id: r.bid,
          branch_name: branch?.name || "",
          collected_on: batchForm.collected_on,
          amount: r.collected,
          opening_balance: info.opening,
          expected: info.total,              // total cash the branch should have held in the window
          period_expected: info.expected,    // CIH accrued inside the window only
          left_in_branch: r.leftInBranch,    // manually counted leftover at the branch
          auto_left: autoLeft,               // system leftover: expected total − collected
          excess,
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
        .map(e => ({ label: e.date, cash: e.cash || 0, online: e.online || 0, cih: effectiveCashInHand(e) }));
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
        cih: mEntries.reduce((s, e) => s + effectiveCashInHand(e), 0),
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

      {/* Filters — custom range + quick presets + branch multi-select in one aligned card.
          A fixed-width label column keeps the two rows lined up instead of drifting. */}
      <Card style={{ marginTop: 12, marginBottom: 16, padding: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "12px 16px" }}>
          <div style={{ width: 128, flexShrink: 0, fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>
            Custom Range
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
          <div style={{ width: 1, alignSelf: "stretch", background: "var(--border2)", margin: "0 2px" }} />
          <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Quick</span>
          {[
            ["This week", () => applyWeek(0)],
            ["Last week", () => applyWeek(-1)],
            ["Last 7 days", () => applyRollingDays(7)],
            ["Last 14 days", () => applyRollingDays(14)],
            ["This month", applyThisMonth],
          ].map(([label, fn]) => (
            <button key={label} onClick={fn}
              style={{ padding: "6px 11px", borderRadius: 8, fontSize: 11, fontWeight: 700, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", cursor: "pointer" }}>
              {label}
            </button>
          ))}
          {customRangeActive && (
            <span style={{ fontSize: 11, color: "var(--accent)", fontWeight: 700, background: "rgba(var(--accent-rgb),0.12)", padding: "5px 10px", borderRadius: 7 }}>
              Active · overriding {filterMode === "month" ? "monthly" : "yearly"} filter
            </span>
          )}
          {!customRangeActive && (dateFrom || dateTo) && (
            <span style={{ fontSize: 11, color: "var(--text3)" }}>Pick both dates to apply</span>
          )}
        </div>

        <div style={{ borderTop: "1px solid var(--border)", display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap", padding: "12px 16px" }}>
          <div style={{ width: 128, flexShrink: 0, fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, paddingTop: 8 }}>
            Branches
            {selected.size > 0 && <div style={{ color: "var(--accent)", marginTop: 2, textTransform: "none", letterSpacing: 0.3 }}>{selected.size} selected</div>}
          </div>
          <div style={{ flex: "1 1 300px", display: "flex", flexWrap: "wrap", gap: 8 }}>
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
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            {!allSelected && (
              <button onClick={saveSelection} title="Remember this branch selection as your default"
                style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: 800, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}>
                <Icon name="save" size={12} /> Save
              </button>
            )}
            <button onClick={selectAll} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: 700, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", cursor: "pointer" }}>Select all</button>
            <button onClick={clearAll} disabled={selected.size === 0} style={{ padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: 700, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", cursor: selected.size === 0 ? "default" : "pointer", opacity: selected.size === 0 ? 0.4 : 1 }}>Clear</button>
          </div>
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
          <div style={{ display: "inline-flex", gap: 6 }}>
            <button onClick={() => openCollectionSlip({ autoPrint: false })} disabled={branchRows.length === 0}
              title="Open the slip in a new tab without triggering the print dialog"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 8, fontSize: 11, fontWeight: 800, letterSpacing: 0.5, background: branchRows.length === 0 ? "var(--bg4)" : "var(--bg3)", color: branchRows.length === 0 ? "var(--text3)" : "var(--accent)", border: `1px solid ${branchRows.length === 0 ? "var(--border)" : "rgba(var(--accent-rgb),0.4)"}`, cursor: branchRows.length === 0 ? "not-allowed" : "pointer", textTransform: "uppercase", opacity: branchRows.length === 0 ? 0.5 : 1 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
              Preview
            </button>
            <button onClick={() => openCollectionSlip({ autoPrint: true })} disabled={branchRows.length === 0}
              title="Open the slip and immediately trigger the print dialog"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 8, fontSize: 11, fontWeight: 800, letterSpacing: 0.5, background: branchRows.length === 0 ? "var(--bg4)" : "linear-gradient(135deg, var(--accent), var(--gold2))", color: branchRows.length === 0 ? "var(--text3)" : "#000", border: "none", cursor: branchRows.length === 0 ? "not-allowed" : "pointer", textTransform: "uppercase", opacity: branchRows.length === 0 ? 0.5 : 1 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 6 2 18 2 18 9"/>
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
                <rect x="6" y="14" width="12" height="8"/>
              </svg>
              Print Collection Slip
            </button>
          </div>
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
                  <TH right title="Manually counted leftover · system-computed leftover below it when they differ">Left at Branch</TH>
                  <TH right>Excess / Less</TH>
                  <TH>Reason</TH>
                  <TH>By</TH>
                  {canRecord && <TH style={{ width: 60, textAlign: "center" }}>Actions</TH>}
                </tr>
              </thead>
              <tbody>
                {periodCollections.length === 0 && (
                  <tr><td colSpan={canRecord ? 9 : 8} style={{ padding: 24, textAlign: "center", color: "var(--text3)" }}>No collections recorded for {plabel}.</td></tr>
                )}
                {periodCollections.map(c => {
                  const expected = Number(c.expected) || 0;
                  const excess = typeof c.excess === "number" ? c.excess : (Number(c.amount) || 0) - expected;
                  const excessLabel = excess > 0 ? `+${INR(excess)}` : excess < 0 ? `-${INR(Math.abs(excess))}` : "—";
                  const excessColor = excess > 0 ? "var(--green)" : excess < 0 ? "var(--red)" : "var(--text3)";
                  const countedLeft = typeof c.left_in_branch === "number" ? c.left_in_branch : null;
                  const autoLeft = typeof c.auto_left === "number" ? c.auto_left : (expected > 0 ? expected - (Number(c.amount) || 0) : null);
                  return (
                    <tr key={c.id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <TD style={{ fontWeight: 600 }}>{c.collected_on}</TD>
                      <TD>{(c.branch_name || branches.find(b => b.id === c.branch_id)?.name || "—").replace("V-CUT ", "")}</TD>
                      <TD right style={{ color: "var(--text3)" }}>{expected > 0 ? INR(expected) : "—"}</TD>
                      <TD right style={{ color: "var(--accent)", fontWeight: 800 }}>{INR(c.amount)}</TD>
                      <TD right>
                        <span style={{ color: countedLeft != null ? "var(--gold)" : "var(--text3)", fontWeight: countedLeft != null ? 700 : 500 }}>{countedLeft != null ? INR(countedLeft) : "—"}</span>
                        {countedLeft != null && autoLeft != null && countedLeft !== autoLeft && (
                          <div style={{ fontSize: 9.5, color: "var(--text3)", marginTop: 2 }}>sys {INR(autoLeft)}</div>
                        )}
                      </TD>
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
                    <TD right style={{ fontWeight: 800, color: "var(--gold)" }}>{INR(periodCollections.reduce((s, c) => s + (Number(c.left_in_branch) || 0), 0))}</TD>
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
      <Modal isOpen={showForm} onClose={() => setShowForm(false)} title="Record Cash Collection" width={1100}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "210px 1fr", gap: 12 }}>
            <div>
              <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Collected On *</label>
              <input type="date" value={batchForm.collected_on} onChange={e => setBatchForm(f => ({ ...f, collected_on: e.target.value }))}
                style={{ width: "100%", padding: "10px 12px", borderRadius: 10, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, marginTop: 5 }} />
            </div>
            <div>
              <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Note</label>
              <input type="text" placeholder="Collector name, handover reference, etc." value={batchForm.note} onChange={e => setBatchForm(f => ({ ...f, note: e.target.value }))}
                style={{ width: "100%", padding: "10px 12px", borderRadius: 10, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, marginTop: 5 }} />
            </div>
          </div>

          {/* Window banner — the reconciliation formula as chips instead of a wall of text */}
          <div style={{ padding: "12px 16px", borderRadius: 12, background: "var(--bg3)", border: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <div style={{ paddingRight: 14, borderRight: "1px solid var(--border2)" }}>
              <div style={{ fontSize: 9, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Window</div>
              <div style={{ fontSize: 13, fontWeight: 800, color: "var(--gold)", marginTop: 2, whiteSpace: "nowrap" }}>{plabel}</div>
            </div>
            {[
              ["Opening Bal.", sumOpening, "var(--orange)", `Uncollected before ${periodStart}`],
              ["+", null],
              ["This Window", sumExpected, "var(--gold)", "Cash-in-hand accrued in the window"],
              ["=", null],
              ["Total Cash", sumTotalCash, "var(--text)", "What branches should physically hold"],
            ].map(([label, value, color, sub], i) => value === null ? (
              <span key={i} style={{ fontSize: 16, fontWeight: 800, color: "var(--text3)" }}>{label}</span>
            ) : (
              <div key={i} style={{ minWidth: 120 }}>
                <div style={{ fontSize: 9, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>{label}</div>
                <div style={{ fontSize: 15, fontWeight: 800, color, marginTop: 2 }}>{INR(value)}</div>
                <div style={{ fontSize: 9.5, color: "var(--text3)", marginTop: 1 }}>{sub}</div>
              </div>
            ))}
          </div>

          {/* Per-branch rows */}
          <div style={{ border: "1px solid var(--border2)", borderRadius: 12, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg3)", flexWrap: "wrap" }}>
              <div style={{ position: "relative", flex: "1 1 220px", maxWidth: 320 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                  style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input type="text" placeholder="Search branch…" value={branchSearch}
                  onChange={e => setBranchSearch(e.target.value)}
                  style={{ width: "100%", padding: "8px 30px 8px 30px", borderRadius: 9, background: "var(--bg4)", border: `1px solid ${branchSearch ? "rgba(var(--accent-rgb),0.5)" : "var(--border2)"}`, color: "var(--text)", fontSize: 12.5, outline: "none" }}
                />
                {branchSearch && (
                  <button onClick={() => setBranchSearch("")} title="Clear search"
                    style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", width: 18, height: 18, borderRadius: "50%", border: "none", background: "var(--bg3)", color: "var(--text3)", cursor: "pointer", fontSize: 11, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
                    ✕
                  </button>
                )}
              </div>
              <span style={{ fontSize: 11, color: "var(--text3)" }}>
                {branchSearch.trim() ? `${modalRows.length} of ${branchRows.length} branches` : `${branchRows.length} branches`}
              </span>
              {hiddenTouched > 0 && (
                <span style={{ fontSize: 11, color: "var(--orange)", fontWeight: 700 }}>
                  {hiddenTouched} branch{hiddenTouched === 1 ? "" : "es"} with amounts hidden by search — still saved
                </span>
              )}
            </div>
            <div style={{ maxHeight: 380, overflowY: "auto", overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12, minWidth: 900 }}>
                <thead style={{ position: "sticky", top: 0, background: "var(--bg4)", zIndex: 1 }}>
                  <tr>
                    <TH>Branch</TH>
                    <TH right title="Opening balance + this window's cash-in-hand — what the branch should be holding">Total Cash</TH>
                    <TH right title="Cash taken by the collector">Collected</TH>
                    <TH right title="Auto-computed leftover: Total Cash − Collected. Click the value to copy it into Counted Left.">System Left <span style={{ fontSize: 8, color: "var(--accent)" }}>AUTO</span></TH>
                    <TH right title="Cash physically counted and left behind at the branch">Counted Left <span style={{ fontSize: 8, color: "var(--gold)" }}>MANUAL</span></TH>
                    <TH right title="Counted Left − System Left. Any mismatch needs a reason.">Diff vs Auto</TH>
                    <TH>Reason</TH>
                  </tr>
                </thead>
                <tbody>
                  {modalRows.length === 0 && (
                    <tr><td colSpan={7} style={{ padding: 24, textAlign: "center", color: "var(--text3)", fontSize: 12 }}>
                      {branchSearch.trim() ? <>No branch matches “{branchSearch.trim()}”.</> : <>No branches available for {plabel}.</>}
                    </td></tr>
                  )}
                  {modalRows.map(r => {
                    const { st: rowState, collected, left, touched, autoLeft, diff } = rowCalc(r);
                    const opening = r.openingBalance;
                    const expected = r.cih;
                    const total = r.totalCash;
                    const diffLabel = !touched ? "—" : diff > 0 ? `+${INR(diff)}` : diff < 0 ? `-${INR(Math.abs(diff))}` : "✓ Match";
                    const diffColor = !touched ? "var(--text3)" : diff > 0 ? "var(--green)" : diff < 0 ? "var(--red)" : "var(--green)";
                    const reasonRequired = touched && diff !== 0;
                    return (
                      <tr key={r.b.id} style={{ borderBottom: "1px solid var(--border)", background: touched ? "rgba(var(--accent-rgb),0.05)" : "transparent" }}>
                        <TD style={{ fontWeight: 700 }}>{r.b.name.replace("V-CUT ", "")}</TD>
                        <TD right>
                          <div style={{ color: "var(--text)", fontWeight: 800, fontSize: 13 }}>{INR(total)}</div>
                          <div style={{ fontSize: 9.5, color: "var(--text3)", marginTop: 1, whiteSpace: "nowrap" }}>
                            <span style={{ color: opening > 0 ? "var(--orange)" : "var(--text3)" }}>{opening > 0 ? INR(opening) : "₹0"}</span>
                            {" + "}
                            <span style={{ color: expected > 0 ? "var(--gold)" : "var(--text3)" }}>{expected > 0 ? INR(expected) : "₹0"}</span>
                          </div>
                        </TD>
                        <TD right style={{ padding: "8px" }}>
                          <input type="number" min="0" placeholder="0"
                            value={rowState.collected ?? ""}
                            onChange={e => {
                              const v = e.target.value;
                              // Auto-fill Counted Left with the system leftover until the user
                              // types their own count; clearing Collected clears the auto value.
                              setBatchForm(f => {
                                const prev = f.rows[r.b.id] || {};
                                const next = { ...prev, collected: v };
                                if (!prev.leftManual) {
                                  next.leftInBranch = v === "" ? "" : String(Math.max(0, total - (Number(v) || 0)));
                                }
                                return { ...f, rows: { ...f.rows, [r.b.id]: next } };
                              });
                            }}
                            style={{ width: 100, padding: "7px 9px", borderRadius: 8, background: "var(--bg3)", border: `1px solid ${collected > 0 ? "var(--accent)" : "var(--border)"}`, color: collected > 0 ? "var(--accent)" : "var(--text)", fontSize: 13, fontWeight: 700, outline: "none", textAlign: "right" }}
                          />
                        </TD>
                        <TD right>
                          <button
                            title="Click to copy into Counted Left"
                            onClick={() => setBatchForm(f => ({ ...f, rows: { ...f.rows, [r.b.id]: { ...(f.rows[r.b.id] || {}), leftInBranch: String(Math.max(0, autoLeft)), leftManual: false } } }))}
                            style={{ padding: "4px 8px", borderRadius: 7, fontSize: 12, fontWeight: 700, background: "transparent", border: "1px dashed var(--border2)", color: autoLeft > 0 ? "var(--text2)" : autoLeft < 0 ? "var(--red)" : "var(--text3)", cursor: "pointer" }}>
                            {INR(autoLeft)}
                          </button>
                        </TD>
                        <TD right style={{ padding: "8px" }}>
                          <input type="number" min="0" placeholder="0"
                            title={rowState.leftInBranch !== "" && rowState.leftInBranch !== undefined && !rowState.leftManual ? "Auto-calculated from Collected — type to override with your physical count" : undefined}
                            value={rowState.leftInBranch ?? ""}
                            onChange={e => setBatchForm(f => ({ ...f, rows: { ...f.rows, [r.b.id]: { ...(f.rows[r.b.id] || {}), leftInBranch: e.target.value, leftManual: e.target.value !== "" } } }))}
                            style={{ width: 100, padding: "7px 9px", borderRadius: 8, background: "var(--bg3)", border: `1px ${left > 0 && !rowState.leftManual ? "dashed" : "solid"} ${left > 0 ? "var(--gold)" : "var(--border)"}`, color: left > 0 ? "var(--gold)" : "var(--text)", fontSize: 13, fontWeight: 700, outline: "none", textAlign: "right" }}
                          />
                          {rowState.leftInBranch !== "" && rowState.leftInBranch !== undefined && (
                            <div style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: rowState.leftManual ? "var(--gold)" : "var(--text3)", marginTop: 2 }}>
                              {rowState.leftManual ? "manual" : "auto-filled"}
                            </div>
                          )}
                        </TD>
                        <TD right style={{ color: diffColor, fontWeight: touched ? 700 : 500, fontSize: touched && diff === 0 ? 11 : 12, whiteSpace: "nowrap" }}>{diffLabel}</TD>
                        <TD style={{ padding: "8px 10px" }}>
                          <input type="text"
                            placeholder={reasonRequired ? "Required — explain the diff" : "Optional"}
                            value={rowState.reason ?? ""}
                            onChange={e => setBatchForm(f => ({ ...f, rows: { ...f.rows, [r.b.id]: { ...(f.rows[r.b.id] || {}), reason: e.target.value } } }))}
                            style={{ width: "100%", minWidth: 140, padding: "7px 9px", borderRadius: 8, background: "var(--bg3)", border: `1px solid ${reasonRequired && !rowState.reason ? "var(--red)" : "var(--border)"}`, color: "var(--text)", fontSize: 12, outline: "none" }}
                          />
                        </TD>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ background: "var(--bg3)", borderTop: "2px solid var(--border2)" }}>
                    <TD style={{ fontWeight: 800, color: "var(--gold)", textTransform: "uppercase", letterSpacing: 0.5 }}>Totals</TD>
                    <TD right style={{ fontWeight: 800, color: "var(--text2)" }}>{INR(sumTotalCash)}</TD>
                    <TD right style={{ fontWeight: 800, color: "var(--accent)", fontSize: 14 }}>{INR(batchTotal)}</TD>
                    <TD right style={{ fontWeight: 700, color: "var(--text2)" }}>{INR(sumTotalCash - batchTotal)}</TD>
                    <TD right style={{ fontWeight: 800, color: "var(--gold)", fontSize: 14 }}>{INR(leftTotal)}</TD>
                    <TD right style={{ fontWeight: 800, color: diffTotal > 0 ? "var(--green)" : diffTotal < 0 ? "var(--red)" : "var(--text3)" }}>
                      {diffTotal === 0 ? "—" : diffTotal > 0 ? `+${INR(diffTotal)}` : `-${INR(Math.abs(diffTotal))}`}
                    </TD>
                    <TD></TD>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Batch-level denomination breakdown */}
          <div style={{ border: "1px solid var(--border2)", borderRadius: 12, padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
              <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Denomination of total collected</label>
              <span style={{ fontSize: 11, color: "var(--text3)" }}>
                Denom total = <span style={{ color: denomTotal === 0 ? "var(--text3)" : denomTotal === batchTotal ? "var(--green)" : "var(--red)", fontWeight: 800 }}>{INR(denomTotal)}</span>
                {denomTotal > 0 && denomTotal !== batchTotal && (
                  <span style={{ marginLeft: 6, color: "var(--red)" }}>≠ collected {INR(batchTotal)}</span>
                )}
                {denomTotal > 0 && denomTotal === batchTotal && (
                  <span style={{ marginLeft: 6, color: "var(--green)" }}>✓ matches</span>
                )}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))", gap: 8 }}>
              {DENOMS.map(d => {
                const count = Number(batchForm.denoms[d]) || 0;
                const sub = d * count;
                return (
                  <div key={d} style={{ background: "var(--bg4)", border: `1px solid ${count > 0 ? "rgba(var(--accent-rgb),0.4)" : "var(--border2)"}`, borderRadius: 10, padding: "8px 10px" }}>
                    <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, display: "flex", justifyContent: "space-between" }}>
                      <span>₹{d}</span>
                      {sub > 0 && <span style={{ color: "var(--accent)" }}>{INR(sub)}</span>}
                    </div>
                    <input
                      type="number" min="0" placeholder="0"
                      value={batchForm.denoms[d]}
                      onChange={e => setBatchForm(f => ({ ...f, denoms: { ...f.denoms, [d]: e.target.value } }))}
                      style={{ width: "100%", marginTop: 4, padding: "6px 8px", borderRadius: 7, background: "var(--bg3)", border: "1px solid var(--border)", color: "var(--text)", fontSize: 14, fontWeight: 700, outline: "none", textAlign: "right" }}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontSize: 11.5, color: "var(--text3)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 800, color: "var(--accent)" }}>{INR(batchTotal)}</span> collected
              <span>·</span>
              <span style={{ fontWeight: 800, color: "var(--gold)" }}>{INR(leftTotal)}</span> counted left at branches
              {diffTotal !== 0 && (
                <>
                  <span>·</span>
                  <span style={{ fontWeight: 800, color: diffTotal > 0 ? "var(--green)" : "var(--red)" }}>
                    Δ {diffTotal > 0 ? "+" : "-"}{INR(Math.abs(diffTotal))} vs system
                  </span>
                </>
              )}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setShowForm(false)}
                style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text3)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Cancel</button>
              <button onClick={saveCollection} disabled={batchTotal <= 0 && leftTotal <= 0}
                style={{ padding: "10px 22px", borderRadius: 10, background: (batchTotal <= 0 && leftTotal <= 0) ? "var(--bg4)" : "linear-gradient(135deg,var(--accent),var(--gold2))", color: (batchTotal <= 0 && leftTotal <= 0) ? "var(--text3)" : "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: (batchTotal <= 0 && leftTotal <= 0) ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
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
