"use client";
import { useEffect, useState, useRef } from "react";
import { collection, onSnapshot, query, orderBy, deleteDoc, doc, addDoc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR, branchIncomeInPeriod, makeFilterPrefix, periodLabel, proRataSalary, staffLeavesInMonth, staffStatusForMonth, MASK } from "@/lib/calculations";
import { Icon, IconBtn, Pill, Card, PeriodWidget, ToggleGroup, TH, TD, useConfirm, useToast } from "@/components/ui";
import { useRouter } from "next/navigation";

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

    if (bid)  setSelectedBranch(bid);
    if (mode) setFilterMode(mode);
    if (yr)   setFilterYear(Number(yr));
    if (mo)   setFilterMonth(Number(mo));

    // Optional: Clean URL params to avoid re-syncing on refresh if user changes it
    if (bid || mode || yr || mo) {
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

    return { 
      b, 
      i: income, 
      e: expenses, 
      n: net, 
      staffCount: staff.filter(s => s.branch_id === b.id).length, 
      vInc, vMatE, vOther, vPetrol,
      fShopRent, fRoomRent, fWifi, fElec,
      actualSalary, actualLeaves,
      totalGst, factor 
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

  if (loading) return <div style={{ textAlign: "center", color: "var(--gold)", fontWeight: 700, padding: 40 }}>Loading branches...</div>;

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
        const activeStaffInMonth = staff.filter(s => s.branch_id === b.id && staffStatusForMonth(s, filterPrefix).status !== 'inactive');
        const mActualSalary = activeStaffInMonth.reduce((s, st) => s + proRataSalary(st, filterPrefix, branches, salHistory, staff, globalSettings), 0);
        const dSalary = mActualSalary * dayFactor;
        
        // Leaves on this specific date
        const dLeaves = leaves.filter(l => l.staff_id && activeStaffInMonth.some(as => as.id === l.staff_id) && l.status === 'approved' && l.date === dayPrefix).reduce((s, l) => s + (l.days || 1), 0);

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
                  <TD style={{ fontWeight: 700, whiteSpace: "nowrap" }}>{b.name.replace("V-CUT ", "")}</TD>
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
              {branchData.length === 0 && <tr><td colSpan={12} style={{ textAlign: "center", padding: 20, color: "var(--text3)" }}>No branches match filters</td></tr>}
            </tbody>
          </table>
        </Card>
      ) : (
        /* Card View */
        <DraggableBranchGrid 
           branchData={branchData}
           isAdmin={isAdmin}
           onCardClick={setSelectedBranch}
        />
      )}
      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}

// ─── Draggable Branch Card Grid (Branches Page Version) ────────────────────────

function DraggableBranchGrid({ branchData, isAdmin, onCardClick }) {
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
      {ordered.map(({ b, i, vInc, vMatE, vOther, fShopRent, fRoomRent, fWifi, fElec, actualSalary, actualLeaves, n, staffCount }) => {
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
            <div style={{ background: "var(--bg4)", borderBottom: "1px solid var(--border)", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", fontWeight: 700, fontSize: 13, color: "var(--gold)", letterSpacing: "0.5px" }}>
              <span>{b.name}</span>
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
