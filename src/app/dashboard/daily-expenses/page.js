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
  const [users, setUsers] = useState([]);
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
  // mode = "single" → modal with one branch + amount.
  // mode = "multi"  → inline form at the top with one row per branch so the
  //   user can record the same expense type across many branches in a single
  //   pass (e.g. AC service done at 5 outlets on the same day).
  // paid_by stays on every doc so the second table on this page can credit
  //   admin contributions separately while the regular expense rollups treat
  //   them all as ordinary daily_expenses.
  const [entryMode, setEntryMode] = useState("single");
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState({ date: new Date().toISOString().slice(0, 10), branch_id: "", expense_type: "", amount: "", note: "", paid_by_role: "accountant", paid_by: "Pravesh" });
  // Multi-branch form: each branch row carries its own expense_type / amount /
  // paid_by / note. `defaults` is a shortcut block — typing into it and clicking
  // "Fill all" copies those values into every branch row at once.
  const [multiForm, setMultiForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    defaults: { expense_type: "", note: "", paid_by_role: "accountant", paid_by: "Pravesh" },
    rows: {}, // { [branch_id]: { expense_type, amount, paid_by_role, paid_by, note } }
  });
  const [multiSaving, setMultiSaving] = useState(false);

  // New expense type inline
  const [showNewType, setShowNewType] = useState(false);
  const [newTypeName, setNewTypeName] = useState("");
  const [newTypeCat, setNewTypeCat] = useState("operations");

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "expense_types"), sn => setExpenseTypes(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "users"), sn => setUsers(sn.docs.map(d => ({ ...d.data(), uid: d.id })))),
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

  // Role → name list. Backs the Paid By picker so the user can attribute an
  // expense to a specific accountant/admin instead of the hard-coded
  // 'Pravesh' / 'Admin' labels. Falls back to a sensible default when the
  // users collection is still loading or empty.
  const usersByRole = useMemo(() => {
    const acc = users.filter(u => u.role === "accountant").map(u => u.name).filter(Boolean).sort();
    const adm = users.filter(u => u.role === "admin").map(u => u.name).filter(Boolean).sort();
    return { accountant: acc.length ? acc : ["Pravesh"], admin: adm.length ? adm : ["Admin"] };
  }, [users]);
  const defaultPaidBy = useMemo(() => ({
    role: "accountant",
    name: usersByRole.accountant[0] || "Pravesh",
  }), [usersByRole]);

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

  // Admin-paid recognition list — same date range / branch filter as the
  // main view, but only entries where paid_by is "Admin". Rendered in its
  // own table below so admin contributions read at a glance without losing
  // the unified expense rollup the rest of the app reads from.
  // Admin-paid = anything tagged with the admin role. Falls back to the
  // legacy 'paid_by === "Admin"' shape for entries written before paid_by_role
  // existed. Same intent: catch every doc that should be credited to admin.
  const adminPaid = useMemo(() => filtered.filter(e => {
    if (e.paid_by_role) return e.paid_by_role === "admin";
    return e.paid_by === "Admin";
  }), [filtered]);
  const adminPaidTotal = adminPaid.reduce((s, e) => s + (Number(e.amount) || 0), 0);

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
        paid_by: form.paid_by || defaultPaidBy.name,
        paid_by_role: form.paid_by_role || defaultPaidBy.role,
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
      setForm({ date: form.date, branch_id: form.branch_id, expense_type: "", amount: "", note: "", paid_by_role: form.paid_by_role, paid_by: form.paid_by });
      setEditId(null);
      setShowForm(false);
    } catch (err) {
      toast({ title: "Error", message: err.message, type: "error" });
    }
  };

  // Multi-branch save — fires one daily_expenses doc per branch row that has
  // both an expense_type and a non-zero amount. Each row carries its own
  // type/paid_by/note so the user can record different expenses across
  // branches in a single pass.
  const handleMultiSave = async () => {
    if (!multiForm.date) {
      toast({ title: "Incomplete", message: "Pick a date.", type: "warning" });
      return;
    }
    const ready = branches
      .map(b => ({ b, r: multiForm.rows[b.id] || {} }))
      .filter(({ r }) => Number(r.amount) > 0 && (r.expense_type || "").trim());
    if (ready.length === 0) {
      toast({ title: "Nothing to save", message: "Add an expense type and amount on at least one branch.", type: "warning" });
      return;
    }
    const missingType = branches
      .map(b => ({ b, r: multiForm.rows[b.id] || {} }))
      .filter(({ r }) => Number(r.amount) > 0 && !(r.expense_type || "").trim());
    if (missingType.length > 0) {
      toast({ title: "Missing expense type", message: `${missingType.length} row(s) have an amount but no expense type.`, type: "warning" });
      return;
    }
    setMultiSaving(true);
    try {
      const stamp = new Date().toISOString();
      const by = currentUser?.name || "user";
      await Promise.all(ready.map(({ b, r }) =>
        addDoc(collection(db, "daily_expenses"), {
          date: multiForm.date,
          branch_id: b.id,
          branch_name: b.name || "",
          expense_type: r.expense_type,
          amount: Number(r.amount) || 0,
          note: (r.note || "").trim(),
          paid_by: r.paid_by || defaultPaidBy.name,
          paid_by_role: r.paid_by_role || defaultPaidBy.role,
          created_at: stamp,
          created_by: by,
        })
      ));
      const total = ready.reduce((s, x) => s + (Number(x.r.amount) || 0), 0);
      const types = Array.from(new Set(ready.map(x => x.r.expense_type)));
      toast({ title: "Saved", message: `${ready.length} entries · ${types.length === 1 ? types[0] : `${types.length} types`} · ${INR(total)} total`, type: "success" });
      setMultiForm({
        date: multiForm.date,
        defaults: multiForm.defaults,
        rows: {},
      });
      setShowForm(false);
    } catch (err) {
      toast({ title: "Error", message: err.message, type: "error" });
    } finally {
      setMultiSaving(false);
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
    setEntryMode("single");
    // Legacy entries pre-paid_by_role default to accountant unless paid_by
    // looks like an admin name; this keeps the role pill in sync with what
    // the user originally chose.
    const paidByRole = e.paid_by_role || (usersByRole.admin.includes(e.paid_by) ? "admin" : "accountant");
    setForm({ date: e.date, branch_id: e.branch_id, expense_type: e.expense_type, amount: e.amount, note: e.note || "", paid_by_role: paidByRole, paid_by: e.paid_by || defaultPaidBy.name });
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
      summary.getCell("A1").value = "V-CUT SALON — ONLINE EXPENSE PAID EXPORT";
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
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>Online Expense Paid</div>
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
            <div style={{ display: "inline-flex", gap: 2, background: "var(--bg4)", padding: 3, borderRadius: 10 }} title="Single = one branch · Multiple = same expense type recorded across many branches at once">
              {[["single", "Single"], ["multi", "Multiple"]].map(([v, l]) => (
                <button key={v} onClick={() => setEntryMode(v)}
                  style={{ padding: "8px 14px", borderRadius: 8, fontSize: 11, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", border: "none", cursor: "pointer",
                    background: entryMode === v ? "linear-gradient(135deg,var(--accent),var(--gold2))" : "transparent",
                    color: entryMode === v ? "#000" : "var(--text3)" }}>
                  {l}
                </button>
              ))}
            </div>
            <button onClick={() => {
              setEditId(null);
              if (entryMode === "multi") {
                setMultiForm(m => ({
                  date: new Date().toISOString().slice(0, 10),
                  defaults: {
                    expense_type: m.defaults?.expense_type || activeTypes[0] || "",
                    note: "",
                    paid_by_role: m.defaults?.paid_by_role || defaultPaidBy.role,
                    paid_by: m.defaults?.paid_by || defaultPaidBy.name,
                  },
                  rows: {},
                }));
                setShowForm(true);
              } else {
                setForm(f => ({ date: new Date().toISOString().slice(0, 10), branch_id: branches[0]?.id || "", expense_type: activeTypes[0] || "", amount: "", note: "", paid_by_role: f.paid_by_role || defaultPaidBy.role, paid_by: f.paid_by || defaultPaidBy.name }));
                setShowForm(true);
              }
            }}
              style={{ padding: "10px 18px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 11, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Icon name="plus" size={14} /> {entryMode === "multi" ? "Add Expense (Multi)" : "Add Expense"}
            </button>
          </>)}
        </div>
      </div>

      {/* Multi-branch entry form — every branch is its own row with its own
          expense type / amount / paid-by / note. The "Quick Fill" block at the
          top copies its values into every row at once for the common case
          where the same expense applies across many branches. */}
      {canEdit && entryMode === "multi" && showForm && !editId && (() => {
        const setRow = (bid, patch) => setMultiForm(f => ({
          ...f,
          rows: { ...f.rows, [bid]: { ...(f.rows[bid] || {}), ...patch } },
        }));
        const setDefaults = (patch) => setMultiForm(f => ({
          ...f,
          defaults: { ...f.defaults, ...patch },
        }));
        const fillAll = () => {
          const d = multiForm.defaults || {};
          setMultiForm(f => ({
            ...f,
            rows: branches.reduce((acc, b) => {
              const cur = f.rows[b.id] || {};
              acc[b.id] = {
                ...cur,
                expense_type: d.expense_type || cur.expense_type || "",
                paid_by: d.paid_by || cur.paid_by || defaultPaidBy.name,
                paid_by_role: d.paid_by_role || cur.paid_by_role || defaultPaidBy.role,
                note: d.note || cur.note || "",
                amount: cur.amount || "",
              };
              return acc;
            }, {}),
          }));
        };
        const clearAll = () => setMultiForm(f => ({ ...f, rows: {} }));
        const ready = branches
          .map(b => ({ b, r: multiForm.rows[b.id] || {} }))
          .filter(({ r }) => Number(r.amount) > 0 && (r.expense_type || "").trim());
        const totalReady = ready.reduce((s, x) => s + (Number(x.r.amount) || 0), 0);
        const missingType = branches
          .map(b => ({ b, r: multiForm.rows[b.id] || {} }))
          .filter(({ r }) => Number(r.amount) > 0 && !(r.expense_type || "").trim()).length;

        return (
        <Card style={{ marginBottom: 16, padding: 18, border: "1px solid rgba(34,211,238,0.3)", overflow: "visible" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1.5 }}>Multi-Branch Entry</div>
              <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 2 }}>Each branch row carries its own expense type, amount, paid-by and note. Use Quick Fill to apply the same values everywhere.</div>
            </div>
            <button onClick={() => setShowForm(false)}
              style={{ padding: "6px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text2)", fontSize: 11, fontWeight: 700, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
              ✕ Close
            </button>
          </div>

          {/* Shared date + Quick Fill row */}
          <div style={{ padding: 12, borderRadius: 10, background: "var(--bg4)", border: "1px dashed var(--border2)", marginBottom: 14 }}>
            <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 800, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Date + Quick Fill (optional)</div>
            <div style={{ display: "grid", gridTemplateColumns: "140px minmax(160px, 1fr) 180px minmax(160px, 1fr) 1fr auto", gap: 10, alignItems: "end" }}>
              <div>
                <label style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Date *</label>
                <input type="date" value={multiForm.date} onChange={e => setMultiForm(f => ({ ...f, date: e.target.value }))}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, marginTop: 4 }} />
              </div>
              <div>
                <label style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Expense Type</label>
                <SearchSelect
                  value={multiForm.defaults?.expense_type || ""}
                  onChange={(v) => setDefaults({ expense_type: v })}
                  options={activeTypes.map(t => ({ value: t, label: t }))}
                  placeholder="Select type…"
                  minWidth={0}
                  style={{ marginTop: 4 }}
                  buttonStyle={{ padding: "8px 10px", borderRadius: 8, background: "var(--bg3)", color: "var(--text)", fontSize: 12 }}
                />
              </div>
              <div>
                <label style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Paid By Role</label>
                <div style={{ display: "inline-flex", gap: 2, background: "var(--bg3)", padding: 3, borderRadius: 8, marginTop: 4 }}>
                  {[["accountant", "Acct"], ["admin", "Admin"]].map(([val, lbl]) => (
                    <button key={val} type="button" onClick={() => {
                      const list = usersByRole[val] || [];
                      const cur = multiForm.defaults?.paid_by;
                      setDefaults({ paid_by_role: val, paid_by: list.includes(cur) ? cur : (list[0] || "") });
                    }}
                      style={{ padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 700, border: "none", cursor: "pointer",
                        background: (multiForm.defaults?.paid_by_role || "accountant") === val ? (val === "admin" ? "var(--orange)" : "var(--green)") : "transparent",
                        color: (multiForm.defaults?.paid_by_role || "accountant") === val ? "#000" : "var(--text3)" }}>
                      {lbl}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Paid By Name</label>
                <SearchSelect
                  value={multiForm.defaults?.paid_by || ""}
                  onChange={(v) => setDefaults({ paid_by: v })}
                  options={(usersByRole[multiForm.defaults?.paid_by_role || "accountant"] || []).map(n => ({ value: n, label: n }))}
                  placeholder="Select name…"
                  minWidth={0}
                  style={{ marginTop: 4 }}
                  buttonStyle={{ padding: "8px 10px", borderRadius: 8, background: "var(--bg3)", color: "var(--text)", fontSize: 12 }}
                />
              </div>
              <div>
                <label style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Note</label>
                <input type="text" placeholder="Default note…" value={multiForm.defaults?.note || ""} onChange={e => setDefaults({ note: e.target.value })}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, marginTop: 4 }} />
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" onClick={fillAll} title="Copy these defaults into every branch row"
                  style={{ padding: "8px 14px", borderRadius: 8, background: "var(--accent)", color: "#000", border: "none", fontSize: 11, fontWeight: 800, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap" }}>
                  Fill All
                </button>
                <button type="button" onClick={clearAll} title="Clear all branch rows"
                  style={{ padding: "8px 12px", borderRadius: 8, background: "var(--bg3)", color: "var(--text3)", border: "1px solid var(--border2)", fontSize: 11, fontWeight: 700, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
                  Clear
                </button>
              </div>
            </div>
          </div>

          {/* Per-branch rows table */}
          <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "auto", maxHeight: 460, marginBottom: 14 }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
              <thead style={{ position: "sticky", top: 0, background: "var(--bg4)", zIndex: 1 }}>
                <tr>
                  <TH style={{ minWidth: 160 }}>Branch</TH>
                  <TH style={{ minWidth: 180 }}>Expense Type</TH>
                  <TH right style={{ minWidth: 110 }}>Amount (₹)</TH>
                  <TH style={{ minWidth: 220 }}>Paid By</TH>
                  <TH style={{ minWidth: 200 }}>Note</TH>
                  <TH style={{ width: 56, textAlign: "center" }}>Clear</TH>
                </tr>
              </thead>
              <tbody>
                {branches.map(b => {
                  const r = multiForm.rows[b.id] || {};
                  const amt = r.amount || "";
                  const active = Number(amt) > 0;
                  const role = r.paid_by_role || multiForm.defaults?.paid_by_role || defaultPaidBy.role;
                  return (
                    <tr key={b.id} style={{ background: active ? "rgba(74,222,128,0.06)" : "transparent", borderBottom: "1px solid var(--border)" }}>
                      <TD style={{ fontWeight: 700, color: "var(--text)" }}>{(b.name || "—").replace("V-CUT ", "")}</TD>
                      <TD>
                        <SearchSelect
                          value={r.expense_type || ""}
                          onChange={(v) => setRow(b.id, { expense_type: v })}
                          options={activeTypes.map(t => ({ value: t, label: t }))}
                          placeholder="Select type…"
                          minWidth={0}
                          buttonStyle={{ padding: "6px 10px", borderRadius: 6, background: "var(--bg3)", color: "var(--text)", fontSize: 12 }}
                        />
                      </TD>
                      <TD right>
                        <input type="number" min="0" step="1" placeholder="0" value={amt}
                          onChange={e => setRow(b.id, { amount: e.target.value })}
                          style={{ width: 100, padding: "6px 8px", borderRadius: 6, background: "var(--bg3)", border: `1px solid ${active ? "var(--accent)" : "var(--border2)"}`, color: active ? "var(--accent)" : "var(--text)", fontSize: 12, fontWeight: 700, textAlign: "right", outline: "none" }} />
                      </TD>
                      <TD>
                        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                          <div style={{ display: "inline-flex", gap: 1, background: "var(--bg3)", padding: 2, borderRadius: 6 }}>
                            {[["accountant", "Acct"], ["admin", "Admin"]].map(([val, lbl]) => (
                              <button key={val} type="button" onClick={() => {
                                const list = usersByRole[val] || [];
                                const cur = r.paid_by;
                                setRow(b.id, { paid_by_role: val, paid_by: list.includes(cur) ? cur : (list[0] || "") });
                              }}
                                style={{ padding: "4px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, border: "none", cursor: "pointer",
                                  background: role === val ? (val === "admin" ? "var(--orange)" : "var(--green)") : "transparent",
                                  color: role === val ? "#000" : "var(--text3)" }}>
                                {lbl}
                              </button>
                            ))}
                          </div>
                          <SearchSelect
                            value={r.paid_by || (usersByRole[role] || [])[0] || ""}
                            onChange={(v) => setRow(b.id, { paid_by: v })}
                            options={(usersByRole[role] || []).map(n => ({ value: n, label: n }))}
                            placeholder="Name…"
                            minWidth={0}
                            buttonStyle={{ padding: "6px 8px", borderRadius: 6, background: "var(--bg3)", color: "var(--text)", fontSize: 11 }}
                          />
                        </div>
                      </TD>
                      <TD>
                        <input type="text" placeholder="Optional…" value={r.note || ""}
                          onChange={e => setRow(b.id, { note: e.target.value })}
                          style={{ width: "100%", padding: "6px 8px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, outline: "none" }} />
                      </TD>
                      <TD style={{ textAlign: "center" }}>
                        <button type="button" onClick={() => setMultiForm(f => {
                          const next = { ...f.rows };
                          delete next[b.id];
                          return { ...f, rows: next };
                        })} title="Clear this row"
                          style={{ padding: "4px 8px", borderRadius: 6, background: "var(--bg3)", color: "var(--text3)", border: "1px solid var(--border2)", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>×</button>
                      </TD>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
            <div style={{ fontSize: 12, color: "var(--text3)" }}>
              {ready.length > 0
                ? <>Will create <strong style={{ color: "var(--accent)" }}>{ready.length}</strong> {ready.length === 1 ? "entry" : "entries"} · Total <strong style={{ color: "var(--green)" }}>{INR(totalReady)}</strong>{missingType > 0 ? <> · <span style={{ color: "var(--red)" }}>{missingType} row(s) missing expense type</span></> : null}</>
                : <>Enter expense type and amount on at least one branch row.</>}
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setShowForm(false)} disabled={multiSaving}
                style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text3)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Cancel</button>
              <button onClick={handleMultiSave} disabled={multiSaving || ready.length === 0}
                style={{ padding: "10px 22px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: multiSaving ? "wait" : (ready.length === 0 ? "not-allowed" : "pointer"), opacity: multiSaving ? 0.6 : (ready.length === 0 ? 0.5 : 1) }}>
                {multiSaving ? "Saving…" : "Save All"}
              </button>
            </div>
          </div>
        </Card>
        );
      })()}

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
              <TH>Date</TH><TH>Branch</TH><TH>Expense Type</TH><TH right>Amount</TH><TH>Paid By</TH><TH>Note</TH><TH>By</TH>
              {canEdit && <TH style={{ width: 80, textAlign: "center" }}>Actions</TH>}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={canEdit ? 8 : 7} style={{ textAlign: "center", padding: 30, color: "var(--text3)", fontSize: 13 }}>No expenses in the selected range.</td></tr>
            )}
            {filtered.map(e => {
              const paidBy = e.paid_by || defaultPaidBy.name;
              const paidByAdmin = e.paid_by_role ? e.paid_by_role === "admin" : paidBy === "Admin";
              return (
                <tr key={e.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <TD>{e.date}</TD>
                  <TD>{(e.branch_name || branchesById.get(e.branch_id)?.name || "—").replace("V-CUT ", "")}</TD>
                  <TD style={{ fontWeight: 600 }}>{e.expense_type}</TD>
                  <TD right style={{ fontWeight: 700, color: "var(--red)" }}>{INR(e.amount)}</TD>
                  <TD>
                    <span title={paidByAdmin ? "Paid by Admin" : "Paid by Accountant"}
                      style={{ fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 4, letterSpacing: 0.5, textTransform: "uppercase",
                      background: paidByAdmin ? "rgba(251,146,60,0.15)" : "rgba(74,222,128,0.12)",
                      color: paidByAdmin ? "var(--orange)" : "var(--green)",
                      border: `1px solid ${paidByAdmin ? "rgba(251,146,60,0.35)" : "rgba(74,222,128,0.3)"}` }}>{paidBy}</span>
                  </TD>
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
              );
            })}
            {filtered.length > 0 && (
              <tr style={{ background: "var(--bg3)", fontWeight: 700, borderTop: "2px solid var(--border2)" }}>
                <TD>TOTAL</TD><TD></TD><TD></TD>
                <TD right style={{ color: "var(--red)", fontWeight: 800 }}>{INR(totalAmount)}</TD>
                <TD></TD><TD></TD><TD></TD>
                {canEdit && <TD></TD>}
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* Admin-paid recognition table — same entries already counted above,
          spotlighted here so admin contributions are easy to acknowledge
          without scanning the full list. */}
      {adminPaid.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10, flexWrap: "wrap", gap: 10 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 800, color: "var(--orange)", textTransform: "uppercase", letterSpacing: 1.5 }}>Recognition</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: "var(--gold)", marginTop: 2 }}>Paid by Admin</div>
            </div>
            <div style={{ fontSize: 13, color: "var(--text3)" }}>
              {adminPaid.length} entries · Total <strong style={{ color: "var(--orange)", fontSize: 16 }}>{INR(adminPaidTotal)}</strong>
            </div>
          </div>
          <Card style={{ padding: 0, overflowX: "auto", border: "1px solid rgba(251,146,60,0.25)" }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
              <thead>
                <tr style={{ background: "rgba(251,146,60,0.08)" }}>
                  <TH>Date</TH><TH>Branch</TH><TH>Expense Type</TH><TH right>Amount</TH><TH>Note</TH><TH>Entered By</TH>
                </tr>
              </thead>
              <tbody>
                {adminPaid.map(e => (
                  <tr key={e.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <TD>{e.date}</TD>
                    <TD>{(e.branch_name || branchesById.get(e.branch_id)?.name || "—").replace("V-CUT ", "")}</TD>
                    <TD style={{ fontWeight: 600 }}>{e.expense_type}</TD>
                    <TD right style={{ fontWeight: 700, color: "var(--orange)" }}>{INR(e.amount)}</TD>
                    <TD style={{ color: "var(--text3)", fontSize: 12 }}>{e.note || "—"}</TD>
                    <TD style={{ color: "var(--text3)", fontSize: 11 }}>{e.created_by || "—"}</TD>
                  </tr>
                ))}
                <tr style={{ background: "rgba(251,146,60,0.06)", fontWeight: 700, borderTop: "2px solid rgba(251,146,60,0.3)" }}>
                  <TD>TOTAL</TD><TD></TD><TD></TD>
                  <TD right style={{ color: "var(--orange)", fontWeight: 800 }}>{INR(adminPaidTotal)}</TD>
                  <TD></TD><TD></TD>
                </tr>
              </tbody>
            </table>
          </Card>
        </div>
      )}

      {/* Add/Edit Expense Modal — single mode only. Multi-branch flow is the
          inline form at the top so the picker has room for a row per branch. */}
      <Modal isOpen={showForm && (entryMode === "single" || !!editId)} onClose={() => { setShowForm(false); setEditId(null); }} title={editId ? "Edit Expense" : "Add Online Expense Paid"} width={480}>
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
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 12, alignItems: "end" }}>
            <div>
              <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Paid By Role *</label>
              <div style={{ display: "inline-flex", gap: 2, background: "var(--bg4)", padding: 3, borderRadius: 8, marginTop: 4 }}>
                {[["accountant", "Accountant"], ["admin", "Admin"]].map(([val, lbl]) => (
                  <button key={val} type="button" onClick={() => setForm(f => {
                    const list = usersByRole[val] || [];
                    return { ...f, paid_by_role: val, paid_by: list.includes(f.paid_by) ? f.paid_by : (list[0] || "") };
                  })}
                    style={{ padding: "8px 14px", borderRadius: 6, fontSize: 12, fontWeight: 700, border: "none", cursor: "pointer",
                      background: (form.paid_by_role || "accountant") === val ? (val === "admin" ? "var(--orange)" : "var(--green)") : "transparent",
                      color: (form.paid_by_role || "accountant") === val ? "#000" : "var(--text3)" }}>
                    {lbl}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Paid By Name *</label>
              <SearchSelect
                value={form.paid_by}
                onChange={(v) => setForm(f => ({ ...f, paid_by: v }))}
                options={(usersByRole[form.paid_by_role || "accountant"] || []).map(n => ({ value: n, label: n }))}
                placeholder="Select name…"
                minWidth={0}
                style={{ marginTop: 4 }}
                buttonStyle={{ padding: "10px 12px", borderRadius: 8, background: "var(--bg4)", color: "var(--text)", fontSize: 13 }}
              />
            </div>
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
