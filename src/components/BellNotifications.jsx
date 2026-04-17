"use client";
import { useEffect, useState, useRef } from "react";
import { collection, onSnapshot, query, where, doc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Icon } from "./ui";

/**
 * Bell in the top bar. Subscribes to pending approvals, leaves, staff setup,
 * and advance requests — renders a unified dropdown for admin/accountant.
 */
export default function BellNotifications({ currentUser }) {
  const [approvals, setApprovals] = useState([]);
  const [pendingLeaves, setPendingLeaves] = useState([]);
  const [pendingStaff, setPendingStaff] = useState([]);
  const [pendingAdvances, setPendingAdvances] = useState([]);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // Original approvals subscription (known working)
  useEffect(() => {
    if (!db) return;
    const q = query(collection(db, "approvals"), where("status", "==", "pending"));
    const unsub = onSnapshot(q, sn => {
      setApprovals(sn.docs.map(d => ({ ...d.data(), id: d.id, _kind: "approval" })));
    });
    return () => unsub();
  }, []);

  // Additional subscriptions — each in its own useEffect so a failure in one doesn't block others
  useEffect(() => {
    if (!db) return;
    try {
      const q = query(collection(db, "leaves"), where("status", "==", "pending"));
      const unsub = onSnapshot(q, sn => setPendingLeaves(sn.docs.map(d => ({ ...d.data(), id: d.id, _kind: "leave" }))), () => {});
      return () => unsub();
    } catch { return; }
  }, []);
  useEffect(() => {
    if (!db) return;
    try {
      const q = query(collection(db, "staff"), where("pending_setup", "==", true));
      const unsub = onSnapshot(q, sn => setPendingStaff(sn.docs.map(d => ({ ...d.data(), id: d.id, _kind: "staff_setup" }))), () => {});
      return () => unsub();
    } catch { return; }
  }, []);
  useEffect(() => {
    if (!db) return;
    try {
      const q = query(collection(db, "staff_advances"), where("status", "==", "pending"));
      const unsub = onSnapshot(q, sn => setPendingAdvances(sn.docs.map(d => ({ ...d.data(), id: d.id, _kind: "advance" }))), () => {});
      return () => unsub();
    } catch { return; }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [open]);

  const approveDoc = async (col, id) => {
    await updateDoc(doc(db, col, id), {
      status: "approved",
      reviewed_by: currentUser?.name || "admin",
      reviewed_by_id: currentUser?.id || "",
      reviewed_at: new Date().toISOString(),
    });
  };
  const rejectDoc = async (col, id) => {
    await updateDoc(doc(db, col, id), {
      status: "rejected",
      reviewed_by: currentUser?.name || "admin",
      reviewed_by_id: currentUser?.id || "",
      reviewed_at: new Date().toISOString(),
    });
  };

  // Build unified notification list
  const all = [...approvals, ...pendingLeaves, ...pendingStaff, ...pendingAdvances];
  all.sort((a, b) => (b.requested_at || b.created_at || b.date || "").localeCompare(a.requested_at || a.created_at || a.date || ""));
  const count = all.length;

  const kindLabel = (k) => ({ approval: "Discount", leave: "Leave", staff_setup: "Staff Setup", advance: "Advance" }[k] || k);
  const kindStyles = (k) => ({
    approval: { bg: "rgba(251,146,60,0.12)", border: "rgba(251,146,60,0.3)", color: "var(--orange)" },
    leave: { bg: "rgba(96,165,250,0.12)", border: "rgba(96,165,250,0.3)", color: "var(--blue, #60a5fa)" },
    staff_setup: { bg: "rgba(0,188,212,0.12)", border: "rgba(0,188,212,0.3)", color: "var(--accent)" },
    advance: { bg: "rgba(255,215,0,0.12)", border: "rgba(255,215,0,0.3)", color: "var(--gold)" },
  }[k] || { bg: "var(--bg4)", border: "var(--border)", color: "var(--text3)" });

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button onClick={() => setOpen(o => !o)} title="Pending notifications"
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
          position: "absolute", top: "calc(100% + 8px)", right: 0, width: 380, zIndex: 1000,
          background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 14,
          boxShadow: "0 20px 40px -10px rgba(0,0,0,0.5)", overflow: "hidden",
        }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", background: "linear-gradient(90deg, rgba(var(--accent-rgb),0.08), transparent)" }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 2 }}>Notifications</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text)" }}>
              {count === 0 ? "You're all caught up" : `${count} pending`}
            </div>
            {count > 0 && (
              <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                {approvals.length > 0 && <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "rgba(251,146,60,0.12)", color: "var(--orange)" }}>{approvals.length} Discount</span>}
                {pendingLeaves.length > 0 && <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "rgba(96,165,250,0.12)", color: "var(--blue, #60a5fa)" }}>{pendingLeaves.length} Leave</span>}
                {pendingStaff.length > 0 && <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "rgba(0,188,212,0.12)", color: "var(--accent)" }}>{pendingStaff.length} Staff Setup</span>}
                {pendingAdvances.length > 0 && <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "rgba(255,215,0,0.12)", color: "var(--gold)" }}>{pendingAdvances.length} Advance</span>}
              </div>
            )}
          </div>

          <div style={{ maxHeight: 420, overflowY: "auto" }}>
            {count === 0 && (
              <div style={{ padding: 26, textAlign: "center", color: "var(--text3)", fontSize: 12 }}>
                <div style={{ fontSize: 24, opacity: 0.4, marginBottom: 6 }}>🔕</div>
                No pending requests.
              </div>
            )}
            {all.map(a => (
              <div key={`${a._kind}-${a.id}`} style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span style={{
                    fontSize: 9, fontWeight: 800, padding: "2px 7px", borderRadius: 5,
                    background: kindStyles(a._kind).bg,
                    color: kindStyles(a._kind).color,
                    border: `1px solid ${kindStyles(a._kind).border}`,
                    textTransform: "uppercase", letterSpacing: 1,
                  }}>{kindLabel(a._kind)}</span>
                  <span style={{ fontSize: 10, color: "var(--text3)", fontWeight: 600 }}>
                    {a.requested_by || a.staff_name || a.name || "—"}{a.branch_name ? ` · ${a.branch_name}` : ""}
                  </span>
                </div>

                {/* Discount approval */}
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

                {/* Leave request */}
                {a._kind === "leave" && (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
                      {a.staff_name || a.name || "Staff"} — {a.leave_type || a.type || "Leave"}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 2 }}>
                      {a.date || "—"}{a.days && a.days > 1 ? ` (${a.days} days)` : ""}
                    </div>
                    {a.reason && <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4, fontStyle: "italic" }}>&ldquo;{a.reason}&rdquo;</div>}
                  </>
                )}

                {/* Staff setup */}
                {a._kind === "staff_setup" && (
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
                    {a.name || "New Staff"} — needs salary & incentive setup
                    <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>Added by accountant · {a.role || "—"}</div>
                  </div>
                )}

                {/* Advance request */}
                {a._kind === "advance" && (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
                      {a.staff_name || "Staff"} — ₹{Number(a.amount || 0).toLocaleString("en-IN")} advance
                    </div>
                    {a.reason && <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4, fontStyle: "italic" }}>&ldquo;{a.reason}&rdquo;</div>}
                  </>
                )}

                {/* Action buttons — not for staff_setup (handled on staff page) */}
                {a._kind !== "staff_setup" && (
                  <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                    <button onClick={() => approveDoc(a._kind === "approval" ? "approvals" : a._kind === "leave" ? "leaves" : "staff_advances", a.id)}
                      style={{ flex: 1, padding: "6px 10px", background: "rgba(74,222,128,0.12)", border: "1px solid rgba(74,222,128,0.35)", color: "var(--green)", borderRadius: 6, fontSize: 10, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", cursor: "pointer" }}>
                      Approve
                    </button>
                    <button onClick={() => rejectDoc(a._kind === "approval" ? "approvals" : a._kind === "leave" ? "leaves" : "staff_advances", a.id)}
                      style={{ flex: 1, padding: "6px 10px", background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)", color: "var(--red)", borderRadius: 6, fontSize: 10, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", cursor: "pointer" }}>
                      Reject
                    </button>
                  </div>
                )}
                {a._kind === "staff_setup" && (
                  <div style={{ marginTop: 8, fontSize: 10, color: "var(--text3)", fontStyle: "italic" }}>
                    Go to Staff page → Pending Setup to configure
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
