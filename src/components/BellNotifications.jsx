"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import { collection, onSnapshot, getDocs, query, where, doc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Icon } from "./ui";

export default function BellNotifications({ currentUser }) {
  const [approvals, setApprovals] = useState([]);
  const [extras, setExtras] = useState([]); // leaves, staff_setup, advances
  const [open, setOpen] = useState(false);
  const [loadedExtras, setLoadedExtras] = useState(false);
  const wrapRef = useRef(null);

  // Real-time subscription for approvals (original, known working)
  useEffect(() => {
    if (!db) return;
    const q = query(collection(db, "approvals"), where("status", "==", "pending"));
    const unsub = onSnapshot(q, sn => {
      setApprovals(sn.docs.map(d => ({ ...d.data(), id: d.id, _kind: "approval" })));
    });
    return () => unsub();
  }, []);

  // Fetch other notifications on-demand when dropdown opens (safe — no persistent subscriptions)
  const fetchExtras = useCallback(async () => {
    if (!db) return;
    const items = [];
    try {
      const leaveSnap = await getDocs(query(collection(db, "leaves"), where("status", "==", "pending")));
      leaveSnap.docs.forEach(d => items.push({ ...d.data(), id: d.id, _kind: "leave" }));
    } catch { /* index missing or permissions */ }
    try {
      const staffSnap = await getDocs(query(collection(db, "staff"), where("pending_setup", "==", true)));
      staffSnap.docs.forEach(d => items.push({ ...d.data(), id: d.id, _kind: "staff_setup" }));
    } catch { /* ignore */ }
    try {
      const advSnap = await getDocs(query(collection(db, "staff_advances"), where("status", "==", "pending")));
      advSnap.docs.forEach(d => items.push({ ...d.data(), id: d.id, _kind: "advance" }));
    } catch { /* ignore */ }
    setExtras(items);
    setLoadedExtras(true);
  }, []);

  // Fetch extras when dropdown opens
  useEffect(() => {
    if (open) fetchExtras();
    if (!open) setLoadedExtras(false);
  }, [open, fetchExtras]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [open]);

  const handleAction = async (colName, id, status) => {
    await updateDoc(doc(db, colName, id), {
      status,
      reviewed_by: currentUser?.name || "admin",
      reviewed_by_id: currentUser?.id || "",
      reviewed_at: new Date().toISOString(),
    });
    // Refresh extras after action
    fetchExtras();
  };

  const colFor = (kind) => ({ approval: "approvals", leave: "leaves", advance: "staff_advances" }[kind]);

  const all = [...approvals, ...extras];
  all.sort((a, b) => (b.requested_at || b.created_at || b.date || "").localeCompare(a.requested_at || a.created_at || a.date || ""));
  const count = approvals.length + extras.length;

  const kindLabel = (k) => ({ approval: "Discount", leave: "Leave", staff_setup: "Staff Setup", advance: "Advance" }[k] || k);
  const kindStyle = (k) => ({
    approval:    { bg: "rgba(251,146,60,0.12)", border: "rgba(251,146,60,0.3)", color: "var(--orange)" },
    leave:       { bg: "rgba(96,165,250,0.12)", border: "rgba(96,165,250,0.3)", color: "#60a5fa" },
    staff_setup: { bg: "rgba(0,188,212,0.12)",  border: "rgba(0,188,212,0.3)",  color: "var(--accent)" },
    advance:     { bg: "rgba(255,215,0,0.12)",  border: "rgba(255,215,0,0.3)",  color: "var(--gold)" },
  }[k] || { bg: "var(--bg4)", border: "var(--border)", color: "var(--text3)" });

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button onClick={() => setOpen(o => !o)} title="Pending notifications"
        style={{
          position: "relative", width: 34, height: 34, borderRadius: 10,
          background: approvals.length > 0 ? "rgba(var(--accent-rgb),0.12)" : "var(--bg4)",
          border: `1px solid ${approvals.length > 0 ? "rgba(var(--accent-rgb),0.4)" : "rgba(72,72,71,0.2)"}`,
          color: approvals.length > 0 ? "var(--accent)" : "var(--text2)",
          cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0, transition: "all .15s",
        }}>
        <Icon name="bell" size={16} />
        {approvals.length > 0 && (
          <span style={{
            position: "absolute", top: -4, right: -4,
            minWidth: 16, height: 16, padding: "0 4px",
            background: "var(--red)", color: "#fff",
            borderRadius: 8, fontSize: 9, fontWeight: 900,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            border: "2px solid var(--bg1)",
          }}>{approvals.length > 99 ? "99+" : approvals.length}</span>
        )}
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 8px)", right: 0, width: 380, zIndex: 1000,
          background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 14,
          boxShadow: "0 20px 40px -10px rgba(0,0,0,0.5)", overflow: "hidden",
        }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", background: "linear-gradient(90deg, rgba(var(--accent-rgb),0.08), transparent)" }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 2 }}>Notifications</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text)" }}>
              {count === 0 ? "You're all caught up" : `${count} pending`}
            </div>
          </div>

          <div style={{ maxHeight: 420, overflowY: "auto" }}>
            {count === 0 && (
              <div style={{ padding: 26, textAlign: "center", color: "var(--text3)", fontSize: 12 }}>
                <div style={{ fontSize: 24, opacity: 0.4, marginBottom: 6 }}>🔕</div>
                No pending requests.
              </div>
            )}
            {all.map(a => {
              const ks = kindStyle(a._kind);
              return (
                <div key={`${a._kind}-${a.id}`} style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 9, fontWeight: 800, padding: "2px 7px", borderRadius: 5, background: ks.bg, color: ks.color, border: `1px solid ${ks.border}`, textTransform: "uppercase", letterSpacing: 1 }}>
                      {kindLabel(a._kind)}
                    </span>
                    <span style={{ fontSize: 10, color: "var(--text3)", fontWeight: 600 }}>
                      {a.requested_by || a.staff_name || a.name || "—"}{a.branch_name ? ` · ${a.branch_name}` : ""}
                    </span>
                  </div>

                  {a._kind === "approval" && (
                    <>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
                        {a.requested_pct}% off requested
                        {a.base_pct ? <span style={{ fontSize: 10, color: "var(--text3)", fontWeight: 600, marginLeft: 6 }}>(base {a.base_pct}%)</span> : null}
                      </div>
                      {a.customer_name && <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 2 }}>Customer: {a.customer_name}</div>}
                      {a.reason && <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4, fontStyle: "italic" }}>&ldquo;{a.reason}&rdquo;</div>}
                    </>
                  )}

                  {a._kind === "leave" && (
                    <>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{a.staff_name || a.name || "Staff"} — {a.leave_type || a.type || "Leave"}</div>
                      <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 2 }}>{a.date || "—"}{a.days && a.days > 1 ? ` (${a.days} days)` : ""}</div>
                      {a.reason && <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4, fontStyle: "italic" }}>&ldquo;{a.reason}&rdquo;</div>}
                    </>
                  )}

                  {a._kind === "staff_setup" && (
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{a.name || "New Staff"} — needs salary & incentive setup</div>
                      <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>Added by accountant · {a.role || "—"}</div>
                      <div style={{ marginTop: 6, fontSize: 10, color: "var(--text3)", fontStyle: "italic" }}>Go to Staff → Pending Setup to configure</div>
                    </div>
                  )}

                  {a._kind === "advance" && (
                    <>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{a.staff_name || "Staff"} — ₹{Number(a.amount || 0).toLocaleString("en-IN")} advance</div>
                      {a.reason && <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4, fontStyle: "italic" }}>&ldquo;{a.reason}&rdquo;</div>}
                    </>
                  )}

                  {a._kind !== "staff_setup" && (
                    <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                      <button onClick={() => handleAction(colFor(a._kind), a.id, "approved")}
                        style={{ flex: 1, padding: "6px 10px", background: "rgba(74,222,128,0.12)", border: "1px solid rgba(74,222,128,0.35)", color: "var(--green)", borderRadius: 6, fontSize: 10, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", cursor: "pointer" }}>
                        Approve
                      </button>
                      <button onClick={() => handleAction(colFor(a._kind), a.id, "rejected")}
                        style={{ flex: 1, padding: "6px 10px", background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)", color: "var(--red)", borderRadius: 6, fontSize: 10, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", cursor: "pointer" }}>
                        Reject
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
