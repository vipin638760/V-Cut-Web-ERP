"use client";
import { useEffect, useState } from "react";
import { collection, onSnapshot, doc, setDoc, deleteDoc, addDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { INR } from "@/lib/calculations";
import { Card, Pill, TH, TD, IconBtn, StatCard, Icon, useConfirm, useToast } from "@/components/ui";

export default function CostCenterTab() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [costCenters, setCostCenters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({ id: "", name: "", dept: "Operations", monthly_cost: "", mobile: "", notes: "" });

  useEffect(() => {
    if (!db) return;
    const unsub = onSnapshot(collection(db, "cost_centers"), sn => {
      setCostCenters(sn.docs.map(d => ({ ...d.data(), id: d.id })));
      setLoading(false);
    });
    return () => unsub();
  }, []);

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.name || !form.monthly_cost) { confirm({ title: "Validation", message: "Name and cost are required for provisioning.", confirmText: "OK", type: "warning", onConfirm: () => {} }); return; }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(), dept: form.dept, mobile: form.mobile.trim(), notes: form.notes.trim(),
        monthly_cost: Number(form.monthly_cost) || 0
      };
      if (form.id) {
        await setDoc(doc(db, "cost_centers", form.id), payload, { merge: true });
        toast({ title: "Updated", message: `${payload.name} has been updated.`, type: "success" });
      } else {
        await addDoc(collection(db, "cost_centers"), payload);
        toast({ title: "Added", message: `${payload.name} registered as a cost center.`, type: "success" });
      }

      setForm({ id: "", name: "", dept: "Operations", monthly_cost: "", mobile: "", notes: "" });
    } catch (e) { confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
    setSaving(false);
  };

  const handleEdit = (c) => setForm({ ...c });

  const handleDelete = async (id) => {
    confirm({
      title: "Delete Support Unit",
      message: "Are you sure you want to permanently remove this <strong>support unit</strong>?",
      confirmText: "Yes, Delete",
      cancelText: "Cancel",
      type: "danger",
      onConfirm: async () => {
        try {
          await deleteDoc(doc(db, "cost_centers", id));
          toast({ title: "Deleted", message: "Cost center has been removed.", type: "success" });
        } catch (e) { confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
      }
    });
  };

  if (loading) return <div style={{ padding: 60, textAlign: "center", color: "var(--accent)", fontWeight: 800 }}>Syncing administrative infrastructure...</div>;

  const totalCost = costCenters.reduce((s, c) => s + (c.monthly_cost || 0), 0);
  const inputStyle = { width: "100%", padding: "14px 18px", border: "1px solid var(--border2)", borderRadius: 14, background: "rgba(255,255,255,0.02)", color: "var(--text)", outline: "none", fontSize: 13, transition: "all 0.2s" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32, animation: "fadeIn 0.5s ease-out" }}>
      {/* Informational Header */}
      <div style={{ background: "rgba(34,211,238,0.05)", border: "1px dashed var(--accent)", borderRadius: 24, padding: "24px 32px", display: "flex", gap: 24, alignItems: "center" }}>
        <div style={{ background: "rgba(34,211,238,0.1)", padding: 16, borderRadius: 20 }}>
           <Icon name="zap" size={24} color="var(--accent)" />
        </div>
        <div style={{ flex: 1 }}>
           <h4 style={{ fontSize: 13, fontWeight: 900, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 2, marginBottom: 8 }}>Global Overhead Analysis</h4>
           <p style={{ fontSize: 14, color: "var(--text3)", fontWeight: 500, lineHeight: 1.6 }}>Cost Centers represent support and administrative units (Finance, HR, Group Ops) whose costs are shared across the network. These expenses are consolidated at the Group P&L level rather than charged to individual branches.</p>
        </div>
        <StatCard 
          label="Total Monthly Overhead" 
          value={INR(totalCost)} 
          subtext="Net consolidated support cost"
          icon={<Icon name="trending" size={18} />}
          color="gold"
          style={{ minWidth: 280, marginTop: 0 }}
        />
      </div>

      <Card style={{ padding: 32, border: form.id ? "1px solid var(--gold)" : undefined, boxShadow: form.id ? "0 0 24px -8px rgba(255,215,0,0.35)" : undefined }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ background: form.id ? "rgba(255,215,0,0.15)" : "rgba(255,215,0,0.1)", padding: 10, borderRadius: 12 }}>
              <Icon name={form.id ? "edit" : "users"} size={20} color="var(--gold)" />
            </div>
            <h3 style={{ fontSize: 18, fontWeight: 950, color: form.id ? "var(--gold)" : "var(--text)", textTransform: "uppercase", letterSpacing: 1 }}>{form.id ? `Editing: ${form.name || "—"}` : "Register Non-Branch Resource"}</h3>
          </div>
          {form.id && (
            <span style={{ padding: "6px 12px", borderRadius: 999, background: "rgba(255,215,0,0.15)", color: "var(--gold)", fontSize: 10, fontWeight: 900, textTransform: "uppercase", letterSpacing: 1 }}>Edit Mode</span>
          )}
        </div>

        <form onSubmit={handleSave} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 20 }}>
          <div style={{ gridColumn: "span 1" }}>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Asset / Member Name</label>
            <input placeholder="e.g. Finance Auditor" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Assigned Department</label>
            <select value={form.dept} onChange={e => setForm({ ...form, dept: e.target.value })} style={{ ...inputStyle, appearance: "none" }}>
              {["Accounts & Finance", "Operations", "HR & Admin", "Marketing", "IT Support", "Management", "Other Support"].map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--gold)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Net Monthly Provision (₹)</label>
            <input type="number" placeholder="0" min="0" value={form.monthly_cost} onChange={e => setForm({ ...form, monthly_cost: e.target.value })} style={{ ...inputStyle, borderColor: "var(--gold)", background: "rgba(255,215,0,0.03)" }} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Secure Mobile</label>
            <input placeholder="Contact terminal" value={form.mobile} onChange={e => setForm({ ...form, mobile: e.target.value })} style={inputStyle} />
          </div>

          <div style={{ gridColumn: "1 / -1", display: "flex", gap: 12, marginTop: 12 }}>
             <button type="submit" disabled={saving} style={{ padding: "14px 28px", borderRadius: 14, background: "var(--accent)", color: "#000", border: "none", fontWeight: 950, fontSize: 13, textTransform: "uppercase", letterSpacing: 1.2, cursor: "pointer", boxShadow: "0 10px 20px -10px rgba(34,211,238,0.4)" }}>{saving ? "Processing..." : (form.id ? "Commit Updates" : "Register Asset")}</button>
            <button type="button" onClick={() => setForm({ id: "", name: "", dept: "Operations", monthly_cost: "", mobile: "", notes: "" })} style={{ padding: "14px 28px", borderRadius: 14, background: "rgba(255,255,255,0.05)", color: "var(--text2)", border: "1px solid var(--border)", fontWeight: 700, fontSize: 13, textTransform: "uppercase", letterSpacing: 1, cursor: "pointer" }}>Reset Node</button>
          </div>
        </form>
      </Card>

      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
           <div style={{ height: 2, width: 20, background: "var(--accent)" }}></div>
           <h4 style={{ fontSize: 12, fontWeight: 900, color: "var(--text2)", textTransform: "uppercase", letterSpacing: 2 }}>Non-Branch Personnel Ledger</h4>
        </div>
        <Card style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
            <thead><tr><TH>Identified Name</TH><TH>Node / Dept</TH><TH>Contact</TH><TH right>Allocated Cost (₹)</TH><TH right>Actions</TH></tr></thead>
            <tbody>
              {costCenters.map(cc => (
                <tr key={cc.id} onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.01)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <TD style={{ fontWeight: 800, color: "var(--text)" }}>{cc.name}</TD>
                  <TD><Pill label={cc.dept || "Unassigned"} color="purple" /></TD>
                  <TD style={{ color: "var(--text3)", fontSize: 13, fontWeight: 600 }}>{cc.mobile || "—"}</TD>
                  <TD right style={{ fontWeight: 950, color: "var(--gold)", fontSize: 14 }}>{INR(cc.monthly_cost)}</TD>
                  <TD right>
                    <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                      <IconBtn name="edit" size={24} onClick={() => handleEdit(cc)} />
                      <IconBtn name="del" size={24} variant="danger" onClick={() => handleDelete(cc.id)} />
                    </div>
                  </TD>
                </tr>
              ))}
              {costCenters.length === 0 && <tr><td colSpan={6} style={{ padding: 60, textAlign: "center", color: "var(--text3)", fontStyle: "italic" }}>No consolidated support assets identified.</td></tr>}
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
