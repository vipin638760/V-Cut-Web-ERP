"use client";
import { useState, useEffect } from "react";
import { collection, onSnapshot, query, orderBy, doc, deleteDoc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { INR } from "@/lib/calculations";
import { Modal, BranchSelect, useToast } from "@/components/ui";

// Per-staff, per-month attendance calendar. Shared by Staff Management and
// Payroll so both surfaces show the same day grid, per-branch worked-days
// summary, and (for admin/accountant) the day editor.
//
// **How to apply:** render once per page and drive with `target = { staff, month }`
// (or null to hide). Owns its own staff_attendance overlay subscription + edit
// state, so the host page only tracks which staff/month is open.
export default function AttendanceCalendarModal({ target, onClose, entries = [], leaves = [], branches = [], canEdit = false, currentUser = null }) {
  const { toast, ToastContainer } = useToast();
  const [attendanceOverrides, setAttendanceOverrides] = useState([]);
  const [editingDay, setEditingDay] = useState(null);
  const [dayDraft, setDayDraft] = useState({ present: true, branch_id: "", note: "" });

  // Overlay rows from staff_attendance for the open staff/month. Overlay wins
  // over entries-derived presence when both exist for a date.
  useEffect(() => {
    if (!db || !target) return;
    const { staff: s, month } = target;
    const [yr, mo] = month.split("-").map(Number);
    const start = `${month}-01`;
    const endDate = new Date(yr, mo, 0).toISOString().slice(0, 10);
    const q = query(collection(db, "staff_attendance"), orderBy("date", "asc"));
    const unsub = onSnapshot(q, sn => {
      const rows = sn.docs.map(d => ({ ...d.data(), id: d.id }))
        .filter(r => r.staff_id === s.id && r.date >= start && r.date <= endDate);
      setAttendanceOverrides(rows);
    });
    return () => unsub();
  }, [target]);

  const close = () => { onClose?.(); setAttendanceOverrides([]); setEditingDay(null); };

  return (
    <>
      {ToastContainer}
      <Modal isOpen={!!target} onClose={close} title={`Attendance · ${target?.staff?.name || ""}`} width={1080}>
        {target && (() => {
          const { staff: s, month } = target;
          const [yr, mo] = month.split("-").map(Number);
          const daysInMonth = new Date(yr, mo, 0).getDate();
          const firstDow = new Date(yr, mo - 1, 1).getDay();
          const todayStr = new Date().toISOString().slice(0, 10);
          const joinDate = s.join || null;
          const exitDate = s.exit_date || null;
          const monEntries = entries.filter(e => e.date && e.date.startsWith(month));
          const monLeaves = leaves.filter(l => l.staff_id === s.id && (l.date || "").startsWith(month) && (l.status === "approved" || !l.status));
          const overrideByDate = new Map(attendanceOverrides.map(o => [o.date, o]));

          const billingForDay = (dateStr) => {
            let total = 0;
            monEntries.forEach(e => {
              if (e.date !== dateStr) return;
              const sb = (e.staff_billing || []).find(x => x.staff_id === s.id);
              if (!sb) return;
              total += (Number(sb.billing) || 0) + (Number(sb.material) || 0);
            });
            return total;
          };

          const dayStatus = (dateStr) => {
            if (overrideByDate.has(dateStr)) {
              const o = overrideByDate.get(dateStr);
              return { kind: o.present ? "present" : "absent", branch_id: o.branch_id || null, note: o.note || "", source: "override" };
            }
            const leave = monLeaves.find(l => l.date === dateStr);
            if (leave) return { kind: "leave", branch_id: null, note: leave.type || "Leave", source: "leave", leaveType: leave.type || "Leave" };
            const hits = monEntries.filter(e => e.date === dateStr && (e.staff_billing || []).some(sb => sb.staff_id === s.id && sb.present !== false));
            if (hits.length > 0) return { kind: "present", branch_id: hits[0].branch_id, note: "", source: "entries" };
            if (joinDate && dateStr < joinDate) return { kind: "before", branch_id: null, note: "", source: "lifecycle" };
            if (exitDate && dateStr > exitDate) return { kind: "after", branch_id: null, note: "", source: "lifecycle" };
            return { kind: "absent", branch_id: null, note: "", source: "default" };
          };

          const compactINR = (n) => {
            const v = Number(n) || 0;
            if (v >= 10000000) return `₹${(v / 10000000).toFixed(1)}Cr`;
            if (v >= 100000) return `₹${(v / 100000).toFixed(1)}L`;
            if (v >= 1000) return `₹${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
            return `₹${v}`;
          };

          const markHoliday = async (dateStr) => {
            try {
              if (overrideByDate.has(dateStr)) await deleteDoc(doc(db, "staff_attendance", `${s.id}_${dateStr}`));
              await setDoc(doc(db, "leaves", `holiday_${s.id}_${dateStr}`), {
                staff_id: s.id, staff_name: s.name, date: dateStr, days: 1, type: "Holiday",
                reason: "Marked from staff calendar", status: "approved", processed: false,
                applied_by: currentUser?.id || "admin", applied_at: new Date().toISOString(),
                approved_by: currentUser?.name || "admin", approved_at: new Date().toISOString(), source: "staff_calendar",
              });
              toast({ title: "Marked Holiday", message: `${s.name} · ${dateStr}`, type: "success" });
              setEditingDay(null);
            } catch (err) { toast({ title: "Mark Failed", message: err.message, type: "error" }); }
          };

          const removeHoliday = async (dateStr) => {
            try {
              await deleteDoc(doc(db, "leaves", `holiday_${s.id}_${dateStr}`));
              toast({ title: "Holiday Removed", message: `${s.name} · ${dateStr}`, type: "success" });
              setEditingDay(null);
            } catch (err) { toast({ title: "Remove Failed", message: err.message, type: "error" }); }
          };

          const saveDay = async (dateStr, draft) => {
            try {
              await setDoc(doc(db, "staff_attendance", `${s.id}_${dateStr}`), {
                staff_id: s.id, staff_name: s.name, date: dateStr, present: !!draft.present,
                branch_id: draft.branch_id || null, branch_name: branches.find(b => b.id === draft.branch_id)?.name || null,
                note: draft.note || "", edited_by: currentUser?.id || "unknown",
                edited_by_name: currentUser?.name || "User", edited_at: new Date().toISOString(),
              });
              toast({ title: "Attendance Saved", message: `${s.name} · ${dateStr} · ${draft.present ? "Present" : "Absent"}`, type: "success" });
              setEditingDay(null);
            } catch (err) { toast({ title: "Save Failed", message: err.message, type: "error" }); }
          };

          const clearOverride = async (dateStr) => {
            try {
              await deleteDoc(doc(db, "staff_attendance", `${s.id}_${dateStr}`));
              toast({ title: "Override Cleared", message: `${dateStr} reverted to computed attendance.`, type: "success" });
              setEditingDay(null);
            } catch (err) { toast({ title: "Clear Failed", message: err.message, type: "error" }); }
          };

          const colorFor = (kind) => ({
            present: { bg: "rgba(74,222,128,0.15)", border: "rgba(74,222,128,0.5)", text: "#4ade80" },
            absent:  { bg: "rgba(248,113,113,0.12)", border: "rgba(248,113,113,0.35)", text: "#f87171" },
            leave:   { bg: "rgba(96,165,250,0.15)", border: "rgba(96,165,250,0.45)", text: "#60a5fa" },
            future:  { bg: "transparent", border: "var(--border)", text: "var(--text3)" },
            before:  { bg: "var(--bg4)", border: "var(--border)", text: "var(--text3)" },
            after:   { bg: "var(--bg4)", border: "var(--border)", text: "var(--text3)" },
          }[kind] || { bg: "transparent", border: "var(--border)", text: "var(--text3)" });

          const short = (bid) => (branches.find(b => b.id === bid)?.name || "").replace("V-CUT ", "").slice(0, 8);
          const blanks = Array(firstDow).fill(null);
          const days = Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);

          const nowDate = new Date();
          const isCurrentMonthView = nowDate.getFullYear() === yr && nowDate.getMonth() + 1 === mo;
          const cutoff = isCurrentMonthView ? new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - 1).toISOString().slice(0, 10) : null;
          let presentCount = 0, leaveCount = 0, absentCount = 0, zeroSaleCount = 0, totalBilling = 0;
          const branchTally = new Map();
          const zeroSaleDays = [];
          days.forEach(dateStr => {
            if (cutoff && dateStr > cutoff) return;
            const st = dayStatus(dateStr);
            const billing = billingForDay(dateStr);
            if (st.kind === "present") {
              presentCount++;
              totalBilling += billing;
              if (st.branch_id) {
                const cur = branchTally.get(st.branch_id) || { days: 0, billing: 0 };
                branchTally.set(st.branch_id, { days: cur.days + 1, billing: cur.billing + billing });
              }
              if (billing === 0) { zeroSaleCount++; zeroSaleDays.push(dateStr); }
            } else if (st.kind === "leave") leaveCount++;
            else if (st.kind === "absent") absentCount++;
          });
          const swatchPalette = ["#22d3ee", "#a78bfa", "#fb923c", "#4ade80", "#f472b6", "#60a5fa", "#fde047", "#f87171"];
          const branchColour = new Map();
          [...branchTally.keys()].forEach((bid, i) => branchColour.set(bid, swatchPalette[i % swatchPalette.length]));

          return (
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: 18, alignItems: "start" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 11, fontWeight: 700 }}>
                  <span style={{ padding: "6px 10px", borderRadius: 8, background: "rgba(74,222,128,0.12)", color: "var(--green)" }}>● Present {presentCount}</span>
                  <span style={{ padding: "6px 10px", borderRadius: 8, background: "rgba(96,165,250,0.12)", color: "var(--blue, #60a5fa)" }}>● Leave {leaveCount}</span>
                  <span style={{ padding: "6px 10px", borderRadius: 8, background: "rgba(248,113,113,0.1)", color: "var(--red)" }}>● Absent {absentCount}</span>
                  {zeroSaleCount > 0 && (
                    <span title={`Days present with ₹0 billing: ${zeroSaleDays.join(", ")}`}
                      style={{ padding: "6px 10px", borderRadius: 8, background: "rgba(250,204,21,0.15)", color: "#facc15", border: "1px solid rgba(250,204,21,0.4)" }}>⚠ Zero-Sale {zeroSaleCount}</span>
                  )}
                  <span style={{ padding: "6px 10px", borderRadius: 8, background: "rgba(255,215,0,0.10)", color: "var(--gold)" }}>Total Billing {INR(totalBilling)}</span>
                  <span style={{ marginLeft: "auto", padding: "6px 10px", borderRadius: 8, background: "var(--bg4)", color: "var(--text3)" }}>Home: {(branches.find(b => b.id === s.branch_id)?.name || "—").replace("V-CUT ", "")}</span>
                </div>

                {/* Per-branch worked-days + billing summary. */}
                {branchTally.size > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "8px 0", borderTop: "1px dashed var(--border)", borderBottom: "1px dashed var(--border)" }}>
                    <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5 }}>Worked at {branchTally.size} branch{branchTally.size === 1 ? "" : "es"}:</div>
                    {[...branchTally.entries()].sort((a, b) => b[1].billing - a[1].billing).map(([bid, info]) => {
                      const bName = (branches.find(b => b.id === bid)?.name || "Branch").replace("V-CUT ", "");
                      const isHome = bid === s.branch_id;
                      return (
                        <span key={bid} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 999, background: "var(--bg3)", border: `1px solid ${branchColour.get(bid)}`, color: "var(--text)", fontSize: 11, fontWeight: 700 }}>
                          <span style={{ width: 8, height: 8, borderRadius: "50%", background: branchColour.get(bid) }} />
                          {bName} · {info.days}d · {INR(info.billing)}
                          {isHome && <span style={{ fontSize: 9, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>home</span>}
                        </span>
                      );
                    })}
                  </div>
                )}

                <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6, fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.2, textAlign: "center" }}>
                  {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => <div key={d}>{d}</div>)}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
                  {blanks.map((_, i) => <div key={`b${i}`} />)}
                  {days.map(dateStr => {
                    const st = dayStatus(dateStr);
                    const isFuture = dateStr > todayStr;
                    const isBeforeJoin = st.kind === "before";
                    const isAfterExit = st.kind === "after";
                    const isJoinDay = joinDate && dateStr === joinDate;
                    const isInactive = isFuture && st.kind === "absent" || isBeforeJoin || isAfterExit;
                    const effectiveKind = isInactive ? (isBeforeJoin ? "before" : isAfterExit ? "after" : "future") : st.kind;
                    const c = colorFor(effectiveKind);
                    const isToday = dateStr === todayStr;
                    const bName = st.branch_id ? short(st.branch_id) : "";
                    const hasOverride = st.source === "override";
                    const isHoliday = st.kind === "leave" && (st.leaveType || "").toLowerCase() === "holiday";
                    const branchDot = st.kind === "present" && st.branch_id ? branchColour.get(st.branch_id) : null;
                    const billing = billingForDay(dateStr);
                    const isZeroSale = st.kind === "present" && billing === 0 && !isFuture;
                    return (
                      <button key={dateStr}
                        disabled={!canEdit || isInactive}
                        onClick={() => { if (isInactive) return; setEditingDay(dateStr); setDayDraft({ present: st.kind === "present", branch_id: st.branch_id || s.branch_id || "", note: st.note || "" }); }}
                        title={isZeroSale ? `Present at ${bName || "branch"} but ₹0 sale — consider marking as Holiday` : st.kind === "present" ? `${bName || "Branch"} · ${INR(billing)}` : isHoliday ? "Holiday" : undefined}
                        style={{ position: "relative", aspectRatio: "1 / 1", padding: 6, borderRadius: 10, background: isInactive ? "transparent" : c.bg, border: isToday ? "2px solid var(--accent)" : isJoinDay ? "2px solid var(--green)" : isZeroSale ? "2px dashed #facc15" : branchDot ? `2px solid ${branchDot}` : `1px solid ${c.border}`, color: isInactive ? "var(--text3)" : c.text, cursor: isInactive ? "default" : canEdit ? "pointer" : "default", opacity: isBeforeJoin || isAfterExit ? 0.25 : isFuture && st.kind === "absent" ? 0.35 : 1, display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "space-between", fontFamily: "var(--font-headline, var(--font-outfit))" }}>
                        <div style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center", fontSize: 12, fontWeight: 800 }}>
                          <span>{Number(dateStr.slice(8, 10))}</span>
                          <div style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                            {isZeroSale && <span title="Zero sale on a present day" style={{ fontSize: 10, color: "#facc15", lineHeight: 1 }}>⚠</span>}
                            {hasOverride && <span title="Manually edited" style={{ fontSize: 8, color: "var(--accent)" }}>✎</span>}
                          </div>
                        </div>
                        {isJoinDay && <div style={{ fontSize: 8, fontWeight: 800, color: "#4ade80", textTransform: "uppercase", letterSpacing: 0.5 }}>JOINED</div>}
                        {bName && !isInactive && <div style={{ fontSize: 9, fontWeight: 800, color: branchDot || c.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>{bName}</div>}
                        {st.kind === "present" && billing > 0 && <div style={{ fontSize: 9, fontWeight: 800, color: "var(--gold)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>{compactINR(billing)}</div>}
                        {isZeroSale && <div style={{ fontSize: 8, fontWeight: 800, color: "#facc15", textTransform: "uppercase", letterSpacing: 0.5 }}>0 SALE</div>}
                        {st.kind === "leave" && <div style={{ fontSize: 9, fontWeight: 800, color: "#60a5fa", textTransform: "uppercase", letterSpacing: 0.5 }}>{isHoliday ? "HOLIDAY" : "LEAVE"}</div>}
                        {st.kind === "absent" && !isFuture && !isBeforeJoin && !isAfterExit && st.source === "default" && <div style={{ fontSize: 9, fontWeight: 700, opacity: 0.75 }}>—</div>}
                      </button>
                    );
                  })}
                </div>

                <div style={{ fontSize: 10, color: "var(--text3)", lineHeight: 1.5 }}>
                  Source priority: <strong>Manual override</strong> › Approved leave › Daily entries › Join/exit lifecycle.
                  {!canEdit && <> You have read-only access.</>}
                </div>
              </div>

              <aside style={{ position: "sticky", top: 0, alignSelf: "start", display: "flex", flexDirection: "column", gap: 12 }}>
                {(() => {
                  if (!editingDay) {
                    return (
                      <div style={{ padding: "22px 24px", borderRadius: 16, background: "var(--bg3)", border: "1px solid rgba(34,211,238,0.18)", boxShadow: "0 0 18px rgba(34,211,238,0.08), 0 0 1px rgba(34,211,238,0.25) inset", textAlign: "center" }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 10 }}>Day Details</div>
                        <div style={{ fontSize: 13, color: "var(--text2)", lineHeight: 1.6 }}>Click any day on the calendar to view billing breakdown{canEdit ? " and edit attendance" : ""}.</div>
                      </div>
                    );
                  }
                  const st = dayStatus(editingDay);
                  const hasOverride = st.source === "override";
                  const dayBilling = billingForDay(editingDay);
                  const isHoliday = st.kind === "leave" && (st.leaveType || "").toLowerCase() === "holiday";
                  const isZeroSale = st.kind === "present" && dayBilling === 0;
                  const dispBranchId = st.branch_id || dayDraft.branch_id;
                  const dispBranch = (branches.find(b => b.id === dispBranchId)?.name || "").replace("V-CUT ", "");
                  const dotColour = dispBranchId ? branchColour.get(dispBranchId) : null;
                  const kindLabel = st.kind === "present" ? "Present" : st.kind === "leave" ? (isHoliday ? "Holiday" : "Leave") : st.kind === "absent" ? "Absent" : st.kind;
                  const kindColour = st.kind === "present" ? "var(--green)" : st.kind === "leave" ? "#60a5fa" : st.kind === "absent" ? "var(--red)" : "var(--text3)";
                  const kindRgb = st.kind === "present" ? "74,222,128" : st.kind === "leave" ? "96,165,250" : st.kind === "absent" ? "248,113,113" : "163,163,163";
                  const longDate = new Date(editingDay).toLocaleDateString("default", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
                  return (
                    <div style={{ padding: "18px 20px", borderRadius: 16, background: "var(--bg3)", border: `1px solid rgba(${kindRgb},0.35)`, boxShadow: `0 0 20px rgba(${kindRgb},0.18), 0 0 1px rgba(${kindRgb},0.45) inset`, display: "flex", flexDirection: "column", gap: 14, position: "relative", overflow: "hidden" }}>
                      <div style={{ position: "absolute", top: -20, right: -20, width: 90, height: 90, background: kindColour, opacity: 0.05, borderRadius: "50%", filter: "blur(22px)" }} />
                      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5 }}>{longDate}</div>
                          <div style={{ fontSize: 14, fontWeight: 800, color: kindColour, textTransform: "uppercase", letterSpacing: 1, marginTop: 4 }}>{kindLabel}</div>
                        </div>
                        <button type="button" onClick={() => setEditingDay(null)} style={{ background: "transparent", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 4 }}>✕</button>
                      </div>
                      {st.kind === "present" && (
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 4 }}>Daily Sale</div>
                          <div style={{ fontSize: 26, fontWeight: 800, color: "var(--gold)", lineHeight: 1.1, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(dayBilling)}</div>
                          <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>Service + Material</div>
                        </div>
                      )}
                      {dispBranchId && (
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6 }}>Branch</div>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 12px", borderRadius: 999, background: "var(--bg4)", border: `1px solid ${dotColour || "var(--border2)"}`, color: "var(--text)", fontSize: 12, fontWeight: 700 }}>
                            {dotColour && <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColour }} />}
                            {dispBranch || "—"}
                            {dispBranchId === s.branch_id && <span style={{ fontSize: 9, color: "var(--text3)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>home</span>}
                          </span>
                        </div>
                      )}
                      {isZeroSale && !isHoliday && (
                        <div style={{ padding: "10px 12px", borderRadius: 10, background: "rgba(250,204,21,0.12)", border: "1px solid rgba(250,204,21,0.35)", color: "#facc15", fontSize: 11, fontWeight: 700, lineHeight: 1.5 }}>
                          ⚠ Staff was present but billed ₹0. You can mark this as a paid Holiday.
                        </div>
                      )}
                      {st.note && (
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 4 }}>Note</div>
                          <div style={{ fontSize: 12, color: "var(--text2)", padding: "8px 10px", background: "var(--bg4)", borderRadius: 8, border: "1px solid var(--border2)" }}>{st.note}</div>
                        </div>
                      )}
                      {canEdit && (
                        <>
                          <div style={{ height: 1, background: "var(--border)", margin: "2px 0" }} />
                          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5 }}>Update Attendance</div>
                            <div style={{ display: "inline-flex", borderRadius: 8, overflow: "hidden", border: "1px solid var(--border2)", width: "fit-content" }}>
                              {[["present", true, "Present"], ["absent", false, "Absent"]].map(([k, v, lbl]) => (
                                <button key={k} type="button" onClick={() => setDayDraft(d => ({ ...d, present: v }))}
                                  style={{ padding: "8px 14px", background: dayDraft.present === v ? (v ? "var(--green)" : "var(--red)") : "var(--bg3)", color: dayDraft.present === v ? "#000" : "var(--text2)", border: "none", fontSize: 11, fontWeight: 800, cursor: "pointer", textTransform: "uppercase", letterSpacing: 1 }}>{lbl}</button>
                              ))}
                            </div>
                            {dayDraft.present && (
                              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Worked at</label>
                                <BranchSelect value={dayDraft.branch_id || ""} onChange={(v) => setDayDraft(d => ({ ...d, branch_id: v }))} branches={branches} placeholder="—" minWidth={0} />
                              </div>
                            )}
                            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                              <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Note (optional)</label>
                              <input value={dayDraft.note} onChange={e => setDayDraft(d => ({ ...d, note: e.target.value }))} placeholder="Reason / context"
                                style={{ padding: "8px 10px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, outline: "none" }} />
                            </div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                              <button type="button" onClick={() => saveDay(editingDay, dayDraft)} style={{ flex: 1, minWidth: 100, padding: "10px", borderRadius: 10, background: "var(--accent)", color: "#000", border: "none", fontWeight: 800, cursor: "pointer" }}>Save</button>
                              {isHoliday ? (
                                <button type="button" onClick={() => removeHoliday(editingDay)} title="Remove holiday marking" style={{ flex: 1, minWidth: 100, padding: "10px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border)", fontWeight: 700, cursor: "pointer" }}>Remove Holiday</button>
                              ) : (
                                <button type="button" onClick={() => markHoliday(editingDay)} title="Mark this day as a paid holiday for this staff" style={{ flex: 1, minWidth: 100, padding: "10px", borderRadius: 10, background: "rgba(96,165,250,0.18)", color: "#60a5fa", border: "1px solid rgba(96,165,250,0.5)", fontWeight: 800, cursor: "pointer" }}>Mark Holiday</button>
                              )}
                            </div>
                            {hasOverride && (
                              <button type="button" onClick={() => clearOverride(editingDay)} title="Revert to computed attendance" style={{ padding: "8px 10px", borderRadius: 8, background: "transparent", color: "var(--text3)", border: "1px dashed var(--border)", fontWeight: 600, fontSize: 11, cursor: "pointer" }}>Clear Manual Override</button>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })()}
              </aside>
            </div>
          );
        })()}
      </Modal>
    </>
  );
}
