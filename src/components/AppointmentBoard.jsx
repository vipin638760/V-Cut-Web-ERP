"use client";
import { useMemo, useState } from "react";
import { INR } from "@/lib/calculations";
import { generateSlots, findAppointment, toMinutes, addMinutes, SLOT_INTERVAL_MIN } from "@/lib/appointments";
import { Icon } from "./ui";

/**
 * Appointment grid. Rows = 30-min slots (09:00–21:00), columns = staff active
 * at the branch on the selected date. Click a free slot to open the booking
 * modal (passed in via onBookSlot). Click an appointment to open details.
 *
 * Props:
 *   staffList: [{ id, name, role }]
 *   appointments: [{ id, staff_id, start, end, customer_name, services, status }]
 *   date: YYYY-MM-DD
 *   onBookSlot({ staff_id, start }): parent opens the booking modal
 *   onOpenAppointment(apt): parent handles click on an existing booking
 *   openHour, closeHour
 */
export default function AppointmentBoard({ staffList = [], appointments = [], date, onBookSlot, onOpenAppointment, openHour = 9, closeHour = 21 }) {
  const slots = useMemo(() => generateSlots(openHour, closeHour), [openHour, closeHour]);
  const [hovering, setHovering] = useState(null); // "staffId__slot"

  if (staffList.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "var(--text3)", background: "var(--bg3)", borderRadius: 14, border: "1px dashed var(--border2)" }}>
        <div style={{ fontSize: 28, opacity: 0.4, marginBottom: 6 }}>📅</div>
        <div style={{ fontSize: 13, fontWeight: 700 }}>No staff available at this branch for {date}.</div>
        <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4 }}>Pick another date or add staff in Staff Management.</div>
      </div>
    );
  }

  const statusColor = (status) => {
    if (status === "completed") return { bg: "rgba(74,222,128,0.15)", border: "rgba(74,222,128,0.4)", text: "var(--green)" };
    if (status === "in_progress") return { bg: "rgba(251,146,60,0.15)", border: "rgba(251,146,60,0.4)", text: "var(--orange)" };
    if (status === "cancelled") return { bg: "rgba(148,163,184,0.1)", border: "rgba(148,163,184,0.3)", text: "var(--text3)" };
    return { bg: "rgba(var(--accent-rgb),0.15)", border: "rgba(var(--accent-rgb),0.4)", text: "var(--accent)" };
  };

  return (
    <div style={{ background: "var(--bg2)", borderRadius: 14, border: "1px solid var(--border)", overflow: "hidden" }}>
      <div style={{ overflowX: "auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: `80px repeat(${staffList.length}, minmax(140px, 1fr))`, minWidth: 80 + staffList.length * 140 }}>
          {/* Header row */}
          <div style={{ padding: "12px 10px", background: "var(--bg3)", borderBottom: "1px solid var(--border)", borderRight: "1px solid var(--border)", fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, textAlign: "center" }}>
            Time
          </div>
          {staffList.map(s => (
            <div key={s.id} style={{ padding: "12px 10px", background: "var(--bg3)", borderBottom: "1px solid var(--border)", borderRight: "1px solid var(--border)" }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "var(--text)" }}>{s.name}</div>
              {s.role && <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 600, marginTop: 2 }}>{s.role}</div>}
            </div>
          ))}

          {/* Slot rows */}
          {slots.map(slot => {
            const nextSlot = addMinutes(slot, SLOT_INTERVAL_MIN);
            const isHourBoundary = slot.endsWith(":00");
            return (
              <div key={slot} style={{ display: "contents" }}>
                <div style={{ padding: "8px 10px", background: isHourBoundary ? "var(--bg3)" : "var(--bg2)", borderBottom: "1px solid var(--border)", borderRight: "1px solid var(--border)", fontSize: 11, fontWeight: isHourBoundary ? 800 : 600, color: isHourBoundary ? "var(--text)" : "var(--text3)", textAlign: "center" }}>
                  {slot}
                </div>
                {staffList.map(s => {
                  const apt = findAppointment(appointments, s.id, slot, nextSlot);
                  const isStartSlot = apt && apt.start === slot;
                  const isContinuation = apt && apt.start !== slot;
                  const hovKey = `${s.id}__${slot}`;
                  const isHovering = hovering === hovKey;
                  if (isContinuation) {
                    return <div key={hovKey} style={{ borderBottom: "1px solid var(--border)", borderRight: "1px solid var(--border)", background: "transparent" }} />;
                  }
                  if (apt && isStartSlot) {
                    const c = statusColor(apt.status);
                    const spans = Math.max(1, Math.round((toMinutes(apt.end) - toMinutes(apt.start)) / SLOT_INTERVAL_MIN));
                    return (
                      <button key={hovKey} onClick={() => onOpenAppointment?.(apt)}
                        style={{
                          gridRow: `span ${spans}`,
                          background: c.bg, border: `1px solid ${c.border}`, borderRight: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
                          padding: "6px 8px", textAlign: "left", cursor: "pointer",
                          display: "flex", flexDirection: "column", justifyContent: "space-between",
                          overflow: "hidden",
                        }}>
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 800, color: c.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {apt.customer_name || "Walk-in"}
                          </div>
                          <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 600, marginTop: 2 }}>
                            {apt.start}–{apt.end}
                          </div>
                        </div>
                        {apt.services?.length > 0 && (
                          <div style={{ fontSize: 9, color: "var(--text2)", fontWeight: 600, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {apt.services.map(sv => sv.name).join(", ")}
                          </div>
                        )}
                      </button>
                    );
                  }
                  return (
                    <button key={hovKey}
                      onClick={() => onBookSlot?.({ staff_id: s.id, staff_name: s.name, start: slot })}
                      onMouseEnter={() => setHovering(hovKey)}
                      onMouseLeave={() => setHovering(prev => prev === hovKey ? null : prev)}
                      style={{
                        border: "none", borderRight: "1px solid var(--border)", borderBottom: "1px solid var(--border)",
                        background: isHovering ? "rgba(var(--accent-rgb),0.08)" : "transparent",
                        padding: 6, cursor: "pointer",
                        minHeight: 44,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        color: isHovering ? "var(--accent)" : "transparent", transition: "all .15s",
                      }}>
                      {isHovering && (
                        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase" }}>+ Book</span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ padding: "10px 14px", display: "flex", gap: 14, flexWrap: "wrap", background: "var(--bg3)", borderTop: "1px solid var(--border)" }}>
        <LegendDot color="var(--accent)" label="Booked" />
        <LegendDot color="var(--orange)" label="In progress" />
        <LegendDot color="var(--green)" label="Completed" />
        <LegendDot color="var(--text3)" label="Cancelled" />
      </div>
    </div>
  );
}

function LegendDot({ color, label }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, background: color }} />
      <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text2)" }}>{label}</span>
    </span>
  );
}
