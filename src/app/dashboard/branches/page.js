"use client";
import { useEffect, useState, useRef } from "react";
import { collection, onSnapshot, query, orderBy, where, getDocs, deleteDoc, doc, addDoc, updateDoc, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR, branchIncomeInPeriod, makeFilterPrefix, periodLabel, proRataSalary, staffLeavesInMonth, staffStatusForMonth, MASK } from "@/lib/calculations";
import { Icon, IconBtn, Pill, Card, PeriodWidget, ToggleGroup, TH, TD, useConfirm, useToast } from "@/components/ui";
import { useRouter } from "next/navigation";
import VLoader from "@/components/VLoader";


const NOW = new Date();

export default function BranchesPage() {
  const router = useRouter();
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [branches, setBranches] = useState([]);
  const [staff, setStaff] = useState([]);
  const [entries, setEntries] = useState([]);
  const [materialAllocations, setMaterialAllocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedBranch, setSelectedBranch] = useState(null);
  const [logView, setLogView] = useState(null);
  const [leaves, setLeaves] = useState([]);
  const [globalSettings, setGlobalSettings] = useState(null);
  const [salHistory, setSalHistory] = useState([]);
  const [selectedStaffHistory, setSelectedStaffHistory] = useState(null);
  const [attendanceCalendar, setAttendanceCalendar] = useState(null); // branch id
  const [attendanceMonth, setAttendanceMonth] = useState(null); // "YYYY-MM"
  const [attendanceSelectedDay, setAttendanceSelectedDay] = useState(null); // "YYYY-MM-DD"

  // Period
  const [filterMode, setFilterMode] = useState("month");
  const [filterYear, setFilterYear] = useState(NOW.getFullYear());
  const [filterMonth, setFilterMonth] = useState(NOW.getMonth() + 1);

  // Controls
  const [brFilter, setBrFilter] = useState("all");
  const [brTypeFilter, setBrTypeFilter] = useState("all");
  const [brSortCol, setBrSortCol] = useState("name");
  const [brSortDir, setBrSortDir] = useState("asc");
  const [brView, setBrView] = useState("card");

  // Edit form
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState({ name: "", type: "mens", location: "", shop_rent: "", room_rent: "", salary_budget: "", wifi: "", shop_elec: "", room_elec: "" });

  // Recalculate modal
  const [recalcModal, setRecalcModal] = useState(null); // { branches: [{id, name}] }
  const [recalcFrom, setRecalcFrom] = useState(() => { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10); });
  const [recalcTo, setRecalcTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [recalcBusy, setRecalcBusy] = useState(false);
  const [recalcLog, setRecalcLog] = useState([]);

  // Multi-branch selection (card/table list view)
  const [selectedBranches, setSelectedBranches] = useState(new Set());
  const toggleBranchSelect = (id) => {
    setSelectedBranches(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const clearBranchSelection = () => setSelectedBranches(new Set());
  const openBulkRecalc = () => {
    if (selectedBranches.size === 0) return;
    const list = Array.from(selectedBranches)
      .map(id => { const b = branches.find(x => x.id === id); return b ? { id: b.id, name: b.name } : null; })
      .filter(Boolean);
    if (list.length === 0) return;
    setRecalcModal({ branches: list });
    setRecalcLog([]);
    setRecalcDone(false);
  };

  const currentUser = useCurrentUser() || {};
  const isAdmin = currentUser?.role === "admin";
  const canEdit = ["admin","accountant"].includes(currentUser?.role);
  const filterPrefix = makeFilterPrefix(filterYear, filterMonth);
  const plabel = periodLabel(filterMode, filterYear, filterMonth);

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "staff"), sn => setStaff(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "leaves"), sn => setLeaves(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "salary_history"), sn => setSalHistory(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(doc(db, "settings", "global"), sn => setGlobalSettings(sn.data())),
      onSnapshot(query(collection(db, "entries"), orderBy("date", "desc")), sn => {
        setEntries(sn.docs.map(d => ({ ...d.data(), id: d.id })));
        setLoading(false);
      }),
      onSnapshot(query(collection(db, "material_allocations"), orderBy("transferred_at", "desc")), sn => {
        setMaterialAllocations(sn.docs.map(d => ({ ...d.data(), id: d.id })));
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  // Sync state from URL (Dashboard deep-linking)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const bid  = params.get("branchId");
    const mode = params.get("mode");
    const yr   = params.get("year");
    const mo   = params.get("month");
    const cal  = params.get("calendar");

    if (bid)  setSelectedBranch(bid);
    if (mode) setFilterMode(mode);
    if (yr)   setFilterYear(Number(yr));
    if (mo)   setFilterMonth(Number(mo));
    if (bid && cal === "1") {
      // Default to the active filter month, or the current month if not set.
      const prefix = (mode === "year")
        ? `${yr || NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, "0")}`
        : `${yr || NOW.getFullYear()}-${String(mo || NOW.getMonth() + 1).padStart(2, "0")}`;
      setAttendanceCalendar(bid);
      setAttendanceMonth(prefix);
      setAttendanceSelectedDay(null);
    }

    // Optional: Clean URL params to avoid re-syncing on refresh if user changes it
    if (bid || mode || yr || mo || cal) {
      const newUrl = window.location.pathname;
      window.history.replaceState({}, "", newUrl);
    }
  }, [branches]); // Wait for branches to be loaded so setSelectedBranch is meaningful

  const inPeriod = (dateStr) => {
    if (!dateStr) return false;
    if (filterMode === "month") return dateStr.startsWith(filterPrefix);
    return dateStr.startsWith(String(filterYear));
  };

  const getIncome = (bid) => {
    return entries.filter(e => e.branch_id === bid && inPeriod(e.date)).reduce((s, e) => {
      return s + (e.online || 0) + (e.cash || 0) + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.material || 0), 0);
    }, 0);
  };

  const getExpenses = (bid) => {
    return entries.filter(e => e.branch_id === bid && inPeriod(e.date)).reduce((s, e) => {
      const inc = (e.staff_billing || []).reduce((ss, sb) => ss + (sb.incentive || 0) + (sb.mat_incentive || 0), 0);
      return s + inc + (e.mat_expense || 0) + (e.others || 0) + (e.petrol || 0);
    }, 0);
  };

  // Build branch data
  let branchData = branches.map(b => {
    const bEntries = entries.filter(ent => ent.branch_id === b.id && inPeriod(ent.date));
    const isYearly = filterMode === "year";
    const currentYear = NOW.getFullYear();
    const factor = (isYearly && filterYear === currentYear) ? (NOW.getMonth() + 1) : (isYearly ? 12 : 1);
    
    // Aggregates
    const iOnline = bEntries.reduce((s, e) => s + (e.online || 0), 0);
    const iCash   = bEntries.reduce((s, e) => s + (e.cash || 0), 0);
    const iMatS   = bEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.material || 0), 0), 0);
    const income  = iOnline + iCash + iMatS;

    const vInc   = bEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.incentive || 0) + (sb.mat_incentive || 0), 0), 0);
    const vMatE  = bEntries.reduce((s, e) => s + (e.mat_expense || 0), 0);
    const vOther = bEntries.reduce((s, e) => s + (e.others || 0) + (e.petrol || 0), 0);
    const vPetrol = bEntries.reduce((s, e) => s + (e.petrol || 0), 0);
    
    // Fixed costs
    const fShopRent = (b.shop_rent || 0) * factor;
    const fRoomRent = (b.room_rent || 0) * factor;
    const fWifi     = (b.wifi || 0) * factor;
    const fElec     = ((b.shop_elec || 0) + (b.room_elec || 0)) * factor;
    const fFixedTot = fShopRent + fRoomRent + fWifi + fElec;

    // Payroll (Actual)
    let actualSalary = 0;
    let actualLeaves = 0;
    const startM = isYearly ? 1 : filterMonth;
    const endM   = isYearly ? factor : filterMonth;
    for (let m = startM; m <= endM; m++) {
      const mPrefix = `${filterYear}-${String(m).padStart(2, '0')}`;
      const activeStaffInMonth = staff.filter(s => s.branch_id === b.id && staffStatusForMonth(s, mPrefix).status !== 'inactive');
      actualSalary += activeStaffInMonth.reduce((s, st) => s + proRataSalary(st, mPrefix, branches, salHistory, staff, globalSettings), 0);
      actualLeaves += activeStaffInMonth.reduce((s, st) => s + staffLeavesInMonth(st.id, mPrefix, leaves), 0);
    }

    const expenses = vInc + vMatE + vOther + fFixedTot + actualSalary;
    const net      = income - expenses;
    const totalGst = bEntries.reduce((s, ent) => s + (ent.total_gst || 0), 0);

    // Cash reconciliation aggregates (entries where actual cash was recorded)
    let totalDeficit = 0, totalExcess = 0, reconciledDays = 0;
    bEntries.forEach(ent => {
      if (ent.cash_diff == null) return;
      reconciledDays += 1;
      if (ent.cash_diff < 0) totalDeficit += Math.abs(ent.cash_diff);
      else if (ent.cash_diff > 0) totalExcess += ent.cash_diff;
    });
    const netDiff = totalExcess - totalDeficit;

    return {
      b,
      i: income,
      e: expenses,
      n: net,
      staffCount: staff.filter(s => s.branch_id === b.id).length,
      vInc, vMatE, vOther, vPetrol,
      fShopRent, fRoomRent, fWifi, fElec,
      actualSalary, actualLeaves,
      totalGst, factor,
      totalDeficit, totalExcess, netDiff, reconciledDays,
    };
  });
  if (brFilter === "profit") branchData = branchData.filter(d => d.n >= 0);
  if (brFilter === "loss") branchData = branchData.filter(d => d.n < 0);
  if (brTypeFilter === "mens") branchData = branchData.filter(d => d.b.type === "mens");
  if (brTypeFilter === "unisex") branchData = branchData.filter(d => d.b.type === "unisex");
  branchData.sort((a, b) => {
    if (brSortCol === "income") return brSortDir === "desc" ? b.i - a.i : a.i - b.i;
    if (brSortCol === "pl") return brSortDir === "desc" ? b.n - a.n : a.n - b.n;
    if (brSortCol === "expense") return brSortDir === "desc" ? b.e - a.e : a.e - b.e;
    return brSortDir === "desc" ? b.b.name.localeCompare(a.b.name) : a.b.name.localeCompare(b.b.name);
  });

  const handleEdit = (b) => {
    setForm({ name: b.name || "", type: b.type || "mens", location: b.location || "", shop_rent: b.shop_rent || "", room_rent: b.room_rent || "", salary_budget: b.salary_budget || "", wifi: b.wifi || "", shop_elec: b.shop_elec || "", room_elec: b.room_elec || "" });
    setEditId(b.id);
    setShowForm(true);
    setSelectedBranch(null);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    const payload = { name: form.name, type: form.type, location: form.location, shop_rent: Number(form.shop_rent) || 0, room_rent: Number(form.room_rent) || 0, salary_budget: Number(form.salary_budget) || 0, wifi: Number(form.wifi) || 0, shop_elec: Number(form.shop_elec) || 0, room_elec: Number(form.room_elec) || 0 };
    try {
      if (editId) {
        await updateDoc(doc(db, "branches", editId), payload);
        toast({ title: "Updated", message: "Branch details updated successfully.", type: "success" });
      } else {
        await addDoc(collection(db, "branches"), payload);
        toast({ title: "Saved", message: "Branch created successfully.", type: "success" });
      }
      setShowForm(false); setEditId(null);
    } catch (err) { confirm({ title: "Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} }); }
  };

  const handleDelete = (bid) => {
    confirm({
      title: "Delete Branch",
      message: "Delete this branch?",
      confirmText: "Delete",
      cancelText: "Cancel",
      type: "danger",
      onConfirm: async () => {
        try { await deleteDoc(doc(db, "branches", bid)); setSelectedBranch(null); toast({ title: "Deleted", message: "Branch has been removed.", type: "success" }); }
        catch (err) { confirm({ title: "Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} }); }
      }
    });
  };

  const handleDeleteEntry = (eid) => {
    confirm({
      title: "Delete Entry",
      message: "Delete this entry permanently?",
      confirmText: "Delete",
      cancelText: "Cancel",
      type: "danger",
      onConfirm: async () => {
        try { await deleteDoc(doc(db, "entries", eid)); toast({ title: "Deleted", message: "Entry has been removed.", type: "success" }); }
        catch (err) { confirm({ title: "Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} }); }
      }
    });
  };

  // ── Recalculate entries for a branch in a date range ──
  const [recalcProgress, setRecalcProgress] = useState({ current: 0, total: 0 });
  const [recalcDone, setRecalcDone] = useState(false); // true when finished

  const handleRecalculate = async () => {
    if (!recalcModal || recalcBusy) return;
    const targetBranches = recalcModal.branches || [];
    if (targetBranches.length === 0) return;

    setRecalcBusy(true);
    setRecalcLog([]);
    setRecalcDone(false);
    setRecalcProgress({ current: 0, total: 0 });
    const log = [];
    const isMulti = targetBranches.length > 1;
    try {
      const ceilTo10 = (n) => Math.ceil(n / 10) * 10;

      // Gather entries for all selected branches so we can drive one progress bar
      const perBranch = targetBranches.map(({ id, name }) => ({
        id, name,
        entries: entries.filter(e => e.branch_id === id && e.date >= recalcFrom && e.date <= recalcTo),
      }));
      const totalEntries = perBranch.reduce((s, x) => s + x.entries.length, 0);

      if (totalEntries === 0) {
        log.push({ type: "info", text: "No entries found in the selected range." });
        setRecalcLog(log);
        setRecalcDone(true);
        setRecalcBusy(false);
        toast({ title: "Nothing to Sync", message: "No entries exist in the selected date range.", type: "warning" });
        return;
      }

      setRecalcProgress({ current: 0, total: totalEntries });

      let updated = 0;
      let processed = 0;

      for (const { id: branchId, name: branchName, entries: branchEntries } of perBranch) {
        const branch = branches.find(b => b.id === branchId);
        const isUnisex = (branch?.type || "").toLowerCase() === "unisex";

        const getRate = (sid) => {
          const s = staff.find(x => x.id === sid);
          if (s?.incentive_pct !== undefined && s.incentive_pct !== null) return Number(s.incentive_pct);
          if (globalSettings) return isUnisex ? (globalSettings.unisex_inc ?? 10) : (globalSettings.mens_inc ?? 10);
          return 10;
        };

        const getDailyExp = async (date) => {
          try {
            const q = query(collection(db, "daily_expenses"), where("branch_id", "==", branchId), where("date", "==", date));
            const sn = await getDocs(q);
            return sn.docs.reduce((s, d) => s + (Number(d.data().amount) || 0), 0);
          } catch { return 0; }
        };

        const getMatExp = (date) => {
          return materialAllocations
            .filter(a => a.branch_id === branchId && a.date === date)
            .reduce((s, a) => s + (Number(a.total) || 0), 0);
        };

        if (branchEntries.length === 0) {
          if (isMulti) {
            log.push({ type: "info", text: `${branchName}: no entries in range`, details: [] });
            setRecalcLog([...log]);
          }
          continue;
        }

        if (isMulti) {
          log.push({ type: "info", text: `— ${branchName} (${branchEntries.length} entries) —`, details: [] });
          setRecalcLog([...log]);
        }

        for (let i = 0; i < branchEntries.length; i++) {
          const entry = branchEntries[i];
          processed++;
          setRecalcProgress({ current: processed, total: totalEntries });
          const changes = {};
          let changed = false;
          const details = [];

          if (entry.staff_billing?.length > 0) {
            const newBilling = entry.staff_billing.map(sb => {
              const billing = Number(sb.billing) || 0;
              const material = Number(sb.material) || 0;
              const tips = Number(sb.tips) || 0;
              const rate = getRate(sb.staff_id);
              const newInc = ceilTo10(billing * rate / 100);
              const newMatInc = ceilTo10(material * 0.05);

              const s = staff.find(x => x.id === sb.staff_id);
              const role = (s?.role || "").toLowerCase();
              const defaultTaken = isUnisex ? (role.includes("hairdresser") || role.includes("hair dresser")) : true;
              const taken = sb.incentive_taken !== undefined ? sb.incentive_taken : defaultTaken;

              const newTotalInc = Math.round(newInc + newMatInc + tips);
              return {
                ...sb,
                incentive: newInc,
                mat_incentive: newMatInc,
                staff_total_inc: newTotalInc,
                incentive_taken: taken,
              };
            });
            changes.staff_billing = newBilling;
            changed = true;
            details.push("incentives recalculated");
          }

          const matExp = getMatExp(entry.date);
          if (matExp > 0 && matExp !== (Number(entry.mat_expense) || 0)) {
            changes.mat_expense = matExp;
            changed = true;
            details.push(`material: ${INR(Number(entry.mat_expense) || 0)} → ${INR(matExp)}`);
          }

          const dailyExp = await getDailyExp(entry.date);
          if (dailyExp > 0 && dailyExp !== (Number(entry.others) || 0)) {
            changes.others = dailyExp;
            changed = true;
            details.push(`expenses: ${INR(Number(entry.others) || 0)} → ${INR(dailyExp)}`);
          }

          if (changed && changes.staff_billing) {
            const totalBilling = changes.staff_billing.reduce((s, sb) => s + (Number(sb.billing) || 0), 0);
            const totalMatSale = changes.staff_billing.reduce((s, sb) => s + (Number(sb.material) || 0), 0);
            const totalSales = totalBilling + totalMatSale;
            const online = Number(entry.online) || 0;
            const cash = Math.max(0, totalSales - online);
            const takenInc = changes.staff_billing.reduce((s, sb) => {
              if (sb.incentive_taken === false) return s;
              return s + (Number(sb.incentive) || 0) + (Number(sb.mat_incentive) || 0);
            }, 0);
            const tipsPaidCash = changes.staff_billing.reduce((s, sb) => {
              const t = Number(sb.tips) || 0;
              return (sb.tip_paid || "cash") === "cash" ? s + t : s;
            }, 0);
            const tipsInCash = changes.staff_billing.reduce((s, sb) => {
              const t = Number(sb.tips) || 0;
              return (sb.tip_in || "online") === "cash" ? s + t : s;
            }, 0);
            const oth = changes.others !== undefined ? changes.others : (Number(entry.others) || 0);
            const pet = Number(entry.petrol) || 0;
            changes.cash_in_hand = cash + tipsInCash - tipsPaidCash - takenInc - oth - pet;
          }

          const prefix = isMulti ? `${branchName} ${entry.date}` : entry.date;
          if (changed) {
            changes.recalculated_at = new Date().toISOString();
            changes.recalculated_by = currentUser?.name || "user";
            await updateDoc(doc(db, "entries", entry.id), changes);
            updated++;
            log.push({ type: "synced", text: `${prefix}: synced`, details });
          } else {
            log.push({ type: "skip", text: `${prefix}: already in sync` });
          }
          setRecalcLog([...log]);
        }
      }

      setRecalcDone(true);
      const scope = isMulti ? ` across ${targetBranches.length} branches` : "";
      if (updated === 0) {
        toast({ title: "Already in Sync", message: `All ${totalEntries} entries${scope} are up to date.`, type: "info" });
      } else {
        toast({ title: "Sync Complete", message: `${updated} of ${totalEntries} entries synced${scope}.`, type: "success" });
      }
    } catch (err) {
      toast({ title: "Error", message: err.message, type: "error" });
      log.push({ type: "error", text: `Error: ${err.message}`, details: [] });
      setRecalcLog([...log]);
      setRecalcDone(true);
    } finally {
      setRecalcBusy(false);
    }
  };

  if (loading) return <VLoader fullscreen label="Loading branches" />;

  // ── Standalone Attendance Calendar Modal (rendered from both views) ───
  const attBranch = attendanceCalendar ? branches.find(x => x.id === attendanceCalendar) : null;
  const attendanceModalEl = attBranch && attendanceMonth ? (() => {
    const [yr, mo] = attendanceMonth.split("-").map(Number);
    const daysInMonth = new Date(yr, mo, 0).getDate();
    const firstDow = new Date(yr, mo - 1, 1).getDay();
    const todayStr = new Date().toISOString().slice(0, 10);
    const isCurrentMonth = NOW.getFullYear() === yr && NOW.getMonth() + 1 === mo;
    const cutoff = isCurrentMonth
      ? new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1).toISOString().slice(0, 10)
      : null;
    const branchEntries = entries.filter(e => e.branch_id === attBranch.id && e.date && e.date.startsWith(attendanceMonth));
    const staffById = new Map(staff.map(st => [st.id, st]));

    const perDay = (dateStr) => {
      // Build present/loan from the day's entry. Track who demonstrably worked
      // (any billing / material / tips > 0) — actual work overrides any leave
      // record that may have been filed by mistake.
      const entry = branchEntries.find(e => e.date === dateStr);
      const present = [], loan = [];
      const workedIds = new Set();
      if (entry) {
        (entry.staff_billing || []).forEach(sb => {
          if (sb.present === false) return;
          const hasWork = (sb.billing || 0) > 0 || (sb.material || 0) > 0 || (sb.tips || 0) > 0;
          if (hasWork) workedIds.add(sb.staff_id);
          const staffRec = staffById.get(sb.staff_id);
          const item = {
            id: sb.staff_id,
            name: staffRec?.name || sb.staff_name || "Staff",
            role: staffRec?.role || "",
            billing: sb.billing || 0,
          };
          if (sb.loan_flag) loan.push(item); else present.push(item);
        });
      }
      // Priority: actual work wins over leave. Staff who clocked work stay in
      // present/loan and are dropped from the leave list. Staff with a leave
      // but no work are treated as on-leave and removed from present/loan.
      const approvedLeaves = leaves
        .filter(l => l.date === dateStr && (l.status === "approved" || !l.status) && staffById.get(l.staff_id)?.branch_id === attBranch.id)
        .filter(l => !workedIds.has(l.staff_id))
        .map(l => ({ id: l.staff_id, name: staffById.get(l.staff_id)?.name || "Staff", type: l.type || "Paid" }));
      const onLeaveIds = new Set(approvedLeaves.map(l => l.id));
      return {
        present: present.filter(p => !onLeaveIds.has(p.id)),
        loan: loan.filter(p => !onLeaveIds.has(p.id)),
        approvedLeaves,
      };
    };

    const blanks = Array(firstDow).fill(null);
    const days = Array.from({ length: daysInMonth }, (_, i) => `${attendanceMonth}-${String(i + 1).padStart(2, "0")}`);

    const activeDay = attendanceSelectedDay && attendanceSelectedDay.startsWith(attendanceMonth) ? attendanceSelectedDay : null;
    const activeRoster = activeDay ? perDay(activeDay) : null;

    // Month nav
    const prevMonth = () => {
      const d = new Date(yr, mo - 2, 1);
      setAttendanceMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      setAttendanceSelectedDay(null);
    };
    const nextMonth = () => {
      const d = new Date(yr, mo, 1);
      setAttendanceMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      setAttendanceSelectedDay(null);
    };

    // Month totals for header summary
    const monthTotals = days.reduce((acc, d) => {
      if (cutoff && d > cutoff) return acc;
      const { present, loan, approvedLeaves } = perDay(d);
      acc.present += present.length;
      acc.loan += loan.length;
      acc.leave += approvedLeaves.length;
      if (present.length + loan.length > 0) acc.activeDays += 1;
      return acc;
    }, { present: 0, loan: 0, leave: 0, activeDays: 0 });

    const LEAVE_HEX = "#c084fc"; // violet-400 — distinct from accent/blue
    const LEAVE_BG = "rgba(192,132,252,0.10)";
    const LEAVE_BORDER = "rgba(192,132,252,0.35)";

    return (
      <div onClick={() => { setAttendanceCalendar(null); setAttendanceSelectedDay(null); }}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.78)", backdropFilter: "blur(10px)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, overflowY: "auto" }}>
        <div onClick={e => e.stopPropagation()}
          style={{ background: "linear-gradient(180deg, var(--bg2) 0%, var(--bg1) 100%)", border: "1px solid var(--border)", borderRadius: 22, width: "100%", maxWidth: 1120, maxHeight: "92vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 30px 60px -15px rgba(0,0,0,0.75), 0 0 0 1px rgba(34,211,238,0.05)" }}>

          {/* Header with gradient accent bar */}
          <div style={{ position: "relative", padding: "22px 28px 20px", borderBottom: "1px solid var(--border)", background: "linear-gradient(135deg, rgba(34,211,238,0.06) 0%, rgba(192,132,252,0.04) 50%, rgba(251,146,60,0.04) 100%)" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "linear-gradient(90deg, var(--accent) 0%, #c084fc 50%, var(--orange) 100%)" }} />
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ width: 44, height: 44, borderRadius: 12, background: "linear-gradient(135deg, rgba(34,211,238,0.18), rgba(34,211,238,0.04))", border: "1px solid rgba(34,211,238,0.35)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent)" }}>
                  <Icon name="checkCircle" size={22} />
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 2 }}>Attendance Calendar</div>
                  <div style={{ fontSize: 19, fontWeight: 800, color: "var(--gold)", letterSpacing: 0.3, lineHeight: 1.2, marginTop: 2 }}>{attBranch.name}</div>
                </div>
              </div>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <button onClick={prevMonth} title="Previous month"
                  style={{ width: 34, height: 34, borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text2)", cursor: "pointer", fontSize: 16, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", transition: "all .15s" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--bg4)"; e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "var(--bg3)"; e.currentTarget.style.color = "var(--text2)"; }}>‹</button>
                <div style={{ minWidth: 170, textAlign: "center", fontSize: 15, fontWeight: 800, color: "var(--text)", letterSpacing: 0.3, fontFamily: "var(--font-headline, var(--font-outfit))" }}>
                  {new Date(yr, mo - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" })}
                </div>
                <button onClick={nextMonth} title="Next month"
                  style={{ width: 34, height: 34, borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text2)", cursor: "pointer", fontSize: 16, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", transition: "all .15s" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--bg4)"; e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "var(--bg3)"; e.currentTarget.style.color = "var(--text2)"; }}>›</button>
                <button onClick={() => { setAttendanceCalendar(null); setAttendanceSelectedDay(null); }} title="Close"
                  style={{ marginLeft: 8, width: 34, height: 34, borderRadius: 10, background: "transparent", border: "1px solid var(--border)", color: "var(--text3)", cursor: "pointer", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", transition: "all .15s" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "rgba(239,68,68,0.10)"; e.currentTarget.style.color = "var(--red)"; e.currentTarget.style.borderColor = "rgba(239,68,68,0.35)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text3)"; e.currentTarget.style.borderColor = "var(--border)"; }}>✕</button>
              </div>
            </div>

            {/* Summary stat strip */}
            <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
              <div style={{ padding: "6px 12px", borderRadius: 8, background: "rgba(74,222,128,0.08)", border: "1px solid rgba(74,222,128,0.25)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 6, height: 6, borderRadius: 3, background: "var(--green)" }} />
                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Present</span>
                <span style={{ fontSize: 13, fontWeight: 800, color: "var(--green)" }}>{monthTotals.present}</span>
              </div>
              {monthTotals.loan > 0 && (
                <div style={{ padding: "6px 12px", borderRadius: 8, background: "rgba(251,146,60,0.08)", border: "1px solid rgba(251,146,60,0.25)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 3, background: "var(--orange)" }} />
                  <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Loaned</span>
                  <span style={{ fontSize: 13, fontWeight: 800, color: "var(--orange)" }}>{monthTotals.loan}</span>
                </div>
              )}
              {monthTotals.leave > 0 && (
                <div style={{ padding: "6px 12px", borderRadius: 8, background: LEAVE_BG, border: `1px solid ${LEAVE_BORDER}`, display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Icon name="moon" size={11} />
                  <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>On Leave</span>
                  <span style={{ fontSize: 13, fontWeight: 800, color: LEAVE_HEX }}>{monthTotals.leave}</span>
                </div>
              )}
              <div style={{ padding: "6px 12px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--border2)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Active Days</span>
                <span style={{ fontSize: 13, fontWeight: 800, color: "var(--text)" }}>{monthTotals.activeDays}</span>
              </div>
            </div>
          </div>

          {/* Body: calendar grid + right roster */}
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", gap: 22, padding: 22, overflowY: "auto" }}>
            {/* Calendar grid */}
            <div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6, fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, textAlign: "center", marginBottom: 8, paddingBottom: 8, borderBottom: "1px dashed var(--border)" }}>
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => <div key={d}>{d}</div>)}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
                {blanks.map((_, i) => <div key={`b${i}`} />)}
                {days.map(dateStr => {
                  const isFuture = cutoff && dateStr > cutoff;
                  const { present, loan, approvedLeaves } = perDay(dateStr);
                  const total = present.length + loan.length;
                  const hasLeave = approvedLeaves.length > 0;
                  const isToday = dateStr === todayStr;
                  const isActive = dateStr === activeDay;
                  // Colour priority: active > future > leave-only > has-activity > empty
                  const baseBg = isActive
                    ? "linear-gradient(135deg, var(--accent) 0%, #0ea5c4 100%)"
                    : isFuture
                      ? "repeating-linear-gradient(45deg, var(--bg4), var(--bg4) 4px, transparent 4px, transparent 8px)"
                      : total > 0
                        ? "linear-gradient(180deg, rgba(74,222,128,0.10), rgba(74,222,128,0.02))"
                        : hasLeave && !total
                          ? `linear-gradient(180deg, ${LEAVE_BG}, rgba(192,132,252,0.02))`
                          : "var(--bg4)";
                  const baseBorder = isActive
                    ? "var(--accent)"
                    : isToday
                      ? "rgba(34,211,238,0.6)"
                      : total > 0
                        ? "rgba(74,222,128,0.28)"
                        : hasLeave
                          ? LEAVE_BORDER
                          : "var(--border)";
                  return (
                    <button key={dateStr}
                      onClick={() => setAttendanceSelectedDay(dateStr)}
                      style={{
                        aspectRatio: "1 / 1",
                        padding: 8,
                        borderRadius: 12,
                        background: baseBg,
                        border: `1px solid ${baseBorder}`,
                        boxShadow: isActive ? "0 6px 18px -4px rgba(34,211,238,0.5)" : isToday ? "inset 0 0 0 1px rgba(34,211,238,0.25)" : "none",
                        color: isActive ? "#001418" : "var(--text)",
                        cursor: "pointer",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        opacity: isFuture ? 0.42 : 1,
                        fontFamily: "var(--font-headline, var(--font-outfit))",
                        transition: "transform .15s, box-shadow .15s",
                        outline: "none",
                      }}
                      onMouseEnter={e => { if (!isActive && !isFuture) { e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.boxShadow = "0 4px 12px -2px rgba(0,0,0,0.4)"; } }}
                      onMouseLeave={e => { if (!isActive && !isFuture) { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = isToday ? "inset 0 0 0 1px rgba(34,211,238,0.25)" : "none"; } }}>
                      <div style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center", fontSize: 13, fontWeight: 800 }}>
                        <span>{Number(dateStr.slice(8, 10))}</span>
                        {hasLeave && (
                          <span title={`${approvedLeaves.length} on leave`}
                            style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 9, fontWeight: 800, padding: "1px 5px", borderRadius: 5, background: isActive ? "rgba(0,20,24,0.15)" : LEAVE_BG, color: isActive ? "#001418" : LEAVE_HEX, border: `1px solid ${isActive ? "transparent" : LEAVE_BORDER}` }}>
                            <Icon name="moon" size={9} />{approvedLeaves.length}
                          </span>
                        )}
                      </div>
                      <div style={{ display: "inline-flex", gap: 4, fontSize: 10, fontWeight: 800 }}>
                        {present.length > 0 && <span style={{ padding: "2px 7px", borderRadius: 5, background: isActive ? "rgba(0,20,24,0.15)" : "rgba(74,222,128,0.18)", color: isActive ? "#001418" : "var(--green)" }}>{present.length}</span>}
                        {loan.length > 0 && <span style={{ padding: "2px 7px", borderRadius: 5, background: isActive ? "rgba(0,20,24,0.15)" : "rgba(251,146,60,0.18)", color: isActive ? "#001418" : "var(--orange)" }}>+{loan.length}</span>}
                        {!total && !hasLeave && !isFuture && <span style={{ color: "var(--text3)", opacity: 0.5 }}>—</span>}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Legend */}
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 14, padding: "10px 14px", background: "var(--bg3)", borderRadius: 10, border: "1px solid var(--border)" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text3)" }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--green)" }} />
                  <span style={{ color: "var(--text2)", fontWeight: 600 }}>Home-branch</span>
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text3)" }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--orange)" }} />
                  <span style={{ color: "var(--text2)", fontWeight: 600 }}>Loaned in</span>
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text3)" }}>
                  <span style={{ color: LEAVE_HEX, display: "inline-flex" }}><Icon name="moon" size={11} /></span>
                  <span style={{ color: "var(--text2)", fontWeight: 600 }}>On leave</span>
                </span>
                {cutoff && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text3)" }}>
                    <span style={{ width: 14, height: 10, borderRadius: 2, backgroundImage: "repeating-linear-gradient(45deg, var(--bg4), var(--bg4) 3px, transparent 3px, transparent 6px)", border: "1px solid var(--border2)" }} />
                    <span style={{ color: "var(--text2)", fontWeight: 600 }}>After <strong style={{ color: "var(--text2)" }}>{cutoff}</strong> — not captured</span>
                  </span>
                )}
              </div>
            </div>

            {/* Right — selected day roster */}
            <div style={{ borderLeft: "1px solid var(--border)", paddingLeft: 22 }}>
              {activeRoster ? (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1.8 }}>Roster for</div>
                  <div style={{ fontSize: 17, fontWeight: 800, color: "var(--text)", marginBottom: 14, fontFamily: "var(--font-headline, var(--font-outfit))" }}>
                    {new Date(activeDay + "T00:00").toLocaleString("en-US", { weekday: "long", day: "numeric", month: "short", year: "numeric" })}
                  </div>

                  {activeRoster.present.length === 0 && activeRoster.loan.length === 0 && activeRoster.approvedLeaves.length === 0 ? (
                    <div style={{ padding: 24, background: "var(--bg3)", border: "1px dashed var(--border2)", borderRadius: 12, color: "var(--text3)", fontSize: 12, textAlign: "center" }}>
                      <div style={{ fontSize: 24, marginBottom: 6, opacity: 0.5 }}>📭</div>
                      No activity recorded for this day.
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {activeRoster.present.map(p => (
                        <div key={`p-${p.id}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 13px", background: "linear-gradient(180deg, rgba(74,222,128,0.08), rgba(74,222,128,0.02))", border: "1px solid rgba(74,222,128,0.22)", borderLeft: "3px solid var(--green)", borderRadius: 10 }}>
                          <div style={{ width: 34, height: 34, borderRadius: 10, background: "linear-gradient(135deg, rgba(74,222,128,0.2), rgba(74,222,128,0.05))", color: "var(--green)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 14, border: "1px solid rgba(74,222,128,0.25)" }}>{p.name[0]}</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                            {p.role && <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 1 }}>{p.role}</div>}
                          </div>
                          {p.billing > 0 && <span style={{ fontSize: 12, color: "var(--green)", fontWeight: 800, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(p.billing)}</span>}
                        </div>
                      ))}
                      {activeRoster.loan.map(p => {
                        const homeName = (branches.find(x => x.id === staffById.get(p.id)?.branch_id)?.name || "").replace("V-CUT ", "");
                        return (
                          <div key={`l-${p.id}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 13px", background: "linear-gradient(180deg, rgba(251,146,60,0.08), rgba(251,146,60,0.02))", border: "1px solid rgba(251,146,60,0.25)", borderLeft: "3px solid var(--orange)", borderRadius: 10 }}>
                            <div style={{ width: 34, height: 34, borderRadius: 10, background: "linear-gradient(135deg, rgba(251,146,60,0.2), rgba(251,146,60,0.05))", color: "var(--orange)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 14, border: "1px solid rgba(251,146,60,0.25)" }}>{p.name[0]}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                              <div style={{ fontSize: 10, color: "var(--orange)", fontWeight: 700, letterSpacing: 0.5, marginTop: 1 }}>LOAN{homeName ? ` · Home: ${homeName}` : ""}</div>
                            </div>
                            {p.billing > 0 && <span style={{ fontSize: 12, color: "var(--orange)", fontWeight: 800, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(p.billing)}</span>}
                          </div>
                        );
                      })}
                      {activeRoster.approvedLeaves.map(l => (
                        <div key={`lv-${l.id}`} style={{ position: "relative", display: "flex", alignItems: "center", gap: 12, padding: "11px 13px", background: `linear-gradient(180deg, ${LEAVE_BG}, rgba(192,132,252,0.02))`, border: `1px solid ${LEAVE_BORDER}`, borderLeft: `3px solid ${LEAVE_HEX}`, borderRadius: 10, opacity: 0.95 }}>
                          <div style={{ width: 34, height: 34, borderRadius: 10, background: "linear-gradient(135deg, rgba(192,132,252,0.22), rgba(192,132,252,0.05))", color: LEAVE_HEX, display: "flex", alignItems: "center", justifyContent: "center", border: `1px solid ${LEAVE_BORDER}` }}>
                            <Icon name="moon" size={16} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</div>
                            <div style={{ fontSize: 10, color: LEAVE_HEX, fontWeight: 700, letterSpacing: 0.4, marginTop: 1 }}>ON LEAVE · {l.type}</div>
                          </div>
                          <span style={{ fontSize: 9, fontWeight: 800, padding: "3px 8px", borderRadius: 6, background: LEAVE_BG, color: LEAVE_HEX, border: `1px solid ${LEAVE_BORDER}`, textTransform: "uppercase", letterSpacing: 0.8 }}>Off</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ padding: 30, textAlign: "center", color: "var(--text3)", fontSize: 12, background: "var(--bg3)", border: "1px dashed var(--border2)", borderRadius: 12 }}>
                  <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.4 }}>👆</div>
                  Click any day on the calendar to see its full roster here.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  })() : null;

  // ── Recalculate Modal (shared between detail and list views) ────
  const recalcModalEl = recalcModal ? (
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(6px)", zIndex: 1100, display: "flex", justifyContent: "center", alignItems: "center", padding: 16 }}>
      <div style={{ width: "100%", maxWidth: 560, background: "var(--bg2)", borderRadius: 16, overflow: "hidden", boxShadow: "0 24px 80px rgba(0,0,0,0.5)" }}>
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        <div style={{ padding: "20px 24px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: "var(--text)" }}>
            {recalcModal.branches.length === 1
              ? `Recalculate — ${recalcModal.branches[0].name}`
              : `Recalculate — ${recalcModal.branches.length} branches`}
          </div>
          {recalcModal.branches.length > 1 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {recalcModal.branches.map(b => (
                <span key={b.id} style={{ fontSize: 10, padding: "3px 8px", borderRadius: 6, background: "var(--bg4)", color: "var(--text2)", fontWeight: 600 }}>{b.name}</span>
              ))}
            </div>
          )}
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 4 }}>
            Recalculates incentives (ceil-to-10, per-staff rate, daily/period defaults), updates material expense from allocations, and other expenses from daily expenses.
          </div>
        </div>
        <div style={{ padding: "16px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>From Date</label>
              <input type="date" value={recalcFrom} onChange={e => setRecalcFrom(e.target.value)} disabled={recalcBusy}
                style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, marginTop: 4, opacity: recalcBusy ? 0.5 : 1 }} />
            </div>
            <div>
              <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>To Date</label>
              <input type="date" value={recalcTo} onChange={e => setRecalcTo(e.target.value)} disabled={recalcBusy}
                style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, marginTop: 4, opacity: recalcBusy ? 0.5 : 1 }} />
            </div>
          </div>

          {/* Progress bar while busy */}
          {recalcBusy && recalcProgress.total > 0 && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)" }}>Syncing entries…</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)" }}>{recalcProgress.current} / {recalcProgress.total}</span>
              </div>
              <div style={{ width: "100%", height: 6, borderRadius: 3, background: "var(--bg4)", overflow: "hidden" }}>
                <div style={{ height: "100%", borderRadius: 3, background: "linear-gradient(90deg, var(--accent), var(--gold2))", transition: "width 0.3s ease", width: `${Math.round((recalcProgress.current / recalcProgress.total) * 100)}%` }} />
              </div>
            </div>
          )}

          {/* Done summary banner */}
          {recalcDone && recalcLog.length > 0 && (() => {
            const synced = recalcLog.filter(l => l.type === "synced").length;
            const skipped = recalcLog.filter(l => l.type === "skip").length;
            const errors = recalcLog.filter(l => l.type === "error").length;
            const isAllInSync = synced === 0 && errors === 0;
            return (
              <div style={{
                padding: "12px 16px", borderRadius: 10, display: "flex", alignItems: "center", gap: 12,
                background: errors > 0 ? "rgba(248,113,113,0.08)" : isAllInSync ? "rgba(96,165,250,0.08)" : "rgba(74,222,128,0.08)",
                border: `1px solid ${errors > 0 ? "rgba(248,113,113,0.2)" : isAllInSync ? "rgba(96,165,250,0.2)" : "rgba(74,222,128,0.2)"}`,
              }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                  background: errors > 0 ? "rgba(248,113,113,0.15)" : isAllInSync ? "rgba(96,165,250,0.15)" : "rgba(74,222,128,0.15)",
                }}>
                  {errors > 0 ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                  ) : isAllInSync ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                  )}
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: errors > 0 ? "var(--red)" : isAllInSync ? "var(--blue, #60a5fa)" : "var(--green)" }}>
                    {errors > 0 ? "Sync Failed" : isAllInSync ? "Already in Sync" : "Sync Complete"}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>
                    {errors > 0 ? "An error occurred during sync."
                      : isAllInSync ? `All ${skipped} entries are already up to date.`
                      : `${synced} synced, ${skipped} already up to date`}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Sync log */}
          {recalcLog.length > 0 && (
            <div style={{ maxHeight: 220, overflowY: "auto", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border)", fontSize: 11 }}>
              <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, position: "sticky", top: 0, background: "var(--bg3)", zIndex: 1 }}>
                Sync Log
              </div>
              {recalcLog.map((l, i) => (
                <div key={i} style={{ padding: "6px 12px", borderBottom: "1px solid rgba(255,255,255,0.03)", display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <span style={{ flexShrink: 0, marginTop: 1 }}>
                    {l.type === "synced" ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                    ) : l.type === "error" ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                    ) : l.type === "info" ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" strokeWidth="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    )}
                  </span>
                  <div style={{ flex: 1 }}>
                    <span style={{ fontFamily: "monospace", color: l.type === "synced" ? "var(--green)" : l.type === "error" ? "var(--red)" : l.type === "info" ? "var(--blue, #60a5fa)" : "var(--text3)" }}>{l.text}</span>
                    {l.details?.length > 0 && (
                      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>
                        {l.details.join(" · ")}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 4 }}>
            <button onClick={() => { setRecalcModal(null); setRecalcLog([]); setRecalcDone(false); }} disabled={recalcBusy}
              style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text3)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: recalcBusy ? "wait" : "pointer" }}>
              {recalcDone ? "Close" : "Cancel"}
            </button>
            {!recalcDone && (
              <button onClick={handleRecalculate} disabled={recalcBusy}
                style={{ padding: "10px 20px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: recalcBusy ? "wait" : "pointer", opacity: recalcBusy ? 0.6 : 1, display: "inline-flex", alignItems: "center", gap: 6 }}>
                {recalcBusy ? (
                  <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: "spin 1s linear infinite" }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Syncing…</>
                ) : (
                  <><Icon name="check" size={13} /> Recalculate</>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  ) : null;

  // ── Branch Detail View ───────────────────────────────────────────
  if (selectedBranch) {
    const b = branches.find(x => x.id === selectedBranch);
    if (!b) { setSelectedBranch(null); return null; }

    // Constants for the entire Detail View
    const branchStaff = staff.filter(s => s.branch_id === b.id);
    const periodEntries = entries.filter(e => e.branch_id === b.id && inPeriod(e.date));

    // Calculate stats based on range (Pro-rata for yearly)
    const isYearly = filterMode === "year";
    const currentYear = NOW.getFullYear();
    const currentMonthNum = NOW.getMonth() + 1;
    const isPastYear = filterYear < currentYear;
    const endMonth = isPastYear ? 12 : ((isYearly && filterYear === currentYear) ? currentMonthNum : (isYearly ? 12 : filterMonth));
    const startMonthStats = isYearly ? 1 : filterMonth; 
    const factor = (endMonth - startMonthStats + 1);
    const breakdownStats = [];
    const isPastMonth = !isPastYear && filterMonth < currentMonthNum;
    const isCurrentMonth = !isPastYear && filterYear === currentYear && filterMonth === currentMonthNum;

    if (filterMode === "month") {
      const isFutureMonth = (filterYear > currentYear) || (filterYear === currentYear && filterMonth > currentMonthNum);
      const daysCount = new Date(filterYear, filterMonth, 0).getDate();
      const endDay = isFutureMonth ? 0 : (isCurrentMonth ? NOW.getDate() : daysCount);
      const dayFactor = 1 / daysCount;

      for (let d = 1; d <= endDay; d++) {
        const dayPrefix = `${filterYear}-${String(filterMonth).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dEntries = entries.filter(e => e.branch_id === b.id && e.date === dayPrefix);

        // Active staff for the month (needed for leaves + salary)
        const activeStaffInMonth = staff.filter(s => s.branch_id === b.id && staffStatusForMonth(s, filterPrefix).status !== 'inactive');
        const dLeaves = leaves.filter(l => l.staff_id && activeStaffInMonth.some(as => as.id === l.staff_id) && l.status === 'approved' && l.date === dayPrefix).reduce((s, l) => s + (l.days || 1), 0);

        // Skip days that have no entries and no approved leaves — avoids
        // stale rows persisting after the daily entry is deleted.
        if (dEntries.length === 0 && dLeaves === 0) continue;

        const dOnline = dEntries.reduce((s, e) => s + (e.online || 0), 0);
        const dCash = dEntries.reduce((s, e) => s + (e.cash || 0), 0);
        const dMatInc = dEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.material || 0), 0), 0);
        const dIncExp = dEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.incentive || 0) + (sb.mat_incentive || 0), 0), 0);
        const dMatExp = dEntries.reduce((s, e) => s + (e.mat_expense || 0), 0);
        const dOtherExp = dEntries.reduce((s, e) => s + (e.others || 0) + (e.petrol || 0), 0);

        // Fixed costs pro-rated for the day
        const mFixed = (b.shop_rent || 0) + (b.room_rent || 0) + (b.wifi || 0) + (b.shop_elec || 0) + (b.room_elec || 0);
        const dFixed = mFixed * dayFactor;

        // Actual Salary for the month pro-rated for that day
        const mActualSalary = activeStaffInMonth.reduce((s, st) => s + proRataSalary(st, filterPrefix, branches, salHistory, staff, globalSettings), 0);
        const dSalary = mActualSalary * dayFactor;

        const dIncome = dOnline + dCash + dMatInc;
        const dExpenses = dIncExp + dMatExp + dOtherExp + dFixed + dSalary;
        
        breakdownStats.push({
          label: `${d} ${new Date(filterYear, filterMonth - 1).toLocaleString('default', { month: 'short' })}`,
          income: dIncome,
          incentives: dIncExp,
          material: dMatExp,
          others: dOtherExp,
          shopRent: (b.shop_rent || 0) * dayFactor,
          roomRent: (b.room_rent || 0) * dayFactor,
          elec: ((b.shop_elec || 0) + (b.room_elec || 0)) * dayFactor,
          wifi: (b.wifi || 0) * dayFactor,
          salary: dSalary,
          leaves: dLeaves,
          pl: dIncome - dExpenses
        });
      }
    } else {
      // Yearly Mode: Month-by-month
      for (let m = 1; m <= endMonth; m++) {
        const monthPrefix = `${filterYear}-${m < 10 ? '0' + m : m}`;
        const mEntries = entries.filter(e => e.branch_id === b.id && e.date.startsWith(monthPrefix));
        
        const mOnline = mEntries.reduce((s, e) => s + (e.online || 0), 0);
        const mCash = mEntries.reduce((s, e) => s + (e.cash || 0), 0);
        const mMatInc = mEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.material || 0), 0), 0);
        const mIncExp = mEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.incentive || 0) + (sb.mat_incentive || 0), 0), 0);
        const mMatExp = mEntries.reduce((s, e) => s + (e.mat_expense || 0), 0);
        const mOtherExp = mEntries.reduce((s, e) => s + (e.others || 0) + (e.petrol || 0), 0);
        
        const mFixed = (b.shop_rent || 0) + (b.room_rent || 0) + (b.wifi || 0) + (b.shop_elec || 0) + (b.room_elec || 0);
        const activeStaffInMonth = staff.filter(s => s.branch_id === b.id && staffStatusForMonth(s, monthPrefix).status !== 'inactive');
        const mActualSalary = activeStaffInMonth.reduce((s, st) => s + proRataSalary(st, monthPrefix, branches, salHistory, staff, globalSettings), 0);
        const mLeaves = activeStaffInMonth.reduce((s, st) => s + staffLeavesInMonth(st.id, monthPrefix, leaves), 0);

        const mIncome = mOnline + mCash + mMatInc;
        const mExpenses = mIncExp + mMatExp + mOtherExp + mFixed + mActualSalary;
        
        breakdownStats.push({
          label: new Date(filterYear, m - 1).toLocaleString('default', { month: 'short' }),
          income: mIncome,
          incentives: mIncExp,
          material: mMatExp,
          others: mOtherExp,
          shopRent: (b.shop_rent || 0),
          roomRent: (b.room_rent || 0),
          elec: (b.shop_elec || 0) + (b.room_elec || 0),
          wifi: (b.wifi || 0),
          salary: mActualSalary,
          leaves: mLeaves,
          pl: mIncome - mExpenses
        });
      }
    }

    // Always use these sums for top KPI cards (which follow filter selection)
    let totalOnline = 0, totalCash = 0, totalMatInc = 0;
    let totalIncentiveExp = 0, totalMatExp = 0, totalOtherExp = 0;
    let totalFixedSalaryComp = 0;

    for (let m = startMonthStats; m <= endMonth; m++) {
      const monthPrefix = `${filterYear}-${m < 10 ? '0' + m : m}`;
      const mEntries = entries.filter(e => e.branch_id === b.id && e.date.startsWith(monthPrefix));
      const mOnline = mEntries.reduce((s, e) => s + (e.online || 0), 0);
      const mCash = mEntries.reduce((s, e) => s + (e.cash || 0), 0);
      const mMatInc = mEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.material || 0), 0), 0);
      const mIncExp = mEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.incentive || 0) + (sb.mat_incentive || 0), 0), 0);
      const mMatExp = mEntries.reduce((s, e) => s + (e.mat_expense || 0), 0);
      const mOtherExp = mEntries.reduce((s, e) => s + (e.others || 0) + (e.petrol || 0), 0);
      const mFixed = (b.shop_rent || 0) + (b.room_rent || 0) + (b.wifi || 0) + (b.shop_elec || 0) + (b.room_elec || 0);
      const actSal = staff.filter(as => as.branch_id === b.id && staffStatusForMonth(as, monthPrefix).status !== 'inactive').reduce((s, st) => s + proRataSalary(st, monthPrefix, branches, salHistory, staff, globalSettings), 0);
      
      totalOnline += mOnline; totalCash += mCash; totalMatInc += mMatInc;
      totalIncentiveExp += mIncExp; totalMatExp += mMatExp; totalOtherExp += mOtherExp;
      totalFixedSalaryComp += (mFixed + actSal);
    }

    const gstPct = globalSettings?.gst_pct || 0;
    const totalGstEst = (totalOnline * gstPct) / 100;
    const totalIncSum = totalOnline + totalCash + totalMatInc;
    const totalVarExp = totalIncentiveExp + totalMatExp + totalOtherExp;
    const netSum = totalIncSum - totalVarExp;
    const fullNetSum = netSum - totalFixedSalaryComp - totalGstEst;

    return (
      <div>
        {/* Back header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
          <button onClick={() => setSelectedBranch(null)} style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--bg3)", border: "1px solid var(--border2)", borderRadius: 8, padding: "8px 14px", fontSize: 12, fontFamily: "var(--font-outfit)", fontWeight: 600, cursor: "pointer", color: "var(--text2)" }}>
            <Icon name="back" size={14} /> Back
          </button>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>{b.name}</div>
          <Pill label={b.type === "unisex" ? "Unisex" : "Mens"} color={b.type === "unisex" ? "purple" : "blue"} />
          {b.location && <span style={{ fontSize: 12, color: "var(--text3)" }}>📍 {b.location}</span>}
          {canEdit && (
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button onClick={() => { setRecalcModal({ branches: [{ id: b.id, name: b.name }] }); setRecalcLog([]); setRecalcDone(false); }}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, background: "rgba(96,165,250,0.12)", border: "1px solid rgba(96,165,250,0.3)", color: "var(--blue, #60a5fa)", cursor: "pointer", fontWeight: 600, fontSize: 12 }}>
                <Icon name="check" size={14} /> Recalculate
              </button>
              <button onClick={() => handleEdit(b)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text2)", cursor: "pointer", fontWeight: 600, fontSize: 12 }}>
                <Icon name="edit" size={14} /> Edit
              </button>
              {isAdmin && <button onClick={() => handleDelete(b.id)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, background: "var(--red-bg)", border: "1px solid rgba(248,113,113,0.3)", color: "var(--red)", cursor: "pointer", fontWeight: 600, fontSize: 12 }}>
                <Icon name="del" size={14} /> Delete
              </button>}
            </div>
          )}
        </div>

        <PeriodWidget filterMode={filterMode} setFilterMode={setFilterMode} filterYear={filterYear} setFilterYear={setFilterYear} filterMonth={filterMonth} setFilterMonth={setFilterMonth} />

        {/* KPIs */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, marginBottom: 24 }}>
          {[
            ["Total Income", INR(totalIncSum), "var(--green)"],
            ["Variable Exp", INR(totalVarExp), "var(--red)"],
            ["Gross Net", isAdmin ? INR(netSum) : "•••••", netSum >= 0 ? "var(--green)" : "var(--red)"],
            ["Fixed Costs", isAdmin ? INR(totalFixedSalaryComp) : "•••••", "var(--orange)"],
            ["GST Est.", isAdmin ? INR(totalGstEst) : "•••••", "var(--red)"],
            ["Full Net P&L", isAdmin ? (INR(fullNetSum)) : "•••••", fullNetSum >= 0 ? "var(--green)" : "var(--red)"],
          ].map(([l, v, c]) => (
            <Card key={l} style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 4, minHeight: 90, justifyContent: "center" }}>
              <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: c, whiteSpace: "nowrap" }}>{v}</div>
              <div style={{ fontSize: 10, color: "var(--blue)", fontWeight: 600 }}>{isYearly ? "This Year" : "This Month"}</div>
            </Card>
          ))}
        </div>

        {/* Two-column detail */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
          {/* Income Breakdown */}
          <Card style={{ padding: 0 }}>
            <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", fontWeight: 700, color: "var(--gold)", fontSize: 12, textTransform: "uppercase", letterSpacing: 1 }}>Income Breakdown</div>
            <div style={{ padding: 16 }}>
              {[["Online / UPI", INR(totalOnline), "var(--green)"], ["Cash Collections", INR(totalCash), "var(--green)"], ["Material Sales", INR(totalMatInc), "var(--green)"]].map(([l, v, c]) => (
                <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
                  <span style={{ color: "var(--text2)", fontWeight: 500 }}>{l}</span>
                  <span style={{ fontWeight: 600, color: c }}>{v}</span>
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", fontSize: 14, fontWeight: 700 }}>
                <span style={{ color: "var(--gold)" }}>TOTAL</span>
                <span style={{ color: "var(--green)" }}>{INR(totalIncSum)}</span>
              </div>
            </div>
          </Card>

          {/* Expense Breakdown */}
          <Card style={{ padding: 0 }}>
            <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", fontWeight: 700, color: "var(--red)", fontSize: 12, textTransform: "uppercase", letterSpacing: 1 }}>Expense Breakdown</div>
            <div style={{ padding: 16 }}>
              {[["Staff Incentives", INR(totalIncentiveExp), "var(--red)"], ["Material Cost", INR(totalMatExp), "var(--red)"], ["Other / Petrol", INR(totalOtherExp), "var(--red)"], ["Shop Rent", INR(b.shop_rent * factor), "var(--orange)"], ["Room Rent", INR(b.room_rent * factor), "var(--orange)"], ["Electricity", INR(((b.shop_elec || 0) + (b.room_elec || 0)) * factor), "var(--orange)"], ["WiFi", INR(b.wifi * factor), "var(--orange)"]].map(([l, v, c]) => (
                <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
                  <span style={{ color: "var(--text2)", fontWeight: 500 }}>{l}</span>
                  <span style={{ fontWeight: 600, color: c }}>{v}</span>
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--border)", fontSize: 12 }}>
                <span style={{ color: "var(--text2)", fontWeight: 500 }}>GST Extraction ({gstPct}%)</span>
                <span style={{ fontWeight: 600, color: "var(--red)" }}>{INR(totalGstEst)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0 4px", fontSize: 14, fontWeight: 700 }}>
                <span style={{ color: "var(--red)" }}>TOTAL</span>
                <span style={{ color: "var(--red)" }}>{isAdmin ? INR(totalVarExp + totalFixedSalaryComp + totalGstEst) : "•••••"}</span>
              </div>
            </div>
          </Card>
        </div>

        {/* Quick action: open the standalone attendance calendar modal for this branch */}
        <div style={{ display: "flex", justifyContent: "flex-end", margin: "8px 0 16px" }}>
          <button onClick={() => { setAttendanceCalendar(b.id); setAttendanceMonth(filterMode === "month" ? filterPrefix : `${filterYear}-${String(NOW.getMonth() + 1).padStart(2, "0")}`); setAttendanceSelectedDay(null); }}
            style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 16px", borderRadius: 10, background: "rgba(var(--accent-rgb),0.1)", border: "1px solid rgba(var(--accent-rgb),0.35)", color: "var(--accent)", fontSize: 12, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", cursor: "pointer" }}>
            📅 View Attendance Calendar
          </button>
        </div>

        {/* Staff Table */}
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, color: "var(--gold)" }}>Branch Staff ({branchStaff.length})</div>
        <Card>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5 }}>
            <thead><tr>
              <TH>#</TH><TH>Name</TH><TH>Role</TH>{isAdmin && <TH right>Salary</TH>}<TH right>Leaves (T/L)</TH><TH right>Billing ({plabel})</TH><TH right>Staff T.Inc</TH><TH right>Staff T.Sale</TH><TH> </TH>
            </tr></thead>
            <tbody>
              {branchStaff.map((s, i) => {
                let billing = 0, matSale = 0, tips = 0, staffTInc = 0;
                
                // Salary & Leaves logic
                let curSalary = 0, leavesTaken = 0;
                const quotaPerMonth = (b.type === 'unisex' ? globalSettings?.unisex_leaves : globalSettings?.mens_leaves) || (b.type === 'unisex' ? 3 : 2);
                
                if (filterMode === 'month') {
                  curSalary = proRataSalary(s, filterPrefix, branches, salHistory, staff, globalSettings);
                  leavesTaken = staffLeavesInMonth(s.id, filterPrefix, leaves);
                } else {
                  // Sum for the year (Jan to endMonth)
                  for (let m = 1; m <= endMonth; m++) {
                    const mPrefix = `${filterYear}-${String(m).padStart(2, '0')}`;
                    curSalary += proRataSalary(s, mPrefix, branches, salHistory, staff, globalSettings);
                    leavesTaken += staffLeavesInMonth(s.id, mPrefix, leaves);
                  }
                }
                const quota = quotaPerMonth * factor;
                const leavesLeft = Math.max(0, quota - leavesTaken);

                periodEntries.forEach(e => {
                  const sb = (e.staff_billing || []).find(x => x.staff_id === s.id);
                  if (sb) {
                    billing += (sb.billing || 0);
                    matSale += (sb.material || 0);
                    tips += (sb.tips || 0);
                    staffTInc += (sb.staff_total_inc || (sb.incentive || 0) + (sb.mat_incentive || 0) + (sb.tips || 0));
                  }
                });
                const totalSale = billing + matSale + tips;
                const pct = Math.min(Math.round(billing / (s.target || 50000) * 100), 100);
                return (
                  <tr key={s.id}>
                    <TD style={{ color: "var(--text3)" }}>{i + 1}</TD>
                    <TD style={{ fontWeight: 600 }}>{s.name}</TD>
                    <TD><Pill label={s.role || "—"} color="blue" /></TD>
                    {isAdmin && <TD right style={{ color: "var(--gold)", fontWeight: 600 }}>{INR(curSalary)}</TD>}
                    <TD right>
                      <span style={{ color: leavesTaken > quota ? "var(--red)" : "var(--green)", fontWeight: 600 }}>{leavesTaken}</span>
                      <span style={{ color: "var(--text3)", margin: "0 4px" }}>/</span>
                      <span style={{ color: leavesLeft > 0 ? "var(--green)" : "var(--red)" }}>{leavesLeft}</span>
                    </TD>
                    <TD right>
                      <span style={{ color: pct >= 100 ? "var(--green)" : "var(--blue)", fontWeight: 600 }}>{INR(billing)}</span>
                      <div style={{ height: 4, background: "var(--border2)", borderRadius: 4, marginTop: 4, overflow: "hidden", minWidth: 60 }}>
                        <div style={{ height: "100%", width: `${pct}%`, background: pct >= 100 ? "var(--green)" : pct >= 60 ? "var(--gold)" : "var(--blue)", borderRadius: 4 }} />
                      </div>
                      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>{pct}%</div>
                    </TD>
                    <TD right style={{ fontWeight: 700, color: "var(--text2)" }}>{INR(staffTInc)}</TD>
                    <TD right style={{ color: "var(--text3)", fontWeight: 700 }}>{INR(totalSale)}</TD>
                    <TD>
                      {filterMode === "year" ? (
                        <button
                          onClick={() => setSelectedStaffHistory(s.id === selectedStaffHistory ? null : s.id)}
                          style={{ background: s.id === selectedStaffHistory ? "var(--gold)" : "rgba(255,255,255,0.05)", border: "none", color: s.id === selectedStaffHistory ? "#000" : "var(--gold)", borderRadius: 6, width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all .2s" }}
                          title="View Monthly History"
                        >
                          <Icon name="log" size={14} />
                        </button>
                      ) : (
                        <span style={{ color: "var(--text3)", fontSize: 10 }} title="Switch to Yearly view to see month-by-month history">—</span>
                      )}
                    </TD>
                  </tr>
                );
              })}
              {branchStaff.length === 0 && <tr><td colSpan={6} style={{ textAlign: "center", padding: 24, color: "var(--text3)" }}>No staff in this branch</td></tr>}
            </tbody>
          </table>
        </Card>

        {/* Individual Staff Monthly History Breakdown — yearly view only */}
        {selectedStaffHistory && filterMode === "year" && (() => {
          const s = staff.find(x => x.id === selectedStaffHistory);
          if (!s) return null;
          const hist = [];
          for (let m = 1; m <= 12; m++) {
            if (!isPastYear && m > currentMonthNum) break; 
            const mPrefix = `${filterYear}-${String(m).padStart(2, '0')}`;
            const status = staffStatusForMonth(s, mPrefix);
            const mSal = proRataSalary(s, mPrefix, branches, salHistory, staff, globalSettings);
            const mLeaves = staffLeavesInMonth(s.id, mPrefix, leaves);
            
            // Performance for the month
            const mEntries = entries.filter(e => e.branch_id === b.id && e.date.startsWith(mPrefix));
            let mBilling = 0, mInc = 0;
            mEntries.forEach(ent => {
              const sb = (ent.staff_billing || []).find(x => x.staff_id === s.id);
              if (sb) {
                mBilling += (sb.billing || 0);
                mInc += (sb.staff_total_inc || (sb.incentive || 0) + (sb.mat_incentive || 0) + (sb.tips || 0));
              }
            });

            hist.push({ month: mPrefix, ...status, salary: mSal, leaves: mLeaves, billing: mBilling, incentive: mInc });
          }
          return (
            <div style={{ marginTop: 20, animation: "fadeIn .3s ease-out" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--gold)" }}>Monthly Attendance & Performance History: {s.name} ({filterYear})</div>
                <button onClick={() => setSelectedStaffHistory(null)} style={{ background: "none", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>CLOSE ✕</button>
              </div>
              <Card>
                <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
                  <thead><tr>
                    <TH>Month</TH><TH>Status</TH><TH right>Days Worked</TH><TH right>Leaves</TH><TH right>Billing</TH><TH right>Incentives</TH><TH right>Salary Drawn</TH>
                  </tr></thead>
                  <tbody>
                    {hist.map(h => (
                      <tr key={h.month}>
                        <TD style={{ fontWeight: 600 }}>{new Date(h.month + "-01").toLocaleString('default', { month: 'long' })}</TD>
                        <TD>
                          <Pill 
                            label={h.status.toUpperCase()} 
                            color={h.status === 'active' ? 'green' : h.status === 'partial' ? 'blue' : 'gray'} 
                          />
                        </TD>
                        <TD right style={{ fontWeight: 700 }}>{h.daysWorked} days</TD>
                        <TD right style={{ color: "var(--red)", fontWeight: 600 }}>{h.leaves > 0 ? h.leaves : "—"}</TD>
                        <TD right style={{ color: "var(--blue)", fontWeight: 700 }}>{INR(h.billing)}</TD>
                        <TD right style={{ color: "var(--text2)", fontWeight: 700 }}>{INR(h.incentive)}</TD>
                        <TD right style={{ color: "var(--gold)", fontWeight: 700 }}>{INR(h.salary)}</TD>
                      </tr>
                    ))}
                    <tr style={{ background: "var(--bg3)", borderTop: "2px solid var(--border2)" }}>
                      <TD style={{ fontWeight: 800, color: "var(--gold)" }}>YEARLY TOTAL</TD>
                      <TD colSpan={2}></TD>
                      <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{hist.reduce((s, x) => s + x.leaves, 0)}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--blue)" }}>{INR(hist.reduce((s, x) => s + x.billing, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--text2)" }}>{INR(hist.reduce((s, x) => s + x.incentive, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--gold)" }}>{INR(hist.reduce((s, x) => s + x.salary, 0))}</TD>
                    </tr>
                  </tbody>
                </table>
              </Card>
            </div>
          );
        })()}

        {/* Breakdown Table */}
        <div style={{ marginTop: 24, marginBottom: 24 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, color: "var(--gold)" }}>
            {filterMode === "month" ? "Daily Performance Breakdown" : "Monthly Performance Breakdown"} ({filterYear})
          </div>
            <Card>
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5 }}>
                <thead><tr>
                  <TH>{filterMode === "month" ? "Date" : "Month"}</TH>
                  <TH right>Income</TH>
                  <TH right>Inc.</TH>
                  <TH right>Mat.</TH>
                  <TH right>Petrol</TH>
                  <TH right>Rent (S)</TH>
                  <TH right>Rent (R)</TH>
                  <TH right>Elec.</TH>
                  <TH right>WiFi</TH>
                  <TH right>Salary</TH>
                  <TH right>{filterMode === "month" ? "Leave Entry" : "Leaves"}</TH>
                  <TH right>Net P&L</TH>
                </tr></thead>
                <tbody>
                  {breakdownStats.map(m => (
                    <tr key={m.label}>
                      <TD style={{ fontWeight: 600 }}>{m.label} {filterYear}</TD>
                      <TD right style={{ color: "var(--green)" }}>{INR(m.income)}</TD>
                      <TD right style={{ color: "var(--red)" }}>{INR(m.incentives)}</TD>
                      <TD right style={{ color: "var(--red)" }}>{INR(m.material)}</TD>
                      <TD right style={{ color: "var(--red)" }}>{INR(m.others)}</TD>
                      <TD right style={{ color: "var(--orange)" }}>{INR(m.shopRent)}</TD>
                      <TD right style={{ color: "var(--orange)" }}>{INR(m.roomRent)}</TD>
                      <TD right style={{ color: "var(--orange)" }}>{INR(m.elec)}</TD>
                      <TD right style={{ color: "var(--orange)" }}>{INR(m.wifi)}</TD>
                      <TD right style={{ color: "var(--blue)" }}>{INR(m.salary)}</TD>
                      <TD right style={{ fontWeight: 600, color: "var(--text3)" }}>{m.leaves}</TD>
                      <TD right style={{ fontWeight: 700, color: m.pl >= 0 ? "var(--green)" : "var(--red)" }}>{isAdmin ? (INR(m.pl)) : "•••••"}</TD>
                    </tr>
                  ))}
                  {breakdownStats.length > 0 && (
                    <tr style={{ background: "var(--bg3)", borderTop: "2px solid var(--border2)" }}>
                      <TD style={{ fontWeight: 800, color: "var(--gold)" }}>TOTAL ({plabel})</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--green)" }}>{INR(breakdownStats.reduce((s, m) => s + m.income, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{INR(breakdownStats.reduce((s, m) => s + m.incentives, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{INR(breakdownStats.reduce((s, m) => s + m.material, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{INR(breakdownStats.reduce((s, m) => s + m.others, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{INR(breakdownStats.reduce((s, m) => s + m.shopRent, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{INR(breakdownStats.reduce((s, m) => s + m.roomRent, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{INR(breakdownStats.reduce((s, m) => s + m.elec, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{INR(breakdownStats.reduce((s, m) => s + m.wifi, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--blue)" }}>{INR(breakdownStats.reduce((s, m) => s + m.salary, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--text2)" }}>{breakdownStats.reduce((s, m) => s + m.leaves, 0)}</TD>
                      <TD right style={{ fontWeight: 800, color: breakdownStats.reduce((s, m) => s + m.pl, 0) >= 0 ? "var(--green)" : "var(--red)" }}>
                        {isAdmin ? INR(breakdownStats.reduce((s, m) => s + m.pl, 0)) : "•••••"}
                      </TD>
                    </tr>
                  )}
                </tbody>
              </table>
            </Card>
          </div>

        {/* Materials Received */}
        {(() => {
          const branchAllocs = materialAllocations.filter(a => a.branch_id === b.id && (a.date || a.transferred_at || "").startsWith(filterMode === "year" ? String(filterYear) : filterPrefix));
          const flatRows = branchAllocs.flatMap(a =>
            (a.items || []).map((it, i) => ({
              ...it,
              date: a.date || (a.transferred_at || "").slice(0, 10),
              transferred_at: a.transferred_at,
              allocation_id: a.id,
              key: `${a.id}-${i}`,
            }))
          ).sort((x, y) => (y.date || "").localeCompare(x.date || ""));
          const totalReceived = flatRows.reduce((s, r) => s + (Number(r.line_total) || (Number(r.qty) * Number(r.price_at_transfer)) || 0), 0);
          return (
            <div style={{ marginTop: 24, marginBottom: 24 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 10 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--gold)" }}>
                  Materials Received ({flatRows.length}) — {filterMode === "year" ? String(filterYear) : plabel}
                </div>
                <div style={{ fontSize: 12, color: "var(--text3)" }}>
                  Total cost <strong style={{ color: "var(--accent)", fontSize: 14 }}>{INR(totalReceived)}</strong>
                  {flatRows.length > 0 && <span style={{ marginLeft: 8, fontSize: 10, color: "var(--text3)" }}>(added to the material expense for each transfer's date)</span>}
                </div>
              </div>
              <Card style={{ padding: 0 }}>
                <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5 }}>
                  <thead><tr>
                    <TH>Date</TH>
                    <TH>Material</TH>
                    <TH right>Qty</TH>
                    <TH>Unit</TH>
                    <TH right>Unit Price</TH>
                    <TH right>Line Total</TH>
                  </tr></thead>
                  <tbody>
                    {flatRows.map(r => (
                      <tr key={r.key}>
                        <TD style={{ whiteSpace: "nowrap", fontWeight: 600 }}>{r.date || "—"}</TD>
                        <TD style={{ fontWeight: 600 }}>{r.name}</TD>
                        <TD right style={{ color: "var(--blue)", fontWeight: 700 }}>{r.qty}</TD>
                        <TD style={{ color: "var(--text3)" }}>{r.unit || "pcs"}</TD>
                        <TD right style={{ color: "var(--text3)" }}>{INR(r.price_at_transfer || 0)}</TD>
                        <TD right style={{ color: "var(--green)", fontWeight: 800 }}>{INR(r.line_total || (Number(r.qty) * Number(r.price_at_transfer)) || 0)}</TD>
                      </tr>
                    ))}
                    {flatRows.length === 0 && (
                      <tr><td colSpan={6} style={{ textAlign: "center", padding: 24, color: "var(--text3)", fontStyle: "italic" }}>No materials transferred to this branch in this period.</td></tr>
                    )}
                    {flatRows.length > 0 && (
                      <tr style={{ background: "var(--bg3)", borderTop: "2px solid var(--border2)" }}>
                        <TD style={{ fontWeight: 800, color: "var(--gold)" }} colSpan={5}>TOTAL</TD>
                        <TD right style={{ fontWeight: 800, color: "var(--accent)" }}>{INR(totalReceived)}</TD>
                      </tr>
                    )}
                  </tbody>
                </table>
              </Card>
            </div>
          );
        })()}

        {/* Recent Entries */}
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, color: "var(--gold)" }}>Recent Entries</div>
        <Card>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5 }}>
            <thead><tr>
              <TH>Date</TH><TH right>Online</TH><TH right>Cash</TH><TH right>GST</TH><TH right>Billing</TH><TH right>Incentive</TH><TH right>Staff T.Inc</TH><TH right>Staff T.Sale</TH><TH right>Cash in Hand</TH>
              {canEdit && <TH sticky> </TH>}
            </tr></thead>
            <tbody>
              {periodEntries.slice(0, 15).map(e => {
                const totalBillingE = (e.staff_billing || []).reduce((s, sb) => s + (sb.billing || 0), 0);
                const totalMatE = (e.staff_billing || []).reduce((s, sb) => s + (sb.material || 0), 0);
                const totalIncE = (e.staff_billing || []).reduce((s, sb) => s + (sb.incentive || 0) + (sb.mat_incentive || 0), 0);
                const totalTipsE = (e.staff_billing || []).reduce((s, sb) => s + (sb.tips || 0), 0);
                const staffTIncE = (e.staff_billing || []).reduce((s, sb) => s + (sb.staff_total_inc || 0), 0);
                const staffTSaleE = totalBillingE + totalMatE + totalTipsE;
                const cih = e.cash_in_hand !== undefined ? e.cash_in_hand : (e.cash || 0) - totalIncE - totalTipsE - (e.others || 0);
                return (
                  <tr key={e.id}>
                    <TD style={{ fontWeight: 600 }}>{e.date}</TD>
                    <TD right style={{ color: "var(--green)" }}>{INR(e.online || 0)}</TD>
                    <TD right style={{ color: "var(--green)" }}>{INR(e.cash || 0)}</TD>
                    <TD right style={{ color: "var(--green)" }}>{INR(e.total_gst || 0)}</TD>
                    <TD right style={{ fontWeight: 600, color: "var(--green)" }}>{INR(totalBillingE)}</TD>
                    <TD right style={{ color: "var(--red)" }}>{INR(totalIncE)}</TD>
                    <TD right style={{ color: "var(--gold)", fontWeight: 700 }}>{INR(staffTIncE)}</TD>
                    <TD right style={{ color: "var(--text2)", fontWeight: 700 }}>{INR(staffTSaleE)}</TD>
                    <TD right style={{ fontWeight: 700, color: cih >= 0 ? "var(--green)" : "var(--red)" }}>{INR(cih)}</TD>
                    {canEdit && <TD sticky><div style={{ display: "flex", gap: 6 }}>
                      <IconBtn name="log" title="View log" variant="secondary" onClick={() => setLogView(e)} />
                      <IconBtn name="edit" title="Edit" variant="secondary" onClick={() => router.push(`/dashboard/entry?edit=${e.id}`)} />
                      <IconBtn name="del" title="Delete" variant="danger" onClick={() => handleDeleteEntry(e.id)} />
                    </div></TD>}
                  </tr>
                );
              })}
              {periodEntries.length === 0 && <tr><td colSpan={7} style={{ textAlign: "center", padding: 24, color: "var(--text3)" }}>No entries for this period</td></tr>}
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
        {attendanceModalEl}
        {recalcModalEl}
        {ConfirmDialog}
        {ToastContainer}
      </div>
    );
  }

  // ── Main Branch List ─────────────────────────────────────────────
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>Branches</div>
        {isAdmin && <button onClick={() => { setForm({ name: "", type: "mens", location: "", shop_rent: "", room_rent: "", salary_budget: "", wifi: "", shop_elec: "", room_elec: "" }); setEditId(null); setShowForm(!showForm); }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderRadius: 10, background: "linear-gradient(135deg,var(--gold),var(--gold2))", color: "#000", border: "none", cursor: "pointer", fontWeight: 700, fontSize: 13 }}>
          <Icon name="plus" size={14} /> Add Branch
        </button>}
      </div>

      <PeriodWidget filterMode={filterMode} setFilterMode={setFilterMode} filterYear={filterYear} setFilterYear={setFilterYear} filterMonth={filterMonth} setFilterMonth={setFilterMonth} />

      {/* Bulk recalculate action bar */}
      {canEdit && selectedBranches.size > 0 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "10px 16px", marginBottom: 12, borderRadius: 10, background: "linear-gradient(135deg, rgba(96,165,250,0.10), rgba(34,211,238,0.06))", border: "1px solid rgba(96,165,250,0.25)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
            <span style={{ fontWeight: 800, color: "var(--blue, #60a5fa)" }}>{selectedBranches.size}</span>
            <span style={{ color: "var(--text2)", fontWeight: 600 }}>branch{selectedBranches.size === 1 ? "" : "es"} selected</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={clearBranchSelection}
              style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 11, cursor: "pointer" }}>
              Clear
            </button>
            <button onClick={openBulkRecalc}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, background: "linear-gradient(135deg, var(--accent), var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>
              <Icon name="check" size={13} /> Recalculate Selected
            </button>
          </div>
        </div>
      )}

      {/* Add/Edit Form */}
      {showForm && isAdmin && (
        <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: "inset 0 2px 10px rgba(0,0,0,.2)" }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 16, paddingBottom: 10, borderBottom: "1px solid var(--border)", color: "var(--gold)", textTransform: "uppercase" }}>{editId ? "Edit Branch" : "Add Branch"}</div>
          <form onSubmit={handleSave}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 12, marginBottom: 16 }}>
              {[["Name","name","text"],["Location","location","text"],["Shop Rent","shop_rent","number"],["Room Rent","room_rent","number"],["Salary Budget","salary_budget","number"],["WiFi","wifi","number"],["Shop Electricity","shop_elec","number"],["Room Electricity","room_elec","number"]].map(([label, key, type]) => (
                <div key={key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={{ fontSize: 12, color: "var(--text2)", fontWeight: 700, textTransform: "capitalize", letterSpacing: 1 }}>{label}</label>
                  <input type={type} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} style={{ padding: "12px 16px", border: "2px solid var(--input-border)", borderRadius: 10, fontSize: 14, background: "var(--bg2)", color: "var(--text)", fontFamily: "var(--font-outfit)", width: "100%", outline: "none" }} />
                </div>
              ))}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 12, color: "var(--text2)", fontWeight: 700, textTransform: "capitalize", letterSpacing: 1 }}>Type</label>
                <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} style={{ padding: "12px 16px", border: "2px solid var(--input-border)", borderRadius: 10, fontSize: 14, background: "var(--bg2)", color: "var(--text)", fontFamily: "var(--font-outfit)", width: "100%", outline: "none" }}>
                  <option value="mens">Mens</option>
                  <option value="unisex">Unisex</option>
                </select>
              </div>
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
              <button type="submit" style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 18px", borderRadius: 10, background: "linear-gradient(135deg,var(--gold),var(--gold2))", color: "#000", border: "none", cursor: "pointer", fontWeight: 700 }}>
                <Icon name="save" size={14} /> {editId ? "Update" : "Save"} Branch
              </button>
              <button type="button" onClick={() => setShowForm(false)} style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", cursor: "pointer", fontWeight: 600 }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", marginBottom: 16 }}>
        <ToggleGroup label="P&L" options={[["all","All"],["profit","Profit"],["loss","Loss"]]} value={brFilter} onChange={setBrFilter} />
        <ToggleGroup label="Type" options={[["all","All"],["mens","Mens"],["unisex","Unisex"]]} value={brTypeFilter} onChange={setBrTypeFilter} />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".5px" }}>Sort</span>
          <select value={brSortCol} onChange={e => setBrSortCol(e.target.value)} style={{ padding: "4px 8px", border: "1px solid var(--border2)", borderRadius: 16, fontSize: 11, background: "var(--bg4)", color: "var(--text)", fontFamily: "var(--font-outfit)" }}>
            <option value="name">Name</option><option value="income">Income</option><option value="pl">Net P&L</option><option value="expense">Expenses</option>
          </select>
          <ToggleGroup options={[["asc","Asc ↑"],["desc","Desc ↓"]]} value={brSortDir} onChange={setBrSortDir} />
        </div>
        <div style={{ marginLeft: "auto" }}>
          <ToggleGroup label="View" options={[["card","⬛ Cards"],["table","☰ Table"]]} value={brView} onChange={setBrView} />
        </div>
      </div>

      {/* Table View */}
      {brView === "table" ? (
        <Card style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 11.5, minWidth: 1000 }}>
            <thead><tr>
              {canEdit && (
                <TH style={{ width: 32, textAlign: "center" }}>
                  <input type="checkbox"
                    checked={branchData.length > 0 && selectedBranches.size === branchData.length}
                    onChange={() => {
                      if (selectedBranches.size === branchData.length) clearBranchSelection();
                      else setSelectedBranches(new Set(branchData.map(d => d.b.id)));
                    }}
                    style={{ cursor: "pointer", accentColor: "var(--accent)" }} />
                </TH>
              )}
              <TH>Branch</TH>
              <TH>Type</TH>
              <TH right>Income</TH>
              <TH right>Inc.</TH>
              <TH right>Mat.</TH>
              <TH right>Petrol</TH>
              <TH right>Rent (S)</TH>
              <TH right>Rent (R)</TH>
              <TH right>Elec.</TH>
              <TH right>WiFi</TH>
              <TH right>Salary</TH>
              <TH right>Leaves</TH>
              <TH right>Net P&L</TH>
            </tr></thead>
            <tbody>
              {branchData.map(({ b, i, vInc, vMatE, vPetrol, fShopRent, fRoomRent, fElec, fWifi, actualSalary, actualLeaves, n }) => (
                <tr key={b.id} style={{ cursor: "pointer" }} onClick={() => setSelectedBranch(b.id)}>
                  {canEdit && (
                    <TD style={{ textAlign: "center" }} onClick={e => { e.stopPropagation(); toggleBranchSelect(b.id); }}>
                      <input type="checkbox" readOnly checked={selectedBranches.has(b.id)}
                        style={{ cursor: "pointer", accentColor: "var(--accent)" }} />
                    </TD>
                  )}
                  <TD style={{ fontWeight: 700, whiteSpace: "nowrap" }}>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <button onClick={e => { e.stopPropagation(); setAttendanceCalendar(b.id); setAttendanceMonth(filterMode === "month" ? filterPrefix : `${filterYear}-${String(NOW.getMonth() + 1).padStart(2, "0")}`); setAttendanceSelectedDay(null); }}
                        title="Attendance calendar"
                        style={{ background: "rgba(var(--accent-rgb),0.08)", border: "1px solid rgba(var(--accent-rgb),0.3)", color: "var(--accent)", borderRadius: 6, padding: "2px 6px", cursor: "pointer", fontSize: 11, lineHeight: 1 }}>📅</button>
                      <span>{b.name.replace("V-CUT ", "")}</span>
                    </div>
                  </TD>
                  <TD><Pill label={b.type === "unisex" ? "Unisex" : "Mens"} color={b.type === "unisex" ? "purple" : "blue"} /></TD>
                  <TD right style={{ color: "var(--green)", fontWeight: 600 }}>{INR(i)}</TD>
                  <TD right style={{ color: "var(--red)" }}>{INR(vInc)}</TD>
                  <TD right style={{ color: "var(--red)" }}>{INR(vMatE)}</TD>
                  <TD right style={{ color: "var(--red)" }}>{INR(vPetrol)}</TD>
                  <TD right style={{ color: "var(--orange)" }}>{INR(fShopRent)}</TD>
                  <TD right style={{ color: "var(--orange)" }}>{INR(fRoomRent)}</TD>
                  <TD right style={{ color: "var(--orange)" }}>{INR(fElec)}</TD>
                  <TD right style={{ color: "var(--orange)" }}>{INR(fWifi)}</TD>
                  <TD right style={{ color: "var(--blue)" }}>{isAdmin ? INR(actualSalary) : MASK}</TD>
                  <TD right style={{ color: "var(--text3)", fontWeight: 600 }}>{actualLeaves}</TD>
                  <TD right style={{ fontWeight: 700, color: n >= 0 ? "var(--green)" : "var(--red)" }}>
                    {isAdmin ? (INR(n)) : MASK}
                  </TD>
                </tr>
              ))}
              {branchData.length > 0 && (
                <tr style={{ background: "var(--bg3)", borderTop: "2px solid var(--border2)" }}>
                  {canEdit && <TD></TD>}
                  <TD style={{ fontWeight: 800, color: "var(--gold)" }}>TOTAL ({plabel})</TD>
                  <TD> </TD>
                  <TD right style={{ fontWeight: 800, color: "var(--green)" }}>{INR(branchData.reduce((s, d) => s + d.i, 0))}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{INR(branchData.reduce((s, d) => s + d.vInc, 0))}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{INR(branchData.reduce((s, d) => s + d.vMatE, 0))}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{INR(branchData.reduce((s, d) => s + d.vPetrol, 0))}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{INR(branchData.reduce((s, d) => s + d.fShopRent, 0))}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{INR(branchData.reduce((s, d) => s + d.fRoomRent, 0))}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{INR(branchData.reduce((s, d) => s + d.fElec, 0))}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{INR(branchData.reduce((s, d) => s + d.fWifi, 0))}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--blue)" }}>{isAdmin ? INR(branchData.reduce((s, d) => s + d.actualSalary, 0)) : MASK}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--text2)" }}>{branchData.reduce((s, d) => s + d.actualLeaves, 0)}</TD>
                  <TD right style={{ fontWeight: 800, color: branchData.reduce((s, d) => s + d.n, 0) >= 0 ? "var(--green)" : "var(--red)" }}>
                    {isAdmin ? INR(branchData.reduce((s, d) => s + d.n, 0)) : MASK}
                  </TD>
                </tr>
              )}
              {branchData.length === 0 && <tr><td colSpan={canEdit ? 14 : 13} style={{ textAlign: "center", padding: 20, color: "var(--text3)" }}>No branches match filters</td></tr>}
            </tbody>
          </table>
        </Card>
      ) : (
        /* Card View */
        <DraggableBranchGrid
           branchData={branchData}
           isAdmin={isAdmin}
           canSelect={canEdit}
           selectedBranches={selectedBranches}
           onToggleSelect={toggleBranchSelect}
           onCardClick={setSelectedBranch}
           onCalendarClick={(bid) => { setAttendanceCalendar(bid); setAttendanceMonth(filterMode === "month" ? filterPrefix : `${filterYear}-${String(NOW.getMonth() + 1).padStart(2, "0")}`); setAttendanceSelectedDay(null); }}
        />
      )}
      {attendanceModalEl}
      {recalcModalEl}
      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}

// ─── Draggable Branch Card Grid (Branches Page Version) ────────────────────────

function DraggableBranchGrid({ branchData, isAdmin, canSelect, selectedBranches, onToggleSelect, onCardClick, onCalendarClick }) {
  const [cardOrder, setCardOrder] = useState([]);
  const [dragOver, setDragOver] = useState(null);
  const [dragging, setDragging] = useState(null);
  const dragId = useRef(null);
  const wasDragged = useRef(false);

  // Build ordered list using cardOrder (array of branch ids), fallback to branchData order
  const ordered = (() => {
    if (cardOrder.length === 0) return branchData;
    const map = Object.fromEntries(branchData.map(d => [d.b.id, d]));
    const list = cardOrder.map(id => map[id]).filter(Boolean);
    // Add any new ones
    branchData.forEach(d => { if (!cardOrder.includes(d.b.id)) list.push(d); });
    return list;
  })();

  const handleDragStart = (e, bid) => {
    wasDragged.current = true;
    dragId.current = bid;
    setDragging(bid);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", bid);
    }
  };

  const handleDragOver = (e, bid) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (dragId.current !== bid) setDragOver(bid);
  };

  const handleDrop = (e, targetId) => {
    e.preventDefault();
    const srcId = dragId.current;
    if (!srcId || srcId === targetId) { setDragOver(null); return; }
    const ids = ordered.map(d => d.b.id);
    const srcIdx = ids.indexOf(srcId);
    const tgtIdx = ids.indexOf(targetId);
    const newIds = [...ids];
    newIds.splice(srcIdx, 1);
    newIds.splice(tgtIdx, 0, srcId);
    setCardOrder(newIds);
    setDragOver(null);
  };

  const handleDragEnd = () => {
    dragId.current = null;
    setDragging(null);
    setDragOver(null);
    setTimeout(() => { wasDragged.current = false; }, 100);
  };

  const handleClick = (e, bid) => {
    if (wasDragged.current) {
      e.preventDefault();
      return;
    }
    onCardClick(bid);
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 16 }}>
      {ordered.map(({ b, i, vInc, vMatE, vOther, fShopRent, fRoomRent, fWifi, fElec, actualSalary, actualLeaves, n, staffCount, totalDeficit, totalExcess, netDiff, reconciledDays }) => {
        const isDragging = dragging === b.id;
        const isOver = dragOver === b.id;
        
        return (
          <div key={b.id} 
            draggable="true"
            onDragStart={(ev) => handleDragStart(ev, b.id)}
            onDragOver={(ev) => handleDragOver(ev, b.id)}
            onDrop={(ev) => handleDrop(ev, b.id)}
            onDragEnd={handleDragEnd}
            onClick={(ev) => handleClick(ev, b.id)}
            style={{ 
              background: "linear-gradient(160deg,var(--bg3),var(--bg2))", 
              border: isOver ? "2px dashed var(--gold)" : `2px solid ${n >= 0 ? "var(--green)" : "var(--red)"}`, 
              borderRadius: 12, 
              overflow: "hidden", 
              cursor: isDragging ? "grabbing" : "grab", 
              transition: "transform .2s, box-shadow .2s, border .2s", 
              opacity: isDragging ? 0.4 : 1,
              transform: isOver ? "scale(1.02)" : "scale(1)",
              boxShadow: isOver
                ? "0 8px 24px rgba(var(--gold-rgb),0.25)"
                : isDragging
                  ? "0 12px 32px rgba(0,0,0,0.5)"
                  : n >= 0 ? "0 4px 16px rgba(74,222,128,.15)" : "0 4px 16px rgba(248,113,113,.15)",
              userSelect: "none"
            }}
            onMouseEnter={ev => {
              if (!isDragging) ev.currentTarget.style.transform = "translateY(-2px)";
            }}
            onMouseLeave={ev => {
              if (!isDragging && !isOver) ev.currentTarget.style.transform = "scale(1)";
            }}
          >
            <div style={{ background: "var(--bg4)", borderBottom: "1px solid var(--border)", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 13, color: "var(--gold)", letterSpacing: "0.5px" }}>
              {canSelect && (
                <input type="checkbox" readOnly
                  checked={selectedBranches?.has(b.id) || false}
                  onClick={ev => { ev.stopPropagation(); onToggleSelect?.(b.id); }}
                  onMouseDown={ev => ev.stopPropagation()}
                  style={{ cursor: "pointer", accentColor: "var(--accent)", flexShrink: 0 }}
                  title="Select for bulk recalculate" />
              )}
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
              <button onClick={ev => { ev.stopPropagation(); onCalendarClick?.(b.id); }}
                title="Attendance calendar"
                style={{ background: "rgba(var(--accent-rgb),0.1)", border: "1px solid rgba(var(--accent-rgb),0.35)", color: "var(--accent)", borderRadius: 6, padding: "2px 8px", cursor: "pointer", fontSize: 13, lineHeight: 1 }}>📅</button>
              <Pill label={b.type === "unisex" ? "Unisex" : "Mens"} color={b.type === "unisex" ? "purple" : "blue"} />
            </div>
            <div style={{ padding: "14px 16px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px 8px" }}>
                <CompactStat label="Income" val={INR(i)} col="var(--green)" />
                <CompactStat label="P&L" val={isAdmin ? (INR(n)) : "•••"} col={n >= 0 ? "var(--green)" : "var(--red)"} bold />
                <CompactStat label="Salary" val={isAdmin ? INR(actualSalary) : "•••"} col="var(--blue)" />
                <CompactStat label="Inc/Mat" val={INR(vInc + vMatE)} col="var(--red)" />
                <CompactStat label="Rent (S)" val={INR(fShopRent)} col="var(--orange)" />
                <CompactStat label="Rent (R)" val={INR(fRoomRent)} col="var(--orange)" />
                <CompactStat label="Travel" val={INR(vOther)} col="var(--red)" />
                <CompactStat label="Elec/Wifi" val={INR(fElec + fWifi)} col="var(--orange)" />
                <CompactStat label="Leaves" val={actualLeaves + " d"} col="var(--text3)" />
                <CompactStat label="Deficit" val={totalDeficit ? INR(totalDeficit) : "—"} col={totalDeficit ? "var(--red)" : "var(--text3)"} />
                <CompactStat label="Excess" val={totalExcess ? INR(totalExcess) : "—"} col={totalExcess ? "var(--green)" : "var(--text3)"} />
                <CompactStat label={`Net (${reconciledDays}d)`} val={reconciledDays ? (netDiff === 0 ? "✓ Match" : (netDiff > 0 ? "+" : "") + INR(netDiff)) : "—"} col={!reconciledDays ? "var(--text3)" : netDiff === 0 ? "var(--green)" : netDiff > 0 ? "var(--green)" : "var(--red)"} bold />
              </div>
              <div style={{ marginTop: 14, textAlign: "center", fontSize: 10, color: "var(--gold)", fontWeight: 600, opacity: 0.7, borderTop: "1px solid var(--border)", paddingTop: 10, letterSpacing: 0.5 }}>
                ⋮⋮ DRAG TO REORDER · CLICK TO EXPAND
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CompactStat({ label, val, col, bold }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 7, color: "var(--text3)", textTransform: "uppercase", fontWeight: 700, marginBottom: 1 }}>{label}</div>
      <div style={{ fontSize: 10.5, fontWeight: bold ? 800 : 700, color: col, whiteSpace: "nowrap" }}>{val}</div>
    </div>
  );
}
