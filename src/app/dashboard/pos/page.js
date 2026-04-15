"use client";
import { useEffect, useState, useRef, useMemo, startTransition } from "react";
import { collection, onSnapshot, query, orderBy, where, addDoc, deleteDoc, doc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR } from "@/lib/calculations";
import { Icon, IconBtn, Card, PeriodWidget, TH, TD, Modal, useConfirm, useToast } from "@/components/ui";
import { staffStatusForMonth, effectiveBranchOnDate } from "@/lib/calculations";

// ExcelJS is ~200KB — load only when Template/Upload/Export is actually used.
let _excelJSPromise = null;
const loadExcelJS = () => {
  if (!_excelJSPromise) _excelJSPromise = import("exceljs").then(m => m.default || m);
  return _excelJSPromise;
};

// One-pass aggregator for an array of staff_billing rows.
// Returns all five totals in a single walk instead of 5 separate reduce passes.
const sumStaffBilling = (arr) => {
  const out = { billing: 0, material: 0, incentive: 0, tips: 0, staffTotalInc: 0 };
  if (!arr) return out;
  for (let i = 0; i < arr.length; i++) {
    const sb = arr[i] || {};
    out.billing       += Number(sb.billing)        || 0;
    out.material      += Number(sb.material)       || 0;
    out.incentive     += (Number(sb.incentive) || 0) + (Number(sb.mat_incentive) || 0);
    out.tips          += Number(sb.tips)           || 0;
    out.staffTotalInc += Number(sb.staff_total_inc) || 0;
  }
  return out;
};

const NOW = new Date();

export default function POSPage() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const pendingTemplateRef = useRef(null);

  // Save file with native "Save As" dialog (browse folder + rename)
  const saveFileWithPicker = async (blob, suggestedName, toastTitle, toastMsg) => {
    try {
      // Use direct download (works without user gesture requirement)
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = suggestedName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast({ title: toastTitle, message: toastMsg, type: "success" });
    } catch (err) {
      if (err.name !== "AbortError") {
        confirm({ title: "Save Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
      }
    }
  };

  const [branches, setBranches] = useState([]);
  const [staff, setStaff] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");

  // Period filter state
  const [filterMode, setFilterMode] = useState("month");
  const [filterYear, setFilterYear] = useState(NOW.getFullYear());
  const [filterMonth, setFilterMonth] = useState(NOW.getMonth() + 1);
  const filterPrefix = filterYear + "-" + String(filterMonth).padStart(2, "0");

  // Entry form state
  const [selBranch, setSelBranch] = useState("");
  const [selDate, setSelDate] = useState(new Date().toISOString().slice(0, 10));
  const [onlineInc, setOnlineInc] = useState("");
  const [matExp, setMatExp] = useState("");
  const [otherExp, setOtherExp] = useState("");
  const [petrol, setPetrol] = useState("");
  const [actualCash, setActualCash] = useState("");
  const [leavePrompt, setLeavePrompt] = useState(null); // { staff, type, reason }
  const [globalSettings, setGlobalSettings] = useState(null);
  const [globalGst, setGlobalGst] = useState("5");
  const [gstPct, setGstPct] = useState("5"); // Form's active GST %
  const [staffRows, setStaffRows] = useState({}); // { [sid]: { billing, material, incentive, tips, gst, staff_total_inc } }
  const [editId, setEditId] = useState(null);
  const [logView, setLogView] = useState(null);
  const [recentView, setRecentView] = useState("branch"); // "branch" | "all" | "date" | "range"
  const [recentDate, setRecentDate] = useState(""); // defaults to selDate
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [uploadPreview, setUploadPreview] = useState(null); // { rows: [...], errors: [...], valid: [...] }
  const [templatePicker, setTemplatePicker] = useState(false); // show format choice
  const [generatingTemplate, setGeneratingTemplate] = useState(false);
  
  // Track original values to allow updates to existing duplicates
  const [origBranch, setOrigBranch] = useState("");
  const [origDate, setOrigDate] = useState("");

  const currentUser = useCurrentUser() || {};
  const roleKnown = !!currentUser?.role;
  const canEdit = !roleKnown || ["admin", "accountant"].includes(currentUser.role);
  const isAdminUser = !roleKnown || currentUser.role === "admin";

  // ── POS Specific State ──
  const [cart, setCart] = useState([]); // Array of { id, serviceName, price, staffId }
  const [activeCategory, setActiveCategory] = useState("Artistic Styling");
  const [defaultStaffId, setDefaultStaffId] = useState(""); // stylist auto-applied to new cart items
  const [billPreview, setBillPreview] = useState(null); // bill data ready to print
  const [clientSearch, setClientSearch] = useState("");
  const [customers, setCustomers] = useState([]);
  const [menus, setMenus] = useState([]);
  const [invoices, setInvoices] = useState([]); // today's invoices (drafts + settled) for selected branch
  const [editingDraftId, setEditingDraftId] = useState(null);
  const [historyInvoices, setHistoryInvoices] = useState([]); // all invoices (settled + draft) in current filter period
  const [historySearch, setHistorySearch] = useState("");
  const [expandedBranchId, setExpandedBranchId] = useState(null);
  // Drill-down filters for the expanded branch
  const [branchSortBy, setBranchSortBy] = useState("date_desc"); // date_desc | date_asc | amount_desc | amount_asc
  const [branchDateFilter, setBranchDateFilter] = useState("");
  const [branchCustomerFilter, setBranchCustomerFilter] = useState("");
  const [branchStatusFilter, setBranchStatusFilter] = useState("all"); // all | settled | draft
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [customerForm, setCustomerForm] = useState(null); // null | { name, phone, email, notes }
  const [viewMode, setViewMode] = useState("pos"); // "pos" | "history"

  // Dynamic menu: pulled from the `menus` collection based on selected branch.
  // Falls back to a short default when nothing is configured so the POS isn't empty.
  const FALLBACK_MENU = {
    "General Services": [
      { id: "F1", name: "Haircut", price: 500, time: "30m", icon: "✂️" },
      { id: "F2", name: "Hair Wash", price: 200, time: "20m", icon: "🛁" },
    ],
  };

  const activeMenus = useMemo(() => {
    if (!selBranch) return [];
    return menus.filter(m => (m.branches || []).includes(selBranch));
  }, [menus, selBranch]);

  // Flatten all applicable menus into { groupName: [items] }. When unisex+mens both tagged,
  // groups are prefixed with the menu type to keep them distinct.
  const MENU = useMemo(() => {
    if (activeMenus.length === 0) return selBranch ? {} : FALLBACK_MENU;
    const out = {};
    activeMenus.forEach(m => {
      (m.groups || []).forEach(g => {
        const label = activeMenus.length > 1
          ? `${m.type === "mens" ? "M" : "U"} · ${g.name}`
          : g.name;
        if (!out[label]) out[label] = [];
        (g.items || []).forEach((it, i) => {
          out[label].push({
            id: `${m.id}-${g.name}-${i}`,
            name: it.name,
            price: Number(it.price) || 0,
            time: it.time || "",
            icon: it.icon || "✨",
            menu_id: m.id,
            menu_type: m.type || "",
            group: g.name,
          });
        });
      });
    });
    return out;
  }, [activeMenus, selBranch]);

  // Keep activeCategory valid when branch changes or menu reloads
  useEffect(() => {
    const cats = Object.keys(MENU);
    if (cats.length > 0 && !cats.includes(activeCategory)) setActiveCategory(cats[0]);
  }, [MENU, activeCategory]);

  const addToCart = (service) => {
    if (!selBranch) {
      toast({ title: "Select a Branch First", message: "Pick a branch before adding services to the cart.", type: "warning" });
      return;
    }
    if (branchStaff.length === 0) {
      toast({ title: "No Staff Available", message: "No active staff in this branch for the selected date.", type: "warning" });
      return;
    }
    const targetStaffId = (defaultStaffId && branchStaff.some(s => s.id === defaultStaffId))
      ? defaultStaffId
      : branchStaff[0].id;
    const targetStaff = branchStaff.find(s => s.id === targetStaffId);
    const newItem = {
      ...service,
      cartId: Date.now() + Math.random(),
      staffId: targetStaffId
    };
    setCart([...cart, newItem]);

    const currentBilling = staffRows[targetStaffId]?.billing || 0;
    updateStaffRow(targetStaffId, "billing", currentBilling + service.price);
    toast({ title: "Item Added", message: `${service.name} → ${targetStaff?.name}`, type: "success" });
  };

  const removeFromCart = (cartItem) => {
    setCart(prev => prev.filter(item => item.cartId !== cartItem.cartId));
    // DEDUCT from staff billing
    if (cartItem.staffId) {
      const currentBilling = staffRows[cartItem.staffId]?.billing || 0;
      updateStaffRow(cartItem.staffId, "billing", Math.max(0, currentBilling - cartItem.price));
    }
  };

  const updateCartStaff = (cartId, newStaffId) => {
    setCart(prev => prev.map(item => {
      if (item.cartId === cartId) {
        // Transfer billing from old staff to new
        if (item.staffId) {
          const oldBill = staffRows[item.staffId]?.billing || 0;
          updateStaffRow(item.staffId, "billing", Math.max(0, oldBill - item.price));
        }
        if (newStaffId) {
          const newBill = staffRows[newStaffId]?.billing || 0;
          updateStaffRow(newStaffId, "billing", newBill + item.price);
        }
        return { ...item, staffId: newStaffId };
      }
      return item;
    }));
  };

  // Define handlers BEFORE any other function that references them.
  // (Turbopack/SWC minifier in production does not reliably hoist `function` declarations
  // the way dev does, which caused a TDZ ReferenceError on the live site.)
  const handleEdit = (e) => {
    setEditId(e.id);
    setSelBranch(e.branch_id);
    setSelDate(e.date);
    setOrigBranch(e.branch_id);
    setOrigDate(e.date);
    setOnlineInc(e.online || "");
    setMatExp(e.mat_expense || "");
    setOtherExp(e.others || "");
    setPetrol(e.petrol || "");
    setActualCash(e.actual_cash != null ? String(e.actual_cash) : "");
    setGstPct(e.global_gst_pct?.toString() || "18");

    const rows = {};
    if (e.staff_billing) {
      e.staff_billing.forEach(sb => {
        rows[sb.staff_id] = {
           billing: sb.billing || 0,
           material: sb.material || 0,
           incentive: sb.incentive || 0,
           mat_incentive: sb.mat_incentive || 0,
           tips: sb.tips || 0,
           gst: sb.gst || 0,
           tip_in: sb.tip_in || "online",
           tip_paid: sb.tip_paid || "cash",
           present: sb.present !== false,
           staff_total_inc: sb.staff_total_inc || 0,
        };
      });
    }
    setStaffRows(rows);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDelete = (eid) => {
    confirm({
      title: "Delete Entry",
      message: "Are you sure you want to <strong>permanently delete</strong> this entry? This action cannot be undone.",
      confirmText: "Yes, Delete",
      cancelText: "No, Keep",
      type: "danger",
      onConfirm: async () => {
        try {
          await deleteDoc(doc(db, "entries", eid));
          if (editId === eid) setEditId(null);
          toast({ title: "Deleted", message: "Entry has been removed.", type: "success" });
        } catch (err) { confirm({ title: "Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} }); }
      }
    });
  };

  const handleEntriesSn = (sn) => {
    const entriesList = sn.docs.map(d => ({ ...d.data(), id: d.id }));
    setEntries(entriesList);
    setLoading(false);

    try {
      if (typeof window !== "undefined" && !editId) {
        const params = new URLSearchParams(window.location.search);
        const editQuery = params.get("edit");
        if (editQuery && sn.docs.length > 0) {
          const e = sn.docs.map(d => ({ ...d.data(), id: d.id })).find(x => x.id === editQuery);
          if (e) handleEdit(e);
          // Clear current URL query
          const newUrl = window.location.pathname;
          window.history.replaceState({}, "", newUrl);
        }
      }
    } catch (err) { console.error("Edit query error", err); }
  };

  // Stable subscriptions (branches, staff, transfers, customers, menus, settings).
  useEffect(() => {
    if (!db) return;
    const wrap = (setter) => (sn) => startTransition(() => setter(sn.docs.map(d => ({ ...d.data(), id: d.id }))));
    const unsubs = [
      onSnapshot(collection(db, "branches"), wrap(setBranches)),
      onSnapshot(collection(db, "staff"), wrap(setStaff)),
      onSnapshot(collection(db, "staff_transfers"), wrap(setTransfers)),
      onSnapshot(collection(db, "customers"), wrap(setCustomers)),
      onSnapshot(collection(db, "menus"), wrap(setMenus)),
      onSnapshot(doc(db, "settings", "global"), sn => {
        if (!sn.exists()) return;
        const data = sn.data();
        startTransition(() => {
          setGlobalSettings(data);
          const rate = data.gst_pct?.toString() || "5";
          setGlobalGst(rate);
        });
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  useEffect(() => {
    if (!editId) setGstPct(globalGst);
  }, [globalGst, editId]);

  // Today's invoices (drafts + settled) for the selected branch.
  // Drafts auto-expire at midnight because subscription filters by today's date.
  useEffect(() => {
    if (!db || !selBranch || !selDate) { setInvoices([]); return; }
    const q = query(
      collection(db, "invoices"),
      where("branch_id", "==", selBranch),
      where("date", "==", selDate),
    );
    const unsub = onSnapshot(q, (sn) => startTransition(() =>
      setInvoices(sn.docs.map(d => ({ ...d.data(), id: d.id })))
    ));
    return () => unsub();
  }, [selBranch, selDate]);

  // Entries subscription scoped to current filter period (month or year).
  useEffect(() => {
    if (!db) return;
    let from, to;
    if (filterMode === "month") {
      from = `${filterPrefix}-01`;
      to   = `${filterPrefix}-31`;
    } else {
      from = `${filterYear}-01-01`;
      to   = `${filterYear}-12-31`;
    }
    const q = query(
      collection(db, "entries"),
      where("date", ">=", from),
      where("date", "<=", to),
      orderBy("date", "desc"),
    );
    const unsub = onSnapshot(q, (sn) => startTransition(() => handleEntriesSn(sn)));
    return () => unsub();
  }, [filterMode, filterPrefix, filterYear]);

  // Invoices subscription scoped to current filter period — powers the History tab
  // branch cards, drill-downs, and search-by-invoice. Settled invoices are permanent.
  useEffect(() => {
    if (!db) return;
    let from, to;
    if (filterMode === "month") {
      from = `${filterPrefix}-01`;
      to   = `${filterPrefix}-31`;
    } else {
      from = `${filterYear}-01-01`;
      to   = `${filterYear}-12-31`;
    }
    const q = query(
      collection(db, "invoices"),
      where("date", ">=", from),
      where("date", "<=", to),
    );
    const unsub = onSnapshot(q, (sn) => startTransition(() =>
      setHistoryInvoices(sn.docs.map(d => ({ ...d.data(), id: d.id })))
    ));
    return () => unsub();
  }, [filterMode, filterPrefix, filterYear]);

  // Branch lookup — memoized so per-row resolution in tables/exports is O(1) instead of O(n).
  const branchesById = useMemo(() => {
    const m = new Map();
    branches.forEach(b => m.set(b.id, b));
    return m;
  }, [branches]);

  // Active staff for selected branch and date — honors active transfers and day-level bounds.
  // Rules:
  //   - Must be at their effective branch on this date (handles temporary transfers).
  //   - selDate must not be before the join date.
  //   - selDate must not be after the exit date (so a mid-month exit hides them on later days
  //     but keeps them available for days up to and including the exit date).
  const branchStaff = selBranch && selDate
    ? staff.filter(s => {
        if (effectiveBranchOnDate(s, selDate, transfers) !== selBranch) return false;
        if (s.join && selDate < s.join) return false;
        if (s.exit_date && selDate > s.exit_date) return false;
        const mon = selDate.slice(0, 7);
        return staffStatusForMonth(s, mon).status !== "inactive";
      })
    : [];

  const updateStaffRow = (sid, field, value) => {
    setStaffRows(prev => {
      const row = prev[sid] || {};
      // Pass-through fields that don't trigger recalculation
      if (field === "tip_in" || field === "tip_paid" || field === "present" || field === "leave_type" || field === "leave_reason") {
        return { ...prev, [sid]: { ...row, [field]: value } };
      }
      const billing = field === "billing" ? Number(value) : (row.billing || 0);
      const material = field === "material" ? Number(value) : (row.material || 0);
      const tips = field === "tips" ? Number(value) : (row.tips || 0);
      const s = staff.find(x => x.id === sid);
      const b = branchesById.get(selBranch);
      
      // Global division-based incentive rate
      let incRateRaw = 10;
      if (globalSettings) {
        if (b?.type === 'unisex') incRateRaw = globalSettings.unisex_inc ?? 10;
        else incRateRaw = globalSettings.mens_inc ?? 10;
      } else if (s?.incentive_pct !== undefined) {
        incRateRaw = s.incentive_pct;
      }
      
      const incPct = incRateRaw / 100;
      const matPct = 0.05;
      
      const incentive = field === "billing" ? Math.round(billing * incPct) : Math.round((field === "incentive" ? Number(value) : (row.incentive !== undefined ? row.incentive : Math.round(billing * incPct))));
      const mat_incentive = Math.round(material * matPct);
      
      const staffTotalInc = incentive + mat_incentive + tips;
      
      const total = billing + material + tips - incentive - mat_incentive;
      return { ...prev, [sid]: { ...row, billing, material, tips, incentive, mat_incentive, staff_total_inc: staffTotalInc, total } };
    });
  };

  // Removed old GST recalculation useEffect as it is now global based on Online Income

  // Totals — single pass over staffRows, memoized so unrelated keystrokes don't rerun it.
  const { totalBilling, totalMatSale, totalIncentive, totalTips, totalStaffIncCombined } = useMemo(() => {
    const acc = { totalBilling: 0, totalMatSale: 0, totalIncentive: 0, totalTips: 0, totalStaffIncCombined: 0 };
    const rows = Object.values(staffRows);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      acc.totalBilling           += Number(r.billing)         || 0;
      acc.totalMatSale           += Number(r.material)        || 0;
      acc.totalIncentive         += (Number(r.incentive) || 0) + (Number(r.mat_incentive) || 0);
      acc.totalTips              += Number(r.tips)            || 0;
      acc.totalStaffIncCombined  += Number(r.staff_total_inc) || 0;
    }
    return acc;
  }, [staffRows]);
  
  // Online is the manual input; Cash auto-fills to absorb the remainder of total sales.
  const globalTotalSales = totalBilling + totalMatSale;
  const totalOnline = Math.max(0, Number(onlineInc) || 0);
  const totalCash = Math.max(0, globalTotalSales - totalOnline);

  // GST calculated on the Online portion
  const totalRowGst = Math.round(totalOnline * (Number(gstPct) || 0) / 100);

  // Tip flow — defaults: received online, paid in cash (most common)
  const { tipsInCash, tipsPaidCash } = useMemo(() => {
    let inCash = 0, outCash = 0;
    Object.values(staffRows).forEach(r => {
      const t = Number(r.tips) || 0;
      if (!t) return;
      if ((r.tip_in || "online") === "cash") inCash += t;
      if ((r.tip_paid || "cash") === "cash") outCash += t;
    });
    return { tipsInCash: inCash, tipsPaidCash: outCash };
  }, [staffRows]);

  // Cash drawer balance: cash sales + cash tips received − cash tips paid − incentive − expenses
  const cashInHand = totalCash + tipsInCash - tipsPaidCash - totalIncentive - (Number(otherExp) || 0) - (Number(petrol) || 0);

  // Reconciliation: actual counted cash vs expected cash-in-hand
  const actualCashNum = actualCash === "" ? null : Number(actualCash);
  const cashDiff = actualCashNum === null ? null : Math.round(actualCashNum - cashInHand);

  // Attendance handlers
  const handleAttendanceToggle = (s, present) => {
    if (present) {
      // Marking present: remove any draft leave + restore inputs
      updateStaffRow(s.id, "present", true);
      updateStaffRow(s.id, "leave_type", "");
      updateStaffRow(s.id, "leave_reason", "");
    } else {
      // Marking absent: open leave application popup
      setLeavePrompt({ staff: s, type: "Paid", reason: "" });
    }
  };

  const confirmLeave = async () => {
    if (!leavePrompt) return;
    const { staff: ls, type, reason } = leavePrompt;
    try {
      await addDoc(collection(db, "leaves"), {
        staff_id: ls.id,
        staff_name: ls.name,
        date: selDate,
        days: 1,
        type: type || "Paid",
        reason: reason || "",
        status: "approved",
        created_by: currentUser?.name || "user",
        created_at: new Date().toISOString(),
        source: "daily_entry",
      });
      // Mark row absent + clear billing fields so it doesn't contribute to totals
      setStaffRows(prev => ({
        ...prev,
        [ls.id]: { ...(prev[ls.id] || {}), present: false, leave_type: type, leave_reason: reason, billing: 0, material: 0, tips: 0, incentive: 0, mat_incentive: 0, staff_total_inc: 0, total: 0 },
      }));
      toast({ title: "Leave Recorded", message: `${ls.name} marked absent (${type}) on ${selDate}.`, type: "success" });
      setLeavePrompt(null);
    } catch (err) {
      confirm({ title: "Save Failed", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    }
  };

  const handleSave = async (e, opts = {}) => {
    e.preventDefault();
    if (!selBranch) { confirm({ title: "Notice", message: "Select a branch first.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} }); return; }
    setSaving(true);
    setSaveStatus("");

    // Resolve the entry id to write to. POS settles pass rollup:true and auto-target
    // any existing daily entry for this branch+date so each bill just accumulates
    // into the day rollup (no "duplicate" prompt — duplicates are what we want here).
    const existingForDay = entries.find(x => x.branch_id === selBranch && x.date === selDate);
    const effectiveEditId = editId || (opts.rollup ? existingForDay?.id : null) || null;

    // Duplicate guard still applies to accountant edits: if they changed branch/date
    // onto a slot that already has a different doc, block it so they go edit that one.
    if (!opts.rollup) {
      const hasChanged = selBranch !== origBranch || selDate !== origDate;
      if (!effectiveEditId || hasChanged) {
        const exists = entries.find(x => x.branch_id === selBranch && x.date === selDate && x.id !== effectiveEditId);
        if (exists) {
          confirm({ title: "Duplicate Detected", message: `An entry for ${branchesById.get(selBranch)?.name} on ${selDate} already exists. Please edit the existing entry instead of creating a new one.`, confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} });
          setSaving(false);
          return;
        }
      }
    }

    try {
      const payload = {
        branch_id: selBranch,
        date: selDate,
        online: totalOnline,
        cash: totalCash,
        mat_expense: Number(matExp) || 0,
        others: Number(otherExp) || 0,
        petrol: Number(petrol) || 0,
        cash_in_hand: cashInHand,
        staff_billing: branchStaff.map(s => ({
          staff_id: s.id,
          billing: staffRows[s.id]?.billing || 0,
          material: staffRows[s.id]?.material || 0,
          incentive: staffRows[s.id]?.incentive || 0,
          mat_incentive: staffRows[s.id]?.mat_incentive || 0,
          tips: staffRows[s.id]?.tips || 0,
          tip_in: staffRows[s.id]?.tip_in || "online",
          tip_paid: staffRows[s.id]?.tip_paid || "cash",
          present: staffRows[s.id]?.present !== false,
          staff_total_inc: staffRows[s.id]?.staff_total_inc || 0
        })),
        actual_cash: actualCashNum,
        cash_diff: cashDiff,
        tips_in_cash: tipsInCash,
        tips_paid_cash: tipsPaidCash,
        global_gst_pct: Number(gstPct) || 0,
        total_gst: totalRowGst,
        customer_id: selectedCustomer?.id || null,
        customer_name: selectedCustomer?.name || null,
        customer_phone: selectedCustomer?.phone || null,
        created_at: new Date().toISOString(),
        created_by: currentUser?.id || "unknown",
      };
      
      let savedEntryId = effectiveEditId;
      if (effectiveEditId) {
        // DETAILED LOGGING LOGIC
        const old = entries.find(x => x.id === effectiveEditId);
        const changes = [];
        if (old) {
          if (old.online !== payload.online) changes.push(`Online updated: ${INR(old.online)} -> ${INR(payload.online)}`);
          if (old.cash !== payload.cash) changes.push(`Cash updated: ${INR(old.cash)} -> ${INR(payload.cash)}`);
          if (old.mat_expense !== payload.mat_expense) changes.push(`Material Expense changed: ${INR(old.mat_expense)} -> ${INR(payload.mat_expense)}`);
          if (old.others !== payload.others) changes.push(`Other Exp changed: ${INR(old.others)} -> ${INR(payload.others)}`);
          if (old.petrol !== payload.petrol) changes.push(`Petrol updated: ${INR(old.petrol)} -> ${INR(payload.petrol)}`);

          payload.staff_billing.forEach(ns => {
            const os = (old.staff_billing || []).find(x => x.staff_id === ns.staff_id);
            const sName = staff.find(x => x.id === ns.staff_id)?.name || "Staff";
            if (!os) {
              changes.push(`Added Staff ${sName} to entry`);
            } else {
              if (os.billing !== ns.billing) changes.push(`${sName}: Billing updated ${INR(os.billing)} -> ${INR(ns.billing)}`);
              if (os.tips !== ns.tips) changes.push(`${sName}: Tips updated ${INR(os.tips)} -> ${INR(ns.tips)}`);
              if (os.material !== ns.material) changes.push(`${sName}: Material sale updated ${INR(os.material)} -> ${INR(ns.material)}`);
            }
          });
        }

        const historyItem = {
          time: new Date().toISOString(),
          user: currentUser?.name || "User",
          action: "Update",
          notes: changes.length > 0 ? changes.join(", ") : "Bill added via POS"
        };

        await updateDoc(doc(db, "entries", effectiveEditId), {
          ...payload,
          updated_at: new Date().toISOString(),
          updated_by: currentUser?.id || "unknown",
          activity_log: [...(old?.activity_log || []), historyItem]
        });
        setSaveStatus("✅ Bill Added!");
        toast({ title: "Bill Saved", message: "Added to today's entry. Ready for the next bill.", type: "success" });
      } else {
        const historyItem = {
          time: new Date().toISOString(),
          user: currentUser?.name || "User",
          action: "Create",
          notes: "Initial record created"
        };
        const created = await addDoc(collection(db, "entries"), { ...payload, activity_log: [historyItem] });
        savedEntryId = created.id;
        setSaveStatus("✅ Saved to Firebase!");
        toast({ title: "Bill Saved", message: "Ready for the next bill on this branch.", type: "success" });
      }

      // Clear only the bill-level fields; keep branch/date/staff totals so multiple bills
      // can be entered for the same branch in sequence (subsequent saves update the day entry).
      // service_logs + invoice docs are written by the settle flow (see confirmPrintAndSave).
      setCart([]);
      setSelectedCustomer(null);
      setClientSearch("");
      if (savedEntryId) setEditId(savedEntryId);
      setOrigBranch(selBranch);
      setOrigDate(selDate);
    } catch (err) {
      setSaveStatus("❌ Error: " + err.message);
    }
    setSaving(false);
  };

  const filteredEntries = useMemo(
    () => entries.filter(e => e.date && (filterMode === "month" ? e.date.startsWith(filterPrefix) : e.date.startsWith(String(filterYear)))),
    [entries, filterMode, filterPrefix, filterYear]
  );

  // Compute visible recent entries based on view mode (memoized — avoids recompute on every keystroke)
  const activeRecentDate = recentDate || selDate;
  const visibleEntries = useMemo(() => {
    let list = filteredEntries;
    if (recentView === "branch" && selBranch) list = filteredEntries.filter(e => e.branch_id === selBranch);
    else if (recentView === "date") list = filteredEntries.filter(e => e.date === activeRecentDate);
    else if (recentView === "range" && rangeFrom && rangeTo) list = entries.filter(e => e.date >= rangeFrom && e.date <= rangeTo);
    return list;
  }, [filteredEntries, recentView, selBranch, activeRecentDate, rangeFrom, rangeTo, entries]);

  const exportToExcel = async () => {
    if (visibleEntries.length === 0) return;
    const ExcelJS = await loadExcelJS();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Entries");
    const headers = ["Date","Branch","Online","Cash","GST","Mat Sale","Total Billing","Incentive","Tips","Staff T.Inc","Other Out","Petrol","Cash in Hand"];
    const hdrRow = ws.addRow(headers);
    hdrRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF065F46" } };
      cell.alignment = { horizontal: "center" };
    });
    ws.columns = headers.map(() => ({ width: 14 }));

    visibleEntries.forEach(e => {
      const b = branchesById.get(e.branch_id);
      const agg = sumStaffBilling(e.staff_billing);
      const cih = e.cash_in_hand !== undefined ? e.cash_in_hand : (e.cash||0) - agg.incentive - agg.tips - (e.others||0);
      const row = ws.addRow([e.date, b?.name||"?", e.online||0, e.cash||0, e.total_gst||0, agg.material, agg.billing, agg.incentive, agg.tips, agg.staffTotalInc, e.others||0, e.petrol||0, cih]);
      row.eachCell((cell, colNum) => { if (colNum >= 3) cell.numFmt = "#,##0"; });
    });

    // Totals row
    const lastRow = visibleEntries.length + 1;
    const totRow = ws.addRow(["TOTAL", "", ...Array(11).fill(0)]);
    for (let c = 3; c <= 13; c++) {
      totRow.getCell(c).value = { formula: `SUM(${String.fromCharCode(64+c)}2:${String.fromCharCode(64+c)}${lastRow})` };
      totRow.getCell(c).numFmt = "#,##0";
    }
    totRow.eachCell(cell => { cell.font = { bold: true, size: 12 }; cell.border = { top: { style: "double" } }; });

    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
    const safeUser = (currentUser?.name || "user").replace(/[^a-zA-Z0-9]/g, "_");
    const fileName = `${safeUser}_entries_${recentView}_${ts}.xlsx`;

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    await saveFileWithPicker(blob, fileName, "Exported", `${visibleEntries.length} records saved.`);
  };

  const downloadTemplate = async () => {
    try {
    const ExcelJS = await loadExcelJS();
    const wb = new ExcelJS.Workbook();
    const branchNames = branches.map(b => b.name);
    const activeStaff = staff.filter(s => !s.exit_date || new Date(s.exit_date) >= new Date());
    const staffNames = activeStaff.map(s => s.name);
    const gstRate = Number(globalGst) || 5;

    const hdrStyle = { font: { bold: true, color: { argb: "FFFFFFFF" }, size: 10 }, fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF065F46" } }, alignment: { horizontal: "center", vertical: "middle" } };
    const sectionStyle = { font: { bold: true, color: { argb: "FF22D3EE" }, size: 11 }, fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A1A1A" } } };
    const calcStyle = { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0FDF4" } }, font: { bold: true, color: { argb: "FF16A34A" } } };
    const calcRedStyle = { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF1F2" } }, font: { color: { argb: "FFDC2626" } } };
    const calcOrangeStyle = { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFBEB" } }, font: { color: { argb: "FFEA580C" } } };
    const numFmt = "#,##0";

    // ── Create one sheet per branch ──
    for (const br of branches) {
      const brStaff = activeStaff.filter(s => s.branch_id === br.id);
      const ws = wb.addWorksheet(br.name.replace("V-CUT ",""));
      ws.columns = [
        { width: 18 }, { width: 16 }, { width: 14 }, { width: 14 }, { width: 14 },
        { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 },
      ];

      // Row 1: Branch Header
      ws.mergeCells("A1:J1");
      const brHdr = ws.getCell("A1");
      brHdr.value = `DAILY SALES ENTRY — ${br.name}`;
      brHdr.font = { bold: true, size: 14, color: { argb: "FF22D3EE" } };
      brHdr.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0E0E0E" } };
      brHdr.alignment = { horizontal: "center" };

      // Row 2: blank
      // Row 3: Entry Info headers
      const infoLabels = ["Date", "Branch", "Online (Auto)", "Cash Income (₹)", "Mat Expense (₹)", "GST %", "Total GST (Auto)", "Other Expenses (₹)", "Petrol / Travel (₹)", "Cash in Hand (Auto)"];
      const r3 = ws.addRow([]); // row 2 blank
      const r4 = ws.addRow(infoLabels);
      r4.eachCell((cell) => { cell.font = hdrStyle.font; cell.fill = hdrStyle.fill; cell.alignment = hdrStyle.alignment; });

      // Row 4: Entry data row
      const dataRow = 4;
      ws.addRow([]);
      // Helper to unlock a cell for input
      const unlock = (cell) => { try { cell.protection = { locked: false }; } catch(_) {} };

      // Date — blank, user fills in
      ws.getCell(`A${dataRow}`).numFmt = "YYYY-MM-DD";
      unlock(ws.getCell(`A${dataRow}`));
      // Branch (locked, pre-filled)
      ws.getCell(`B${dataRow}`).value = br.name;
      ws.getCell(`B${dataRow}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8E8E8" } };
      // Online Income = Total Billing - Cash (auto-calc, filled after totals row is known)
      ws.getCell(`C${dataRow}`).numFmt = numFmt;
      ws.getCell(`C${dataRow}`).fill = calcStyle.fill; ws.getCell(`C${dataRow}`).font = calcStyle.font;
      // Cash Income — editable
      const cashCell = ws.getCell(`D${dataRow}`);
      cashCell.value = null; cashCell.numFmt = numFmt; unlock(cashCell);
      cashCell.dataValidation = { type: "whole", operator: "greaterThanOrEqual", formulae: [0], showErrorMessage: true, errorTitle: "Invalid", error: "Enter a positive number." };
      // Material Expense — editable
      const matCell = ws.getCell(`E${dataRow}`);
      matCell.value = null; matCell.numFmt = numFmt; unlock(matCell);
      matCell.dataValidation = { type: "whole", operator: "greaterThanOrEqual", formulae: [0], showErrorMessage: true, errorTitle: "Invalid", error: "Enter a positive number." };
      // GST % (locked)
      ws.getCell(`F${dataRow}`).value = gstRate;
      ws.getCell(`F${dataRow}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8E8E8" } };
      // Total GST = Online * GST% / 100 (auto-calc)
      ws.getCell(`G${dataRow}`).value = { formula: `ROUND(C${dataRow}*F${dataRow}/100,0)` };
      ws.getCell(`G${dataRow}`).numFmt = numFmt;
      ws.getCell(`G${dataRow}`).fill = calcRedStyle.fill; ws.getCell(`G${dataRow}`).font = calcRedStyle.font;
      // Other Expenses — editable
      const othCell = ws.getCell(`H${dataRow}`);
      othCell.value = null; othCell.numFmt = numFmt; unlock(othCell);
      othCell.dataValidation = { type: "whole", operator: "greaterThanOrEqual", formulae: [0], showErrorMessage: true, errorTitle: "Invalid", error: "Enter a positive number." };
      // Petrol — editable
      const petCell = ws.getCell(`I${dataRow}`);
      petCell.value = null; petCell.numFmt = numFmt; unlock(petCell);
      petCell.dataValidation = { type: "whole", operator: "greaterThanOrEqual", formulae: [0], showErrorMessage: true, errorTitle: "Invalid", error: "Enter a positive number." };
      // Cash in Hand (auto-calc, formula set after totals)
      ws.getCell(`J${dataRow}`).numFmt = numFmt;
      ws.getCell(`J${dataRow}`).font = { bold: true, size: 12, color: { argb: "FF16A34A" } };


      // Row 5: blank
      ws.addRow([]); // row 5

      // Row 6: Staff Billing section header
      const staffHdrRow = 6;
      ws.mergeCells(`A${staffHdrRow}:J${staffHdrRow}`);
      const shdr = ws.getCell(`A${staffHdrRow}`);
      shdr.value = "STAFF BILLING & INCENTIVES";
      shdr.font = sectionStyle.font; shdr.fill = sectionStyle.fill;

      // Row 7: Staff column headers
      const staffCols = ["Staff", "Billing (₹)", "Mat Sale", "Mat Inc (5%Auto)", "Incentive", "Tips (₹)", "Staff Total Inc", "Staff Total"];
      const r7 = ws.getRow(7);
      staffCols.forEach((h, i) => {
        const cell = r7.getCell(i + 1);
        cell.value = h;
        cell.font = hdrStyle.font; cell.fill = hdrStyle.fill; cell.alignment = hdrStyle.alignment;
      });

      // Staff rows (pre-populated with active employees)
      const staffStartRow = 8;
      const incPct = globalSettings ? (br.type === 'unisex' ? (globalSettings.unisex_inc ?? 10) : (globalSettings.mens_inc ?? 10)) : 10;

      // Cache styles once
      const lockedFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8E8E8" } };
      const numValidation = { type: "whole", operator: "greaterThanOrEqual", formulae: [0], showErrorMessage: true, errorTitle: "Invalid", error: "Enter a positive number." };

      brStaff.forEach((s, idx) => {
        const r = staffStartRow + idx;
        const cA = ws.getCell(`A${r}`), cB = ws.getCell(`B${r}`), cC = ws.getCell(`C${r}`);
        const cD = ws.getCell(`D${r}`), cE = ws.getCell(`E${r}`), cF = ws.getCell(`F${r}`);
        const cG = ws.getCell(`G${r}`), cH = ws.getCell(`H${r}`);
        cA.value = s.name; cA.font = { bold: true }; cA.fill = lockedFill;
        cB.numFmt = numFmt; unlock(cB); cB.dataValidation = numValidation;
        cC.value = null; cC.numFmt = numFmt; unlock(cC); cC.dataValidation = numValidation;
        cD.value = { formula: `ROUND(C${r}*5/100,0)` }; cD.numFmt = numFmt; cD.fill = calcOrangeStyle.fill; cD.font = calcOrangeStyle.font;
        cE.value = { formula: `ROUND(B${r}*${incPct}/100,0)` }; cE.numFmt = numFmt; cE.fill = calcRedStyle.fill; cE.font = calcRedStyle.font;
        cF.value = null; cF.numFmt = numFmt; unlock(cF);
        cG.value = { formula: `E${r}+D${r}+F${r}` }; cG.numFmt = numFmt; cG.fill = calcStyle.fill; cG.font = calcStyle.font;
        cH.value = { formula: `B${r}+C${r}+F${r}` }; cH.numFmt = numFmt; cH.fill = calcStyle.fill; cH.font = calcStyle.font;
      });

      // Extra rows for additional staff (with dropdown) — reduced from 5 to 3 for speed
      const extraStart = staffStartRow + brStaff.length;
      const staffListFormula = `"${staffNames.join(",")}"`;
      const staffDropdownValidation = { type: "list", formulae: [staffListFormula], showErrorMessage: true, errorTitle: "Invalid", error: "Select a staff member." };
      for (let x = 0; x < 3; x++) {
        const r = extraStart + x;
        const cA = ws.getCell(`A${r}`), cB = ws.getCell(`B${r}`), cC = ws.getCell(`C${r}`);
        const cD = ws.getCell(`D${r}`), cE = ws.getCell(`E${r}`), cF = ws.getCell(`F${r}`);
        const cG = ws.getCell(`G${r}`), cH = ws.getCell(`H${r}`);
        cA.dataValidation = staffDropdownValidation; unlock(cA);
        cB.numFmt = numFmt; unlock(cB);
        cC.numFmt = numFmt; unlock(cC);
        cD.value = { formula: `ROUND(C${r}*5/100,0)` }; cD.numFmt = numFmt; cD.fill = calcOrangeStyle.fill; cD.font = calcOrangeStyle.font;
        cE.value = { formula: `ROUND(B${r}*${incPct}/100,0)` }; cE.numFmt = numFmt; cE.fill = calcRedStyle.fill; cE.font = calcRedStyle.font;
        cF.numFmt = numFmt; unlock(cF);
        cG.value = { formula: `E${r}+D${r}+F${r}` }; cG.numFmt = numFmt; cG.fill = calcStyle.fill; cG.font = calcStyle.font;
        cH.value = { formula: `B${r}+C${r}+F${r}` }; cH.numFmt = numFmt; cH.fill = calcStyle.fill; cH.font = calcStyle.font;
      }

      // Totals row
      const totRow = extraStart + 3;
      ws.getCell(`A${totRow}`).value = "TOTALS";
      ws.getCell(`A${totRow}`).font = { bold: true, color: { argb: "FF22D3EE" } };
      const totFont = { bold: true, color: { argb: "FF22D3EE" } };
      const totBorder = { top: { style: "double", color: { argb: "FF22D3EE" } } };
      ["B","C","D","E","F","G","H"].forEach(col => {
        const c = ws.getCell(`${col}${totRow}`);
        c.value = { formula: `SUM(${col}${staffStartRow}:${col}${totRow - 1})` };
        c.numFmt = numFmt; c.font = totFont; c.border = totBorder;
      });

      // Online Income = Total Staff Billing - Cash (auto: what's left after cash is online)
      ws.getCell(`C${dataRow}`).value = { formula: `MAX(0,B${totRow}-D${dataRow})` };
      // Material Expense is editable — no formula override
      // Cash in Hand = Cash - Total Incentive - Total Mat Inc - Total Tips - Other - Petrol
      ws.getCell(`J${dataRow}`).value = { formula: `D${dataRow}-E${totRow}-D${totRow}-F${totRow}-H${dataRow}-I${dataRow}` };

      // Protect sheet — lock formula cells, allow input cells
      try { await ws.protect("vcut2026", { selectLockedCells: true, selectUnlockedCells: true }); } catch(_) {}
    }

    // Instructions sheet
    const instrWs = wb.addWorksheet("Instructions");
    instrWs.getColumn(1).width = 60;
    instrWs.getCell("A1").value = "V-CUT SALON — DAILY ENTRY UPLOAD TEMPLATE";
    instrWs.getCell("A1").font = { bold: true, size: 14, color: { argb: "FF065F46" } };
    const instructions = [
      "",
      "1. Each branch has its own sheet tab at the bottom.",
      "2. Fill Date, Online Income, Cash Income, Material Expense per day.",
      "3. Fill each staff member's Billing, Mat Sale, and Tips.",
      "4. Green/Red/Orange columns are AUTO-CALCULATED — do NOT edit them.",
      "5. Branch name, GST %, and staff names are pre-filled and locked.",
      "6. Use the dropdown in extra staff rows to add more employees.",
      "7. Save the file and upload it back using the Upload button.",
      "",
      "BRANCHES:", ...branches.map(b => `  • ${b.name}`),
      "",
      "ACTIVE STAFF:", ...activeStaff.map(s => `  • ${s.name} (${branchesById.get(s.branch_id)?.name || '?'})`),
    ];
    instructions.forEach((text, i) => { instrWs.getCell(`A${i + 2}`).value = text; });

    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
    const safeUser = (currentUser?.name || "user").replace(/[^a-zA-Z0-9]/g, "_");
    const fileName = `${safeUser}_entry_template_${ts}.xlsx`;

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    await saveFileWithPicker(blob, fileName, "Template Saved", `${fileName} saved. Fill and upload it back.`);
    } catch (err) {
      console.error("Template error:", err);
      confirm({ title: "Template Error", message: err.message || "Unknown error", confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    } finally {
      setGeneratingTemplate(false);
    }
  };

  const downloadFlatTemplate = async () => {
    try {
      const ExcelJS = await loadExcelJS();
      const wb = new ExcelJS.Workbook();
      const branchNames = branches.map(b => b.name);
      const activeStaff = staff.filter(s => !s.exit_date || new Date(s.exit_date) >= new Date());
      const staffNames = activeStaff.map(s => s.name);
      const gstRate = Number(globalGst) || 5;
      const numFmt = "#,##0";

      const ws = wb.addWorksheet("Daily Entries");
      // Headers: Date, Branch, Staff, Billing, Mat Sale, Tips, Online, Cash, Mat Expense, Other Exp, Petrol, Incentive(auto), Mat Inc(auto), Staff Total Inc(auto), Total Billing(auto), GST(auto)
      const headers = ["Date","Branch","Staff Name","Billing (₹)","Mat Sale","Tips (₹)","Online Income (₹)","Cash Income (₹)","Mat Expense (₹)","Other Expenses (₹)","Petrol (₹)","Incentive (Auto)","Mat Inc (Auto)","Staff Total Inc (Auto)","Total Billing (Auto)","GST (Auto)"];
      const hdrRow = ws.addRow(headers);
      hdrRow.eachCell(cell => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF065F46" } };
        cell.alignment = { horizontal: "center", vertical: "middle" };
      });
      ws.columns = [
        { width: 14 }, { width: 18 }, { width: 18 }, { width: 12 }, { width: 12 },
        { width: 10 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 },
        { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 12 },
      ];

      const unlock = (cell) => { try { cell.protection = { locked: false }; } catch(_) {} };
      const incPct = 10; // default

      // Pre-fill rows: one row per staff per branch (user fills date + amounts)
      let rowIdx = 2;
      for (const br of branches) {
        const brStaff = activeStaff.filter(s => s.branch_id === br.id);
        for (const s of brStaff) {
          const r = rowIdx;
          // Date — editable
          ws.getCell(`A${r}`).numFmt = "YYYY-MM-DD"; unlock(ws.getCell(`A${r}`));
          // Branch — pre-filled, locked
          ws.getCell(`B${r}`).value = br.name;
          ws.getCell(`B${r}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8E8E8" } };
          // Staff — pre-filled, locked
          ws.getCell(`C${r}`).value = s.name;
          ws.getCell(`C${r}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8E8E8" } };
          ws.getCell(`C${r}`).font = { bold: true };
          // Billing, Mat Sale, Tips — editable
          ["D","E","F"].forEach(col => { ws.getCell(`${col}${r}`).numFmt = numFmt; unlock(ws.getCell(`${col}${r}`)); });
          ws.getCell("D" + r).dataValidation = { type: "whole", operator: "greaterThanOrEqual", formulae: [0], showErrorMessage: true, errorTitle: "Invalid", error: "Enter a positive number." };
          // Online, Cash, Mat Expense, Other, Petrol — editable (same for all staff in a branch, user fills once)
          ["G","H","I","J","K"].forEach(col => { ws.getCell(`${col}${r}`).numFmt = numFmt; unlock(ws.getCell(`${col}${r}`)); });
          // Auto-calc: Incentive = Billing * 10%
          ws.getCell(`L${r}`).value = { formula: `ROUND(D${r}*${incPct}/100,0)` };
          ws.getCell(`L${r}`).numFmt = numFmt;
          ws.getCell(`L${r}`).font = { color: { argb: "FFDC2626" } };
          ws.getCell(`L${r}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF1F2" } };
          // Mat Inc = Mat Sale * 5%
          ws.getCell(`M${r}`).value = { formula: `ROUND(E${r}*5/100,0)` };
          ws.getCell(`M${r}`).numFmt = numFmt;
          ws.getCell(`M${r}`).font = { color: { argb: "FFEA580C" } };
          ws.getCell(`M${r}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFBEB" } };
          // Staff Total Inc = Incentive + Mat Inc + Tips
          ws.getCell(`N${r}`).value = { formula: `L${r}+M${r}+F${r}` };
          ws.getCell(`N${r}`).numFmt = numFmt;
          ws.getCell(`N${r}`).font = { bold: true, color: { argb: "FF16A34A" } };
          ws.getCell(`N${r}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0FDF4" } };
          // Total Billing = Online + Cash
          ws.getCell(`O${r}`).value = { formula: `G${r}+H${r}` };
          ws.getCell(`O${r}`).numFmt = numFmt;
          ws.getCell(`O${r}`).font = { bold: true, color: { argb: "FF16A34A" } };
          ws.getCell(`O${r}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0FDF4" } };
          // GST = Online * gst%
          ws.getCell(`P${r}`).value = { formula: `ROUND(G${r}*${gstRate}/100,0)` };
          ws.getCell(`P${r}`).numFmt = numFmt;
          ws.getCell(`P${r}`).font = { color: { argb: "FFDC2626" } };
          ws.getCell(`P${r}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF1F2" } };
          rowIdx++;
        }
        // Add 3 extra blank rows per branch for additional staff
        for (let x = 0; x < 3; x++) {
          const r = rowIdx;
          ws.getCell(`A${r}`).numFmt = "YYYY-MM-DD"; unlock(ws.getCell(`A${r}`));
          ws.getCell(`B${r}`).dataValidation = { type: "list", formulae: [`"${branchNames.join(",")}"`], showErrorMessage: true, errorTitle: "Invalid", error: "Select branch." };
          unlock(ws.getCell(`B${r}`));
          ws.getCell(`C${r}`).dataValidation = { type: "list", formulae: [`"${staffNames.join(",")}"`], showErrorMessage: true, errorTitle: "Invalid", error: "Select staff." };
          unlock(ws.getCell(`C${r}`));
          ["D","E","F","G","H","I","J","K"].forEach(col => { ws.getCell(`${col}${r}`).numFmt = numFmt; unlock(ws.getCell(`${col}${r}`)); });
          ws.getCell(`L${r}`).value = { formula: `ROUND(D${r}*${incPct}/100,0)` }; ws.getCell(`L${r}`).numFmt = numFmt;
          ws.getCell(`L${r}`).font = { color: { argb: "FFDC2626" } }; ws.getCell(`L${r}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF1F2" } };
          ws.getCell(`M${r}`).value = { formula: `ROUND(E${r}*5/100,0)` }; ws.getCell(`M${r}`).numFmt = numFmt;
          ws.getCell(`M${r}`).font = { color: { argb: "FFEA580C" } }; ws.getCell(`M${r}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFBEB" } };
          ws.getCell(`N${r}`).value = { formula: `L${r}+M${r}+F${r}` }; ws.getCell(`N${r}`).numFmt = numFmt;
          ws.getCell(`N${r}`).font = { bold: true, color: { argb: "FF16A34A" } }; ws.getCell(`N${r}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0FDF4" } };
          ws.getCell(`O${r}`).value = { formula: `G${r}+H${r}` }; ws.getCell(`O${r}`).numFmt = numFmt;
          ws.getCell(`O${r}`).font = { bold: true, color: { argb: "FF16A34A" } }; ws.getCell(`O${r}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0FDF4" } };
          ws.getCell(`P${r}`).value = { formula: `ROUND(G${r}*${gstRate}/100,0)` }; ws.getCell(`P${r}`).numFmt = numFmt;
          ws.getCell(`P${r}`).font = { color: { argb: "FFDC2626" } }; ws.getCell(`P${r}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF1F2" } };
          rowIdx++;
        }
      }

      // Freeze header row
      ws.views = [{ state: "frozen", ySplit: 1 }];
      try { await ws.protect("vcut2026", { selectLockedCells: true, selectUnlockedCells: true }); } catch(_) {}

      const now = new Date();
      const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
      const safeUser = (currentUser?.name || "user").replace(/[^a-zA-Z0-9]/g, "_");
      const fileName = `${safeUser}_flat_template_${ts}.xlsx`;
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      await saveFileWithPicker(blob, fileName, "Template Saved", `${fileName} saved.`);
    } catch (err) {
      console.error("Flat template error:", err);
      confirm({ title: "Template Error", message: err.message || "Unknown error", confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    } finally {
      setGeneratingTemplate(false);
    }
  };

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const isExcel = file.name.endsWith('.xlsx') || file.name.endsWith('.xls');
      let dataRows = [];

      if (isExcel) {
        const ExcelJS = await loadExcelJS();
        const buf = await file.arrayBuffer();
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf);
        // Read ALL worksheets (multi-branch template)
        wb.eachSheet((ws, sheetId) => {
          if (ws.name.toLowerCase() === 'instructions') return; // skip instructions
          // Check if this is a branch template (has "DAILY SALES ENTRY" in A1)
          const a1 = String(ws.getCell("A1").value || "").toLowerCase();
          const isBranchTemplate = a1.includes("daily sales entry");
          if (isBranchTemplate) {
            // Branch template format: row 3 = headers, row 4 = data, row 7 = staff headers, row 8+ = staff
            const branchName = String(ws.getCell("B4").value || ws.name || "").trim();
            const date = ws.getCell("A4").value;
            const online = Number(ws.getCell("C4").value) || 0;
            const cash = Number(ws.getCell("D4").value) || 0;
            const matExp = Number(ws.getCell("E4").value) || 0;
            const others = Number(ws.getCell("H4").value) || 0;
            const petrol = Number(ws.getCell("I4").value) || 0;
            // Skip blank sheets (closed shop — no date entered)
            if (!date) return;
            // Read staff rows (row 8+, until TOTALS or empty)
            const staffBilling = [];
            for (let r = 8; r <= 30; r++) {
              const name = String(ws.getCell(`A${r}`).value || "").trim();
              if (!name || name === "TOTALS") break;
              const billing = Number(ws.getCell(`B${r}`).value) || 0;
              const material = Number(ws.getCell(`C${r}`).value) || 0;
              const tips = Number(ws.getCell(`F${r}`).value) || 0;
              // Skip staff on holiday (all zeros / blank)
              if (billing === 0 && material === 0 && tips === 0) continue;
              const s = staff.find(x => x.name.toLowerCase() === name.toLowerCase());
              if (s) staffBilling.push({ staff_id: s.id, staff_name: name, billing, material, tips, incentive: Math.round(billing * 0.1), mat_incentive: Math.round(material * 0.05), staff_total_inc: Math.round(billing * 0.1) + Math.round(material * 0.05) + tips });
            }
            dataRows.push({ rowNum: sheetId, date, branch: branchName, online, cash, matExp, others, petrol, staffBilling, _isTemplate: true });
          } else {
            // Flat format (single sheet) — one row per staff, group by date+branch
            const hdrs = [];
            ws.getRow(1).eachCell((cell, colNum) => { hdrs[colNum] = String(cell.value || "").trim().toLowerCase(); });
            const hasStaffCol = hdrs.some(h => h && h.includes("staff"));
            if (hasStaffCol) {
              // Group rows by date + branch
              const groups = {};
              ws.eachRow((row, rowNum) => {
                if (rowNum === 1) return;
                const r = {};
                row.eachCell((cell, colNum) => { r[hdrs[colNum]] = cell.value; });
                if (!Object.values(r).some(v => v != null && v !== "" && v !== 0)) return;
                const gv = (keys) => { for (const k of keys) { const m = Object.keys(r).find(h => h && h.includes(k)); if (m && r[m] != null) return r[m]; } return null; };
                let rawDate = gv(["date"]);
                let date = "";
                if (rawDate instanceof Date) date = rawDate.toISOString().split("T")[0];
                else if (typeof rawDate === "string") date = rawDate.trim();
                else if (typeof rawDate === "number") { const d = new Date(Math.round((rawDate - 25569) * 86400000)); date = d.toISOString().split("T")[0]; }
                const branchName = String(gv(["branch"]) || "").trim();
                if (!date || !branchName) return;
                const key = `${date}__${branchName}`;
                if (!groups[key]) {
                  groups[key] = { date, branch: branchName, online: Number(gv(["online"])) || 0, cash: Number(gv(["cash"])) || 0, matExp: Number(gv(["mat exp", "mat expense"])) || 0, others: Number(gv(["other"])) || 0, petrol: Number(gv(["petrol"])) || 0, staffBilling: [], _isTemplate: true, rowNum: rowNum };
                }
                const staffName = String(gv(["staff"]) || "").trim();
                const billing = Number(gv(["billing"])) || 0;
                const material = Number(gv(["mat sale"])) || 0;
                const tips = Number(gv(["tips"])) || 0;
                if (staffName && (billing > 0 || material > 0 || tips > 0)) {
                  const s = staff.find(x => x.name.toLowerCase() === staffName.toLowerCase());
                  if (s) groups[key].staffBilling.push({ staff_id: s.id, staff_name: staffName, billing, material, tips, incentive: Math.round(billing * 0.1), mat_incentive: Math.round(material * 0.05), staff_total_inc: Math.round(billing * 0.1) + Math.round(material * 0.05) + tips });
                }
              });
              Object.values(groups).forEach(g => dataRows.push(g));
            } else {
              // Simple flat format without staff column
              ws.eachRow((row, rowNum) => {
                if (rowNum === 1) return;
                const r = {};
                row.eachCell((cell, colNum) => { r[hdrs[colNum]] = cell.value; });
                if (Object.values(r).some(v => v != null && v !== "" && v !== 0)) dataRows.push({ rowNum, ...r });
              });
            }
          }
        });
      } else {
        const text = await file.text();
        const lines = text.split("\n").filter(l => l.trim());
        if (lines.length < 2) { confirm({ title: "Invalid File", message: "File must have a header and at least one data row.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} }); return; }
        const hdrs = lines[0].split(",").map(h => h.trim().toLowerCase());
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(",").map(c => c.trim());
          const r = { rowNum: i + 1 };
          hdrs.forEach((h, j) => { r[h] = cols[j]; });
          dataRows.push(r);
        }
      }

      // Map column names flexibly
      const getVal = (r, ...keys) => {
        for (const k of keys) {
          const match = Object.keys(r).find(h => h && h.includes(k));
          if (match && r[match] != null) return r[match];
        }
        return null;
      };

      const parsed = dataRows.map(r => {
        // Branch template format (multi-sheet)
        if (r._isTemplate) {
          let rawDate = r.date;
          let date = "";
          if (rawDate instanceof Date) date = rawDate.toISOString().split("T")[0];
          else if (typeof rawDate === "string") date = rawDate.trim();
          else if (typeof rawDate === "number") { const d = new Date(Math.round((rawDate - 25569) * 86400000)); date = d.toISOString().split("T")[0]; }
          const branchName = String(r.branch || "").trim();
          const branch = branches.find(b => b.name.toLowerCase().includes(branchName.toLowerCase()));
          const errors = [];
          if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push("Invalid date (need YYYY-MM-DD)");
          if (!branch) errors.push(`Branch "${branchName}" not found`);
          const duplicate = entries.find(ex => ex.date === date && ex.branch_id === branch?.id);
          if (duplicate) errors.push("Duplicate: entry exists for this date & branch");
          return { row: r.rowNum, date, branchName, branch, online: r.online, cash: r.cash, gst: 0, matSale: 0, billing: r.online + r.cash, incentive: 0, tips: 0, others: r.others, petrol: r.petrol, matExp: r.matExp, staffBilling: r.staffBilling, errors, valid: errors.length === 0 };
        }
        // Flat CSV/single-sheet format
        let rawDate = getVal(r, "date");
        let date = "";
        if (rawDate instanceof Date) date = rawDate.toISOString().split("T")[0];
        else if (typeof rawDate === "string") date = rawDate.trim();
        else if (typeof rawDate === "number") { const d = new Date(Math.round((rawDate - 25569) * 86400000)); date = d.toISOString().split("T")[0]; }

        const branchName = String(getVal(r, "branch") || "").trim();
        const branch = branches.find(b => b.name.toLowerCase().includes(branchName.toLowerCase()));
        const online = Number(getVal(r, "online")) || 0;
        const cash = Number(getVal(r, "cash")) || 0;
        const gst = Number(getVal(r, "gst")) || 0;
        const matSale = Number(getVal(r, "mat")) || 0;
        const billing = Number(getVal(r, "billing", "total")) || 0;
        const incentive = Number(getVal(r, "incentive")) || 0;
        const tips = Number(getVal(r, "tips")) || 0;
        const others = Number(getVal(r, "other")) || 0;
        const petrol = Number(getVal(r, "petrol")) || 0;

        const errors = [];
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push("Invalid date (need YYYY-MM-DD)");
        if (!branch) errors.push(`Branch "${branchName}" not found`);
        if (online < 0 || cash < 0) errors.push("Income cannot be negative");
        const duplicate = entries.find(ex => ex.date === date && ex.branch_id === branch?.id);
        if (duplicate) errors.push("Duplicate: entry exists for this date & branch");
        if (billing > 0 && online + cash > 0 && Math.abs((online + cash) - billing) > billing * 0.5) errors.push("Online+Cash differs from Billing by >50%");

        return { row: r.rowNum, date, branchName, branch, online, cash, gst, matSale, billing, incentive, tips, others, petrol, errors, valid: errors.length === 0 };
      });

      setUploadPreview({ rows: parsed, validCount: parsed.filter(r => r.valid).length, errorCount: parsed.filter(r => !r.valid).length });
    } catch (err) { confirm({ title: "Parse Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} }); }
    e.target.value = "";
  };

  const confirmUpload = async () => {
    if (!uploadPreview) return;
    const validRows = uploadPreview.rows.filter(r => r.valid);
    if (validRows.length === 0) { confirm({ title: "No Valid Rows", message: "All rows have errors. Fix the file and try again.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} }); return; }
    try {
      const gstR = Number(globalGst) || 5;
      for (const r of validRows) {
        const totalGst = Math.round(r.online * gstR / 100);
        const agg = sumStaffBilling(r.staffBilling);
        const totalInc = agg.incentive;
        const totalTips = agg.tips;
        const cih = r.cash - totalInc - totalTips - (r.others || 0) - (r.petrol || 0);
        await addDoc(collection(db, "entries"), {
          date: r.date, branch_id: r.branch.id,
          online: r.online, cash: r.cash, total_gst: totalGst,
          mat_expense: r.matExp || r.matSale || 0,
          others: r.others || 0, petrol: r.petrol || 0,
          global_gst_pct: gstR,
          cash_in_hand: cih,
          staff_billing: r.staffBilling || [],
          uploaded: true, uploaded_at: new Date().toISOString(),
        });
      }
      toast({ title: "Uploaded", message: `${validRows.length} entries imported successfully.`, type: "success" });
      setUploadPreview(null);
    } catch (err) { confirm({ title: "Upload Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} }); }
  };

  // Customer lookup: match name or phone (case-insensitive)
  const customerMatches = clientSearch.trim().length === 0 ? [] : (() => {
    const q = clientSearch.trim().toLowerCase();
    return customers.filter(c =>
      (c.name || "").toLowerCase().includes(q) ||
      (c.phone || "").toLowerCase().includes(q)
    ).slice(0, 6);
  })();

  const pickCustomer = (c) => {
    setSelectedCustomer(c);
    setClientSearch(c.name || c.phone || "");
    setShowCustomerDropdown(false);
  };

  const openNewCustomerForm = () => {
    const q = clientSearch.trim();
    const looksLikePhone = /^[\d+\-()\s]+$/.test(q) && q.replace(/\D/g, "").length >= 6;
    setCustomerForm({
      name: looksLikePhone ? "" : q,
      phone: looksLikePhone ? q : "",
      email: "",
      address: "",
      birthdate: "",
      marriage_date: "",
      notes: "",
    });
    setShowCustomerDropdown(false);
  };

  const saveNewCustomer = async (e) => {
    e.preventDefault();
    if (!customerForm) return;
    const name = customerForm.name.trim();
    if (!name) {
      confirm({ title: "Name Required", message: "Please enter the customer's name.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} });
      return;
    }
    try {
      const docRef = await addDoc(collection(db, "customers"), {
        name,
        phone: customerForm.phone.trim() || null,
        email: customerForm.email.trim() || null,
        address: customerForm.address.trim() || null,
        birthdate: customerForm.birthdate || null,
        marriage_date: customerForm.marriage_date || null,
        notes: customerForm.notes.trim() || null,
        created_at: new Date().toISOString(),
        created_by: currentUser?.name || "user",
      });
      const saved = { id: docRef.id, name, phone: customerForm.phone.trim() || null };
      setSelectedCustomer(saved);
      setClientSearch(name);
      setCustomerForm(null);
      toast({ title: "Customer Added", message: `${name} saved.`, type: "success" });
    } catch (err) {
      confirm({ title: "Save Failed", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    }
  };

  // Today's drafts + settled invoices for the selected branch+date
  const todaysDrafts = useMemo(
    () => invoices.filter(i => i.status === "draft").sort((a, b) => (a.created_at || "").localeCompare(b.created_at || "")),
    [invoices]
  );
  const todaysSettled = useMemo(
    () => invoices
      .filter(i => i.status === "settled")
      .sort((a, b) => (a.invoice_no || "").localeCompare(b.invoice_no || "")),
    [invoices]
  );
  const settledCount = todaysSettled.length;

  // Settled-only set — global search + branch cards operate on this.
  const settledInvoices = useMemo(
    () => historyInvoices.filter(i => i.status === "settled"),
    [historyInvoices]
  );

  // History search — match by invoice no, customer name/phone, amount, or date substring.
  const filteredInvoices = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return settledInvoices;
    const qNum = Number(q.replace(/[^\d.]/g, ""));
    return settledInvoices.filter(inv => {
      if ((inv.invoice_no || "").toLowerCase().includes(q)) return true;
      if ((inv.customer_name || "").toLowerCase().includes(q)) return true;
      if ((inv.customer_phone || "").toLowerCase().includes(q)) return true;
      if ((inv.date || "").includes(q)) return true;
      if (!Number.isNaN(qNum) && qNum > 0) {
        const tot = Number(inv.total) || Number(inv.subtotal) || 0;
        if (tot === qNum) return true;
      }
      return false;
    });
  }, [settledInvoices, historySearch]);

  // Branch summary cards — grouped counts + totals. Search narrows the underlying set.
  const branchSummaries = useMemo(() => {
    const map = new Map();
    filteredInvoices.forEach(inv => {
      const key = inv.branch_id;
      if (!map.has(key)) {
        map.set(key, {
          branch_id: key,
          branch_name: (branchesById.get(key)?.name || inv.branch_name || "Branch").replace("V-CUT ", ""),
          count: 0,
          total: 0,
          drafts: 0,
        });
      }
      const s = map.get(key);
      s.count += 1;
      s.total += Number(inv.total) || Number(inv.subtotal) || 0;
    });
    // Include draft counts for the same branches so the card can hint "+N drafts"
    historyInvoices.filter(i => i.status === "draft").forEach(inv => {
      if (map.has(inv.branch_id)) map.get(inv.branch_id).drafts += 1;
    });
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [filteredInvoices, historyInvoices, branchesById]);

  // Invoices for the expanded branch card — applies filter controls + sort.
  // Includes drafts when status filter is "all" or "draft".
  const filteredBranchInvoices = useMemo(() => {
    if (!expandedBranchId) return [];
    const custQ = branchCustomerFilter.trim().toLowerCase();
    const list = historyInvoices.filter(inv => {
      if (inv.branch_id !== expandedBranchId) return false;
      if (branchStatusFilter !== "all" && inv.status !== branchStatusFilter) return false;
      if (branchDateFilter && inv.date !== branchDateFilter) return false;
      if (custQ) {
        const hit = (inv.customer_name || "").toLowerCase().includes(custQ)
                 || (inv.customer_phone || "").toLowerCase().includes(custQ);
        if (!hit) return false;
      }
      return true;
    });
    const amt = (inv) => Number(inv.total) || Number(inv.subtotal) || 0;
    switch (branchSortBy) {
      case "date_asc":    list.sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.invoice_no || "").localeCompare(b.invoice_no || "")); break;
      case "amount_desc": list.sort((a, b) => amt(b) - amt(a)); break;
      case "amount_asc":  list.sort((a, b) => amt(a) - amt(b)); break;
      case "date_desc":
      default:            list.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.invoice_no || "").localeCompare(a.invoice_no || "")); break;
    }
    return list;
  }, [historyInvoices, expandedBranchId, branchStatusFilter, branchDateFilter, branchCustomerFilter, branchSortBy]);

  // Invoice number: {BRANCH-PREFIX}-{DDMMYY}-{NNN}
  const branchPrefix = (b) => {
    if (!b) return "INV";
    const raw = (b.code || b.name || "").replace(/V[-\s]*CUT/gi, "").replace(/[^A-Za-z]/g, "");
    return (raw.slice(0, 3) || "INV").toUpperCase();
  };
  const formatInvoiceNo = (branch, date, seq) => {
    const [y, m, d] = date.split("-");
    return `${branchPrefix(branch)}-${d}${m}${y.slice(2)}-${String(seq).padStart(3, "0")}`;
  };

  const buildInvoicePayload = (status, invoice_no = null) => {
    const branch = branchesById.get(selBranch);
    const staffMap = new Map(staff.map(s => [s.id, s]));
    const subtotal = cart.reduce((s, it) => s + (Number(it.price) || 0), 0);
    const online = Math.max(0, Number(onlineInc) || 0);
    const cash = Math.max(0, subtotal - online);
    const gst_amount = Math.round(online * (Number(gstPct) || 0) / 100);
    const split = new Map();
    cart.forEach(it => {
      if (!it.staffId) return;
      split.set(it.staffId, (split.get(it.staffId) || 0) + (Number(it.price) || 0));
    });
    return {
      branch_id: selBranch,
      branch_name: branch?.name || "",
      date: selDate,
      items: cart.map(it => ({
        cart_id: String(it.cartId),
        name: it.name,
        price: Number(it.price) || 0,
        staff_id: it.staffId || null,
        staff_name: staffMap.get(it.staffId)?.name || "",
        menu_id: it.menu_id || "",
        menu_type: it.menu_type || "",
        group: it.group || "",
        icon: it.icon || "",
      })),
      staff_split: [...split.entries()].map(([staff_id, billing]) => ({
        staff_id, billing, staff_name: staffMap.get(staff_id)?.name || "",
      })),
      customer_id: selectedCustomer?.id || null,
      customer_name: selectedCustomer?.name || null,
      customer_phone: selectedCustomer?.phone || null,
      subtotal,
      gst_pct: Number(gstPct) || 0,
      gst_amount,
      cash,
      online,
      total: subtotal,
      status,
      ...(invoice_no ? { invoice_no } : {}),
      cashier_name: currentUser?.name || "Staff",
      created_by: currentUser?.id || "unknown",
    };
  };

  // Apply a delta to staffRows.billing for a list of cart items (sign: +1 adds, -1 rolls back).
  // Mirrors updateStaffRow's incentive recompute so rolling back a draft leaves clean totals.
  const adjustStaffRowsFromCart = (items, sign) => {
    const deltas = new Map();
    items.forEach(it => {
      if (!it.staffId) return;
      deltas.set(it.staffId, (deltas.get(it.staffId) || 0) + (Number(it.price) || 0));
    });
    if (deltas.size === 0) return;
    const b = branchesById.get(selBranch);
    let incRateRaw = 10;
    if (globalSettings) {
      if (b?.type === "unisex") incRateRaw = globalSettings.unisex_inc ?? 10;
      else incRateRaw = globalSettings.mens_inc ?? 10;
    }
    const incPct = incRateRaw / 100;
    const matPct = 0.05;
    setStaffRows(prev => {
      const next = { ...prev };
      deltas.forEach((delta, sid) => {
        const row = next[sid] || {};
        const newBilling = Math.max(0, (Number(row.billing) || 0) + sign * delta);
        const material = Number(row.material) || 0;
        const tips = Number(row.tips) || 0;
        const incentive = Math.round(newBilling * incPct);
        const mat_incentive = Math.round(material * matPct);
        const staff_total_inc = incentive + mat_incentive + tips;
        const total = newBilling + material + tips - incentive - mat_incentive;
        next[sid] = { ...row, billing: newBilling, material, tips, incentive, mat_incentive, staff_total_inc, total };
      });
      return next;
    });
  };

  const saveDraft = async () => {
    if (!selBranch) { toast({ title: "Pick a Branch", message: "Select a branch before saving a draft.", type: "warning" }); return; }
    if (cart.length === 0) { toast({ title: "Empty Cart", message: "Add items before saving a draft.", type: "warning" }); return; }
    setSaving(true);
    try {
      const payload = buildInvoicePayload("draft");
      if (editingDraftId) {
        await updateDoc(doc(db, "invoices", editingDraftId), { ...payload, updated_at: new Date().toISOString() });
      } else {
        await addDoc(collection(db, "invoices"), { ...payload, created_at: new Date().toISOString() });
      }
      // Roll back the staffRows bumps that addToCart applied — draft billing is not counted yet.
      adjustStaffRowsFromCart(cart, -1);
      setCart([]);
      setSelectedCustomer(null);
      setClientSearch("");
      setOnlineInc("");
      setEditingDraftId(null);
      toast({ title: "Draft Saved", message: "Resume it from the drafts bar. Auto-expires at midnight.", type: "success" });
    } catch (err) {
      toast({ title: "Save Failed", message: err.message, type: "error" });
    }
    setSaving(false);
  };

  const resumeDraft = (d) => {
    if (cart.length > 0) {
      toast({ title: "Cart Not Empty", message: "Settle or clear the current cart before resuming a draft.", type: "warning" });
      return;
    }
    const items = (d.items || []).map((it, i) => ({
      id: it.menu_id || `draft-${i}`,
      cartId: Date.now() + Math.random() + i,
      name: it.name,
      price: Number(it.price) || 0,
      staffId: it.staff_id || "",
      menu_id: it.menu_id || "",
      menu_type: it.menu_type || "",
      group: it.group || "",
      icon: it.icon || "✨",
    }));
    setCart(items);
    if (d.customer_id) setSelectedCustomer({ id: d.customer_id, name: d.customer_name, phone: d.customer_phone });
    setOnlineInc(d.online ? String(d.online) : "");
    setEditingDraftId(d.id);
    // Re-apply the staff_billing bumps the cart would normally carry.
    adjustStaffRowsFromCart(items, +1);
    toast({ title: "Draft Loaded", message: `Resumed ${d.items?.length || 0} item(s). Finish and settle to lock invoice #.`, type: "success" });
  };

  const discardDraft = async (d) => {
    confirm({
      title: "Discard Draft?",
      message: "This draft will be permanently removed.",
      confirmText: "Discard", cancelText: "Keep", type: "danger",
      onConfirm: async () => {
        try { await deleteDoc(doc(db, "invoices", d.id)); }
        catch (err) { toast({ title: "Error", message: err.message, type: "error" }); }
      }
    });
  };

  // Build the bill preview data and open the preview modal (invoice_no assigned here).
  const openBillPreview = () => {
    if (cart.length === 0) return;
    if (!selBranch) { toast({ title: "Branch Required", message: "Pick a branch first.", type: "warning" }); return; }
    const branch = branches.find(b => b.id === selBranch);
    const staffMap = new Map(branchStaff.map(s => [s.id, s]));
    const items = cart.map(it => ({
      name: it.name,
      price: it.price,
      stylist: staffMap.get(it.staffId)?.name || "—",
    }));
    const subtotal = items.reduce((s, it) => s + it.price, 0);
    const gstAmt = Math.round(subtotal * (Number(gstPct) || 0) / 100);
    const onlineAmt = Math.max(0, Number(onlineInc) || 0);
    const cashAmt = Math.max(0, subtotal - onlineAmt);
    let paymentMode = "Cash";
    if (onlineAmt > 0 && cashAmt > 0) paymentMode = "Split (Cash + Online)";
    else if (onlineAmt > 0) paymentMode = "Online";
    const nextSeq = settledCount + 1;
    const billNo = formatInvoiceNo(branch, selDate, nextSeq);
    setBillPreview({
      billNo,
      branch: branch || { name: "V-Cut Salon" },
      date: selDate,
      time: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
      customer: selectedCustomer,
      items,
      subtotal,
      gstPct: Number(gstPct) || 0,
      gstAmt,
      total: subtotal, // GST already included in service prices (inclusive) — treat total as subtotal
      onlineAmt,
      cashAmt,
      paymentMode,
      cashier: currentUser?.name || "Staff",
    });
  };

  // Re-open a previously-settled invoice in the preview modal (read-only).
  // Useful when the user wants to look at or print an earlier bill of the day.
  const openInvoicePreview = (inv) => {
    const branch = branchesById.get(inv.branch_id) || { name: inv.branch_name };
    const staffMap = new Map(staff.map(s => [s.id, s]));
    const items = (inv.items || []).map(it => ({
      name: it.name,
      price: Number(it.price) || 0,
      stylist: staffMap.get(it.staff_id)?.name || it.staff_name || "—",
    }));
    const subtotal = Number(inv.subtotal) || items.reduce((s, it) => s + it.price, 0);
    const onlineAmt = Number(inv.online) || 0;
    const cashAmt = Number(inv.cash) || Math.max(0, subtotal - onlineAmt);
    let paymentMode = "Cash";
    if (onlineAmt > 0 && cashAmt > 0) paymentMode = "Split (Cash + Online)";
    else if (onlineAmt > 0) paymentMode = "Online";
    const settledDate = inv.settled_at || inv.created_at;
    setBillPreview({
      billNo: inv.invoice_no || "—",
      branch,
      date: inv.date,
      time: settledDate ? new Date(settledDate).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "",
      customer: inv.customer_id ? { id: inv.customer_id, name: inv.customer_name, phone: inv.customer_phone } : null,
      items,
      subtotal,
      gstPct: Number(inv.gst_pct) || 0,
      gstAmt: Number(inv.gst_amount) || 0,
      total: Number(inv.total) || subtotal,
      onlineAmt,
      cashAmt,
      paymentMode,
      cashier: inv.cashier_name || "Staff",
      viewOnly: true,
    });
  };

  const confirmPrintAndSave = async ({ print = true } = {}) => {
    try {
      if (!billPreview) return;
      const invoice_no = billPreview.billNo;

      // 1. Write/settle the invoice doc first so the invoice_no is locked in.
      const payload = buildInvoicePayload("settled", invoice_no);
      payload.settled_at = new Date().toISOString();
      let invoiceId;
      if (editingDraftId) {
        await updateDoc(doc(db, "invoices", editingDraftId), payload);
        invoiceId = editingDraftId;
      } else {
        payload.created_at = new Date().toISOString();
        const ref = await addDoc(collection(db, "invoices"), payload);
        invoiceId = ref.id;
      }

      // 2. Per-item service_logs tagged source="pos" with invoice linkage.
      const staffMap = new Map(staff.map(s => [s.id, s]));
      const logPayloads = cart.filter(it => it.staffId).map(it => ({
        staff_id: it.staffId,
        staff_name: staffMap.get(it.staffId)?.name || "",
        branch_id: selBranch,
        date: selDate,
        service_name: it.name || "",
        service_group: it.group || "",
        menu_id: it.menu_id || "",
        menu_type: it.menu_type || "",
        amount: Number(it.price) || 0,
        standard_price: Number(it.price) || 0,
        custom_price: false,
        price_note: "",
        tip: 0,
        tip_in: "online",
        material_sale: 0,
        material_name: "",
        source: "pos",
        invoice_id: invoiceId,
        invoice_no,
        pos_cart_id: String(it.cartId),
        customer_id: selectedCustomer?.id || null,
        customer_name: selectedCustomer?.name || null,
        created_by: currentUser?.id || "unknown",
        created_at: new Date().toISOString(),
      }));
      await Promise.all(logPayloads.map(p => addDoc(collection(db, "service_logs"), p)));

      // 3. Rollup into the daily entries doc so accountant can edit petrol/etc later.
      // rollup:true auto-targets any existing entry for this branch+date — each bill
      // just adds to the daily total instead of tripping the duplicate-detection guard.
      await handleSave({ preventDefault: () => {} }, { rollup: true });

      setEditingDraftId(null);

      // 4. Print only if the user chose "Settle & Print". Otherwise close the modal.
      if (print) {
        setTimeout(() => { window.print(); }, 100);
      } else {
        setBillPreview(null);
        toast({ title: "Bill Settled", message: `${invoice_no} saved. Open it from Today's Bills to print later.`, type: "success" });
      }
    } catch (err) {
      confirm({ title: "Save Failed", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    }
  };

  if (loading) return <div className="text-center text-[var(--gold)] p-10">Loading...</div>;

  return (
    <div style={{ height: "calc(100vh - 80px)", display: "flex", flexDirection: "column", gap: 16 }}>
      {/* ── TOP ACTION BAR ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12, background: "var(--bg2)", padding: "12px 20px",
        borderRadius: 16, border: "1px solid var(--border)", boxShadow: "0 4px 20px rgba(0,0,0,0.2)",
        flexWrap: "wrap"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, flexWrap: "wrap", minWidth: 0 }}>
          <div style={{ position: "relative", flex: 1, minWidth: 180, maxWidth: 400 }}>
             <div style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--accent)", opacity: 0.6 }}>
               <Icon name="search" size={16} />
             </div>
             <input
               type="text"
               placeholder="IDENTIFY CLIENT (NAME / PHONE)..."
               value={clientSearch}
               onChange={e => { setClientSearch(e.target.value); setSelectedCustomer(null); setShowCustomerDropdown(true); }}
               onFocus={() => setShowCustomerDropdown(true)}
               onBlur={() => setTimeout(() => setShowCustomerDropdown(false), 150)}
               style={{
                 width: "100%", padding: "12px 16px 12px 42px", borderRadius: 12, border: "none",
                 background: "var(--bg4)", color: "var(--text)", fontSize: 13, fontWeight: 700,
                 letterSpacing: 1, outline: "none", borderBottom: selectedCustomer ? "2px solid var(--green)" : clientSearch ? "2px solid var(--accent)" : "2px solid transparent",
                 transition: "all 0.3s", boxSizing: "border-box"
               }}
             />
             {selectedCustomer && (
               <button type="button" onClick={(e) => { e.stopPropagation(); setSelectedCustomer(null); setClientSearch(""); }}
                 title="Clear customer"
                 style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "transparent", border: "none", color: "var(--green)", cursor: "pointer", fontSize: 11, fontWeight: 800, letterSpacing: 0.5 }}>
                 ✓ {selectedCustomer.name} ✕
               </button>
             )}
             {showCustomerDropdown && clientSearch.trim().length > 0 && !selectedCustomer && (
               <div style={{
                 position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 20,
                 background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 12,
                 boxShadow: "0 10px 30px rgba(0,0,0,0.4)", overflow: "hidden", maxHeight: 280, overflowY: "auto",
               }}>
                 {customerMatches.map(c => (
                   <button key={c.id} type="button" onMouseDown={() => pickCustomer(c)}
                     style={{ width: "100%", padding: "10px 14px", background: "transparent", border: "none", textAlign: "left", cursor: "pointer", color: "var(--text)", fontSize: 13, borderBottom: "1px solid var(--border)" }}>
                     <div style={{ fontWeight: 700 }}>{c.name}</div>
                     <div style={{ fontSize: 11, color: "var(--text3)" }}>{c.phone || "no phone"}</div>
                   </button>
                 ))}
                 <button type="button" onMouseDown={openNewCustomerForm}
                   style={{ width: "100%", padding: "12px 14px", background: "rgba(34,211,238,0.08)", border: "none", color: "var(--accent)", fontSize: 12, fontWeight: 800, letterSpacing: 0.5, cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 8 }}>
                   <Icon name="plus" size={14} />
                   {customerMatches.length === 0 ? `No match — add "${clientSearch.trim()}" as new customer` : "Add new customer"}
                 </button>
               </div>
             )}
          </div>
          <select
            value={selBranch}
            onChange={e => { setSelBranch(e.target.value); setStaffRows({}); setOnlineInc(""); setCart([]); }}
            style={{
              background: "var(--bg4)", border: "none", color: selBranch ? "var(--gold)" : "var(--text3)", fontWeight: 800,
              fontSize: 13, outline: "none", cursor: "pointer", textTransform: "uppercase",
              padding: "10px 12px", borderRadius: 10
            }}>
            <option value="">SELECT BRANCH…</option>
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <input
            type="date"
            value={selDate}
            onChange={e => { setSelDate(e.target.value); setEditId(null); }}
            style={{
              background: "var(--bg4)", border: "none", color: "var(--text)", fontWeight: 700,
              fontSize: 13, outline: "none", padding: "10px 12px", borderRadius: 10, cursor: "pointer"
            }}
            title="Entry date"
          />
        </div>

        <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setViewMode("pos")} style={{
              padding: "10px 16px", borderRadius: 10, fontSize: 11, fontWeight: 800, border: "none", cursor: "pointer",
              background: viewMode === "pos" ? "var(--accent)" : "var(--bg4)", color: viewMode === "pos" ? "#000" : "var(--text3)",
              textTransform: "uppercase", transition: "all .3s"
            }}>Terminal</button>
            <button onClick={() => setViewMode("history")} style={{
              padding: "10px 16px", borderRadius: 10, fontSize: 11, fontWeight: 800, border: "none", cursor: "pointer",
              background: viewMode === "history" ? "var(--accent)" : "var(--bg4)", color: viewMode === "history" ? "#000" : "var(--text3)",
              textTransform: "uppercase", transition: "all .3s"
            }}>History</button>
        </div>
      </div>

      {viewMode === "pos" ? (
        <div className="pos-split" style={{ flex: 1, display: "flex", gap: 16, minHeight: 0 }}>
          {/* ── LEFT: MENU GRID ── */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
            {/* Category Chips */}
            <div style={{ display: "flex", gap: 10, overflowX: "auto", padding: "4px 0", scrollbarWidth: "none" }}>
              {Object.keys(MENU).map(cat => (
                <button 
                  key={cat} 
                  onClick={() => setActiveCategory(cat)}
                  style={{
                    padding: "10px 20px", borderRadius: "100px", fontSize: 11, fontWeight: 700, border: "none", cursor: "pointer",
                    whiteSpace: "nowrap", textTransform: "uppercase", letterSpacing: 1,
                    background: activeCategory === cat ? "var(--accent)" : "var(--bg3)",
                    color: activeCategory === cat ? "#000" : "var(--text3)",
                    boxShadow: activeCategory === cat ? "0 4px 15px rgba(var(--accent-rgb), 0.3)" : "none",
                    transition: "all .3s"
                  }}>
                  {cat}
                </button>
              ))}
            </div>

            {/* Empty states */}
            {!selBranch && (
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text3)", fontSize: 13, fontWeight: 700, letterSpacing: 1, textAlign: "center", padding: 20 }}>
                ⚠ Select a branch to load its menu.
              </div>
            )}
            {selBranch && Object.keys(MENU).length === 0 && (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--text3)", fontSize: 13, textAlign: "center", padding: 20, gap: 10 }}>
                <div style={{ fontSize: 32 }}>📋</div>
                <div style={{ fontWeight: 700 }}>No menu configured for this branch.</div>
                <div style={{ fontSize: 12 }}>Ask an admin to set up a menu in <strong>Menu Configuration</strong> and tag it to this branch.</div>
              </div>
            )}

            {/* Today's Settled Bills — click to re-open preview and print later */}
            {selBranch && todaysSettled.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 2px", overflowX: "auto", scrollbarWidth: "none" }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, flexShrink: 0 }}>Today&apos;s Bills</div>
                {todaysSettled.map(inv => (
                  <button key={inv.id} onClick={() => openInvoicePreview(inv)}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0,
                      padding: "6px 10px", borderRadius: 999,
                      background: "rgba(var(--accent-rgb), 0.08)",
                      color: "var(--accent)",
                      border: "1px solid rgba(var(--accent-rgb), 0.25)",
                      fontSize: 11, fontWeight: 700, cursor: "pointer",
                    }}>
                    <span style={{ fontWeight: 900, letterSpacing: 0.5 }}>{inv.invoice_no}</span>
                    <span style={{ opacity: 0.8 }}>· {inv.customer_name || "Walk-in"} · {INR(inv.total || inv.subtotal || 0)}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Drafts Strip — today's drafts for this branch (auto-expires at midnight) */}
            {selBranch && todaysDrafts.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 2px", overflowX: "auto", scrollbarWidth: "none" }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, flexShrink: 0 }}>Drafts</div>
                {todaysDrafts.map(d => {
                  const active = editingDraftId === d.id;
                  return (
                    <div key={d.id}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0,
                        padding: "6px 10px", borderRadius: 999,
                        background: active ? "var(--accent)" : "var(--bg3)",
                        color: active ? "#000" : "var(--text2)",
                        border: `1px solid ${active ? "var(--accent)" : "var(--border2)"}`,
                        fontSize: 11, fontWeight: 700,
                      }}>
                      <button onClick={() => resumeDraft(d)}
                        style={{ background: "transparent", border: "none", color: "inherit", fontWeight: 700, cursor: "pointer", padding: 0 }}>
                        {(d.customer_name || "Walk-in")} · {d.items?.length || 0} item{(d.items?.length || 0) === 1 ? "" : "s"} · {INR(d.subtotal || 0)}
                      </button>
                      <button onClick={() => discardDraft(d)} title="Discard draft"
                        style={{ background: "transparent", border: "none", color: active ? "#000" : "var(--red)", opacity: 0.7, cursor: "pointer", padding: 0, display: "inline-flex", alignItems: "center" }}>
                        <Icon name="del" size={12} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Service Grid — credit-card style (compact, fixed aspect) */}
            {selBranch && Object.keys(MENU).length > 0 && (
            <div style={{
              flex: 1, overflowY: "auto", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
              gap: 12, paddingRight: 8, scrollbarWidth: "thin", alignContent: "start"
            }}>
              {MENU[activeCategory]?.map(service => (
                <div
                  key={service.id}
                  onClick={() => addToCart(service)}
                  style={{
                    aspectRatio: "1.6 / 1",
                    background: "linear-gradient(135deg, var(--bg2), var(--bg3))",
                    borderRadius: 14, padding: "12px 14px",
                    border: "1px solid var(--border)",
                    cursor: "pointer", transition: "transform .18s ease, border-color .18s ease, box-shadow .18s ease",
                    position: "relative", overflow: "hidden",
                    display: "flex", flexDirection: "column", justifyContent: "space-between",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-3px)"; e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.boxShadow = "0 8px 24px rgba(var(--accent-rgb),0.15)"; }}
                  onMouseLeave={e => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.boxShadow = "none"; }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div style={{ fontSize: 20, lineHeight: 1 }}>{service.icon}</div>
                    {service.time && <div style={{ fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.5 }}>{service.time}</div>}
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 800, color: "var(--text)", lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{service.name}</div>
                    <div style={{ fontSize: 15, fontWeight: 900, color: "var(--accent)", marginTop: 4 }}>{INR(service.price)}</div>
                  </div>
                  <div style={{ position: "absolute", bottom: -24, right: -24, width: 70, height: 70, background: "var(--accent)", filter: "blur(36px)", opacity: 0.06 }} />
                </div>
              ))}
            </div>
            )}
          </div>

          {/* ── RIGHT: CART / CHECKOUT ── */}
          <div className="pos-cart" style={{
            width: 380, background: "var(--bg2)", borderRadius: 24, padding: 24,
            display: "flex", flexDirection: "column", gap: 20, border: "1px solid var(--border)",
            boxShadow: "0 10px 40px rgba(0,0,0,0.3)", position: "relative", overflow: "hidden",
            flexShrink: 0
          }}>
            {/* Backdrop Glow */}
            <div style={{ position: "absolute", top: -100, right: -100, width: 300, height: 300, background: "var(--accent)", filter: "blur(120px)", opacity: 0.03, pointerEvents: "none" }} />
            
            <div style={{ fontSize: 16, fontWeight: 900, color: "var(--gold)", letterSpacing: 1.5, textTransform: "uppercase", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Order Summary</span>
              <Icon name="grid" size={18} />
            </div>

            {/* Branch + Default Stylist selectors (also selectable here, not just in top bar) */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: 12, borderBottom: "1px solid var(--border2)" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label style={{ fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Branch</label>
                <select value={selBranch}
                  onChange={e => { setSelBranch(e.target.value); setStaffRows({}); setOnlineInc(""); setCart([]); setDefaultStaffId(""); }}
                  style={{ padding: "8px 10px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: selBranch ? "var(--gold)" : "var(--text3)", fontSize: 12, fontWeight: 700, outline: "none", cursor: "pointer" }}>
                  <option value="">Select branch…</option>
                  {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label style={{ fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Default Stylist (auto-assign)</label>
                <select value={defaultStaffId}
                  onChange={e => setDefaultStaffId(e.target.value)}
                  disabled={!selBranch || branchStaff.length === 0}
                  style={{ padding: "8px 10px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: defaultStaffId ? "var(--accent)" : "var(--text3)", fontSize: 12, fontWeight: 700, outline: "none", cursor: branchStaff.length ? "pointer" : "not-allowed", opacity: branchStaff.length ? 1 : 0.5 }}>
                  <option value="">Auto (first active)</option>
                  {branchStaff.map(s => <option key={s.id} value={s.id}>{s.name}{s.role ? ` • ${s.role}` : ""}</option>)}
                </select>
              </div>
            </div>


            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, paddingRight: 4 }}>
              {cart.length === 0 ? (
                <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, opacity: 0.3 }}>
                   <Icon name="log" size={48} />
                   <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Cart is Empty</div>
                </div>
              ) : cart.map((item) => (
                <div key={item.cartId}
                  style={{
                    background: "linear-gradient(135deg, var(--bg3), var(--bg4))",
                    borderRadius: 14, padding: "10px 12px",
                    border: "1px solid var(--border2)",
                    display: "flex", flexDirection: "column", gap: 8,
                    position: "relative", overflow: "hidden",
                    animation: "pos-card-in .22s ease-out",
                  }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 800, color: "var(--text)", lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</div>
                      <div style={{ fontSize: 14, fontWeight: 900, color: "var(--accent)", marginTop: 2 }}>{INR(item.price)}</div>
                    </div>
                    <button onClick={() => removeFromCart(item)} style={{ background: "transparent", border: "none", color: "var(--red)", opacity: 0.7, cursor: "pointer", padding: 0 }} title="Remove">
                      <Icon name="del" size={14} />
                    </button>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.5 }}>Staff:</div>
                    <select
                      value={item.staffId}
                      onChange={e => updateCartStaff(item.cartId, e.target.value)}
                      style={{
                        flex: 1, background: "var(--bg2)", border: "1px solid var(--border2)", borderRadius: 8,
                        padding: "4px 6px", color: "var(--text2)", fontSize: 10, fontWeight: 600, outline: "none"
                      }}>
                      <option value="">Select…</option>
                      {branchStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  <div style={{ position: "absolute", bottom: -20, right: -20, width: 60, height: 60, background: "var(--accent)", filter: "blur(30px)", opacity: 0.06 }} />
                </div>
              ))}
            </div>

            {/* Financials */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12, borderTop: "1px solid var(--border2)", paddingTop: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--text3)", fontWeight: 600 }}>
                 <span>Subtotal</span>
                 <span style={{ color: "var(--text)" }}>{INR(totalBilling + totalMatSale)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--text3)", fontWeight: 600 }}>
                 <span>GST ({gstPct || 0}%)</span>
                 <span style={{ color: "var(--red)" }}>{INR(totalRowGst)}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                 <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 10, display: "block", marginBottom: 4, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase" }}>Online</label>
                    <input 
                      type="number" 
                      value={onlineInc} 
                      onChange={e => setOnlineInc(e.target.value)}
                      style={{ width: "100%", background: "var(--bg4)", border: "1px solid var(--border2)", borderRadius: 10, padding: 10, fontSize: 14, fontWeight: 800, color: "var(--accent)" }}
                    />
                 </div>
                 <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 10, display: "block", marginBottom: 4, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase" }}>Cash</label>
                    <input 
                      type="number" 
                      readOnly
                      value={totalCash} 
                      style={{ width: "100%", background: "var(--bg3)", border: "none", borderRadius: 10, padding: 10, fontSize: 14, fontWeight: 800, color: "var(--green)", opacity: 0.8 }}
                    />
                 </div>
              </div>

              <div style={{ marginTop: 16, padding: "20px", background: "linear-gradient(135deg, var(--bg4), var(--bg3))", borderRadius: 20, textAlign: "center", border: "1px solid rgba(255,255,255,0.03)" }}>
                 <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 2, marginBottom: 8 }}>Total Receivable</div>
                 <div style={{ fontSize: 36, fontWeight: 900, color: "var(--gold)", letterSpacing: -1 }}>{INR(totalBilling + totalMatSale + totalTips)}</div>
              </div>

              <div style={{ display: "flex", gap: 10 }}>
                <button
                  disabled={saving || cart.length === 0}
                  onClick={saveDraft}
                  style={{
                    flex: 1, padding: "14px", borderRadius: 14, fontSize: 12, fontWeight: 900,
                    background: "var(--bg4)", color: "var(--text)",
                    border: "1px solid var(--border2)",
                    cursor: cart.length === 0 ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: 1.2,
                    transition: "all .2s",
                    opacity: cart.length === 0 ? 0.5 : 1,
                  }}
                  onMouseEnter={e => { if (cart.length) e.currentTarget.style.borderColor = "var(--accent)"; }}
                  onMouseLeave={e => e.currentTarget.style.borderColor = "var(--border2)"}>
                  {saving ? "…" : (editingDraftId ? "Update Draft" : "Save Draft")}
                </button>
                <button
                  disabled={saving || cart.length === 0}
                  onClick={openBillPreview}
                  style={{
                    flex: 1.2, padding: "14px", borderRadius: 14, border: "none", fontSize: 12, fontWeight: 900,
                    background: "linear-gradient(135deg, var(--accent), var(--gold2))", color: "#000",
                    cursor: cart.length === 0 ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: 1.2,
                    boxShadow: "0 8px 24px rgba(var(--accent-rgb), 0.3)", transition: "all .2s",
                    opacity: cart.length === 0 ? 0.5 : 1
                  }}
                  onMouseEnter={e => { if (cart.length) e.currentTarget.style.transform = "scale(1.02)"; }}
                  onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"}>
                  {saving ? "Settling…" : "Preview & Settle"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: "auto" }}>
           <PeriodWidget filterMode={filterMode} setFilterMode={setFilterMode} filterYear={filterYear} setFilterYear={setFilterYear} filterMonth={filterMonth} setFilterMonth={setFilterMonth} />

           {/* Search bar — filters invoices across branches by inv-no / customer / amount / date */}
           <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 10, background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, padding: 10, position: "relative" }}>
             <div style={{ position: "absolute", left: 22, color: "var(--text3)" }}><Icon name="search" size={14} /></div>
             <input value={historySearch} onChange={e => setHistorySearch(e.target.value)}
               placeholder="Search bills by invoice no, customer, amount, or date (YYYY-MM-DD)…"
               style={{ flex: 1, padding: "10px 12px 10px 34px", background: "var(--bg3)", border: "1px solid var(--border2)", borderRadius: 8, color: "var(--text)", fontSize: 13, outline: "none" }} />
             {historySearch && (
               <button onClick={() => setHistorySearch("")}
                 style={{ background: "transparent", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: 18, fontWeight: 700 }}>✕</button>
             )}
           </div>

           {/* Branch cards — click to drill into that branch's invoices */}
           <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
             {branchSummaries.length === 0 && (
               <div style={{ gridColumn: "1 / -1", padding: 30, textAlign: "center", color: "var(--text3)", fontSize: 13 }}>
                 No invoices in this period yet.
               </div>
             )}
             {branchSummaries.map(bs => {
               const active = expandedBranchId === bs.branch_id;
               return (
                 <button key={bs.branch_id}
                   onClick={() => {
                     if (active) { setExpandedBranchId(null); return; }
                     setExpandedBranchId(bs.branch_id);
                     setBranchDateFilter(""); setBranchCustomerFilter(""); setBranchSortBy("date_desc"); setBranchStatusFilter("all");
                   }}
                   style={{
                     textAlign: "left", cursor: "pointer",
                     background: active ? "linear-gradient(135deg, rgba(var(--accent-rgb),0.12), rgba(var(--accent-rgb),0.03))" : "var(--bg2)",
                     border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                     borderRadius: 16, padding: 16, display: "flex", flexDirection: "column", gap: 8,
                     transition: "all .2s",
                   }}>
                   <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5 }}>Branch</div>
                   <div style={{ fontSize: 16, fontWeight: 800, color: "var(--text)", letterSpacing: 0.2 }}>{bs.branch_name}</div>
                   <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: 6 }}>
                     <div>
                       <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>Bills</div>
                       <div style={{ fontSize: 22, fontWeight: 900, color: "var(--accent)" }}>{bs.count}</div>
                       {bs.drafts > 0 && (
                         <div style={{ fontSize: 10, color: "var(--orange)", fontWeight: 700, marginTop: 2 }}>+{bs.drafts} draft{bs.drafts === 1 ? "" : "s"}</div>
                       )}
                     </div>
                     <div style={{ textAlign: "right" }}>
                       <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>Total</div>
                       <div style={{ fontSize: 18, fontWeight: 900, color: "var(--gold)" }}>{INR(bs.total)}</div>
                     </div>
                   </div>
                 </button>
               );
             })}
           </div>

           {/* Expanded invoice table for the selected branch */}
           {expandedBranchId && (
             <div style={{ marginTop: 16 }}>
               <Card>
                 <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                   <div style={{ fontSize: 12, fontWeight: 800, color: "var(--text)", letterSpacing: 0.5 }}>
                     {branchesById.get(expandedBranchId)?.name || "Branch"} — Invoices
                   </div>
                   <button onClick={() => setExpandedBranchId(null)}
                     style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--text3)", borderRadius: 8, padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Collapse</button>
                 </div>

                 {/* Filter bar — sort, date, customer, status */}
                 <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                   <select value={branchSortBy} onChange={e => setBranchSortBy(e.target.value)}
                     style={{ padding: "8px 10px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 11, fontWeight: 700, outline: "none" }}>
                     <option value="date_desc">Newest first</option>
                     <option value="date_asc">Oldest first</option>
                     <option value="amount_desc">Amount: high → low</option>
                     <option value="amount_asc">Amount: low → high</option>
                   </select>
                   <input type="date" value={branchDateFilter} onChange={e => setBranchDateFilter(e.target.value)}
                     placeholder="Any date"
                     style={{ padding: "8px 10px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 11, fontWeight: 700, outline: "none", colorScheme: "dark" }} />
                   <input type="text" value={branchCustomerFilter} onChange={e => setBranchCustomerFilter(e.target.value)}
                     placeholder="Filter by customer / phone…"
                     style={{ flex: "1 1 180px", padding: "8px 10px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 11, fontWeight: 600, outline: "none" }} />
                   <div style={{ display: "inline-flex", borderRadius: 8, overflow: "hidden", border: "1px solid var(--border2)" }}>
                     {[["all", "All"], ["settled", "Settled"], ["draft", "Drafts"]].map(([v, l]) => (
                       <button key={v} onClick={() => setBranchStatusFilter(v)}
                         style={{ padding: "8px 12px", background: branchStatusFilter === v ? "var(--accent)" : "var(--bg3)", color: branchStatusFilter === v ? "#000" : "var(--text2)", border: "none", fontSize: 10, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", cursor: "pointer" }}>{l}</button>
                     ))}
                   </div>
                   {(branchDateFilter || branchCustomerFilter || branchSortBy !== "date_desc" || branchStatusFilter !== "all") && (
                     <button onClick={() => { setBranchDateFilter(""); setBranchCustomerFilter(""); setBranchSortBy("date_desc"); setBranchStatusFilter("all"); }}
                       style={{ background: "transparent", border: "1px solid var(--border)", color: "var(--text3)", borderRadius: 8, padding: "6px 10px", fontSize: 10, fontWeight: 700, cursor: "pointer", textTransform: "uppercase", letterSpacing: 1 }}>Reset</button>
                   )}
                 </div>

                 <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5 }}>
                   <thead>
                     <tr>
                       <TH>Date</TH><TH>Invoice</TH><TH>Customer</TH>
                       <TH right>Online</TH><TH right>Cash</TH>
                       <TH right>Amount</TH>
                       <TH right>Action</TH>
                     </tr>
                   </thead>
                   <tbody>
                     {filteredBranchInvoices.length === 0 && (
                       <tr><td colSpan={7} style={{ textAlign: "center", padding: 24, color: "var(--text3)", fontSize: 12 }}>
                         No invoices match the current filters.
                       </td></tr>
                     )}
                     {filteredBranchInvoices.map(inv => {
                       const isDraft = inv.status === "draft";
                       return (
                         <tr key={inv.id} style={{ opacity: isDraft ? 0.85 : 1 }}>
                           <TD style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{inv.date}</TD>
                           <TD style={{ fontFamily: "var(--font-headline, var(--font-outfit))", fontWeight: 700, color: isDraft ? "var(--orange)" : "var(--accent)" }}>
                             {isDraft ? (
                               <span style={{ display: "inline-block", padding: "2px 6px", borderRadius: 6, background: "rgba(251,146,60,0.12)", border: "1px solid rgba(251,146,60,0.3)", fontSize: 10, letterSpacing: 1 }}>DRAFT</span>
                             ) : inv.invoice_no}
                           </TD>
                           <TD>
                             <div style={{ fontWeight: 600 }}>{inv.customer_name || "Walk-in"}</div>
                             {inv.customer_phone && <div style={{ fontSize: 10, color: "var(--text3)" }}>{inv.customer_phone}</div>}
                           </TD>
                           <TD right style={{ color: "var(--green)" }}>{INR(inv.online || 0)}</TD>
                           <TD right style={{ color: "var(--green)" }}>{INR(inv.cash || 0)}</TD>
                           <TD right style={{ fontWeight: 800, color: isDraft ? "var(--orange)" : "var(--gold)" }}>{INR(inv.total || inv.subtotal || 0)}</TD>
                           <TD right>
                             {isDraft ? (
                               <span style={{ fontSize: 10, color: "var(--text3)", fontStyle: "italic" }}>Pending settle</span>
                             ) : (
                               <button onClick={() => openInvoicePreview(inv)} title="Open bill (print / save as PDF)"
                                 style={{ background: "rgba(var(--accent-rgb),0.1)", border: "1px solid rgba(var(--accent-rgb),0.3)", color: "var(--accent)", padding: "6px 10px", borderRadius: 8, fontWeight: 700, fontSize: 11, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
                                 <Icon name="log" size={12} /> PDF
                               </button>
                             )}
                           </TD>
                         </tr>
                       );
                     })}
                   </tbody>
                 </table>
               </Card>
             </div>
           )}

           {/* Global search results across all branches (only shown while searching) */}
           {historySearch && !expandedBranchId && filteredInvoices.length > 0 && (
             <div style={{ marginTop: 16 }}>
               <Card>
                 <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", fontSize: 12, fontWeight: 800, color: "var(--text)" }}>
                   Search Results ({filteredInvoices.length})
                 </div>
                 <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5 }}>
                   <thead>
                     <tr>
                       <TH>Date</TH><TH>Invoice No</TH><TH>Branch</TH><TH>Customer</TH>
                       <TH right>Amount</TH><TH right>PDF</TH>
                     </tr>
                   </thead>
                   <tbody>
                     {filteredInvoices.slice(0, 100).map(inv => (
                       <tr key={inv.id}>
                         <TD style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{inv.date}</TD>
                         <TD style={{ fontWeight: 700, color: "var(--accent)" }}>{inv.invoice_no}</TD>
                         <TD style={{ fontSize: 11 }}>{(branchesById.get(inv.branch_id)?.name || inv.branch_name || "").replace("V-CUT ", "")}</TD>
                         <TD>{inv.customer_name || "Walk-in"}</TD>
                         <TD right style={{ fontWeight: 800, color: "var(--gold)" }}>{INR(inv.total || inv.subtotal || 0)}</TD>
                         <TD right>
                           <button onClick={() => openInvoicePreview(inv)} title="Open bill (print / save as PDF)"
                             style={{ background: "rgba(var(--accent-rgb),0.1)", border: "1px solid rgba(var(--accent-rgb),0.3)", color: "var(--accent)", padding: "6px 10px", borderRadius: 8, fontWeight: 700, fontSize: 11, cursor: "pointer" }}>PDF</button>
                         </TD>
                       </tr>
                     ))}
                   </tbody>
                 </table>
               </Card>
             </div>
           )}

        </div>
      )}

      {/* Audit Log Modal */}
      {logView && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: "rgba(15,15,20,0.95)", border: "1px solid rgba(255,215,0,0.2)", borderRadius: 24, padding: 32, width: "100%", maxWidth: 420, boxShadow: "0 25px 50px -12px rgba(0,0,0,0.5)", position: "relative" }}>
            <button onClick={() => setLogView(null)} style={{ position: "absolute", top: 20, right: 20, background: "rgba(255,255,255,0.05)", border: "none", color: "var(--text3)", borderRadius: "50%", width: 32, height: 32, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all .2s" }}>✕</button>
            <div style={{ fontSize: 20, fontWeight: 800, color: "var(--gold)", marginBottom: 24, letterSpacing: 0.5 }}>Activity Timeline</div>
            <div style={{ maxHeight: 400, overflowY: "auto", paddingRight: 10, display: "flex", flexDirection: "column", gap: 0 }}>
              {(logView.activity_log || []).slice().reverse().map((log, idx) => (
                <div key={idx} style={{ display: "flex", gap: 16, position: "relative", paddingBottom: 24 }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: log.action === "Create" ? "var(--green)" : "var(--gold)", marginTop: 4, zIndex: 1 }} />
                    {idx !== (logView.activity_log || []).length - 1 && (
                      <div style={{ width: 2, flex: 1, background: "rgba(255,255,255,0.1)", margin: "4px 0" }} />
                    )}
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: "var(--text3)", marginBottom: 4, fontWeight: 700, textTransform: "uppercase" }}>
                      {new Date(log.time).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} · {new Date(log.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>{log.action} by {log.user}</div>
                    <div style={{ fontSize: 12, color: "var(--text3)", lineHeight: "1.5", background: "rgba(255,255,255,0.03)", padding: "8px 12px", borderRadius: 8 }}>{log.notes}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* New Customer Modal */}
      {customerForm && (
        <div onClick={() => setCustomerForm(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <form onSubmit={saveNewCustomer} onClick={e => e.stopPropagation()}
            style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 20, padding: 28, width: "100%", maxWidth: 440, display: "flex", flexDirection: "column", gap: 16, boxShadow: "0 25px 50px -12px rgba(0,0,0,0.6)" }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: "var(--gold)", letterSpacing: 0.5 }}>New Customer</div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Name *</label>
              <input autoFocus required value={customerForm.name} onChange={e => setCustomerForm({ ...customerForm, name: e.target.value })}
                placeholder="Full name"
                style={{ padding: "12px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 14, outline: "none" }} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Phone</label>
              <input value={customerForm.phone} onChange={e => setCustomerForm({ ...customerForm, phone: e.target.value })}
                placeholder="10-digit mobile"
                style={{ padding: "12px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 14, outline: "none" }} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Email</label>
              <input type="email" value={customerForm.email} onChange={e => setCustomerForm({ ...customerForm, email: e.target.value })}
                placeholder="optional"
                style={{ padding: "12px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 14, outline: "none" }} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Address</label>
              <input value={customerForm.address} onChange={e => setCustomerForm({ ...customerForm, address: e.target.value })}
                placeholder="optional"
                style={{ padding: "12px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 14, outline: "none" }} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Birth Date</label>
                <input type="date" value={customerForm.birthdate} onChange={e => setCustomerForm({ ...customerForm, birthdate: e.target.value })}
                  style={{ padding: "12px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 14, outline: "none" }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Marriage Date</label>
                <input type="date" value={customerForm.marriage_date} onChange={e => setCustomerForm({ ...customerForm, marriage_date: e.target.value })}
                  style={{ padding: "12px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 14, outline: "none" }} />
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Notes</label>
              <textarea rows={2} value={customerForm.notes} onChange={e => setCustomerForm({ ...customerForm, notes: e.target.value })}
                placeholder="Preferences, allergies, etc."
                style={{ padding: "12px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 14, outline: "none", resize: "vertical" }} />
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
              <button type="submit" style={{ flex: 1, padding: "12px", borderRadius: 10, background: "var(--accent)", color: "#000", border: "none", fontWeight: 800, cursor: "pointer", letterSpacing: 0.5 }}>Save Customer</button>
              <button type="button" onClick={() => setCustomerForm(null)} style={{ padding: "12px 18px", borderRadius: 10, background: "var(--bg3)", color: "var(--text2)", border: "1px solid var(--border)", cursor: "pointer", fontWeight: 600 }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {/* ── BILL PREVIEW / PRINT ── */}
      {billPreview && (
        <div className="bill-overlay" onClick={() => setBillPreview(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", backdropFilter: "blur(8px)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, overflow: "auto" }}>
          <div onClick={e => e.stopPropagation()}
            style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: 440 }}>

            {/* The actual bill — what gets printed */}
            <div id="print-bill"
              style={{
                background: "#ffffff", color: "#111", padding: "32px 28px", borderRadius: 12,
                position: "relative", overflow: "hidden", fontFamily: "var(--font-outfit, system-ui)",
                boxShadow: "0 20px 60px rgba(0,0,0,0.5)"
              }}>
              {/* V-Cut watermark behind everything */}
              <div aria-hidden="true" style={{
                position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
                pointerEvents: "none", opacity: 0.06, fontFamily: "'Great Vibes', cursive",
                fontSize: 180, fontWeight: 400, color: "#dc2626", transform: "rotate(-18deg)", letterSpacing: 4, userSelect: "none"
              }}>V-Cut</div>

              <div style={{ position: "relative" }}>
                {/* Header */}
                <div style={{ textAlign: "center", borderBottom: "2px solid #111", paddingBottom: 12, marginBottom: 16 }}>
                  <div style={{ fontFamily: "'Great Vibes', cursive", fontSize: 42, lineHeight: 1, color: "#dc2626" }}>V<span style={{ color: "#111" }}>-Cut</span></div>
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 4, color: "#111", marginTop: 4 }}>SALON · {billPreview.branch.name?.replace("V-CUT ", "").toUpperCase()}</div>
                  {billPreview.branch.location && <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>{billPreview.branch.location}</div>}
                </div>

                {/* Bill meta */}
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#333", marginBottom: 12 }}>
                  <div><strong>Bill #</strong> {billPreview.billNo}</div>
                  <div>{billPreview.date} · {billPreview.time}</div>
                </div>

                {/* Customer */}
                {billPreview.customer && (
                  <div style={{ background: "#f6f6f6", borderRadius: 8, padding: "8px 10px", marginBottom: 12, fontSize: 11 }}>
                    <div><strong>Guest:</strong> {billPreview.customer.name}</div>
                    {billPreview.customer.phone && <div style={{ color: "#555" }}>📞 {billPreview.customer.phone}</div>}
                  </div>
                )}

                {/* Items */}
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginBottom: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #111", textAlign: "left" }}>
                      <th style={{ padding: "6px 4px", fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Service</th>
                      <th style={{ padding: "6px 4px", fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Stylist</th>
                      <th style={{ padding: "6px 4px", fontSize: 10, textTransform: "uppercase", letterSpacing: 1, textAlign: "right" }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {billPreview.items.map((it, i) => (
                      <tr key={i} style={{ borderBottom: "1px dashed #ccc" }}>
                        <td style={{ padding: "8px 4px", fontWeight: 600 }}>{it.name}</td>
                        <td style={{ padding: "8px 4px", color: "#555" }}>{it.stylist}</td>
                        <td style={{ padding: "8px 4px", textAlign: "right", fontWeight: 700 }}>{INR(it.price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Totals */}
                <div style={{ borderTop: "1px solid #111", paddingTop: 10, fontSize: 12 }}>
                  <Row label="Subtotal" value={INR(billPreview.subtotal)} />
                  {billPreview.gstPct > 0 && <Row label={`GST (${billPreview.gstPct}%) — incl.`} value={INR(billPreview.gstAmt)} muted />}
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, paddingTop: 8, borderTop: "2px solid #111", fontSize: 16, fontWeight: 900 }}>
                    <span>TOTAL</span>
                    <span>{INR(billPreview.total)}</span>
                  </div>
                </div>

                {/* Payment */}
                <div style={{ marginTop: 14, padding: "10px 12px", background: "#f6f6f6", borderRadius: 8, fontSize: 11 }}>
                  <div style={{ fontWeight: 800, marginBottom: 4 }}>Payment — {billPreview.paymentMode}</div>
                  {billPreview.onlineAmt > 0 && <div style={{ display: "flex", justifyContent: "space-between" }}><span>Online</span><strong>{INR(billPreview.onlineAmt)}</strong></div>}
                  {billPreview.cashAmt > 0 && <div style={{ display: "flex", justifyContent: "space-between" }}><span>Cash</span><strong>{INR(billPreview.cashAmt)}</strong></div>}
                </div>

                {/* Thanks */}
                <div style={{ textAlign: "center", marginTop: 18, fontSize: 11, lineHeight: 1.6, color: "#333" }}>
                  <div style={{ fontFamily: "'Great Vibes', cursive", fontSize: 28, color: "#dc2626", lineHeight: 1 }}>Thank You</div>
                  <div style={{ marginTop: 6 }}>We loved having you at <strong>V-Cut</strong>. See you again soon ✂️</div>
                  <div style={{ fontSize: 10, color: "#777", marginTop: 8 }}>Billed by {billPreview.cashier}</div>
                </div>
              </div>
            </div>

            {/* Action buttons — hidden in print */}
            <div className="no-print" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={() => setBillPreview(null)}
                style={{ flex: "1 1 120px", padding: "12px", borderRadius: 10, background: "var(--bg3)", color: "var(--text)", border: "1px solid var(--border)", cursor: "pointer", fontWeight: 700 }}>
                {billPreview.viewOnly ? "Close" : "Back to Edit"}
              </button>
              {billPreview.viewOnly ? (
                <button onClick={() => window.print()}
                  style={{ flex: "2 1 160px", padding: "12px", borderRadius: 10, background: "linear-gradient(135deg, var(--accent), var(--gold2))", color: "#000", border: "none", cursor: "pointer", fontWeight: 900, letterSpacing: 1, textTransform: "uppercase" }}>
                  Print
                </button>
              ) : (
                <>
                  <button onClick={() => confirmPrintAndSave({ print: false })} disabled={saving}
                    style={{ flex: "1 1 140px", padding: "12px", borderRadius: 10, background: "var(--bg4)", color: "var(--text)", border: "1px solid var(--accent)", cursor: "pointer", fontWeight: 800, letterSpacing: 1, textTransform: "uppercase" }}>
                    {saving ? "Saving…" : "Settle"}
                  </button>
                  <button onClick={() => confirmPrintAndSave({ print: true })} disabled={saving}
                    style={{ flex: "1 1 160px", padding: "12px", borderRadius: 10, background: "linear-gradient(135deg, var(--accent), var(--gold2))", color: "#000", border: "none", cursor: "pointer", fontWeight: 900, letterSpacing: 1, textTransform: "uppercase" }}>
                    {saving ? "…" : "Settle & Print"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {ToastContainer}
      {ConfirmDialog}
    </div>
  );
}

function Row({ label, value, muted }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", color: muted ? "#666" : "#111" }}>
      <span>{label}</span>
      <span style={{ fontWeight: muted ? 500 : 700 }}>{value}</span>
    </div>
  );
}

function FG({ label, children, income, expense }) {
  const borderColor = income ? "var(--green)" : expense ? "var(--red)" : "var(--input-border)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, justifyContent: "flex-end" }}>
      <label style={{ fontSize: 12, color: "var(--text2)", fontWeight: 700, textTransform: "capitalize", letterSpacing: 1 }}>{label}</label>
      <div style={{ display: "contents" }}>
        {children && (() => {
          const child = children;
          const baseStyle = { padding: "12px 16px", border: `2px solid ${borderColor}`, borderRadius: 10, fontSize: 15, background: "var(--bg2)", color: "var(--text)", fontFamily: "var(--font-outfit)", width: "100%", transition: "all .3s", outline: "none", boxSizing: "border-box" };
          if (child.type === "input" || child.type === "select") {
            return <child.type {...child.props} style={{ ...baseStyle, ...child.props.style }} />;
          }
          return child;
        })()}
      </div>
    </div>
  );
}
