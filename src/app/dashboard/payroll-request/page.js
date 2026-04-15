"use client";
import { useEffect, useState } from "react";
import { collection, addDoc, query, where, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR, makeFilterPrefix } from "@/lib/calculations";
import { Card, TH, TD, Pill, PeriodWidget, Icon, useConfirm } from "@/components/ui";
import VLoader from "@/components/VLoader";


export default function PayrollRequestPage() {
  const { confirm, ConfirmDialog } = useConfirm();
  const [advances, setAdvances] = useState([]);
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [filterYear, setFilterYear] = useState(new Date().getFullYear());
  const [filterMonth, setFilterMonth] = useState(new Date().getMonth() + 1);
  const filterPrefix = makeFilterPrefix(filterYear, filterMonth);

  const currentUser = useCurrentUser() || {};

  useEffect(() => {
    if (!db || !currentUser.id) return;
    const q = query(collection(db, "staff_advances"), where("staff_id", "==", currentUser.staff_id || currentUser.id));
    const unsub = onSnapshot(q, sn => {
      const docs = sn.docs.map(d => ({ ...d.data(), id: d.id }));
      docs.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      setAdvances(docs);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!amount || Number(amount) <= 0) { confirm({ title: "Notice", message: "Enter a valid amount.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} }); return; }
    setSubmitting(true);
    try {
      await addDoc(collection(db, "staff_advances"), {
        staff_id: currentUser.staff_id || currentUser.id,
        staff_name: currentUser.name,
        amount: Number(amount),
        reason: reason || "",
        date: new Date().toISOString().split("T")[0],
        month_str: filterPrefix,
        status: "pending",
        requested_at: new Date().toISOString(),
      });
      setAmount("");
      setReason("");
      confirm({ title: "Success", message: "Advance request submitted successfully.", confirmText: "OK", cancelText: "Close", type: "success", onConfirm: () => {} });
    } catch (err) { confirm({ title: "Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} }); }
    setSubmitting(false);
  };

  const periodAdvances = advances.filter(a => a.month_str === filterPrefix || (a.date && a.date.startsWith(filterPrefix)));
  const totalApproved = periodAdvances.filter(a => a.status === "approved").reduce((s, a) => s + Number(a.amount), 0);
  const totalPending = periodAdvances.filter(a => a.status === "pending").reduce((s, a) => s + Number(a.amount), 0);

  if (loading) return <VLoader fullscreen label="Loading" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h2 style={{ fontSize: 28, fontWeight: 800, color: "var(--text)", margin: 0, fontFamily: "var(--font-headline, var(--font-outfit))" }}>Advance Request</h2>
        <p style={{ fontSize: 13, color: "var(--text3)", fontWeight: 500, marginTop: 6 }}>Request salary advances and track your history.</p>
      </div>

      <PeriodWidget filterMode="month" setFilterMode={() => {}} filterYear={filterYear} setFilterYear={setFilterYear} filterMonth={filterMonth} setFilterMonth={setFilterMonth} monthlyOnly />

      {/* Summary Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
        <div style={{ background: "var(--bg3)", borderRadius: 14, padding: "18px 22px", border: "1px solid rgba(72,72,71,0.1)" }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>Approved Advances</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--green)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(totalApproved)}</div>
        </div>
        <div style={{ background: "var(--bg3)", borderRadius: 14, padding: "18px 22px", border: "1px solid rgba(72,72,71,0.1)" }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>Pending Requests</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--orange)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(totalPending)}</div>
        </div>
      </div>

      {/* Request Form */}
      <Card style={{ padding: 24 }}>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 16, fontFamily: "var(--font-headline, var(--font-outfit))" }}>New Advance Request</h3>
        <form onSubmit={handleSubmit} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <label style={{ fontSize: 10, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 6 }}>Amount (&#x20B9;)</label>
            <input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0"
              style={{ width: "100%", padding: "12px 14px", background: "var(--bg4)", border: "none", borderBottom: "2px solid transparent", borderRadius: 10, color: "var(--text)", fontSize: 14, fontWeight: 700, outline: "none" }}
            />
          </div>
          <div>
            <label style={{ fontSize: 10, fontWeight: 600, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 6 }}>Reason</label>
            <input type="text" value={reason} onChange={e => setReason(e.target.value)} placeholder="Optional"
              style={{ width: "100%", padding: "12px 14px", background: "var(--bg4)", border: "none", borderRadius: 10, color: "var(--text)", fontSize: 13, fontWeight: 500, outline: "none" }}
            />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <button type="submit" disabled={submitting}
              style={{ padding: "12px 28px", borderRadius: 10, background: "linear-gradient(135deg, var(--accent), var(--gold2))", color: "#000", border: "none", fontWeight: 700, cursor: "pointer", fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, opacity: submitting ? 0.5 : 1 }}>
              {submitting ? "Submitting..." : "Submit Request"}
            </button>
          </div>
        </form>
      </Card>

      {/* History */}
      <div>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 12, fontFamily: "var(--font-headline, var(--font-outfit))" }}>Request History</h3>
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
            <thead><tr><TH>Date</TH><TH>Period</TH><TH right>Amount</TH><TH>Reason</TH><TH>Status</TH></tr></thead>
            <tbody>
              {advances.slice(0, 20).map(a => (
                <tr key={a.id} style={{ transition: "background 0.15s" }}
                  onMouseEnter={e => e.currentTarget.style.background = "var(--bg4)"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <TD style={{ color: "var(--text3)", fontSize: 12 }}>{a.date}</TD>
                  <TD><Pill label={a.month_str || "—"} color="gold" /></TD>
                  <TD right style={{ fontWeight: 700, color: "var(--accent)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(a.amount)}</TD>
                  <TD style={{ color: "var(--text3)", fontSize: 12 }}>{a.reason || "—"}</TD>
                  <TD><Pill label={a.status} color={a.status === "approved" ? "green" : a.status === "rejected" ? "red" : "orange"} /></TD>
                </tr>
              ))}
              {advances.length === 0 && <tr><TD colSpan={5} style={{ textAlign: "center", padding: 40, color: "var(--text3)" }}>No advance requests yet</TD></tr>}
            </tbody>
          </table>
        </Card>
      </div>
      {ConfirmDialog}
    </div>
  );
}
