"use client";
import { useEffect, useState, useMemo } from "react";
import { collection, onSnapshot, query, where, orderBy, addDoc, deleteDoc, doc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR } from "@/lib/calculations";
import { Icon, IconBtn, Card, TH, TD, Modal, useConfirm, useToast } from "@/components/ui";
import VLoader from "@/components/VLoader";

export default function DailyExpensesPage() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const currentUser = useCurrentUser() || {};
  const canEdit = ["admin", "accountant"].includes(currentUser.role);

  const [branches, setBranches] = useState([]);
  const [expenseTypes, setExpenseTypes] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [branchFilter, setBranchFilter] = useState("");
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setDate(1);
    return d.toISOString().slice(0, 10);
  });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10));

  // Form
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState({ date: new Date().toISOString().slice(0, 10), branch_id: "", expense_type: "", amount: "", note: "" });

  // New expense type inline
  const [showNewType, setShowNewType] = useState(false);
  const [newTypeName, setNewTypeName] = useState("");
  const [newTypeCat, setNewTypeCat] = useState("operations");

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "expense_types"), sn => setExpenseTypes(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  // Fetch daily expenses by date range
  useEffect(() => {
    if (!db || !dateFrom || !dateTo) return;
    setLoading(true);
    const q = query(
      collection(db, "daily_expenses"),
      where("date", ">=", dateFrom),
      where("date", "<=", dateTo),
      orderBy("date", "desc"),
    );
    const unsub = onSnapshot(q,
      sn => { setExpenses(sn.docs.map(d => ({ ...d.data(), id: d.id }))); setLoading(false); },
      () => { setExpenses([]); setLoading(false); }
    );
    return () => unsub();
  }, [dateFrom, dateTo]);

  const branchesById = useMemo(() => new Map(branches.map(b => [b.id, b])), [branches]);
  const activeTypes = expenseTypes.filter(t => t.active !== false).map(t => t.name).sort();

  const filtered = useMemo(() => {
    if (!branchFilter) return expenses;
    return expenses.filter(e => e.branch_id === branchFilter);
  }, [expenses, branchFilter]);

  // Aggregate by type
  const byType = useMemo(() => {
    const map = {};
    filtered.forEach(e => {
      const t = e.expense_type || "Other";
      map[t] = (map[t] || 0) + (Number(e.amount) || 0);
    });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }, [filtered]);

  const totalAmount = filtered.reduce((s, e) => s + (Number(e.amount) || 0), 0);

  const handleSave = async () => {
    if (!form.branch_id || !form.expense_type || !form.amount || !form.date) {
      toast({ title: "Incomplete", message: "Fill all required fields.", type: "warning" });
      return;
    }
    try {
      const payload = {
        date: form.date,
        branch_id: form.branch_id,
        branch_name: branchesById.get(form.branch_id)?.name || "",
        expense_type: form.expense_type,
        amount: Number(form.amount) || 0,
        note: form.note?.trim() || "",
        ...(editId ? { updated_at: new Date().toISOString(), updated_by: currentUser?.name || "user" }
                    : { created_at: new Date().toISOString(), created_by: currentUser?.name || "user" }),
      };
      if (editId) {
        await updateDoc(doc(db, "daily_expenses", editId), payload);
        toast({ title: "Updated", message: "Expense updated.", type: "success" });
      } else {
        await addDoc(collection(db, "daily_expenses"), payload);
        toast({ title: "Saved", message: `${form.expense_type} — ${INR(Number(form.amount))} added.`, type: "success" });
      }
      setForm({ date: form.date, branch_id: form.branch_id, expense_type: "", amount: "", note: "" });
      setEditId(null);
      setShowForm(false);
    } catch (err) {
      toast({ title: "Error", message: err.message, type: "error" });
    }
  };

  const handleDelete = (e) => {
    confirm({
      title: "Delete Expense",
      message: `Delete <strong>${e.expense_type}</strong> — ${INR(e.amount)} on ${e.date}?`,
      confirmText: "Delete", type: "danger",
      onConfirm: async () => {
        await deleteDoc(doc(db, "daily_expenses", e.id));
        toast({ title: "Deleted", message: "Expense removed.", type: "success" });
      },
    });
  };

  const handleEdit = (e) => {
    setForm({ date: e.date, branch_id: e.branch_id, expense_type: e.expense_type, amount: e.amount, note: e.note || "" });
    setEditId(e.id);
    setShowForm(true);
  };

  const addNewType = async () => {
    const name = newTypeName.trim();
    if (!name) return;
    if (expenseTypes.some(t => t.name.toLowerCase() === name.toLowerCase())) {
      toast({ title: "Exists", message: `"${name}" already exists.`, type: "warning" });
      return;
    }
    await addDoc(collection(db, "expense_types"), {
      name, category: newTypeCat, active: true, desc: "",
      created_at: new Date().toISOString(), created_by: currentUser?.name || "user",
    });
    toast({ title: "Type Added", message: `"${name}" is now available.`, type: "success" });
    setNewTypeName("");
    setShowNewType(false);
  };

  if (loading && expenses.length === 0 && branches.length === 0) return <VLoader fullscreen label="Loading Expenses" />;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 2 }}>Operations</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>Daily Expenses</div>
        </div>
        {canEdit && (
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setShowNewType(true)}
              style={{ padding: "10px 16px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--accent)", fontWeight: 800, fontSize: 11, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Icon name="settings" size={12} /> Manage Types
            </button>
            <button onClick={() => { setEditId(null); setForm({ date: new Date().toISOString().slice(0, 10), branch_id: branches[0]?.id || "", expense_type: activeTypes[0] || "", amount: "", note: "" }); setShowForm(true); }}
              style={{ padding: "10px 18px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 11, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Icon name="plus" size={14} /> Add Expense
            </button>
          </div>
        )}
      </div>

      {/* Filters */}
      <Card style={{ marginBottom: 16, padding: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <select value={branchFilter} onChange={e => setBranchFilter(e.target.value)}
            style={{ padding: "8px 12px", border: "1px solid var(--border2)", borderRadius: 10, fontSize: 13, background: "var(--bg3)", color: "var(--text)", minWidth: 160 }}>
            <option value="">All Branches</option>
            {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>From:</span>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border2)", background: "var(--bg3)", color: "var(--text)", fontSize: 12 }} />
            <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>To:</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border2)", background: "var(--bg3)", color: "var(--text)", fontSize: 12 }} />
          </div>
        </div>
      </Card>

      {/* KPI Strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 16 }}>
        <Card style={{ padding: 14 }}>
          <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Total Expenses</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--red)", marginTop: 4 }}>{INR(totalAmount)}</div>
        </Card>
        <Card style={{ padding: 14 }}>
          <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Records</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--accent)", marginTop: 4 }}>{filtered.length}</div>
        </Card>
        <Card style={{ padding: 14 }}>
          <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Expense Types</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--gold)", marginTop: 4 }}>{byType.length}</div>
        </Card>
      </div>

      {/* Type breakdown */}
      {byType.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
          {byType.map(([type, amt]) => (
            <span key={type} style={{ padding: "6px 12px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--border)", fontSize: 11, fontWeight: 700, color: "var(--text2)" }}>
              {type}: <span style={{ color: "var(--red)" }}>{INR(amt)}</span>
            </span>
          ))}
        </div>
      )}

      {/* Expenses Table */}
      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--bg4)" }}>
              <TH>Date</TH><TH>Branch</TH><TH>Expense Type</TH><TH right>Amount</TH><TH>Note</TH><TH>By</TH>
              {canEdit && <TH style={{ width: 80, textAlign: "center" }}>Actions</TH>}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={canEdit ? 7 : 6} style={{ textAlign: "center", padding: 30, color: "var(--text3)", fontSize: 13 }}>No expenses in the selected range.</td></tr>
            )}
            {filtered.map(e => (
              <tr key={e.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <TD>{e.date}</TD>
                <TD>{(e.branch_name || branchesById.get(e.branch_id)?.name || "—").replace("V-CUT ", "")}</TD>
                <TD style={{ fontWeight: 600 }}>{e.expense_type}</TD>
                <TD right style={{ fontWeight: 700, color: "var(--red)" }}>{INR(e.amount)}</TD>
                <TD style={{ color: "var(--text3)", fontSize: 12 }}>{e.note || "—"}</TD>
                <TD style={{ color: "var(--text3)", fontSize: 11 }}>{e.created_by || "—"}</TD>
                {canEdit && (
                  <TD style={{ textAlign: "center" }}>
                    <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
                      <IconBtn name="edit" variant="secondary" onClick={() => handleEdit(e)} title="Edit" />
                      <IconBtn name="del" variant="danger" onClick={() => handleDelete(e)} title="Delete" />
                    </div>
                  </TD>
                )}
              </tr>
            ))}
            {filtered.length > 0 && (
              <tr style={{ background: "var(--bg3)", fontWeight: 700, borderTop: "2px solid var(--border2)" }}>
                <TD>TOTAL</TD><TD></TD><TD></TD>
                <TD right style={{ color: "var(--red)", fontWeight: 800 }}>{INR(totalAmount)}</TD>
                <TD></TD><TD></TD>
                {canEdit && <TD></TD>}
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* Add/Edit Expense Modal */}
      <Modal isOpen={showForm} onClose={() => { setShowForm(false); setEditId(null); }} title={editId ? "Edit Expense" : "Add Daily Expense"} width={480}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Date *</label>
              <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, marginTop: 4 }} />
            </div>
            <div>
              <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Branch *</label>
              <select value={form.branch_id} onChange={e => setForm(f => ({ ...f, branch_id: e.target.value }))}
                style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, marginTop: 4 }}>
                <option value="">Select…</option>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Expense Type *</label>
            <select value={form.expense_type} onChange={e => setForm(f => ({ ...f, expense_type: e.target.value }))}
              style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, marginTop: 4 }}>
              <option value="">Select type…</option>
              {activeTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Amount (₹) *</label>
            <input type="number" min="0" placeholder="0" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
              style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "var(--bg4)", border: "2px solid var(--accent)", color: "var(--accent)", fontSize: 16, fontWeight: 800, marginTop: 4 }} />
          </div>
          <div>
            <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Note</label>
            <input type="text" placeholder="Optional note…" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
              style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, marginTop: 4 }} />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 6 }}>
            <button onClick={() => { setShowForm(false); setEditId(null); }}
              style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text3)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Cancel</button>
            <button onClick={handleSave}
              style={{ padding: "10px 20px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>
              {editId ? "Update" : "Save Expense"}
            </button>
          </div>
        </div>
      </Modal>

      {/* New Expense Type Modal */}
      <Modal isOpen={showNewType} onClose={() => setShowNewType(false)} title="Add Expense Type" width={400}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Type Name *</label>
            <input type="text" placeholder="e.g. AC Repair, Towel Purchase" value={newTypeName} onChange={e => setNewTypeName(e.target.value)} autoFocus
              style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, marginTop: 4 }} />
          </div>
          <div>
            <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Category</label>
            <select value={newTypeCat} onChange={e => setNewTypeCat(e.target.value)}
              style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, marginTop: 4 }}>
              <option value="operations">Operations</option>
              <option value="utilities">Utilities</option>
              <option value="maintenance">Maintenance</option>
              <option value="supplies">Supplies</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div style={{ fontSize: 11, color: "var(--text3)", padding: "8px 12px", borderRadius: 8, background: "var(--bg3)" }}>
            This type will also appear in <strong>Master Setup → Expense Types</strong> for all users.
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button onClick={() => setShowNewType(false)}
              style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text3)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Cancel</button>
            <button onClick={addNewType}
              style={{ padding: "10px 20px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>
              Add Type
            </button>
          </div>
        </div>
      </Modal>

      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}
