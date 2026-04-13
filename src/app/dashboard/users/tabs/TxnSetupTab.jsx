"use client";
import { useEffect, useState } from "react";
import { collection, onSnapshot, doc, deleteDoc, addDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { INR } from "@/lib/calculations";
import { Card, Pill, TH, TD, IconBtn, PeriodWidget, StatCard, Icon, useConfirm, useToast } from "@/components/ui";

const NOW = new Date();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DEFAULT_EXP_TYPES = ["Rent", "Electricity", "WiFi", "Water", "Salaries", "Incentives", "Petrol", "Maid", "Dustbin"];

export default function TxnSetupTab() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [transactions, setTransactions] = useState([]);
  const [branches, setBranches] = useState([]);
  const [expenseTypes, setExpenseTypes] = useState([]);
  const [loading, setLoading] = useState(true);

  const [filterMode, setFilterMode] = useState("month");
  const [filterYear, setFilterYear] = useState(NOW.getFullYear());
  const [filterMonth, setFilterMonth] = useState(NOW.getMonth() + 1);
  const selectedPeriod = `${filterYear}-${String(filterMonth).padStart(2, "0")}`;

  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    branch_id: "all", cat: "expense", type: DEFAULT_EXP_TYPES[0], amount: "", date: NOW.toISOString().slice(0, 10), desc: ""
  });

  useEffect(() => {
    if (!db) return;
    const unsubB = onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id }))));
    const unsubE = onSnapshot(collection(db, "expense_types"), sn => setExpenseTypes(sn.docs.map(d => ({ ...d.data(), id: d.id }))));
    const unsubT = onSnapshot(collection(db, "transactions"), sn => {
      setTransactions(sn.docs.map(d => ({ ...d.data(), id: d.id })));
      setLoading(false);
    });
    return () => { unsubB(); unsubE(); unsubT(); };
  }, []);

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.type || !form.amount) { confirm({ title: "Validation", message: "Category and amount required for logging.", confirmText: "OK", type: "warning", onConfirm: () => {} }); return; }
    setSaving(true);
    try {
      await addDoc(collection(db, "transactions"), {
        ...form,
        amount: Number(form.amount) || 0,
        month: selectedPeriod,
        recorded_at: NOW.toISOString()
      });
      setForm(prev => ({ ...prev, amount: "", desc: "" }));
      toast({ title: "Saved", message: "Transaction recorded successfully.", type: "success" });
    } catch (e) { confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
    setSaving(false);
  };

  const handleDelete = async (id) => {
    confirm({
      title: "Delete Transaction",
      message: "Are you sure you want to permanently remove this <strong>transaction record</strong>?",
      confirmText: "Yes, Delete",
      cancelText: "Cancel",
      type: "danger",
      onConfirm: async () => {
        try { await deleteDoc(doc(db, "transactions", id)); toast({ title: "Deleted", message: "Transaction has been removed.", type: "success" }); } catch (e) { confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
      }
    });
  };

  if (loading) return <div style={{ padding: 60, textAlign: "center", color: "var(--accent)", fontWeight: 800 }}>Synchronizing transactional data...</div>;

  const inputStyle = { width: "100%", padding: "14px 18px", border: "1px solid var(--border2)", borderRadius: 14, background: "rgba(255,255,255,0.02)", color: "var(--text)", outline: "none", fontSize: 13, transition: "all 0.2s" };

  const allTypes = [...DEFAULT_EXP_TYPES, ...expenseTypes.filter(et => et.active !== false).map(et => et.name)];
  const monTxns = transactions.filter(t => t.month === selectedPeriod).sort((a, b) => b.date.localeCompare(a.date));

  const totalInc = monTxns.filter(t => t.cat === "income").reduce((s, t) => s + (t.amount || 0), 0);
  const totalExp = monTxns.filter(t => t.cat === "expense").reduce((s, t) => s + (t.amount || 0), 0);
  const net = totalInc - totalExp;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32, animation: "fadeIn 0.5s ease-out" }}>
      
      <Card style={{ padding: "16px 24px", background: "var(--bg2)", borderRadius: 24, border: "1px solid var(--border)" }}>
         <PeriodWidget filterMode={filterMode} setFilterMode={setFilterMode} filterYear={filterYear} setFilterYear={setFilterYear} filterMonth={filterMonth} setFilterMonth={setFilterMonth} monthlyOnly />
      </Card>

      {/* Impact Indicators */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 24 }}>
        <StatCard label="Variable Gross Yield" value={INR(totalInc)} icon={<Icon name="trending" size={20} />} color="green" />
        <StatCard label="Operational Outflow" value={INR(totalExp)} icon={<Icon name="wallet" size={20} />} color="red" />
        <StatCard 
          label="Net Period Impact" 
          value={INR(net)} 
          subtext={net >= 0 ? "Surplus realized" : "Deficit observed"}
          icon={<Icon name="pie" size={20} />} 
          color={net >= 0 ? "accent" : "orange"} 
        />
      </div>

      {/* Transaction Control Center */}
      <Card style={{ padding: 32, borderRadius: 28 }}>
        <div style={{ fontSize: 13, fontWeight: 950, color: "var(--gold)", textTransform: "uppercase", letterSpacing: 2, marginBottom: 32, display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 32, height: 32, background: "rgba(255,215,0,0.1)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="plus" size={16} color="var(--gold)" />
          </div>
          Initialize Variable Entry — {MONTHS[filterMonth - 1]} {filterYear}
        </div>
        
        <form onSubmit={handleSave} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 28 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5 }}>Asset Target</label>
            <select value={form.branch_id} onChange={e => setForm({ ...form, branch_id: e.target.value })} style={{ ...inputStyle, appearance: "none" }}>
              <option value="all">Global Network (Shared)</option>
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5 }}>Flow Direction</label>
            <select value={form.cat} onChange={e => setForm({ ...form, cat: e.target.value })} style={{ ...inputStyle, appearance: "none" }}>
              <option value="expense">Operational Expense (-)</option>
              <option value="income">External Revenue (+)</option>
            </select>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5 }}>Classification</label>
            <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} style={{ ...inputStyle, appearance: "none" }}>
              {allTypes.map((t, i) => <option key={i} value={t}>{t}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5 }}>Net Worth (₹)</label>
            <input type="number" placeholder="0.00" min="0" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} style={{ ...inputStyle, borderColor: "var(--gold)", background: "rgba(255,215,0,0.02)" }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5 }}>Timestamp</label>
            <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} style={inputStyle} />
          </div>
          <div style={{ gridColumn: "span 2", display: "flex", flexDirection: "column", gap: 10 }}>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5 }}>Protocol Narration</label>
            <input placeholder="Enter reference numbers or vendor identity..." value={form.desc} onChange={e => setForm({ ...form, desc: e.target.value })} style={inputStyle} />
          </div>

          <div style={{ gridColumn: "1 / -1", marginTop: 12 }}>
            <button type="submit" disabled={saving} style={{ 
              padding: "18px 36px", 
              borderRadius: 16, 
              background: "linear-gradient(135deg, var(--accent), var(--gold2))", 
              color: "#000", 
              border: "none", 
              fontWeight: 950, 
              cursor: "pointer", 
              textTransform: "uppercase", 
              letterSpacing: 1.5,
              fontSize: 12,
              boxShadow: "0 15px 35px -12px rgba(34,211,238,0.5)",
              transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)"
            }}>
              {saving ? "Executing Log..." : "Commence Logging"}
            </button>
          </div>
        </form>
      </Card>

      {/* Historical Ledger */}
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "24px 32px", borderBottom: "1px solid var(--border2)", display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(255,255,255,0.01)" }}>
          <div style={{ fontSize: 12, fontWeight: 950, color: "var(--text)", textTransform: "uppercase", letterSpacing: 2 }}>
            Transactional Ledger — {selectedPeriod}
          </div>
          <Pill label={`${monTxns.length} Verified Entries`} color="gold" />
        </div>
        
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
            <thead>
              <tr>
                <TH>Assigned Asset</TH>
                <TH>Flow Type</TH>
                <TH>Category</TH>
                <TH>Effective Date</TH>
                <TH right>Quantum Impact</TH>
                <TH>Narration Details</TH>
                <TH right>Operations</TH>
              </tr>
            </thead>
            <tbody>
              {monTxns.map(t => {
                const b = branches.find(x => x.id === t.branch_id);
                const isInc = t.cat === "income";
                return (
                  <tr key={t.id} onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.01)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <TD style={{ fontWeight: 800, color: "var(--text)" }}>{t.branch_id === "all" ? <Pill label="Global Network" color="gold" /> : b ? b.name : "Unmapped"}</TD>
                    <TD><Pill label={t.cat.toUpperCase()} color={isInc ? "green" : "red"} /></TD>
                    <TD style={{ fontSize: 13, fontWeight: 700, color: "var(--accent)" }}>{t.type}</TD>
                    <TD style={{ color: "var(--text3)", fontSize: 13, fontWeight: 600 }}>{t.date}</TD>
                    <TD right style={{ fontWeight: 950, color: isInc ? "var(--green)" : "var(--red)", fontSize: 14 }}>
                      {isInc ? "+" : "-"}{INR(t.amount)}
                    </TD>
                    <TD style={{ fontSize: 12, color: "var(--text3)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>
                      {t.desc || t.note || "No Reference Data"}
                    </TD>
                    <TD right>
                      <IconBtn name="del" variant="danger" size={28} onClick={() => handleDelete(t.id)} />
                    </TD>
                  </tr>
                );
              })}
              {monTxns.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: 80, textAlign: "center", fontStyle: "italic", color: "var(--text3)" }}>
                    <div style={{ opacity: 0.1, marginBottom: 20 }}>
                       <Icon name="info" size={48} />
                    </div>
                    No transactional telemetry available for this period.
                  </td>
                </tr>
              )}
            </tbody>
            {monTxns.length > 0 && (
              <tfoot>
                <tr style={{ background: "rgba(255,255,255,0.02)" }}>
                  <TD colSpan={4} style={{ borderBottom: "none", fontSize: 11, fontWeight: 950, textTransform: "uppercase", letterSpacing: 2, color: "var(--text3)" }}>Consolidated Monthly Yield</TD>
                  <TD right style={{ borderBottom: "none", fontSize: 16, fontWeight: 950, color: net >= 0 ? "var(--green)" : "var(--red)" }}>
                    {INR(net)}
                  </TD>
                  <TD colSpan={2} style={{ borderBottom: "none" }}></TD>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>
      
      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        select option { background: #1a1b1e; color: #fff; }
      `}</style>
      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}
