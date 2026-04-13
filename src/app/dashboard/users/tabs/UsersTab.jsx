"use client";
import { useEffect, useState } from "react";
import { collection, onSnapshot, doc, setDoc, deleteDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { DEFAULTS_USERS } from "@/lib/constants";
import { Card, Pill, TH, TD, IconBtn, Icon, useConfirm, useToast } from "@/components/ui";

export default function UsersTab() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [users, setUsers] = useState([]);
  const [branches, setBranches] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  
  const [form, setForm] = useState({ 
    id: "", 
    name: "", 
    role: "employee", 
    password: "", 
    branch_id: "all", 
    staff_id: "" 
  });
  const [saving, setSaving] = useState(false);
  const isEditing = !!users.find(u => u.uid === form.id && form.id !== "");

  useEffect(() => {
    if (!db) return;
    const unsubB = onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id }))));
    const unsubS = onSnapshot(collection(db, "staff"), sn => setStaff(sn.docs.map(d => ({ ...d.data(), id: d.id }))));
    const unsubU = onSnapshot(collection(db, "users"), sn => {
      const dbUsers = sn.docs.map(d => ({ ...d.data(), uid: d.id }));
      setUsers(dbUsers.length ? dbUsers : DEFAULTS_USERS);
      setLoading(false);
    });
    return () => { unsubB(); unsubS(); unsubU(); };
  }, []);

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.id || !form.name || !form.password) { confirm({ title: "Validation", message: "System credentials required.", confirmText: "OK", type: "warning", onConfirm: () => {} }); return; }
    setSaving(true);
    try {
      await setDoc(doc(db, "users", form.id), {
        ...form,
        staff_id: form.staff_id || "",
        branch_id: form.branch_id || "all"
      });
      toast({ title: "Saved", message: "User credentials saved successfully.", type: "success" });
      setForm({ id: "", name: "", role: "employee", password: "", branch_id: "all", staff_id: "" });
    } catch (e) { confirm({ title: "Deployment Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
    setSaving(false);
  };

  const handleEdit = (u) => setForm({ 
    ...u, 
    id: u.uid || u.id,
    password: u.password || "",
    staff_id: u.staff_id || "",
    branch_id: u.branch_id || "all"
  });

  const handleDelete = async (id) => {
    confirm({
      title: "Deactivate Identity",
      message: "Are you sure you want to permanently deactivate this <strong>identity</strong>?",
      confirmText: "Yes, Deactivate",
      cancelText: "Cancel",
      type: "danger",
      onConfirm: async () => {
        try { await deleteDoc(doc(db, "users", id)); toast({ title: "Deleted", message: "User has been removed.", type: "success" }); } catch (e) { confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
      }
    });
  };

  if (loading) return <div style={{ padding: 60, textAlign: "center", color: "var(--accent)", fontWeight: 800 }}>Syncing identity registry...</div>;

  const inputStyle = { width: "100%", padding: "14px 18px", border: "1px solid var(--border2)", borderRadius: 14, background: "rgba(255,255,255,0.02)", color: "var(--text)", outline: "none", fontSize: 13, transition: "all 0.2s" };

  return (
    <div style={{ animation: "fadeIn 0.5s ease-out", display: "flex", flexDirection: "column", gap: 32 }}>
      
      {/* Identity Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 24 }}>
        <div>
           <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <div style={{ background: "rgba(34,211,238,0.1)", padding: 8, borderRadius: 10 }}>
                 <Icon name="users" size={18} color="var(--accent)" />
              </div>
              <h3 style={{ fontSize: 22, fontWeight: 950, color: "var(--text)", textTransform: "uppercase", letterSpacing: 1 }}>Access Registry</h3>
           </div>
           <p style={{ fontSize: 13, color: "var(--text3)", fontWeight: 500 }}>Authorize system credentials and define network-wide permissions.</p>
        </div>
        <Pill label={`${users.length} Active Personas`} color="gold" />
      </div>

      {/* Credential Provisioning Form */}
      <Card style={{ padding: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32 }}>
          <div style={{ background: isEditing ? "rgba(74,222,128,0.1)" : "rgba(255,215,0,0.1)", padding: 10, borderRadius: 12 }}>
            <Icon name={isEditing ? "edit" : "plus"} size={16} color={isEditing ? "var(--green)" : "var(--gold)"} />
          </div>
          <h4 style={{ fontSize: 14, fontWeight: 900, color: "var(--text)", textTransform: "uppercase", letterSpacing: 1.5 }}>
            {isEditing ? `Modifying Identity: ${form.id}` : "Provision New Identity"}
          </h4>
        </div>
        
        <form onSubmit={handleSave} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 24 }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Unique Identifier (ID)</label>
            <input placeholder="e.g. system_admin" value={form.id} onChange={e => setForm({ ...form, id: e.target.value })} style={{ ...inputStyle, border: isEditing ? "1px solid var(--border2)" : "1px solid var(--gold)", color: isEditing ? "var(--text3)" : "var(--gold)" }} disabled={isEditing} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Display Label</label>
            <input placeholder="Legal name or alias" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Permission Tier</label>
            <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} style={{ ...inputStyle, appearance: "none" }}>
              <option value="admin">Level 5: Administrator</option>
              <option value="accountant">Level 3: Financial Ops</option>
              <option value="employee">Level 1: Field Personnel</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Authentication Key</label>
            <input type="text" placeholder="Min 8 characters required" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Node Access (Branch)</label>
            <select value={form.branch_id || "all"} onChange={e => setForm({ ...form, branch_id: e.target.value })} style={{ ...inputStyle, appearance: "none" }}>
              <option value="all">Global Network Access</option>
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Linked Staff Asset</label>
            <select value={form.staff_id || ""} onChange={e => setForm({ ...form, staff_id: e.target.value })} style={{ ...inputStyle, appearance: "none" }}>
              <option value="">No Profile Association</option>
              {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          
          <div style={{ gridColumn: "1 / -1", display: "flex", gap: 16, marginTop: 12 }}>
            <button type="submit" disabled={saving} style={{ padding: "16px 40px", borderRadius: 16, background: isEditing ? "var(--green)" : "var(--accent)", color: "#000", border: "none", fontWeight: 950, fontSize: 13, textTransform: "uppercase", letterSpacing: 1.2, cursor: "pointer", boxShadow: `0 10px 20px -10px ${isEditing ? "rgba(74,222,128,0.4)" : "rgba(34,211,238,0.4)"}` }}>
              {saving ? "Deploying..." : isEditing ? "Apply Protocol" : "Authorize Identity"}
            </button>
            <button type="button" onClick={() => setForm({ id: "", name: "", role: "employee", password: "", branch_id: "all", staff_id: "" })} style={{ padding: "16px 32px", borderRadius: 16, background: "rgba(255,255,255,0.05)", color: "var(--text2)", border: "1px solid var(--border)", fontWeight: 700, fontSize: 13, textTransform: "uppercase", letterSpacing: 1, cursor: "pointer" }}>
              {isEditing ? "Discard Changes" : "Reset Form"}
            </button>
          </div>
        </form>
      </Card>

      {/* Identity Table */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
           <div style={{ height: 2, width: 20, background: "var(--accent)" }}></div>
           <h4 style={{ fontSize: 12, fontWeight: 900, color: "var(--text2)", textTransform: "uppercase", letterSpacing: 2 }}>Authenticated Personnel Registry</h4>
        </div>
        
        <Card style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
            <thead>
              <tr>
                <TH>Persistent ID</TH>
                <TH>Assigned Label</TH>
                <TH>Tier</TH>
                <TH>Node Auth</TH>
                <TH>Linked Asset</TH>
                <TH right>Control</TH>
              </tr>
            </thead>
            <tbody>
              {users.map(u => {
                const b = branches.find(x => x.id === u.branch_id);
                const s = staff.find(x => x.id === u.staff_id);
                const roleColor = u.role === "admin" ? "gold" : u.role === "accountant" ? "green" : "blue";
                return (
                  <tr key={u.id} onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.01)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <TD style={{ fontFamily: "monospace", fontSize: 12, color: "var(--accent)", fontWeight: 700 }}>{u.id}</TD>
                    <TD style={{ fontWeight: 800, color: "var(--text)" }}>{u.name}</TD>
                    <TD><Pill label={u.role} color={roleColor} /></TD>
                    <TD style={{ color: "var(--text2)", fontSize: 13, fontWeight: 600 }}>
                      {u.branch_id === "all" ? <span style={{color:"var(--gold)"}}>Global Network</span> : b ? b.name : "Local Node"}
                    </TD>
                    <TD style={{ color: "var(--text3)", fontSize: 13, fontWeight: 500 }}>{s ? s.name : <span style={{opacity:0.3}}>Isolated ID</span>}</TD>
                    <TD right>
                      <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
                        <IconBtn name="edit" size={28} onClick={() => handleEdit(u)} />
                        <IconBtn name="del" variant="danger" size={28} onClick={() => handleDelete(u.uid || u.id)} />
                      </div>
                    </TD>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        select option { background: #1a1b1e; color: #fff; }
      `}</style>
      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}
