"use client";
import { useEffect, useState, useRef } from "react";
import { collection, onSnapshot, query, where, doc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Icon } from "./ui";

/**
 * Bell in the top bar. Subscribes to pending approvals and renders a dropdown
 * where admin/accountant can approve or reject each request.
 *
 * Approval doc shape (approvals collection):
 *   type: "pos_discount"
 *   status: "pending" | "approved" | "rejected"
 *   requested_by, requested_by_id, requested_at
 *   branch_id, branch_name, customer_id, customer_name
 *   draft_invoice_id
 *   requested_pct, base_pct, reason
 *   reviewed_by, reviewed_by_id, reviewed_at
 */
export default function BellNotifications({ currentUser }) {
  const [pending, setPending] = useState([]);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!db) return;
    const q = query(collection(db, "approvals"), where("status", "==", "pending"));
    const unsub = onSnapshot(q, sn => {
      const list = sn.docs.map(d => ({ ...d.data(), id: d.id }));
      list.sort((a, b) => (b.requested_at || "").localeCompare(a.requested_at || ""));
      setPending(list);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [open]);

  const approve = async (a) => {
    await updateDoc(doc(db, "approvals", a.id), {
      status: "approved",
      reviewed_by: currentUser?.name || "admin",
      reviewed_by_id: currentUser?.id || "",
      reviewed_at: new Date().toISOString(),
    });
  };
  const reject = async (a) => {
    await updateDoc(doc(db, "approvals", a.id), {
      status: "rejected",
      reviewed_by: currentUser?.name || "admin",
      reviewed_by_id: currentUser?.id || "",
      reviewed_at: new Date().toISOString(),
    });
  };

  const count = pending.length;

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button onClick={() => setOpen(o => !o)} title="Pending approvals"
        style={{
          position: "relative", width: 34, height: 34, borderRadius: 10,
          background: count > 0 ? "rgba(var(--accent-rgb),0.12)" : "var(--bg4)",
          border: `1px solid ${count > 0 ? "rgba(var(--accent-rgb),0.4)" : "rgba(72,72,71,0.2)"}`,
          color: count > 0 ? "var(--accent)" : "var(--text2)",
          cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0, transition: "all .15s",
        }}>
        <Icon name="bell" size={16} />
        {count > 0 && (
          <span style={{
            position: "absolute", top: -4, right: -4,
            minWidth: 16, height: 16, padding: "0 4px",
            background: "var(--red)", color: "#fff",
            borderRadius: 8, fontSize: 9, fontWeight: 900,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            border: "2px solid var(--bg1)",
          }}>{count > 99 ? "99+" : count}</span>
        )}
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 8px)", right: 0, width: 360, zIndex: 1000,
          background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 14,
          boxShadow: "0 20px 40px -10px rgba(0,0,0,0.5)", overflow: "hidden",
        }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", background: "linear-gradient(90deg, rgba(var(--accent-rgb),0.08), transparent)" }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 2 }}>Notifications</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text)" }}>
              {count === 0 ? "You're all caught up" : `${count} pending approval${count === 1 ? "" : "s"}`}
            </div>
          </div>

          <div style={{ maxHeight: 420, overflowY: "auto" }}>
            {count === 0 && (
              <div style={{ padding: 26, textAlign: "center", color: "var(--text3)", fontSize: 12 }}>
                <div style={{ fontSize: 24, opacity: 0.4, marginBottom: 6 }}>🔕</div>
                No pending requests.
              </div>
            )}
            {pending.map(a => (
              <div key={a.id} style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{
                    fontSize: 9, fontWeight: 800, padding: "2px 7px", borderRadius: 5,
                    background: "rgba(251,146,60,0.12)", color: "var(--orange)",
                    border: "1px solid rgba(251,146,60,0.3)",
                    textTransform: "uppercase", letterSpacing: 1,
                  }}>{a.type === "pos_discount" ? "Discount" : a.type}</span>
                  <span style={{ fontSize: 10, color: "var(--text3)", fontWeight: 600 }}>
                    {a.requested_by || "—"}{a.branch_name ? ` · ${a.branch_name}` : ""}
                  </span>
                </div>
                {a.type === "pos_discount" ? (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
                      {a.requested_pct}% off requested
                      {a.base_pct ? <span style={{ fontSize: 10, color: "var(--text3)", fontWeight: 600, marginLeft: 6 }}>(base {a.base_pct}%)</span> : null}
                    </div>
                    {a.customer_name && <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 2 }}>Customer: {a.customer_name}</div>}
                    {a.reason && <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4, fontStyle: "italic" }}>&ldquo;{a.reason}&rdquo;</div>}
                  </>
                ) : (
                  <div style={{ fontSize: 12, color: "var(--text2)" }}>{JSON.stringify(a)}</div>
                )}
                <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                  <button onClick={() => approve(a)}
                    style={{ flex: 1, padding: "6px 10px", background: "rgba(74,222,128,0.12)", border: "1px solid rgba(74,222,128,0.35)", color: "var(--green)", borderRadius: 6, fontSize: 10, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", cursor: "pointer" }}>
                    Approve
                  </button>
                  <button onClick={() => reject(a)}
                    style={{ flex: 1, padding: "6px 10px", background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)", color: "var(--red)", borderRadius: 6, fontSize: 10, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", cursor: "pointer" }}>
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
