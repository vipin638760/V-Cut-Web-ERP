"use client";
import { useEffect, useState } from "react";
import { collection, onSnapshot, query, orderBy, doc, deleteDoc, setDoc, addDoc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import {
  INR, ROLES,
  staffOverallStatus, staffStatusForMonth, staffLeavesInMonth,
  staffBillingInPeriod, lastMonthData, proRataSalary, makeFilterPrefix, periodLabel,
  getStaffSalaryForMonth
} from "@/lib/calculations";
import { MONTHS } from "@/lib/constants";
import { Icon, IconBtn, Pill, Card, PeriodWidget, TH, TD, StatCard, ProgressBar, Modal, useConfirm, useToast } from "@/components/ui";


const NOW = new Date();

export default function StaffPage() {
  const [staff, setStaff] = useState([]);
  const [branches, setBranches] = useState([]);
  const [entries, setEntries] = useState([]);
  const [leaves, setLeaves] = useState([]);
  const [salaryHistory, setSalaryHistory] = useState([]);
  const [statusLog, setStatusLog] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [globalSettings, setGlobalSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [historyModal, setHistoryModal] = useState(null); // staff object
  const [monthlyLogModal, setMonthlyLogModal] = useState(null); // staff object for yearly breakdown
  const [transferModal, setTransferModal] = useState(null); // staff object being transferred
  const [transferForm, setTransferForm] = useState({ to_branch_id: "", start_date: "", end_date: "", reason: "" });

  // Period filter state
  const [filterMode, setFilterMode] = useState("month");
  const [filterYear, setFilterYear] = useState(NOW.getFullYear());
  const [filterMonth, setFilterMonth] = useState(NOW.getMonth() + 1);
  const filterPrefix = makeFilterPrefix(filterYear, filterMonth);

  // UI state
  const [branchFilter, setBranchFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [roleFilter, setRoleFilter] = useState("all"); // all | mens | unisex
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);

  // Attendance calendar (per-staff, per-month)
  const [attendanceModal, setAttendanceModal] = useState(null); // { staff, month: "YYYY-MM" }
  const [attendanceOverrides, setAttendanceOverrides] = useState([]); // overlay rows from staff_attendance
  const [editingDay, setEditingDay] = useState(null); // "YYYY-MM-DD" or null
  const [dayDraft, setDayDraft] = useState({ present: true, branch_id: "", note: "" });

  // Form state
  const [form, setForm] = useState({ name: "", branch_id: "", role: "", mobile: "", salary: "", incentive_pct: "10", target: "", join: "", exit_date: "" });
  const [increment, setIncrement] = useState("");

  // Status toggle pending state
  const [pendingStatus, setPendingStatus] = useState({}); // { staffId: { open: bool, date: string, newStatus: bool } }

  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const currentUser = useCurrentUser() || {};
  const isAdmin = currentUser?.role === "admin";
  const isAccountant = currentUser?.role === "accountant";
  const canEdit = currentUser?.role === "admin" || currentUser?.role === "accountant";

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "staff"), sn => setStaff(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(query(collection(db, "entries"), orderBy("date", "desc")), sn => setEntries(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "leaves"), sn => setLeaves(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(doc(db, "settings", "global"), sn => setGlobalSettings(sn.data())),
      onSnapshot(query(collection(db, "staff_status_log"), orderBy("at", "desc")), sn => setStatusLog(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(query(collection(db, "staff_transfers"), orderBy("start_date", "desc")), sn => setTransfers(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(query(collection(db, "salary_history"), orderBy("effective_from", "asc")), sn => {
        setSalaryHistory(sn.docs.map(d => ({ ...d.data(), id: d.id })));
        setLoading(false);
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  // Subscribe to staff_attendance overlay for the currently-viewed staff/month.
  // Overlay wins over entries-derived presence when both exist for the same date.
  useEffect(() => {
    if (!db || !attendanceModal) return;
    const { staff: s, month } = attendanceModal;
    const [yr, mo] = month.split("-").map(Number);
    const start = `${month}-01`;
    const endDate = new Date(yr, mo, 0).toISOString().slice(0, 10);
    const q = query(
      collection(db, "staff_attendance"),
      orderBy("date", "asc"),
    );
    const unsub = onSnapshot(q, sn => {
      const rows = sn.docs.map(d => ({ ...d.data(), id: d.id }))
        .filter(r => r.staff_id === s.id && r.date >= start && r.date <= endDate);
      setAttendanceOverrides(rows);
    });
    return () => unsub();
  }, [attendanceModal]);

  const statusRefMon = filterMode === "month" ? filterPrefix : filterYear + "-" + String(NOW.getMonth() + 1).padStart(2, "0");

  // Filtered list
  let filtered = branchFilter ? staff.filter(s => s.branch_id === branchFilter) : [...staff];
  if (statusFilter === "active") filtered = filtered.filter(s => staffOverallStatus(s, statusRefMon) === "active");
  else if (statusFilter === "inactive") filtered = filtered.filter(s => staffOverallStatus(s, statusRefMon) !== "active");
  if (roleFilter === "mens") filtered = filtered.filter(s => (s.role || "").toLowerCase().includes("mens"));
  else if (roleFilter === "unisex") filtered = filtered.filter(s => (s.role || "").toLowerCase().includes("unisex"));
  // For admin, hide pending-setup staff from the main table (they appear in the Pending Setup section above)
  if (isAdmin) filtered = filtered.filter(s => !s.pending_setup);

  const totalActive = staff.filter(s => staffOverallStatus(s, statusRefMon) === "active").length;
  const totalInactive = staff.filter(s => staffOverallStatus(s, statusRefMon) !== "active").length;

  // Last month label
  const lmDate = new Date(NOW.getFullYear(), NOW.getMonth() - 1, 1);
  const lmLabel = lmDate.toLocaleString("default", { month: "long", year: "numeric" });

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.name || !form.branch_id) { confirm({ title: "Missing Fields", message: "Name and Branch are required.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} }); return; }
    if (!form.join) { confirm({ title: "Joining Date Required", message: "Please select the joining date before saving.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} }); return; }

    // Accountant adding a new staff member: auto-apply default salary of ₹15,000 (they cannot edit salary).
    // For edits, accountant must never change salary — preserve the existing value.
    let effectiveSalary = Number(form.salary) || 0;
    if (isAccountant) {
      if (editId) {
        const existing = staff.find(x => x.id === editId);
        effectiveSalary = Number(existing?.salary) || 0;
      } else {
        effectiveSalary = 15000;
      }
    }

    const payload = {
      name: form.name.trim(),
      branch_id: form.branch_id,
      role: form.role,
      mobile: form.mobile,
      salary: effectiveSalary,
      incentive_pct: Number(form.incentive_pct) || 10,
      target: Number(form.target) || 50000,
      join: form.join || null,
      exit_date: form.exit_date || null,
    };

    // Mark accountant-added new staff as pending admin setup; admin clears it on save
    if (isAccountant && !editId) {
      payload.pending_setup = true;
      payload.added_by_role = "accountant";
    }
    if (isAdmin && editId) {
      payload.pending_setup = false;
    }
    try {
      if (editId) {
        const existing = staff.find(x => x.id === editId);
        await updateDoc(doc(db, "staff", editId), payload);
        // Log salary change if salary was modified
        if (existing && Number(existing.salary) !== Number(payload.salary)) {
          // If this is the admin's first setup of an accountant-added staff, backdate the
          // effective date to the joining date so salary calculations start from day 1.
          const isInitialAdminSetup = isAdmin && existing.pending_setup;
          const effectiveFrom = isInitialAdminSetup
            ? (payload.join || existing.join || new Date().toISOString().split("T")[0])
            : new Date().toISOString().split("T")[0];
          await addDoc(collection(db, "salary_history"), {
            staff_id: editId,
            staff_name: payload.name,
            old_salary: isInitialAdminSetup ? 0 : (Number(existing.salary) || 0),
            salary: Number(payload.salary) || 0,
            effective_from: effectiveFrom,
            changed_by: currentUser?.name || "admin",
            changed_at: new Date().toISOString(),
            note: isInitialAdminSetup ? "Initial salary set by admin (backdated to joining date)" : undefined,
          });
        }
      } else {
        await addDoc(collection(db, "staff"), payload);
      }
      const wasEdit = !!editId;
      const savedName = payload.name;
      setShowForm(false);
      setEditId(null);
      setForm({ name: "", branch_id: "", role: "", mobile: "", salary: "", incentive_pct: "10", target: "", join: "", exit_date: "" });
      toast({ title: wasEdit ? "Record Updated" : "Employee Added", message: `${savedName} has been ${wasEdit ? 'updated' : 'added'} successfully.`, type: "success" });
    } catch (err) {
      confirm({ title: "Save Failed", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    }
  };

  const handleEdit = (s) => {
    setForm({
      name: s.name || "", branch_id: s.branch_id || "", role: s.role || "", mobile: s.mobile || "",
      salary: s.salary || "", incentive_pct: s.incentive_pct ?? 10, target: s.target || "",
      join: s.join || "", exit_date: s.exit_date || "",
    });
    setEditId(s.id);
    setIncrement("");
    setShowForm(true);
  };

  const handleDelete = (sid) => {
    const s = staff.find(x => x.id === sid);
    confirm({
      title: "Delete Employee",
      message: `<strong>${s?.name || 'this employee'}</strong>, are you sure you want to permanently delete this record? This action cannot be undone.`,
      confirmText: "Yes, Delete",
      cancelText: "No, Keep",
      type: "danger",
      onConfirm: async () => {
        try { await deleteDoc(doc(db, "staff", sid)); toast({ title: "Deleted", message: `${s?.name || 'Employee'} has been removed.`, type: "success" }); }
        catch (err) { confirm({ title: "Error", message: err.message, confirmText: "OK", type: "warning", onConfirm: () => {} }); }
      }
    });
  };

  const handleToggleStatus = (s, checked) => {
    const dateVal = new Date().toISOString().slice(0, 10);
    setPendingStatus(prev => ({ ...prev, [s.id]: { open: true, date: dateVal, goingActive: checked } }));
  };

  const confirmStatusChange = async (sid) => {
    const pending = pendingStatus[sid];
    if (!pending) return;
    try {
      const s = staff.find(x => x.id === sid);
      const update = pending.goingActive ? { exit_date: null } : { exit_date: pending.date };
      await updateDoc(doc(db, "staff", sid), update);
      // Non-blocking log
      addDoc(collection(db, "staff_status_log"), {
        staff_id: sid,
        staff_name: s?.name,
        date: pending.date,
        action: pending.goingActive ? "activated" : "deactivated",
        by: currentUser?.name || "user",
        at: new Date().toISOString(),
      }).catch(() => {});
      toast({ title: pending.goingActive ? "Activated" : "Deactivated", message: `${s?.name} has been ${pending.goingActive ? 'activated' : 'deactivated'}.`, type: pending.goingActive ? "success" : "warning" });
    } catch (err) { confirm({ title: "Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} }); }
    setPendingStatus(prev => { const n = { ...prev }; delete n[sid]; return n; });
  };

  // Active transfer for a staff member = status 'active' and today within start..end (or no end)
  const todayStr = new Date().toISOString().slice(0, 10);
  const getActiveTransfer = (sid) => transfers.find(t =>
    t.staff_id === sid && t.status === "active" &&
    (!t.start_date || t.start_date <= todayStr) &&
    (!t.end_date || t.end_date >= todayStr)
  );

  const openTransfer = (s) => {
    setTransferForm({ to_branch_id: "", start_date: todayStr, end_date: "", reason: "" });
    setTransferModal(s);
  };

  const handleSaveTransfer = async (e) => {
    e.preventDefault();
    if (!transferModal) return;
    if (!transferForm.to_branch_id) { confirm({ title: "Missing Destination", message: "Please select the branch to transfer to.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} }); return; }
    if (transferForm.to_branch_id === transferModal.branch_id) { confirm({ title: "Same Branch", message: "Destination must differ from current branch.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} }); return; }
    if (!transferForm.start_date) { confirm({ title: "Start Date Required", message: "Please select a start date.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} }); return; }
    if (transferForm.end_date && transferForm.end_date < transferForm.start_date) { confirm({ title: "Invalid Date Range", message: "End date cannot be before start date.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} }); return; }

    const toBranch = branches.find(b => b.id === transferForm.to_branch_id);
    try {
      await addDoc(collection(db, "staff_transfers"), {
        staff_id: transferModal.id,
        staff_name: transferModal.name,
        from_branch_id: transferModal.branch_id || null,
        from_branch_name: branches.find(b => b.id === transferModal.branch_id)?.name || null,
        to_branch_id: transferForm.to_branch_id,
        to_branch_name: toBranch?.name || null,
        start_date: transferForm.start_date,
        end_date: transferForm.end_date || null,
        reason: transferForm.reason.trim() || null,
        status: "active",
        created_by: currentUser?.name || "user",
        created_at: new Date().toISOString(),
      });
      toast({ title: "Transfer Created", message: `${transferModal.name} → ${toBranch?.name}${transferForm.end_date ? ` until ${transferForm.end_date}` : ""}.`, type: "success" });
      setTransferModal(null);
    } catch (err) {
      confirm({ title: "Transfer Failed", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    }
  };

  const handleEndTransfer = (t) => {
    confirm({
      title: "Return Staff to Home Branch",
      message: `Return <strong>${t.staff_name}</strong> to <strong>${t.from_branch_name || "home branch"}</strong>? This will end the current transfer today.`,
      confirmText: "Yes, Return",
      cancelText: "Cancel",
      type: "warning",
      onConfirm: async () => {
        try {
          await updateDoc(doc(db, "staff_transfers", t.id), {
            status: "completed",
            end_date: todayStr,
            ended_by: currentUser?.name || "user",
            ended_at: new Date().toISOString(),
          });
          toast({ title: "Transfer Ended", message: `${t.staff_name} returned to ${t.from_branch_name || "home branch"}.`, type: "success" });
        } catch (err) {
          confirm({ title: "Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
        }
      },
    });
  };

  if (loading) return <VLoader fullscreen label="Loading Staff" />;

  // Yearly salary helper — sum pro-rata across all months (honors approved leaves)
  const yearlyStaffSalary = (s) => {
    if (filterMode !== 'year') return proRataSalary(s, filterPrefix, branches, salaryHistory, staff, globalSettings, leaves);
    const limit = filterYear === NOW.getFullYear() ? NOW.getMonth() + 1 : 12;
    let total = 0;
    for (let m = 1; m <= limit; m++) total += proRataSalary(s, `${filterYear}-${String(m).padStart(2,'0')}`, branches, salaryHistory, staff, globalSettings, leaves);
    return total;
  };

  // Totals
  const totalTarget = filtered.reduce((s, x) => s + ((x.target || 0) * (filterMode === 'year' ? (filterYear === NOW.getFullYear() ? NOW.getMonth() + 1 : 12) : 1)), 0);
  const totalAchieved = filtered.reduce((s, x) => s + staffBillingInPeriod(x.id, entries, filterPrefix, filterMode, filterYear), 0);
  const totalSalary = filtered.reduce((s, x) => s + yearlyStaffSalary(x), 0);

  return (
    <div>
      {/* Page Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div className="page-title" style={{ fontSize: 24, fontWeight: 800, color: "var(--gold)", letterSpacing: 1, textTransform: "capitalize" }}>Staff</div>
        <button onClick={() => { location.reload(); }} className="refresh-btn" style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text2)", cursor: "pointer", fontSize: 16 }}>↻</button>
      </div>

      {/* Period Widget */}
      <PeriodWidget filterMode={filterMode} setFilterMode={setFilterMode} filterYear={filterYear} setFilterYear={setFilterYear} filterMonth={filterMonth} setFilterMonth={setFilterMonth} />

      {/* Summary Metrics */}
      <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        <StatCard label="Total Staff" value={filtered.length} subtext={`${totalActive} Active / ${totalInactive} Inactive`} icon={<Icon name="log" size={24} />} color="blue" />
        <StatCard label={filterMode === 'year' ? "Yearly Billing" : "Monthly Billing"} value={INR(totalAchieved)} subtext={`Target: ${INR(totalTarget)}`} icon={<Icon name="check" size={24} />} trend={`${Math.round((totalAchieved / (totalTarget || 1)) * 100)}% of goal`} color="green" />
        {!isAccountant && <StatCard label={filterMode === 'year' ? "Est. Yearly Payroll" : "Est. Payroll"} value={INR(totalSalary)} subtext="Pro-rata basis" icon={<Icon name="plus" size={24} />} color="gold" />}
      </div>

      {/* Filters & Controls */}
      <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)", borderRadius: 16, padding: 12, marginBottom: 16, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <select value={branchFilter} onChange={e => setBranchFilter(e.target.value)}
          style={{ padding: "8px 12px", border: "1px solid var(--border2)", borderRadius: 10, fontSize: 13, background: "var(--bg3)", color: "var(--text)", minWidth: 160 }}>
          <option value="">All Branches</option>
          {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>

        <div style={{ display: "inline-flex", background: "var(--bg3)", border: "1.5px solid var(--border2)", borderRadius: 12, padding: 3, gap: 2 }}>
          {[["all", "All"], ["active", "Active"], ["inactive", "Inactive"]].map(([val, label]) => (
            <button key={val} onClick={() => setStatusFilter(val)}
              style={{ padding: "6px 16px", fontSize: 11, fontWeight: 700, color: statusFilter === val ? "#000" : "var(--text3)", background: statusFilter === val ? (val === "active" ? "var(--green)" : val === "inactive" ? "var(--red)" : "var(--accent)") : "transparent", border: "none", borderRadius: 9, cursor: "pointer", transition: "all 0.2s", textTransform: "uppercase" }}>
              {label}
            </button>
          ))}
        </div>

        {/* Role type filter — narrows to mens-only or unisex stylists */}
        <div style={{ display: "inline-flex", background: "var(--bg3)", border: "1.5px solid var(--border2)", borderRadius: 12, padding: 3, gap: 2 }}>
          {[["all", "All Roles"], ["mens", "Mens"], ["unisex", "Unisex"]].map(([val, label]) => (
            <button key={val} onClick={() => setRoleFilter(val)}
              style={{ padding: "6px 14px", fontSize: 11, fontWeight: 700, color: roleFilter === val ? "#000" : "var(--text3)", background: roleFilter === val ? "var(--accent)" : "transparent", border: "none", borderRadius: 9, cursor: "pointer", transition: "all 0.2s", textTransform: "uppercase" }}>
              {label}
            </button>
          ))}
        </div>

        <div style={{ marginLeft: "auto", display: "flex", gap: 12 }}>
          {canEdit && (
            <button onClick={() => { setShowForm(true); setEditId(null); setForm({ name: "", branch_id: "", role: "", mobile: "", salary: "", incentive_pct: "10", target: "", join: new Date().toISOString().split("T")[0], exit_date: "" }); }}
              style={{ padding: "8px 20px", fontSize: 13, borderRadius: 10, background: "var(--accent)", color: "#000", border: "none", cursor: "pointer", fontWeight: 800, display: "flex", alignItems: "center", gap: 8, boxShadow: "var(--accent-glow)" }}>
              <Icon name="plus" size={16} /> Add Staff Member
            </button>
          )}
        </div>
      </div>

      <Modal isOpen={showForm} onClose={() => setShowForm(false)} title={editId ? "Edit Staff Details" : "Register New Staff"}>
        {!isAdmin && <div style={{ fontSize: 11, color: "var(--red)", marginBottom: 16 }}>⚠️ Salary & Incentive % require Admin.</div>}
        <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <FormField label="Full Name"><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Enter name" /></FormField>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <FormField label="Branch">
              <select value={form.branch_id} onChange={e => setForm({ ...form, branch_id: e.target.value })}>
                <option value="">Select...</option>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </FormField>
            <FormField label="Role">
              <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
                <option value="">Select...</option>
                {ROLES.map(r => <option key={r}>{r}</option>)}
              </select>
            </FormField>
          </div>
          <FormField label="Mobile Number"><input value={form.mobile} onChange={e => setForm({ ...form, mobile: e.target.value })} placeholder="9999999999" /></FormField>

          {isAdmin && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <FormField label="Monthly Salary (₹)"><input type="number" value={form.salary} onChange={e => { setForm({ ...form, salary: e.target.value }); setIncrement(""); }} placeholder="30000" /></FormField>
                <FormField label="Incentive %"><input type="number" value={form.incentive_pct} onChange={e => setForm({ ...form, incentive_pct: e.target.value })} placeholder="10" /></FormField>
              </div>
              {editId && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "end" }}>
                  <FormField label="Increment Amount (₹)">
                    <input type="number" value={increment} placeholder="e.g. 2000" onChange={e => {
                      const inc = e.target.value;
                      setIncrement(inc);
                      if (inc) {
                        const existing = staff.find(x => x.id === editId);
                        const base = Number(existing?.salary) || 0;
                        setForm(f => ({ ...f, salary: String(base + Number(inc)) }));
                      }
                    }} />
                  </FormField>
                  <div style={{ fontSize: 12, color: "var(--text3)", paddingBottom: 14 }}>
                    {increment && Number(increment) ? (
                      <span>New Salary: <strong style={{ color: "var(--green)", fontSize: 14 }}>{INR(Number(form.salary))}</strong></span>
                    ) : null}
                  </div>
                </div>
              )}
            </>
          )}
          
          <FormField label="Monthly Billing Target (₹)"><input type="number" value={form.target} onChange={e => setForm({ ...form, target: e.target.value })} placeholder="60000" /></FormField>
          
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <FormField label="Joining Date *"><input type="date" required value={form.join} onChange={e => setForm({ ...form, join: e.target.value })} /></FormField>
            <FormField label="Exit Date (Opt)"><input type="date" value={form.exit_date} onChange={e => setForm({ ...form, exit_date: e.target.value })} /></FormField>
          </div>

          <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
            <button type="submit" style={{ flex: 1, padding: "14px", borderRadius: 12, background: "var(--accent)", color: "#000", border: "none", fontWeight: 800, cursor: "pointer" }}>Save Employee</button>
            <button type="button" onClick={() => setShowForm(false)} style={{ padding: "14px 24px", borderRadius: 12, background: "var(--bg3)", color: "var(--text2)", border: "1px solid var(--border)", cursor: "pointer", fontWeight: 600 }}>Cancel</button>
          </div>
        </form>
      </Modal>

      {/* Status Confirmation Modal */}
      {Object.keys(pendingStatus).length > 0 && (() => {
        const sid = Object.keys(pendingStatus)[0];
        const pending = pendingStatus[sid];
        const s = staff.find(x => x.id === sid);
        return (
          <Modal isOpen={true} onClose={() => setPendingStatus({})} title="Change Employee Status">
            <div style={{ fontSize: 13, color: "var(--text2)", marginBottom: 20 }}>
              You are changing the status for <strong>{s?.name}</strong> to <strong>{pending.goingActive ? "Active" : "Inactive"}</strong>.
              Please select the effective date for this change.
            </div>
            <FormField label="Effective Date">
              <input type="date" value={pending.date} onChange={e => setPendingStatus({ [sid]: { ...pending, date: e.target.value } })} />
            </FormField>
            <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
              <button onClick={() => confirmStatusChange(sid)} style={{ flex: 1, padding: "14px", borderRadius: 12, background: pending.goingActive ? "var(--green)" : "var(--red)", color: "#fff", border: "none", fontWeight: 800, cursor: "pointer" }}>
                Confirm {pending.goingActive ? "Activation" : "Deactivation"}
              </button>
              <button onClick={() => setPendingStatus({})} style={{ padding: "14px 24px", borderRadius: 12, background: "var(--bg3)", color: "var(--text2)", border: "1px solid var(--border)", cursor: "pointer", fontWeight: 600 }}>Cancel</button>
            </div>
          </Modal>
        );
      })()}

      {/* Attendance Calendar Modal — per-staff, per-month, editable by admin/accountant */}
      <Modal isOpen={!!attendanceModal} onClose={() => { setAttendanceModal(null); setAttendanceOverrides([]); setEditingDay(null); }} title={`Attendance · ${attendanceModal?.staff?.name || ""}`} width={720}>
        {attendanceModal && (() => {
          const { staff: s, month } = attendanceModal;
          const [yr, mo] = month.split("-").map(Number);
          const daysInMonth = new Date(yr, mo, 0).getDate();
          const firstDow = new Date(yr, mo - 1, 1).getDay(); // 0 = Sun
          const todayStr = new Date().toISOString().slice(0, 10);
          const joinDate = s.join || null;
          const exitDate = s.exit_date || null;
          const monEntries = entries.filter(e => e.date && e.date.startsWith(month));
          const monLeaves = leaves.filter(l => l.staff_id === s.id && (l.date || "").startsWith(month) && (l.status === "approved" || !l.status));
          const overrideByDate = new Map(attendanceOverrides.map(o => [o.date, o]));

          // Resolve per-day status. Priority: override > leave > entries > default.
          const dayStatus = (dateStr) => {
            if (overrideByDate.has(dateStr)) {
              const o = overrideByDate.get(dateStr);
              return { kind: o.present ? "present" : "absent", branch_id: o.branch_id || null, note: o.note || "", source: "override" };
            }
            const leave = monLeaves.find(l => l.date === dateStr);
            if (leave) return { kind: "leave", branch_id: null, note: leave.type || "Leave", source: "leave" };
            const hits = monEntries.filter(e => e.date === dateStr && (e.staff_billing || []).some(sb => sb.staff_id === s.id && sb.present !== false));
            if (hits.length > 0) {
              const hit = hits[0];
              return { kind: "present", branch_id: hit.branch_id, note: "", source: "entries" };
            }
            if (joinDate && dateStr < joinDate) return { kind: "before", branch_id: null, note: "", source: "lifecycle" };
            if (exitDate && dateStr > exitDate) return { kind: "after", branch_id: null, note: "", source: "lifecycle" };
            return { kind: "absent", branch_id: null, note: "", source: "default" };
          };

          const saveDay = async (dateStr, draft) => {
            try {
              await setDoc(doc(db, "staff_attendance", `${s.id}_${dateStr}`), {
                staff_id: s.id,
                staff_name: s.name,
                date: dateStr,
                present: !!draft.present,
                branch_id: draft.branch_id || null,
                branch_name: branches.find(b => b.id === draft.branch_id)?.name || null,
                note: draft.note || "",
                edited_by: currentUser?.id || "unknown",
                edited_by_name: currentUser?.name || "User",
                edited_at: new Date().toISOString(),
              });
              toast({ title: "Attendance Saved", message: `${s.name} · ${dateStr} · ${draft.present ? "Present" : "Absent"}`, type: "success" });
              setEditingDay(null);
            } catch (err) {
              toast({ title: "Save Failed", message: err.message, type: "error" });
            }
          };

          const clearOverride = async (dateStr) => {
            try {
              await deleteDoc(doc(db, "staff_attendance", `${s.id}_${dateStr}`));
              toast({ title: "Override Cleared", message: `${dateStr} reverted to computed attendance.`, type: "success" });
              setEditingDay(null);
            } catch (err) {
              toast({ title: "Clear Failed", message: err.message, type: "error" });
            }
          };

          const colorFor = (kind) => ({
            present: { bg: "rgba(74,222,128,0.12)", border: "rgba(74,222,128,0.4)", text: "var(--green)" },
            absent:  { bg: "rgba(248,113,113,0.1)", border: "rgba(248,113,113,0.3)", text: "var(--red)" },
            leave:   { bg: "rgba(96,165,250,0.12)", border: "rgba(96,165,250,0.35)", text: "var(--blue, #60a5fa)" },
            before:  { bg: "var(--bg4)", border: "var(--border)", text: "var(--text3)" },
            after:   { bg: "var(--bg4)", border: "var(--border)", text: "var(--text3)" },
          }[kind] || { bg: "var(--bg4)", border: "var(--border)", text: "var(--text3)" });

          const short = (bid) => (branches.find(b => b.id === bid)?.name || "").replace("V-CUT ", "").slice(0, 8);

          const blanks = Array(firstDow).fill(null);
          const days = Array.from({ length: daysInMonth }, (_, i) => {
            const d = String(i + 1).padStart(2, "0");
            return `${month}-${d}`;
          });

          let presentCount = 0, leaveCount = 0, absentCount = 0;
          days.forEach(dateStr => {
            const st = dayStatus(dateStr);
            if (st.kind === "present") presentCount++;
            else if (st.kind === "leave") leaveCount++;
            else if (st.kind === "absent") absentCount++;
          });

          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 11, fontWeight: 700 }}>
                <span style={{ padding: "6px 10px", borderRadius: 8, background: "rgba(74,222,128,0.12)", color: "var(--green)" }}>● Present {presentCount}</span>
                <span style={{ padding: "6px 10px", borderRadius: 8, background: "rgba(96,165,250,0.12)", color: "var(--blue, #60a5fa)" }}>● Leave {leaveCount}</span>
                <span style={{ padding: "6px 10px", borderRadius: 8, background: "rgba(248,113,113,0.1)", color: "var(--red)" }}>● Absent {absentCount}</span>
                <span style={{ marginLeft: "auto", padding: "6px 10px", borderRadius: 8, background: "var(--bg4)", color: "var(--text3)" }}>Home: {(branches.find(b => b.id === s.branch_id)?.name || "—").replace("V-CUT ", "")}</span>
              </div>

              {/* Weekday header */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6, fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.2, textAlign: "center" }}>
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => <div key={d}>{d}</div>)}
              </div>

              {/* Calendar grid */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
                {blanks.map((_, i) => <div key={`b${i}`} />)}
                {days.map(dateStr => {
                  const st = dayStatus(dateStr);
                  const c = colorFor(st.kind);
                  const isToday = dateStr === todayStr;
                  const bName = st.branch_id ? short(st.branch_id) : "";
                  const hasOverride = st.source === "override";
                  return (
                    <button key={dateStr}
                      disabled={!canEdit}
                      onClick={() => { setEditingDay(dateStr); setDayDraft({ present: st.kind === "present" || st.kind === "leave" ? (st.kind === "present") : false, branch_id: st.branch_id || s.branch_id || "", note: st.note || "" }); }}
                      style={{
                        position: "relative",
                        aspectRatio: "1 / 1",
                        padding: 6,
                        borderRadius: 10,
                        background: c.bg,
                        border: `1px solid ${isToday ? "var(--accent)" : c.border}`,
                        color: c.text,
                        cursor: canEdit ? "pointer" : "default",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        fontFamily: "var(--font-headline, var(--font-outfit))",
                      }}>
                      <div style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center", fontSize: 12, fontWeight: 800 }}>
                        <span>{Number(dateStr.slice(8, 10))}</span>
                        {hasOverride && <span title="Manually edited" style={{ fontSize: 8, color: "var(--accent)" }}>✎</span>}
                      </div>
                      {bName && <div style={{ fontSize: 9, fontWeight: 700, opacity: 0.9, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>{bName}</div>}
                      {st.kind === "leave" && <div style={{ fontSize: 9, fontWeight: 700, opacity: 0.85 }}>LEAVE</div>}
                      {st.kind === "absent" && st.source === "default" && <div style={{ fontSize: 9, fontWeight: 700, opacity: 0.75 }}>—</div>}
                    </button>
                  );
                })}
              </div>

              {/* Inline day editor */}
              {editingDay && canEdit && (() => {
                const st = dayStatus(editingDay);
                const hasOverride = st.source === "override";
                return (
                  <div style={{ padding: 14, borderRadius: 12, background: "var(--bg3)", border: "1px solid var(--border2)", display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <div style={{ fontSize: 13, fontWeight: 800, color: "var(--text)" }}>Edit {editingDay}</div>
                      <button type="button" onClick={() => setEditingDay(null)}
                        style={{ background: "transparent", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: 14 }}>✕</button>
                    </div>
                    <div style={{ display: "inline-flex", borderRadius: 8, overflow: "hidden", border: "1px solid var(--border2)", width: "fit-content" }}>
                      {[["present", true, "Present"], ["absent", false, "Absent"]].map(([k, v, lbl]) => (
                        <button key={k} type="button" onClick={() => setDayDraft(d => ({ ...d, present: v }))}
                          style={{ padding: "8px 14px", background: dayDraft.present === v ? (v ? "var(--green)" : "var(--red)") : "var(--bg3)", color: dayDraft.present === v ? "#000" : "var(--text2)", border: "none", fontSize: 11, fontWeight: 800, cursor: "pointer", textTransform: "uppercase", letterSpacing: 1 }}>{lbl}</button>
                      ))}
                    </div>
                    {dayDraft.present && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Worked at</label>
                        <select value={dayDraft.branch_id || ""} onChange={e => setDayDraft(d => ({ ...d, branch_id: e.target.value }))}
                          style={{ padding: "8px 10px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12 }}>
                          <option value="">—</option>
                          {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </select>
                      </div>
                    )}
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Note (optional)</label>
                      <input value={dayDraft.note} onChange={e => setDayDraft(d => ({ ...d, note: e.target.value }))}
                        placeholder="Reason / context"
                        style={{ padding: "8px 10px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, outline: "none" }} />
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" onClick={() => saveDay(editingDay, dayDraft)}
                        style={{ flex: 1, padding: "10px", borderRadius: 10, background: "var(--accent)", color: "#000", border: "none", fontWeight: 800, cursor: "pointer" }}>Save</button>
                      {hasOverride && (
                        <button type="button" onClick={() => clearOverride(editingDay)}
                          title="Revert to computed attendance"
                          style={{ padding: "10px 14px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border)", fontWeight: 700, cursor: "pointer" }}>Clear Override</button>
                      )}
                    </div>
                  </div>
                );
              })()}

              <div style={{ fontSize: 10, color: "var(--text3)", lineHeight: 1.5 }}>
                Source priority: <strong>Manual override</strong> › Approved leave › Daily entries › Join/exit lifecycle.
                {!canEdit && <> You have read-only access.</>}
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* Transfer Modal */}
      <Modal isOpen={!!transferModal} onClose={() => setTransferModal(null)} title={`Transfer Staff — ${transferModal?.name || ''}`}>
        {transferModal && (
          <form onSubmit={handleSaveTransfer} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ background: "var(--bg4)", padding: 12, borderRadius: 10, fontSize: 12, color: "var(--text2)" }}>
              Temporarily reassigning <strong>{transferModal.name}</strong> from{" "}
              <strong>{branches.find(b => b.id === transferModal.branch_id)?.name || "—"}</strong>.
              This does not change their home branch.
            </div>
            <FormField label="Transfer To Branch">
              <select value={transferForm.to_branch_id} onChange={e => setTransferForm({ ...transferForm, to_branch_id: e.target.value })}>
                <option value="">Select...</option>
                {branches.filter(b => b.id !== transferModal.branch_id).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </FormField>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <FormField label="Start Date *">
                <input type="date" required value={transferForm.start_date} onChange={e => setTransferForm({ ...transferForm, start_date: e.target.value })} />
              </FormField>
              <FormField label="End Date (Opt)">
                <input type="date" value={transferForm.end_date} onChange={e => setTransferForm({ ...transferForm, end_date: e.target.value })} />
              </FormField>
            </div>
            <FormField label="Reason">
              <input value={transferForm.reason} onChange={e => setTransferForm({ ...transferForm, reason: e.target.value })} placeholder="e.g. Covering staff shortage at destination branch" />
            </FormField>
            <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
              <button type="submit" style={{ flex: 1, padding: "14px", borderRadius: 12, background: "var(--accent)", color: "#000", border: "none", fontWeight: 800, cursor: "pointer" }}>Confirm Transfer</button>
              <button type="button" onClick={() => setTransferModal(null)} style={{ padding: "14px 24px", borderRadius: 12, background: "var(--bg3)", color: "var(--text2)", border: "1px solid var(--border)", cursor: "pointer", fontWeight: 600 }}>Cancel</button>
            </div>
          </form>
        )}
      </Modal>

      {/* Pending Setup Table (admin only) */}
      {isAdmin && (() => {
        const pending = staff.filter(s => s.pending_setup);
        if (pending.length === 0) return null;
        return (
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <span style={{ padding: "4px 10px", borderRadius: 999, background: "rgba(251,146,60,0.15)", color: "var(--orange)", fontSize: 10, fontWeight: 900, textTransform: "uppercase", letterSpacing: 1 }}>Action Needed</span>
              <h4 style={{ fontSize: 14, fontWeight: 800, color: "var(--orange)", margin: 0 }}>Pending Setup — {pending.length} new staff added by accountant</h4>
            </div>
            <Card style={{ border: "1px solid rgba(251,146,60,0.35)" }}>
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
                <thead>
                  <tr>
                    <TH>Name</TH><TH>Branch</TH><TH>Role</TH><TH>Mobile</TH><TH>Joined</TH>
                    <TH right>Default Salary</TH><TH right>Default Inc %</TH><TH right sticky>Action</TH>
                  </tr>
                </thead>
                <tbody>
                  {pending.map(s => {
                    const b = branches.find(x => x.id === s.branch_id);
                    return (
                      <tr key={s.id} style={{ background: "rgba(251,146,60,0.03)" }}>
                        <TD style={{ fontWeight: 700 }}>{s.name}</TD>
                        <TD>{b?.name || "—"}</TD>
                        <TD>{s.role || "—"}</TD>
                        <TD style={{ color: "var(--text3)" }}>{s.mobile || "—"}</TD>
                        <TD style={{ color: "var(--text3)" }}>{s.join || "—"}</TD>
                        <TD right style={{ color: "var(--orange)", fontWeight: 700 }}>{INR(s.salary || 0)}</TD>
                        <TD right style={{ color: "var(--orange)", fontWeight: 700 }}>{s.incentive_pct || 10}%</TD>
                        <TD sticky right>
                          <button onClick={() => handleEdit(s)}
                            style={{ padding: "6px 14px", borderRadius: 8, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <Icon name="edit" size={12} /> Setup Now
                          </button>
                        </TD>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          </div>
        );
      })()}

      {/* Staff Table */}
      <Card>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
          <thead>
            <tr>
              <TH>Staff Identity</TH>
              <TH>Role & Status</TH>
              <TH>Goal Progress</TH>
              {!isAccountant && <TH right>{filterMode === 'year' ? 'Yearly Salary' : 'Monthly Salary'}</TH>}
              {canEdit && <TH right sticky>Actions</TH>}
            </tr>
          </thead>
          <tbody>
            {filtered.map((s, i) => {
              const b = branches.find(x => x.id === s.branch_id);
              const ach = staffBillingInPeriod(s.id, entries, filterPrefix, filterMode, filterYear);
              const monthsInView = filterMode === 'year' ? (filterYear === NOW.getFullYear() ? NOW.getMonth() + 1 : 12) : 1;
              const tgt = (s.target || 50000) * monthsInView;
              const overall = staffOverallStatus(s, statusRefMon);
              const checkMon = filterMode === "month" ? filterPrefix : filterYear + "-" + String(NOW.getMonth() + 1).padStart(2, "0");
              const monthSt = staffStatusForMonth(s, checkMon);
              const sal = yearlyStaffSalary(s);
              const isPending = pendingStatus[s.id];
              const activeTransfer = getActiveTransfer(s.id);

              return (
                <tr key={s.id} style={{ opacity: overall === "inactive" ? 0.6 : 1, transition: "background 0.2s" }}>
                  <TD>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ width: 40, height: 40, borderRadius: 12, background: "var(--bg4)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 800, color: "var(--accent)", border: "1px solid var(--border)" }}>{s.name[0]}</div>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>{s.name}</div>
                        <div style={{ fontSize: 11, color: "var(--text3)", display: "flex", alignItems: "center", gap: 5 }}>
                          <Icon name="log" size={10} /> {b?.name || "No Branch"} • {s.mobile || "No Mobile"}
                        </div>
                        {activeTransfer && (
                          <div style={{ marginTop: 4, display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 8px", borderRadius: 999, background: "rgba(96,165,250,0.12)", border: "1px solid rgba(96,165,250,0.3)", fontSize: 10, fontWeight: 700, color: "var(--blue, #60a5fa)" }}>
                            <span>↪ Temp @ {activeTransfer.to_branch_name}</span>
                            {activeTransfer.end_date && <span style={{ opacity: 0.8 }}>until {activeTransfer.end_date}</span>}
                          </div>
                        )}
                      </div>
                    </div>
                  </TD>
                  <TD>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <Pill label={s.role || "Trainee"} color={s.role === 'Captain' ? 'purple' : 'blue'} />
                        {overall === 'active' ? <Pill label="Active" color="green" /> : <Pill label="Inactive" color="red" />}
                      </div>
                      {monthSt.status === 'partial' && (
                        <button type="button"
                          onClick={() => setAttendanceModal({ staff: s, month: filterMode === "month" ? filterPrefix : `${filterYear}-${String(NOW.getMonth() + 1).padStart(2, "0")}` })}
                          title="Open attendance calendar"
                          style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", fontSize: 10, color: "var(--orange)", fontWeight: 600, textAlign: "left", textDecoration: "underline dotted" }}>
                          Partial: {monthSt.daysWorked} working days · view calendar
                        </button>
                      )}
                      {monthSt.status === 'active' && (
                        <button type="button"
                          onClick={() => setAttendanceModal({ staff: s, month: filterMode === "month" ? filterPrefix : `${filterYear}-${String(NOW.getMonth() + 1).padStart(2, "0")}` })}
                          title="Open attendance calendar"
                          style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", fontSize: 10, color: "var(--text3)", fontWeight: 500, textAlign: "left" }}>
                          📅 Attendance
                        </button>
                      )}
                    </div>
                  </TD>
                  <TD style={{ minWidth: 200 }}>
                    <ProgressBar value={ach} max={tgt} label={`${INR(ach)} / ${INR(tgt)}`} color={ach >= tgt ? "green" : "accent"} />
                  </TD>
                  {!isAccountant && (
                    <TD right>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 800, color: "var(--accent)" }}>{INR(sal)}</div>
                          <div style={{ fontSize: 10, color: "var(--text3)" }}>{filterMode === 'year' ? 'Yearly payroll' : 'Pro-rata payroll'}</div>
                        </div>
                        {filterMode === 'year' && (
                          <button onClick={() => setMonthlyLogModal(s)} title="Monthly Breakdown"
                            style={{ padding: "4px 6px", borderRadius: 6, background: "var(--bg4)", border: "1px solid var(--border)", cursor: "pointer", display: "inline-flex", alignItems: "center" }}>
                            <Icon name="log" size={14} style={{ color: "var(--accent)" }} />
                          </button>
                        )}
                      </div>
                    </TD>
                  )}
                  {canEdit && (
                    <TD sticky right>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                        {!isAccountant && <IconBtn name="log" onClick={() => setHistoryModal(s)} variant="secondary" title="History Log" />}
                        {overall === 'active' && (
                          activeTransfer ? (
                            <button onClick={() => handleEndTransfer(activeTransfer)} title="Return to home branch"
                              style={{ padding: "6px 10px", borderRadius: 8, background: "var(--green-bg)", border: "1px solid rgba(74,222,128,0.3)", color: "var(--green)", fontSize: 11, fontWeight: 800, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}>
                              ↩ Return
                            </button>
                          ) : (
                            <button onClick={() => openTransfer(s)} title="Transfer to another branch"
                              style={{ padding: "6px 10px", borderRadius: 8, background: "rgba(96,165,250,0.12)", border: "1px solid rgba(96,165,250,0.3)", color: "var(--blue, #60a5fa)", fontSize: 11, fontWeight: 800, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}>
                              ↪ Transfer
                            </button>
                          )
                        )}
                        <IconBtn name={overall === 'active' ? 'close' : 'check'} onClick={() => handleToggleStatus(s, !(overall === 'active'))} variant={overall === 'active' ? 'danger' : 'success'} title={overall === 'active' ? "Mark as Exited" : "Activate"} />
                        <IconBtn name="edit" onClick={() => handleEdit(s)} variant="secondary" title="Edit Staff" />
                        {!isAccountant && <IconBtn name="del" onClick={() => handleDelete(s.id)} variant="danger" title="Delete" />}
                      </div>
                    </TD>
                  )}
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={13} style={{ textAlign: "center", padding: 24, color: "var(--text3)" }}>No staff found for this filter</td></tr>
            )}
          </tbody>
          <tfoot>
            <tr style={{ background: "var(--bg3)", fontWeight: 800, color: "var(--accent)", borderTop: "2px solid var(--border2)" }}>
              <td colSpan={2} style={{ padding: "16px 20px" }}>NETWORK TOTALS ({filtered.length} staff)</td>
              <td style={{ padding: "16px 20px" }}>
                <ProgressBar value={totalAchieved} max={totalTarget} label={`${INR(totalAchieved)} / ${INR(totalTarget)}`} color="accent" />
              </td>
              {!isAccountant && <td style={{ padding: "16px 20px", textAlign: "right", fontSize: 18 }}>{INR(totalSalary)}</td>}
              {canEdit && <td style={{ position: "sticky", right: 0, background: "var(--bg3)" }}></td>}
            </tr>
          </tfoot>
        </table>
      </Card>

      {/* Employee History Log Modal */}
      <Modal isOpen={!!historyModal} onClose={() => setHistoryModal(null)} title={`Employee Log — ${historyModal?.name || ''}`} width={620}>
        {historyModal && (() => {
          const sHist = salaryHistory.filter(h => h.staff_id === historyModal.id);
          const sLog = statusLog.filter(l => l.staff_id === historyModal.id);
          const sTransfers = transfers.filter(t => t.staff_id === historyModal.id);
          const b = branches.find(x => x.id === historyModal.branch_id);
          // Merge all events into a single timeline
          const timeline = [
            ...sHist.map(h => ({
              date: h.effective_from,
              type: 'salary',
              action: 'Salary Changed',
              details: `${INR(h.old_salary || 0)} → ${INR(h.salary)}${h.old_salary != null && h.salary > h.old_salary ? ` (+${INR(h.salary - h.old_salary)} increment)` : ''}`,
              by: h.changed_by || '—',
              color: 'accent',
            })),
            ...sLog.map(l => ({
              date: l.date,
              type: 'status',
              action: l.action === 'activated' ? 'Activated' : l.action === 'deactivated' ? 'Deactivated' : l.action,
              details: l.action === 'deactivated' ? `Exit date set: ${l.date}` : 'Rejoined / Reactivated',
              by: l.by || '—',
              color: l.action === 'activated' ? 'green' : 'red',
            })),
            ...sTransfers.map(t => ({
              date: t.start_date,
              type: 'transfer',
              action: t.status === 'active' ? 'Transferred' : 'Transfer Ended',
              details: `${t.from_branch_name || '—'} → ${t.to_branch_name || '—'}${t.end_date ? ` (until ${t.end_date})` : ''}${t.reason ? ` • ${t.reason}` : ''}`,
              by: t.created_by || '—',
              color: t.status === 'active' ? 'blue' : 'accent',
            })),
          ].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {/* Employee Info Card */}
              <div style={{ background: "var(--bg4)", padding: 16, borderRadius: 10 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 12 }}>
                  <div><span style={{ color: "var(--text3)" }}>Branch:</span> <strong>{b?.name || '—'}</strong></div>
                  <div><span style={{ color: "var(--text3)" }}>Role:</span> <strong>{historyModal.role || '—'}</strong></div>
                  <div><span style={{ color: "var(--text3)" }}>Joined:</span> <strong>{historyModal.join || '—'}</strong></div>
                  <div><span style={{ color: "var(--text3)" }}>Status:</span> <strong style={{ color: historyModal.exit_date ? "var(--red)" : "var(--green)" }}>{historyModal.exit_date ? `Exited ${historyModal.exit_date}` : 'Active'}</strong></div>
                  <div><span style={{ color: "var(--text3)" }}>Current Salary:</span> <strong style={{ color: "var(--accent)" }}>{INR(historyModal.salary)}</strong></div>
                  <div><span style={{ color: "var(--text3)" }}>Mobile:</span> <strong>{historyModal.mobile || '—'}</strong></div>
                </div>
              </div>

              {/* Unified Activity Log Table */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 10 }}>Activity Log</div>
                {timeline.length > 0 ? (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid var(--border)" }}>
                        <th style={{ padding: "8px 10px", textAlign: "left", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Date</th>
                        <th style={{ padding: "8px 10px", textAlign: "left", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Action</th>
                        <th style={{ padding: "8px 10px", textAlign: "left", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Details</th>
                        <th style={{ padding: "8px 10px", textAlign: "right", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>By</th>
                      </tr>
                    </thead>
                    <tbody>
                      {timeline.map((t, i) => (
                        <tr key={i} style={{ borderBottom: "1px solid rgba(72,72,71,0.08)" }}>
                          <td style={{ padding: "10px 10px", color: "var(--text3)", whiteSpace: "nowrap" }}>{t.date}</td>
                          <td style={{ padding: "10px 10px" }}><Pill label={t.action} color={t.color} /></td>
                          <td style={{ padding: "10px 10px", color: "var(--text2)", fontWeight: 600 }}>{t.details}</td>
                          <td style={{ padding: "10px 10px", textAlign: "right", color: "var(--text3)", fontSize: 11 }}>{t.by}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <div style={{ fontSize: 12, color: "var(--text3)", padding: "16px 0", textAlign: "center" }}>No activity recorded yet.</div>}
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* Monthly Breakdown Modal (yearly view) */}
      <Modal isOpen={!!monthlyLogModal} onClose={() => setMonthlyLogModal(null)} title={`Monthly Breakdown — ${monthlyLogModal?.name || ''}`} width={520}>
        {monthlyLogModal && (() => {
          const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
          const limit = filterYear === NOW.getFullYear() ? NOW.getMonth() + 1 : 12;
          const rows = [];
          let yearTotal = 0;
          for (let m = 1; m <= limit; m++) {
            const mp = `${filterYear}-${String(m).padStart(2,'0')}`;
            const mSal = proRataSalary(monthlyLogModal, mp, branches, salaryHistory, staff, globalSettings, leaves);
            const mBill = staffBillingInPeriod(monthlyLogModal.id, entries, mp, 'month', filterYear);
            const mStatus = staffStatusForMonth(monthlyLogModal, mp);
            yearTotal += mSal;
            rows.push({ month: MONTH_NAMES[m-1], prefix: mp, salary: mSal, billing: mBill, status: mStatus.status, days: mStatus.daysWorked });
          }
          return (
            <div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    <th style={{ padding: "8px 10px", textAlign: "left", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Month</th>
                    <th style={{ padding: "8px 10px", textAlign: "center", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Status</th>
                    <th style={{ padding: "8px 10px", textAlign: "right", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Days</th>
                    <th style={{ padding: "8px 10px", textAlign: "right", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Billing</th>
                    <th style={{ padding: "8px 10px", textAlign: "right", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Salary</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid rgba(72,72,71,0.08)" }}>
                      <td style={{ padding: "10px 10px", fontWeight: 600 }}>{r.month} {filterYear}</td>
                      <td style={{ padding: "10px 10px", textAlign: "center" }}>
                        <Pill label={r.status === 'active' ? 'Full' : r.status === 'partial' ? 'Partial' : 'N/A'} color={r.status === 'active' ? 'green' : r.status === 'partial' ? 'orange' : 'red'} />
                      </td>
                      <td style={{ padding: "10px 10px", textAlign: "right", color: "var(--text3)" }}>{r.days}</td>
                      <td style={{ padding: "10px 10px", textAlign: "right", color: "var(--text2)", fontWeight: 600 }}>{INR(r.billing)}</td>
                      <td style={{ padding: "10px 10px", textAlign: "right", color: "var(--accent)", fontWeight: 700 }}>{INR(r.salary)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: "2px solid var(--border)" }}>
                    <td colSpan={3} style={{ padding: "12px 10px", fontWeight: 800, fontSize: 13 }}>TOTAL</td>
                    <td style={{ padding: "12px 10px", textAlign: "right", fontWeight: 800, fontSize: 13, color: "var(--text)" }}>{INR(rows.reduce((s,r) => s + r.billing, 0))}</td>
                    <td style={{ padding: "12px 10px", textAlign: "right", fontWeight: 800, fontSize: 13, color: "var(--accent)" }}>{INR(yearTotal)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          );
        })()}
      </Modal>

      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────
function FormField({ label, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, justifyContent: "flex-end" }}>
      <label style={{ fontSize: 12, color: "var(--text2)", fontWeight: 700, textTransform: "capitalize", letterSpacing: 1 }}>{label}</label>
      {children && <div style={{ display: "contents" }}>
        {React.cloneElement(children, {
          style: { padding: "12px 16px", border: "2px solid var(--input-border)", borderRadius: 10, fontSize: 15, background: "var(--bg2)", color: "var(--text)", fontFamily: "var(--font-outfit)", width: "100%", transition: "all .3s", ...(children.props.style || {}) }
        })}
      </div>}
    </div>
  );
}

import React from "react";
import VLoader from "@/components/VLoader";

