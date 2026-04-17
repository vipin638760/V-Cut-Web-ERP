"use client";
import { useEffect, useState, useRef, useMemo, startTransition } from "react";
import { collection, onSnapshot, query, orderBy, where, addDoc, deleteDoc, doc, updateDoc, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR } from "@/lib/calculations";
import { Icon, IconBtn, Card, PeriodWidget, TH, TD, Modal, useConfirm, useToast } from "@/components/ui";
import { staffStatusForMonth, effectiveBranchOnDate } from "@/lib/calculations";
import VLoader from "@/components/VLoader";


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

export default function EntryPage() {
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
  const [leaves, setLeaves] = useState([]);
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
  const [loanStaffIds, setLoanStaffIds] = useState(() => new Set()); // staff added as loan resources for this entry
  const [loanPickerOpen, setLoanPickerOpen] = useState(false);
  const [loanSearch, setLoanSearch] = useState("");
  const [editId, setEditId] = useState(null);
  const [logView, setLogView] = useState(null);
  const [recentView, setRecentView] = useState("branch"); // "branch" | "all" | "date" | "range"
  const [recentDate, setRecentDate] = useState(""); // defaults to selDate
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [uploadPreview, setUploadPreview] = useState(null); // { rows: [...], errors: [...], valid: [...] }
  const [serviceLogsByStaff, setServiceLogsByStaff] = useState({}); // { [staff_id]: { billing, tips, material, count, closed } }
  const [sharedServices, setSharedServices] = useState([]); // [{ id, service_name, amount, sale_staff_id, incentive_staff_ids: [] }]
  const [sharedForm, setSharedForm] = useState(null); // { service_name, amount, sale_staff_id, incentive_staff_ids: [] } or null
  const [templatePicker, setTemplatePicker] = useState(false); // show format choice
  const [generatingTemplate, setGeneratingTemplate] = useState(false);
  
  // Track original values to allow updates to existing duplicates
  const [origBranch, setOrigBranch] = useState("");
  const [origDate, setOrigDate] = useState("");

  const currentUser = useCurrentUser() || {};
  // While the user hook is hydrating (role undefined) treat as editor so
  // action buttons are not hidden during the first render pass.
  const roleKnown = !!currentUser?.role;
  const canEdit = !roleKnown || ["admin", "accountant"].includes(currentUser.role);
  const canDelete = !roleKnown || currentUser.role === "admin";

  // Define handlers BEFORE any other function that references them.
  // (Turbopack/SWC production minifier does not reliably hoist `function` declarations,
  // which caused a "Cannot access 'eB' before initialization" TDZ error on the live site.)
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
    const loans = new Set();
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
        if (sb.loan_flag) loans.add(sb.staff_id);
      });
    }
    setStaffRows(rows);
    setLoanStaffIds(loans);
    setSharedServices(e.shared_services || []);
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

  // Stable subscriptions (branches, staff, transfers, settings) — mount once, don't re-subscribe on filter/edit changes.
  useEffect(() => {
    if (!db) return;
    const wrap = (setter) => (sn) => startTransition(() => setter(sn.docs.map(d => ({ ...d.data(), id: d.id }))));
    const unsubs = [
      onSnapshot(collection(db, "branches"), wrap(setBranches)),
      onSnapshot(collection(db, "staff"), wrap(setStaff)),
      onSnapshot(collection(db, "staff_transfers"), wrap(setTransfers)),
      onSnapshot(collection(db, "leaves"), wrap(setLeaves)),
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

  // Sync gstPct from globalGst when not editing an existing entry (decoupled from the subscription).
  useEffect(() => {
    if (!editId) setGstPct(globalGst);
  }, [globalGst, editId]);

  // Entries subscription — scoped to the current filter period so we read far less data.
  // Re-subscribes when the user switches month/year.
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
    const unsub = onSnapshot(q, (sn) => {
      // Process + commit inside a transition so typing in the form stays responsive.
      startTransition(() => handleEntriesSn(sn));
    });
    return () => unsub();
  }, [filterMode, filterPrefix, filterYear]);

  // Service logs for the currently selected branch+date — used to show discrepancies
  // between what staff logged themselves (day-working page) and what the accountant is entering.
  useEffect(() => {
    if (!db || !selBranch || !selDate) { setServiceLogsByStaff({}); return; }
    const q = query(
      collection(db, "service_logs"),
      where("branch_id", "==", selBranch),
      where("date", "==", selDate),
    );
    const unsub = onSnapshot(q, sn => {
      const byStaff = {};
      sn.docs.forEach(d => {
        const l = d.data();
        const k = l.staff_id;
        if (!byStaff[k]) byStaff[k] = { billing: 0, tips: 0, material: 0, count: 0 };
        byStaff[k].billing  += Number(l.amount) || 0;
        byStaff[k].tips     += Number(l.tip) || 0;
        byStaff[k].material += Number(l.material_sale) || 0;
        byStaff[k].count    += 1;
      });
      setServiceLogsByStaff(byStaff);
    });
    return () => unsub();
  }, [selBranch, selDate]);

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

  // Cross-branch active staff — used by the loan-resource picker.
  const allActiveStaffOnDate = selDate
    ? staff.filter(s => {
        if (s.join && selDate < s.join) return false;
        if (s.exit_date && selDate > s.exit_date) return false;
        const mon = selDate.slice(0, 7);
        return staffStatusForMonth(s, mon).status !== "inactive";
      })
    : [];

  const homeBranchOf = (s) => effectiveBranchOnDate(s, selDate, transfers) || s?.branch_id || null;

  // Loan rows = staff added ad-hoc whose home is another branch today.
  const loanStaffList = selBranch
    ? allActiveStaffOnDate.filter(s => loanStaffIds.has(s.id) && homeBranchOf(s) !== selBranch)
    : [];

  // Combined list the table iterates over.
  const tableStaff = [...branchStaff, ...loanStaffList];

  // Staff eligible for the picker: active today AND home is a different branch AND not already added.
  const loanPickerResults = selBranch
    ? allActiveStaffOnDate.filter(s => {
        if (homeBranchOf(s) === selBranch) return false;
        if (loanStaffIds.has(s.id)) return false;
        const q = loanSearch.trim().toLowerCase();
        if (!q) return true;
        const homeName = (branchesById.get(homeBranchOf(s))?.name || "").toLowerCase();
        return (s.name || "").toLowerCase().includes(q) || homeName.includes(q);
      })
    : [];

  const addLoanStaff = (sid) => {
    setLoanStaffIds(prev => { const n = new Set(prev); n.add(sid); return n; });
    setLoanSearch("");
  };
  const removeLoanStaff = (sid) => {
    setLoanStaffIds(prev => { const n = new Set(prev); n.delete(sid); return n; });
    setStaffRows(prev => { const { [sid]: _omit, ...rest } = prev; return rest; });
  };

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
      
      const incentive = field === "billing"
        ? Math.round(billing * incPct)
        : Math.round((field === "incentive" ? Number(value) : (row.incentive !== undefined ? Number(row.incentive) || 0 : Math.round(billing * incPct))) || 0);
      const mat_incentive = Math.round(material * matPct);

      const staffTotalInc = Math.round(incentive + mat_incentive + tips);

      const total = Math.round(billing + material + tips - incentive - mat_incentive);
      return { ...prev, [sid]: { ...row, billing, material, tips, incentive, mat_incentive, staff_total_inc: staffTotalInc, total } };
    });
  };

  // ── Shared Services: per-staff billing + incentive contributions ──
  const sharedContributions = useMemo(() => {
    const billing = {};   // { staffId: amount added to billing }
    const incentive = {}; // { staffId: incentive earned }
    sharedServices.forEach(ss => {
      const amt = Number(ss.amount) || 0;
      if (amt <= 0) return;
      billing[ss.sale_staff_id] = (billing[ss.sale_staff_id] || 0) + amt;
      (ss.incentive_staff_ids || []).forEach(sid => {
        const s = staff.find(x => x.id === sid);
        const b = branchesById.get(selBranch);
        let incRate = 10;
        if (globalSettings) {
          incRate = b?.type === 'unisex' ? (globalSettings.unisex_inc ?? 10) : (globalSettings.mens_inc ?? 10);
        } else if (s?.incentive_pct !== undefined) {
          incRate = s.incentive_pct;
        }
        incentive[sid] = (incentive[sid] || 0) + Math.round(amt * incRate / 100);
      });
    });
    const totalBilling = Object.values(billing).reduce((s, v) => s + v, 0);
    const totalIncentive = Object.values(incentive).reduce((s, v) => s + v, 0);
    return { billing, incentive, totalBilling, totalIncentive };
  }, [sharedServices, staff, selBranch, globalSettings, branchesById]);

  // Totals — single pass over staffRows + shared service contributions.
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
    // Add shared service contributions
    acc.totalBilling += sharedContributions.totalBilling;
    acc.totalIncentive += sharedContributions.totalIncentive;
    acc.totalStaffIncCombined += sharedContributions.totalIncentive;
    return acc;
  }, [staffRows, sharedContributions]);
  
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
      // Block if a non-rejected leave already exists for this staff on this date
      const dupSnap = await getDocs(query(
        collection(db, "leaves"),
        where("staff_id", "==", ls.id),
        where("date", "==", selDate)
      ));
      const dup = dupSnap.docs.map(d => d.data()).find(l => l.status !== "rejected");
      if (dup) {
        confirm({
          title: "Leave Already Exists",
          message: `${ls.name} already has a <strong>${dup.status}</strong> leave (${dup.type || "—"}) on ${selDate}. Can't submit it again.`,
          confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {}
        });
        setLeavePrompt(null);
        return;
      }
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

  // Staff showing Present in the UI but with zero billing / material / tips.
  // Warn regardless of whether a leave record already exists: if the row is still ticked
  // Present while a leave is on file for today, that's a contradictory state the user
  // needs to resolve (uncheck Present or remove the stale leave). Keep the warning
  // in sync with what's visible on screen.
  const zeroWorkPresent = [...branchStaff, ...loanStaffList].filter(s => {
    const r = staffRows[s.id] || {};
    if (r.present === false) return false;
    const hasWork = (Number(r.billing) || 0) > 0 || (Number(r.material) || 0) > 0 || (Number(r.tips) || 0) > 0;
    return !hasWork;
  });

  const handleSave = async (e, opts = {}) => {
    e.preventDefault();
    if (!selBranch) { confirm({ title: "Notice", message: "Select a branch first.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} }); return; }

    // Absence check before save — present staff with no logged work and no leave on file.
    // Manager / accountant has to decide: truly present (idle) OR absent (file leave).
    if (!opts.skipAbsenceCheck && zeroWorkPresent.length > 0) {
      const names = zeroWorkPresent.map(s => s.name).join(", ");
      confirm({
        title: "Confirm attendance",
        message: `${zeroWorkPresent.length} staff marked <strong>present</strong> have no billing, material, or tips and no leave on file for ${selDate}:<br/><br/><strong>${names}</strong><br/><br/>If they were absent, uncheck Present on each row and file leave. If they were genuinely present without work, save as-is.`,
        confirmText: "Save As-Is",
        cancelText: "Let Me Fix",
        type: "warning",
        onConfirm: () => handleSave(e, { ...opts, skipAbsenceCheck: true }),
      });
      return;
    }

    setSaving(true);
    setSaveStatus("");

    // Check for duplicates (same branch and date)
    // Only block if we are creating NEW, or if we changed branch/date to a combination that conflict with ANOTHER record
    const hasChanged = selBranch !== origBranch || selDate !== origDate;
    if (!editId || hasChanged) {
      const exists = entries.find(e => e.branch_id === selBranch && e.date === selDate && e.id !== editId);
      if (exists) {
        confirm({ title: "Duplicate Detected", message: `An entry for ${branchesById.get(selBranch)?.name} on ${selDate} already exists. Please edit the existing entry instead of creating a new one.`, confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} });
        setSaving(false);
        return;
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
        staff_billing: [
          ...branchStaff.map(s => {
            const shBilling = sharedContributions.billing[s.id] || 0;
            const shIncentive = sharedContributions.incentive[s.id] || 0;
            const baseBilling = (staffRows[s.id]?.billing || 0) + shBilling;
            const baseInc = (staffRows[s.id]?.incentive || 0) + shIncentive;
            const baseTotalInc = (staffRows[s.id]?.staff_total_inc || 0) + shIncentive;
            return {
              staff_id: s.id,
              billing: baseBilling,
              material: staffRows[s.id]?.material || 0,
              incentive: baseInc,
              mat_incentive: staffRows[s.id]?.mat_incentive || 0,
              tips: staffRows[s.id]?.tips || 0,
              tip_in: staffRows[s.id]?.tip_in || "online",
              tip_paid: staffRows[s.id]?.tip_paid || "cash",
              present: staffRows[s.id]?.present !== false,
              staff_total_inc: baseTotalInc,
              shared_billing: shBilling || undefined,
              shared_incentive: shIncentive || undefined,
              home_branch_id: selBranch,
              loan_flag: false,
            };
          }),
          ...loanStaffList.map(s => {
            const shBilling = sharedContributions.billing[s.id] || 0;
            const shIncentive = sharedContributions.incentive[s.id] || 0;
            const baseBilling = (staffRows[s.id]?.billing || 0) + shBilling;
            const baseInc = (staffRows[s.id]?.incentive || 0) + shIncentive;
            const baseTotalInc = (staffRows[s.id]?.staff_total_inc || 0) + shIncentive;
            return {
              staff_id: s.id,
              billing: baseBilling,
              material: staffRows[s.id]?.material || 0,
              incentive: baseInc,
              mat_incentive: staffRows[s.id]?.mat_incentive || 0,
              tips: staffRows[s.id]?.tips || 0,
              tip_in: staffRows[s.id]?.tip_in || "online",
              tip_paid: staffRows[s.id]?.tip_paid || "cash",
              present: staffRows[s.id]?.present !== false,
              staff_total_inc: baseTotalInc,
              shared_billing: shBilling || undefined,
              shared_incentive: shIncentive || undefined,
              home_branch_id: homeBranchOf(s),
              loan_flag: true,
            };
          }),
        ],
        shared_services: sharedServices.length > 0 ? sharedServices : [],
        actual_cash: actualCashNum,
        cash_diff: cashDiff,
        tips_in_cash: tipsInCash,
        tips_paid_cash: tipsPaidCash,
        global_gst_pct: Number(gstPct) || 0,
        total_gst: totalRowGst,
        created_at: new Date().toISOString(),
        created_by: currentUser?.id || "unknown",
      };
      
      if (editId) {
        // DETAILED LOGGING LOGIC
        const old = entries.find(x => x.id === editId);
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
          notes: changes.length > 0 ? changes.join(", ") : "Manual update (no values changed)"
        };

        await updateDoc(doc(db, "entries", editId), { 
          ...payload, 
          updated_at: new Date().toISOString(),
          updated_by: currentUser?.id || "unknown",
          activity_log: [...(old?.activity_log || []), historyItem]
        });
        setSaveStatus("✅ Entry Updated!");
        toast({ title: "Updated", message: "Entry has been updated successfully.", type: "success" });
      } else {
        const historyItem = {
          time: new Date().toISOString(),
          user: currentUser?.name || "User",
          action: "Create",
          notes: "Initial record created"
        };
        await addDoc(collection(db, "entries"), { ...payload, activity_log: [historyItem] });
        setSaveStatus("✅ Saved to Firebase!");
        toast({ title: "Saved", message: "Entry saved successfully.", type: "success" });
      }

      // Clear form
      setSelBranch(""); setOnlineInc(""); setMatExp(""); setOtherExp(""); setPetrol(""); setActualCash("");
      setStaffRows({});
      setLoanStaffIds(new Set());
      setSharedServices([]);
      setEditId(null);
      setGstPct(globalGst);
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

  const inp = { padding: "8px 10px", border: "2px solid var(--input-border)", borderRadius: 8, fontSize: 14, background: "var(--bg3)", color: "var(--text)", fontFamily: "var(--font-outfit)", width: 90, textAlign: "right", transition: "border .2s", outline: "none" };

  if (loading) return <VLoader fullscreen label="Loading" />;

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>Data Entry</div>
      </div>

      <PeriodWidget filterMode={filterMode} setFilterMode={setFilterMode} filterYear={filterYear} setFilterYear={setFilterYear} filterMonth={filterMonth} setFilterMonth={setFilterMonth} />

      {/* Entry Form */}
      <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: "inset 0 2px 10px rgba(0,0,0,.2)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, paddingBottom: 10, borderBottom: "1px solid var(--border)", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--gold)", textTransform: "uppercase", letterSpacing: 1 }}>Daily Sales Entry</div>
          {canEdit && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button type="button" onClick={() => setTemplatePicker(true)} title="Download upload template"
                style={{ padding: "6px 14px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: "var(--orange)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                <Icon name="save" size={13} /> Template
              </button>
              <label title="Upload entries from CSV/Excel" style={{ padding: "6px 14px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                <Icon name="plus" size={13} /> Upload
                <input type="file" accept=".csv,.xls,.xlsx" onChange={handleUpload} style={{ display: "none" }} />
              </label>
            </div>
          )}
        </div>

        <form onSubmit={handleSave}>
          {/* Branch + Date */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: 12, marginBottom: 16 }}>
            <FG label="Branch">
              <select value={selBranch} onChange={e => { setSelBranch(e.target.value); setStaffRows({}); setLoanStaffIds(new Set()); setSharedServices([]); setOnlineInc(""); setMatExp(""); setOtherExp(""); setPetrol(""); setEditId(null); if(!editId) setGstPct(globalGst); }}>
                <option value="">Select branch...</option>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </FG>
            <FG label="Date">
              <input type="date" value={selDate} onChange={e => { setSelDate(e.target.value); setEditId(null); if(!editId) setGstPct(globalGst); }} />
            </FG>
            <FG label="Global GST (%)">
              <div style={{ padding: "12px 16px", borderRadius: 10, border: "2px solid var(--border)", background: "var(--bg3)", color: "var(--red)", fontWeight: 700, fontSize: 14, fontFamily: "var(--font-outfit)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>{gstPct}%</span>
                <span style={{ fontSize: 10, color: "var(--text3)", fontWeight: 400, textTransform: "uppercase" }}>{editId ? "Historical" : "Master Sync"}</span>
              </div>
            </FG>
          </div>

          {selBranch && (
            <>
              {/* Income */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: 12, marginBottom: 16 }}>
                <FG label="Online Income (₹)" income>
                  <input type="number" placeholder="0" min="0" value={onlineInc} onChange={e => setOnlineInc(e.target.value)} title="Enter online portion — Cash auto-fills the remainder" />
                </FG>
                <FG label={`TOTAL GST @ ${gstPct}%`} expense>
                  <input type="number" readOnly value={totalRowGst} style={{ background: "transparent", color: "var(--red)", cursor: "not-allowed", fontWeight: 700 }} title="Calculated on Online Income" />
                </FG>
                <FG label="Cash Income (₹)" income>
                  <input type="number" readOnly value={totalCash} style={{ background: "transparent", color: "var(--green)", cursor: "not-allowed", fontWeight: 700 }} title="Auto-calculated: Total Sale − Online" />
                </FG>
                <FG label="Material Expense (₹)" expense><input type="number" placeholder="0" min="0" value={matExp} onChange={e => setMatExp(e.target.value)} /></FG>
              </div>

              {/* Staff Billing Table */}
              <div style={{ height: 1, background: "linear-gradient(90deg,transparent,var(--border2),transparent)", margin: "16px 0" }} />
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 12, color: "var(--gold)", textTransform: "uppercase", letterSpacing: 1 }}>Staff Billing & Incentives</div>

              {(() => {
                const discrepancies = branchStaff
                  .map(s => {
                    const logged = serviceLogsByStaff[s.id];
                    if (!logged || logged.count === 0) return null;
                    const r = staffRows[s.id] || {};
                    const bDiff = (Number(r.billing) || 0) - logged.billing;
                    const tDiff = (Number(r.tips) || 0) - logged.tips;
                    const mDiff = (Number(r.material) || 0) - logged.material;
                    if (bDiff === 0 && tDiff === 0 && mDiff === 0) return null;
                    return { staff: s, logged, bDiff, tDiff, mDiff };
                  })
                  .filter(Boolean);
                if (discrepancies.length === 0) return null;
                return (
                  <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 10, background: "rgba(255,180,0,0.08)", border: "1px solid rgba(255,180,0,0.3)", fontSize: 12, color: "var(--text2)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <Icon name="alert" size={14} color="var(--gold)" />
                      <strong style={{ color: "var(--gold)" }}>Staff log discrepancy — {discrepancies.length} mismatch{discrepancies.length === 1 ? "" : "es"}</strong>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }}>
                      {discrepancies.map(d => (
                        <div key={d.staff.id}>
                          <strong>{d.staff.name}</strong> logged{" "}
                          {INR(d.logged.billing)} billing / {INR(d.logged.tips)} tips / {INR(d.logged.material)} material ({d.logged.count} svc)
                          {d.bDiff !== 0 && <span style={{ color: "var(--red)" }}> · Billing Δ {INR(d.bDiff)}</span>}
                          {d.tDiff !== 0 && <span style={{ color: "var(--red)" }}> · Tips Δ {INR(d.tDiff)}</span>}
                          {d.mDiff !== 0 && <span style={{ color: "var(--red)" }}> · Material Δ {INR(d.mDiff)}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {(tableStaff.length > 0 || canEdit) && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 2 }}>
                    Staff Billing &amp; Incentives
                    {loanStaffList.length > 0 && (
                      <span style={{ marginLeft: 10, padding: "2px 8px", borderRadius: 6, background: "rgba(251,146,60,0.12)", border: "1px solid rgba(251,146,60,0.35)", color: "var(--orange)", fontSize: 10, letterSpacing: 1 }}>
                        {loanStaffList.length} LOAN
                      </span>
                    )}
                  </div>
                  {canEdit && selBranch && (
                    <button type="button" onClick={() => { setLoanPickerOpen(true); setLoanSearch(""); }}
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 10, border: "1px solid var(--orange)", background: "rgba(251,146,60,0.08)", color: "var(--orange)", fontSize: 11, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", cursor: "pointer" }}>
                      <Icon name="plus" size={12} /> Loan Resource
                    </button>
                  )}
                </div>
              )}
              {tableStaff.length > 0 ? (
                <div style={{ overflowX: "auto", marginBottom: 16 }}>
                  <table style={{ width: "100%", minWidth: 1100, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ background: "var(--bg4)" }}>
                        {["Present", "Staff", "Billing (₹)", "Shared Sale", "Net Billing", "Mat Sale", "Mat Inc (5%auto)", "Incentive", "Shared Inc", "Tips (₹)", "Tip In/Out", "Staff Total Inc", "Staff Total"].map((h, i) => (
                          <th key={i} style={{ textAlign: i === 0 || i === 1 ? "left" : "right", padding: "10px 14px", fontSize: 11, fontWeight: 700, color: "var(--text2)", textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid var(--gold)", whiteSpace: "nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tableStaff.map(s => {
                        const isLoan = loanStaffIds.has(s.id);
                        const loanHome = isLoan ? (branchesById.get(homeBranchOf(s))?.name || "").replace("V-CUT ", "") : "";
                        const r = staffRows[s.id] || {};
                        const isPresent = r.present !== false; // default true
                        const incPct = (s.incentive_pct ?? 10) / 100;
                        const matInc = Math.round((r.material || 0) * 0.05);
                        const inc = Math.round(r.incentive !== undefined ? Number(r.incentive) || 0 : (r.billing || 0) * incPct);
                        const shBilling = sharedContributions.billing[s.id] || 0;
                        const shIncentive = sharedContributions.incentive[s.id] || 0;
                        const staffTInc = Math.round(inc + matInc + (Number(r.tips) || 0) + shIncentive);
                        const total = Math.round((Number(r.billing) || 0) + shBilling + (Number(r.material) || 0) + (Number(r.tips) || 0));
                        const tipIn = r.tip_in || "online";
                        const tipPaid = r.tip_paid || "cash";
                        const disabledStyle = !isPresent ? { opacity: 0.4, pointerEvents: "none" } : {};
                        return (
                          <tr key={s.id} style={{ borderBottom: "1px solid var(--border)", transition: "background .15s", background: !isPresent ? "rgba(248,113,113,0.05)" : isLoan ? "rgba(251,146,60,0.04)" : undefined }}>
                            <td style={{ padding: "10px 14px", textAlign: "center" }}>
                              <input type="checkbox" checked={isPresent} onChange={e => handleAttendanceToggle(s, e.target.checked)} title={isPresent ? "Present (uncheck to record leave)" : "On leave"} style={{ width: 18, height: 18, accentColor: isPresent ? "var(--green)" : "var(--red)", cursor: "pointer" }} />
                            </td>
                            <td style={{ padding: "10px 14px", fontWeight: 600, fontSize: 13 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                <span>{s.name}</span>
                                {isLoan && (
                                  <span title={`Loaned from ${loanHome}`} style={{ padding: "1px 6px", borderRadius: 6, background: "rgba(251,146,60,0.15)", border: "1px solid rgba(251,146,60,0.4)", color: "var(--orange)", fontSize: 9, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase" }}>LOAN</span>
                                )}
                                {isLoan && canEdit && (
                                  <button type="button" onClick={() => removeLoanStaff(s.id)} title="Remove loan resource"
                                    style={{ background: "transparent", border: "none", color: "var(--text3)", cursor: "pointer", padding: 0, fontSize: 12, fontWeight: 800 }}>✕</button>
                                )}
                              </div>
                              <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 400, marginTop: 2 }}>
                                {!isPresent ? <span style={{ color: "var(--red)", fontWeight: 700 }}>ON LEAVE ({r.leave_type || "Paid"}){r.leave_reason ? ` — ${r.leave_reason}` : ""}</span> : isLoan ? <span style={{ color: "var(--orange)" }}>Home: {loanHome}</span> : (s.role || "")}
                              </div>
                            </td>
                            <td style={{ padding: "6px 14px", textAlign: "right", ...disabledStyle }}>
                              <input type="number" placeholder="0" min="0" disabled={!isPresent} value={r.billing || ""} onChange={e => updateStaffRow(s.id, "billing", e.target.value)} style={{ ...inp, borderColor: "var(--green)" }} onFocus={e => e.target.style.borderColor = "var(--gold)"} onBlur={e => e.target.style.borderColor = "var(--green)"} />
                            </td>
                            <td style={{ padding: "6px 14px", textAlign: "right", fontWeight: 700, color: shBilling > 0 ? "var(--blue, #60a5fa)" : "var(--text3)", fontSize: 12 }}>
                              {shBilling > 0 ? INR(shBilling) : "—"}
                            </td>
                            <td style={{ padding: "6px 14px", textAlign: "right", fontWeight: 800, color: "var(--accent)", fontSize: 13 }}>
                              {INR((Number(r.billing) || 0) + shBilling)}
                            </td>
                            <td style={{ padding: "6px 14px", textAlign: "right", ...disabledStyle }}>
                              <input type="number" placeholder="0" min="0" disabled={!isPresent} value={r.material || ""} onChange={e => updateStaffRow(s.id, "material", e.target.value)} style={{ ...inp, borderColor: "var(--green)", color: "var(--green)", fontWeight: 600 }} onFocus={e => e.target.style.borderColor = "var(--gold)"} onBlur={e => e.target.style.borderColor = "var(--green)"} />
                            </td>
                            <td style={{ padding: "6px 14px", textAlign: "right" }}>
                              <input type="text" readOnly value={INR(matInc)} title="Auto-calculated (5%)" style={{ ...inp, borderColor: "var(--red)", background: "rgba(255,255,255,0.03)", color: "var(--red)", cursor: "not-allowed", fontWeight: 700 }} />
                            </td>
                            <td style={{ padding: "6px 14px", textAlign: "right" }}>
                              <input type="text" readOnly value={INR(inc)} title="Auto-calculated (Incentive %)" style={{ ...inp, borderColor: "var(--red)", background: "rgba(255,255,255,0.03)", color: "var(--red)", cursor: "not-allowed", fontWeight: 700 }} />
                            </td>
                            <td style={{ padding: "6px 14px", textAlign: "right", fontWeight: 700, color: shIncentive > 0 ? "var(--blue, #60a5fa)" : "var(--text3)", fontSize: 12 }}>
                              {shIncentive > 0 ? INR(shIncentive) : "—"}
                            </td>
                            <td style={{ padding: "6px 14px", textAlign: "right", ...disabledStyle }}>
                              <input type="number" placeholder="0" min="0" disabled={!isPresent} value={r.tips || ""} onChange={e => updateStaffRow(s.id, "tips", e.target.value)} style={{ ...inp, borderColor: "var(--red)", color: "var(--red)", fontWeight: 600 }} onFocus={e => e.target.style.borderColor = "var(--gold)"} onBlur={e => e.target.style.borderColor = "var(--red)"} />
                            </td>
                            <td style={{ padding: "6px 14px", textAlign: "right", ...disabledStyle }}>
                              <div style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 11 }}>
                                <select disabled={!isPresent} value={tipIn} onChange={e => updateStaffRow(s.id, "tip_in", e.target.value)} title="Tip received as" style={{ padding: "4px 6px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text2)", fontSize: 11 }}>
                                  <option value="online">In: Online</option>
                                  <option value="cash">In: Cash</option>
                                </select>
                                <span style={{ color: "var(--text3)" }}>→</span>
                                <select disabled={!isPresent} value={tipPaid} onChange={e => updateStaffRow(s.id, "tip_paid", e.target.value)} title="Tip paid to staff as" style={{ padding: "4px 6px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text2)", fontSize: 11 }}>
                                  <option value="cash">Out: Cash</option>
                                  <option value="online">Out: Online</option>
                                </select>
                              </div>
                            </td>
                            <td style={{ padding: "6px 14px", textAlign: "right", fontWeight: 700, color: "var(--gold)" }}>{INR(staffTInc)}</td>
                            <td style={{ padding: "6px 14px", textAlign: "right", fontWeight: 700, color: "var(--text2)" }}>{INR(total)}</td>
                          </tr>
                        );
                      })}
                      {/* Totals row */}
                      <tr style={{ background: "var(--bg3)", fontWeight: 700, color: "var(--gold)", borderTop: "2px solid var(--border2)" }}>
                        <td style={{ padding: "10px 14px" }}></td>
                        <td style={{ padding: "10px 14px" }}>TOTALS</td>
                        <td style={{ padding: "10px 14px", textAlign: "right", color: "var(--green)" }}>{INR(totalBilling - sharedContributions.totalBilling)}</td>
                        <td style={{ padding: "10px 14px", textAlign: "right", color: "var(--blue, #60a5fa)" }}>{sharedContributions.totalBilling > 0 ? INR(sharedContributions.totalBilling) : "—"}</td>
                        <td style={{ padding: "10px 14px", textAlign: "right", color: "var(--accent)", fontWeight: 800 }}>{INR(totalBilling)}</td>
                        <td style={{ padding: "10px 14px", textAlign: "right", color: "var(--green)" }}>{INR(totalMatSale)}</td>
                        <td style={{ padding: "10px 14px", textAlign: "right", color: "var(--text3)" }}></td>
                        <td style={{ padding: "10px 14px", textAlign: "right", color: "var(--red)" }}>{INR(totalIncentive - totalTips - sharedContributions.totalIncentive)}</td>
                        <td style={{ padding: "10px 14px", textAlign: "right", color: "var(--blue, #60a5fa)" }}>{sharedContributions.totalIncentive > 0 ? INR(sharedContributions.totalIncentive) : "—"}</td>
                        <td style={{ padding: "10px 14px", textAlign: "right", color: "var(--red)" }}>{INR(totalTips)}</td>
                        <td style={{ padding: "10px 14px", textAlign: "right", color: "var(--text3)", fontSize: 10 }}>cash↑ {INR(tipsInCash)} • cash↓ {INR(tipsPaidCash)}</td>
                        <td style={{ padding: "10px 14px", textAlign: "right", color: "var(--gold)" }}>{INR(totalStaffIncCombined)}</td>
                        <td style={{ padding: "10px 14px", textAlign: "right" }}>{INR(totalBilling + totalMatSale + totalTips)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : <div style={{ color: "var(--text3)", fontSize: 13, marginBottom: 16 }}>No active staff in this branch for the selected date.</div>}

              {/* ── Shared Services (multi-staff billing split) ── */}
              {canEdit && selBranch && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 2 }}>
                      Shared Services
                      {sharedServices.length > 0 && (
                        <span style={{ marginLeft: 10, padding: "2px 8px", borderRadius: 6, background: "rgba(96,165,250,0.12)", border: "1px solid rgba(96,165,250,0.35)", color: "var(--blue, #60a5fa)", fontSize: 10, letterSpacing: 1 }}>
                          {sharedServices.length}
                        </span>
                      )}
                    </div>
                    <button type="button" onClick={() => setSharedForm({ service_name: "", amount: "", sale_staff_id: "", incentive_staff_ids: [] })}
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 10, border: "1px solid var(--blue, #60a5fa)", background: "rgba(96,165,250,0.08)", color: "var(--blue, #60a5fa)", fontSize: 11, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", cursor: "pointer" }}>
                      <Icon name="plus" size={12} /> Add Shared Service
                    </button>
                  </div>

                  {sharedServices.length > 0 && (
                    <div style={{ overflowX: "auto", marginBottom: 12 }}>
                      <table style={{ width: "100%", minWidth: 700, borderCollapse: "collapse", fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: "var(--bg4)" }}>
                            {["Sale Amount", "Sale To", "Incentive To", "Incentive Breakdown", ""].map((h, i) => (
                              <th key={i} style={{ textAlign: i === 0 || i === 3 ? "right" : "left", padding: "8px 12px", fontSize: 10, fontWeight: 700, color: "var(--text2)", textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid var(--blue, #60a5fa)", whiteSpace: "nowrap" }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {sharedServices.map((ss, idx) => {
                            const saleStaff = staff.find(x => x.id === ss.sale_staff_id);
                            const incBreakdown = (ss.incentive_staff_ids || []).map(sid => {
                              const s = staff.find(x => x.id === sid);
                              const b = branchesById.get(selBranch);
                              let rate = 10;
                              if (globalSettings) rate = b?.type === 'unisex' ? (globalSettings.unisex_inc ?? 10) : (globalSettings.mens_inc ?? 10);
                              else if (s?.incentive_pct !== undefined) rate = s.incentive_pct;
                              const inc = Math.round((Number(ss.amount) || 0) * rate / 100);
                              return { name: s?.name || "?", rate, inc };
                            });
                            const totalInc = incBreakdown.reduce((s, x) => s + x.inc, 0);
                            return (
                              <tr key={ss.id || idx} style={{ borderBottom: "1px solid var(--border)" }}>
                                <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 700, color: "var(--accent)", fontSize: 14 }}>{INR(Number(ss.amount) || 0)}</td>
                                <td style={{ padding: "8px 12px" }}>
                                  <span style={{ padding: "2px 8px", borderRadius: 6, background: "rgba(74,222,128,0.12)", border: "1px solid rgba(74,222,128,0.3)", color: "var(--green)", fontSize: 10, fontWeight: 700 }}>
                                    {saleStaff?.name || "—"}
                                  </span>
                                </td>
                                <td style={{ padding: "8px 12px" }}>
                                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                                    {incBreakdown.map((ib, i) => (
                                      <span key={i} style={{ padding: "2px 8px", borderRadius: 6, background: "rgba(96,165,250,0.12)", border: "1px solid rgba(96,165,250,0.3)", color: "var(--blue, #60a5fa)", fontSize: 10, fontWeight: 700 }}>
                                        {ib.name} ({ib.rate}%)
                                      </span>
                                    ))}
                                  </div>
                                </td>
                                <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 700, color: "var(--gold)" }}>
                                  {incBreakdown.map(ib => INR(ib.inc)).join(" + ")} = {INR(totalInc)}
                                </td>
                                <td style={{ padding: "8px 12px", textAlign: "center" }}>
                                  <button type="button" onClick={() => setSharedServices(prev => prev.filter((_, i) => i !== idx))}
                                    style={{ background: "transparent", border: "none", color: "var(--red)", cursor: "pointer", fontSize: 14, fontWeight: 800 }}>✕</button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Add/Edit Shared Service Form */}
                  {sharedForm && (
                    <div style={{ padding: 16, borderRadius: 12, background: "var(--bg3)", border: "1px solid var(--border2)", marginBottom: 12 }}>
                      <div style={{ fontSize: 13, fontWeight: 800, color: "var(--text)", marginBottom: 12 }}>Add Shared Service</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, marginBottom: 12 }}>
                        <div>
                          <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Sale Amount (₹)</label>
                          <input type="number" placeholder="0" min="0" value={sharedForm.amount} onChange={e => setSharedForm(f => ({ ...f, amount: e.target.value }))} autoFocus
                            style={{ width: "100%", padding: "10px 14px", borderRadius: 8, background: "var(--bg4)", border: "2px solid var(--accent)", color: "var(--accent)", fontSize: 16, fontWeight: 800, outline: "none", marginTop: 4 }} />
                        </div>
                        <div>
                          <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Sale Tagged To (billing credit)</label>
                          <select value={sharedForm.sale_staff_id} onChange={e => setSharedForm(f => ({ ...f, sale_staff_id: e.target.value }))}
                            style={{ width: "100%", padding: "10px 14px", borderRadius: 8, background: "var(--bg4)", border: "2px solid var(--green)", color: "var(--text)", fontSize: 13, fontWeight: 600, outline: "none", marginTop: 4 }}>
                            <option value="">Select staff…</option>
                            {tableStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </select>
                        </div>
                      </div>
                      <div style={{ marginBottom: 12 }}>
                        <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Incentive Applicable To (select staff who get incentive)</label>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
                          {tableStaff.map(s => {
                            const checked = (sharedForm.incentive_staff_ids || []).includes(s.id);
                            return (
                              <label key={s.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8, background: checked ? "rgba(96,165,250,0.15)" : "var(--bg4)", border: `1px solid ${checked ? "rgba(96,165,250,0.5)" : "var(--border2)"}`, cursor: "pointer", fontSize: 12, fontWeight: 600, color: checked ? "var(--blue, #60a5fa)" : "var(--text3)", transition: "all 0.15s" }}>
                                <input type="checkbox" checked={checked} onChange={e => {
                                  setSharedForm(f => ({
                                    ...f,
                                    incentive_staff_ids: e.target.checked
                                      ? [...(f.incentive_staff_ids || []), s.id]
                                      : (f.incentive_staff_ids || []).filter(id => id !== s.id)
                                  }));
                                }} style={{ accentColor: "var(--blue, #60a5fa)" }} />
                                {s.name}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                        <button type="button" onClick={() => setSharedForm(null)}
                          style={{ padding: "8px 16px", borderRadius: 8, background: "var(--bg4)", color: "var(--text3)", border: "1px solid var(--border2)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
                        <button type="button" onClick={() => {
                          if (!sharedForm.amount || !sharedForm.sale_staff_id || (sharedForm.incentive_staff_ids || []).length === 0) {
                            toast({ title: "Incomplete", message: "Enter amount, select sale staff, and check at least one incentive staff.", type: "warning" });
                            return;
                          }
                          setSharedServices(prev => [...prev, { ...sharedForm, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }]);
                          setSharedForm(null);
                        }}
                          style={{ padding: "8px 18px", borderRadius: 8, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontSize: 12, fontWeight: 800, cursor: "pointer" }}>
                          Add Service
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Expenses */}
              <div style={{ height: 1, background: "linear-gradient(90deg,transparent,var(--border2),transparent)", margin: "16px 0" }} />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: 12, marginBottom: 16 }}>
                <FG label="Other Expenses (₹)" expense><input type="number" placeholder="0" min="0" value={otherExp} onChange={e => setOtherExp(e.target.value)} /></FG>
                <FG label="Petrol / Travel (₹)" expense><input type="number" placeholder="0" min="0" value={petrol} onChange={e => setPetrol(e.target.value)} /></FG>
                <FG label="Cash in Hand (Expected)">
                  <div style={{ padding: "12px 16px", borderRadius: 10, border: `2px solid ${cashInHand >= 0 ? "var(--green)" : "var(--red)"}`, background: "var(--bg3)", fontSize: 18, fontWeight: 700, color: cashInHand >= 0 ? "var(--green)" : "var(--red)" }}>{INR(cashInHand)}</div>
                </FG>
                <FG label="Actual Cash Counted (₹)">
                  <input type="number" placeholder="leave blank to skip" min="0" step="1" value={actualCash}
                    onChange={e => {
                      const v = e.target.value;
                      if (v === "") { setActualCash(""); return; }
                      const n = Number(v);
                      if (Number.isNaN(n) || n < 0) return;   // reject negatives outright
                      setActualCash(String(Math.max(0, n)));
                    }}
                    onKeyDown={e => { if (e.key === "-" || e.key === "e") e.preventDefault(); }}
                    style={cashDiff === null ? undefined : {
                      borderColor: cashDiff === 0 ? "var(--green)" : cashDiff > 0 ? "var(--green)" : "var(--red)",
                      color: cashDiff === 0 ? "var(--green)" : cashDiff > 0 ? "var(--green)" : "var(--red)",
                      fontWeight: 700,
                    }} />
                </FG>
              </div>

              {/* Reconciliation banner */}
              {actualCashNum !== null && (
                <div style={{
                  padding: "10px 16px", borderRadius: 10, marginBottom: 16,
                  border: `2px solid ${cashDiff === 0 ? "var(--green)" : cashDiff < 0 ? "var(--red)" : "var(--orange, #fb923c)"}`,
                  background: cashDiff === 0 ? "rgba(74,222,128,0.08)" : cashDiff < 0 ? "rgba(248,113,113,0.08)" : "rgba(251,146,60,0.08)",
                  display: "flex", alignItems: "center", gap: 12, fontWeight: 700,
                }}>
                  <span style={{ fontSize: 18 }}>
                    {cashDiff === 0 ? "✓" : cashDiff < 0 ? "▼" : "▲"}
                  </span>
                  <span style={{ color: cashDiff === 0 ? "var(--green)" : cashDiff < 0 ? "var(--red)" : "var(--orange, #fb923c)" }}>
                    {cashDiff === 0
                      ? `MATCH — actual cash equals expected (${INR(cashInHand)})`
                      : cashDiff < 0
                        ? `DEFICIT — short by ${INR(Math.abs(cashDiff))} (expected ${INR(cashInHand)}, counted ${INR(actualCashNum)})`
                        : `EXCESS — over by ${INR(cashDiff)} (expected ${INR(cashInHand)}, counted ${INR(actualCashNum)})`}
                  </span>
                </div>
              )}

              {/* Attendance hint — present staff with no work and no leave on file */}
              {zeroWorkPresent.length > 0 && (
                <div style={{ marginTop: 14, padding: "10px 14px", borderRadius: 10, background: "rgba(251,146,60,0.08)", border: "1px solid rgba(251,146,60,0.35)", fontSize: 12, color: "var(--orange)" }}>
                  <strong>⚠ {zeroWorkPresent.length} present staff with no work logged:</strong>{" "}
                  {zeroWorkPresent.map(s => s.name).join(", ")}.
                  <span style={{ color: "var(--text3)", fontWeight: 500 }}> If absent, uncheck Present to file leave; otherwise save as-is.</span>
                </div>
              )}

              {/* Save / Clear */}
              <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 16 }}>
                <button type="submit" disabled={saving}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 24px", borderRadius: 10, fontSize: 14, fontWeight: 800, background: "linear-gradient(135deg,var(--gold),var(--gold2))", color: "#000", border: "none", cursor: "pointer", letterSpacing: 1, boxShadow: "0 4px 15px rgba(var(--gold-rgb),0.3)", opacity: saving ? 0.6 : 1 }}>
                  <Icon name="save" size={16} />
                  {saving ? "Saving..." : editId ? "Update Entry" : "Save to Database"}
                </button>
                <button type="button" onClick={() => { setSelBranch(""); setOnlineInc(""); setMatExp(""); setOtherExp(""); setPetrol(""); setStaffRows({}); setLoanStaffIds(new Set()); setSharedServices([]); setSaveStatus(""); setEditId(null); }}
                  style={{ padding: "10px 18px", borderRadius: 10, fontSize: 13, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", cursor: "pointer", fontWeight: 600 }}>
                  {editId ? "Cancel Edit" : "Clear"}
                </button>
                {saveStatus && <span style={{ fontSize: 13, color: saveStatus.startsWith("✅") ? "var(--green)" : "var(--red)" }}>{saveStatus}</span>}
              </div>
            </>
          )}
        </form>
      </div>

      {/* Recent Entries Table */}
      <div style={{ margin: "20px 0 12px", display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>
            Recent Entries — {visibleEntries.length} records
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {/* View toggles */}
            <div style={{ display: "flex", gap: 3, background: "var(--bg4)", padding: 3, borderRadius: 10 }}>
              {[
                ["branch", selBranch ? (branchesById.get(selBranch)?.name?.replace("V-CUT ","") || "Branch") : "Branch"],
                ["date", "Date"],
                ["range", "Range"],
                ["all", "All"]
              ].map(([val, label]) => (
                <button key={val} onClick={() => { setRecentView(val); if (val === "date" && !recentDate) setRecentDate(selDate); if (val === "range" && !rangeFrom) { setRangeFrom(selDate); setRangeTo(selDate); } }}
                  style={{ padding: "5px 12px", borderRadius: 7, fontSize: 10, fontWeight: 700, border: "none", cursor: "pointer", transition: "all .2s", textTransform: "uppercase", letterSpacing: 0.5, background: recentView === val ? "linear-gradient(135deg, var(--accent), var(--gold2))" : "transparent", color: recentView === val ? "#000" : "var(--text3)" }}>
                  {label}
                </button>
              ))}
            </div>
            {/* Export */}
            {canEdit && (
              <button onClick={exportToExcel} title="Export to CSV"
                style={{ padding: "5px 10px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border)", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 700, color: "var(--green)", textTransform: "uppercase" }}>
                <Icon name="save" size={12} /> Export
              </button>
            )}
          </div>
        </div>
        {/* Date / Range pickers */}
        {recentView === "date" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>Date:</span>
            <input type="date" value={activeRecentDate} onChange={e => setRecentDate(e.target.value)}
              style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg4)", color: "var(--text)", fontSize: 12, fontWeight: 600 }} />
          </div>
        )}
        {recentView === "range" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>From:</span>
            <input type="date" value={rangeFrom} onChange={e => setRangeFrom(e.target.value)}
              style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg4)", color: "var(--text)", fontSize: 12, fontWeight: 600 }} />
            <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>To:</span>
            <input type="date" value={rangeTo} onChange={e => setRangeTo(e.target.value)}
              style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg4)", color: "var(--text)", fontSize: 12, fontWeight: 600 }} />
          </div>
        )}
      </div>
      <Card>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5 }}>
          <thead>
            <tr>
              <TH>Date</TH><TH>Branch</TH>
              <TH right>Online</TH><TH right>Cash</TH>
              <TH right>GST</TH>
              <TH right>Mat Sale</TH><TH right>Total Billing</TH><TH right>Incentive</TH>
              <TH right>Tips</TH>
              <TH right>Staff T.Inc</TH><TH right>Staff T.Sale</TH>
              <TH right>Other Out</TH>
              <TH right>Cash in Hand</TH>
              <TH right>Def / Exc</TH>
              <TH right sticky style={{ minWidth: 130 }}>Actions</TH>
            </tr>
          </thead>
          <tbody>
            {visibleEntries.slice(0, 30).map(e => {
              const b = branchesById.get(e.branch_id);
              const agg = sumStaffBilling(e.staff_billing);
              const totalBillingE = agg.billing;
              const totalMatE = agg.material;
              const totalIncE = agg.incentive;
              const totalTipsE = agg.tips;
              const staffTotalIncE = agg.staffTotalInc;
              const staffTotalSaleE = totalBillingE + totalMatE + totalTipsE;
              const totalOthE = (e.others || 0) + (e.petrol || 0);
              const cih = e.cash_in_hand !== undefined ? e.cash_in_hand : (e.cash || 0) - totalIncE - totalTipsE - (e.others || 0);
              return (
                <tr key={e.id}>
                  <TD style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{e.date}</TD>
                  <TD style={{ fontWeight: 500, fontSize: 12 }}>{b ? b.name.replace("V-CUT ", "") : "?"}</TD>
                  <TD right style={{ color: "var(--green)" }}>{INR(e.online || 0)}</TD>
                  <TD right style={{ color: "var(--green)" }}>{INR(e.cash || 0)}</TD>
                  <TD right style={{ color: "var(--red)" }}>{INR(e.total_gst || 0)}</TD>
                  <TD right style={{ color: "var(--green)" }}>{INR(totalMatE)}</TD>
                  <TD right style={{ fontWeight: 600, color: "var(--green)" }}>{INR(totalBillingE)}</TD>
                  <TD right style={{ color: "var(--red)" }}>{INR(totalIncE)}</TD>
                  <TD right style={{ color: "var(--red)" }}>{INR(totalTipsE)}</TD>
                  <TD right style={{ color: "var(--gold)", fontWeight: 700 }}>{INR(staffTotalIncE)}</TD>
                  <TD right style={{ color: "var(--text2)", fontWeight: 700 }}>{INR(staffTotalSaleE)}</TD>
                  <TD right style={{ color: "var(--red)" }}>{INR(totalOthE)}</TD>
                  <TD right style={{ fontWeight: 700, color: cih >= 0 ? "var(--green)" : "var(--red)" }}>{INR(cih)}</TD>
                  <TD right style={{ fontWeight: 700, color: e.cash_diff == null ? "var(--text3)" : e.cash_diff === 0 ? "var(--green)" : e.cash_diff > 0 ? "var(--green)" : "var(--red)", whiteSpace: "nowrap" }}
                    title={e.cash_diff == null ? "Actual cash not recorded" : e.cash_diff === 0 ? "Match" : e.cash_diff > 0 ? `Excess ${INR(e.cash_diff)}` : `Deficit ${INR(Math.abs(e.cash_diff))}`}>
                    {e.cash_diff == null ? "—" : e.cash_diff === 0 ? "✓ Match" : e.cash_diff > 0 ? `▲ ${INR(e.cash_diff)}` : `▼ ${INR(Math.abs(e.cash_diff))}`}
                  </TD>
                  <TD right sticky style={{ minWidth: 130 }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end", flexWrap: "nowrap" }}>
                      <IconBtn name="log" title="View log" variant="secondary" onClick={() => setLogView(e)} />
                      <IconBtn name="edit" title="Edit entry" variant="secondary" onClick={() => handleEdit(e)} />
                      {canDelete && <IconBtn name="del" title="Delete entry" variant="danger" onClick={() => handleDelete(e.id)} />}
                    </div>
                  </TD>
                </tr>
              );
            })}
            {filteredEntries.length === 0 && (
              <tr><td colSpan={15} style={{ textAlign: "center", padding: 24, color: "var(--text3)" }}>No entries for this period</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* Audit Log Modal */}
      {logView && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: "rgba(15,15,20,0.95)", border: "1px solid rgba(255,215,0,0.2)", borderRadius: 24, padding: 32, width: "100%", maxWidth: 420, boxShadow: "0 25px 50px -12px rgba(0,0,0,0.5)", position: "relative" }}>
            <button onClick={() => setLogView(null)} style={{ position: "absolute", top: 20, right: 20, background: "rgba(255,255,255,0.05)", border: "none", color: "var(--text3)", borderRadius: "50%", width: 32, height: 32, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all .2s" }}>✕</button>
            <div style={{ fontSize: 20, fontWeight: 800, color: "var(--gold)", marginBottom: 24, letterSpacing: 0.5 }}>Activity Timeline</div>
            <div style={{ maxHeight: 400, overflowY: "auto", paddingRight: 10, display: "flex", flexDirection: "column", gap: 0 }}>
              {(logView.activity_log || []).slice().reverse().map((log, idx) => (
                <div key={idx} style={{ display: "flex", gap: 16, position: "relative", paddingBottom: 24 }}>
                  {/* Timeline dot and line */}
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
              {(!logView.activity_log || logView.activity_log.length === 0) && (
                <div style={{ color: "var(--text3)", fontSize: 14, textAlign: "center", padding: 40, border: "2px dashed rgba(255,255,255,0.05)", borderRadius: 16 }}>No history records found.</div>
              )}
            </div>
            <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text3)" }}>
              <span>REF: {logView.id.slice(0, 8)}</span>
              <span style={{ color: "var(--red)", fontWeight: 700 }}>GST {logView.global_gst_pct || 0}%</span>
            </div>
          </div>
        </div>
      )}
      {/* Upload Preview Modal */}
      <Modal isOpen={!!uploadPreview} onClose={() => setUploadPreview(null)} title="Upload Preview" width={700}>
        {uploadPreview && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Summary */}
            <div style={{ display: "flex", gap: 12 }}>
              <div style={{ flex: 1, padding: 12, borderRadius: 10, background: "rgba(74,222,128,0.08)", border: "1px solid rgba(74,222,128,0.2)", textAlign: "center" }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: "var(--green)" }}>{uploadPreview.validCount}</div>
                <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase" }}>Valid</div>
              </div>
              <div style={{ flex: 1, padding: 12, borderRadius: 10, background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)", textAlign: "center" }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: "var(--red)" }}>{uploadPreview.errorCount}</div>
                <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase" }}>Errors</div>
              </div>
              <div style={{ flex: 1, padding: 12, borderRadius: 10, background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.2)", textAlign: "center" }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: "var(--accent)" }}>{uploadPreview.rows.length}</div>
                <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase" }}>Total Rows</div>
              </div>
            </div>

            {/* Preview Table */}
            <div style={{ maxHeight: 350, overflowY: "auto", borderRadius: 10, border: "1px solid var(--border)" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr style={{ background: "var(--bg4)", position: "sticky", top: 0 }}>
                    <th style={{ padding: "8px 10px", textAlign: "left", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase" }}>#</th>
                    <th style={{ padding: "8px 10px", textAlign: "left", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase" }}>Status</th>
                    <th style={{ padding: "8px 10px", textAlign: "left", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase" }}>Date</th>
                    <th style={{ padding: "8px 10px", textAlign: "left", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase" }}>Branch</th>
                    <th style={{ padding: "8px 10px", textAlign: "right", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase" }}>Online</th>
                    <th style={{ padding: "8px 10px", textAlign: "right", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase" }}>Cash</th>
                    <th style={{ padding: "8px 10px", textAlign: "right", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase" }}>Billing</th>
                    <th style={{ padding: "8px 10px", textAlign: "left", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase" }}>Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {uploadPreview.rows.map((r, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid rgba(72,72,71,0.08)", background: r.valid ? "transparent" : "rgba(248,113,113,0.04)" }}>
                      <td style={{ padding: "8px 10px", color: "var(--text3)" }}>{r.row}</td>
                      <td style={{ padding: "8px 10px" }}>
                        {r.valid
                          ? <span style={{ color: "var(--green)", fontWeight: 700, fontSize: 10 }}>✓ OK</span>
                          : <span style={{ color: "var(--red)", fontWeight: 700, fontSize: 10 }}>✗ ERROR</span>}
                      </td>
                      <td style={{ padding: "8px 10px", fontWeight: 600 }}>{r.date || "—"}</td>
                      <td style={{ padding: "8px 10px", color: r.branch ? "var(--text2)" : "var(--red)", fontWeight: 600 }}>{r.branchName || "—"}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", color: "var(--green)" }}>{INR(r.online)}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", color: "var(--green)" }}>{INR(r.cash)}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 600 }}>{INR(r.billing)}</td>
                      <td style={{ padding: "8px 10px", fontSize: 10, color: "var(--red)", maxWidth: 200 }}>
                        {r.errors.length > 0 ? r.errors.join("; ") : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Actions */}
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={confirmUpload} disabled={uploadPreview.validCount === 0}
                style={{ flex: 1, padding: "12px 0", borderRadius: 10, background: uploadPreview.validCount > 0 ? "linear-gradient(135deg, var(--green), #16a34a)" : "var(--bg4)", color: uploadPreview.validCount > 0 ? "#fff" : "var(--text3)", border: "none", fontWeight: 700, fontSize: 13, cursor: uploadPreview.validCount > 0 ? "pointer" : "not-allowed" }}>
                Import {uploadPreview.validCount} Valid Entries
              </button>
              <button onClick={() => setUploadPreview(null)}
                style={{ padding: "12px 20px", borderRadius: 10, background: "var(--bg4)", color: "var(--text3)", border: "none", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Template Format Picker */}
      <Modal isOpen={templatePicker} onClose={() => setTemplatePicker(false)} title="Download Template" width={440}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <p style={{ fontSize: 13, color: "var(--text3)", marginBottom: 4 }}>Choose a template format:</p>

          <button onClick={() => { setGeneratingTemplate(true); setTemplatePicker(false); requestAnimationFrame(() => requestAnimationFrame(() => downloadTemplate())); }}
            style={{ padding: "16px 20px", borderRadius: 12, background: "var(--bg4)", border: "1px solid var(--border)", cursor: "pointer", textAlign: "left", transition: "all .2s" }}
            onMouseEnter={e => e.currentTarget.style.borderColor = "var(--accent)"}
            onMouseLeave={e => e.currentTarget.style.borderColor = "var(--border)"}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>Multi-Tab (Per Branch)</div>
            <div style={{ fontSize: 11, color: "var(--text3)", lineHeight: 1.5 }}>
              Separate sheet for each branch with pre-filled staff names.<br/>
              Best for daily entry — one date per sheet, staff billing inline.
            </div>
          </button>

          <button onClick={() => { setGeneratingTemplate(true); setTemplatePicker(false); requestAnimationFrame(() => requestAnimationFrame(() => downloadFlatTemplate())); }}
            style={{ padding: "16px 20px", borderRadius: 12, background: "var(--bg4)", border: "1px solid var(--border)", cursor: "pointer", textAlign: "left", transition: "all .2s" }}
            onMouseEnter={e => e.currentTarget.style.borderColor = "var(--accent)"}
            onMouseLeave={e => e.currentTarget.style.borderColor = "var(--border)"}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>Single-Tab (All in One)</div>
            <div style={{ fontSize: 11, color: "var(--text3)", lineHeight: 1.5 }}>
              All branches and staff in one flat table — one row per staff.<br/>
              Best for bulk entry — fill multiple dates at once.
            </div>
          </button>
        </div>
      </Modal>

      {/* Template Generating Loader */}
      {generatingTemplate && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)", zIndex: 1500, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
          <style>{`
            @keyframes vPulse {
              0%, 100% { transform: scale(1); filter: drop-shadow(0 0 20px rgba(240,100,100,0.6)); }
              50% { transform: scale(1.15); filter: drop-shadow(0 0 40px rgba(240,100,100,0.9)); }
            }
            @keyframes vSpin {
              from { transform: rotate(0deg); }
              to { transform: rotate(360deg); }
            }
            @keyframes dots {
              0%, 20% { opacity: 0.2; }
              40% { opacity: 1; }
              100% { opacity: 0.2; }
            }
          `}</style>
          <div style={{ position: "relative", width: 120, height: 120, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "3px solid transparent", borderTopColor: "#f06464", borderRightColor: "#22d3ee", animation: "vSpin 1.2s linear infinite" }} />
            <div style={{ fontFamily: "var(--font-vibes), 'Brush Script MT', cursive", fontSize: 72, fontWeight: 400, color: "#f06464", lineHeight: 1, animation: "vPulse 1.5s ease-in-out infinite" }}>V</div>
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--accent)", letterSpacing: 2, textTransform: "uppercase" }}>
            Generating Template
            <span style={{ animation: "dots 1.4s infinite", animationDelay: "0s" }}>.</span>
            <span style={{ animation: "dots 1.4s infinite", animationDelay: "0.2s" }}>.</span>
            <span style={{ animation: "dots 1.4s infinite", animationDelay: "0.4s" }}>.</span>
          </div>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 500 }}>Building sheets, formulas, and validations</div>
        </div>
      )}

      {/* Leave Application Modal — opens when attendance is unchecked */}
      <Modal isOpen={!!leavePrompt} onClose={() => setLeavePrompt(null)} title={`Leave Application — ${leavePrompt?.staff?.name || ""}`}>
        {leavePrompt && (
          <form onSubmit={(e) => { e.preventDefault(); confirmLeave(); }} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ background: "var(--bg4)", padding: 12, borderRadius: 10, fontSize: 12, color: "var(--text2)" }}>
              Marking <strong>{leavePrompt.staff.name}</strong> absent on <strong>{selDate}</strong>.
              Salary will pro-rate based on present days; paid-leave allowance is consumed first.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 12, color: "var(--text2)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Leave Type</label>
              <select value={leavePrompt.type} onChange={e => setLeavePrompt({ ...leavePrompt, type: e.target.value })}
                style={{ padding: "12px 16px", border: "2px solid var(--input-border)", borderRadius: 10, fontSize: 14, background: "var(--bg2)", color: "var(--text)" }}>
                <option value="Paid">Paid Leave</option>
                <option value="Unpaid">Unpaid Leave</option>
                <option value="Sick Leave">Sick Leave</option>
                <option value="Casual">Casual Leave</option>
              </select>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 12, color: "var(--text2)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Reason (optional)</label>
              <input value={leavePrompt.reason} onChange={e => setLeavePrompt({ ...leavePrompt, reason: e.target.value })} placeholder="e.g. Personal emergency"
                style={{ padding: "12px 16px", border: "2px solid var(--input-border)", borderRadius: 10, fontSize: 14, background: "var(--bg2)", color: "var(--text)" }} />
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
              <button type="submit" style={{ flex: 1, padding: "14px", borderRadius: 12, background: "var(--accent)", color: "#000", border: "none", fontWeight: 800, cursor: "pointer" }}>Record Leave</button>
              <button type="button" onClick={() => setLeavePrompt(null)} style={{ padding: "14px 24px", borderRadius: 12, background: "var(--bg3)", color: "var(--text2)", border: "1px solid var(--border)", cursor: "pointer", fontWeight: 600 }}>Cancel</button>
            </div>
          </form>
        )}
      </Modal>

      {/* Loan Resource Picker — add active staff from other branches to this entry */}
      <Modal isOpen={loanPickerOpen} onClose={() => setLoanPickerOpen(false)} title="Add Loan Resource" width={520}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 12, color: "var(--text3)", lineHeight: 1.5 }}>
            Pick a stylist from another branch who worked here on {selDate}. Their billing, incentive, and tips will be credited to this branch, while their salary stays with their home branch.
          </div>
          <div style={{ position: "relative" }}>
            <div style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--text3)" }}>
              <Icon name="search" size={14} />
            </div>
            <input autoFocus value={loanSearch} onChange={e => setLoanSearch(e.target.value)}
              placeholder="Search by staff name or branch…"
              style={{ width: "100%", padding: "10px 12px 10px 38px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
          </div>

          {loanStaffList.length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6 }}>Already loaned ({loanStaffList.length})</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {loanStaffList.map(s => (
                  <span key={s.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 999, background: "rgba(251,146,60,0.1)", border: "1px solid rgba(251,146,60,0.3)", color: "var(--orange)", fontSize: 11, fontWeight: 700 }}>
                    {s.name}
                    <button type="button" onClick={() => removeLoanStaff(s.id)}
                      style={{ background: "transparent", border: "none", color: "var(--orange)", cursor: "pointer", padding: 0, fontSize: 12, fontWeight: 800 }}>✕</button>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, border: "1px solid var(--border)", borderRadius: 10, padding: 6 }}>
            {loanPickerResults.length === 0 ? (
              <div style={{ padding: 16, textAlign: "center", color: "var(--text3)", fontSize: 12 }}>
                {loanSearch ? "No match." : "No other-branch staff available for this date."}
              </div>
            ) : (
              loanPickerResults.map(s => {
                const homeName = (branchesById.get(homeBranchOf(s))?.name || "").replace("V-CUT ", "");
                return (
                  <button type="button" key={s.id} onClick={() => addLoanStaff(s.id)}
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", background: "var(--bg3)", border: "1px solid var(--border2)", borderRadius: 8, color: "var(--text)", cursor: "pointer", textAlign: "left" }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{s.name}</div>
                      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>{s.role || "Stylist"} · Home: <span style={{ color: "var(--orange)", fontWeight: 700 }}>{homeName}</span></div>
                    </div>
                    <span style={{ fontSize: 10, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1 }}>Add</span>
                  </button>
                );
              })
            )}
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" onClick={() => setLoanPickerOpen(false)}
              style={{ flex: 1, padding: "10px", borderRadius: 10, background: "var(--bg3)", color: "var(--text2)", border: "1px solid var(--border)", cursor: "pointer", fontWeight: 700 }}>Done</button>
          </div>
        </div>
      </Modal>

      {ConfirmDialog}
      {ToastContainer}
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
