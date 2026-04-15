"use client";
import { useEffect, useState } from "react";
import { collection, onSnapshot, query, orderBy, addDoc, deleteDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Icon, IconBtn, Card, PeriodWidget, TH, TD, Modal, Pill, StatCard, useConfirm, useToast } from "@/components/ui";
import VLoader from "@/components/VLoader";


const NOW = new Date();

export default function ReviewsTab() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [reviews, setReviews] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);

  // Filter states
  const [filterYear, setFilterYear] = useState(NOW.getFullYear());
  const [filterMonth, setFilterMonth] = useState(NOW.getMonth() + 1);
  const filterPrefix = `${filterYear}-${String(filterMonth).padStart(2, "0")}`;

  // UI states
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ staff_id: "", customer_name: "", date: "", rating: 5, feedback: "" });

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "staff"), sn => setStaff(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(query(collection(db, "staff_reviews"), orderBy("date", "desc")), sn => {
        setReviews(sn.docs.map(d => ({ ...d.data(), id: d.id })));
        setLoading(false);
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.staff_id || !form.date || !form.rating) { confirm({ title: "Validation", message: "Staff, Date and Rating are mandatory for recording.", confirmText: "OK", type: "warning", onConfirm: () => {} }); return; }
    try {
      await addDoc(collection(db, "staff_reviews"), {
        ...form,
        rating: Number(form.rating),
        created_at: new Date().toISOString()
      });
      setShowForm(false);
      setForm({ staff_id: "", customer_name: "", date: "", rating: 5, feedback: "" });
      toast({ title: "Saved", message: "Review recorded successfully.", type: "success" });
    } catch (err) { confirm({ title: "Error", message: err.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
  };

  const handleDelete = async (id) => {
    confirm({
      title: "Delete Performance Record",
      message: "Are you sure you want to permanently remove this <strong>performance record</strong>?",
      confirmText: "Yes, Delete",
      cancelText: "Cancel",
      type: "danger",
      onConfirm: async () => {
        try {
          await deleteDoc(doc(db, "staff_reviews", id));
          toast({ title: "Deleted", message: "Review has been removed.", type: "success" });
        } catch (err) { confirm({ title: "Error", message: err.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
      }
    });
  };

  if (loading) return <VLoader fullscreen label="Syncing performance feedback" />;

  const filtered = reviews.filter(r => r.date && r.date.startsWith(filterPrefix));
  const avgRating = filtered.length > 0 ? (filtered.reduce((s, r) => s + (r.rating || 0), 0) / filtered.length).toFixed(1) : "0.0";

  const inputStyle = { width: "100%", padding: "14px 18px", border: "1px solid var(--border2)", borderRadius: 14, background: "rgba(255,255,255,0.02)", color: "var(--text)", outline: "none", fontSize: 13, transition: "all 0.2s" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32, animation: "fadeIn 0.5s ease-out" }}>
      {/* Dynamic Header */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 24 }}>
        <div>
           <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <div style={{ background: "rgba(34,211,238,0.1)", padding: 8, borderRadius: 10 }}>
                 <Icon name="star" size={18} color="var(--accent)" />
              </div>
              <h3 style={{ fontSize: 22, fontWeight: 950, color: "var(--text)", textTransform: "uppercase", letterSpacing: 1 }}>Performance Registry</h3>
           </div>
           <p style={{ fontSize: 13, color: "var(--text3)", fontWeight: 500 }}>Global repository for customer feedback and internal staff assessments.</p>
        </div>
        <button onClick={() => setShowForm(true)}
          style={{ padding: "14px 28px", borderRadius: 16, background: "var(--accent)", color: "#000", border: "none", cursor: "pointer", fontWeight: 900, fontSize: 13, textTransform: "uppercase", letterSpacing: 1, display: "flex", alignItems: "center", gap: 10, boxShadow: "0 10px 25px -10px rgba(34,211,238,0.5)" }}>
          <Icon name="plus" size={18} /> Record New Entry
        </button>
      </div>

      {/* Analytics Suite */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20 }}>
         <StatCard 
            label="Avg Monthly Rating" 
            value={avgRating} 
            subtext={`${filtered.length} entries this period`}
            icon={<Icon name="star" size={18} />}
            color="gold"
         />
         <StatCard 
            label="Feedback Volume" 
            value={filtered.length} 
            subtext="Total journaled interactions"
            icon={<Icon name="zap" size={18} />}
            color="cyan"
         />
         <PeriodWidget filterMode={"month"} setFilterMode={() => {}} filterYear={filterYear} setFilterYear={setFilterYear} filterMonth={filterMonth} setFilterMonth={setFilterMonth} />
      </div>

      {/* Ledger Table */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
           <div style={{ height: 2, width: 20, background: "var(--accent)" }}></div>
           <h4 style={{ fontSize: 12, fontWeight: 900, color: "var(--text2)", textTransform: "uppercase", letterSpacing: 2 }}>Journaled Feed Ledger</h4>
        </div>
        <Card style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
            <thead>
              <tr>
                <TH>Timestamp & Personnel</TH>
                <TH>Contributor</TH>
                <TH>Score</TH>
                <TH>Journal Entry</TH>
                <TH right>Actions</TH>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><TD colSpan={5} style={{ textAlign: "center", padding: 60, color: "var(--text3)", fontStyle: "italic" }}>No entries journaled for this node period.</TD></tr>
              ) : filtered.map((r) => {
                const s = staff.find(x => x.id === r.staff_id);
                return (
                  <tr key={r.id} onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.01)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <TD>
                      <div style={{ fontWeight: 800, color: "var(--text)", fontSize: 14 }}>{new Date(r.date).toLocaleDateString("en-IN", { day: 'numeric', month: 'short', year: 'numeric' })}</div>
                      <div style={{ fontSize: 11, color: "var(--accent)", fontWeight: 900, textTransform: "uppercase", marginTop: 2 }}>{s ? s.name : "System Ref Error"}</div>
                    </TD>
                    <TD>
                       <div style={{ color: "var(--text2)", fontWeight: 600 }}>{r.customer_name || "Internal Assessment"}</div>
                    </TD>
                    <TD>
                      <div style={{ display: "flex", gap: 3 }}>
                         {[1,2,3,4,5].map(star => (
                            <Icon key={star} name="star" size={12} color={star <= r.rating ? "var(--gold)" : "rgba(255,255,255,0.05)"} />
                         ))}
                      </div>
                    </TD>
                    <TD style={{ color: "var(--text3)", maxWidth: 350, fontSize: 13, lineHeight: 1.5 }}>
                       {r.feedback || <span style={{ fontStyle: "italic", opacity: 0.5 }}>No detailed journal provided</span>}
                    </TD>
                    <TD right>
                       <IconBtn name="del" size={24} variant="danger" onClick={() => handleDelete(r.id)} />
                    </TD>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </div>

      {showForm && (
        <Modal title={"Initialize Performance Entry"} onClose={() => setShowForm(false)}>
          <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: 24, padding: "8px 0" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
              <div>
                 <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Target Personnel *</label>
                 <select required value={form.staff_id} onChange={e => setForm({...form, staff_id: e.target.value})} style={{ ...inputStyle, appearance: "none" }}>
                   <option value="">-- Identity Select --</option>
                   {staff.map(s => <option key={s.id} value={s.id}>{s.name} ({s.role})</option>)}
                 </select>
              </div>
              <div>
                 <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Assessment Date *</label>
                 <input type="date" required value={form.date} onChange={e => setForm({...form, date: e.target.value})} style={inputStyle} />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
               <div>
                  <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Contributor Identity</label>
                  <input type="text" value={form.customer_name} onChange={e => setForm({...form, customer_name: e.target.value})} placeholder="e.g. Verified Client" style={inputStyle} />
               </div>
               <div>
                  <label style={{ fontSize: 11, fontWeight: 900, color: "var(--gold)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Assessment Score (1-5) *</label>
                  <input type="number" required min="1" max="5" value={form.rating} onChange={e => setForm({...form, rating: e.target.value})} style={{ ...inputStyle, borderColor: "var(--gold)", background: "rgba(255,215,0,0.03)" }} />
               </div>
            </div>
            <div>
               <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Detailed Journal Entry</label>
               <textarea rows={4} value={form.feedback} onChange={e => setForm({...form, feedback: e.target.value})} placeholder="Document detailed observations or feedback..."
                 style={{ ...inputStyle, resize: "vertical" }} />
            </div>
            <button type="submit" style={{ padding: "18px", borderRadius: 16, background: "var(--accent)", color: "#000", border: "none", fontWeight: 950, fontSize: 14, textTransform: "uppercase", letterSpacing: 1.2, cursor: "pointer", marginTop: 8, boxShadow: "0 10px 30px -10px rgba(34,211,238,0.5)" }}>
              Journal Assessment
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
