"use client";
import { useEffect, useState, useMemo } from "react";
import { collection, onSnapshot, query, orderBy, addDoc, deleteDoc, doc, setDoc, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR, proRataSalary } from "@/lib/calculations";
import { Icon, IconBtn, Pill, Card, PeriodWidget, TH, TD, Modal, useConfirm, useToast } from "@/components/ui";
// ExcelJS is ~200KB — load only when Template/Upload/Export is actually used.
let _excelJSPromise = null;
const loadExcelJS = () => {
  if (!_excelJSPromise) _excelJSPromise = import("exceljs").then(m => m.default || m);
  return _excelJSPromise;
};

const NOW = new Date();
const CORE_COLS = [
  "Shop Rent", "Room Rent", "Electricity Shop", "Electricity Room",
  "Water Bill", "WiFi Bill", "Maid / Cleaning", "Garbage / Waste", 
  "Dust Collector Bag", "AC Service", "Electrical Maintenance", "Staff Advance"
];

export default function ExpensesPage() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [expenses, setExpenses] = useState([]);
  const [branches, setBranches] = useState([]);
  const [customTypes, setCustomTypes] = useState([]);
  const [staff, setStaff] = useState([]);
  const [salHistory, setSalHistory] = useState([]);
  const [dailyEntries, setDailyEntries] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [viewType, setViewType] = useState("fixed"); // 'fixed' or 'total'
  const [focusedCol, setFocusedCol] = useState(null); // category name or null
  const [bulkEdit, setBulkEdit] = useState(false);
  
  const [filterMode, setFilterMode]   = useState("month");
  const [filterYear, setFilterYear]   = useState(NOW.getFullYear());
  const [filterMonth, setFilterMonth] = useState(NOW.getMonth() + 1);
  const filterPrefix = `${filterYear}-${String(filterMonth).padStart(2, "0")}`;

  // Combined columns for the grid (Deduplicated to prevent key collisions)
  const activeCols = Array.from(new Set([...CORE_COLS, ...customTypes.filter(t => t.active).map(t => t.name)]));

  // Local grid inputs mapping [branch_id][type] -> amount
  const [localGrid, setLocalGrid] = useState({});
  const [editingDoc, setEditingDoc] = useState(null);
  const [form, setForm] = useState({ branch_id: "", type: "", amount: "", date: "", note: "" });

  const openForm = (doc = null) => {
    if (doc) {
      setEditingDoc(doc);
      setForm({ ...doc });
    } else {
      setEditingDoc(null);
      setForm({ branch_id: branches[0]?.id || "", type: activeCols[0] || "", amount: "", date: new Date().toISOString().split("T")[0], note: "" });
    }
    setShowForm(true);
  };

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "expense_types"), sn => setCustomTypes(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "staff"), sn => setStaff(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "salary_history"), sn => setSalHistory(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(query(collection(db, "entries"), orderBy("date", "desc")), sn => setDailyEntries(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(query(collection(db, "fixed_expenses"), orderBy("date", "desc")), sn => {
        setExpenses(sn.docs.map(d => ({ ...d.data(), id: d.id })));
        setLoading(false);
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  // Sync grid view state
  useEffect(() => {
    const fresh = {};
    branches.forEach(b => {
      fresh[b.id] = {};
      activeCols.forEach(t => {
        const match = expenses.find(e => e.branch_id === b.id && e.type === t && e.date?.startsWith(filterPrefix));
        if (match) {
          fresh[b.id][t] = { val: match.amount, isActual: true };
        } else {
          // Fallback to Master Data defaults
          let def = 0;
          if (t === "Shop Rent") def = Number(b.shop_rent)||0;
          else if (t === "Room Rent") def = Number(b.room_rent)||0;
          else if (t === "Electricity Shop") def = Number(b.shop_elec)||0;
          else if (t === "Electricity Room") def = Number(b.room_elec)||0;
          else if (t === "Water Bill") def = Number(b.water)||0;
          else if (t === "WiFi Bill") def = Number(b.wifi)||0;
          else if (t === "Maid / Cleaning") def = Number(b.maid)||0;
          else if (t === "Garbage / Waste") def = Number(b.garbage)||0;
          else if (t === "Dust Collector Bag") def = Number(b.dust)||0;
          else if (t === "AC Service") def = Number(b.ac_service)||0;
          else if (t === "Electrical Maintenance") def = Number(b.elec_maint)||0;
          
          fresh[b.id][t] = { val: def || "", isActual: false };
        }
      });
    });
    setLocalGrid(fresh);
  }, [branches, expenses, filterPrefix, activeCols.join(",")]);

  const inPeriod = (e) => {
    if (!e.date) return false;
    return filterMode === "month" ? e.date.startsWith(filterPrefix) : e.date.startsWith(String(filterYear));
  };
  const filtered = expenses.filter(inPeriod);
  
  // Helper to get stats for a branch in current month
  // ── Pre-computed lookup maps — one walk each, replaces nested filter+reduce patterns ──
  const staffByBranch = useMemo(() => {
    const m = new Map();
    staff.forEach(st => {
      if (!m.has(st.branch_id)) m.set(st.branch_id, []);
      m.get(st.branch_id).push(st);
    });
    return m;
  }, [staff]);

  // Map<branchId|YYYY-MM, summedAmount> for fixed_expenses
  const expensesByBranchMonth = useMemo(() => {
    const m = new Map();
    expenses.forEach(e => {
      if (!e.branch_id || !e.date) return;
      const k = `${e.branch_id}|${e.date.slice(0, 7)}`;
      m.set(k, (m.get(k) || 0) + (Number(e.amount) || 0));
    });
    return m;
  }, [expenses]);

  // Map<branchId|YYYY-MM, { mat, petrol, others, incs, variable }> for daily entries
  const dailyAggByBranchMonth = useMemo(() => {
    const m = new Map();
    dailyEntries.forEach(e => {
      if (!e.branch_id || !e.date) return;
      const k = `${e.branch_id}|${e.date.slice(0, 7)}`;
      let slot = m.get(k);
      if (!slot) { slot = { mat: 0, petrol: 0, others: 0, incs: 0, variable: 0 }; m.set(k, slot); }
      const mat = Number(e.mat_expense) || 0;
      const pet = Number(e.petrol) || 0;
      const oth = Number(e.others) || 0;
      const sb = e.staff_billing || [];
      let incs = 0;
      for (let i = 0; i < sb.length; i++) {
        const x = sb[i] || {};
        incs += Number(x.staff_total_inc) || (Number(x.incentive) || 0) + (Number(x.mat_incentive) || 0) + (Number(x.tips) || 0);
      }
      slot.mat += mat; slot.petrol += pet; slot.others += oth; slot.incs += incs;
      slot.variable += mat + pet + oth + incs;
    });
    return m;
  }, [dailyEntries]);

  // Map<branchId, activeColsSum> — current-month grid totals (used by KPI and annual fallback)
  const gridTotalByBranch = useMemo(() => {
    const m = new Map();
    branches.forEach(b => {
      let sum = 0;
      for (let i = 0; i < activeCols.length; i++) sum += Number(localGrid[b.id]?.[activeCols[i]]?.val) || 0;
      m.set(b.id, sum);
    });
    return m;
  }, [branches, localGrid, activeCols]);

  const getBranchStats = (bid) => {
    if (filterMode !== "month") return { salary: 0, variable: 0 };
    const bStaff = staffByBranch.get(bid) || [];
    const salary = bStaff.reduce((s, st) => s + proRataSalary(st, filterPrefix, branches, salHistory, staff), 0);
    const variable = dailyAggByBranchMonth.get(`${bid}|${filterPrefix}`)?.variable || 0;
    return { salary, variable };
  };

  const currentUser = useCurrentUser() || {};
  const canEdit = ["admin","accountant"].includes(currentUser?.role);
  const isAdmin = currentUser?.role === "admin";
  const [exporting, setExporting] = useState(false);
  const [templating, setTemplating] = useState(false);
  const [uploadPreview, setUploadPreview] = useState(null); // { rows: [{branch, values:{...}, existing:{...}}], errors }
  const [committing, setCommitting] = useState(false);

  const downloadExpenseTemplate = async () => {
    if (templating || filterMode !== "month") return;
    setTemplating(true);
    try {
      const ExcelJS = await loadExcelJS();
      const wb = new ExcelJS.Workbook();
      wb.creator = "V-Cut";
      wb.created = new Date();

      const ws = wb.addWorksheet(`Expenses-${filterPrefix}`, { views: [{ state: "frozen", ySplit: 3, xSplit: 1 }] });
      const headerFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0891B2" } };
      const headerFont = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      const moneyFmt = '₹#,##0';
      const thin = { style: "thin", color: { argb: "FFCBD5E1" } };
      const border = { top: thin, left: thin, bottom: thin, right: thin };

      const cols = ["Branch", ...activeCols, "Fixed Total"];
      ws.mergeCells(1, 1, 1, cols.length);
      const title = ws.getCell(1, 1);
      title.value = `V-CUT — Fixed Expenses Template (${filterPrefix})`;
      title.font = { bold: true, size: 16, color: { argb: "FF0891B2" } };
      title.alignment = { vertical: "middle", horizontal: "center" };
      ws.getRow(1).height = 28;

      const hdrRow = ws.getRow(3);
      cols.forEach((h, i) => {
        const c = hdrRow.getCell(i + 1);
        c.value = h;
        c.font = headerFont;
        c.fill = headerFill;
        c.alignment = { vertical: "middle", horizontal: i === 0 ? "left" : "right", wrapText: true };
        c.border = border;
      });
      hdrRow.height = 28;

      branches.forEach((b, idx) => {
        const r = ws.getRow(4 + idx);
        const nameCell = r.getCell(1);
        nameCell.value = b.name.replace("V-CUT ", "");
        nameCell.font = { bold: true };
        nameCell.border = border;
        nameCell.alignment = { horizontal: "left" };
        nameCell.protection = { locked: true };

        // Master-data defaults from Shops master setup
        const masterByCat = {
          "Shop Rent": Number(b.shop_rent) || 0,
          "Room Rent": Number(b.room_rent) || 0,
          "Electricity Shop": Number(b.shop_elec) || 0,
          "Electricity Room": Number(b.room_elec) || 0,
          "Water Bill": Number(b.water) || 0,
          "WiFi Bill": Number(b.wifi) || 0,
          "Maid / Cleaning": Number(b.maid) || 0,
          "Garbage / Waste": Number(b.garbage) || 0,
          "Dust Collector Bag": Number(b.dust) || 0,
        };
        activeCols.forEach((t, i) => {
          const c = r.getCell(2 + i);
          const def = masterByCat[t];
          c.value = def != null && def > 0 ? def : null;
          c.numFmt = moneyFmt;
          c.border = border;
          c.alignment = { horizontal: "right" };
          c.protection = { locked: false };
          c.dataValidation = {
            type: "decimal", operator: "greaterThanOrEqual", formulae: [0],
            showErrorMessage: true, errorStyle: "error",
            errorTitle: "Invalid value", error: "Enter a non-negative number."
          };
        });
        // Fixed Total formula
        const totalCell = r.getCell(cols.length);
        const startCol = String.fromCharCode(65 + 1); // 'B'
        const endCol = String.fromCharCode(65 + activeCols.length);
        totalCell.value = { formula: `SUM(${startCol}${4 + idx}:${endCol}${4 + idx})`, result: 0 };
        totalCell.numFmt = moneyFmt;
        totalCell.border = border;
        totalCell.alignment = { horizontal: "right" };
        totalCell.font = { bold: true };
        totalCell.protection = { locked: true };
      });

      ws.columns = cols.map((_, i) => ({ width: i === 0 ? 22 : 16 }));
      try { await ws.protect("vcut-expenses", { selectLockedCells: true, selectUnlockedCells: true, formatColumns: true, formatRows: true }); } catch { /* ignore */ }

      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const fileName = `V-Cut_Expenses_Template_${filterPrefix}.xlsx`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast({ title: "Template Ready", message: `${fileName} downloaded. Fill and upload it back.`, type: "success" });
    } catch (err) {
      console.error("Template error:", err);
      toast({ title: "Template Error", message: err.message || "Unknown error", type: "error" });
    } finally {
      setTemplating(false);
    }
  };

  const handleExpenseUpload = async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    ev.target.value = "";
    try {
      const ExcelJS = await loadExcelJS();
      const buffer = await file.arrayBuffer();
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer);
      const ws = wb.worksheets[0];
      if (!ws) throw new Error("Workbook contains no sheets.");

      // Find header row (row with "Branch" in col A)
      let headerRowNum = -1;
      for (let r = 1; r <= Math.min(6, ws.rowCount); r++) {
        const v = ws.getRow(r).getCell(1).value;
        if (typeof v === "string" && v.trim().toLowerCase() === "branch") { headerRowNum = r; break; }
      }
      if (headerRowNum < 0) throw new Error(`Could not find header row. Expected "Branch" in column A.`);

      // Column map
      const headerRow = ws.getRow(headerRowNum);
      const colMap = {}; // colIdx -> categoryName
      for (let c = 2; c <= headerRow.cellCount; c++) {
        const v = headerRow.getCell(c).value;
        if (!v) continue;
        const label = String(v).trim();
        if (label.toLowerCase() === "fixed total") continue;
        colMap[c] = label;
      }

      const rows = [];
      const errors = [];
      const branchByName = new Map(branches.map(b => [b.name.replace("V-CUT ", "").trim().toLowerCase(), b]));

      for (let r = headerRowNum + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const nameRaw = row.getCell(1).value;
        if (!nameRaw) continue;
        const nameStr = String(nameRaw).trim();
        if (!nameStr) continue;
        const branch = branchByName.get(nameStr.toLowerCase());
        if (!branch) { errors.push(`Row ${r}: branch "${nameStr}" not found.`); continue; }

        const values = {};
        Object.entries(colMap).forEach(([ci, cat]) => {
          const raw = row.getCell(Number(ci)).value;
          const num = raw == null || raw === "" ? null : Number(raw?.result ?? raw);
          if (raw != null && raw !== "" && (Number.isNaN(num) || num < 0)) {
            errors.push(`Row ${r} (${nameStr}) / ${cat}: "${raw}" is not a valid non-negative number.`);
            return;
          }
          if (num != null) values[cat] = num;
        });

        // Compare with existing (current period)
        const existing = {};
        activeCols.forEach(cat => {
          const match = expenses.find(e => e.branch_id === branch.id && e.type === cat && e.date?.startsWith(filterPrefix));
          existing[cat] = match ? Number(match.amount) || 0 : null;
        });
        rows.push({ branch, values, existing });
      }

      setUploadPreview({ rows, errors, period: filterPrefix });
    } catch (err) {
      console.error("Upload error:", err);
      confirm({ title: "Upload Error", message: err.message || "Unknown error", confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    }
  };

  const commitUpload = async () => {
    if (!uploadPreview || committing) return;
    setCommitting(true);
    try {
      const batch = writeBatch(db);
      let writes = 0;
      uploadPreview.rows.forEach(({ branch, values }) => {
        Object.entries(values).forEach(([cat, amount]) => {
          const existing = expenses.find(e => e.branch_id === branch.id && e.type === cat && e.date?.startsWith(uploadPreview.period));
          if (existing) {
            if (Number(existing.amount) === amount) return;
            batch.set(doc(db, "fixed_expenses", existing.id), { ...existing, amount, updated_by: currentUser?.id || "admin", updated_at: new Date().toISOString() }, { merge: true });
          } else {
            const newRef = doc(collection(db, "fixed_expenses"));
            batch.set(newRef, { branch_id: branch.id, type: cat, amount, date: `${uploadPreview.period}-01`, by: currentUser?.id || "admin", at: new Date().toISOString() });
          }
          writes++;
        });
      });
      if (writes === 0) {
        toast({ title: "No Changes", message: "All values match existing records.", type: "info" });
        setUploadPreview(null);
      } else {
        await batch.commit();
        toast({ title: "Uploaded", message: `${writes} expense record(s) saved.`, type: "success" });
        setUploadPreview(null);
      }
    } catch (err) {
      confirm({ title: "Commit Error", message: err.message || "Unknown error", confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    } finally {
      setCommitting(false);
    }
  };

  const exportExpenses = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const ExcelJS = await loadExcelJS();
      const wb = new ExcelJS.Workbook();
      wb.creator = "V-Cut";
      wb.created = new Date();

      const periodText = filterMode === "year" ? String(filterYear) : `${String(filterMonth).padStart(2, "0")}-${filterYear}`;
      const headerFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0891B2" } };
      const headerFont = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      const moneyFmt = '₹#,##0;[Red]-₹#,##0';
      const thin = { style: "thin", color: { argb: "FFCBD5E1" } };
      const border = { top: thin, left: thin, bottom: thin, right: thin };
      const totalFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };

      const writeHeaderRow = (ws, rowNum, cols) => {
        const r = ws.getRow(rowNum);
        cols.forEach((h, i) => {
          const c = r.getCell(i + 1);
          c.value = h;
          c.font = headerFont;
          c.fill = headerFill;
          c.alignment = { vertical: "middle", horizontal: i === 0 ? "left" : "right", wrapText: true };
          c.border = border;
        });
        r.height = 28;
      };

      // Helper: compute fixed expenses for a branch in a given month prefix
      const branchFixedByCategory = (b, mPrefix) => {
        const result = {};
        const isCurrentPrefix = mPrefix === filterPrefix;
        activeCols.forEach(t => {
          const match = expenses.find(e => e.branch_id === b.id && e.type === t && e.date?.startsWith(mPrefix));
          if (match) {
            result[t] = Number(match.amount) || 0;
          } else if (isCurrentPrefix && localGrid[b.id]?.[t]?.val != null) {
            result[t] = Number(localGrid[b.id][t].val) || 0;
          } else {
            // Fallback to master defaults
            let def = 0;
            if (t === "Shop Rent") def = Number(b.shop_rent) || 0;
            else if (t === "Room Rent") def = Number(b.room_rent) || 0;
            else if (t === "Electricity Shop") def = Number(b.shop_elec) || 0;
            else if (t === "Electricity Room") def = Number(b.room_elec) || 0;
            else if (t === "Water Bill") def = Number(b.water) || 0;
            else if (t === "WiFi Bill") def = Number(b.wifi) || 0;
            else if (t === "Maid / Cleaning") def = Number(b.maid) || 0;
            else if (t === "Garbage / Waste") def = Number(b.garbage) || 0;
            else if (t === "Dust Collector Bag") def = Number(b.dust) || 0;
            result[t] = def;
          }
        });
        return result;
      };

      const branchVariableAndSalary = (b, mPrefix) => {
        const bStaff = staff.filter(s => s.branch_id === b.id);
        const salary = bStaff.reduce((s, st) => s + proRataSalary(st, mPrefix, branches, salHistory, staff), 0);
        const bEntries = dailyEntries.filter(e => e.branch_id === b.id && e.date?.startsWith(mPrefix));
        const variable = bEntries.reduce((s, e) => {
          const sb = e.staff_billing || [];
          const incs = sb.reduce((ss, x) => ss + (x.staff_total_inc || (x.incentive || 0) + (x.mat_incentive || 0) + (x.tips || 0)), 0);
          return s + (e.mat_expense || 0) + (e.petrol || 0) + (e.others || 0) + incs;
        }, 0);
        return { salary, variable };
      };

      if (filterMode === "month") {
        // Single-month matrix: branches × categories
        const ws = wb.addWorksheet(`Summary-${periodText}`, { views: [{ state: "frozen", ySplit: 3, xSplit: 1 }] });
        const cols = ["Branch", "Salary", "Variable", ...activeCols, "Fixed Total", "Grand Total"];
        ws.mergeCells(1, 1, 1, cols.length);
        const t = ws.getCell(1, 1);
        t.value = `V-CUT — Financial Expenses (${periodText})`;
        t.font = { bold: true, size: 16, color: { argb: "FF0891B2" } };
        t.alignment = { vertical: "middle", horizontal: "center" };
        ws.getRow(1).height = 28;
        writeHeaderRow(ws, 3, cols);

        const totals = Array(cols.length - 1).fill(0);
        branches.forEach((b, idx) => {
          const r = ws.getRow(4 + idx);
          const fixed = branchFixedByCategory(b, filterPrefix);
          const { salary, variable } = branchVariableAndSalary(b, filterPrefix);
          const fixedTotal = activeCols.reduce((s, t2) => s + (fixed[t2] || 0), 0);
          const grand = fixedTotal + salary + variable;
          const vals = [b.name.replace("V-CUT ", ""), salary, variable, ...activeCols.map(t2 => fixed[t2] || 0), fixedTotal, grand];
          vals.forEach((v, i) => {
            const c = r.getCell(i + 1);
            c.value = v;
            c.border = border;
            if (i === 0) { c.font = { bold: true }; }
            else {
              c.alignment = { horizontal: "right" };
              if (typeof v === "number") c.numFmt = moneyFmt;
              totals[i - 1] = (totals[i - 1] || 0) + (typeof v === "number" ? v : 0);
            }
          });
        });
        const trow = ws.getRow(4 + branches.length);
        trow.getCell(1).value = "TOTAL";
        trow.getCell(1).font = { bold: true };
        trow.getCell(1).fill = totalFill;
        trow.getCell(1).border = border;
        totals.forEach((v, i) => {
          const c = trow.getCell(i + 2);
          c.value = v;
          c.numFmt = moneyFmt;
          c.font = { bold: true };
          c.fill = totalFill;
          c.border = border;
          c.alignment = { horizontal: "right" };
        });
        ws.columns = cols.map((_, i) => ({ width: i === 0 ? 22 : 16 }));
      } else {
        // Yearly summary: branches × 12 months + annual total
        const curY = NOW.getFullYear();
        const curM = NOW.getMonth() + 1;
        const endMonth = filterYear < curY ? 12 : (filterYear === curY ? curM : 12);
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const ws = wb.addWorksheet(`Summary-${periodText}`, { views: [{ state: "frozen", ySplit: 3, xSplit: 1 }] });
        const cols = ["Branch", ...monthNames.slice(0, endMonth), "Annual Total"];
        ws.mergeCells(1, 1, 1, cols.length);
        const t = ws.getCell(1, 1);
        t.value = `V-CUT — Financial Expenses (${periodText}) — ${viewType === "fixed" ? "Fixed Only" : "Total (F+S+V)"}`;
        t.font = { bold: true, size: 16, color: { argb: "FF0891B2" } };
        t.alignment = { vertical: "middle", horizontal: "center" };
        ws.getRow(1).height = 28;
        writeHeaderRow(ws, 3, cols);

        const totals = Array(cols.length - 1).fill(0);
        branches.forEach((b, idx) => {
          const r = ws.getRow(4 + idx);
          r.getCell(1).value = b.name.replace("V-CUT ", "");
          r.getCell(1).font = { bold: true };
          r.getCell(1).border = border;
          let annual = 0;
          for (let m = 1; m <= endMonth; m++) {
            const mPrefix = `${filterYear}-${String(m).padStart(2, "0")}`;
            const fixed = branchFixedByCategory(b, mPrefix);
            const fixedTotal = activeCols.reduce((s, t2) => s + (fixed[t2] || 0), 0);
            let mTotal = fixedTotal;
            if (viewType === "total") {
              const { salary, variable } = branchVariableAndSalary(b, mPrefix);
              mTotal += salary + variable;
            }
            const c = r.getCell(1 + m);
            c.value = mTotal;
            c.numFmt = moneyFmt;
            c.border = border;
            c.alignment = { horizontal: "right" };
            annual += mTotal;
            totals[m - 1] += mTotal;
          }
          const ac = r.getCell(cols.length);
          ac.value = annual;
          ac.numFmt = moneyFmt;
          ac.font = { bold: true };
          ac.border = border;
          ac.alignment = { horizontal: "right" };
          totals[cols.length - 2] += annual;
        });
        const trow = ws.getRow(4 + branches.length);
        trow.getCell(1).value = "TOTAL";
        trow.getCell(1).font = { bold: true };
        trow.getCell(1).fill = totalFill;
        trow.getCell(1).border = border;
        totals.forEach((v, i) => {
          const c = trow.getCell(i + 2);
          c.value = v;
          c.numFmt = moneyFmt;
          c.font = { bold: true };
          c.fill = totalFill;
          c.border = border;
          c.alignment = { horizontal: "right" };
        });
        ws.columns = cols.map((_, i) => ({ width: i === 0 ? 22 : 14 }));

        // Per-branch tab: months × categories
        branches.forEach(b => {
          const safeName = (b.name.replace("V-CUT ", "") || "Branch").slice(0, 31).replace(/[\\\/\?\*\[\]:]/g, "");
          const ws2 = wb.addWorksheet(safeName, { views: [{ state: "frozen", ySplit: 3, xSplit: 1 }] });
          const catCols = ["Month", "Salary", "Variable", ...activeCols, "Fixed Total", "Grand Total"];
          ws2.mergeCells(1, 1, 1, catCols.length);
          const tt = ws2.getCell(1, 1);
          tt.value = `${b.name} — ${periodText}`;
          tt.font = { bold: true, size: 14, color: { argb: "FF0891B2" } };
          tt.alignment = { vertical: "middle", horizontal: "center" };
          ws2.getRow(1).height = 26;
          writeHeaderRow(ws2, 3, catCols);

          const colTotals = Array(catCols.length - 1).fill(0);
          for (let m = 1; m <= endMonth; m++) {
            const mPrefix = `${filterYear}-${String(m).padStart(2, "0")}`;
            const fixed = branchFixedByCategory(b, mPrefix);
            const { salary, variable } = branchVariableAndSalary(b, mPrefix);
            const fixedTotal = activeCols.reduce((s, t2) => s + (fixed[t2] || 0), 0);
            const grand = fixedTotal + salary + variable;
            const vals = [`${monthNames[m - 1]} ${filterYear}`, salary, variable, ...activeCols.map(t2 => fixed[t2] || 0), fixedTotal, grand];
            const r = ws2.getRow(3 + m);
            vals.forEach((v, i) => {
              const c = r.getCell(i + 1);
              c.value = v;
              c.border = border;
              if (i === 0) { c.font = { bold: true }; }
              else {
                c.alignment = { horizontal: "right" };
                if (typeof v === "number") c.numFmt = moneyFmt;
                colTotals[i - 1] += (typeof v === "number" ? v : 0);
              }
            });
          }
          const trow2 = ws2.getRow(4 + endMonth);
          trow2.getCell(1).value = "ANNUAL TOTAL";
          trow2.getCell(1).font = { bold: true };
          trow2.getCell(1).fill = totalFill;
          trow2.getCell(1).border = border;
          colTotals.forEach((v, i) => {
            const c = trow2.getCell(i + 2);
            c.value = v;
            c.numFmt = moneyFmt;
            c.font = { bold: true };
            c.fill = totalFill;
            c.border = border;
            c.alignment = { horizontal: "right" };
          });
          ws2.columns = catCols.map((_, i) => ({ width: i === 0 ? 16 : 14 }));
        });
      }

      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const fileName = `V-Cut_Financial_Expenses_${periodText}.xlsx`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast({ title: "Exported", message: `${fileName} downloaded.`, type: "success" });
    } catch (err) {
      console.error("Expenses export error:", err);
      toast({ title: "Export Error", message: err.message || "Unknown error", type: "error" });
    } finally {
      setExporting(false);
    }
  };

  const handleGridUpdate = async (bid, type, val) => {
    if (val === "" || isNaN(val)) return;
    const amount = Number(val);
    const existing = expenses.find(e => e.branch_id === bid && e.type === type && e.date?.startsWith(filterPrefix));
    
    try {
      if (existing) {
        if (existing.amount === amount) return; // No change
        await setDoc(doc(db, "fixed_expenses", existing.id), { ...existing, amount }, { merge: true });
      } else {
        await addDoc(collection(db, "fixed_expenses"), {
          branch_id: bid,
          type: type,
          amount: amount,
          date: `${filterPrefix}-01`, 
          by: currentUser?.id || "admin",
          at: new Date().toISOString()
        });
      }
    } catch (err) { confirm({ title: "Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} }); }
  };

  const handleSyncMasterData = () => {
    confirm({
      title: "Sync Master Data",
      message: "Convert all suggested bills for this month into actual records?",
      confirmText: "Convert",
      cancelText: "Cancel",
      type: "warning",
      onConfirm: async () => {
        const batch = writeBatch(db);
        let count = 0;

        branches.forEach(b => {
          const bGrid = localGrid[b.id] || {};
          activeCols.forEach(t => {
            const cell = bGrid[t];
            if (cell && !cell.isActual && cell.val > 0) {
              const newDocRef = doc(collection(db, "fixed_expenses"));
              batch.set(newDocRef, {
                branch_id: b.id,
                type: t,
                amount: Number(cell.val),
                date: `${filterPrefix}-01`,
                by: currentUser?.id || "admin",
                at: new Date().toISOString()
              });
              count++;
            }
          });
        });

        if (count === 0) { confirm({ title: "Notice", message: "All current values are already actual records!", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} }); return; }
        try {
          await batch.commit();
          toast({ title: "Synced", message: `Successfully synced ${count} records.`, type: "success" });
          confirm({ title: "Success", message: `Successfully synced ${count} suggestions to actual records.`, confirmText: "OK", cancelText: "Close", type: "success", onConfirm: () => {} });
        } catch (err) { confirm({ title: "Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} }); }
      }
    });
  };

  const handleSaveExpense = async (formData) => {
    try {
      const payload = {
        ...formData,
        amount: Number(formData.amount),
        updated_by: currentUser?.id || "admin",
        updated_at: new Date().toISOString()
      };
      
      if (formData.id) {
        await setDoc(doc(db, "fixed_expenses", formData.id), payload, { merge: true });
      } else {
        await addDoc(collection(db, "fixed_expenses"), {
          ...payload,
          by: currentUser?.id || "admin",
          at: new Date().toISOString()
        });
      }
      setShowForm(false);
      setEditingDoc(null);
      toast({ title: "Saved", message: "Expense record saved successfully.", type: "success" });
    } catch (err) { confirm({ title: "Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} }); }
  };

  const handleInputChange = (bid, type, val) => {
    setLocalGrid(prev => ({
      ...prev,
      [bid]: { ...prev[bid], [type]: { ...prev[bid]?.[type], val: val } }
    }));
  };

  const handleDelete = (id) => {
    confirm({
      title: "Delete Record",
      message: "Are you sure you want to delete this record?",
      confirmText: "Delete",
      cancelText: "Cancel",
      type: "danger",
      onConfirm: async () => {
        try {
          await deleteDoc(doc(db, "fixed_expenses", id));
          toast({ title: "Deleted", message: "Expense record has been removed.", type: "success" });
        } catch (err) { confirm({ title: "Error", message: "Delete failed: " + err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} }); }
      }
    });
  };

  const IS = { padding: "11px 14px", border: "2px solid var(--input-border)", borderRadius: 10, fontSize: 14, background: "var(--bg2)", color: "var(--text)", fontFamily: "var(--font-outfit)", width: "100%", outline: "none" };

  // Group by type for summary
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // ── KPIs & annual total — memoized; reads precomputed maps instead of repeated filter+reduce.
  const networkFixed = useMemo(
    () => branches.reduce((s, b) => s + (gridTotalByBranch.get(b.id) || 0), 0),
    [branches, gridTotalByBranch]
  );

  const { networkSalary, networkVar } = useMemo(() => {
    if (filterMode !== "month") return { networkSalary: 0, networkVar: 0 };
    let sal = 0, varr = 0;
    for (let i = 0; i < branches.length; i++) {
      const bid = branches[i].id;
      const bStaff = staffByBranch.get(bid) || [];
      for (let j = 0; j < bStaff.length; j++) {
        sal += proRataSalary(bStaff[j], filterPrefix, branches, salHistory, staff);
      }
      varr += dailyAggByBranchMonth.get(`${bid}|${filterPrefix}`)?.variable || 0;
    }
    return { networkSalary: sal, networkVar: varr };
  }, [branches, staffByBranch, salHistory, staff, dailyAggByBranchMonth, filterPrefix, filterMode]);

  const networkAnnualTotal = useMemo(() => {
    const REAL_NOW = new Date().toISOString().slice(0, 7);
    let total = 0;
    for (let i = 0; i < branches.length; i++) {
      const b = branches[i];
      const mBase = (Number(b.shop_rent) || 0) + (Number(b.room_rent) || 0) + (Number(b.shop_elec) || 0) + (Number(b.room_elec) || 0) + (Number(b.water) || 0) + (Number(b.wifi) || 0) + (Number(b.maid) || 0) + (Number(b.garbage) || 0) + (Number(b.dust) || 0);
      const gridSum = gridTotalByBranch.get(b.id) || 0;
      const bStaff = staffByBranch.get(b.id) || [];
      for (let m = 1; m <= 12; m++) {
        const pref = `${filterYear}-${String(m).padStart(2, "0")}`;
        const isFuture = pref > REAL_NOW;
        const isCurrent = pref === filterPrefix;
        const mAct = expensesByBranchMonth.get(`${b.id}|${pref}`) || 0;
        if (!isFuture) {
          total += (mAct > 0 || isCurrent ? (mAct || (isCurrent ? gridSum : mBase)) : mBase);
          if (viewType === "total") {
            for (let j = 0; j < bStaff.length; j++) {
              total += proRataSalary(bStaff[j], pref, branches, salHistory, staff);
            }
            const dailyAgg = dailyAggByBranchMonth.get(`${b.id}|${pref}`);
            if (dailyAgg) total += dailyAgg.variable;
          }
        } else {
          total += mAct; // ONLY ACTUALS FOR FUTURE
        }
      }
    }
    return total;
  }, [branches, filterYear, filterPrefix, viewType, expensesByBranchMonth, dailyAggByBranchMonth, staffByBranch, gridTotalByBranch, salHistory, staff]);

  const displayTotal = filterMode === "month" 
    ? (viewType === "fixed" ? networkFixed : (networkFixed + networkSalary + networkVar)) 
    : networkAnnualTotal;

  if (loading) return <div style={{ textAlign: "center", color: "var(--accent)", fontWeight: 600, padding: 40, fontFamily: "var(--font-headline, var(--font-outfit))" }}>Loading Expenses...</div>;

  const TS = { padding: "6px 12px", borderRadius: 8, fontSize: 11, fontWeight: 700, border: "none", cursor: "pointer", transition: "all .2s", textTransform: "uppercase", letterSpacing: 0.5 };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 20 }}>
        <div>
           <h2 style={{ fontSize: 28, fontWeight: 800, color: "var(--text)", letterSpacing: -0.5, margin: 0, fontFamily: "var(--font-headline, var(--font-outfit))" }}>Financial Expenses</h2>
           <div style={{ display: "flex", gap: 3, marginTop: 10, background: "var(--bg4)", padding: 3, borderRadius: 10 }}>
              <button onClick={() => setViewType("fixed")} style={{ ...TS, background: viewType === "fixed" ? "linear-gradient(135deg, var(--accent), var(--gold2))" : "transparent", color: viewType === "fixed" ? "#000" : "var(--text3)" }}>Fixed Only</button>
              <button onClick={() => setViewType("total")} style={{ ...TS, background: viewType === "total" ? "linear-gradient(135deg, var(--accent), var(--gold2))" : "transparent", color: viewType === "total" ? "#000" : "var(--text3)" }}>Total (F+S+V)</button>
           </div>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          {canEdit && filterMode === "month" && (
            <>
              <button onClick={handleSyncMasterData} title="Convert all master suggestions to records"
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 16px", borderRadius: 10, background: "var(--bg3)", color: "var(--text3)", border: "1px solid rgba(72,72,71,0.12)", cursor: "pointer", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
                Sync Master
              </button>
              <button onClick={() => openForm()}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 16px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", cursor: "pointer", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
                <Icon name="plus" size={12} /> Log Single
              </button>
            </>
          )}
          {canEdit && filterMode === "month" && (
            <>
              <button onClick={downloadExpenseTemplate} disabled={templating} title="Download a blank template for this month"
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 16px", borderRadius: 10, background: "var(--bg3)", color: "var(--orange)", border: "1px solid rgba(72,72,71,0.12)", cursor: templating ? "wait" : "pointer", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, opacity: templating ? 0.6 : 1 }}>
                <Icon name="save" size={12} /> {templating ? "Generating..." : "Template"}
              </button>
              <label title="Upload filled template (simulates before committing)"
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 16px", borderRadius: 10, background: "var(--bg3)", color: "var(--accent)", border: "1px solid rgba(72,72,71,0.12)", cursor: "pointer", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
                <Icon name="plus" size={12} /> Upload
                <input type="file" accept=".xlsx,.xls" onChange={handleExpenseUpload} style={{ display: "none" }} />
              </label>
            </>
          )}
          {isAdmin && (
            <button onClick={exportExpenses} disabled={exporting} title="Export financial expenses to Excel"
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 16px", borderRadius: 10, background: "var(--bg3)", color: "var(--green)", border: "1px solid rgba(72,72,71,0.12)", cursor: exporting ? "wait" : "pointer", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, opacity: exporting ? 0.6 : 1 }}>
              <Icon name="save" size={12} /> {exporting ? "Exporting..." : "Export"}
            </button>
          )}
        </div>
      </div>

      {/* Stat Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
        <div onClick={() => setFocusedCol(null)} style={{ background: "var(--bg3)", padding: "18px 22px", borderRadius: 14, cursor: "pointer", border: "1px solid rgba(72,72,71,0.1)" }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>Fixed Costs</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--orange)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(networkFixed)}</div>
        </div>
        <div onClick={() => setFocusedCol("Salary")} style={{ background: "var(--bg3)", padding: "18px 22px", borderRadius: 14, cursor: "pointer", border: "1px solid rgba(72,72,71,0.1)" }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>Variable Costs</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--blue)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(networkSalary + networkVar)}</div>
        </div>
        <div onClick={() => setFocusedCol(null)} style={{ background: "var(--bg3)", padding: "18px 22px", borderRadius: 14, cursor: "pointer", border: "1px solid rgba(72,72,71,0.1)" }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>Total Spending</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--red)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(displayTotal)}</div>
        </div>
      </div>

      <PeriodWidget
        filterMode={filterMode} setFilterMode={setFilterMode} filterYear={filterYear} setFilterYear={setFilterYear} filterMonth={filterMonth} setFilterMonth={setFilterMonth}
        onEdit={() => setBulkEdit(!bulkEdit)}
      />

      {/* Grid Matrix */}
      <Card style={{ padding: 0, overflow: "auto", maxHeight: "calc(100vh - 320px)" }}>
        <table style={{ minWidth: "max-content", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
          {filterMode === "month" ? (
            <>
              <thead>
                <tr style={{ position: "sticky", top: 0, zIndex: 10 }}>
                  <TH onClick={() => setFocusedCol(null)} style={{ position: "sticky", left: 0, background: "var(--bg4)", zIndex: 11, borderRight: "1px solid rgba(72,72,71,0.15)", width: 130, minWidth: 130, cursor: "pointer", fontSize: 11 }}>Branch</TH>

                  {viewType === "total" && isAdmin && <TH right onClick={() => setFocusedCol("Salary")} style={{ width: 110, minWidth: 110, background: focusedCol === "Salary" ? "rgba(96,165,250,0.08)" : "var(--bg4)", color: "var(--blue)", cursor: "pointer" }}>Salary</TH>}
                  {viewType === "total" && <TH right onClick={() => setFocusedCol("Variable")} style={{ width: 110, minWidth: 110, background: focusedCol === "Variable" ? "rgba(96,165,250,0.08)" : "var(--bg4)", color: "var(--blue)", cursor: "pointer" }}>Variable</TH>}

                  {activeCols.map(t => {
                    const label = t.replace(/Bill/gi, "").replace(/ \/ /g, "/").replace(/Electricity/gi, "Elec").replace(/Collector /gi, "").replace(/Maintenance/gi, "Maint").replace(/Service/gi, "Svc").replace(/ELECTRICAL/gi, "ELEC");
                    return (
                      <TH key={t} right onClick={() => setFocusedCol(t)} style={{
                        color: focusedCol === t ? "var(--accent)" : "var(--text3)", fontSize: 9,
                        whiteSpace: "nowrap", padding: "12px 8px", background: focusedCol === t ? "rgba(var(--accent-rgb),0.04)" : "var(--bg4)",
                        width: 110, minWidth: 110, cursor: "pointer"
                      }}>
                        {label}
                      </TH>
                    );
                  })}
                  <TH right onClick={() => setFocusedCol(null)} style={{ fontWeight: 700, fontSize: 11, background: "var(--bg4)", borderLeft: "1px solid rgba(72,72,71,0.15)", position: "sticky", right: 0, zIndex: 15, width: 120, minWidth: 120, cursor: "pointer" }}>Total</TH>
                </tr>
              </thead>
              <tbody>
                {branches.map(b => {
                  const bGrid = localGrid[b.id] || {};
                  const stats = getBranchStats(b.id);
                  const fixedTotal = activeCols.reduce((s, t) => s + (Number(bGrid[t]?.val) || 0), 0);
                  const rowTotal = viewType === "fixed" ? fixedTotal : (fixedTotal + stats.salary + stats.variable);

                  return (
                    <tr key={b.id} style={{ transition: "background 0.15s" }}
                      onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.015)"}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <TD style={{ fontWeight: 700, color: "var(--text)", fontSize: 12, position: "sticky", left: 0, background: "var(--bg3)", zIndex: 5, borderRight: "1px solid rgba(72,72,71,0.1)", width: 130, minWidth: 130 }}>{b.name.replace("V-CUT ", "")}</TD>

                      {viewType === "total" && (
                        <>
                          {isAdmin && <TD right style={{ fontWeight: 700, color: "var(--blue)", fontSize: 12, background: focusedCol === "Salary" ? "rgba(96,165,250,0.06)" : "transparent" }}>{INR(stats.salary)}</TD>}
                          <TD right style={{ fontWeight: 700, color: "var(--blue)", fontSize: 12, background: focusedCol === "Variable" ? "rgba(96,165,250,0.06)" : "transparent" }}>{INR(stats.variable)}</TD>
                        </>
                      )}

                      {activeCols.map(t => {
                        const cell = bGrid[t] || { val: "", isActual: false };
                        return (
                          <TD key={t} right style={{ padding: "6px 4px", background: focusedCol === t ? "rgba(var(--accent-rgb),0.02)" : "transparent", width: 110 }}>
                            <input
                              type="number"
                              value={cell.val}
                              onChange={(e) => handleInputChange(b.id, t, e.target.value)}
                              onBlur={(e) => handleGridUpdate(b.id, t, e.target.value)}
                              placeholder="—"
                              style={{
                                width: 80, padding: "7px 8px", background: bulkEdit ? "var(--bg4)" : "var(--bg4)",
                                border: "none", borderBottom: cell.isActual ? "2px solid var(--accent)" : "2px solid transparent",
                                borderRadius: 8,
                                color: cell.isActual ? "var(--red)" : "var(--text3)",
                                fontWeight: 700, fontStyle: cell.isActual ? "normal" : "italic",
                                textAlign: "right", fontSize: 13, outline: "none", transition: "all .2s",
                                fontFamily: "var(--font-headline, var(--font-outfit))",
                                pointerEvents: (canEdit || bulkEdit) ? "auto" : "none"
                              }}
                            />
                          </TD>
                        );
                      })}
                      <TD right style={{ fontWeight: 800, color: "var(--red)", fontSize: 14, background: "var(--bg3)", padding: "0 14px", borderLeft: "1px solid rgba(72,72,71,0.1)", position: "sticky", right: 0, zIndex: 10, width: 120, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(rowTotal)}</TD>
                    </tr>
                  );
                })}
              </tbody>
            </>
          ) : (
            <>
              <thead>
                <tr style={{ position: "sticky", top: 0, zIndex: 10 }}>
                  <TH style={{ position: "sticky", left: 0, background: "var(--bg4)", zIndex: 20, borderRight: "1px solid rgba(72,72,71,0.15)", minWidth: 120, fontSize: 11 }}>Branch</TH>
                  {MONTHS.map(m => <TH key={m} right style={{ background: "var(--bg4)", fontSize: 10, color: "var(--text3)" }}>{m}</TH>)}
                  <TH right style={{ background: "var(--bg4)", borderLeft: "1px solid rgba(72,72,71,0.15)", fontSize: 11, position: "sticky", right: 0, zIndex: 15 }}>{viewType === "fixed" ? "YTD Fixed" : "YTD Total"}</TH>
                </tr>
              </thead>
              <tbody>
                {branches.map(b => {
                  let branchYearTotal = 0;
                  return (
                    <tr key={b.id} style={{ transition: "background 0.15s" }}
                      onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.015)"}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <TD style={{ fontWeight: 700, color: "var(--text)", fontSize: 12, position: "sticky", left: 0, background: "var(--bg3)", zIndex: 5, borderRight: "1px solid rgba(72,72,71,0.1)", width: 130, minWidth: 130 }}>{b.name.replace("V-CUT ", "")}</TD>
                      {MONTHS.map((m, i) => {
                        const mPrefix = `${filterYear}-${String(i + 1).padStart(2, "0")}`;
                        const REAL_NOW = new Date().toISOString().slice(0, 7); 
                        const isFuture = mPrefix > REAL_NOW;
                        
                        // 1. Get Actuals from DB
                        const mActuals = expenses.filter(e => e.branch_id === b.id && e.date?.startsWith(mPrefix)).reduce((s, e) => s + (e.amount || 0), 0);
                        
                        // 2. Baseline Fallback ONLY for past/current
                        let mFixed = mActuals;
                        if (!isFuture && mFixed === 0) {
                          mFixed = (Number(b.shop_rent) || 0) + (Number(b.room_rent) || 0) + (Number(b.shop_elec) || 0) + (Number(b.room_elec) || 0) + (Number(b.water) || 0) + (Number(b.wifi) || 0) + (Number(b.maid) || 0) + (Number(b.garbage) || 0) + (Number(b.dust) || 0);
                        }

                        let mTotal = mFixed;

                        if (viewType === "total" && !isFuture) {
                          const bStaff = staff.filter(s => s.branch_id === b.id);
                          const mSalary = bStaff.reduce((s, st) => s + proRataSalary(st, mPrefix, branches, salHistory, staff), 0);
                          const bEntries = dailyEntries.filter(e => e.branch_id === b.id && e.date?.startsWith(mPrefix));
                          const mVar = bEntries.reduce((s, e) => {
                            const sb = e.staff_billing || [];
                            const incs = sb.reduce((ss, x) => ss + (x.staff_total_inc || (x.incentive || 0) + (x.mat_incentive || 0) + (x.tips || 0)), 0);
                            return s + (e.mat_expense || 0) + (e.petrol || 0) + (e.others || 0) + incs;
                          }, 0);
                          mTotal += (mSalary + mVar);
                        } else if (viewType === "total" && isFuture) {
                           // Future total view should also only show manual actuals
                           mTotal = mActuals; 
                        }

                        branchYearTotal += mTotal;
                        return <TD key={i} right style={{ color: mTotal > 0 ? "var(--red)" : "var(--text3)", fontWeight: 700, fontSize: 12, fontFamily: "var(--font-headline, var(--font-outfit))", opacity: mTotal > 0 ? 1 : 0.3 }}>{mTotal > 0 ? INR(mTotal) : "—"}</TD>;
                      })}
                      <TD right style={{ fontWeight: 800, color: "var(--red)", fontSize: 14, background: "var(--bg3)", borderLeft: "1px solid rgba(72,72,71,0.1)", position: "sticky", right: 0, zIndex: 5, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(branchYearTotal)}</TD>
                    </tr>
                  );
                })}
              </tbody>
            </>
          )}
          <tfoot style={{ position: "sticky", bottom: 0, zIndex: 10 }}>
             <tr style={{ background: "var(--bg4)" }}>
                <TD style={{ color: "var(--text)", fontWeight: 700, letterSpacing: 0.5, position: "sticky", left: 0, background: "var(--bg4)", zIndex: 11, borderRight: "1px solid rgba(72,72,71,0.15)", width: 130, minWidth: 130, fontSize: 11, textTransform: "uppercase" }}>Network Total</TD>

                {filterMode === "month" ? (
                  <>
                    {viewType === "total" && isAdmin && <TD right style={{ color: "var(--blue)", fontWeight: 700, width: 110, minWidth: 110, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(networkSalary)}</TD>}
                    {viewType === "total" && <TD right style={{ color: "var(--blue)", fontWeight: 700, width: 110, minWidth: 110, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(networkVar)}</TD>}

                    {activeCols.map(t => {
                      const tTotal = branches.reduce((s, b) => s + (Number(localGrid[b.id]?.[t]?.val) || 0), 0);
                      return <TD key={t} right style={{ color: "var(--red)", fontSize: 12, width: 110, minWidth: 110, fontWeight: 700, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(tTotal)}</TD>;
                    })}
                    <TD right style={{ fontSize: 16, color: "var(--red)", fontWeight: 800, borderLeft: "1px solid rgba(72,72,71,0.15)", width: 120, minWidth: 120, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(displayTotal)}</TD>
                  </>
                ) : (
                  <>
                    {MONTHS.map((m, i) => {
                      const mPrefix = `${filterYear}-${String(i + 1).padStart(2, "0")}`;
                      const REAL_NOW = new Date().toISOString().slice(0, 7);
                      const isFuture = mPrefix > REAL_NOW;
                      const isCurrentActive = mPrefix === filterPrefix;
                      
                      // Network Fixed (Actuals or Baseline if no data AND NOT FUTURE)
                      const nFixed = branches.reduce((s, b) => {
                         const mAct = expenses.filter(e => e.branch_id === b.id && e.date?.startsWith(mPrefix)).reduce((ss, e) => ss + (e.amount || 0), 0);
                         if (isFuture && mAct === 0) return s; 
                         const mBase = (Number(b.shop_rent) || 0) + (Number(b.room_rent) || 0) + (Number(b.shop_elec) || 0) + (Number(b.room_elec) || 0) + (Number(b.water) || 0) + (Number(b.wifi) || 0) + (Number(b.maid) || 0) + (Number(b.garbage) || 0) + (Number(b.dust) || 0);
                         return s + (mAct > 0 || isCurrentActive ? (mAct || (isCurrentActive ? activeCols.reduce((ss, t) => ss + (Number(localGrid[b.id]?.[t]?.val) || 0), 0) : mBase)) : mBase);
                      }, 0);

                      let nTotal = nFixed;

                      if (viewType === "total") {
                        const nSalary = staff.reduce((s, st) => s + proRataSalary(st, mPrefix, branches, salHistory, staff), 0);
                        const nEntries = dailyEntries.filter(e => e.date?.startsWith(mPrefix));
                        const nVar = nEntries.reduce((s, e) => {
                           const sb = e.staff_billing || [];
                           const incs = sb.reduce((ss, x) => ss + (x.staff_total_inc || (x.incentive || 0) + (x.mat_incentive || 0) + (x.tips || 0)), 0);
                           return s + (e.mat_expense || 0) + (e.petrol || 0) + (e.others || 0) + incs;
                        }, 0);
                        nTotal += (isFuture ? 0 : (nSalary + nVar)); // Future salary not shown unless projected is requested
                      }
                      return <TD key={i} right style={{ color: "var(--orange)", fontSize: 12, fontWeight: 700, width: 110, minWidth: 110, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{nTotal > 0 ? INR(nTotal) : "—"}</TD>;
                    })}
                    <TD right style={{ fontSize: 16, color: "var(--red)", fontWeight: 800, borderLeft: "1px solid rgba(72,72,71,0.15)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>
                      {INR(branches.reduce((s, b) => {
                         let bYearTotal = 0;
                         const REAL_NOW = new Date().toISOString().slice(0, 7);
                         for (let m=1; m<=12; m++) {
                           const pref = `${filterYear}-${String(m).padStart(2, "0")}`;
                           const isFuture = pref > REAL_NOW;
                           const isCurrent = pref === filterPrefix;
                           
                           // Final Grid-consistent Fixed Logic
                           const mAct = expenses.filter(e => e.branch_id === b.id && e.date?.startsWith(pref)).reduce((ss, e) => ss + (e.amount || 0), 0);
                           if (!isFuture) {
                             const mBase = (Number(b.shop_rent) || 0) + (Number(b.room_rent) || 0) + (Number(b.shop_elec) || 0) + (Number(b.room_elec) || 0) + (Number(b.water) || 0) + (Number(b.wifi) || 0) + (Number(b.maid) || 0) + (Number(b.garbage) || 0) + (Number(b.dust) || 0);
                             bYearTotal += (mAct > 0 || isCurrent ? (mAct || (isCurrent ? activeCols.reduce((ss, t) => ss + (Number(localGrid[b.id]?.[t]?.val) || 0), 0) : mBase)) : mBase);

                             if (viewType === "total") {
                                const bStaff = staff.filter(st => st.branch_id === b.id);
                                bYearTotal += bStaff.reduce((ss, st) => ss + proRataSalary(st, pref, branches, salHistory, staff), 0);
                                const bEntries = dailyEntries.filter(e => e.branch_id === b.id && e.date?.startsWith(pref));
                                bYearTotal += bEntries.reduce((ss, e) => {
                                   const sb = e.staff_billing || [];
                                   const incs = sb.reduce((sss, x) => sss + (x.staff_total_inc || (x.incentive || 0) + (x.mat_incentive || 0) + (x.tips || 0)), 0);
                                   return ss + (e.mat_expense || 0) + (e.petrol || 0) + (e.others || 0) + incs;
                                }, 0);
                             }
                           } else {
                             bYearTotal += mAct; // Only add actuals for future if user manually added them
                           }
                         }
                         return s + bYearTotal;
                      }, 0))}
                    </TD>
                  </>
                )}
             </tr>
          </tfoot>
        </table>
      </Card>

      {showForm && (
         <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}>
            <Card style={{ width: "100%", maxWidth: 480, background: "var(--bg2)", padding: 28 }}>
               <div style={{ marginBottom: 24, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontWeight: 700, color: "var(--text)", fontSize: 16, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{editingDoc ? "Edit Expense" : "Log Expense"}</div>
                  <button onClick={() => setShowForm(false)} style={{ background: "none", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: 18 }}>&#x2715;</button>
               </div>
               
               <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div>
                     <label style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase", fontWeight: 700, display: "block", marginBottom: 6 }}>Branch</label>
                     <select value={form.branch_id} onChange={e => setForm({...form, branch_id: e.target.value})} style={IS}>
                        {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                     </select>
                  </div>

                  <div>
                     <label style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase", fontWeight: 700, display: "block", marginBottom: 6 }}>Category</label>
                     <select value={form.type} onChange={e => setForm({...form, type: e.target.value})} style={IS}>
                        {activeCols.map(t => <option key={t} value={t}>{t}</option>)}
                     </select>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                     <div>
                        <label style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase", fontWeight: 700, display: "block", marginBottom: 6 }}>Amount (₹)</label>
                        <input type="number" value={form.amount} onChange={e => setForm({...form, amount: e.target.value})} placeholder="0.00" style={IS} />
                     </div>
                     <div>
                        <label style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase", fontWeight: 700, display: "block", marginBottom: 6 }}>Date</label>
                        <input type="date" value={form.date} onChange={e => setForm({...form, date: e.target.value})} style={IS} />
                     </div>
                  </div>

                  <div>
                     <label style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase", fontWeight: 700, display: "block", marginBottom: 6 }}>Notes / Remainder</label>
                     <textarea value={form.note} onChange={e => setForm({...form, note: e.target.value})} placeholder="Billing cycle details, bill number etc." style={{ ...IS, height: 80, resize: "none" }} />
                  </div>

                  <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                     <button onClick={() => handleSaveExpense(form)} style={{ flex: 1, padding: "14px", borderRadius: 10, background: "linear-gradient(135deg, var(--accent), var(--gold2))", color: "#000", border: "none", fontWeight: 700, cursor: "pointer", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>
                        {editingDoc ? "Update" : "Save"}
                     </button>
                     <button onClick={() => setShowForm(false)} style={{ flex: 1, padding: "14px", borderRadius: 10, background: "var(--bg4)", color: "var(--text3)", border: "none", fontWeight: 600, cursor: "pointer", fontSize: 12, textTransform: "uppercase" }}>
                        Cancel
                     </button>
                  </div>
               </div>
            </Card>
         </div>
      )}

      <div style={{ marginTop: 8 }}>
         <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 12, fontFamily: "var(--font-headline, var(--font-outfit))", display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="log" size={14} color="var(--text3)" /> History ({filtered.length} records)
         </h3>
         <Card style={{ padding: 0 }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
               <thead>
                  <tr>
                     <TH>Date</TH>
                     <TH>Branch</TH>
                     <TH>Category</TH>
                     <TH>Note</TH>
                     <TH right>Amount</TH>
                     <TH right>Actions</TH>
                  </tr>
               </thead>
               <tbody>
                  {filtered.map(e => (
                     <tr key={e.id}>
                        <TD style={{ color: "var(--text3)" }}>{e.date}</TD>
                        <TD style={{ fontWeight: 600 }}>{branches.find(b => b.id === e.branch_id)?.name.replace("V-CUT ", "") || e.branch_id}</TD>
                        <TD><Pill label={e.type} color="blue" /></TD>
                        <TD style={{ fontSize: 11, color: "var(--text3)" }}>{e.note || "—"}</TD>
                        <TD right style={{ fontWeight: 700, color: "var(--red)" }}>{INR(e.amount)}</TD>
                        <TD right style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                           <IconBtn name="edit" variant="primary" size={22} onClick={() => openForm(e)} />
                           <IconBtn name="del" variant="danger" size={22} onClick={() => handleDelete(e.id)} />
                        </TD>
                     </tr>
                  ))}
                  {filtered.length === 0 && (
                     <tr><TD colSpan={6} style={{ textAlign: "center", padding: 40, color: "var(--text3)" }}>No history for this period</TD></tr>
                  )}
               </tbody>
            </table>
         </Card>
      </div>
      {/* Upload Simulation Modal */}
      <Modal isOpen={!!uploadPreview} onClose={() => !committing && setUploadPreview(null)} title={`Simulate Upload — ${uploadPreview?.period || ""}`} width={900}>
        {uploadPreview && (() => {
          const changes = [];
          let additions = 0, updates = 0, unchanged = 0, cleared = 0;
          uploadPreview.rows.forEach(({ branch, values, existing }) => {
            activeCols.forEach(cat => {
              const newVal = values[cat];
              const oldVal = existing[cat];
              if (newVal == null && (oldVal == null || oldVal === 0)) return;
              if (newVal == null) { /* left blank */ return; }
              if (oldVal == null) {
                additions++;
                changes.push({ branch: branch.name.replace("V-CUT ", ""), cat, old: null, nw: newVal, kind: "add" });
              } else if (Number(oldVal) === Number(newVal)) {
                unchanged++;
              } else if (Number(newVal) === 0 && Number(oldVal) > 0) {
                cleared++;
                changes.push({ branch: branch.name.replace("V-CUT ", ""), cat, old: oldVal, nw: newVal, kind: "clear" });
              } else {
                updates++;
                changes.push({ branch: branch.name.replace("V-CUT ", ""), cat, old: oldVal, nw: newVal, kind: "update" });
              }
            });
          });
          const hasErrors = uploadPreview.errors.length > 0;
          return (
            <div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
                {[["Additions", additions, "var(--green)"], ["Updates", updates, "var(--accent)"], ["Cleared", cleared, "var(--orange)"], ["Unchanged", unchanged, "var(--text3)"]].map(([l, v, c]) => (
                  <div key={l} style={{ padding: 12, borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border)" }}>
                    <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: c, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{v}</div>
                  </div>
                ))}
              </div>
              {hasErrors && (
                <div style={{ padding: 12, borderRadius: 10, background: "var(--red-bg)", border: "1px solid rgba(248,113,113,0.3)", marginBottom: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "var(--red)", marginBottom: 6 }}>{uploadPreview.errors.length} error(s) — fix and re-upload:</div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: "var(--red)" }}>
                    {uploadPreview.errors.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}
                    {uploadPreview.errors.length > 10 && <li>…and {uploadPreview.errors.length - 10} more</li>}
                  </ul>
                </div>
              )}
              <div style={{ maxHeight: 400, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 10 }}>
                <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
                  <thead style={{ position: "sticky", top: 0, background: "var(--bg4)", zIndex: 1 }}>
                    <tr><TH>Branch</TH><TH>Category</TH><TH right>Old</TH><TH right>New</TH><TH>Kind</TH></tr>
                  </thead>
                  <tbody>
                    {changes.length === 0 && <tr><td colSpan={5} style={{ padding: 20, textAlign: "center", color: "var(--text3)" }}>No differences detected.</td></tr>}
                    {changes.map((ch, i) => (
                      <tr key={i}>
                        <TD style={{ fontWeight: 700 }}>{ch.branch}</TD>
                        <TD>{ch.cat}</TD>
                        <TD right style={{ color: "var(--text3)" }}>{ch.old == null ? "—" : INR(ch.old)}</TD>
                        <TD right style={{ color: ch.kind === "clear" ? "var(--orange)" : ch.kind === "add" ? "var(--green)" : "var(--accent)", fontWeight: 700 }}>{INR(ch.nw)}</TD>
                        <TD><Pill label={ch.kind.toUpperCase()} color={ch.kind === "add" ? "green" : ch.kind === "clear" ? "orange" : "blue"} /></TD>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
                <button onClick={() => setUploadPreview(null)} disabled={committing}
                  style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: committing ? "wait" : "pointer" }}>
                  Cancel
                </button>
                <button onClick={commitUpload} disabled={committing || hasErrors || (additions + updates + cleared === 0)}
                  style={{ padding: "10px 18px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: committing ? "wait" : "pointer", opacity: (committing || hasErrors || (additions + updates + cleared === 0)) ? 0.5 : 1 }}>
                  {committing ? "Committing..." : `Commit ${additions + updates + cleared} Change(s)`}
                </button>
              </div>
            </div>
          );
        })()}
      </Modal>

      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}
