"use client";
import { useEffect, useState, useMemo } from "react";
import { collection, onSnapshot, addDoc, deleteDoc, doc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR } from "@/lib/calculations";
import { Icon, Card, TH, TD, Modal, BranchSelect, useConfirm, useToast } from "@/components/ui";
import VLoader from "@/components/VLoader";

// Recurring monthly bills the shop must clear by month-end (salary, rent,
// electricity, etc.). Each doc lives in `payables`, tagged with the month it
// belongs to. Recurring items are cloned into the next month via "Carry
// Forward"; anything still unpaid from an earlier month surfaces as Overdue.
const PRESET_CATEGORIES = [
  "Salary", "Shop Rent", "Room Rent", "Electricity Bill", "Water Bill",
  "WiFi / Internet", "Maintenance", "EMI / Loan", "GST / Tax", "Other",
];

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const shiftMonth = (m, delta) => {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const monthLabel = (m) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
};

export default function PayablesPage() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const currentUser = useCurrentUser() || {};
  const canEdit = ["admin", "accountant"].includes(currentUser.role);

  const [branches, setBranches] = useState([]);
  const [payables, setPayables] = useState([]);
  const [loading, setLoading] = useState(true);

  const [month, setMonth] = useState(thisMonth());

  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState({ category: "", amount: "", branch_id: "", note: "", recurring: true });

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "payables"),
        sn => { setPayables(sn.docs.map(d => ({ ...d.data(), id: d.id }))); setLoading(false); },
        () => setLoading(false)),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  const branchesById = useMemo(() => new Map(branches.map(b => [b.id, b])), [branches]);
  const branchName = (id) => branchesById.get(id)?.name || "";

  // Items for the selected month, unpaid first then by category.
  const monthItems = useMemo(() => {
    return payables
      .filter(p => p.month === month)
      .sort((a, b) => {
        if ((a.status === "paid") !== (b.status === "paid")) return a.status === "paid" ? 1 : -1;
        return (a.category || "").localeCompare(b.category || "");
      });
  }, [payables, month]);

  // Unpaid bills from any earlier month — still owed, shown as Overdue.
  const overdue = useMemo(() => {
    return payables
      .filter(p => p.status !== "paid" && p.month < month)
      .sort((a, b) => (a.month || "").localeCompare(b.month || "") || (a.category || "").localeCompare(b.category || ""));
  }, [payables, month]);

  const totals = useMemo(() => {
    const due = monthItems.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const paid = monthItems.filter(p => p.status === "paid").reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const overdueAmt = overdue.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    return { due, paid, pending: due - paid, overdueAmt };
  }, [monthItems, overdue]);

  const openAdd = () => {
    setEditId(null);
    setForm({ category: "", amount: "", branch_id: "", note: "", recurring: true });
    setShowForm(true);
  };
  const openEdit = (p) => {
    setEditId(p.id);
    setForm({ category: p.category || "", amount: p.amount ?? "", branch_id: p.branch_id || "", note: p.note || "", recurring: p.recurring !== false });
    setShowForm(true);
  };

  const handleSave = async () => {
    const category = form.category.trim();
    if (!category || !form.amount) {
      toast({ title: "Incomplete", message: "Enter a category and amount.", type: "warning" });
      return;
    }
    try {
      const base = {
        month,
        category,
        amount: Number(form.amount) || 0,
        branch_id: form.branch_id || "",
        branch_name: branchName(form.branch_id),
        note: form.note.trim(),
        recurring: !!form.recurring,
      };
      if (editId) {
        await updateDoc(doc(db, "payables", editId), { ...base, updated_at: new Date().toISOString(), updated_by: currentUser?.name || "user" });
        toast({ title: "Updated", message: `${category} updated.`, type: "success" });
      } else {
        await addDoc(collection(db, "payables"), { ...base, status: "unpaid", paid_at: null, paid_by: "", created_at: new Date().toISOString(), created_by: currentUser?.name || "user" });
        toast({ title: "Added", message: `${category} — ${INR(base.amount)} added to ${monthLabel(month)}.`, type: "success" });
      }
      setShowForm(false);
      setEditId(null);
    } catch (err) {
      toast({ title: "Error", message: err.message, type: "error" });
    }
  };

  const togglePaid = async (p) => {
    const next = p.status === "paid" ? "unpaid" : "paid";
    try {
      await updateDoc(doc(db, "payables", p.id), {
        status: next,
        paid_at: next === "paid" ? new Date().toISOString() : null,
        paid_by: next === "paid" ? (currentUser?.name || "user") : "",
      });
    } catch (err) {
      toast({ title: "Error", message: err.message, type: "error" });
    }
  };

  const handleDelete = (p) => {
    confirm({
      title: "Delete Payable",
      message: `Remove <strong>${p.category}</strong> — ${INR(p.amount)} from ${monthLabel(p.month)}?`,
      confirmText: "Delete", type: "danger",
      onConfirm: async () => {
        await deleteDoc(doc(db, "payables", p.id));
        toast({ title: "Deleted", message: "Payable removed.", type: "success" });
      },
    });
  };

  // Clone the previous month's recurring bills into this month as unpaid,
  // skipping any category+branch pair already present so a repeat click is safe.
  const [carrying, setCarrying] = useState(false);
  const carryForward = async () => {
    const prev = shiftMonth(month, -1);
    const source = payables.filter(p => p.month === prev && p.recurring !== false);
    if (source.length === 0) {
      toast({ title: "Nothing to carry", message: `No recurring bills found in ${monthLabel(prev)}.`, type: "warning" });
      return;
    }
    const existing = new Set(monthItems.map(p => `${(p.category || "").toLowerCase()}|${p.branch_id || ""}`));
    const toAdd = source.filter(p => !existing.has(`${(p.category || "").toLowerCase()}|${p.branch_id || ""}`));
    if (toAdd.length === 0) {
      toast({ title: "Already carried", message: `${monthLabel(month)} already has every recurring bill from ${monthLabel(prev)}.`, type: "info" });
      return;
    }
    setCarrying(true);
    try {
      const stamp = new Date().toISOString();
      const by = currentUser?.name || "user";
      await Promise.all(toAdd.map(p => addDoc(collection(db, "payables"), {
        month,
        category: p.category,
        amount: Number(p.amount) || 0,
        branch_id: p.branch_id || "",
        branch_name: p.branch_name || "",
        note: p.note || "",
        recurring: true,
        status: "unpaid",
        paid_at: null,
        paid_by: "",
        carried_from: prev,
        created_at: stamp,
        created_by: by,
      })));
      toast({ title: "Carried Forward", message: `${toAdd.length} bill(s) copied from ${monthLabel(prev)}.`, type: "success" });
    } catch (err) {
      toast({ title: "Error", message: err.message, type: "error" });
    } finally {
      setCarrying(false);
    }
  };

  if (loading && payables.length === 0 && branches.length === 0) return <VLoader fullscreen label="Loading Payables" />;

  const statCard = (label, value, color) => (
    <Card style={{ padding: 16, flex: 1, minWidth: 150 }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color, marginTop: 6 }}>{INR(value)}</div>
    </Card>
  );

  const StatusBadge = ({ paid }) => (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 20, fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5,
      background: paid ? "rgba(74,222,128,0.14)" : "rgba(248,113,113,0.14)",
      color: paid ? "var(--green)" : "var(--red)",
      border: `1px solid ${paid ? "rgba(74,222,128,0.4)" : "rgba(248,113,113,0.4)"}`,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: paid ? "var(--green)" : "var(--red)" }} />
      {paid ? "Paid" : "Unpaid"}
    </span>
  );

  const renderRow = (p, { showMonth = false } = {}) => {
    const paid = p.status === "paid";
    return (
      <tr key={p.id} style={{ borderBottom: "1px solid var(--border)", background: paid ? "rgba(74,222,128,0.04)" : "transparent" }}>
        <TD style={{ fontWeight: 700, color: "var(--text)" }}>
          {p.category}
          {p.recurring !== false && <span title="Recurring monthly bill" style={{ marginLeft: 8, padding: "1px 6px", borderRadius: 4, background: "var(--bg4)", color: "var(--text3)", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Monthly</span>}
          {p.carried_from && <span title={`Carried from ${monthLabel(p.carried_from)}`} style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 4, background: "rgba(34,211,238,0.12)", color: "var(--accent)", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Carried</span>}
        </TD>
        {showMonth && <TD style={{ color: "var(--text3)", fontSize: 11, fontWeight: 700 }}>{monthLabel(p.month)}</TD>}
        <TD style={{ color: "var(--text2)" }}>{p.branch_name || branchName(p.branch_id) || "—"}</TD>
        <TD style={{ color: "var(--text3)", fontSize: 12 }}>{p.note || "—"}</TD>
        <TD right style={{ fontWeight: 800, color: "var(--gold)" }}>{INR(p.amount)}</TD>
        <TD style={{ textAlign: "center" }}><StatusBadge paid={paid} /></TD>
        <TD style={{ textAlign: "center", color: "var(--text3)", fontSize: 11 }}>
          {paid && p.paid_at ? new Date(p.paid_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "—"}
        </TD>
        {canEdit && (
          <TD style={{ textAlign: "center" }}>
            <div style={{ display: "inline-flex", gap: 6 }}>
              <button onClick={() => togglePaid(p)} title={paid ? "Mark as unpaid" : "Mark as paid"}
                style={{ padding: "6px 12px", borderRadius: 7, cursor: "pointer", fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, border: "1px solid",
                  background: paid ? "var(--bg4)" : "rgba(74,222,128,0.14)",
                  borderColor: paid ? "var(--border2)" : "rgba(74,222,128,0.4)",
                  color: paid ? "var(--text3)" : "var(--green)" }}>
                {paid ? "Undo" : "✓ Mark Paid"}
              </button>
              <button onClick={() => openEdit(p)} title="Edit"
                style={{ width: 30, height: 30, borderRadius: 7, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text2)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                <Icon name="edit" size={13} />
              </button>
              <button onClick={() => handleDelete(p)} title="Delete"
                style={{ width: 30, height: 30, borderRadius: 7, background: "var(--red-bg)", border: "1px solid rgba(248,113,113,0.3)", color: "var(--red)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                <Icon name="del" size={13} />
              </button>
            </div>
          </TD>
        )}
      </tr>
    );
  };

  const colCount = canEdit ? 7 : 6;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 2 }}>Operations</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>Payments To Be Paid</div>
        </div>
        {canEdit && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={carryForward} disabled={carrying}
              title={`Copy recurring bills from ${monthLabel(shiftMonth(month, -1))} into ${monthLabel(month)}`}
              style={{ padding: "10px 16px", borderRadius: 10, background: "var(--bg3)", border: "1px solid rgba(34,211,238,0.4)", color: "var(--accent)", fontWeight: 800, fontSize: 11, cursor: carrying ? "wait" : "pointer", textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6, opacity: carrying ? 0.6 : 1 }}>
              <Icon name="calendar" size={13} /> {carrying ? "Carrying…" : "Carry Forward"}
            </button>
            <button onClick={openAdd}
              style={{ padding: "10px 18px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 11, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Icon name="plus" size={14} /> Add Payable
            </button>
          </div>
        )}
      </div>

      {/* Month navigator */}
      <Card style={{ marginBottom: 16, padding: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14 }}>
          <button onClick={() => setMonth(m => shiftMonth(m, -1))} title="Previous month"
            style={{ width: 36, height: 36, borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="back" size={16} />
          </button>
          <div style={{ minWidth: 200, textAlign: "center" }}>
            <div style={{ fontSize: 18, fontWeight: 800, color: "var(--text)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{monthLabel(month)}</div>
            <input type="month" value={month} onChange={e => e.target.value && setMonth(e.target.value)}
              style={{ marginTop: 4, padding: "4px 8px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text3)", fontSize: 11 }} />
          </div>
          <button onClick={() => setMonth(m => shiftMonth(m, 1))} title="Next month"
            style={{ width: 36, height: 36, borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", transform: "rotate(180deg)" }}>
            <Icon name="back" size={16} />
          </button>
        </div>
      </Card>

      {/* Summary */}
      <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        {statCard("Total Due", totals.due, "var(--gold)")}
        {statCard("Paid", totals.paid, "var(--green)")}
        {statCard("Pending", totals.pending, totals.pending > 0 ? "var(--red)" : "var(--green)")}
        {overdue.length > 0 && statCard(`Overdue (${overdue.length})`, totals.overdueAmt, "var(--red)")}
      </div>

      {/* Overdue from earlier months */}
      {overdue.length > 0 && (
        <Card style={{ marginBottom: 16, padding: 0, border: "1px solid rgba(248,113,113,0.35)", overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", background: "rgba(248,113,113,0.08)", display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="alert" size={15} color="var(--red)" />
            <div style={{ fontSize: 13, fontWeight: 800, color: "var(--red)" }}>Overdue — unpaid from earlier months</div>
            <div style={{ marginLeft: "auto", fontSize: 12, fontWeight: 800, color: "var(--red)" }}>{INR(totals.overdueAmt)}</div>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "var(--bg3)" }}>
                  <TH>Category</TH><TH>Month</TH><TH>Branch</TH><TH>Note</TH><TH right>Amount</TH><TH style={{ textAlign: "center" }}>Status</TH><TH style={{ textAlign: "center" }}>Paid On</TH>{canEdit && <TH style={{ textAlign: "center" }}>Actions</TH>}
                </tr>
              </thead>
              <tbody>{overdue.map(p => renderRow(p, { showMonth: true }))}</tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Current month list */}
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "var(--bg3)" }}>
                <TH>Category</TH><TH>Branch</TH><TH>Note</TH><TH right>Amount</TH><TH style={{ textAlign: "center" }}>Status</TH><TH style={{ textAlign: "center" }}>Paid On</TH>{canEdit && <TH style={{ textAlign: "center" }}>Actions</TH>}
              </tr>
            </thead>
            <tbody>
              {monthItems.length === 0 ? (
                <tr><TD colSpan={colCount} style={{ textAlign: "center", padding: 40, color: "var(--text3)" }}>
                  No payables for {monthLabel(month)}.{canEdit && " Use Carry Forward to pull recurring bills, or Add Payable."}
                </TD></tr>
              ) : monthItems.map(p => renderRow(p))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Add / Edit modal */}
      <Modal isOpen={showForm} onClose={() => setShowForm(false)} title={editId ? "Edit Payable" : `Add Payable · ${monthLabel(month)}`} width={460}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 800, textTransform: "uppercase", letterSpacing: 1 }}>Category *</label>
            <input type="text" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} placeholder="e.g. Rent, Salary, Electricity Bill"
              style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, marginTop: 5, boxSizing: "border-box" }} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {PRESET_CATEGORIES.map(c => (
                <button key={c} type="button" onClick={() => setForm(f => ({ ...f, category: c }))}
                  style={{ padding: "5px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700, cursor: "pointer", border: "1px solid", whiteSpace: "nowrap",
                    background: form.category === c ? "rgba(34,211,238,0.14)" : "var(--bg4)",
                    borderColor: form.category === c ? "rgba(34,211,238,0.4)" : "var(--border2)",
                    color: form.category === c ? "var(--accent)" : "var(--text3)" }}>
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 800, textTransform: "uppercase", letterSpacing: 1 }}>Amount (₹) *</label>
            <input type="number" min="0" step="1" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="0"
              style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, marginTop: 5, boxSizing: "border-box", fontWeight: 700 }} />
          </div>
          <div>
            <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 800, textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 5 }}>Branch (optional)</label>
            <BranchSelect value={form.branch_id} onChange={v => setForm(f => ({ ...f, branch_id: v }))} branches={branches} placeholder="No specific branch" />
          </div>
          <div>
            <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 800, textTransform: "uppercase", letterSpacing: 1 }}>Note (optional)</label>
            <input type="text" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder="Reference, due date, payee…"
              style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, marginTop: 5, boxSizing: "border-box" }} />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", padding: "10px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)" }}>
            <input type="checkbox" checked={form.recurring} onChange={e => setForm(f => ({ ...f, recurring: e.target.checked }))} style={{ width: 16, height: 16, accentColor: "var(--accent)" }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text2)" }}>Recurring — carries to next month on Carry Forward</span>
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 4 }}>
            <button onClick={() => setShowForm(false)}
              style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text3)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Cancel</button>
            <button onClick={handleSave}
              style={{ padding: "10px 22px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>
              {editId ? "Save Changes" : "Add Payable"}
            </button>
          </div>
        </div>
      </Modal>

      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}
