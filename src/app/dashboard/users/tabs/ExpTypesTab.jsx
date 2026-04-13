"use client";
import { useEffect, useRef, useState } from "react";
import { collection, onSnapshot, doc, setDoc, deleteDoc, addDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Card, Pill, TH, TD, IconBtn, Modal, Icon, useConfirm, useToast } from "@/components/ui";

export default function ExpTypesTab() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [expenseTypes, setExpenseTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", category: "utilities", desc: "" });

  // Edit State
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState({ id: "", name: "", category: "utilities", desc: "" });

  const dedupInFlight = useRef(false);

  const findDuplicates = (rows) => {
    const byName = new Map();
    rows.forEach(r => {
      const key = (r.name || "").trim().toLowerCase();
      if (!key) return;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(r);
    });
    const toDelete = [];
    byName.forEach(group => {
      if (group.length > 1) {
        group.sort((a, b) => (b.desc?.length || 0) - (a.desc?.length || 0) || a.id.localeCompare(b.id));
        for (let i = 1; i < group.length; i++) toDelete.push(group[i].id);
      }
    });
    return toDelete;
  };

  useEffect(() => {
    if (!db) return;
    const unsub = onSnapshot(collection(db, "expense_types"), async sn => {
      const rows = sn.docs.map(d => ({ ...d.data(), id: d.id }));
      setExpenseTypes(rows);
      setLoading(false);

      // Auto-run dedup whenever duplicates detected (guarded against overlapping runs)
      if (!dedupInFlight.current) {
        const toDelete = findDuplicates(rows);
        if (toDelete.length > 0) {
          dedupInFlight.current = true;
          try {
            await Promise.all(toDelete.map(id => deleteDoc(doc(db, "expense_types", id))));
            toast({ title: "Cleaned Duplicates", message: `Removed ${toDelete.length} duplicate classification(s).`, type: "success" });
          } catch { /* ignore */ }
          dedupInFlight.current = false;
        }
      }
    });
    return () => unsub();
  }, []);

  const handleCleanupDuplicates = async () => {
    const toDelete = findDuplicates(expenseTypes);
    if (toDelete.length === 0) {
      toast({ title: "No Duplicates", message: "Collection is already clean.", type: "info" });
      return;
    }
    try {
      await Promise.all(toDelete.map(id => deleteDoc(doc(db, "expense_types", id))));
      toast({ title: "Cleaned Duplicates", message: `Removed ${toDelete.length} duplicate classification(s).`, type: "success" });
    } catch (e) {
      confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} });
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { confirm({ title: "Validation", message: "Type name required.", confirmText: "OK", type: "warning", onConfirm: () => {} }); return; }
    setSaving(true);
    try {
      await addDoc(collection(db, "expense_types"), { ...form, active: true });
      setForm({ name: "", category: "utilities", desc: "" });
      toast({ title: "Saved", message: "Expense type created successfully.", type: "success" });
    } catch (e) { confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
    setSaving(false);
  };

  const handleToggle = async (t) => {
    try { await setDoc(doc(db, "expense_types", t.id), { active: !t.active }, { merge: true }); }
    catch (e) { confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
  };

  const handleDelete = async (id) => {
    confirm({
      title: "Delete Classification",
      message: "Are you sure you want to permanently remove this <strong>custom classification</strong>?",
      confirmText: "Yes, Delete",
      cancelText: "Cancel",
      type: "danger",
      onConfirm: async () => {
        try { await deleteDoc(doc(db, "expense_types", id)); toast({ title: "Deleted", message: "Expense type has been removed.", type: "success" }); } catch (e) { confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
      }
    });
  };

  const handleEditClick = (et) => {
    setEditForm({ id: et.id, name: et.name, category: et.category || "utilities", desc: et.desc || "" });
    setIsEditing(true);
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    if (!editForm.name.trim()) { confirm({ title: "Validation", message: "Type descriptor required.", confirmText: "OK", type: "warning", onConfirm: () => {} }); return; }
    setSaving(true);
    try {
      await setDoc(doc(db, "expense_types", editForm.id), {
        name: editForm.name,
        category: editForm.category,
        desc: editForm.desc
      }, { merge: true });
      setIsEditing(false);
      toast({ title: "Updated", message: "Expense type updated successfully.", type: "success" });
    } catch (error) {
      confirm({ title: "Error", message: error.message, confirmText: "OK", type: "danger", onConfirm: () => {} });
    }
    setSaving(false);
  };

  if (loading) return <div style={{ padding: 60, textAlign: "center", color: "var(--accent)", fontWeight: 800 }}>Loading category registry...</div>;

  const IS = { width: "100%", padding: "14px 18px", border: "1px solid var(--border2)", borderRadius: 14, background: "rgba(255,255,255,0.02)", color: "var(--text)", outline: "none", fontSize: 13, transition: "all 0.2s" };
  const chevronSvg = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>")`;
  const SS = {
    ...IS,
    appearance: "none",
    WebkitAppearance: "none",
    MozAppearance: "none",
    paddingRight: 44,
    backgroundImage: chevronSvg,
    backgroundRepeat: "no-repeat",
    backgroundPosition: "right 16px center",
    backgroundSize: "14px 14px",
    cursor: "pointer",
    fontWeight: 600,
  };
  const CATEGORIES = [
    ["utilities", "Utilities & Overheads"],
    ["cleaning", "Cleaning & Hygiene"],
    ["maintenance", "Unit Maintenance"],
    ["staff", "Human Resources"],
    ["other", "General / Miscellaneous"],
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32, animation: "fadeIn 0.5s ease-out" }}>
      {/* Configuration Header */}
      <Card style={{ padding: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
          <div style={{ background: "rgba(34,211,238,0.1)", padding: 10, borderRadius: 12 }}>
            <Icon name="zap" size={20} color="var(--accent)" />
          </div>
          <div>
             <h3 style={{ fontSize: 18, fontWeight: 950, color: "var(--text)", textTransform: "uppercase", letterSpacing: 1 }}>Expense Classification Engine</h3>
             <div style={{ fontSize: 13, color: "var(--text3)", fontWeight: 500, marginTop: 4 }}>Add custom descriptors to appear across all transactional units</div>
          </div>
        </div>

        <form onSubmit={handleSave} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 20 }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Descriptor Name</label>
            <input placeholder="e.g. Generator Maintenance" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={IS} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Business Category</label>
            <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} style={SS}>
              {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Contextual Purpose</label>
            <input placeholder="Brief explanation of use..." value={form.desc} onChange={e => setForm({ ...form, desc: e.target.value })} style={IS} />
          </div>

          <div style={{ gridColumn: "1 / -1", display: "flex", gap: 12, marginTop: 12 }}>
            <button type="submit" disabled={saving} style={{ padding: "14px 28px", borderRadius: 14, background: "var(--accent)", color: "#000", border: "none", fontWeight: 950, fontSize: 13, textTransform: "uppercase", letterSpacing: 1.2, cursor: "pointer", boxShadow: "0 10px 20px -10px rgba(34,211,238,0.4)" }}>
              {saving ? "Deploying..." : "Provision Category"}
            </button>
            <button type="button" onClick={() => setForm({ name: "", category: "utilities", desc: "" })} style={{ padding: "14px 28px", borderRadius: 14, background: "rgba(255,255,255,0.05)", color: "var(--text2)", border: "1px solid var(--border)", fontWeight: 700, fontSize: 13, textTransform: "uppercase", letterSpacing: 1, cursor: "pointer" }}>Clear Form</button>
          </div>
        </form>
      </Card>

      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ height: 2, width: 20, background: "var(--gold)" }}></div>
            <h4 style={{ fontSize: 12, fontWeight: 900, color: "var(--text2)", textTransform: "uppercase", letterSpacing: 2 }}>All Classifications ({expenseTypes.length})</h4>
          </div>
          <button onClick={handleCleanupDuplicates}
            style={{ padding: "6px 12px", borderRadius: 8, background: "rgba(239,68,68,0.1)", color: "var(--red)", border: "1px solid rgba(239,68,68,0.2)", fontSize: 10, fontWeight: 900, textTransform: "uppercase", letterSpacing: 1, cursor: "pointer" }}>
            Cleanup Duplicates
          </button>
        </div>
        <Card style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
            <thead><tr><TH>Classification</TH><TH>Node</TH><TH>Context</TH><TH right>Control</TH></tr></thead>
            <tbody>
              {expenseTypes.map(et => (
                <tr key={et.id} onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.01)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <TD style={{ fontWeight: 800, color: "var(--text)" }}>{et.name}</TD>
                  <TD><Pill label={et.category || "—"} color="blue" /></TD>
                  <TD style={{ color: "var(--text3)", fontSize: 12, fontStyle: et.desc ? "normal" : "italic" }}>{et.desc || "No context provided"}</TD>
                  <TD right>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button onClick={() => handleToggle(et)} style={{ background: et.active ? "rgba(34,211,238,0.1)" : "rgba(239,68,68,0.1)", color: et.active ? "var(--accent)" : "var(--red)", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 10, fontWeight: 900, textTransform: "uppercase", letterSpacing: 1, cursor: "pointer" }}>{et.active ? "Active" : "Disabled"}</button>
                      <IconBtn name="edit" size={24} onClick={() => handleEditClick(et)} />
                      <IconBtn name="del" size={24} variant="danger" onClick={() => handleDelete(et.id)} />
                    </div>
                  </TD>
                </tr>
              ))}
              {expenseTypes.length === 0 && <tr><td colSpan={4} style={{ padding: 40, textAlign: "center", color: "var(--text3)", fontStyle: "italic" }}>No classifications deployed.</td></tr>}
            </tbody>
          </table>
        </Card>
      </div>

      {isEditing && (
        <Modal title="Refine Classification" onClose={() => setIsEditing(false)}>
          <form onSubmit={handleUpdate} style={{ display: "flex", flexDirection: "column", gap: 24, padding: "8px 0" }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Descriptor</label>
              <input value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} style={IS} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Economic Category</label>
              <select value={editForm.category} onChange={e => setEditForm({ ...editForm, category: e.target.value })} style={SS}>
                {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Defined Purpose</label>
              <input value={editForm.desc} onChange={e => setEditForm({ ...editForm, desc: e.target.value })} style={IS} />
            </div>
            <button type="submit" disabled={saving} style={{ padding: "18px", borderRadius: 16, background: "var(--accent)", color: "#000", border: "none", fontWeight: 950, fontSize: 14, textTransform: "uppercase", letterSpacing: 1.2, cursor: "pointer", marginTop: 8, boxShadow: "0 10px 30px -10px rgba(34,211,238,0.5)" }}>
              {saving ? "Committing..." : "Commit Refinement"}
            </button>
          </form>
        </Modal>
      )}

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        select option { background: #1a1b1e; color: #fff; }
      `}</style>
      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}
