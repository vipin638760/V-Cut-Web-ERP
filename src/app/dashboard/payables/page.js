"use client";
import { useEffect, useState, useMemo } from "react";
import { collection, onSnapshot, addDoc, deleteDoc, doc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR } from "@/lib/calculations";
import { Icon, Card, TH, TD, Modal, BranchSelect, ToggleGroup, useConfirm, useToast } from "@/components/ui";
import VLoader from "@/components/VLoader";

// Recurring monthly bills the shop must clear by month-end (salary, rent,
// electricity, etc.). Each doc lives in `payables`, tagged with the month it
// belongs to. Recurring items are cloned into the next month via "Carry
// Forward"; anything still unpaid from an earlier month surfaces as Overdue.
const PRESET_CATEGORIES = [
  "Salary", "Shop Rent", "Room Rent", "Electricity Bill", "Water Bill",
  "WiFi / Internet", "Maintenance", "EMI / Loan", "GST / Tax", "Other",
];

// Recurring fixed bills auto-pulled from each branch's month record
// (fixed_expenses, else the branch master default). type = fixed_expenses.type,
// field = branch master fallback field.
const FIXED_BILLS = [
  { type: "Shop Rent", field: "shop_rent" },
  { type: "Room Rent", field: "room_rent" },
  { type: "Electricity Shop", field: "shop_elec" },
  { type: "Electricity Room", field: "room_elec" },
  { type: "Water Bill", field: "water" },
  { type: "WiFi Bill", field: "wifi" },
  { type: "Shop Maintenance", field: "shop_maint" },
  { type: "Room Maintenance", field: "room_maint" },
];

// Receipt title + payee wording per bill category (falls back to a generic
// payment receipt). Keyed by lowercased category substring.
const receiptKind = (category = "") => {
  const c = category.toLowerCase();
  if (c.includes("rent")) return { title: "Rent Receipt", line: "Received with thanks the rent amount of" };
  if (c.includes("electric")) return { title: "Electricity Bill Payment", line: "Paid towards electricity charges the amount of" };
  if (c.includes("water")) return { title: "Water Bill Payment", line: "Paid towards water charges the amount of" };
  if (c.includes("wifi") || c.includes("internet")) return { title: "Internet Bill Payment", line: "Paid towards internet / WiFi charges the amount of" };
  if (c.includes("maint")) return { title: "Maintenance Payment", line: "Paid towards maintenance the amount of" };
  return { title: "Payment Receipt", line: "Paid towards the above the amount of" };
};

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
  const [fixedExpenses, setFixedExpenses] = useState([]);
  const [expenseTypes, setExpenseTypes] = useState([]);
  const [loading, setLoading] = useState(true);

  const [month, setMonth] = useState(thisMonth());
  const [statusFilter, setStatusFilter] = useState("all"); // all | paid | unpaid

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
      onSnapshot(collection(db, "fixed_expenses"), sn => setFixedExpenses(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "expense_types"), sn => setExpenseTypes(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  const branchesById = useMemo(() => new Map(branches.map(b => [b.id, b])), [branches]);
  const branchName = (id) => branchesById.get(id)?.name || "";

  // Items for the selected month, unpaid first then by category. The Paid /
  // To-Pay filter narrows the visible rows (KPIs stay on the full month).
  const monthItemsAll = useMemo(() => {
    return payables
      .filter(p => p.month === month)
      .sort((a, b) => {
        if ((a.status === "paid") !== (b.status === "paid")) return a.status === "paid" ? 1 : -1;
        return (a.category || "").localeCompare(b.category || "");
      });
  }, [payables, month]);
  const monthItems = useMemo(() => {
    if (statusFilter === "all") return monthItemsAll;
    return monthItemsAll.filter(p => (statusFilter === "paid") === (p.status === "paid"));
  }, [monthItemsAll, statusFilter]);
  const paidN = monthItemsAll.filter(p => p.status === "paid").length;
  const unpaidN = monthItemsAll.length - paidN;

  // Unpaid bills from any earlier month — still owed, shown as Overdue.
  const overdue = useMemo(() => {
    return payables
      .filter(p => p.status !== "paid" && p.month < month)
      .sort((a, b) => (a.month || "").localeCompare(b.month || "") || (a.category || "").localeCompare(b.category || ""));
  }, [payables, month]);

  const totals = useMemo(() => {
    const due = monthItemsAll.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const paid = monthItemsAll.filter(p => p.status === "paid").reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const overdueAmt = overdue.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    return { due, paid, pending: due - paid, overdueAmt };
  }, [monthItemsAll, overdue]);

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

  // Pull each branch's fixed monthly bills (rent, electricity, water, wifi,
  // maintenance) into this month as unpaid payables. Amount = this month's
  // fixed_expenses record if present, else the branch master default. Skips any
  // (category + branch) pair already in the month so repeat clicks are safe.
  const [pulling, setPulling] = useState(false);
  const pullFixedBills = async () => {
    const existing = new Set(monthItemsAll.map(p => `${(p.category || "").toLowerCase()}|${p.branch_id || ""}`));
    const monthFixed = fixedExpenses.filter(e => (e.date || "").startsWith(month));
    // Full fixed-column set the Operations "Fixed" tab renders: 8 core bills
    // (with a branch-master fallback field) + any active custom expense_types
    // tagged category "fixed" (no master fallback — value comes from fixed_expenses).
    const cols = [
      ...FIXED_BILLS,
      ...expenseTypes
        .filter(t => t.active !== false && t.category === "fixed" && !FIXED_BILLS.some(fb => fb.type === t.name))
        .map(t => ({ type: t.name, field: null })),
    ];
    const toAdd = [];
    branches.forEach(b => {
      cols.forEach(({ type, field }) => {
        const rec = monthFixed.find(e => e.branch_id === b.id && e.type === type);
        const amount = rec ? Number(rec.amount) || 0 : (field ? Number(b[field]) || 0 : 0);
        if (amount <= 0) return;
        if (existing.has(`${type.toLowerCase()}|${b.id}`)) return;
        toAdd.push({ type, amount, branch: b });
      });
    });
    if (toAdd.length === 0) {
      toast({ title: "Nothing to pull", message: `Every branch's fixed bill for ${monthLabel(month)} is already listed (or set to ₹0).`, type: "info" });
      return;
    }
    setPulling(true);
    try {
      const stamp = new Date().toISOString();
      const by = currentUser?.name || "user";
      await Promise.all(toAdd.map(({ type, amount, branch }) => addDoc(collection(db, "payables"), {
        month, category: type, amount,
        branch_id: branch.id, branch_name: branch.name || "",
        note: "", recurring: true, source: "fixed",
        status: "unpaid", paid_at: null, paid_by: "",
        created_at: stamp, created_by: by,
      })));
      toast({ title: "Fixed Bills Pulled", message: `${toAdd.length} bill(s) added for ${monthLabel(month)}.`, type: "success" });
    } catch (err) {
      toast({ title: "Error", message: err.message, type: "error" });
    } finally {
      setPulling(false);
    }
  };

  // Printable receipt / paid note for a cleared bill — rent receipt, electricity
  // paid note, etc. Mirrors the payslip look; title adapts to the category.
  const generateReceipt = (p) => {
    const kind = receiptKind(p.category);
    const w = window.open("", "_blank", "width=800,height=900");
    if (!w) { toast({ title: "Popup blocked", message: "Allow popups to print the receipt.", type: "warning" }); return; }
    const paidOn = p.paid_at ? new Date(p.paid_at).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" }) : "—";
    const rno = `RC-${(p.id || "").slice(-6).toUpperCase()}`;
    const amt = `&#8377;${(Number(p.amount) || 0).toLocaleString("en-IN")}`;
    const brName = (p.branch_name || branchName(p.branch_id) || "—");
    const html = `<!DOCTYPE html><html><head><title>${kind.title} - ${p.category} - ${monthLabel(p.month)}</title>
<link href="https://fonts.googleapis.com/css2?family=Great+Vibes&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}@page{size:A4;margin:16mm}body{font-family:'Segoe UI',system-ui,sans-serif;background:#fff;color:#1a1a1a;padding:36px;max-width:800px;margin:0 auto;font-size:13px}.watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-20deg);font-size:100px;font-weight:900;color:rgba(0,0,0,.02);pointer-events:none;white-space:nowrap;font-style:italic;letter-spacing:10px}.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px;padding-bottom:20px;border-bottom:2px solid #065f46}.brand{display:flex;align-items:baseline;gap:0}.brand-v{color:#f06464;font-size:48px;font-weight:400;font-family:'Great Vibes',cursive}.brand-cut{color:#1a1a1a;font-size:38px;font-weight:400;font-family:'Great Vibes',cursive}.brand-salon{font-size:13px;font-weight:800;letter-spacing:5px;background:linear-gradient(90deg,#b8860b,#daa520);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-left:8px}.doc-title{text-align:right}.doc-title h2{font-size:20px;font-weight:700;letter-spacing:1px;text-transform:uppercase}.doc-title p{font-size:11px;color:#888;margin-top:3px}.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:28px}.info-box{background:#f7f9fa;padding:16px 18px;border-radius:8px}.info-box h4{font-size:8px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px}.info-row{display:flex;justify-content:space-between;padding:4px 0;font-size:12px}.info-row .label{color:#777}.info-row .value{font-weight:700}.paid-line{font-size:14px;color:#333;margin:6px 0 22px;line-height:1.7}.net-box{background:linear-gradient(135deg,#064e3b,#065f46);color:#fff;padding:22px 28px;border-radius:10px;display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}.net-box .lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#a7f3d0}.net-box .sub{font-size:11px;color:#6ee7b7;margin-top:3px}.net-box .amt{font-size:28px;font-weight:800;color:#ecfdf5;font-family:'Courier New',monospace}.pay-badge{display:inline-flex;align-items:center;gap:6px;background:#f0fdf4;border:1px solid #bbf7d0;color:#16a34a;padding:4px 10px;border-radius:6px;font-size:10px;font-weight:700;text-transform:uppercase}.sig-grid{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:40px;align-items:end}.sig-box{display:flex;flex-direction:column;align-items:center;justify-content:flex-end}.sig-line{text-align:center;border-top:1px solid #ccc;padding-top:8px;font-size:10px;color:#999;width:100%}.footer{text-align:center;padding-top:24px;border-top:1px solid #eee;color:#bbb;font-size:9px;letter-spacing:1px;margin-top:24px}@media print{body{padding:0}.no-print{display:none!important}}</style></head><body>
<div class="watermark">V-Cut Salon</div>
<div class="header"><div><div class="brand"><span class="brand-v">V</span><span class="brand-cut">-Cut</span><span class="brand-salon">SALON</span></div><p style="font-size:10px;color:#aaa;margin-top:3px;letter-spacing:1px">Salon Management System</p></div><div class="doc-title"><h2>${kind.title}</h2><p>Receipt No: ${rno}</p><p>Date: ${paidOn}</p></div></div>
<div class="info-grid"><div class="info-box"><h4>Bill Details</h4><div class="info-row"><span class="label">Category</span><span class="value">${p.category}</span></div><div class="info-row"><span class="label">Branch</span><span class="value">${brName}</span></div><div class="info-row"><span class="label">Billing Month</span><span class="value">${monthLabel(p.month)}</span></div>${p.note ? `<div class="info-row"><span class="label">Note</span><span class="value">${p.note}</span></div>` : ""}</div><div class="info-box"><h4>Payment</h4><div class="info-row"><span class="label">Status</span><span class="value"><span class="pay-badge">${p.status === "paid" ? "Paid" : "Pending"}</span></span></div><div class="info-row"><span class="label">Paid On</span><span class="value">${paidOn}</span></div><div class="info-row"><span class="label">Paid By</span><span class="value">${p.paid_by || "—"}</span></div></div></div>
<p class="paid-line">${kind.line} <strong>${amt}</strong> for <strong>${p.category}</strong>${brName !== "—" ? ` (${brName})` : ""} towards ${monthLabel(p.month)}.</p>
<div class="net-box"><div><div class="lbl">Amount ${p.status === "paid" ? "Paid" : "Payable"}</div><div class="sub">${kind.title}</div></div><div class="amt">${amt}</div></div>
<div class="sig-grid"><div class="sig-box"><div style="height:60px"></div><div class="sig-line">Received By</div></div><div class="sig-box"><div style="height:60px"></div><div class="sig-line">Authorised Signatory &mdash; V-Cut Salon</div></div></div>
<div class="footer"><p>System-generated ${kind.title.toLowerCase()} &mdash; V-Cut Salon</p></div>
<div class="no-print" style="text-align:center;margin-top:20px"><button onclick="window.print()" style="padding:12px 32px;background:#065f46;color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px">Print / Save as PDF</button></div>
</body></html>`;
    w.document.write(html);
    w.document.close();
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
              <button onClick={() => generateReceipt(p)} title={paid ? "Print receipt / paid note" : "Print bill"}
                style={{ padding: "6px 10px", borderRadius: 7, background: "var(--bg4)", border: "1px solid rgba(251,191,36,0.4)", color: "var(--gold)", cursor: "pointer", fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 4 }}>
                <Icon name="log" size={12} /> {paid ? "Receipt" : "Bill"}
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
            <button onClick={pullFixedBills} disabled={pulling}
              title={`Pull each branch's rent, electricity, water, WiFi & maintenance into ${monthLabel(month)}`}
              style={{ padding: "10px 16px", borderRadius: 10, background: "var(--bg3)", border: "1px solid rgba(251,191,36,0.45)", color: "var(--gold)", fontWeight: 800, fontSize: 11, cursor: pulling ? "wait" : "pointer", textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6, opacity: pulling ? 0.6 : 1 }}>
              <Icon name="grid" size={13} /> {pulling ? "Pulling…" : "Pull Fixed Bills"}
            </button>
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

      {/* Paid / To-Pay filter */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <ToggleGroup
          options={[["all", `All${monthItemsAll.length ? ` · ${monthItemsAll.length}` : ""}`], ["unpaid", `To Pay${unpaidN ? ` · ${unpaidN}` : ""}`], ["paid", `Paid${paidN ? ` · ${paidN}` : ""}`]]}
          value={statusFilter} onChange={setStatusFilter}
          colors={{ unpaid: "linear-gradient(135deg,#f97316,#fb923c)", paid: "linear-gradient(135deg,#22a354,#4ade80)" }} />
      </div>

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
                  {statusFilter !== "all" && monthItemsAll.length > 0
                    ? `No ${statusFilter === "paid" ? "paid" : "to-pay"} items for ${monthLabel(month)}.`
                    : <>No payables for {monthLabel(month)}.{canEdit && " Use Pull Fixed Bills for rent/electricity, Carry Forward for recurring bills, or Add Payable."}</>}
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
