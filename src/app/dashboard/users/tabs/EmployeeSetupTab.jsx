"use client";
import { useEffect, useState } from "react";
import { collection, onSnapshot, doc, setDoc, deleteDoc, addDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { INR, staffOverallStatus } from "@/lib/calculations";
import { Card, Pill, TH, TD, IconBtn, StatCard, Icon, Modal, ToggleGroup, useConfirm, useToast } from "@/components/ui";
import VLoader from "@/components/VLoader";


export default function EmployeeSetupTab() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [staff, setStaff] = useState([]);
  const [branches, setBranches] = useState([]);
  const [statusLog, setStatusLog] = useState([]);
  const [loading, setLoading] = useState(true);
  
  const [statusFilter, setStatusFilter] = useState("all");
  const [showAdvance, setShowAdvance] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [advForm, setAdvForm] = useState({ staff_id: "", staff_name: "", amount: "", reason: "", month_str: "" });
  const [editForm, setEditForm] = useState({ id: "", name: "", role: "", salary: "", target: "", branch_id: "" });

  useEffect(() => {
    if (!db) return;
    const unsubS = onSnapshot(collection(db, "staff"), sn => setStaff(sn.docs.map(d => ({ ...d.data(), id: d.id }))));
    const unsubB = onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id }))));
    const unsubL = onSnapshot(collection(db, "staff_status_log"), sn => {
      setStatusLog(sn.docs.map(d => ({ ...d.data(), id: d.id })));
      setLoading(false);
    });
    return () => { unsubS(); unsubB(); unsubL(); };
  }, []);

  const handleToggleStatus = async (s) => {
    const overall = staffOverallStatus(s);
    const newStatus = overall === "active" ? "inactive" : "active";
    const chosenDate = prompt(`Enter ${newStatus === 'inactive' ? 'Exit' : 'Re-join'} Date (YYYY-MM-DD):`, new Date().toISOString().slice(0, 10));
    if (!chosenDate) return;

    confirm({
      title: "Status Transition",
      message: `Transition <strong>${s.name}</strong> to <strong>${newStatus.toUpperCase()}</strong> effective ${chosenDate}?`,
      confirmText: "Yes, Proceed",
      cancelText: "Cancel",
      type: "warning",
      onConfirm: async () => {
        try {
          if (overall === "active") {
            await setDoc(doc(db, "staff", s.id), { exit_date: chosenDate }, { merge: true });
          } else {
            await setDoc(doc(db, "staff", s.id), { exit_date: null, join: chosenDate }, { merge: true });
          }
          await addDoc(collection(db, "staff_status_log"), {
            staff_id: s.id, staff_name: s.name, action: newStatus, date: chosenDate,
            recorded_at: new Date().toISOString()
          });
          toast({ title: "Updated", message: `${s.name} status changed to ${newStatus}.`, type: "success" });
        } catch (e) { confirm({ title: "Error", message: "Status update failed: " + e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
      }
    });
  };

  const handleDelete = async (s) => {
    confirm({
      title: "Delete Personnel Record",
      message: `Permanently delete personnel record for <strong>${s.name}</strong>? This action is irreversible.`,
      confirmText: "Yes, Delete",
      cancelText: "Cancel",
      type: "danger",
      onConfirm: async () => {
        try { await deleteDoc(doc(db, "staff", s.id)); toast({ title: "Deleted", message: `${s.name} has been removed.`, type: "success" }); } catch (e) { confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
      }
    });
  };

  const handleRequestAdvance = async () => {
    if (!advForm.amount || Number(advForm.amount) <= 0) { confirm({ title: "Validation", message: "Valid disbursement amount required.", confirmText: "OK", type: "warning", onConfirm: () => {} }); return; }

    const staffRef = staff.find(x => x.id === advForm.staff_id);
    const doSubmit = async () => {
      try {
        await addDoc(collection(db, "staff_advances"), {
          ...advForm,
          amount: Number(advForm.amount),
          status: "pending",
          date: new Date().toISOString().split("T")[0],
          at: new Date().toISOString()
        });
        setShowAdvance(false);
        toast({ title: "Saved", message: "Advance request submitted successfully.", type: "success" });
      } catch (e) { confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
    };

    if (staffRef && Number(advForm.amount) > (staffRef.salary * 0.5)) {
      confirm({
        title: "High Disbursement Alert",
        message: `Request exceeds 50% of base salary (<strong>${INR(staffRef.salary * 0.5)}</strong>). Proceed with authorization?`,
        confirmText: "Yes, Proceed",
        cancelText: "Cancel",
        type: "warning",
        onConfirm: doSubmit
      });
    } else {
      await doSubmit();
    }
  };

  const handleSaveEdit = async () => {
    if (!editForm.name) { confirm({ title: "Validation", message: "Legal descriptor name is required.", confirmText: "OK", type: "warning", onConfirm: () => {} }); return; }
    try {
      await setDoc(doc(db, "staff", editForm.id), {
        ...editForm,
        salary: Number(editForm.salary) || 0,
        target: Number(editForm.target) || 0
      }, { merge: true });
      setShowEdit(false);
      toast({ title: "Updated", message: "Employee record updated successfully.", type: "success" });
    } catch (e) { confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
  };

  if (loading) return <VLoader fullscreen label="Loading personnel telemetry" />;

  const totalActive = staff.filter(s => staffOverallStatus(s) === "active").length;
  const totalInactive = staff.filter(s => staffOverallStatus(s) === "inactive").length;

  let displayStaff = [...staff].sort((a,b) => (a.name).localeCompare(b.name));
  if (statusFilter === "active") displayStaff = displayStaff.filter(s => staffOverallStatus(s) === "active");
  if (statusFilter === "inactive") displayStaff = displayStaff.filter(s => staffOverallStatus(s) === "inactive");

  const inputStyle = { width: "100%", padding: "14px 18px", border: "1px solid var(--border2)", borderRadius: 14, background: "rgba(255,255,255,0.02)", color: "var(--text)", outline: "none", fontSize: 13, transition: "all 0.2s" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32, animation: "fadeIn 0.5s ease-out" }}>
      
      {/* Workforce Dashboard */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 24 }}>
        <StatCard 
          label="Total Global Workforce" 
          value={staff.length} 
          subtext="Personnel in database"
          icon={<Icon name="users" size={20} />} 
          color="accent" 
        />
        <StatCard 
          label="Operational Units" 
          value={totalActive} 
          subtext="Actively deployed staff"
          icon={<Icon name="checkCircle" size={20} />} 
          color="green" 
        />
        <StatCard 
          label="Workforce Attrition" 
          value={totalInactive} 
          subtext="Alumni & inactive records"
          icon={<Icon name="info" size={20} />} 
          color="red" 
        />
      </div>

      {/* Control Strip */}
      <div style={{ background: "var(--bg2)", padding: "16px 24px", borderRadius: 24, border: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 20 }}>
        <ToggleGroup 
          options={[
            ["all", "Network Scope"],
            ["active", "Active Deployment"],
            ["inactive", "Retention Logs"]
          ]} 
          value={statusFilter} 
          onChange={setStatusFilter} 
        />
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text3)", display: "flex", alignItems: "center", gap: 10 }}>
          <Icon name="zap" size={14} color="var(--gold)" />
          Real-time status synchronization active
        </div>
      </div>

      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
            <thead>
              <tr>
                <TH>Representative Name</TH>
                <TH>Assigned Node</TH>
                <TH>Primary Role</TH>
                <TH right>Base Compensation</TH>
                <TH>Status & Timeline</TH>
                <TH>Incident Logs</TH>
                <TH right>Protocol Controls</TH>
              </tr>
            </thead>
            <tbody>
              {displayStaff.map((s) => {
                const b = branches.find(x => x.id === s.branch_id);
                const overall = staffOverallStatus(s);
                const slog = statusLog.filter(l => l.staff_id === s.id).sort((x, y) => y.date.localeCompare(x.date));
                
                return (
                  <tr key={s.id} onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.01)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <TD style={{ fontWeight: 800, color: overall === "inactive" ? "var(--text3)" : "var(--text)" }}>{s.name}</TD>
                    <TD style={{ color: "var(--accent)", fontSize: 13, fontWeight: 700 }}>{b ? b.name : "Unmapped"}</TD>
                    <TD><Pill label={s.role || "Level 1"} color="blue" /></TD>
                    <TD right style={{ color: "var(--gold)", fontWeight: 950, fontSize: 14 }}>{INR(s.salary)}</TD>
                    <TD>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                         <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 800, textTransform: "uppercase" }}>Inducted: {s.join || "—"}</div>
                         <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                           <Pill label={overall} color={overall === "active" ? "green" : "red"} />
                           <button onClick={() => handleToggleStatus(s)} style={{ fontSize: 9, background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text2)", padding: "2px 6px", cursor: "pointer", fontWeight: 800, textTransform: "uppercase" }}>Override</button>
                         </div>
                      </div>
                    </TD>
                    <TD>
                      {slog.length > 0 ? (
                        <details style={{ cursor: "pointer" }}>
                          <summary style={{ outline: "none", fontSize: 11, fontWeight: 800, color: "var(--accent)", listStyle: "none" }}>{slog.length} Activities</summary>
                          <div style={{ paddingTop: 10, display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid var(--border2)", marginTop: 6 }}>
                            {slog.map((l, idx) => <div key={idx} style={{ fontSize: 10, color: l.action === "inactive" ? "var(--red)" : "var(--green)", fontWeight: 700 }}>{l.date}: {l.action.toUpperCase()}</div>)}
                          </div>
                        </details>
                      ) : <span style={{ opacity: 0.2 }}>Clean Record</span>}
                    </TD>
                    <TD right>
                      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
                        <IconBtn name="edit" size={28} onClick={() => { setEditForm({ ...s }); setShowEdit(true); }} />
                        <button onClick={() => { setShowAdvance(true); setAdvForm({ staff_id: s.id, staff_name: s.name, amount: "", reason: "", month_str: new Date().toISOString().slice(0, 7) }); }} 
                          style={{ fontSize: 10, padding: "8px 14px", background: "rgba(255,215,0,0.1)", color: "var(--gold)", border: "1px solid rgba(255,215,0,0.2)", borderRadius: 10, fontWeight: 900, cursor: "pointer", textTransform: "uppercase", letterSpacing: 1 }}>
                          Payout
                        </button>
                        <IconBtn name="del" variant="danger" size={28} onClick={() => handleDelete(s)} />
                      </div>
                    </TD>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Financial Payout / Advance Modal */}
      <Modal isOpen={showAdvance} title="Financial Disbursement Protocols" onClose={() => setShowAdvance(false)}>
        <div style={{ display: "flex", flexDirection: "column", gap: 24, padding: "8px 0" }}>
          <div style={{ background: "rgba(34,211,238,0.05)", padding: 20, borderRadius: 16, border: "1px solid var(--border2)" }}>
            <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 900, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6 }}>Associated Profile</div>
            <div style={{ fontSize: 18, fontWeight: 950, color: "var(--accent)" }}>{advForm.staff_name}</div>
          </div>
          
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Requested Amount (₹)</label>
              <input type="number" value={advForm.amount} onChange={e => setAdvForm({...advForm, amount: e.target.value})} placeholder="0" style={{ ...inputStyle, borderColor: "var(--gold)", background: "rgba(255,215,0,0.03)" }} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Settlement Month</label>
              <input type="month" value={advForm.month_str} onChange={e => setAdvForm({...advForm, month_str: e.target.value})} style={inputStyle} />
            </div>
          </div>

          <div>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Disbursement Context</label>
            <textarea value={advForm.reason} onChange={e => setAdvForm({...advForm, reason: e.target.value})} placeholder="Provide professional justification for this advance..." style={{ ...inputStyle, height: 100, resize: "none" }} />
          </div>

          <button onClick={handleRequestAdvance} style={{ padding: "18px", borderRadius: 16, background: "linear-gradient(135deg, var(--gold), var(--gold2))", color: "#000", border: "none", fontWeight: 950, fontSize: 14, textTransform: "uppercase", letterSpacing: 1.2, cursor: "pointer", marginTop: 8, boxShadow: "0 10px 30px -10px rgba(255,215,0,0.5)" }}>Authorize Disbursement</button>
        </div>
      </Modal>

      {/* Profile Modification Modal */}
      <Modal isOpen={showEdit} title="Personnel Record Refinement" onClose={() => setShowEdit(false)}>
        <div style={{ display: "flex", flexDirection: "column", gap: 24, padding: "8px 0" }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Legal Identity Name</label>
            <input type="text" value={editForm.name} onChange={e => setEditForm({...editForm, name: e.target.value})} style={inputStyle} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Base Compensation (₹)</label>
              <input type="number" value={editForm.salary} onChange={e => setEditForm({...editForm, salary: e.target.value})} style={inputStyle} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Productivity Target</label>
              <input type="number" value={editForm.target} onChange={e => setEditForm({...editForm, target: e.target.value})} style={inputStyle} />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Primary Node Asset</label>
              <select value={editForm.branch_id} onChange={e => setEditForm({...editForm, branch_id: e.target.value})} style={{ ...inputStyle, appearance: "none" }}>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Designated Permission</label>
              <select value={editForm.role} onChange={e => setEditForm({...editForm, role: e.target.value})} style={{ ...inputStyle, appearance: "none" }}>
                <option value="Senior Stylist">Chief Strategist / Senior</option>
                <option value="Stylist">Operations Specialist</option>
                <option value="Trainee">Junior / Trainee</option>
                <option value="Receptionist">Front-Desk Curator</option>
                <option value="Manager">Node Manager</option>
              </select>
            </div>
          </div>

          <button onClick={handleSaveEdit} style={{ padding: "18px", borderRadius: 16, background: "var(--accent)", color: "#000", border: "none", fontWeight: 950, fontSize: 14, textTransform: "uppercase", letterSpacing: 1.2, cursor: "pointer", marginTop: 8, boxShadow: "0 10px 30px -10px rgba(34,211,238,0.5)" }}>Commit Protocol Changes</button>
        </div>
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
