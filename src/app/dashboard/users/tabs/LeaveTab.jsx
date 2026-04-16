"use client";
import { useEffect, useState } from "react";
import { collection, onSnapshot, query, orderBy, addDoc, deleteDoc, doc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Icon, IconBtn, Pill, Card, PeriodWidget, TH, TD, Modal, ToggleGroup, StatCard, useConfirm, useToast } from "@/components/ui";
import VLoader from "@/components/VLoader";


const NOW = new Date();

export default function LeaveTab({ view = "admin" }) {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [leaves, setLeaves] = useState([]);
  const [staff, setStaff] = useState([]);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState(null);

  // Filter states
  const [filterYear, setFilterYear] = useState(NOW.getFullYear());
  const [filterMonth, setFilterMonth] = useState(NOW.getMonth() + 1);
  const filterPrefix = `${filterYear}-${String(filterMonth).padStart(2, "0")}`;

  // UI states
  const [showForm, setShowForm] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [form, setForm] = useState({ staff_id: "", date: "", days: 1, reason: "", status: "pending" });

  useEffect(() => {
    const saved = localStorage.getItem("vcut_user");
    if (saved) setCurrentUser(JSON.parse(saved));
  }, []);

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "staff"), sn => setStaff(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(query(collection(db, "leaves"), orderBy("date", "desc")), sn => {
        setLeaves(sn.docs.map(d => ({ ...d.data(), id: d.id })));
        setLoading(false);
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  useEffect(() => {
    if (view === "employee" && currentUser?.id) {
      setForm(prev => ({ ...prev, staff_id: currentUser.id }));
    }
  }, [view, currentUser]);

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.staff_id || !form.date) { confirm({ title: "Validation", message: "Selection and Date are required.", confirmText: "OK", type: "warning", onConfirm: () => {} }); return; }
    // Block duplicates: same staff + same date + not rejected
    const dup = leaves.find(l => l.staff_id === form.staff_id && l.date === form.date && l.status !== "rejected");
    if (dup) {
      const s = staff.find(x => x.id === form.staff_id);
      confirm({
        title: "Leave Already Submitted",
        message: `A leave for <strong>${s?.name || "this staff"}</strong> on <strong>${form.date}</strong> already exists (<em>${dup.status}</em>). You can't submit it again.`,
        confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {}
      });
      return;
    }
    try {
      await addDoc(collection(db, "leaves"), {
        ...form,
        days: Number(form.days),
        created_at: new Date().toISOString()
      });
      setShowForm(false);
      setForm({ staff_id: view === "employee" ? currentUser.id : "", date: "", days: 1, reason: "", status: "pending" });
      toast({ title: "Saved", message: "Leave record saved successfully.", type: "success" });
    } catch (err) { confirm({ title: "Error", message: err.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
  };

  const handleUpdateStatus = async (id, status) => {
    try {
      await updateDoc(doc(db, "leaves", id), { status });
      toast({ title: status === "approved" ? "Approved" : "Rejected", message: `Leave request ${status}.`, type: "success" });
    } catch (err) { confirm({ title: "Error", message: err.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
  };

  const handleDelete = async (id) => {
    confirm({
      title: "Delete Attendance Record",
      message: "Are you sure you want to permanently remove this <strong>attendance record</strong>?",
      confirmText: "Yes, Delete",
      cancelText: "Cancel",
      type: "danger",
      onConfirm: async () => {
        try {
          await deleteDoc(doc(db, "leaves", id));
          toast({ title: "Deleted", message: "Leave record has been removed.", type: "success" });
        } catch (err) { confirm({ title: "Error", message: err.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
      }
    });
  };

  if (loading) return <VLoader fullscreen label="Syncing attendance logs" />;

  let filtered = leaves.filter(l => l.date && l.date.startsWith(filterPrefix))
    .filter(l => statusFilter === "all" || l.status === statusFilter);

  if (view === "employee" && currentUser?.id) {
    filtered = filtered.filter(l => l.staff_id === currentUser.id);
  }

  // Analytics for StatCards
  const pendingCount = (view === "employee" ? leaves.filter(l => l.staff_id === currentUser?.id) : leaves).filter(l => l.status === "pending").length;
  const approvedThisMonth = filtered.filter(l => l.status === "approved").reduce((sum, l) => sum + (Number(l.days) || 0), 0);

  const inputStyle = { width: "100%", padding: "14px 18px", border: "1px solid var(--border2)", borderRadius: 14, background: "rgba(255,255,255,0.02)", color: "var(--text)", outline: "none", fontSize: 15, transition: "all 0.2s" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32, animation: "fadeIn 0.5s ease-out" }}>
      {/* Premium Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 20 }}>
        <div>
          <h2 style={{ fontSize: 28, fontWeight: 950, color: "var(--text)", letterSpacing: -1 }}>
            {view === "employee" ? "Attendance & Leaves" : "Workforce Attendance"}
          </h2>
          <div style={{ fontSize: 14, color: "var(--text3)", fontWeight: 600, marginTop: 4 }}>
            {view === "employee" ? "Manage your time-off requests and track approval history" : "Monitor staff availability and process pending leave applications"}
          </div>
        </div>
        <button onClick={() => setShowForm(true)}
          style={{ padding: "12px 24px", borderRadius: 16, background: "var(--accent)", color: "#000", border: "none", cursor: "pointer", fontWeight: 900, fontSize: 13, textTransform: "uppercase", letterSpacing: 1, display: "flex", alignItems: "center", gap: 10, boxShadow: "0 10px 20px -10px rgba(34,211,238,0.4)" }}>
          <Icon name="plus" size={18} /> {view === "employee" ? "New Application" : "Log Manual Leave"}
        </button>
      </div>

      {/* Analytics Overview */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 24 }}>
        <StatCard 
          label="Pending Applications" 
          value={pendingCount} 
          subtext="Awaiting manager review"
          icon={<Icon name="clock" size={20} />}
          color={pendingCount > 0 ? "orange" : "accent"}
        />
        <StatCard 
          label={view === "employee" ? "Approved Days (Monthly)" : "Staff On Leave Today"} 
          value={view === "employee" ? `${approvedThisMonth} Days` : leaves.filter(l => l.date === NOW.toISOString().split('T')[0] && l.status === 'approved').length} 
          subtext={view === "employee" ? `Status for ${filterPrefix}` : "Approved absences today"}
          icon={<Icon name="checkCircle" size={20} />}
          color="green"
        />
        <StatCard 
          label="Total Records" 
          value={filtered.length} 
          subtext="Filtered month logs"
          icon={<Icon name="menu" size={20} />}
        />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 20, background: "var(--bg2)", padding: "16px 24px", borderRadius: 24, border: "1px solid var(--border)" }}>
        <PeriodWidget 
          filterMode="month" setFilterMode={() => {}} 
          filterYear={filterYear} setFilterYear={setFilterYear} 
          filterMonth={filterMonth} setFilterMonth={setFilterMonth} 
        />
        <ToggleGroup 
          options={[["all", "All Logs"], ["pending", "Pending"], ["approved", "Approved"], ["rejected", "Rejected"]]} 
          value={statusFilter} 
          onChange={setStatusFilter} 
        />
      </div>

      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
            <thead>
              <tr>
                <TH>Date of Absence</TH>
                {view !== "employee" && <TH>Team Member</TH>}
                {view !== "employee" && <TH>Branch Location</TH>}
                <TH right={view === "employee"}>Duration</TH>
                <TH>Context/Reason</TH>
                <TH>Audit Status</TH>
                <TH right>Actions</TH>
              </tr>
            </thead>
            <tbody>
              {filtered.map(l => {
                const s = staff.find(x => x.id === l.staff_id);
                const b = branches.find(x => x.id === s?.branch_id);
                return (
                  <tr key={l.id} onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.01)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <TD style={{ color: "var(--text3)", fontWeight: 700 }}>{l.date}</TD>
                    {view !== "employee" && <TD style={{ fontWeight: 800, color: "var(--text)" }}>{s?.name || "Unlinked User"}</TD>}
                    {view !== "employee" && <TD style={{ fontSize: 13, color: "var(--accent)", fontWeight: 600 }}>{b?.name || "—"}</TD>}
                    <TD right={view === "employee"} style={{ fontWeight: 900, color: "var(--text)" }}>{l.days} {l.days === 1 ? 'Day' : 'Days'}</TD>
                    <TD style={{ fontSize: 13, color: "var(--text3)", fontStyle: l.reason ? "normal" : "italic" }}>{l.reason || "No context provided"}</TD>
                    <TD><Pill label={l.status} color={l.status === 'approved' ? 'green' : l.status === 'rejected' ? 'red' : 'gold'} /></TD>
                    <TD right style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
                      {view === "admin" && l.status === 'pending' && (
                        <>
                          <IconBtn name="check" variant="success" size={28} onClick={() => handleUpdateStatus(l.id, 'approved')} />
                          <IconBtn name="close" variant="danger" size={28} onClick={() => handleUpdateStatus(l.id, 'rejected')} />
                        </>
                      )}
                      {(view === "admin" || (view === "employee" && l.status === 'pending')) && (
                        <IconBtn name="del" variant="danger" size={28} onClick={() => handleDelete(l.id)} />
                      )}
                      {view === "employee" && l.status !== 'pending' && <span style={{ color: "var(--text3)", fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>Locked</span>}
                    </TD>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={10} style={{ textAlign: "center", padding: 80, color: "var(--text3)", fontSize: 15, fontStyle: "italic" }}>No attendance logs found for this period.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal isOpen={showForm} onClose={() => setShowForm(false)} title={view === "employee" ? "Compose Leave Application" : "Log Professional Absence"}>
        <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: 24, padding: "8px 0" }}>
          {view !== "employee" && (
            <div>
              <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Target Member</label>
              <select value={form.staff_id} onChange={e => setForm({...form, staff_id: e.target.value})} style={inputStyle}>
                <option value="">Select Employee...</option>
                {staff.sort((a,b) => a.name.localeCompare(b.name)).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 20 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Commencement Date</label>
              <input type="date" value={form.date} onChange={e => setForm({...form, date: e.target.value})} style={inputStyle} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Total Duration (Days)</label>
              <input type="number" value={form.days} onChange={e => setForm({...form, days: e.target.value})} style={inputStyle} />
            </div>
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Justification / Reason</label>
            <textarea value={form.reason} onChange={e => setForm({...form, reason: e.target.value})} placeholder="Please provide brief context for this request..." style={{ ...inputStyle, height: 100, resize: "none" }} />
          </div>
          <button type="submit" style={{ padding: "18px", background: "var(--accent)", color: "#000", border: "none", borderRadius: 16, fontWeight: 950, fontSize: 14, textTransform: "uppercase", letterSpacing: 1.2, cursor: "pointer", marginTop: 8, boxShadow: "0 10px 30px -10px rgba(34,211,238,0.5)" }}>
            {view === "employee" ? "Send Application" : "Commit Record"}
          </button>
        </form>
      </Modal>

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        select option { background: #1a1b1e; color: #fff; }
      `}</style>
      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}
