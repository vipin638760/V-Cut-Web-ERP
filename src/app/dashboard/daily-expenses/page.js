"use client";
import { useEffect, useState, useMemo } from "react";
import { collection, onSnapshot, query, where, orderBy, addDoc, deleteDoc, doc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR } from "@/lib/calculations";
import { Icon, IconBtn, Card, TH, TD, Modal, BranchSelect, SearchSelect, useConfirm, useToast } from "@/components/ui";
import VLoader from "@/components/VLoader";

// ExcelJS is lazy-loaded — ~200KB, only needed when the user hits Export.
let _excelJSPromise = null;
const loadExcelJS = () => {
  if (!_excelJSPromise) _excelJSPromise = import("exceljs").then(m => m.default || m);
  return _excelJSPromise;
};

export default function DailyExpensesPage() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const currentUser = useCurrentUser() || {};
  const canEdit = ["admin", "accountant"].includes(currentUser.role);

  const [branches, setBranches] = useState([]);
  const [expenseTypes, setExpenseTypes] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [branchFilter, setBranchFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [searchText, setSearchText] = useState("");
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setDate(1);
    return d.toISOString().slice(0, 10);
  });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10));

  // Table sorting
  const [sortBy, setSortBy] = useState("date");
  const [sortDir, setSortDir] = useState("desc");
  const toggleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortBy(col); setSortDir(col === "amount" || col === "date" ? "desc" : "asc"); }
  };

  // Drill-down (click on a breakdown card)
  const [drillType, setDrillType] = useState(null);

  // Form
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState({ date: new Date().toISOString().slice(0, 10), branch_id: "", expense_type: "", amount: "", note: "" });

  // New expense type inline
  const [showNewType, setShowNewType] = useState(false);
  const [newTypeName, setNewTypeName] = useState("");
  const [newTypeCat, setNewTypeCat] = useState("operations");

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "expense_types"), sn => setExpenseTypes(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  // Fetch daily expenses by date range
  useEffect(() => {
    if (!db || !dateFrom || !dateTo) return;
    setLoading(true);
    const q = query(
      collection(db, "daily_expenses"),
      where("date", ">=", dateFrom),
      where("date", "<=", dateTo),
      orderBy("date", "desc"),
    );
    const unsub = onSnapshot(q,
      sn => { setExpenses(sn.docs.map(d => ({ ...d.data(), id: d.id }))); setLoading(false); },
      () => { setExpenses([]); setLoading(false); }
    );
    return () => unsub();
  }, [dateFrom, dateTo]);

  const branchesById = useMemo(() => new Map(branches.map(b => [b.id, b])), [branches]);
  const activeTypes = expenseTypes.filter(t => t.active !== false).map(t => t.name).sort();

  // Branch + date scoped list — the breakdown cards aggregate from this,
  // so toggling the type filter never hides the other cards.
  const scoped = useMemo(() => {
    return branchFilter ? expenses.filter(e => e.branch_id === branchFilter) : expenses;
  }, [expenses, branchFilter]);

  // Table-visible list — adds type + free-text search on top of scoped.
  const filtered = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return scoped.filter(e => {
      if (typeFilter && e.expense_type !== typeFilter) return false;
      if (!q) return true;
      const hay = [
        e.expense_type,
        e.branch_name || branchesById.get(e.branch_id)?.name || "",
        e.note,
        e.created_by,
        String(e.amount || ""),
        e.date,
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [scoped, typeFilter, searchText, branchesById]);

  // Aggregate by type — from scoped (not typeFilter-affected) so the breakdown
  // cards always show every type, even if the user has clicked into one.
  const byType = useMemo(() => {
    const map = {}, counts = {};
    scoped.forEach(e => {
      const t = e.expense_type || "Other";
      map[t] = (map[t] || 0) + (Number(e.amount) || 0);
      counts[t] = (counts[t] || 0) + 1;
    });
    return Object.entries(map)
      .map(([type, amt]) => ({ type, amt, count: counts[type] || 0 }))
      .sort((a, b) => b.amt - a.amt);
  }, [scoped]);

  // Sorted list for the table.
  const sorted = useMemo(() => {
    const arr = [...filtered];
    const dir = sortDir === "asc" ? 1 : -1;
    const nameOf = (e) => e.branch_name || branchesById.get(e.branch_id)?.name || "";
    arr.sort((a, b) => {
      let av, bv;
      switch (sortBy) {
        case "branch": av = nameOf(a); bv = nameOf(b); break;
        case "type":   av = a.expense_type || ""; bv = b.expense_type || ""; break;
        case "amount": av = Number(a.amount) || 0; bv = Number(b.amount) || 0; break;
        case "by":     av = a.created_by || ""; bv = b.created_by || ""; break;
        case "note":   av = a.note || ""; bv = b.note || ""; break;
        case "date":
        default:       av = a.date || ""; bv = b.date || ""; break;
      }
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return arr;
  }, [filtered, sortBy, sortDir, branchesById]);

  // Drill-down entries — the rows behind a clicked breakdown card.
  const drillEntries = useMemo(() => {
    if (!drillType) return [];
    return scoped
      .filter(e => e.expense_type === drillType)
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  }, [scoped, drillType]);
  const drillTotal = drillEntries.reduce((s, e) => s + (Number(e.amount) || 0), 0);

  const totalAmount = filtered.reduce((s, e) => s + (Number(e.amount) || 0), 0);

  const handleSave = async () => {
    if (!form.branch_id || !form.expense_type || !form.amount || !form.date) {
      toast({ title: "Incomplete", message: "Fill all required fields.", type: "warning" });
      return;
    }
    try {
      const payload = {
        date: form.date,
        branch_id: form.branch_id,
        branch_name: branchesById.get(form.branch_id)?.name || "",
        expense_type: form.expense_type,
        amount: Number(form.amount) || 0,
        note: form.note?.trim() || "",
        ...(editId ? { updated_at: new Date().toISOString(), updated_by: currentUser?.name || "user" }
                    : { created_at: new Date().toISOString(), created_by: currentUser?.name || "user" }),
      };
      if (editId) {
        await updateDoc(doc(db, "daily_expenses", editId), payload);
        toast({ title: "Updated", message: "Expense updated.", type: "success" });
      } else {
        await addDoc(collection(db, "daily_expenses"), payload);
        toast({ title: "Saved", message: `${form.expense_type} — ${INR(Number(form.amount))} added.`, type: "success" });
      }
      setForm({ date: form.date, branch_id: form.branch_id, expense_type: "", amount: "", note: "" });
      setEditId(null);
      setShowForm(false);
    } catch (err) {
      toast({ title: "Error", message: err.message, type: "error" });
    }
  };

  const handleDelete = (e) => {
    confirm({
      title: "Delete Expense",
      message: `Delete <strong>${e.expense_type}</strong> — ${INR(e.amount)} on ${e.date}?`,
      confirmText: "Delete", type: "danger",
      onConfirm: async () => {
        await deleteDoc(doc(db, "daily_expenses", e.id));
        toast({ title: "Deleted", message: "Expense removed.", type: "success" });
      },
    });
  };

  const handleEdit = (e) => {
    setForm({ date: e.date, branch_id: e.branch_id, expense_type: e.expense_type, amount: e.amount, note: e.note || "" });
    setEditId(e.id);
    setShowForm(true);
  };

  // Excel export — respects the current filters (branch, type, search, date range).
  // Sheets:
  //   • All Expenses — flat list
  //   • By Category — type rollups grouped under their category
  //   • By Branch — type rollups grouped per branch
  //   • One sheet per category (e.g. "Fixed", "Operations") — full detail rows for that group
  const [exporting, setExporting] = useState(false);
  const exportToExcel = async () => {
    if (filtered.length === 0) return;
    setExporting(true);
    try {
      const ExcelJS = await loadExcelJS();
      const wb = new ExcelJS.Workbook();

      const typeCategory = new Map(expenseTypes.map(t => [t.name, (t.category || "other").toLowerCase()]));
      const catOf = (e) => typeCategory.get(e.expense_type) || "other";
      const rangeLabel = `${dateFrom} → ${dateTo}`;

      const hdrFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF065F46" } };
      const hdrFont = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      const totalFont = { bold: true, size: 12 };
      const totalBorder = { top: { style: "double" } };

      const writeHeader = (ws, headers) => {
        const row = ws.addRow(headers);
        row.eachCell(cell => { cell.font = hdrFont; cell.fill = hdrFill; cell.alignment = { horizontal: "center" }; });
        ws.columns = headers.map(() => ({ width: 16 }));
      };

      const writeTotalsRow = (ws, label, sumColLetters, lastDataRow) => {
        const cells = [label, ...Array(sumColLetters.length).fill(null)];
        const row = ws.addRow(cells);
        sumColLetters.forEach((col, i) => {
          const c = row.getCell(i + 2);
          c.value = { formula: `SUM(${col}2:${col}${lastDataRow})` };
          c.numFmt = "#,##0";
        });
        row.eachCell(c => { c.font = totalFont; c.border = totalBorder; });
      };

      // ── 1. All Expenses (flat) ──
      const flatWs = wb.addWorksheet("All Expenses");
      writeHeader(flatWs, ["Date","Branch","Category","Type","Amount","Note","By"]);
      const sortedFlat = [...filtered].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      sortedFlat.forEach(e => {
        const branchName = e.branch_name || branchesById.get(e.branch_id)?.name || "?";
        const r = flatWs.addRow([e.date, branchName, catOf(e), e.expense_type, Number(e.amount) || 0, e.note || "", e.created_by || ""]);
        r.getCell(5).numFmt = "#,##0";
      });
      if (sortedFlat.length > 0) writeTotalsRow(flatWs, "TOTAL", ["E"], sortedFlat.length + 1);

      // ── 2. By Category — collapse per (category, type) ──
      const byCat = new Map(); // category → Map(type → { amt, count })
      filtered.forEach(e => {
        const cat = catOf(e);
        if (!byCat.has(cat)) byCat.set(cat, new Map());
        const typeMap = byCat.get(cat);
        const prev = typeMap.get(e.expense_type) || { amt: 0, count: 0 };
        typeMap.set(e.expense_type, { amt: prev.amt + (Number(e.amount) || 0), count: prev.count + 1 });
      });
      const catWs = wb.addWorksheet("By Category");
      writeHeader(catWs, ["Category","Type","Entries","Amount"]);
      let catGrand = 0;
      let lastCatRow = 1;
      [...byCat.keys()].sort().forEach(cat => {
        const typeMap = byCat.get(cat);
        let catSubtotal = 0;
        [...typeMap.entries()].sort((a, b) => b[1].amt - a[1].amt).forEach(([type, v]) => {
          const r = catWs.addRow([cat, type, v.count, v.amt]);
          r.getCell(4).numFmt = "#,##0";
          catSubtotal += v.amt;
          lastCatRow += 1;
        });
        catGrand += catSubtotal;
        // Subtotal row per category
        const sub = catWs.addRow([`${cat.toUpperCase()} SUBTOTAL`, "", "", catSubtotal]);
        sub.eachCell(c => { c.font = { bold: true, color: { argb: "FF22D3EE" } }; });
        sub.getCell(4).numFmt = "#,##0";
        lastCatRow += 1;
        catWs.addRow([]);
        lastCatRow += 1;
      });
      if (catGrand > 0) {
        const g = catWs.addRow(["GRAND TOTAL", "", "", catGrand]);
        g.eachCell(c => { c.font = totalFont; c.border = totalBorder; });
        g.getCell(4).numFmt = "#,##0";
      }

      // ── 3. By Branch — same idea, branch × type rollup ──
      const byBranch = new Map();
      filtered.forEach(e => {
        const bn = e.branch_name || branchesById.get(e.branch_id)?.name || "?";
        if (!byBranch.has(bn)) byBranch.set(bn, new Map());
        const typeMap = byBranch.get(bn);
        const prev = typeMap.get(e.expense_type) || { amt: 0, count: 0 };
        typeMap.set(e.expense_type, { amt: prev.amt + (Number(e.amount) || 0), count: prev.count + 1 });
      });
      const brWs = wb.addWorksheet("By Branch");
      writeHeader(brWs, ["Branch","Type","Entries","Amount"]);
      let brGrand = 0;
      [...byBranch.keys()].sort().forEach(bn => {
        const typeMap = byBranch.get(bn);
        let brSubtotal = 0;
        [...typeMap.entries()].sort((a, b) => b[1].amt - a[1].amt).forEach(([type, v]) => {
          const r = brWs.addRow([bn, type, v.count, v.amt]);
          r.getCell(4).numFmt = "#,##0";
          brSubtotal += v.amt;
        });
        brGrand += brSubtotal;
        const sub = brWs.addRow([`${bn} SUBTOTAL`, "", "", brSubtotal]);
        sub.eachCell(c => { c.font = { bold: true, color: { argb: "FF22D3EE" } }; });
        sub.getCell(4).numFmt = "#,##0";
        brWs.addRow([]);
      });
      if (brGrand > 0) {
        const g = brWs.addRow(["GRAND TOTAL", "", "", brGrand]);
        g.eachCell(c => { c.font = totalFont; c.border = totalBorder; });
        g.getCell(4).numFmt = "#,##0";
      }

      // ── 4. One sheet per category with the full detail rows for that group ──
      [...byCat.keys()].sort().forEach(cat => {
        const safeName = cat.slice(0, 31).replace(/[\\\/\*\[\]\?:]/g, "_") || "other";
        const ws = wb.addWorksheet(safeName.charAt(0).toUpperCase() + safeName.slice(1));
        writeHeader(ws, ["Date","Branch","Type","Amount","Note","By"]);
        const rows = filtered
          .filter(e => catOf(e) === cat)
          .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
        rows.forEach(e => {
          const bn = e.branch_name || branchesById.get(e.branch_id)?.name || "?";
          const r = ws.addRow([e.date, bn, e.expense_type, Number(e.amount) || 0, e.note || "", e.created_by || ""]);
          r.getCell(4).numFmt = "#,##0";
        });
        if (rows.length > 0) writeTotalsRow(ws, "TOTAL", ["D"], rows.length + 1);
      });

      // ── Summary title sheet up front ──
      const summary = wb.addWorksheet("Summary", { properties: { tabColor: { argb: "FF22D3EE" } } });
      wb.worksheets.unshift(wb.worksheets.pop()); // move the new sheet to front
      summary.getColumn(1).width = 30;
      summary.getColumn(2).width = 24;
      summary.getCell("A1").value = "V-CUT SALON — DAILY EXPENSES EXPORT";
      summary.getCell("A1").font = { bold: true, size: 14, color: { argb: "FF065F46" } };
      summary.getCell("A3").value = "Date Range"; summary.getCell("B3").value = rangeLabel;
      summary.getCell("A4").value = "Branch Filter"; summary.getCell("B4").value = branchFilter ? (branchesById.get(branchFilter)?.name || branchFilter) : "All";
      summary.getCell("A5").value = "Type Filter"; summary.getCell("B5").value = typeFilter || "All";
      summary.getCell("A6").value = "Search"; summary.getCell("B6").value = searchText || "—";
      summary.getCell("A8").value = "Entries"; summary.getCell("B8").value = filtered.length;
      summary.getCell("A9").value = "Total Amount"; summary.getCell("B9").value = totalAmount;
      summary.getCell("B9").numFmt = "#,##0";
      summary.getCell("A11").value = "Sheet Guide"; summary.getCell("A11").font = { bold: true };
      [
        ["All Expenses", "Flat list, sorted newest-first with grand total."],
        ["By Category", "Type rollup per category with per-category subtotals."],
        ["By Branch", "Type rollup per branch with per-branch subtotals."],
        ...[...byCat.keys()].sort().map(c => [c.charAt(0).toUpperCase() + c.slice(1), `Full detail rows for the ${c} category.`]),
      ].forEach(([k, v], i) => {
        summary.getCell(`A${12 + i}`).value = `  • ${k}`;
        summary.getCell(`B${12 + i}`).value = v;
      });

      const now = new Date();
      const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
      const safeUser = (currentUser?.name || "user").replace(/[^a-zA-Z0-9]/g, "_");
      const fileName = `${safeUser}_daily_expenses_${dateFrom}_to_${dateTo}_${ts}.xlsx`;
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = fileName;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast({ title: "Exported", message: `${filtered.length} expenses saved as ${fileName}.`, type: "success" });
    } catch (err) {
      confirm({ title: "Export Error", message: err.message || "Unknown error", confirmText: "OK", type: "danger", onConfirm: () => {} });
    } finally {
      setExporting(false);
    }
  };

  const addNewType = async () => {
    const name = newTypeName.trim();
    if (!name) return;
    if (expenseTypes.some(t => t.name.toLowerCase() === name.toLowerCase())) {
      toast({ title: "Exists", message: `"${name}" already exists.`, type: "warning" });
      return;
    }
    await addDoc(collection(db, "expense_types"), {
      name, category: newTypeCat, active: true, desc: "",
      created_at: new Date().toISOString(), created_by: currentUser?.name || "user",
    });
    toast({ title: "Type Added", message: `"${name}" is now available.`, type: "success" });
    setNewTypeName("");
    setShowNewType(false);
  };

  if (loading && expenses.length === 0 && branches.length === 0) return <VLoader fullscreen label="Loading Expenses" />;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 2 }}>Operations</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>Daily Expenses</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={exportToExcel} disabled={exporting || filtered.length === 0}
            title={filtered.length === 0 ? "No rows to export" : "Download the current view as a multi-sheet Excel workbook"}
            style={{ padding: "10px 16px", borderRadius: 10, background: filtered.length === 0 ? "var(--bg4)" : "var(--bg3)", border: `1px solid ${filtered.length === 0 ? "var(--border)" : "rgba(74,222,128,0.4)"}`, color: filtered.length === 0 ? "var(--text3)" : "var(--green)", fontWeight: 800, fontSize: 11, cursor: (exporting || filtered.length === 0) ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6, opacity: (exporting || filtered.length === 0) ? 0.55 : 1 }}>
            <Icon name="save" size={12} /> {exporting ? "Exporting…" : "Export"}
          </button>
          {canEdit && (<>
            <button onClick={() => setShowNewType(true)}
              style={{ padding: "10px 16px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--accent)", fontWeight: 800, fontSize: 11, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Icon name="settings" size={12} /> Manage Types
            </button>
            <button onClick={() => { setEditId(null); setForm({ date: new Date().toISOString().slice(0, 10), branch_id: branches[0]?.id || "", expense_type: activeTypes[0] || "", amount: "", note: "" }); setShowForm(true); }}
              style={{ padding: "10px 18px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 11, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Icon name="plus" size={14} /> Add Expense
            </button>
          </>)}
        </div>
      </div>

      {/* Filters */}
      <Card style={{ marginBottom: 16, padding: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <BranchSelect value={branchFilter} onChange={setBranchFilter} branches={branches} placeholder="All Branches" />
          <SearchSelect
            value={typeFilter}
            onChange={(v) => setTypeFilter(v)}
            options={activeTypes.map(t => ({ value: t, label: t }))}
            placeholder="All Types"
            minWidth={160}
            buttonStyle={{ padding: "8px 12px", borderRadius: 10, fontSize: 13, background: "var(--bg3)", color: "var(--text)" }}
          />
          <input type="text" placeholder="Search branch, note, amount…" value={searchText} onChange={e => setSearchText(e.target.value)}
            style={{ padding: "8px 12px", border: "1px solid var(--border2)", borderRadius: 10, fontSize: 13, background: "var(--bg3)", color: "var(--text)", minWidth: 220, flex: 1 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>From:</span>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border2)", background: "var(--bg3)", color: "var(--text)", fontSize: 12 }} />
            <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>To:</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border2)", background: "var(--bg3)", color: "var(--text)", fontSize: 12 }} />
          </div>
          {(branchFilter || typeFilter || searchText) && (
            <button onClick={() => { setBranchFilter(""); setTypeFilter(""); setSearchText(""); }}
              style={{ padding: "8px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text3)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              Clear
            </button>
          )}
        </div>
      </Card>

      {/* KPI Strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 16 }}>
        <Card style={{ padding: 14 }}>
          <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Total Expenses</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--red)", marginTop: 4 }}>{INR(totalAmount)}</div>
        </Card>
        <Card style={{ padding: 14 }}>
          <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Records</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--accent)", marginTop: 4 }}>{filtered.length}</div>
        </Card>
        <Card style={{ padding: 14 }}>
          <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Expense Types</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--gold)", marginTop: 4 }}>{byType.length}</div>
        </Card>
      </div>

      {/* Type breakdown — clickable cards, click opens the drill-down modal */}
      {byType.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10, marginBottom: 16 }}>
          {byType.map(({ type, amt, count }) => {
            const isActive = drillType === type;
            return (
              <button
                key={type}
                onClick={() => setDrillType(type)}
                style={{
                  textAlign: "left", cursor: "pointer",
                  background: "var(--bg2)",
                  border: `1px solid ${isActive ? "var(--accent)" : "var(--border2)"}`,
                  borderRadius: 12, padding: "12px 14px",
                  boxShadow: isActive ? "0 0 0 2px rgba(255, 215, 0, 0.18)" : "none",
                  transition: "border-color 0.15s, box-shadow 0.15s, transform 0.1s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-1px)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; }}
                title={`View ${count} ${count === 1 ? "entry" : "entries"} for ${type}`}
              >
                <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{type}</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: "var(--red)", marginTop: 4 }}>{INR(amt)}</div>
                <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>{count} {count === 1 ? "entry" : "entries"}</div>
              </button>
            );
          })}
        </div>
      )}

      {/* Expenses Table */}
      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--bg4)" }}>
              <TH>Date</TH><TH>Branch</TH><TH>Expense Type</TH><TH right>Amount</TH><TH>Note</TH><TH>By</TH>
              {canEdit && <TH style={{ width: 80, textAlign: "center" }}>Actions</TH>}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={canEdit ? 7 : 6} style={{ textAlign: "center", padding: 30, color: "var(--text3)", fontSize: 13 }}>No expenses in the selected range.</td></tr>
            )}
            {filtered.map(e => (
              <tr key={e.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <TD>{e.date}</TD>
                <TD>{(e.branch_name || branchesById.get(e.branch_id)?.name || "—").replace("V-CUT ", "")}</TD>
                <TD style={{ fontWeight: 600 }}>{e.expense_type}</TD>
                <TD right style={{ fontWeight: 700, color: "var(--red)" }}>{INR(e.amount)}</TD>
                <TD style={{ color: "var(--text3)", fontSize: 12 }}>{e.note || "—"}</TD>
                <TD style={{ color: "var(--text3)", fontSize: 11 }}>{e.created_by || "—"}</TD>
                {canEdit && (
                  <TD style={{ textAlign: "center" }}>
                    <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
                      <IconBtn name="edit" variant="secondary" onClick={() => handleEdit(e)} title="Edit" />
                      <IconBtn name="del" variant="danger" onClick={() => handleDelete(e)} title="Delete" />
                    </div>
                  </TD>
                )}
              </tr>
            ))}
            {filtered.length > 0 && (
              <tr style={{ background: "var(--bg3)", fontWeight: 700, borderTop: "2px solid var(--border2)" }}>
                <TD>TOTAL</TD><TD></TD><TD></TD>
                <TD right style={{ color: "var(--red)", fontWeight: 800 }}>{INR(totalAmount)}</TD>
                <TD></TD><TD></TD>
                {canEdit && <TD></TD>}
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* Add/Edit Expense Modal */}
      <Modal isOpen={showForm} onClose={() => { setShowForm(false); setEditId(null); }} title={editId ? "Edit Expense" : "Add Daily Expense"} width={480}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Date *</label>
              <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, marginTop: 4 }} />
            </div>
            <div>
              <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Branch *</label>
              <div style={{ marginTop: 4 }}>
                <BranchSelect
                  value={form.branch_id}
                  onChange={(v) => setForm(f => ({ ...f, branch_id: v }))}
                  branches={branches}
                  placeholder="Select branch…"
                  minWidth={0}
                />
              </div>
            </div>
          </div>
          <div>
            <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Expense Type *</label>
            <SearchSelect
              value={form.expense_type}
              onChange={(v) => setForm(f => ({ ...f, expense_type: v }))}
              options={activeTypes.map(t => ({ value: t, label: t }))}
              placeholder="Select type…"
              minWidth={0}
              style={{ marginTop: 4 }}
              buttonStyle={{ padding: "10px 12px", borderRadius: 8, background: "var(--bg4)", color: "var(--text)", fontSize: 13 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Amount (₹) *</label>
            <input type="number" min="0" placeholder="0" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
              style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "var(--bg4)", border: "2px solid var(--accent)", color: "var(--accent)", fontSize: 16, fontWeight: 800, marginTop: 4 }} />
          </div>
          <div>
            <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Note</label>
            <input type="text" placeholder="Optional note…" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
              style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, marginTop: 4 }} />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 6 }}>
            <button onClick={() => { setShowForm(false); setEditId(null); }}
              style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text3)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Cancel</button>
            <button onClick={handleSave}
              style={{ padding: "10px 20px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>
              {editId ? "Update" : "Save Expense"}
            </button>
          </div>
        </div>
      </Modal>

      {/* New Expense Type Modal */}
      <Modal isOpen={showNewType} onClose={() => setShowNewType(false)} title="Add Expense Type" width={400}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Type Name *</label>
            <input type="text" placeholder="e.g. AC Repair, Towel Purchase" value={newTypeName} onChange={e => setNewTypeName(e.target.value)} autoFocus
              style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, marginTop: 4 }} />
          </div>
          <div>
            <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Category</label>
            <SearchSelect
              value={newTypeCat}
              onChange={(v) => setNewTypeCat(v)}
              options={[
                { value: "operations", label: "Operations" },
                { value: "utilities", label: "Utilities" },
                { value: "maintenance", label: "Maintenance" },
                { value: "supplies", label: "Supplies" },
                { value: "other", label: "Other" },
              ]}
              allowEmpty={false}
              minWidth={0}
              style={{ marginTop: 4 }}
              buttonStyle={{ padding: "10px 12px", borderRadius: 8, background: "var(--bg4)", color: "var(--text)", fontSize: 13 }}
            />
          </div>
          <div style={{ fontSize: 11, color: "var(--text3)", padding: "8px 12px", borderRadius: 8, background: "var(--bg3)" }}>
            This type will also appear in <strong>Master Setup → Expense Types</strong> for all users.
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button onClick={() => setShowNewType(false)}
              style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text3)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Cancel</button>
            <button onClick={addNewType}
              style={{ padding: "10px 20px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>
              Add Type
            </button>
          </div>
        </div>
      </Modal>

      {/* Category drill-down: table of every entry for a clicked category */}
      <Modal isOpen={!!drillType} onClose={() => setDrillType(null)} title={drillType ? `${drillType} — Breakdown` : ""} width={820}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontSize: 12, color: "var(--text3)" }}>
              {drillEntries.length} {drillEntries.length === 1 ? "entry" : "entries"}
              {branchFilter ? " · filtered by branch" : " · across all branches"}
              {` · ${dateFrom} → ${dateTo}`}
            </div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "var(--red)" }}>{INR(drillTotal)}</div>
          </div>
          <Card style={{ padding: 0, overflowX: "auto", maxHeight: "60vh" }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
              <thead>
                <tr style={{ background: "var(--bg4)" }}>
                  <TH>Date</TH><TH>Branch</TH><TH right>Amount</TH><TH>Note</TH><TH>By</TH>
                </tr>
              </thead>
              <tbody>
                {drillEntries.length === 0 && (
                  <tr><td colSpan={5} style={{ textAlign: "center", padding: 20, color: "var(--text3)", fontSize: 12 }}>No entries.</td></tr>
                )}
                {drillEntries.map(e => (
                  <tr key={e.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <TD>{e.date}</TD>
                    <TD>{(e.branch_name || branchesById.get(e.branch_id)?.name || "—").replace("V-CUT ", "")}</TD>
                    <TD right style={{ fontWeight: 700, color: "var(--red)" }}>{INR(e.amount)}</TD>
                    <TD style={{ color: "var(--text3)", fontSize: 12 }}>{e.note || "—"}</TD>
                    <TD style={{ color: "var(--text3)", fontSize: 11 }}>{e.created_by || "—"}</TD>
                  </tr>
                ))}
                {drillEntries.length > 0 && (
                  <tr style={{ background: "var(--bg3)", fontWeight: 700, borderTop: "2px solid var(--border2)" }}>
                    <TD>TOTAL</TD><TD></TD>
                    <TD right style={{ color: "var(--red)", fontWeight: 800 }}>{INR(drillTotal)}</TD>
                    <TD></TD><TD></TD>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>
        </div>
      </Modal>

      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}
