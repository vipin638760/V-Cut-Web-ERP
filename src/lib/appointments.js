/**
 * Appointment helpers.
 * Appointment doc (appointments collection):
 *   branch_id, date ("YYYY-MM-DD"), start ("HH:MM"), end ("HH:MM")
 *   staff_id, staff_name
 *   customer_id, customer_name, customer_phone
 *   services: [{ menu_id, name, price, duration }]
 *   status: "booked" | "in_progress" | "completed" | "cancelled"
 *   notes, created_by, created_at
 */

export const DEFAULT_OPEN_HOUR = 9;
export const DEFAULT_CLOSE_HOUR = 21;
export const SLOT_INTERVAL_MIN = 30;

/** "09:00", "09:30", ... up to (closeHour:00). */
export function generateSlots(openHour = DEFAULT_OPEN_HOUR, closeHour = DEFAULT_CLOSE_HOUR, intervalMin = SLOT_INTERVAL_MIN) {
  const slots = [];
  for (let h = openHour; h < closeHour; h++) {
    for (let m = 0; m < 60; m += intervalMin) {
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return slots;
}

/** "HH:MM" → minutes since midnight. */
export const toMinutes = (hhmm) => {
  const [h, m] = (hhmm || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** minutes → "HH:MM". */
export const toHHMM = (mins) => {
  const m = ((mins % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** Add minutes to "HH:MM". */
export const addMinutes = (hhmm, minutes) => toHHMM(toMinutes(hhmm) + (Number(minutes) || 0));

/** Do the two half-open intervals overlap? */
export function overlaps(startA, endA, startB, endB) {
  return toMinutes(startA) < toMinutes(endB) && toMinutes(startB) < toMinutes(endA);
}

/** Is slot booked for this staff on this date? Returns the appointment or null. */
export function findAppointment(appointments, staffId, slotStart, slotEnd) {
  return appointments.find(a =>
    a.staff_id === staffId &&
    overlaps(a.start, a.end, slotStart, slotEnd) &&
    a.status !== "cancelled"
  ) || null;
}
