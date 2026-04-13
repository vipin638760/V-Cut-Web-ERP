"use client";
import { useEffect, useState, useMemo } from "react";
import { collection, onSnapshot, query, orderBy } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { staffBillingInPeriod, staffIncentivesInPeriod, makeFilterPrefix, INR, MONTHS } from "@/lib/calculations";
import { Card, PeriodWidget, ProgressBar, Icon, Pill } from "@/components/ui";

const NOW = new Date();

// Circular ring progress component
function RingProgress({ pct, size = 200, stroke = 14, color = "var(--accent)", label, sublabel }) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = Math.min(pct / 100, 1) * circ;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--bg4)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={pct >= 100 ? "var(--green)" : color}
          strokeWidth={stroke}
          strokeDasharray={`${dash} ${circ}`}
          strokeLinecap="round"
          style={{ transition: "stroke-dasharray 0.9s cubic-bezier(0.34,1.56,0.64,1)", filter: `drop-shadow(0 0 6px ${pct >= 100 ? "var(--green)" : color})` }}
        />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
        <div style={{ fontSize: 36, fontWeight: 950, color: pct >= 100 ? "var(--green)" : "var(--text)", letterSpacing: -2, lineHeight: 1 }}>
          {Math.round(pct)}%
        </div>
        {label && <div style={{ fontSize: 11, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, marginTop: 6 }}>{label}</div>}
        {sublabel && <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 600, marginTop: 2 }}>{sublabel}</div>}
      </div>
    </div>
  );
}

// Mini metric tile
function MetricTile({ label, value, icon, color = "var(--accent)", sub }) {
  return (
    <div style={{ background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 16, padding: "20px 22px", display: "flex", flexDirection: "column", gap: 10, position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: -12, right: -12, width: 60, height: 60, background: color, filter: "blur(30px)", opacity: 0.12, borderRadius: "50%" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ color, opacity: 0.9 }}><Icon name={icon} size={15} /></div>
        <span style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5 }}>{label}</span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 950, color: "var(--text)", letterSpacing: -0.5, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>{sub}</div>}
    </div>
  );
}

export default function MyTargetPage() {
  const [currentUser, setCurrentUser] = useState(null);
  const [staffData, setStaffData]     = useState(null);
  const [entries, setEntries]         = useState([]);
  const [loading, setLoading]         = useState(true);

  const [filterYear, setFilterYear]   = useState(NOW.getFullYear());
  const [filterMonth, setFilterMonth] = useState(NOW.getMonth() + 1);
  const filterPrefix = makeFilterPrefix(filterYear, filterMonth);

  // Load user
  useEffect(() => {
    const saved = localStorage.getItem("vcut_user");
    if (saved) setCurrentUser(JSON.parse(saved));
  }, []);

  // Load firebase data
  useEffect(() => {
    if (!db || !currentUser?.staff_id) { setLoading(false); return; }
    const unsubs = [
      onSnapshot(collection(db, "staff"), sn => {
        const s = sn.docs.map(d => ({ ...d.data(), id: d.id })).find(x => x.id === currentUser.staff_id);
        setStaffData(s || null);
      }),
      onSnapshot(query(collection(db, "entries"), orderBy("date", "desc")), sn => {
        setEntries(sn.docs.map(d => ({ ...d.data(), id: d.id })));
        setLoading(false);
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, [currentUser]);

  // Computed values
  const target    = staffData?.target || 50000;
  const incPct    = staffData?.incentive_pct || 10;
  const billing   = staffBillingInPeriod(currentUser?.staff_id, entries, filterPrefix, "month", filterYear);
  const incentive = staffIncentivesInPeriod(currentUser?.staff_id, entries, filterPrefix, "month", filterYear);
  const pct       = target > 0 ? (billing / target) * 100 : 0;
  const remaining = Math.max(0, target - billing);

  // Days math (only relevant for current month view)
  const isCurrentMonth = filterYear === NOW.getFullYear() && filterMonth === NOW.getMonth() + 1;
  const daysInMonth  = new Date(filterYear, filterMonth, 0).getDate();
  const daysPassed   = isCurrentMonth ? NOW.getDate() : daysInMonth;
  const daysLeft     = isCurrentMonth ? daysInMonth - NOW.getDate() : 0;
  const dailyAvg     = daysPassed > 0 ? billing / daysPassed : 0;
  const projected    = dailyAvg * daysInMonth;
  const dailyNeeded  = daysLeft > 0 ? remaining / daysLeft : 0;

  // Daily breakdown for this month
  const dailyData = useMemo(() => {
    const sid = currentUser?.staff_id;
    if (!sid) return [];
    const prefix = filterPrefix;
    const relevant = entries.filter(e => e.date && e.date.startsWith(prefix));
    const map = {};
    relevant.forEach(e => {
      const sb = (e.staff_billing || []).find(x => x.staff_id === sid);
      if (sb) {
        map[e.date] = (map[e.date] || 0) + (sb.billing || 0);
      }
    });
    return Object.entries(map)
      .map(([date, amount]) => ({ date, amount }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [entries, currentUser, filterPrefix]);

  // Last 6 months performance
  const monthHistory = useMemo(() => {
    const sid = currentUser?.staff_id;
    if (!sid) return [];
    const res = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(filterYear, filterMonth - 1 - i, 1);
      const yr = d.getFullYear();
      const mo = d.getMonth() + 1;
      const pfx = makeFilterPrefix(yr, mo);
      const b = staffBillingInPeriod(sid, entries, pfx, "month", yr);
      res.push({ label: MONTHS[mo - 1] + " " + yr, billing: b, target: staffData?.target || 50000, yr, mo });
    }
    return res;
  }, [entries, currentUser, staffData, filterYear, filterMonth]);

  const maxHistBilling = Math.max(...monthHistory.map(m => m.billing), 1);

  if (!currentUser?.staff_id) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh", gap: 16, textAlign: "center" }}>
        <div style={{ fontSize: 40, opacity: 0.3 }}><Icon name="users" size={40} /></div>
        <h2 style={{ fontSize: 20, fontWeight: 900, color: "var(--text3)" }}>No Staff Profile Linked</h2>
        <p style={{ fontSize: 13, color: "var(--text3)", maxWidth: 360, lineHeight: 1.6 }}>Your account is not linked to a staff record. Contact your admin.</p>
      </div>
    );
  }

  if (loading) {
    return <div style={{ textAlign: "center", color: "var(--accent)", padding: 60, fontWeight: 900, fontSize: 13, textTransform: "uppercase", letterSpacing: 2 }}>Loading Target Data...</div>;
  }

  const statusColor  = pct >= 100 ? "var(--green)" : pct >= 75 ? "var(--accent)" : pct >= 40 ? "var(--orange)" : "var(--red)";
  const statusLabel  = pct >= 100 ? "TARGET CRUSHED" : pct >= 75 ? "ON TRACK" : pct >= 40 ? "BEHIND PACE" : "NEEDS PUSH";
  const statusPillC  = pct >= 100 ? "green" : pct >= 75 ? "gold" : pct >= 40 ? "orange" : "red";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 2, marginBottom: 8 }}>Personal Performance</div>
          <h1 style={{ fontSize: 32, fontWeight: 950, color: "var(--text)", letterSpacing: -1, margin: 0 }}>My Target</h1>
          {staffData?.name && <p style={{ fontSize: 13, color: "var(--text3)", fontWeight: 600, marginTop: 4 }}>{staffData.name} · {staffData.role || "Stylist"}</p>}
        </div>
        <Pill label={statusLabel} color={statusPillC} />
      </div>

      {/* Period Widget */}
      <PeriodWidget
        filterMode="month" setFilterMode={() => {}}
        filterYear={filterYear} setFilterYear={setFilterYear}
        filterMonth={filterMonth} setFilterMonth={setFilterMonth}
        monthlyOnly
      />

      {/* Hero Section */}
      <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 24, padding: 32, display: "flex", gap: 40, alignItems: "center", flexWrap: "wrap", position: "relative", overflow: "hidden", boxShadow: "var(--card-shadow)" }}>
        {/* Ambient glow */}
        <div style={{ position: "absolute", top: -60, right: -60, width: 300, height: 300, background: statusColor, filter: "blur(100px)", opacity: 0.05, borderRadius: "50%", pointerEvents: "none" }} />

        <RingProgress
          pct={pct}
          size={200}
          stroke={16}
          color={statusColor}
          label="of target"
          sublabel={`${INR(billing)} earned`}
        />

        <div style={{ flex: 1, minWidth: 240, display: "flex", flexDirection: "column", gap: 20 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6 }}>Monthly Target</div>
            <div style={{ fontSize: 42, fontWeight: 950, color: "var(--text)", letterSpacing: -2, lineHeight: 1 }}>{INR(target)}</div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={{ padding: "12px 16px", background: "rgba(255,255,255,0.03)", borderRadius: 12, border: "1px solid var(--border)" }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Earned</div>
              <div style={{ fontSize: 18, fontWeight: 950, color: "var(--green)" }}>{INR(billing)}</div>
            </div>
            <div style={{ padding: "12px 16px", background: "rgba(255,255,255,0.03)", borderRadius: 12, border: "1px solid var(--border)" }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Remaining</div>
              <div style={{ fontSize: 18, fontWeight: 950, color: remaining > 0 ? "var(--red)" : "var(--green)" }}>{remaining > 0 ? INR(remaining) : "Done!"}</div>
            </div>
          </div>

          <ProgressBar value={billing} max={target} color={pct >= 100 ? "green" : "accent"} size="lg" />
        </div>
      </div>

      {/* KPI Row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
        <MetricTile icon="wallet" label="Incentive Earned" value={INR(incentive)} color="var(--green)" sub={`${incPct}% rate · ${billing > 0 ? Math.round(incentive / billing * 100) : 0}% of billing`} />
        {isCurrentMonth && (
          <>
            <MetricTile icon="trending" label="Daily Avg" value={INR(Math.round(dailyAvg))} color="var(--accent)" sub={`Over ${daysPassed} days worked`} />
            <MetricTile icon="clock" label="Daily Target Needed" value={daysLeft > 0 ? INR(Math.round(dailyNeeded)) : "Done!"} color={dailyNeeded > dailyAvg ? "var(--red)" : "var(--green)"} sub={`${daysLeft} days left`} />
            <MetricTile icon="pie" label="Projected Month Total" value={INR(Math.round(projected))} color={projected >= target ? "var(--green)" : "var(--orange)"} sub={projected >= target ? "On track to hit target" : `${INR(Math.round(target - projected))} short of target`} />
          </>
        )}
        {!isCurrentMonth && (
          <MetricTile icon="pie" label="Final Achievement" value={`${Math.round(pct)}%`} color={pct >= 100 ? "var(--green)" : "var(--orange)"} sub={pct >= 100 ? "Target achieved!" : `${INR(remaining)} below target`} />
        )}
      </div>

      {/* Daily Breakdown */}
      {dailyData.length > 0 && (
        <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 24, padding: 28, boxShadow: "var(--card-shadow)" }}>
          <div style={{ fontSize: 13, fontWeight: 900, color: "var(--text)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 24 }}>Daily Breakdown</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {dailyData.map(({ date, amount }) => {
              const dayMax = Math.max(...dailyData.map(d => d.amount), 1);
              const barPct = (amount / dayMax) * 100;
              const dayLabel = new Date(date + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric" });
              return (
                <div key={date} style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", width: 60, flexShrink: 0, textAlign: "right" }}>{dayLabel}</div>
                  <div style={{ flex: 1, height: 28, background: "var(--bg4)", borderRadius: 8, overflow: "hidden", position: "relative" }}>
                    <div style={{ height: "100%", width: `${barPct}%`, background: `linear-gradient(90deg, var(--accent), var(--gold2))`, borderRadius: 8, transition: "width 0.6s cubic-bezier(0.34,1.56,0.64,1)", boxShadow: "0 0 8px rgba(34,211,238,0.3)" }} />
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 800, color: "var(--text)", width: 80, flexShrink: 0 }}>{INR(amount)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Monthly History */}
      <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 24, padding: 28, boxShadow: "var(--card-shadow)" }}>
        <div style={{ fontSize: 13, fontWeight: 900, color: "var(--text)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 24 }}>6-Month Performance History</div>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", height: 120 }}>
          {monthHistory.map((m, i) => {
            const barH   = maxHistBilling > 0 ? (m.billing / maxHistBilling) * 100 : 0;
            const isSelected = m.yr === filterYear && m.mo === filterMonth;
            const hit = m.billing >= m.target;
            return (
              <div
                key={i}
                onClick={() => { setFilterYear(m.yr); setFilterMonth(m.mo); }}
                style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, cursor: "pointer" }}
                title={`${m.label}: ${INR(m.billing)}`}
              >
                <div style={{ fontSize: 10, fontWeight: 800, color: isSelected ? "var(--accent)" : "var(--text3)" }}>{INR(m.billing)}</div>
                <div style={{ width: "100%", height: 80, display: "flex", alignItems: "flex-end" }}>
                  <div style={{ width: "100%", height: `${barH}%`, minHeight: 4, background: hit ? "var(--green)" : isSelected ? "var(--accent)" : "var(--bg4)", borderRadius: "6px 6px 0 0", transition: "all 0.4s", border: isSelected ? "1px solid var(--accent)" : "none", boxShadow: hit ? "0 0 10px rgba(74,222,128,0.3)" : isSelected ? "0 0 10px rgba(34,211,238,0.3)" : "none" }} />
                </div>
                <div style={{ fontSize: 10, fontWeight: 700, color: isSelected ? "var(--accent)" : "var(--text3)", textTransform: "uppercase" }}>{m.label.slice(0, 3)}</div>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 16, fontSize: 10, fontWeight: 700, color: "var(--text3)" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: "var(--green)", display: "inline-block" }} />Target Hit</span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: "var(--accent)", display: "inline-block" }} />Selected Month</span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: "var(--bg4)", border: "1px solid var(--border2)", display: "inline-block" }} />Below Target</span>
        </div>
      </div>

    </div>
  );
}
