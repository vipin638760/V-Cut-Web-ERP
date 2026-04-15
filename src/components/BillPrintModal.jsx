"use client";
import { INR } from "@/lib/calculations";

// Reusable print-ready bill modal. Pass a settled invoice doc; optional onClose.
// Uses the same #print-bill id as the POS so the existing print CSS rules apply:
// only #print-bill is visible in print output, everything else hidden.
export default function BillPrintModal({ invoice, onClose }) {
  if (!invoice) return null;
  const items = invoice.items || [];
  const subtotal = Number(invoice.subtotal) || items.reduce((s, it) => s + (Number(it.price) || 0), 0);
  const onlineAmt = Number(invoice.online) || 0;
  const cashAmt = Number(invoice.cash) || Math.max(0, subtotal - onlineAmt);
  let paymentMode = "Cash";
  if (onlineAmt > 0 && cashAmt > 0) paymentMode = "Split (Cash + Online)";
  else if (onlineAmt > 0) paymentMode = "Online";
  const gstPct = Number(invoice.gst_pct) || 0;
  const gstAmt = Number(invoice.gst_amount) || 0;
  const total = Number(invoice.total) || subtotal;
  const settledAt = invoice.settled_at || invoice.created_at;
  const time = settledAt ? new Date(settledAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "";

  return (
    <div className="bill-overlay" onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, overflowY: "auto" }}>
      <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 520 }}>
        <div id="print-bill" style={{ background: "#fff", color: "#111", borderRadius: 14, padding: "28px 32px", fontFamily: "var(--font-headline, var(--font-outfit))", boxShadow: "0 25px 50px -12px rgba(0,0,0,0.6)" }}>
          {/* Header */}
          <div style={{ textAlign: "center", paddingBottom: 14, borderBottom: "2px dashed #ddd" }}>
            <div style={{ fontFamily: "'Great Vibes', cursive", fontSize: 38, lineHeight: 1, color: "#dc2626" }}>V</div>
            <div style={{ fontFamily: "'Great Vibes', cursive", fontSize: 26, color: "#111", lineHeight: 1 }}>-Cut</div>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 4, color: "#111", marginTop: 4 }}>
              SALON · {(invoice.branch_name || "").replace("V-CUT ", "").toUpperCase()}
            </div>
          </div>

          {/* Meta */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginTop: 12, fontSize: 11, color: "#333" }}>
            <div>
              <div><strong>Bill #</strong> {invoice.invoice_no || "—"}</div>
              <div>{invoice.date} · {time}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              {invoice.customer_name ? (
                <>
                  <div><strong>Customer:</strong> {invoice.customer_name}</div>
                  {invoice.customer_phone && <div style={{ color: "#555" }}>📞 {invoice.customer_phone}</div>}
                </>
              ) : (
                <div><strong>Customer:</strong> Walk-in{invoice.walkin_no ? ` #${String(invoice.walkin_no).padStart(3, "0")}` : ""}</div>
              )}
            </div>
          </div>

          {/* Items */}
          <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse", marginTop: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #111" }}>
                <th style={{ textAlign: "left", padding: "6px 4px", fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Service</th>
                <th style={{ textAlign: "left", padding: "6px 4px", fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Stylist</th>
                <th style={{ textAlign: "right", padding: "6px 4px", fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} style={{ borderBottom: "1px dashed #eee" }}>
                  <td style={{ padding: "8px 4px", fontWeight: 600 }}>{it.name}</td>
                  <td style={{ padding: "8px 4px", color: "#555" }}>
                    {it.staff_name || "—"}
                    {it.loan_flag && <span className="no-print" style={{ marginLeft: 6, padding: "1px 5px", background: "#fef3c7", color: "#b45309", border: "1px solid #fde68a", borderRadius: 4, fontSize: 9, fontWeight: 700, letterSpacing: 0.5 }}>LOAN</span>}
                  </td>
                  <td style={{ padding: "8px 4px", textAlign: "right", fontWeight: 700 }}>{INR(it.price || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Totals */}
          <div style={{ borderTop: "1px solid #111", paddingTop: 10, fontSize: 12 }}>
            <Row label="Subtotal" value={INR(subtotal)} />
            {gstPct > 0 && <Row label={`GST (${gstPct}%) — incl.`} value={INR(gstAmt)} muted />}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, paddingTop: 8, borderTop: "2px solid #111", fontSize: 16, fontWeight: 900 }}>
              <span>TOTAL</span>
              <span>{INR(total)}</span>
            </div>
          </div>

          {/* Payment */}
          <div style={{ marginTop: 14, padding: "10px 12px", background: "#f6f6f6", borderRadius: 8, fontSize: 11 }}>
            <div style={{ fontWeight: 800, marginBottom: 4 }}>Payment — {paymentMode}</div>
            {onlineAmt > 0 && <div style={{ display: "flex", justifyContent: "space-between" }}><span>Online</span><strong>{INR(onlineAmt)}</strong></div>}
            {cashAmt > 0 && <div style={{ display: "flex", justifyContent: "space-between" }}><span>Cash</span><strong>{INR(cashAmt)}</strong></div>}
          </div>

          {/* Thanks */}
          <div style={{ textAlign: "center", marginTop: 18, fontSize: 11, lineHeight: 1.6, color: "#333" }}>
            <div style={{ fontFamily: "'Great Vibes', cursive", fontSize: 28, color: "#dc2626", lineHeight: 1 }}>Thank You</div>
            <div style={{ marginTop: 6 }}>We loved having you at <strong>V-Cut</strong>. See you again soon ✂️</div>
            {invoice.cashier_name && <div style={{ fontSize: 10, color: "#777", marginTop: 8 }}>Billed by {invoice.cashier_name}</div>}
          </div>
        </div>

        {/* Actions — hidden in print */}
        <div className="no-print" style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <button onClick={onClose}
            style={{ flex: 1, padding: "12px", borderRadius: 10, background: "var(--bg3)", color: "var(--text)", border: "1px solid var(--border)", cursor: "pointer", fontWeight: 700 }}>
            Close
          </button>
          <button onClick={() => window.print()}
            style={{ flex: 2, padding: "12px", borderRadius: 10, background: "linear-gradient(135deg, var(--accent), var(--gold2))", color: "#000", border: "none", cursor: "pointer", fontWeight: 900, letterSpacing: 1, textTransform: "uppercase" }}>
            Print / Save as PDF
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, muted }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", color: muted ? "#666" : "#111" }}>
      <span>{label}</span>
      <span style={{ fontWeight: muted ? 500 : 700 }}>{value}</span>
    </div>
  );
}
