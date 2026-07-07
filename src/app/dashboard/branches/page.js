"use client";
import { useEffect, useState, useRef } from "react";
import { collection, onSnapshot, query, orderBy, where, getDocs, deleteDoc, doc, addDoc, updateDoc, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR, MONTHS, branchIncomeInPeriod, makeFilterPrefix, periodLabel, proRataSalary, salaryByBranchForMonth, branchSalaryShare, getStaffSalaryForMonth, staffLeavesInMonth, staffStatusForMonth, parseLocalDate, MASK, effectiveCashInHand, computeIncentiveExpense, getMonthlyFixed, effectiveBranchOnDate, shiftMonth, lastDayWithData, cumulativeCollection, monthCollection, fmtDelta } from "@/lib/calculations";
import { Icon, IconBtn, Pill, Card, PeriodWidget, ToggleGroup, TH, TD, Modal, SearchSelect, BranchEmployeeSearch, useConfirm, useToast } from "@/components/ui";
import { useRouter } from "next/navigation";
import VLoader from "@/components/VLoader";

function useSort(defaultCol = null, defaultDir = "asc") {
  const [sortCol, setSortCol] = useState(defaultCol);
  const [sortDir, setSortDir] = useState(defaultDir);
  const toggle = (col) => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
  };
  const sortRows = (rows, keyFns) => {
    if (!sortCol || !keyFns || typeof keyFns[sortCol] !== "function") return rows;
    const fn = keyFns[sortCol];
    const mult = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = fn(a), bv = fn(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * mult;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * mult;
    });
  };
  return { sortCol, sortDir, toggle, sortRows };
}

const NOW = new Date();

// Inline SVG chart — branch-scoped daily/monthly collection (cash + online + mat sale).
// Uses the same bar-chart idiom as dashboard's DailyBusinessChart but branch-only + supports yearly mode.
function BranchCollectionChart({ periodEntries, allEntries = [], branchId, filterMode, filterYear, filterMonth, endMonth, onDayClick, monthlyExpense = {} }) {
  const [hover, setHover] = useState(null);
  const isMonth = filterMode === "month";

  // Month-to-date comparison — running collection through the latest day with
  // data this month, vs the same 1..cutoff window of the prior two months, plus
  // the two prior full-month totals so the branch shows its recent trend.
  let mtdCutoff = 0, mtdCurr = 0, mtd = [];
  if (isMonth) {
    mtdCutoff = lastDayWithData(allEntries, filterYear, filterMonth, branchId);
    if (mtdCutoff > 0) {
      mtdCurr = cumulativeCollection(allEntries, filterYear, filterMonth, mtdCutoff, branchId);
      mtd = [1, 2, 3].map(back => {
        const { y, m } = shiftMonth(filterYear, filterMonth, back);
        return {
          label: MONTHS[m - 1], y, m,
          tillDate: cumulativeCollection(allEntries, y, m, mtdCutoff, branchId),
          full: monthCollection(allEntries, y, m, branchId),
        };
      });
    }
  }

  const buckets = [];
  if (isMonth) {
    const daysInMonth = new Date(filterYear, filterMonth, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${filterYear}-${String(filterMonth).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      buckets.push({ label: String(d), key, value: 0, cash: 0, online: 0, mat: 0, entryId: null });
    }
    periodEntries.forEach(e => {
      const idx = buckets.findIndex(x => x.key === e.date);
      if (idx < 0) return;
      const mat = (e.staff_billing || []).reduce((s, sb) => s + (sb.material || 0), 0);
      buckets[idx].online += (e.online || 0);
      buckets[idx].cash += (e.cash || 0);
      buckets[idx].mat += mat;
      buckets[idx].value += (e.online || 0) + (e.cash || 0) + mat;
      if (e.id) buckets[idx].entryId = e.id;
    });
  } else {
    for (let m = 1; m <= endMonth; m++) {
      const prefix = `${filterYear}-${String(m).padStart(2, "0")}`;
      const label = new Date(filterYear, m - 1, 1).toLocaleString("default", { month: "short" });
      const mEntries = periodEntries.filter(e => e.date && e.date.startsWith(prefix));
      let on = 0, ca = 0, ma = 0;
      mEntries.forEach(e => { on += (e.online || 0); ca += (e.cash || 0); ma += (e.staff_billing || []).reduce((ss, sb) => ss + (sb.material || 0), 0); });
      buckets.push({ label, key: prefix, value: on + ca + ma, online: on, cash: ca, mat: ma });
    }
  }

  // Year mode: per-month expense (Operating Cost) for the red overlay line.
  const bucketExp = buckets.map(b => isMonth ? 0 : (Number(monthlyExpense[b.key]) || 0));
  const totalExp = bucketExp.reduce((s, v) => s + v, 0);
  const max = Math.max(1, ...buckets.map(b => b.value), ...bucketExp);
  const total = buckets.reduce((s, b) => s + b.value, 0);
  const working = buckets.filter(b => b.value > 0).length;
  const avg = working ? Math.round(total / working) : 0;
  const bestIdx = buckets.reduce((best, b, i) => (b.value > buckets[best].value ? i : best), 0);

  const H = 180;
  const BAR_W = isMonth ? 22 : 42;
  const GAP = 6;
  const LEFT = 44;
  const PAD_TOP = 14;
  const PAD_BOTTOM = 28;
  const W = LEFT + buckets.length * (BAR_W + GAP);

  return (
    <Card style={{ padding: 16, marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--blue, #60a5fa)", textTransform: "uppercase", letterSpacing: 1.5 }}>📈 Collection Trend</div>
          <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>{isMonth ? "Daily" : "Monthly"} income · Cash + Online + Material</div>
          <div style={{ display: "flex", gap: 12, marginTop: 6, flexWrap: "wrap" }}>
            {[["Online", "#60a5fa"], ["Cash", "#c084fc"], ["Material", "var(--accent)"]].map(([lbl, col]) => (
              <span key={lbl} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 700, color: "var(--text2)" }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: col }} />{lbl}
              </span>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>Total</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "var(--green)" }}>{INR(total)}</div>
          </div>
          {!isMonth && totalExp > 0 && (
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
                <span style={{ width: 10, height: 2, background: "var(--red)", display: "inline-block", borderRadius: 1 }} />Expense
              </div>
              <div style={{ fontSize: 14, fontWeight: 800, color: "var(--red)" }}>{INR(totalExp)}</div>
            </div>
          )}
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>{isMonth ? "Daily Avg" : "Monthly Avg"}</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "var(--blue, #60a5fa)" }}>{INR(avg)}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>Best</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "var(--gold)" }}>{buckets[bestIdx]?.value > 0 ? `${buckets[bestIdx].label} · ${INR(buckets[bestIdx].value)}` : "—"}</div>
          </div>
        </div>
      </div>
      {/* Month-to-date comparison — this branch's running collection vs the same
          date window of the last two months + those months' full totals. */}
      {isMonth && mtdCutoff > 0 && (
        <div style={{ display: "flex", alignItems: "stretch", gap: 10, flexWrap: "wrap", marginBottom: 12, padding: "10px 12px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border)" }}>
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", paddingRight: 12, borderRight: "1px solid var(--border)" }}>
            <span style={{ fontSize: 8.5, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 700 }}>This month · till day {mtdCutoff}</span>
            <span style={{ fontSize: 18, fontWeight: 900, color: "var(--green)" }}>{INR(mtdCurr)}</span>
          </div>
          {mtd.map(mo => {
            const delta = mtdCurr - mo.tillDate;
            const up = delta > 0, flat = delta === 0;
            const col = flat ? "var(--text3)" : up ? "var(--green)" : "var(--red)";
            const pct = mo.tillDate > 0 ? Math.round((delta / mo.tillDate) * 100) : null;
            return (
              <div key={mo.label} style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 1, padding: "4px 10px", borderRadius: 8, background: "var(--bg4)", border: `1px solid ${col}44`, minWidth: 128 }}>
                <span style={{ fontSize: 8.5, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700 }}>vs {mo.label} (1–{mtdCutoff})</span>
                <span style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
                  <span style={{ fontSize: 14, fontWeight: 900, color: col }}>{flat ? "·" : up ? "▲" : "▼"} {fmtDelta(delta)}</span>
                  {pct !== null && !flat && <span style={{ fontSize: 9.5, fontWeight: 800, color: col }}>{pct > 0 ? "+" : ""}{pct}%</span>}
                </span>
                <span style={{ fontSize: 8.5, color: "var(--text3)", fontWeight: 600 }}>{mo.label} full: {INR(mo.full)}</span>
              </div>
            );
          })}
        </div>
      )}

      {total === 0 ? (
        <div style={{ height: H, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text3)", fontStyle: "italic", fontSize: 12 }}>No entries recorded for this period.</div>
      ) : (
        <div style={{ position: "relative", overflowX: "auto" }}>
          <svg width={W} height={H + PAD_TOP + PAD_BOTTOM} style={{ display: "block" }}>
            {Array.from({ length: 5 }, (_, i) => {
              const y = PAD_TOP + (1 - i / 4) * H;
              const v = Math.round(max * (i / 4));
              return (
                <g key={i}>
                  <line x1={LEFT} y1={y} x2={W} y2={y} stroke="rgba(255,255,255,0.05)" />
                  <text x={LEFT - 5} y={y + 3} fontSize={9} fill="var(--text3)" textAnchor="end">{v >= 1000 ? `${Math.round(v / 1000)}k` : v}</text>
                </g>
              );
            })}
            {buckets.map((b, i) => {
              const x = LEFT + i * (BAR_W + GAP);
              const totalH = b.value > 0 ? (b.value / max) * H : 2;
              const baseY = PAD_TOP + H;
              const isBest = i === bestIdx && b.value > 0;
              const clickable = isMonth && b.value > 0 && onDayClick;
              const dim = hover && hover.i !== i ? 0.4 : 1;
              // Stack Online (bottom) → Cash → Material (top). Segment heights
              // scale off the same max so bar total == income.
              const segs = b.value > 0
                ? [["online", b.online, "#60a5fa"], ["cash", b.cash, "#c084fc"], ["mat", b.mat, "var(--accent)"]].filter(s => s[1] > 0)
                : [];
              let cursorY = baseY;
              return (
                <g key={i} onMouseEnter={() => setHover({ i, b })} onMouseLeave={() => setHover(null)}
                  onClick={clickable ? () => onDayClick(b.key, b.entryId) : undefined}
                  style={{ cursor: clickable ? "pointer" : "default" }}>
                  {b.value <= 0 && <rect x={x} y={baseY - 2} width={BAR_W} height={2} rx={1} fill="var(--border)" />}
                  {segs.map(([k, v, col], si) => {
                    const segH = Math.max(1, (v / max) * H);
                    cursorY -= segH;
                    const isTop = si === segs.length - 1;
                    return <rect key={k} x={x} y={cursorY} width={BAR_W} height={segH} rx={isTop ? 4 : 0} fill={col} opacity={dim} style={{ transition: "opacity .15s" }} />;
                  })}
                  {isBest && <rect x={x - 1} y={baseY - totalH - 1} width={BAR_W + 2} height={totalH + 1} rx={5} fill="none" stroke="var(--green)" strokeWidth={1.5} opacity={dim} />}
                  <text x={x + BAR_W / 2} y={PAD_TOP + H + 14} fontSize={9} fill={isBest ? "var(--green)" : "var(--text3)"} textAnchor="middle" fontWeight={isBest ? 800 : 600}>{b.label}</text>
                </g>
              );
            })}
            {/* Year mode: per-month EXPENSE overlay (red line + dots). */}
            {!isMonth && (() => {
              const pts = bucketExp
                .map((e, i) => ({ i, e, x: LEFT + i * (BAR_W + GAP) + BAR_W / 2, y: PAD_TOP + H - (e / max) * H }))
                .filter(p => p.e > 0);
              if (pts.length === 0) return null;
              const d = pts.map((p, k) => `${k === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
              return (
                <g>
                  {pts.length > 1 && <path d={d} fill="none" stroke="var(--red)" strokeWidth={2} strokeLinejoin="round" opacity={0.9} />}
                  {pts.map(p => (
                    <circle key={p.i} cx={p.x} cy={p.y} r={3} fill="var(--red)" stroke="var(--bg4)" strokeWidth={1.5}
                      opacity={hover && hover.i !== p.i ? 0.4 : 1} />
                  ))}
                </g>
              );
            })()}
            <defs>
              <linearGradient id="bcol-blue" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(96,165,250,0.85)" />
                <stop offset="100%" stopColor="rgba(96,165,250,0.35)" />
              </linearGradient>
              <linearGradient id="bcol-green" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(74,222,128,0.95)" />
                <stop offset="100%" stopColor="rgba(74,222,128,0.4)" />
              </linearGradient>
            </defs>
          </svg>
          {hover && (
            <div style={{
              position: "absolute",
              left: Math.min(LEFT + hover.i * (BAR_W + GAP) + BAR_W + 10, W - 140),
              top: 4, pointerEvents: "none",
              background: "var(--bg4)", border: "1px solid rgba(96,165,250,0.35)", borderRadius: 8,
              padding: "6px 10px", fontSize: 11, zIndex: 3, boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
            }}>
              <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>{hover.b.key}</div>
              <div style={{ fontSize: 9, color: "var(--green)", fontWeight: 700, marginTop: 3, textTransform: "uppercase" }}>Income</div>
              <div style={{ fontSize: 13, fontWeight: 800, color: "var(--green)" }}>{INR(hover.b.value)}</div>
              <div style={{ marginTop: 5, display: "flex", flexDirection: "column", gap: 2, minWidth: 120 }}>
                {[["Online", hover.b.online, "#60a5fa"], ["Cash", hover.b.cash, "#c084fc"], ["Material", hover.b.mat, "var(--accent)"]].map(([lbl, v, col]) => (
                  <div key={lbl} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--text2)" }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: col }} />{lbl}
                    </span>
                    <span style={{ fontWeight: 700, color: v > 0 ? "var(--text)" : "var(--text3)" }}>{INR(v || 0)}</span>
                  </div>
                ))}
              </div>
              {!isMonth && (bucketExp[hover.i] || 0) > 0 && (() => {
                const exp = bucketExp[hover.i] || 0;
                const net = hover.b.value - exp;
                return (
                  <>
                    <div style={{ fontSize: 9, color: "var(--red)", fontWeight: 700, marginTop: 4, textTransform: "uppercase" }}>Expense</div>
                    <div style={{ fontSize: 12, fontWeight: 800, color: "var(--red)" }}>{INR(exp)}</div>
                    <div style={{ fontSize: 9, color: net >= 0 ? "var(--green)" : "var(--red)", fontWeight: 700, marginTop: 4, textTransform: "uppercase" }}>Net P&L</div>
                    <div style={{ fontSize: 12, fontWeight: 800, color: net >= 0 ? "var(--green)" : "var(--red)" }}>{INR(net)}</div>
                  </>
                );
              })()}
              {isMonth && hover.b.value > 0 && onDayClick && (
                <div style={{ fontSize: 9, color: "var(--blue, #60a5fa)", marginTop: 3, fontWeight: 700 }}>Click → open Daily Entry</div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// Branch-scoped twin of the dashboard's Same-Date Compare card. Overlays the
// three *completed* months before the selection (Apr · May · Jun for a July
// selection) day-by-day for THIS branch only, so you can eyeball how the same
// calendar day trended across recent months. The selected month is excluded —
// it has its own Collection Trend + month-to-date strip above. Month mode only.
function BranchSameDateCompareChart({ allEntries = [], branchId, filterYear, filterMonth }) {
  const [hover, setHover] = useState(null); // { day, mi }

  const ref = shiftMonth(filterYear, filterMonth, 1);
  const months = [];
  for (let back = 2; back >= 0; back--) {
    const { y, m } = shiftMonth(ref.y, ref.m, back);
    months.push({ y, m, label: new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short" }) });
  }
  const COLORS = ["#c084fc", "#5de8ff", "#4ade80"]; // oldest, middle, newest
  const GRADS = ["linear-gradient(180deg,#d7a6ff,#8b5cf6)", "linear-gradient(180deg,#5de8ff,#12a5bf)", "linear-gradient(180deg,#7df094,#22a354)"];

  const daysInSel = new Date(ref.y, ref.m, 0).getDate();

  // Per-month, per-day collection (online + cash + material) for this branch.
  const data = months.map(({ y, m }) => {
    const dim = new Date(y, m, 0).getDate();
    const byDay = Array.from({ length: dim }, () => 0);
    allEntries.forEach(e => {
      if (!e.date || e.branch_id !== branchId) return;
      const [ey, em, ed] = e.date.split("-").map(Number);
      if (ey !== y || em !== m) return;
      const idx = ed - 1;
      if (idx < 0 || idx >= dim) return;
      const matSale = (e.staff_billing || []).reduce((s, sb) => s + (sb.material || 0), 0);
      byDay[idx] += (e.online || 0) + (e.cash || 0) + matSale;
    });
    return { y, m, dim, byDay };
  });

  const max = Math.max(1, ...data.flatMap(d => d.byDay));
  const monStats = data.map(d => {
    const total = d.byDay.reduce((s, v) => s + v, 0);
    const working = d.byDay.filter(v => v > 0).length;
    const avg = working ? Math.round(total / working) : 0;
    let bestDay = 0, bestVal = 0;
    d.byDay.forEach((v, i) => { if (v > bestVal) { bestVal = v; bestDay = i + 1; } });
    return { total, avg, bestDay, bestVal };
  });
  const monTotals = monStats.map(s => s.total);
  const newest = monTotals[2], prev = monTotals[1];
  const delta = prev > 0 ? Math.round(((newest - prev) / prev) * 100) : null;

  const H = 180;
  const GROUP_GAP = 10;
  const BAR_W = 7;
  const BAR_GAP = 2;
  const groupW = 3 * BAR_W + 2 * BAR_GAP;
  const LEFT = 8;
  const W = LEFT + daysInSel * (groupW + GROUP_GAP);

  const weekdayOf = (d) => new Date(ref.y, ref.m - 1, d).toLocaleDateString("en-US", { weekday: "narrow" });
  const isWeekend = (d) => { const w = new Date(ref.y, ref.m - 1, d).getDay(); return w === 0 || w === 6; };

  return (
    <Card style={{ padding: 16, marginBottom: 12, overflow: "visible" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1.5 }}>📊 Same-Date Compare</div>
          <div style={{ fontSize: 15, fontWeight: 800, color: "var(--gold)", fontFamily: "var(--font-headline, var(--font-outfit))", marginTop: 2 }}>Every day · {months.map(m => m.label).join(" · ")} {months[2].y}</div>
          <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 600, marginTop: 2 }}>Prior 3 completed months for this branch — {new Date(filterYear, filterMonth - 1, 1).toLocaleDateString("en-US", { month: "long" })} shown above</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "stretch", flexWrap: "wrap" }}>
          {months.map((mo, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "6px 10px", borderRadius: 10, background: "var(--bg3)", border: `1px solid ${COLORS[i]}55`, minWidth: 120 }}>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: COLORS[i] }} />
                <span style={{ fontSize: 10.5, fontWeight: 800, color: "var(--text)" }}>{mo.label} {mo.y}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 9.5 }}>
                <span style={{ color: "var(--text3)", fontWeight: 700 }}>Total</span>
                <span style={{ color: "var(--text)", fontWeight: 800 }}>{INR(monTotals[i])}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 9.5 }}>
                <span style={{ color: "var(--text3)", fontWeight: 700 }}>Avg / day</span>
                <span style={{ color: "var(--blue)", fontWeight: 800 }}>{INR(monStats[i].avg)}</span>
              </div>
            </div>
          ))}
          {delta !== null && (
            <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", textAlign: "right", paddingLeft: 4 }}>
              <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>Month vs Prev</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: delta >= 0 ? "var(--green)" : "var(--red)" }}>{delta >= 0 ? "▲" : "▼"} {Math.abs(delta)}%</div>
            </div>
          )}
        </div>
      </div>

      {max <= 1 ? (
        <div style={{ height: H, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text3)", fontStyle: "italic", fontSize: 12 }}>No business for this branch in the prior 3 months.</div>
      ) : (
        <div style={{ position: "relative" }}>
          <div style={{ overflowX: "auto", paddingBottom: 4 }}>
            <div style={{ position: "relative", width: W, height: H + 34, display: "flex", alignItems: "flex-end", gap: GROUP_GAP, paddingLeft: LEFT }}>
              {Array.from({ length: daysInSel }, (_, di) => {
                const day = di + 1;
                const wknd = isWeekend(day);
                return (
                  <div key={day} style={{ display: "flex", flexDirection: "column", alignItems: "center", width: groupW }}>
                    <div style={{ display: "flex", alignItems: "flex-end", gap: BAR_GAP, height: H }}>
                      {data.map((d, mi) => {
                        const val = d.byDay[day - 1] || 0;
                        const missing = day > d.dim;
                        const barH = Math.max(val > 0 ? 3 : 0, Math.round((val / max) * H));
                        const on = hover && hover.day === day && hover.mi === mi;
                        return (
                          <div key={mi} onMouseEnter={() => !missing && setHover({ day, mi })} onMouseLeave={() => setHover(null)}
                            title={missing ? "" : `${months[mi].label} ${day} · ${INR(val)}`}
                            style={{ width: BAR_W, height: barH, minHeight: missing ? 0 : val > 0 ? 3 : 2, borderRadius: "3px 3px 0 0", background: missing ? "transparent" : val > 0 ? GRADS[mi] : "var(--bg4)", opacity: on ? 1 : hover ? 0.55 : 1, transition: "opacity .12s", cursor: missing ? "default" : "pointer" }} />
                        );
                      })}
                    </div>
                    <div style={{ marginTop: 6, textAlign: "center", lineHeight: 1.1 }}>
                      <div style={{ fontSize: 9.5, fontWeight: 800, color: wknd ? "var(--orange, #f59e0b)" : "var(--text2)" }}>{day}</div>
                      <div style={{ fontSize: 8, fontWeight: 700, color: wknd ? "var(--orange, #f59e0b)" : "var(--text3)" }}>{weekdayOf(day)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {hover && (() => {
            const day = hover.day;
            return (
              <div style={{ position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)", background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px", boxShadow: "0 8px 24px rgba(0,0,0,0.5)", zIndex: 20, minWidth: 180, pointerEvents: "none" }}>
                <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Day {day} · same-date</div>
                {data.map((d, mi) => (
                  <div key={mi} style={{ display: "flex", justifyContent: "space-between", gap: 14, fontSize: 11.5, padding: "2px 0" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text2)", fontWeight: 700 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: COLORS[mi] }} />{months[mi].label}
                    </span>
                    <span style={{ color: (d.byDay[day - 1] || 0) > 0 ? "var(--gold)" : "var(--text3)", fontWeight: 800 }}>{INR(d.byDay[day - 1] || 0)}</span>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 8, textAlign: "center" }}>
        Three bars per day = the three months. Weekdays under each day (weekends orange). Hover for the same-date split.
      </div>
    </Card>
  );
}

// Small labelled stat tile used in the attendance calendar's month summary panel.
function MiniTally({ label, value, color, sub }) {
  return (
    <div style={{ padding: "10px 12px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border)" }}>
      <div style={{ fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.8 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 900, color, fontFamily: "var(--font-headline, var(--font-outfit))", marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 600, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

// Monthly EXPENSE bar chart for a single branch (year view). Twin of the
// Collection Trend chart but red bars = operating cost, with a per-category
// breakdown on hover (Salary / Incentives / Material / Rent / Elec / WiFi /
// Other / GST). Fed straight from breakdownStats so it matches the P&L table.
function BranchExpenseChart({ breakdownStats = [], filterYear, salaryBreakup = {} }) {
  const [hover, setHover] = useState(null);
  const buckets = breakdownStats.map(s => {
    const exp = (s.income || 0) - (s.pl || 0);
    const rent = (s.shopRent || 0) + (s.roomRent || 0);
    const known = (s.salary || 0) + (s.incentives || 0) + rent + (s.elec || 0) + (s.wifi || 0) + (s.others || 0) + (s.gst || 0);
    const material = Math.max(0, exp - known);
    return {
      label: s.label, key: s.monthPrefix || s.label, value: exp,
      cats: [
        ["Salary", s.salary || 0, "var(--blue, #60a5fa)"],
        ["Incentives", s.incentives || 0, "var(--orange)"],
        ["Material", material, "var(--accent)"],
        ["Rent", rent, "#c084fc"],
        ["Electricity", s.elec || 0, "var(--gold)"],
        ["WiFi", s.wifi || 0, "var(--blue, #60a5fa)"],
        ["Other / Petrol", s.others || 0, "var(--text3)"],
        ["GST Est.", s.gst || 0, "var(--red)"],
      ].filter(c => c[1] > 0),
    };
  });

  const max = Math.max(1, ...buckets.map(b => b.value));
  const total = buckets.reduce((s, b) => s + b.value, 0);
  const active = buckets.filter(b => b.value > 0).length;
  const avg = active ? Math.round(total / active) : 0;
  const worstIdx = buckets.reduce((w, b, i) => (b.value > buckets[w].value ? i : w), 0);

  const H = 180, BAR_W = 42, GAP = 6, LEFT = 44, PAD_TOP = 14, PAD_BOTTOM = 28;
  const W = LEFT + buckets.length * (BAR_W + GAP);

  return (
    <Card style={{ padding: 16, marginBottom: 12, overflow: "visible" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--red)", textTransform: "uppercase", letterSpacing: 1.5 }}>💸 Expense Trend</div>
          <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>Monthly operating cost · hover for split</div>
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>Total</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "var(--red)" }}>{INR(total)}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>Monthly Avg</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "var(--orange)" }}>{INR(avg)}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>Highest</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "var(--red)" }}>{buckets[worstIdx]?.value > 0 ? `${buckets[worstIdx].label} · ${INR(buckets[worstIdx].value)}` : "—"}</div>
          </div>
        </div>
      </div>
      {total === 0 ? (
        <div style={{ height: H, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text3)", fontStyle: "italic", fontSize: 12 }}>No expense recorded for this period.</div>
      ) : (
        <div style={{ position: "relative" }}>
          <div style={{ overflowX: "auto" }}>
          <svg width={W} height={H + PAD_TOP + PAD_BOTTOM} style={{ display: "block" }}>
            <defs>
              <linearGradient id="bexp-red" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#fb7185" /><stop offset="100%" stopColor="rgba(225,29,72,0.45)" /></linearGradient>
              <linearGradient id="bexp-hi" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#fca5a5" /><stop offset="100%" stopColor="#dc2626" stopOpacity="0.7" /></linearGradient>
              <linearGradient id="bexp-sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="rgba(255,255,255,0.28)" /><stop offset="70%" stopColor="rgba(255,255,255,0)" /></linearGradient>
              <filter id="bexp-glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="3.5" /></filter>
            </defs>
            {Array.from({ length: 5 }, (_, i) => {
              const y = PAD_TOP + (1 - i / 4) * H;
              const v = Math.round(max * (i / 4));
              return (
                <g key={i}>
                  <line x1={LEFT} y1={y} x2={W} y2={y} stroke="rgba(255,255,255,0.05)" />
                  <text x={LEFT - 5} y={y + 3} fontSize={9} fill="var(--text3)" textAnchor="end">{v >= 100000 ? `${(v / 100000).toFixed(1)}L` : v >= 1000 ? `${Math.round(v / 1000)}k` : v}</text>
                </g>
              );
            })}
            {buckets.map((b, i) => {
              const x = LEFT + i * (BAR_W + GAP);
              const h = b.value > 0 ? (b.value / max) * H : 2;
              const y = PAD_TOP + H - h;
              const isWorst = i === worstIdx && b.value > 0;
              return (
                <g key={i} onMouseEnter={() => b.value > 0 && setHover({ i, b })} onMouseLeave={() => setHover(null)}
                  style={{ cursor: b.value > 0 ? "pointer" : "default", transition: "opacity .15s" }}
                  opacity={hover && hover.i !== i ? 0.4 : 1}>
                  {isWorst && b.value > 0 && (
                    <rect x={x - 3} y={y - 3} width={BAR_W + 6} height={h + 6} rx={6} fill="rgba(248,113,113,0.35)" filter="url(#bexp-glow)" />
                  )}
                  <rect x={x} y={y} width={BAR_W} height={h} rx={4} fill={isWorst ? "url(#bexp-hi)" : "url(#bexp-red)"} />
                  {b.value > 0 && <rect x={x} y={y} width={BAR_W} height={Math.min(h * 0.4, 16)} rx={4} fill="url(#bexp-sheen)" />}
                  <text x={x + BAR_W / 2} y={PAD_TOP + H + 14} fontSize={9} fill={isWorst ? "var(--red)" : "var(--text3)"} textAnchor="middle" fontWeight={isWorst ? 800 : 600}>{b.label}</text>
                </g>
              );
            })}
          </svg>
          </div>
          {hover && (() => {
            const staffList = salaryBreakup[hover.b.key] || [];
            return (
            <div style={{ position: "absolute", left: W + 16, top: 8, pointerEvents: "none", width: 230, background: "linear-gradient(160deg, rgba(30,18,20,0.98), rgba(18,12,14,0.98))", border: "1px solid rgba(248,113,113,0.45)", borderRadius: 10, padding: "10px 12px", fontSize: 11, zIndex: 5, boxShadow: "0 10px 34px rgba(0,0,0,0.65)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, paddingBottom: 6, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: "var(--text)" }}>{hover.b.label} {filterYear}</span>
                <span style={{ fontSize: 14, fontWeight: 900, color: "var(--red)" }}>{INR(hover.b.value)}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {hover.b.cats.map(([label, val, col]) => (
                  <div key={label}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 10.5 }}>
                      <span style={{ color: "var(--text2)", fontWeight: 600 }}>{label}</span>
                      <span style={{ fontWeight: 700, color: col }}>{INR(val)}</span>
                    </div>
                    {/* Admin-only per-staff salary breakup, indented under Salary. */}
                    {label === "Salary" && staffList.length > 0 && (
                      <div style={{ marginTop: 3, marginLeft: 8, paddingLeft: 8, borderLeft: "2px solid rgba(96,165,250,0.35)", display: "flex", flexDirection: "column", gap: 2 }}>
                        {staffList.map(s => (
                          <div key={s.name} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 9.5 }}>
                            <span style={{ color: "var(--text3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                            <span style={{ fontWeight: 600, color: "var(--blue, #60a5fa)" }}>{INR(s.amt)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            );
          })()}
        </div>
      )}
    </Card>
  );
}

// Month-wise Profit / Loss for a single branch (year view). Diverging bars —
// profit green above the zero line, loss red below — straight from
// breakdownStats.pl so it matches the P&L table. Hover shows income/expense/net.
function BranchPLTrendChart({ breakdownStats = [], filterYear }) {
  const [hover, setHover] = useState(null);
  // Only months with business (income > 0) — idle months (rent/salary, no sales)
  // are dropped so the trend reflects operating performance.
  const buckets = breakdownStats
    .filter(s => (s.income || 0) > 0)
    .map(s => ({ label: s.label, key: s.monthPrefix || s.label, pl: s.pl || 0, income: s.income || 0 }));
  if (buckets.length === 0) return null;

  const maxMag = Math.max(1, ...buckets.map(b => Math.abs(b.pl)));
  const totalPL = buckets.reduce((s, b) => s + b.pl, 0);
  const profitMonths = buckets.filter(b => b.pl > 0).length;
  const lossMonths = buckets.filter(b => b.pl < 0).length;

  const H = 200, halfH = H / 2, BAR_W = 42, GAP = 6, LEFT = 46, PAD_TOP = 16, PAD_BOTTOM = 28, BAR_R = 4;
  const W = LEFT + buckets.length * (BAR_W + GAP);
  const zeroY = PAD_TOP + halfH;
  const shortAmt = (v) => { const a = Math.abs(v); return (v < 0 ? "-" : "") + (a >= 100000 ? `${(a / 100000).toFixed(1)}L` : a >= 1000 ? `${Math.round(a / 1000)}k` : a); };

  return (
    <Card style={{ padding: 16, marginBottom: 12, overflow: "visible" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1.5 }}>📈 Profit / Loss Trend</div>
          <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>Monthly Full Net P&L · hover for split</div>
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>Profit / Loss mo</div>
            <div style={{ fontSize: 14, fontWeight: 800 }}><span style={{ color: "var(--green)" }}>{profitMonths}</span> <span style={{ color: "var(--text3)" }}>/</span> <span style={{ color: "var(--red)" }}>{lossMonths}</span></div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>Net</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: totalPL >= 0 ? "var(--green)" : "var(--red)" }}>{INR(totalPL)}</div>
          </div>
        </div>
      </div>
      <div style={{ position: "relative" }}>
        <div style={{ overflowX: "auto" }}>
        <svg width={W} height={H + PAD_TOP + PAD_BOTTOM} style={{ display: "block" }}>
          <defs>
            <linearGradient id="plt-green" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#7df094" /><stop offset="100%" stopColor="#22a354" stopOpacity="0.7" /></linearGradient>
            <linearGradient id="plt-red" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#e11d48" stopOpacity="0.7" /><stop offset="100%" stopColor="#fb7185" /></linearGradient>
          </defs>
          <text x={LEFT - 6} y={PAD_TOP + 3} fontSize={9} fill="var(--text3)" textAnchor="end">{shortAmt(maxMag)}</text>
          <text x={LEFT - 6} y={PAD_TOP + H + 3} fontSize={9} fill="var(--text3)" textAnchor="end">{shortAmt(-maxMag)}</text>
          <line x1={LEFT} y1={zeroY} x2={W} y2={zeroY} stroke="rgba(255,255,255,0.22)" strokeWidth={1.2} />
          {buckets.map((b, i) => {
            const x = LEFT + i * (BAR_W + GAP);
            const cx = x + BAR_W / 2;
            const barH = Math.max(2, (Math.abs(b.pl) / maxMag) * halfH);
            const profit = b.pl >= 0;
            const y = profit ? zeroY - barH : zeroY;
            const labelY = profit ? y - 5 : y + barH + 11;
            return (
              <g key={i} opacity={hover && hover.i !== i ? 0.4 : 1}
                onMouseEnter={() => setHover({ i, b })} onMouseLeave={() => setHover(null)}
                style={{ cursor: "pointer", transition: "opacity .15s" }}>
                <rect x={x} y={y} width={BAR_W} height={barH} rx={BAR_R} fill={profit ? "url(#plt-green)" : "url(#plt-red)"} />
                <text x={cx} y={labelY} fontSize={9} fontWeight={800} fill={profit ? "var(--green)" : "var(--red)"} textAnchor="middle">{shortAmt(b.pl)}</text>
                <text x={cx} y={PAD_TOP + H + 16} fontSize={9} fill="var(--text3)" textAnchor="middle" fontWeight={600}>{b.label}</text>
              </g>
            );
          })}
        </svg>
        </div>
        {hover && (() => {
          const b = hover.b;
          const exp = b.income - b.pl;
          return (
            <div style={{ position: "absolute", left: W + 16, top: 8, pointerEvents: "none", width: 190, background: "linear-gradient(160deg, rgba(18,22,30,0.98), rgba(12,14,20,0.98))", border: `1px solid ${b.pl >= 0 ? "rgba(74,222,128,0.45)" : "rgba(248,113,113,0.45)"}`, borderRadius: 10, padding: "10px 12px", fontSize: 11, zIndex: 5, boxShadow: "0 10px 34px rgba(0,0,0,0.65)" }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: "var(--text)", marginBottom: 8, paddingBottom: 6, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>{b.label} {filterYear}</div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 3 }}><span style={{ color: "var(--text3)" }}>Income</span><span style={{ fontWeight: 700, color: "var(--green)" }}>{INR(b.income)}</span></div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 3 }}><span style={{ color: "var(--text3)" }}>Expense</span><span style={{ fontWeight: 700, color: "var(--red)" }}>{INR(exp)}</span></div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 5, paddingTop: 5, borderTop: "1px dashed rgba(255,255,255,0.1)" }}><span style={{ color: "var(--text2)", fontWeight: 700 }}>Net P&L</span><span style={{ fontWeight: 900, color: b.pl >= 0 ? "var(--green)" : "var(--red)" }}>{INR(b.pl)}</span></div>
            </div>
          );
        })()}
      </div>
    </Card>
  );
}

// Stacked bar chart — per-day (or per-month) sale split by staff member.
// Value = sb.billing + sb.material (service sale + material sale), coloured by staff.
function BranchStaffSalesChart({ periodEntries, branchStaff, allStaff, filterMode, filterYear, filterMonth, endMonth, onDayClick }) {
  const [hover, setHover] = useState(null);
  const isMonth = filterMode === "month";

  const palette = ["#60a5fa", "#4ade80", "#fbbf24", "#f472b6", "#a78bfa", "#22d3ee", "#fb923c", "#34d399", "#f87171", "#c084fc", "#facc15", "#2dd4bf"];
  const colorAt = (i) => palette[i % palette.length];

  const buckets = [];
  if (isMonth) {
    const daysInMonth = new Date(filterYear, filterMonth, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${filterYear}-${String(filterMonth).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      buckets.push({ label: String(d), key, stacks: {}, entryId: null });
    }
    periodEntries.forEach(e => {
      const idx = buckets.findIndex(x => x.key === e.date);
      if (idx < 0) return;
      if (e.id) buckets[idx].entryId = e.id;
      (e.staff_billing || []).forEach(sb => {
        if (!sb.staff_id) return;
        buckets[idx].stacks[sb.staff_id] = (buckets[idx].stacks[sb.staff_id] || 0) + (sb.billing || 0) + (sb.material || 0);
      });
    });
  } else {
    for (let m = 1; m <= endMonth; m++) {
      const prefix = `${filterYear}-${String(m).padStart(2, "0")}`;
      const label = new Date(filterYear, m - 1, 1).toLocaleString("default", { month: "short" });
      const bucket = { label, key: prefix, stacks: {}, entryId: null };
      periodEntries.filter(e => e.date && e.date.startsWith(prefix)).forEach(e => {
        (e.staff_billing || []).forEach(sb => {
          if (!sb.staff_id) return;
          bucket.stacks[sb.staff_id] = (bucket.stacks[sb.staff_id] || 0) + (sb.billing || 0) + (sb.material || 0);
        });
      });
      buckets.push(bucket);
    }
  }

  const staffTotals = {};
  buckets.forEach(b => Object.entries(b.stacks).forEach(([id, v]) => { staffTotals[id] = (staffTotals[id] || 0) + v; }));
  const activeStaffIds = Object.keys(staffTotals).filter(id => staffTotals[id] > 0).sort((a, b) => staffTotals[b] - staffTotals[a]);
  // Loan resources carry a home branch_id that isn't this branch, so fall back to the full staff roster for name lookup.
  const staffById = Object.fromEntries((allStaff && allStaff.length ? allStaff : branchStaff).map(s => [s.id, s]));

  // Per-staff stats: highest / lowest / average, computed across days (or months) where that staff had any sale.
  const staffStats = {};
  activeStaffIds.forEach(sid => {
    let highVal = -Infinity, highKey = null;
    let lowVal = Infinity, lowKey = null;
    let sum = 0, activeCount = 0;
    buckets.forEach(b => {
      const v = b.stacks[sid] || 0;
      if (v <= 0) return;
      sum += v;
      activeCount += 1;
      if (v > highVal) { highVal = v; highKey = b.key; }
      if (v < lowVal) { lowVal = v; lowKey = b.key; }
    });
    staffStats[sid] = {
      total: sum,
      avg: activeCount ? Math.round(sum / activeCount) : 0,
      activeCount,
      high: highVal === -Infinity ? 0 : highVal,
      highKey,
      low: lowVal === Infinity ? 0 : lowVal,
      lowKey,
    };
  });

  const max = Math.max(1, ...buckets.map(b => Object.values(b.stacks).reduce((s, v) => s + v, 0)));
  const total = buckets.reduce((s, b) => s + Object.values(b.stacks).reduce((ss, v) => ss + v, 0), 0);

  const H = 200;
  const BAR_W = isMonth ? 22 : 42;
  const GAP = 6;
  const LEFT = 44;
  const PAD_TOP = 14;
  const PAD_BOTTOM = 28;
  const W = LEFT + buckets.length * (BAR_W + GAP);

  return (
    <Card style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1.5 }}>👥 Staff Sales Breakdown</div>
          <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>{isMonth ? "Daily" : "Monthly"} sale split by staff · service + material</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>Total Staff Sales</div>
          <div style={{ fontSize: 14, fontWeight: 800, color: "var(--green)" }}>{INR(total)}</div>
        </div>
      </div>
      {total === 0 ? (
        <div style={{ height: H, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text3)", fontStyle: "italic", fontSize: 12 }}>No staff billing recorded.</div>
      ) : (
        <>
          <div style={{ position: "relative", overflowX: "auto" }}>
            <svg width={W} height={H + PAD_TOP + PAD_BOTTOM} style={{ display: "block" }}>
              {Array.from({ length: 5 }, (_, i) => {
                const y = PAD_TOP + (1 - i / 4) * H;
                const v = Math.round(max * (i / 4));
                return (
                  <g key={i}>
                    <line x1={LEFT} y1={y} x2={W} y2={y} stroke="rgba(255,255,255,0.05)" />
                    <text x={LEFT - 5} y={y + 3} fontSize={9} fill="var(--text3)" textAnchor="end">{v >= 1000 ? `${Math.round(v / 1000)}k` : v}</text>
                  </g>
                );
              })}
              {buckets.map((b, i) => {
                const x = LEFT + i * (BAR_W + GAP);
                let accY = PAD_TOP + H;
                const bucketTotal = Object.values(b.stacks).reduce((s, v) => s + v, 0);
                const clickable = isMonth && bucketTotal > 0 && onDayClick;
                return (
                  <g key={i}>
                    {activeStaffIds.map((sid, si) => {
                      const v = b.stacks[sid] || 0;
                      if (v <= 0) return null;
                      const h = (v / max) * H;
                      accY -= h;
                      return (
                        <rect key={sid} x={x} y={accY} width={BAR_W} height={h}
                          fill={colorAt(si)}
                          onMouseEnter={() => setHover({ i, bucket: b, sid, value: v, total: bucketTotal })}
                          onMouseLeave={() => setHover(null)}
                          onClick={clickable ? () => onDayClick(b.key, b.entryId) : undefined}
                          opacity={hover && hover.i !== i ? 0.45 : 1}
                          style={{ cursor: clickable ? "pointer" : "default", transition: "opacity .15s" }}
                        />
                      );
                    })}
                    <text x={x + BAR_W / 2} y={PAD_TOP + H + 14} fontSize={9} fill="var(--text3)" textAnchor="middle" fontWeight={600}>{b.label}</text>
                  </g>
                );
              })}
            </svg>
            {hover && (
              <div style={{
                position: "absolute",
                left: Math.min(LEFT + hover.i * (BAR_W + GAP) + BAR_W + 10, W - 170),
                top: 4, pointerEvents: "none",
                background: "var(--bg4)", border: "1px solid rgba(var(--accent-rgb),0.35)", borderRadius: 8,
                padding: "6px 10px", fontSize: 11, zIndex: 3, boxShadow: "0 6px 20px rgba(0,0,0,0.5)",
                minWidth: 150,
              }}>
                <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>{hover.bucket.key}</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text2)", marginTop: 2 }}>{staffById[hover.sid]?.name || "Unknown"}</div>
                <div style={{ fontSize: 13, fontWeight: 800, color: "var(--green)", marginTop: 2 }}>{INR(hover.value)}</div>
                <div style={{ fontSize: 9, color: "var(--text3)", marginTop: 2 }}>{isMonth ? "Day" : "Month"} total: {INR(hover.total)}</div>
                {isMonth && onDayClick && (
                  <div style={{ fontSize: 9, color: "var(--accent)", marginTop: 3, fontWeight: 700 }}>Click → open Daily Entry</div>
                )}
              </div>
            )}
          </div>
          {/* Per-staff stats grid — elegant cards with rank, big total,
              avg / highest / lowest triad, and short humanised dates. */}
          {(() => {
            // Format a stat bucket key (YYYY-MM-DD in month mode, YYYY-MM in year)
            // into the tight "17 Apr" / "Apr" that the cards show underneath the
            // highest / lowest amounts. Keeps the visual weight away from dates.
            const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            const fmtKey = (k) => {
              if (!k) return "—";
              const parts = k.split("-");
              if (parts.length === 3) {
                const mi = Number(parts[1]) - 1;
                return `${Number(parts[2])} ${MONTHS_SHORT[mi] || ""}`.trim();
              }
              if (parts.length === 2) return MONTHS_SHORT[Number(parts[1]) - 1] || k;
              return k;
            };
            // Rank for the medal / #N pill — ranked by total so the top earners
            // get the visual nod regardless of the natural card order.
            const ranked = [...activeStaffIds].sort((a, b) => staffStats[b].total - staffStats[a].total);
            const rankBySid = new Map(ranked.map((sid, i) => [sid, i + 1]));
            const MEDAL = { 1: "🥇", 2: "🥈", 3: "🥉" };

            return (
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1.5 }}>Per-staff statistics</div>
                  <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 600 }}>{activeStaffIds.length} active · ranked by period total</div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
                  {activeStaffIds.map((sid, i) => {
                    const st = staffStats[sid];
                    const color = colorAt(i);
                    const rank = rankBySid.get(sid) || 0;
                    const medal = MEDAL[rank];
                    // Normalize highest against itself as the 100% reference so
                    // the mini AVG bar visually grades the staff member's
                    // consistency (avg / highest).
                    const avgPct = st.high > 0 ? Math.min(100, Math.round((st.avg / st.high) * 100)) : 0;
                    const name = staffById[sid]?.name || "Unknown";
                    return (
                      <div key={sid} style={{
                        position: "relative",
                        background: `linear-gradient(145deg, rgba(255,255,255,0.02), rgba(255,255,255,0)), var(--bg3)`,
                        border: `1px solid ${color}2E`,
                        borderRadius: 12,
                        padding: "14px 16px 12px",
                        boxShadow: `0 1px 2px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)`,
                        overflow: "hidden",
                      }}>
                        {/* Top accent strip — carries the staff color without the
                            heavy 3px left border used previously. */}
                        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${color}, ${color}55 70%, transparent)` }} />

                        {/* Header: rank + name, period total on the right. */}
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 12 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
                            <div style={{
                              width: 26, height: 26, borderRadius: 8,
                              background: medal ? `${color}22` : "var(--bg4)",
                              border: `1px solid ${medal ? color + "55" : "var(--border)"}`,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: medal ? 14 : 10, fontWeight: 800,
                              color: medal ? color : "var(--text3)", flexShrink: 0,
                            }}>{medal || `#${rank}`}</div>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ color: "var(--text)", fontWeight: 800, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: 0.2 }}>{name}</div>
                              <div style={{ color: "var(--text3)", fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Period Total</div>
                            </div>
                          </div>
                          <div style={{ textAlign: "right", flexShrink: 0 }}>
                            <div style={{ color: "var(--green)", fontWeight: 900, fontSize: 16, fontFamily: "var(--font-headline, var(--font-outfit))", lineHeight: 1.1 }}>{INR(st.total)}</div>
                            <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 600, marginTop: 2 }}>{st.activeCount} {isMonth ? (st.activeCount === 1 ? "day" : "days") : (st.activeCount === 1 ? "mo" : "mos")}</div>
                          </div>
                        </div>

                        {/* Stat row: AVG with consistency bar · HIGHEST · LOWEST */}
                        <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr 1fr", gap: 10 }}>
                          <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingRight: 8, borderRight: "1px solid rgba(255,255,255,0.05)" }}>
                            <div style={{ color: "var(--text3)", fontSize: 8.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1 }}>Avg</div>
                            <div style={{ color: "var(--blue, #60a5fa)", fontWeight: 800, fontSize: 12.5 }}>{INR(st.avg)}</div>
                            <div style={{ height: 2.5, background: "rgba(255,255,255,0.05)", borderRadius: 2, overflow: "hidden", marginTop: 2 }}>
                              <div style={{ height: "100%", width: `${avgPct}%`, background: "linear-gradient(90deg, var(--blue, #60a5fa), var(--accent))", borderRadius: 2 }} />
                            </div>
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingRight: 8, borderRight: "1px solid rgba(255,255,255,0.05)" }}>
                            <div style={{ color: "var(--text3)", fontSize: 8.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1 }}>High</div>
                            <div style={{ color: "var(--green)", fontWeight: 800, fontSize: 12.5 }}>{INR(st.high)}</div>
                            <div style={{ color: "var(--text3)", fontSize: 9, fontWeight: 600 }}>{fmtKey(st.highKey)}</div>
                          </div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            <div style={{ color: "var(--text3)", fontSize: 8.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1 }}>Low</div>
                            <div style={{ color: "var(--orange, #fb923c)", fontWeight: 800, fontSize: 12.5 }}>{INR(st.low)}</div>
                            <div style={{ color: "var(--text3)", fontSize: 9, fontWeight: 600 }}>{fmtKey(st.lowKey)}</div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </>
      )}
    </Card>
  );
}

export default function BranchesPage() {
  const router = useRouter();
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [branches, setBranches] = useState([]);
  const [staff, setStaff] = useState([]);
  const [entries, setEntries] = useState([]);
  const [materialAllocations, setMaterialAllocations] = useState([]);
  const [materialsMaster, setMaterialsMaster] = useState([]);
  // Per-month overrides written from Operational Expenses (Fixed tab).
  // **Why:** Without this, edits to Shop Rent / Room Rent / Elec / WiFi /
  // custom fixed columns made on the Operational Expenses page never showed
  // up here — the Summary view fell back to the static branches master.
  // **How to apply:** Used in the branchData factor loop to override the
  // master default per (branch, YYYY-MM, expense_type).
  const [fixedExpenses, setFixedExpenses] = useState([]);
  // Older per-month override store written by Master Setup → Fixed Exp tab.
  // **Why:** Some branches still use this surface; without reading it, the
  // Summary view drifts whenever the user updated values there instead of in
  // Operational Expenses.
  // **How to apply:** Resolver consults this when no `fixed_expenses` row
  // exists for the (branch, month, type).
  const [monthlyExpenses, setMonthlyExpenses] = useState([]);
  // Per-staff incentive payouts. Used to add the ceil-10 rounding bump
  // (amount_released − total_incentive) to incentive expense once paid.
  const [incentiveReleases, setIncentiveReleases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedBranch, setSelectedBranch] = useState(null);
  const [logView, setLogView] = useState(null);
  const [leaves, setLeaves] = useState([]);
  const [globalSettings, setGlobalSettings] = useState(null);
  const [salHistory, setSalHistory] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [selectedStaffHistory, setSelectedStaffHistory] = useState(null);
  // Search-driven focus on a specific staff row inside the branch detail.
  // **Why:** When the user searches "Aarif" in the unified search, we open
  // his branch detail and highlight his row briefly so he's easy to spot.
  // **How to apply:** Set on search-select; cleared after the highlight
  // pulse fades or the user leaves the detail view.
  const [staffFocusId, setStaffFocusId] = useState(null);
  const staffRosterSort = useSort();
  const [staffTab, setStaffTab] = useState("active"); // "active" | "inactive"
  const [staffSalesCal, setStaffSalesCal] = useState(null); // staff id for per-day sales calendar modal
  const [attendanceCalendar, setAttendanceCalendar] = useState(null); // branch id
  const [attendanceMonth, setAttendanceMonth] = useState(null); // "YYYY-MM"
  const [attendanceSelectedDay, setAttendanceSelectedDay] = useState(null); // "YYYY-MM-DD"
  const [attChip, setAttChip] = useState(null); // null | 'present' | 'loan' | 'leave' | 'active' | 'business'

  // Period
  const [filterMode, setFilterMode] = useState("month");
  const [filterYear, setFilterYear] = useState(NOW.getFullYear());
  const [filterMonth, setFilterMonth] = useState(NOW.getMonth() + 1);

  // Controls
  const [brFilter, setBrFilter] = useState("all");
  const [brTargetFilter, setBrTargetFilter] = useState("all"); // all | met | notmet
  // After the branch detail mounts with a staff focus, scroll the matching
  // row into view and let the highlight pulse for ~3s before clearing.
  useEffect(() => {
    if (!staffFocusId || !selectedBranch) return;
    const t = setTimeout(() => {
      const el = typeof document !== "undefined" ? document.getElementById(`staff-row-${staffFocusId}`) : null;
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 350);
    const clear = setTimeout(() => setStaffFocusId(null), 3500);
    return () => { clearTimeout(t); clearTimeout(clear); };
  }, [staffFocusId, selectedBranch]);
  const [brTypeFilter, setBrTypeFilter] = useState("all");
  // Default sort = income desc. Saved preference is applied after mount (in an
  // effect, not the useState initializer) so server + first client render agree
  // and there is no hydration mismatch.
  const [brSortCol, setBrSortCol] = useState("income");
  const [brSortDir, setBrSortDir] = useState("desc");
  useEffect(() => {
    try {
      const s = localStorage.getItem("vcut_branch_sort");
      if (s) {
        const { col, dir } = JSON.parse(s);
        if (col) setBrSortCol(col);
        if (dir) setBrSortDir(dir);
      }
    } catch {}
  }, []);
  // Honour ?view=summary|table|card from the URL so deep-links (e.g. from
  // the dashboard's Operating Cost card) land on the right tab. Read straight
  // from window.location — useSearchParams() in Next 16 / React 19 requires
  // a Suspense boundary and the webview dumps the page without one.
  const [brView, setBrView] = useState(() => {
    if (typeof window === "undefined") return "card";
    const q = new URLSearchParams(window.location.search).get("view");
    return q === "summary" || q === "table" || q === "card" ? q : "card";
  });
  const [summaryTab, setSummaryTab] = useState("summary"); // "summary" | "dailycash"
  // Deep-link target for DailyCashOnline — e.g. dashboard's Missing Entries
  // card sets this to "missing" so the right collapsible card is already open
  // on arrival. Once consumed, DailyCashOnline clears it back to null.
  const [dailyCashExpanded, setDailyCashExpanded] = useState(null);

  // Edit form
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState({ name: "", type: "mens", location: "", shop_rent: "", room_rent: "", salary_budget: "", wifi: "", shop_elec: "", room_elec: "" });

  // Detail-view section picker: empty set = all hidden; user clicks cards to reveal
  // each section (Cash Flow, Performance, Materials, Recent Entries).
  const [openSections, setOpenSections] = useState(new Set());
  // KPI breakdown popup — "variable" or "fixed" or null
  const [kpiBreakdown, setKpiBreakdown] = useState(null);
  // Material Consumption dashboard: which material card is expanded for the
  // detail timeline. Keyed by material_id (or name fallback).
  const [expandedMat, setExpandedMat] = useState(null);
  // Materials Received table — search, group filter, sort.
  const [matSearch, setMatSearch] = useState("");
  const [matGroupFilter, setMatGroupFilter] = useState("");
  const matSort = useSort("date", "desc");
  const toggleSection = (id) => setOpenSections(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // Recalculate modal
  const [recalcModal, setRecalcModal] = useState(null); // { branches: [{id, name}] }
  // Admin-only breakdown modal for the Salary column in Daily/Monthly Performance.
  // { label, salary, monthlyTotal, dayFactor, daysInMonth, branchName, staffRows: [{id,name,role,base,proRated}] }
  const [salaryDetail, setSalaryDetail] = useState(null);
  const [recalcFrom, setRecalcFrom] = useState(() => { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10); });
  const [recalcTo, setRecalcTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [recalcBusy, setRecalcBusy] = useState(false);
  const [recalcLog, setRecalcLog] = useState([]);

  // Multi-branch selection (card/table list view)
  const [selectedBranches, setSelectedBranches] = useState(new Set());
  const toggleBranchSelect = (id) => {
    setSelectedBranches(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const clearBranchSelection = () => setSelectedBranches(new Set());
  const selectAllBranches = () => setSelectedBranches(new Set(branches.map(b => b.id)));
  const openBulkRecalc = () => {
    if (selectedBranches.size === 0) return;
    const list = Array.from(selectedBranches)
      .map(id => { const b = branches.find(x => x.id === id); return b ? { id: b.id, name: b.name } : null; })
      .filter(Boolean);
    if (list.length === 0) return;
    setRecalcModal({ branches: list });
    setRecalcLog([]);
    setRecalcDone(false);
  };

  const currentUser = useCurrentUser() || {};
  const isAdmin = currentUser?.role === "admin";
  const canEdit = ["admin","accountant"].includes(currentUser?.role);
  const filterPrefix = makeFilterPrefix(filterYear, filterMonth);
  const plabel = periodLabel(filterMode, filterYear, filterMonth);

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "staff"), sn => setStaff(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "leaves"), sn => setLeaves(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "salary_history"), sn => setSalHistory(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "staff_transfers"), sn => setTransfers(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(doc(db, "settings", "global"), sn => setGlobalSettings(sn.data())),
      onSnapshot(query(collection(db, "entries"), orderBy("date", "desc")), sn => {
        setEntries(sn.docs.map(d => ({ ...d.data(), id: d.id })));
        setLoading(false);
      }),
      onSnapshot(query(collection(db, "material_allocations"), orderBy("transferred_at", "desc")), sn => {
        setMaterialAllocations(sn.docs.map(d => ({ ...d.data(), id: d.id })));
      }),
      onSnapshot(collection(db, "materials"), sn => setMaterialsMaster(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "fixed_expenses"), sn => setFixedExpenses(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "monthly_expenses"), sn => setMonthlyExpenses(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "incentive_releases"), sn => setIncentiveReleases(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  // Sync state from URL (Dashboard deep-linking).
  // Why: Next 16 App Router keeps the page mounted when only query params change,
  // so `useState` lazy-init (and this effect on [branches]) don't re-run on re-entry.
  // We listen for pushState/popstate so a second visit with a different `?view=` or
  // `?branchId=` actually takes effect instead of showing the previous detail view.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const applyUrlState = () => {
      const params = new URLSearchParams(window.location.search);
      const bid  = params.get("branchId");
      const sid  = params.get("staffId");
      const view = params.get("view");
      const tab  = params.get("tab");
      const expand = params.get("expand");
      const mode = params.get("mode");
      const yr   = params.get("year");
      const mo   = params.get("month");
      const cal  = params.get("calendar");

      if (view === "summary" || view === "table" || view === "card") {
        setBrView(view);
        // A ?view= deep-link targets the list/summary tab — never a single branch.
        setSelectedBranch(null);
      }
      if (tab === "summary" || tab === "dailycash") setSummaryTab(tab);
      // Dashboard's Missing Entries card deep-links with ?expand=missing so the
      // relevant card is open on arrival.
      if (expand) setDailyCashExpanded(expand);
      if (bid)  setSelectedBranch(bid);
      if (sid)  setStaffFocusId(sid);
      if (mode) setFilterMode(mode);
      if (yr)   setFilterYear(Number(yr));
      if (mo)   setFilterMonth(Number(mo));
      if (bid && cal === "1") {
        // Default to the active filter month, or the current month if not set.
        const prefix = (mode === "year")
          ? `${yr || NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, "0")}`
          : `${yr || NOW.getFullYear()}-${String(mo || NOW.getMonth() + 1).padStart(2, "0")}`;
        setAttendanceCalendar(bid);
        setAttendanceMonth(prefix);
        setAttendanceSelectedDay(null);
      }

      // Clean URL params so a refresh doesn't re-apply stale deep-link state.
      if (bid || sid || view || tab || expand || mode || yr || mo || cal) {
        window.history.replaceState({}, "", window.location.pathname);
      }
    };

    applyUrlState();

    // Next's client-side router uses history.pushState; patch it to emit an event
    // so this page can re-sync when the user arrives via router.push while the
    // component is still mounted.
    const origPush = window.history.pushState;
    window.history.pushState = function (...args) {
      const result = origPush.apply(this, args);
      window.dispatchEvent(new Event("vcut:urlchange"));
      return result;
    };
    window.addEventListener("vcut:urlchange", applyUrlState);
    window.addEventListener("popstate", applyUrlState);

    return () => {
      window.history.pushState = origPush;
      window.removeEventListener("vcut:urlchange", applyUrlState);
      window.removeEventListener("popstate", applyUrlState);
    };
  }, [branches]);

  const inPeriod = (dateStr) => {
    if (!dateStr) return false;
    if (filterMode === "month") return dateStr.startsWith(filterPrefix);
    return dateStr.startsWith(String(filterYear));
  };

  const getIncome = (bid) => {
    return entries.filter(e => e.branch_id === bid && inPeriod(e.date)).reduce((s, e) => {
      return s + (e.online || 0) + (e.cash || 0) + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.material || 0), 0);
    }, 0);
  };

  const getExpenses = (bid) => {
    return entries.filter(e => e.branch_id === bid && inPeriod(e.date)).reduce((s, e) => {
      const inc = (e.staff_billing || []).reduce((ss, sb) => ss + (sb.incentive || 0) + (sb.mat_incentive || 0), 0);
      return s + inc + (e.mat_expense || 0) + (e.others || 0) + (e.petrol || 0);
    }, 0);
  };

  // Override lookup from `fixed_expenses` (Operational Expenses page) — keyed
  // by `${branchId}|${YYYY-MM}|${type}`.
  const fixedOverride = (() => {
    const m = new Map();
    fixedExpenses.forEach(fx => {
      if (!fx.branch_id || !fx.date || !fx.type) return;
      const key = `${fx.branch_id}|${fx.date.slice(0, 7)}|${fx.type}`;
      m.set(key, (m.get(key) || 0) + (Number(fx.amount) || 0));
    });
    return m;
  })();
  // Older override store: `monthly_expenses` keyed by `${branchId}|${YYYY-MM}`,
  // each row holds shop_rent / room_rent / shop_elec / room_elec / wifi / water
  // as named fields (Master Setup → Fixed Exp tab writes here).
  const monthlyOverride = (() => {
    const m = new Map();
    monthlyExpenses.forEach(rec => {
      if (!rec.branch_id || !rec.month) return;
      m.set(`${rec.branch_id}|${rec.month}`, rec);
    });
    return m;
  })();
  // Maps the Operational Expenses type-name into the matching field on a
  // `monthly_expenses` doc so the resolver can fall back to the older store.
  const typeToMonthlyField = {
    "Shop Rent": "shop_rent",
    "Room Rent": "room_rent",
    "Electricity Shop": "shop_elec",
    "Electricity Room": "room_elec",
    "WiFi Bill": "wifi",
    "Water Bill": "water",
  };
  // Resolve a fixed-cost line for a (branch, type, master-default) tuple
  // across the active period, summing per-month. Override priority per month:
  //   1. `fixed_expenses` row (Operational Expenses page) for this type
  //   2. `monthly_expenses` row (Master Setup → Fixed Exp) for this field
  //   3. branches master default
  // Staff + branch lookups for computeIncentiveExpense — passing branches and
  // globalSettings lets it fall back to the mens/unisex rate when a staff
  // record doesn't have an explicit incentive_pct (mirrors entry/page.js).
  const staffByIdMap = new Map(staff.map(s => [s.id, s]));
  const branchesByIdMap = new Map(branches.map(b => [b.id, b]));
  const resolveFixed = (b, type, perMonthDefault, isYearly, filterYear, filterMonth) => {
    const startM = isYearly ? 1 : filterMonth;
    const endM = isYearly ? (filterYear === NOW.getFullYear() ? NOW.getMonth() + 1 : 12) : filterMonth;
    const monthlyField = typeToMonthlyField[type];
    let total = 0;
    for (let m = startM; m <= endM; m++) {
      const ymKey = `${filterYear}-${String(m).padStart(2, "0")}`;
      const fxKey = `${b.id}|${ymKey}|${type}`;
      const fxOvr = fixedOverride.get(fxKey);
      if (fxOvr != null) { total += fxOvr; continue; }
      if (monthlyField) {
        const mRow = monthlyOverride.get(`${b.id}|${ymKey}`);
        const mOvr = mRow?.[monthlyField];
        if (mOvr !== undefined && mOvr !== null) { total += Number(mOvr) || 0; continue; }
      }
      total += Number(perMonthDefault) || 0;
    }
    return total;
  };

  // Build branch data
  let branchData = branches.map(b => {
    const bEntries = entries.filter(ent => ent.branch_id === b.id && inPeriod(ent.date));
    const isYearly = filterMode === "year";
    const currentYear = NOW.getFullYear();
    const factor = (isYearly && filterYear === currentYear) ? (NOW.getMonth() + 1) : (isYearly ? 12 : 1);
    
    // Aggregates
    const iOnline = bEntries.reduce((s, e) => s + (e.online || 0), 0);
    const iCash   = bEntries.reduce((s, e) => s + (e.cash || 0), 0);
    const iMatS   = bEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.material || 0), 0), 0);
    const income  = iOnline + iCash + iMatS;

    // Incentive expense = raw 5% per-day + ceil-to-10 rounding bump on
    // releases that fall in this period for this branch. Pending entries
    // count as raw; once paid out, the rounding surplus also lands here so
    // the total matches what was actually disbursed.
    const branchReleases = incentiveReleases.filter(r => r.branch_id === b.id && inPeriod(r.period_from || (r.released_at || "").slice(0, 10)));
    const vInc = computeIncentiveExpense(bEntries, staffByIdMap, branchReleases, branchesByIdMap, globalSettings);
    // Material cost honours Master Setup → Material Expense Source toggles
    // so card/table/Summary use the same source as the branch detail + P&L
    // pages. Default (allocations only) matches the dashboard's Operating
    // Cost formula — without this, Summary totals drifted ~tens of thousands.
    const matUseAllocations = globalSettings?.mat_use_allocations !== false;
    const matUseLumpsum = globalSettings?.mat_use_lumpsum === true;
    const allocsTotal = (arr) => arr.reduce((s, a) => s + (Number(a.total) || (a.items || []).reduce((ss, it) => ss + (Number(it.line_total) || (Number(it.qty) * Number(it.price_at_transfer)) || 0), 0)), 0);
    const vMatAlloc = allocsTotal(materialAllocations.filter(a => a.branch_id === b.id && inPeriod(a.date || (a.transferred_at || "").slice(0, 10))));
    const vMatLump  = bEntries.reduce((s, e) => s + (Number(e.mat_expense) || 0), 0);
    const vMatE = (matUseAllocations ? vMatAlloc : 0) + (matUseLumpsum ? vMatLump : 0);
    const vOther = bEntries.reduce((s, e) => s + (e.others || 0) + (e.petrol || 0), 0);
    const vPetrol = bEntries.reduce((s, e) => s + (e.petrol || 0), 0);
    
    // Fixed costs — prefer per-month overrides written by Operational Expenses,
    // fall back to the branches master default. fElec sums the Shop + Room
    // electricity lines so a partial override (e.g. Shop only) still adds the
    // Room master for that month.
    const fShopRent = resolveFixed(b, "Shop Rent",        b.shop_rent || 0, isYearly, filterYear, filterMonth);
    const fRoomRent = resolveFixed(b, "Room Rent",        b.room_rent || 0, isYearly, filterYear, filterMonth);
    const fWifi     = resolveFixed(b, "WiFi Bill",        b.wifi || 0,      isYearly, filterYear, filterMonth);
    const fShopElec = resolveFixed(b, "Electricity Shop", b.shop_elec || 0, isYearly, filterYear, filterMonth);
    const fRoomElec = resolveFixed(b, "Electricity Room", b.room_elec || 0, isYearly, filterYear, filterMonth);
    const fElec     = fShopElec + fRoomElec;
    const fFixedTot = fShopRent + fRoomRent + fWifi + fElec;

    // Payroll (Actual)
    let actualSalary = 0;
    let actualLeaves = 0;
    const startM = isYearly ? 1 : filterMonth;
    const endM   = isYearly ? factor : filterMonth;
    for (let m = startM; m <= endM; m++) {
      const mPrefix = `${filterYear}-${String(m).padStart(2, '0')}`;
      // Transfer-aware staff set (matches the roster): a staff is "at" this branch
      // for the month based on effectiveBranchOnDate at month-end, not their raw
      // home branch_id — so transferred staff's salary lands on the right branch.
      const mRefDate = `${mPrefix}-${String(new Date(filterYear, m, 0).getDate()).padStart(2, '0')}`;
      const activeStaffInMonth = staff.filter(s => effectiveBranchOnDate(s, mRefDate, transfers) === b.id && staffStatusForMonth(s, mPrefix).status !== 'inactive');
      // Salary expense follows where work physically happened: split each staff
      // member's attendance-gated month salary across branches by days present,
      // then take this branch's share (staff borrowed in counted here, ours lent
      // out only contribute their here-portion).
      actualSalary += (salaryByBranchForMonth(mPrefix, entries, branches, salHistory, staff, globalSettings, leaves).get(b.id) || 0);
      actualLeaves += activeStaffInMonth.reduce((s, st) => s + staffLeavesInMonth(st.id, mPrefix, leaves), 0);
    }

    const gstPct = globalSettings?.gst_pct || 0;
    const gstEst = (iOnline * gstPct) / 100;
    const expenses = vInc + vMatE + vOther + fFixedTot + actualSalary + gstEst;
    const net      = income - expenses;
    const totalGst = bEntries.reduce((s, ent) => s + (ent.total_gst || 0), 0);

    // Cash reconciliation aggregates (entries where actual cash was recorded)
    let totalDeficit = 0, totalExcess = 0, reconciledDays = 0;
    bEntries.forEach(ent => {
      if (ent.cash_diff == null) return;
      reconciledDays += 1;
      if (ent.cash_diff < 0) totalDeficit += Math.abs(ent.cash_diff);
      else if (ent.cash_diff > 0) totalExcess += ent.cash_diff;
    });
    const netDiff = totalExcess - totalDeficit;

    // Shop target — should bill at least 3× its salary cost. Achieved = income.
    const shopTgt = Math.round(actualSalary * 3);
    const targetMet = shopTgt > 0 && income >= shopTgt;
    const targetPct = shopTgt > 0 ? Math.round(income / shopTgt * 100) : 0;
    const targetShort = Math.max(0, shopTgt - income);
    const targetExcess = Math.max(0, income - shopTgt);

    return {
      b,
      i: income,
      e: expenses,
      n: net,
      staffCount: staff.filter(s => s.branch_id === b.id).length,
      vInc, vMatE, vOther, vPetrol,
      fShopRent, fRoomRent, fWifi, fElec, fShopElec, fRoomElec,
      actualSalary, actualLeaves,
      totalGst, factor,
      totalDeficit, totalExcess, netDiff, reconciledDays,
      shopTgt, targetMet, targetPct, targetShort, targetExcess,
    };
  });
  if (brFilter === "profit") branchData = branchData.filter(d => d.n >= 0);
  if (brFilter === "loss") branchData = branchData.filter(d => d.n < 0);
  if (brTargetFilter === "met") branchData = branchData.filter(d => d.targetMet);
  if (brTargetFilter === "notmet") branchData = branchData.filter(d => d.shopTgt > 0 && !d.targetMet);
  if (brTypeFilter === "mens") branchData = branchData.filter(d => d.b.type === "mens");
  if (brTypeFilter === "unisex") branchData = branchData.filter(d => d.b.type === "unisex");
  branchData.sort((a, b) => {
    if (brSortCol === "income") return brSortDir === "desc" ? b.i - a.i : a.i - b.i;
    if (brSortCol === "pl") return brSortDir === "desc" ? b.n - a.n : a.n - b.n;
    if (brSortCol === "expense") return brSortDir === "desc" ? b.e - a.e : a.e - b.e;
    return brSortDir === "desc" ? b.b.name.localeCompare(a.b.name) : a.b.name.localeCompare(b.b.name);
  });

  const handleEdit = (b) => {
    setForm({ name: b.name || "", type: b.type || "mens", location: b.location || "", shop_rent: b.shop_rent || "", room_rent: b.room_rent || "", salary_budget: b.salary_budget || "", wifi: b.wifi || "", shop_elec: b.shop_elec || "", room_elec: b.room_elec || "" });
    setEditId(b.id);
    setShowForm(true);
    setSelectedBranch(null);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    const payload = { name: form.name, type: form.type, location: form.location, shop_rent: Number(form.shop_rent) || 0, room_rent: Number(form.room_rent) || 0, salary_budget: Number(form.salary_budget) || 0, wifi: Number(form.wifi) || 0, shop_elec: Number(form.shop_elec) || 0, room_elec: Number(form.room_elec) || 0 };
    try {
      if (editId) {
        await updateDoc(doc(db, "branches", editId), payload);
        toast({ title: "Updated", message: "Branch details updated successfully.", type: "success" });
      } else {
        await addDoc(collection(db, "branches"), payload);
        toast({ title: "Saved", message: "Branch created successfully.", type: "success" });
      }
      setShowForm(false); setEditId(null);
    } catch (err) { confirm({ title: "Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} }); }
  };

  const handleDelete = (bid) => {
    confirm({
      title: "Delete Branch",
      message: "Delete this branch?",
      confirmText: "Delete",
      cancelText: "Cancel",
      type: "danger",
      onConfirm: async () => {
        try { await deleteDoc(doc(db, "branches", bid)); setSelectedBranch(null); toast({ title: "Deleted", message: "Branch has been removed.", type: "success" }); }
        catch (err) { confirm({ title: "Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} }); }
      }
    });
  };

  const handleDeleteEntry = (eid) => {
    confirm({
      title: "Delete Entry",
      message: "Delete this entry permanently?",
      confirmText: "Delete",
      cancelText: "Cancel",
      type: "danger",
      onConfirm: async () => {
        try { await deleteDoc(doc(db, "entries", eid)); toast({ title: "Deleted", message: "Entry has been removed.", type: "success" }); }
        catch (err) { confirm({ title: "Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} }); }
      }
    });
  };

  // ── Recalculate entries for a branch in a date range ──
  const [recalcProgress, setRecalcProgress] = useState({ current: 0, total: 0 });
  const [recalcDone, setRecalcDone] = useState(false); // true when finished

  const handleRecalculate = async () => {
    if (!recalcModal || recalcBusy) return;
    const targetBranches = recalcModal.branches || [];
    if (targetBranches.length === 0) return;

    setRecalcBusy(true);
    setRecalcLog([]);
    setRecalcDone(false);
    setRecalcProgress({ current: 0, total: 0 });
    const log = [];
    const isMulti = targetBranches.length > 1;
    try {
      const ceilTo10 = (n) => Math.ceil(n / 10) * 10;

      // Gather entries for all selected branches so we can drive one progress bar
      const perBranch = targetBranches.map(({ id, name }) => ({
        id, name,
        entries: entries.filter(e => e.branch_id === id && e.date >= recalcFrom && e.date <= recalcTo),
      }));
      const totalEntries = perBranch.reduce((s, x) => s + x.entries.length, 0);

      if (totalEntries === 0) {
        log.push({ type: "info", text: "No entries found in the selected range." });
        setRecalcLog(log);
        setRecalcDone(true);
        setRecalcBusy(false);
        toast({ title: "Nothing to Sync", message: "No entries exist in the selected date range.", type: "warning" });
        return;
      }

      setRecalcProgress({ current: 0, total: totalEntries });

      let updated = 0;
      let processed = 0;

      for (const { id: branchId, name: branchName, entries: branchEntries } of perBranch) {
        const branch = branches.find(b => b.id === branchId);
        const isUnisex = (branch?.type || "").toLowerCase() === "unisex";

        const getRate = (sid) => {
          const s = staff.find(x => x.id === sid);
          if (s?.incentive_pct !== undefined && s.incentive_pct !== null) return Number(s.incentive_pct);
          if (globalSettings) return isUnisex ? (globalSettings.unisex_inc ?? 10) : (globalSettings.mens_inc ?? 10);
          return 10;
        };

        const getMatExp = (date) => {
          return materialAllocations
            .filter(a => a.branch_id === branchId && a.date === date)
            .reduce((s, a) => s + (Number(a.total) || 0), 0);
        };

        if (branchEntries.length === 0) {
          if (isMulti) {
            log.push({ type: "info", text: `${branchName}: no entries in range`, details: [] });
            setRecalcLog([...log]);
          }
          continue;
        }

        if (isMulti) {
          log.push({ type: "info", text: `— ${branchName} (${branchEntries.length} entries) —`, details: [] });
          setRecalcLog([...log]);
        }

        for (let i = 0; i < branchEntries.length; i++) {
          const entry = branchEntries[i];
          processed++;
          setRecalcProgress({ current: processed, total: totalEntries });
          const changes = {};
          let changed = false;
          const details = [];

          if (entry.staff_billing?.length > 0) {
            const newBilling = entry.staff_billing.map(sb => {
              const billing = Number(sb.billing) || 0;
              const material = Number(sb.material) || 0;
              const tips = Number(sb.tips) || 0;
              const rate = getRate(sb.staff_id);
              const newInc = ceilTo10(billing * rate / 100);
              const newMatInc = ceilTo10(material * 0.05);

              const s = staff.find(x => x.id === sb.staff_id);
              const role = (s?.role || "").toLowerCase();
              const defaultTaken = isUnisex ? (role.includes("hairdresser") || role.includes("hair dresser")) : true;
              const taken = sb.incentive_taken !== undefined ? sb.incentive_taken : defaultTaken;

              const newTotalInc = Math.round(newInc + newMatInc + tips);
              return {
                ...sb,
                incentive: newInc,
                mat_incentive: newMatInc,
                staff_total_inc: newTotalInc,
                incentive_taken: taken,
              };
            });
            changes.staff_billing = newBilling;
            changed = true;
            details.push("incentives recalculated");
          }

          const matExp = getMatExp(entry.date);
          if (matExp > 0 && matExp !== (Number(entry.mat_expense) || 0)) {
            changes.mat_expense = matExp;
            changed = true;
            details.push(`material: ${INR(Number(entry.mat_expense) || 0)} → ${INR(matExp)}`);
          }

          // Intentionally NO sync from daily_expenses into entry.others.
          // entry.others = Other Expenses paid out of branch cash on the day.
          // daily_expenses = HO-paid operational expenses, tracked centrally.
          // Older versions copied daily_expenses → entry.others which double-counted
          // the same money in P&L (variable cost + branch cash deduction). The
          // Daily Expenses card on the form is informational only; its total flows
          // through Operational Expenses, not through entry.others.

          // Recompute cash-in-hand against the canonical form formula.
          // Mirrors computeCashInHand in lib/calculations.js; kept inline
          // here because we already have `changes.*` in scope and want to
          // log the delta against the stored value.
          {
            const sbForCih = changes.staff_billing || entry.staff_billing || [];
            const totalBilling = sbForCih.reduce((s, sb) => s + (Number(sb.billing) || 0), 0);
            const totalMatSale = sbForCih.reduce((s, sb) => s + (Number(sb.material) || 0), 0);
            const totalSales = totalBilling + totalMatSale;
            const online = Number(entry.online) || 0;
            // Prefer cash stored on the entry; fall back to derived.
            const cashFromEntry = entry.cash !== undefined ? Number(entry.cash) || 0 : Math.max(0, totalSales - online);
            const takenInc = sbForCih.reduce((s, sb) => {
              if (sb.incentive_taken === false) return s;
              const isUnisex = (branch?.type || "").toLowerCase() === "unisex";
              let taken = true;
              if (sb.incentive_taken !== undefined) {
                taken = sb.incentive_taken !== false;
              } else {
                const staffRec = staff.find(x => x.id === sb.staff_id);
                const role = (staffRec?.role || "").toLowerCase();
                taken = isUnisex ? (role.includes("hairdresser") || role.includes("hair dresser")) : true;
              }
              return taken ? s + (Number(sb.incentive) || 0) + (Number(sb.mat_incentive) || 0) : s;
            }, 0);
            const tipsPaidCash = sbForCih.reduce((s, sb) => {
              const t = Number(sb.tips) || 0;
              return (sb.tip_paid || "cash") === "cash" ? s + t : s;
            }, 0);
            const tipsInCash = sbForCih.reduce((s, sb) => {
              const t = Number(sb.tips) || 0;
              return (sb.tip_in || "online") === "cash" ? s + t : s;
            }, 0);
            const effectiveOthers = changes.others !== undefined ? Number(changes.others) || 0 : Number(entry.others) || 0;
            const effectivePetrol = Number(entry.petrol) || 0;
            const newCih = Math.round(cashFromEntry + tipsInCash - tipsPaidCash - takenInc - effectiveOthers - effectivePetrol);
            const prevCih = entry.cash_in_hand;
            if (prevCih === undefined || Math.round(prevCih) !== newCih) {
              changes.cash_in_hand = newCih;
              changed = true;
              details.push(prevCih === undefined
                ? `cash-in-hand: — → ${INR(newCih)}`
                : `cash-in-hand: ${INR(prevCih)} → ${INR(newCih)}`);
            }

            // Re-derive cash_diff against whatever actual_cash is on file so a
            // re-run keeps Def/Exc in sync with the freshly computed expected.
            const actualStored = entry.actual_cash;
            const newCashDiff = (actualStored === null || actualStored === undefined || actualStored === "")
              ? null
              : Math.round((Number(actualStored) || 0) - newCih);
            const prevCashDiff = entry.cash_diff === undefined ? null : entry.cash_diff;
            if (prevCashDiff !== newCashDiff) {
              changes.cash_diff = newCashDiff;
              changed = true;
              const fmt = v => v === null ? "—" : (v > 0 ? `▲ ${INR(v)}` : v < 0 ? `▼ ${INR(Math.abs(v))}` : "✓ Match");
              details.push(`def/exc: ${fmt(prevCashDiff)} → ${fmt(newCashDiff)}`);
            }
          }

          const prefix = isMulti ? `${branchName} ${entry.date}` : entry.date;
          if (changed) {
            changes.recalculated_at = new Date().toISOString();
            changes.recalculated_by = currentUser?.name || "user";
            await updateDoc(doc(db, "entries", entry.id), changes);
            updated++;
            log.push({ type: "synced", text: `${prefix}: synced`, details });
          } else {
            log.push({ type: "skip", text: `${prefix}: already in sync` });
          }
          setRecalcLog([...log]);
        }
      }

      setRecalcDone(true);
      const scope = isMulti ? ` across ${targetBranches.length} branches` : "";
      if (updated === 0) {
        toast({ title: "Already in Sync", message: `All ${totalEntries} entries${scope} are up to date.`, type: "info" });
      } else {
        toast({ title: "Sync Complete", message: `${updated} of ${totalEntries} entries synced${scope}.`, type: "success" });
      }
    } catch (err) {
      toast({ title: "Error", message: err.message, type: "error" });
      log.push({ type: "error", text: `Error: ${err.message}`, details: [] });
      setRecalcLog([...log]);
      setRecalcDone(true);
    } finally {
      setRecalcBusy(false);
    }
  };

  if (loading) return <VLoader fullscreen label="Loading branches" />;

  // ── Standalone Attendance Calendar Modal (rendered from both views) ───
  const attBranch = attendanceCalendar ? branches.find(x => x.id === attendanceCalendar) : null;
  const attendanceModalEl = attBranch && attendanceMonth ? (() => {
    const [yr, mo] = attendanceMonth.split("-").map(Number);
    const daysInMonth = new Date(yr, mo, 0).getDate();
    const firstDow = new Date(yr, mo - 1, 1).getDay();
    const todayStr = new Date().toISOString().slice(0, 10);
    const isCurrentMonth = NOW.getFullYear() === yr && NOW.getMonth() + 1 === mo;
    const cutoff = isCurrentMonth
      ? new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 1).toISOString().slice(0, 10)
      : null;
    const branchEntries = entries.filter(e => e.branch_id === attBranch.id && e.date && e.date.startsWith(attendanceMonth));
    const staffById = new Map(staff.map(st => [st.id, st]));

    const perDay = (dateStr) => {
      // Build present/loan from the day's entry. Track who demonstrably worked
      // (any billing / material / tips > 0) — actual work overrides any leave
      // record that may have been filed by mistake.
      const entry = branchEntries.find(e => e.date === dateStr);
      const present = [], loan = [];
      const workedIds = new Set();
      if (entry) {
        (entry.staff_billing || []).forEach(sb => {
          if (sb.present === false) return;
          const hasWork = (sb.billing || 0) > 0 || (sb.material || 0) > 0 || (sb.tips || 0) > 0;
          if (hasWork) workedIds.add(sb.staff_id);
          const staffRec = staffById.get(sb.staff_id);
          const item = {
            id: sb.staff_id,
            name: staffRec?.name || sb.staff_name || "Staff",
            role: staffRec?.role || "",
            billing: sb.billing || 0,
          };
          if (sb.loan_flag) loan.push(item); else present.push(item);
        });
      }
      // Priority: actual work wins over leave. Staff who clocked work stay in
      // present/loan and are dropped from the leave list. Staff with a leave
      // but no work are treated as on-leave and removed from present/loan.
      const approvedLeaves = leaves
        .filter(l => l.date === dateStr && (l.status === "approved" || !l.status) && staffById.get(l.staff_id)?.branch_id === attBranch.id)
        .filter(l => !workedIds.has(l.staff_id))
        .map(l => ({ id: l.staff_id, name: staffById.get(l.staff_id)?.name || "Staff", type: l.type || "Paid" }));
      const onLeaveIds = new Set(approvedLeaves.map(l => l.id));
      return {
        present: present.filter(p => !onLeaveIds.has(p.id)),
        loan: loan.filter(p => !onLeaveIds.has(p.id)),
        approvedLeaves,
      };
    };

    // True day collection = the entry's online + cash + material sale — the
    // same "business" definition the Collection Trend chart uses, so the
    // calendar's per-day figure reconciles with the rest of the branch view.
    const dayBusiness = (dateStr) => {
      const entry = branchEntries.find(e => e.date === dateStr);
      if (!entry) return 0;
      const mat = (entry.staff_billing || []).reduce((s, sb) => s + (sb.material || 0), 0);
      return (entry.online || 0) + (entry.cash || 0) + mat;
    };
    // Compact ₹ for the tight day cells (₹38k / ₹1.8L).
    const fmtShort = (v) => v >= 100000 ? `₹${(v / 100000).toFixed(1)}L` : v >= 1000 ? `₹${Math.round(v / 1000)}k` : v > 0 ? `₹${v}` : "";

    const blanks = Array(firstDow).fill(null);
    const days = Array.from({ length: daysInMonth }, (_, i) => `${attendanceMonth}-${String(i + 1).padStart(2, "0")}`);

    const activeDay = attendanceSelectedDay && attendanceSelectedDay.startsWith(attendanceMonth) ? attendanceSelectedDay : null;
    const activeRoster = activeDay ? perDay(activeDay) : null;

    // Month nav
    const prevMonth = () => {
      const d = new Date(yr, mo - 2, 1);
      setAttendanceMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      setAttendanceSelectedDay(null);
      setAttChip(null);
    };
    const nextMonth = () => {
      const d = new Date(yr, mo, 1);
      setAttendanceMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
      setAttendanceSelectedDay(null);
      setAttChip(null);
    };

    // Month totals for header summary + the right-panel "till now" card.
    const monthTotals = days.reduce((acc, d) => {
      if (cutoff && d > cutoff) return acc;
      const { present, loan, approvedLeaves } = perDay(d);
      acc.present += present.length;
      acc.loan += loan.length;
      acc.leave += approvedLeaves.length;
      const biz = dayBusiness(d);
      acc.business += biz;
      if (present.length + loan.length > 0 || biz > 0) acc.activeDays += 1;
      if (biz > acc.bestVal) { acc.bestVal = biz; acc.bestDay = d; }
      return acc;
    }, { present: 0, loan: 0, leave: 0, activeDays: 0, business: 0, bestDay: null, bestVal: 0 });

    // Every approved-leave occurrence this month (till cutoff), newest first —
    // fed to the right panel so leave dates are visible at a glance.
    const monthLeaves = days
      .filter(d => !(cutoff && d > cutoff))
      .flatMap(d => perDay(d).approvedLeaves.map(l => ({ date: d, name: l.name, type: l.type })))
      .sort((a, b) => b.date.localeCompare(a.date));

    // Per-chip month aggregations — drive the clickable header chips. Present /
    // loaned are rolled up per staff (days worked + billing); active + business
    // are per-day. All respect the capture cutoff.
    const presentAgg = new Map();  // id → { name, role, days, billing }
    const loanAgg = new Map();     // id → { name, days, billing, homeName }
    const dayList = [];            // { date, business, present, loan }
    days.forEach(d => {
      if (cutoff && d > cutoff) return;
      const { present, loan } = perDay(d);
      present.forEach(p => {
        const a = presentAgg.get(p.id) || { name: p.name, role: p.role, days: 0, billing: 0 };
        a.days += 1; a.billing += p.billing || 0; presentAgg.set(p.id, a);
      });
      loan.forEach(p => {
        const homeName = (branches.find(x => x.id === staffById.get(p.id)?.branch_id)?.name || "").replace("V-CUT ", "");
        const a = loanAgg.get(p.id) || { name: p.name, days: 0, billing: 0, homeName };
        a.days += 1; a.billing += p.billing || 0; loanAgg.set(p.id, a);
      });
      const biz = dayBusiness(d);
      if (present.length + loan.length > 0 || biz > 0) dayList.push({ date: d, business: biz, present: present.length, loan: loan.length });
    });
    const presentList = [...presentAgg.values()].sort((a, b) => b.days - a.days || b.billing - a.billing);
    const loanList = [...loanAgg.values()].sort((a, b) => b.days - a.days || b.billing - a.billing);
    const activeDaysList = [...dayList].sort((a, b) => a.date.localeCompare(b.date));
    const businessList = [...dayList].filter(x => x.business > 0).sort((a, b) => b.business - a.business);

    const LEAVE_HEX = "#c084fc"; // violet-400 — distinct from accent/blue
    const LEAVE_BG = "rgba(192,132,252,0.10)";
    const LEAVE_BORDER = "rgba(192,132,252,0.35)";

    return (
      <div onClick={() => { setAttendanceCalendar(null); setAttendanceSelectedDay(null); setAttChip(null); }}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.78)", backdropFilter: "blur(10px)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, overflowY: "auto" }}>
        <div onClick={e => e.stopPropagation()}
          style={{ background: "linear-gradient(180deg, var(--bg2) 0%, var(--bg1) 100%)", border: "1px solid var(--border)", borderRadius: 22, width: "100%", maxWidth: 1120, maxHeight: "92vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 30px 60px -15px rgba(0,0,0,0.75), 0 0 0 1px rgba(34,211,238,0.05)" }}>

          {/* Header with gradient accent bar */}
          <div style={{ position: "relative", padding: "22px 28px 20px", borderBottom: "1px solid var(--border)", background: "linear-gradient(135deg, rgba(34,211,238,0.06) 0%, rgba(192,132,252,0.04) 50%, rgba(251,146,60,0.04) 100%)" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "linear-gradient(90deg, var(--accent) 0%, #c084fc 50%, var(--orange) 100%)" }} />
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ width: 44, height: 44, borderRadius: 12, background: "linear-gradient(135deg, rgba(34,211,238,0.18), rgba(34,211,238,0.04))", border: "1px solid rgba(34,211,238,0.35)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent)" }}>
                  <Icon name="checkCircle" size={22} />
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 2 }}>Attendance Calendar</div>
                  <div style={{ fontSize: 19, fontWeight: 800, color: "var(--gold)", letterSpacing: 0.3, lineHeight: 1.2, marginTop: 2 }}>{attBranch.name}</div>
                </div>
              </div>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <button onClick={prevMonth} title="Previous month"
                  style={{ width: 34, height: 34, borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text2)", cursor: "pointer", fontSize: 16, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", transition: "all .15s" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--bg4)"; e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "var(--bg3)"; e.currentTarget.style.color = "var(--text2)"; }}>‹</button>
                <div style={{ minWidth: 170, textAlign: "center", fontSize: 15, fontWeight: 800, color: "var(--text)", letterSpacing: 0.3, fontFamily: "var(--font-headline, var(--font-outfit))" }}>
                  {new Date(yr, mo - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" })}
                </div>
                <button onClick={nextMonth} title="Next month"
                  style={{ width: 34, height: 34, borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text2)", cursor: "pointer", fontSize: 16, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", transition: "all .15s" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "var(--bg4)"; e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "var(--bg3)"; e.currentTarget.style.color = "var(--text2)"; }}>›</button>
                <button onClick={() => { setAttendanceCalendar(null); setAttendanceSelectedDay(null); setAttChip(null); }} title="Close"
                  style={{ marginLeft: 8, width: 34, height: 34, borderRadius: 10, background: "transparent", border: "1px solid var(--border)", color: "var(--text3)", cursor: "pointer", fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", transition: "all .15s" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "rgba(239,68,68,0.10)"; e.currentTarget.style.color = "var(--red)"; e.currentTarget.style.borderColor = "rgba(239,68,68,0.35)"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text3)"; e.currentTarget.style.borderColor = "var(--border)"; }}>✕</button>
              </div>
            </div>

            {/* Summary stat strip — each chip is a toggle that drives the right
                panel's month breakdown. Click again (or the active chip) to clear. */}
            {(() => {
              const onChip = (key) => { setAttChip(c => c === key ? null : key); setAttendanceSelectedDay(null); };
              const chip = (key, dot, label, value, hex, activeBg, activeBorder, disabled = false) => {
                const active = attChip === key;
                return (
                  <button key={key} onClick={disabled ? undefined : () => onChip(key)}
                    title={disabled ? "Nothing to show" : active ? "Click to clear" : `Show ${label.toLowerCase()} breakdown`}
                    style={{
                      padding: "6px 12px", borderRadius: 8, display: "inline-flex", alignItems: "center", gap: 6,
                      background: active ? activeBg : "var(--bg3)",
                      border: `1px solid ${active ? activeBorder : "var(--border2)"}`,
                      boxShadow: active ? `0 0 0 1px ${activeBorder}, 0 4px 14px -6px ${activeBorder}` : "none",
                      cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1,
                      transition: "all .15s", fontFamily: "inherit",
                    }}>
                    {dot}
                    <span style={{ fontSize: 10, fontWeight: 700, color: active ? hex : "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>{label}</span>
                    <span style={{ fontSize: 13, fontWeight: 800, color: hex }}>{value}</span>
                    {active && <span style={{ fontSize: 11, color: hex, fontWeight: 900, marginLeft: 1 }}>✕</span>}
                  </button>
                );
              };
              const dot = (c) => <span style={{ width: 6, height: 6, borderRadius: 3, background: c }} />;
              return (
                <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
                  {chip("present", dot("var(--green)"), "Present", monthTotals.present, "var(--green)", "rgba(74,222,128,0.14)", "rgba(74,222,128,0.5)", monthTotals.present === 0)}
                  {chip("loan", dot("var(--orange)"), "Loaned", monthTotals.loan, "var(--orange)", "rgba(251,146,60,0.14)", "rgba(251,146,60,0.5)", monthTotals.loan === 0)}
                  {chip("leave", <Icon name="moon" size={11} />, "On Leave", monthTotals.leave, LEAVE_HEX, LEAVE_BG, LEAVE_BORDER, monthTotals.leave === 0)}
                  {chip("active", null, "Active Days", monthTotals.activeDays, "var(--text)", "rgba(255,255,255,0.08)", "var(--border2)", monthTotals.activeDays === 0)}
                  {chip("business", null, `Business${cutoff ? " · till now" : ""}`, INR(monthTotals.business), "var(--accent)", "rgba(34,211,238,0.14)", "rgba(34,211,238,0.5)", monthTotals.business === 0)}
                </div>
              );
            })()}
          </div>

          {/* Body: calendar grid + right roster */}
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", gap: 22, padding: 22, overflowY: "auto" }}>
            {/* Calendar grid */}
            <div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6, fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, textAlign: "center", marginBottom: 8, paddingBottom: 8, borderBottom: "1px dashed var(--border)" }}>
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => <div key={d}>{d}</div>)}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
                {blanks.map((_, i) => <div key={`b${i}`} />)}
                {days.map(dateStr => {
                  const isFuture = cutoff && dateStr > cutoff;
                  const { present, loan, approvedLeaves } = perDay(dateStr);
                  const total = present.length + loan.length;
                  const biz = dayBusiness(dateStr);
                  const hasLeave = approvedLeaves.length > 0;
                  const isToday = dateStr === todayStr;
                  const isActive = dateStr === activeDay;
                  // Colour priority: active > future > leave-only > has-activity > empty
                  const baseBg = isActive
                    ? "linear-gradient(135deg, var(--accent) 0%, #0ea5c4 100%)"
                    : isFuture
                      ? "repeating-linear-gradient(45deg, var(--bg4), var(--bg4) 4px, transparent 4px, transparent 8px)"
                      : total > 0
                        ? "linear-gradient(180deg, rgba(74,222,128,0.10), rgba(74,222,128,0.02))"
                        : hasLeave && !total
                          ? `linear-gradient(180deg, ${LEAVE_BG}, rgba(192,132,252,0.02))`
                          : "var(--bg4)";
                  const baseBorder = isActive
                    ? "var(--accent)"
                    : isToday
                      ? "rgba(34,211,238,0.6)"
                      : total > 0
                        ? "rgba(74,222,128,0.28)"
                        : hasLeave
                          ? LEAVE_BORDER
                          : "var(--border)";
                  return (
                    <button key={dateStr}
                      onClick={() => { setAttendanceSelectedDay(dateStr); setAttChip(null); }}
                      style={{
                        aspectRatio: "1 / 1",
                        padding: 8,
                        borderRadius: 12,
                        background: baseBg,
                        border: `1px solid ${baseBorder}`,
                        boxShadow: isActive ? "0 6px 18px -4px rgba(34,211,238,0.5)" : isToday ? "inset 0 0 0 1px rgba(34,211,238,0.25)" : "none",
                        color: isActive ? "#001418" : "var(--text)",
                        cursor: "pointer",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        opacity: isFuture ? 0.42 : 1,
                        fontFamily: "var(--font-headline, var(--font-outfit))",
                        transition: "transform .15s, box-shadow .15s",
                        outline: "none",
                      }}
                      onMouseEnter={e => { if (!isActive && !isFuture) { e.currentTarget.style.transform = "translateY(-1px)"; e.currentTarget.style.boxShadow = "0 4px 12px -2px rgba(0,0,0,0.4)"; } }}
                      onMouseLeave={e => { if (!isActive && !isFuture) { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = isToday ? "inset 0 0 0 1px rgba(34,211,238,0.25)" : "none"; } }}>
                      <div style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center", fontSize: 13, fontWeight: 800 }}>
                        <span>{Number(dateStr.slice(8, 10))}</span>
                        {hasLeave && (
                          <span title={`${approvedLeaves.length} on leave`}
                            style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 9, fontWeight: 800, padding: "1px 5px", borderRadius: 5, background: isActive ? "rgba(0,20,24,0.15)" : LEAVE_BG, color: isActive ? "#001418" : LEAVE_HEX, border: `1px solid ${isActive ? "transparent" : LEAVE_BORDER}` }}>
                            <Icon name="moon" size={9} />{approvedLeaves.length}
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, width: "100%" }}>
                        <div style={{ display: "inline-flex", gap: 4, fontSize: 10, fontWeight: 800 }}>
                          {present.length > 0 && <span style={{ padding: "2px 7px", borderRadius: 5, background: isActive ? "rgba(0,20,24,0.15)" : "rgba(74,222,128,0.18)", color: isActive ? "#001418" : "var(--green)" }}>{present.length}</span>}
                          {loan.length > 0 && <span style={{ padding: "2px 7px", borderRadius: 5, background: isActive ? "rgba(0,20,24,0.15)" : "rgba(251,146,60,0.18)", color: isActive ? "#001418" : "var(--orange)" }}>+{loan.length}</span>}
                          {!total && !hasLeave && !isFuture && <span style={{ color: "var(--text3)", opacity: 0.5 }}>—</span>}
                        </div>
                        {/* Per-day business (collection). Only shown when there was money in. */}
                        {biz > 0 && (
                          <span style={{ fontSize: 10, fontWeight: 800, color: isActive ? "#001418" : "var(--accent)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{fmtShort(biz)}</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Legend */}
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 14, padding: "10px 14px", background: "var(--bg3)", borderRadius: 10, border: "1px solid var(--border)" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text3)" }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--green)" }} />
                  <span style={{ color: "var(--text2)", fontWeight: 600 }}>Home-branch</span>
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text3)" }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--orange)" }} />
                  <span style={{ color: "var(--text2)", fontWeight: 600 }}>Loaned in</span>
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text3)" }}>
                  <span style={{ color: LEAVE_HEX, display: "inline-flex" }}><Icon name="moon" size={11} /></span>
                  <span style={{ color: "var(--text2)", fontWeight: 600 }}>On leave</span>
                </span>
                {cutoff && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text3)" }}>
                    <span style={{ width: 14, height: 10, borderRadius: 2, backgroundImage: "repeating-linear-gradient(45deg, var(--bg4), var(--bg4) 3px, transparent 3px, transparent 6px)", border: "1px solid var(--border2)" }} />
                    <span style={{ color: "var(--text2)", fontWeight: 600 }}>After <strong style={{ color: "var(--text2)" }}>{cutoff}</strong> — not captured</span>
                  </span>
                )}
              </div>
            </div>

            {/* Right — chip breakdown > selected-day roster > month summary */}
            <div style={{ borderLeft: "1px solid var(--border)", paddingLeft: 22 }}>
              {attChip ? (
                (() => {
                  const head = (title, color, total) => (
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 10 }}>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 800, color, textTransform: "uppercase", letterSpacing: 1.5 }}>{title}</div>
                        {total != null && <div style={{ fontSize: 17, fontWeight: 900, color: "var(--text)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{total}</div>}
                      </div>
                      <button onClick={() => setAttChip(null)} title="Clear"
                        style={{ padding: "5px 10px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text3)", fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, cursor: "pointer" }}>✕ Clear</button>
                    </div>
                  );
                  const empty = (msg) => <div style={{ padding: 24, textAlign: "center", color: "var(--text3)", fontSize: 12, fontStyle: "italic", background: "var(--bg3)", border: "1px dashed var(--border2)", borderRadius: 12 }}>{msg}</div>;
                  const dayLabel = (d) => `${Number(d.slice(8, 10))} ${new Date(yr, mo - 1, 1).toLocaleString("en-US", { month: "short" })}`;
                  const avatar = (letter, col, bg, bd) => <div style={{ width: 32, height: 32, borderRadius: 9, background: bg, color: col, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 13, border: `1px solid ${bd}`, flexShrink: 0 }}>{letter}</div>;
                  const rowWrap = { display: "flex", flexDirection: "column", gap: 6, maxHeight: 440, overflowY: "auto" };

                  if (attChip === "present") {
                    return (
                      <div>
                        {head("Present · home-branch", "var(--green)", `${presentList.length} staff · ${monthTotals.present} shifts`)}
                        {presentList.length === 0 ? empty("No present staff this month.") : (
                          <div style={rowWrap}>
                            {presentList.map(p => (
                              <div key={p.name} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", background: "linear-gradient(180deg, rgba(74,222,128,0.07), rgba(74,222,128,0.02))", border: "1px solid rgba(74,222,128,0.22)", borderLeft: "3px solid var(--green)", borderRadius: 10 }}>
                                {avatar(p.name[0], "var(--green)", "rgba(74,222,128,0.14)", "rgba(74,222,128,0.25)")}
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                                  <div style={{ fontSize: 10, color: "var(--text3)" }}>{p.days} day{p.days === 1 ? "" : "s"}{p.role ? ` · ${p.role}` : ""}</div>
                                </div>
                                {p.billing > 0 && <span style={{ fontSize: 12, fontWeight: 800, color: "var(--green)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(p.billing)}</span>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  }
                  if (attChip === "loan") {
                    return (
                      <div>
                        {head("Loaned in", "var(--orange)", `${loanList.length} staff · ${monthTotals.loan} shifts`)}
                        {loanList.length === 0 ? empty("No loaned-in staff this month.") : (
                          <div style={rowWrap}>
                            {loanList.map(p => (
                              <div key={p.name} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", background: "linear-gradient(180deg, rgba(251,146,60,0.07), rgba(251,146,60,0.02))", border: "1px solid rgba(251,146,60,0.25)", borderLeft: "3px solid var(--orange)", borderRadius: 10 }}>
                                {avatar(p.name[0], "var(--orange)", "rgba(251,146,60,0.14)", "rgba(251,146,60,0.25)")}
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                                  <div style={{ fontSize: 10, color: "var(--orange)", fontWeight: 700 }}>{p.days} day{p.days === 1 ? "" : "s"}{p.homeName ? ` · Home: ${p.homeName}` : ""}</div>
                                </div>
                                {p.billing > 0 && <span style={{ fontSize: 12, fontWeight: 800, color: "var(--orange)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(p.billing)}</span>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  }
                  if (attChip === "leave") {
                    return (
                      <div>
                        {head("On leave", LEAVE_HEX, `${monthLeaves.length} leave${monthLeaves.length === 1 ? "" : "s"}`)}
                        {monthLeaves.length === 0 ? empty("No leaves this month.") : (
                          <div style={rowWrap}>
                            {monthLeaves.map((l, i) => (
                              <div key={`${l.date}-${l.name}-${i}`} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 12px", background: LEAVE_BG, border: `1px solid ${LEAVE_BORDER}`, borderLeft: `3px solid ${LEAVE_HEX}`, borderRadius: 10 }}>
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                                  {avatar(<Icon name="moon" size={14} />, LEAVE_HEX, "rgba(192,132,252,0.14)", LEAVE_BORDER)}
                                  <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</span>
                                </span>
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                                  <span style={{ fontSize: 9, fontWeight: 700, color: LEAVE_HEX, textTransform: "uppercase" }}>{l.type}</span>
                                  <span style={{ fontSize: 11, fontWeight: 800, color: "var(--text3)" }}>{dayLabel(l.date)}</span>
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  }
                  // active + business — both are per-day lists
                  const rows = attChip === "business" ? businessList : activeDaysList;
                  return (
                    <div>
                      {attChip === "business"
                        ? head(`Business${cutoff ? " · till now" : ""}`, "var(--accent)", INR(monthTotals.business))
                        : head("Active days", "var(--text)", `${monthTotals.activeDays} day${monthTotals.activeDays === 1 ? "" : "s"}`)}
                      {rows.length === 0 ? empty("No days to show.") : (
                        <div style={rowWrap}>
                          {rows.map(d => (
                            <button key={d.date} onClick={() => { setAttendanceSelectedDay(d.date); setAttChip(null); }}
                              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 12px", background: "var(--bg3)", border: "1px solid var(--border)", borderLeft: "3px solid var(--accent)", borderRadius: 10, cursor: "pointer", textAlign: "left", width: "100%" }}
                              onMouseEnter={e => e.currentTarget.style.background = "var(--bg4)"}
                              onMouseLeave={e => e.currentTarget.style.background = "var(--bg3)"}>
                              <div>
                                <div style={{ fontSize: 13, fontWeight: 800, color: "var(--text)" }}>{new Date(d.date + "T00:00").toLocaleString("en-US", { weekday: "short", day: "numeric", month: "short" })}</div>
                                <div style={{ fontSize: 10, color: "var(--text3)" }}>{d.present} present{d.loan > 0 ? ` · +${d.loan} loaned` : ""}</div>
                              </div>
                              <span style={{ fontSize: 13, fontWeight: 800, color: "var(--accent)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(d.business)}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()
              ) : activeRoster ? (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1.8 }}>Roster for</div>
                  <div style={{ fontSize: 17, fontWeight: 800, color: "var(--text)", marginBottom: 14, fontFamily: "var(--font-headline, var(--font-outfit))" }}>
                    {new Date(activeDay + "T00:00").toLocaleString("en-US", { weekday: "long", day: "numeric", month: "short", year: "numeric" })}
                  </div>

                  {activeRoster.present.length === 0 && activeRoster.loan.length === 0 && activeRoster.approvedLeaves.length === 0 ? (
                    <div style={{ padding: 24, background: "var(--bg3)", border: "1px dashed var(--border2)", borderRadius: 12, color: "var(--text3)", fontSize: 12, textAlign: "center" }}>
                      <div style={{ fontSize: 24, marginBottom: 6, opacity: 0.5 }}>📭</div>
                      No activity recorded for this day.
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {activeRoster.present.map(p => (
                        <div key={`p-${p.id}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 13px", background: "linear-gradient(180deg, rgba(74,222,128,0.08), rgba(74,222,128,0.02))", border: "1px solid rgba(74,222,128,0.22)", borderLeft: "3px solid var(--green)", borderRadius: 10 }}>
                          <div style={{ width: 34, height: 34, borderRadius: 10, background: "linear-gradient(135deg, rgba(74,222,128,0.2), rgba(74,222,128,0.05))", color: "var(--green)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 14, border: "1px solid rgba(74,222,128,0.25)" }}>{p.name[0]}</div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                            {p.role && <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 1 }}>{p.role}</div>}
                          </div>
                          {p.billing > 0 && <span style={{ fontSize: 12, color: "var(--green)", fontWeight: 800, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(p.billing)}</span>}
                        </div>
                      ))}
                      {activeRoster.loan.map(p => {
                        const homeName = (branches.find(x => x.id === staffById.get(p.id)?.branch_id)?.name || "").replace("V-CUT ", "");
                        return (
                          <div key={`l-${p.id}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 13px", background: "linear-gradient(180deg, rgba(251,146,60,0.08), rgba(251,146,60,0.02))", border: "1px solid rgba(251,146,60,0.25)", borderLeft: "3px solid var(--orange)", borderRadius: 10 }}>
                            <div style={{ width: 34, height: 34, borderRadius: 10, background: "linear-gradient(135deg, rgba(251,146,60,0.2), rgba(251,146,60,0.05))", color: "var(--orange)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 14, border: "1px solid rgba(251,146,60,0.25)" }}>{p.name[0]}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                              <div style={{ fontSize: 10, color: "var(--orange)", fontWeight: 700, letterSpacing: 0.5, marginTop: 1 }}>LOAN{homeName ? ` · Home: ${homeName}` : ""}</div>
                            </div>
                            {p.billing > 0 && <span style={{ fontSize: 12, color: "var(--orange)", fontWeight: 800, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(p.billing)}</span>}
                          </div>
                        );
                      })}
                      {activeRoster.approvedLeaves.map(l => (
                        <div key={`lv-${l.id}`} style={{ position: "relative", display: "flex", alignItems: "center", gap: 12, padding: "11px 13px", background: `linear-gradient(180deg, ${LEAVE_BG}, rgba(192,132,252,0.02))`, border: `1px solid ${LEAVE_BORDER}`, borderLeft: `3px solid ${LEAVE_HEX}`, borderRadius: 10, opacity: 0.95 }}>
                          <div style={{ width: 34, height: 34, borderRadius: 10, background: "linear-gradient(135deg, rgba(192,132,252,0.22), rgba(192,132,252,0.05))", color: LEAVE_HEX, display: "flex", alignItems: "center", justifyContent: "center", border: `1px solid ${LEAVE_BORDER}` }}>
                            <Icon name="moon" size={16} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</div>
                            <div style={{ fontSize: 10, color: LEAVE_HEX, fontWeight: 700, letterSpacing: 0.4, marginTop: 1 }}>ON LEAVE · {l.type}</div>
                          </div>
                          <span style={{ fontSize: 9, fontWeight: 800, padding: "3px 8px", borderRadius: 6, background: LEAVE_BG, color: LEAVE_HEX, border: `1px solid ${LEAVE_BORDER}`, textTransform: "uppercase", letterSpacing: 0.8 }}>Off</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Total Business — the day's collection (online + cash + material),
                      plus staff-billed context and the running month-to-date total. */}
                  {(() => {
                    const dayColl = dayBusiness(activeDay);
                    const staffBill =
                      activeRoster.present.reduce((s, p) => s + (p.billing || 0), 0) +
                      activeRoster.loan.reduce((s, p) => s + (p.billing || 0), 0);
                    const headCount = activeRoster.present.length + activeRoster.loan.length;
                    if (headCount === 0 && dayColl === 0 && staffBill === 0) return null;
                    return (
                      <div style={{ marginTop: 14, padding: "12px 14px", borderRadius: 12, background: "linear-gradient(135deg, rgba(74,222,128,0.08), rgba(74,222,128,0.02))", border: "1px solid rgba(74,222,128,0.3)", display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                          <div>
                            <div style={{ fontSize: 10, fontWeight: 800, color: "var(--green)", textTransform: "uppercase", letterSpacing: 1.2 }}>Day Business</div>
                            <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>{headCount} staff billed · {INR(staffBill)} attributed</div>
                          </div>
                          <div style={{ fontSize: 18, fontWeight: 800, color: "var(--green)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(dayColl)}</div>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, paddingTop: 8, borderTop: "1px dashed rgba(255,255,255,0.10)" }}>
                          <span style={{ fontSize: 10, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1.2 }}>Month{cutoff ? " · till now" : ""}</span>
                          <span style={{ fontSize: 14, fontWeight: 800, color: "var(--accent)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(monthTotals.business)}</span>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1.8 }}>
                    {new Date(yr, mo - 1, 1).toLocaleString("en-US", { month: "long" })} · {cutoff ? "Till Now" : "Full Month"}
                  </div>

                  {/* Total business so far this month */}
                  <div style={{ padding: "16px 16px", borderRadius: 14, background: "linear-gradient(135deg, rgba(34,211,238,0.10), rgba(34,211,238,0.02))", border: "1px solid rgba(34,211,238,0.3)" }}>
                    <div style={{ fontSize: 10, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1.2 }}>Total Business{cutoff ? " · till now" : ""}</div>
                    <div style={{ fontSize: 26, fontWeight: 900, color: "var(--accent)", fontFamily: "var(--font-headline, var(--font-outfit))", marginTop: 2 }}>{INR(monthTotals.business)}</div>
                    <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>
                      {monthTotals.activeDays} active day{monthTotals.activeDays === 1 ? "" : "s"}
                      {monthTotals.activeDays > 0 && ` · avg ${INR(Math.round(monthTotals.business / monthTotals.activeDays))}/day`}
                    </div>
                  </div>

                  {/* Attendance tallies */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <MiniTally label="Present" value={monthTotals.present} color="var(--green)" />
                    <MiniTally label="Loaned in" value={monthTotals.loan} color="var(--orange)" />
                    <MiniTally label="On leave" value={monthTotals.leave} color={LEAVE_HEX} />
                    <MiniTally label="Best day" value={monthTotals.bestDay ? fmtShort(monthTotals.bestVal) : "—"} color="var(--gold)" sub={monthTotals.bestDay ? `${Number(monthTotals.bestDay.slice(8, 10))} ${new Date(yr, mo - 1, 1).toLocaleString("en-US", { month: "short" })}` : ""} />
                  </div>

                  {/* Leave dates this month */}
                  {monthLeaves.length > 0 && (
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 800, color: LEAVE_HEX, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 6, display: "inline-flex", alignItems: "center", gap: 5 }}>
                        <Icon name="moon" size={11} /> Leaves ({monthLeaves.length})
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 180, overflowY: "auto" }}>
                        {monthLeaves.map((l, i) => (
                          <div key={`${l.date}-${l.name}-${i}`} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "7px 10px", borderRadius: 8, background: LEAVE_BG, border: `1px solid ${LEAVE_BORDER}` }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</span>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                              <span style={{ fontSize: 9, fontWeight: 700, color: LEAVE_HEX, textTransform: "uppercase" }}>{l.type}</span>
                              <span style={{ fontSize: 11, fontWeight: 800, color: "var(--text3)" }}>{Number(l.date.slice(8, 10))} {new Date(yr, mo - 1, 1).toLocaleString("en-US", { month: "short" })}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div style={{ padding: "14px 12px", textAlign: "center", color: "var(--text3)", fontSize: 11, background: "var(--bg3)", border: "1px dashed var(--border2)", borderRadius: 12 }}>
                    👆 Click any day for its full roster & business.
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  })() : null;

  // ── Recalculate Modal (shared between detail and list views) ────
  const recalcModalEl = recalcModal ? (
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(6px)", zIndex: 1100, display: "flex", justifyContent: "center", alignItems: "center", padding: 16 }}>
      <div style={{ width: "100%", maxWidth: 560, background: "var(--bg2)", borderRadius: 16, overflow: "hidden", boxShadow: "0 24px 80px rgba(0,0,0,0.5)" }}>
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        <div style={{ padding: "20px 24px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: "var(--text)" }}>
            {recalcModal.branches.length === 1
              ? `Recalculate — ${recalcModal.branches[0].name}`
              : `Recalculate — ${recalcModal.branches.length} branches`}
          </div>
          {recalcModal.branches.length > 1 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {recalcModal.branches.map(b => (
                <span key={b.id} style={{ fontSize: 10, padding: "3px 8px", borderRadius: 6, background: "var(--bg4)", color: "var(--text2)", fontWeight: 600 }}>{b.name}</span>
              ))}
            </div>
          )}
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 4 }}>
            Recalculates incentives (ceil-to-10, per-staff rate, daily/period defaults), updates material expense from allocations, and other expenses from online expense paid.
          </div>
        </div>
        <div style={{ padding: "16px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>From Date</label>
              <input type="date" value={recalcFrom} onChange={e => setRecalcFrom(e.target.value)} disabled={recalcBusy}
                style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, marginTop: 4, opacity: recalcBusy ? 0.5 : 1 }} />
            </div>
            <div>
              <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>To Date</label>
              <input type="date" value={recalcTo} onChange={e => setRecalcTo(e.target.value)} disabled={recalcBusy}
                style={{ width: "100%", padding: "10px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, marginTop: 4, opacity: recalcBusy ? 0.5 : 1 }} />
            </div>
          </div>

          {/* Progress bar while busy */}
          {recalcBusy && recalcProgress.total > 0 && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)" }}>Syncing entries…</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)" }}>{recalcProgress.current} / {recalcProgress.total}</span>
              </div>
              <div style={{ width: "100%", height: 6, borderRadius: 3, background: "var(--bg4)", overflow: "hidden" }}>
                <div style={{ height: "100%", borderRadius: 3, background: "linear-gradient(90deg, var(--accent), var(--gold2))", transition: "width 0.3s ease", width: `${Math.round((recalcProgress.current / recalcProgress.total) * 100)}%` }} />
              </div>
            </div>
          )}

          {/* Done summary banner */}
          {recalcDone && recalcLog.length > 0 && (() => {
            const synced = recalcLog.filter(l => l.type === "synced").length;
            const skipped = recalcLog.filter(l => l.type === "skip").length;
            const errors = recalcLog.filter(l => l.type === "error").length;
            const isAllInSync = synced === 0 && errors === 0;
            return (
              <div style={{
                padding: "12px 16px", borderRadius: 10, display: "flex", alignItems: "center", gap: 12,
                background: errors > 0 ? "rgba(248,113,113,0.08)" : isAllInSync ? "rgba(96,165,250,0.08)" : "rgba(74,222,128,0.08)",
                border: `1px solid ${errors > 0 ? "rgba(248,113,113,0.2)" : isAllInSync ? "rgba(96,165,250,0.2)" : "rgba(74,222,128,0.2)"}`,
              }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                  background: errors > 0 ? "rgba(248,113,113,0.15)" : isAllInSync ? "rgba(96,165,250,0.15)" : "rgba(74,222,128,0.15)",
                }}>
                  {errors > 0 ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                  ) : isAllInSync ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                  )}
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: errors > 0 ? "var(--red)" : isAllInSync ? "var(--blue, #60a5fa)" : "var(--green)" }}>
                    {errors > 0 ? "Sync Failed" : isAllInSync ? "Already in Sync" : "Sync Complete"}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>
                    {errors > 0 ? "An error occurred during sync."
                      : isAllInSync ? `All ${skipped} entries are already up to date.`
                      : `${synced} synced, ${skipped} already up to date`}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Sync log */}
          {recalcLog.length > 0 && (
            <div style={{ maxHeight: 220, overflowY: "auto", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border)", fontSize: 11 }}>
              <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, position: "sticky", top: 0, background: "var(--bg3)", zIndex: 1 }}>
                Sync Log
              </div>
              {recalcLog.map((l, i) => (
                <div key={i} style={{ padding: "6px 12px", borderBottom: "1px solid rgba(255,255,255,0.03)", display: "flex", alignItems: "flex-start", gap: 8 }}>
                  <span style={{ flexShrink: 0, marginTop: 1 }}>
                    {l.type === "synced" ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                    ) : l.type === "error" ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                    ) : l.type === "info" ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" strokeWidth="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    )}
                  </span>
                  <div style={{ flex: 1 }}>
                    <span style={{ fontFamily: "monospace", color: l.type === "synced" ? "var(--green)" : l.type === "error" ? "var(--red)" : l.type === "info" ? "var(--blue, #60a5fa)" : "var(--text3)" }}>{l.text}</span>
                    {l.details?.length > 0 && (
                      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>
                        {l.details.join(" · ")}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 4 }}>
            <button onClick={() => { setRecalcModal(null); setRecalcLog([]); setRecalcDone(false); }} disabled={recalcBusy}
              style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text3)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: recalcBusy ? "wait" : "pointer" }}>
              {recalcDone ? "Close" : "Cancel"}
            </button>
            {!recalcDone && (
              <button onClick={handleRecalculate} disabled={recalcBusy}
                style={{ padding: "10px 20px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: recalcBusy ? "wait" : "pointer", opacity: recalcBusy ? 0.6 : 1, display: "inline-flex", alignItems: "center", gap: 6 }}>
                {recalcBusy ? (
                  <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: "spin 1s linear infinite" }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Syncing…</>
                ) : (
                  <><Icon name="check" size={13} /> Recalculate</>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  ) : null;

  // ── Admin-only Salary Breakdown modal ──────────────────────────────
  const salaryDetailEl = salaryDetail ? (() => {
    const statusPill = (status) => {
      const map = {
        present: { label: "Present", bg: "rgba(74,222,128,0.12)", fg: "var(--green)", bd: "rgba(74,222,128,0.35)" },
        paid_leave: { label: "Paid Leave", bg: "rgba(96,165,250,0.12)", fg: "var(--blue)", bd: "rgba(96,165,250,0.35)" },
        absent: { label: "Absent", bg: "rgba(248,113,113,0.12)", fg: "var(--red)", bd: "rgba(248,113,113,0.4)" },
        not_active: { label: "Not Active", bg: "rgba(156,163,175,0.08)", fg: "var(--text3)", bd: "rgba(156,163,175,0.25)" },
      };
      const c = map[status] || map.present;
      return (
        <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 9, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", background: c.bg, color: c.fg, border: `1px solid ${c.bd}` }}>{c.label}</span>
      );
    };
    const isDaily = salaryDetail.mode === "month";
    return (
      <Modal isOpen={!!salaryDetail} onClose={() => setSalaryDetail(null)} title="Salary Breakdown" width={700}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
            <div>
              <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
                {salaryDetail.branchName}
              </div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "var(--gold)", marginTop: 2 }}>
                {salaryDetail.label}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
                {isDaily ? "This day's salary (Σ day shares)" : "Monthly salary"}
              </div>
              <div style={{ fontSize: 20, fontWeight: 800, color: "var(--blue)", marginTop: 2 }}>
                {INR(Math.round(isDaily ? salaryDetail.dayTotal : salaryDetail.monthlyTotal))}
              </div>
            </div>
          </div>

          {isDaily && (
            <div style={{ padding: "10px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border)", fontSize: 12, color: "var(--text2)", lineHeight: 1.5 }}>
              <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>How each staff&apos;s day share is computed</div>
              Day share = <strong>base salary ÷ {salaryDetail.daysInMonth}</strong> when the employee is
              <strong style={{ color: "var(--green)" }}> present</strong> or on
              <strong style={{ color: "var(--blue)" }}> paid leave</strong>. Drops to
              <strong style={{ color: "var(--red)" }}> ₹0</strong> on unpaid-leave / absent days.
            </div>
          )}

          <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
            Active staff ({salaryDetail.staffRows.length})
          </div>

          <Card style={{ padding: 0, overflowX: "auto", maxHeight: "50vh" }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
              <thead>
                <tr style={{ background: "var(--bg4)" }}>
                  <TH>Staff</TH>
                  <TH>Role</TH>
                  <TH right>Base Salary</TH>
                  <TH right>Pro-rated</TH>
                  {isDaily && <TH>Status</TH>}
                  {isDaily && <TH right>Day Share</TH>}
                </tr>
              </thead>
              <tbody>
                {salaryDetail.staffRows.length === 0 && (
                  <tr><td colSpan={isDaily ? 6 : 4} style={{ padding: 20, textAlign: "center", color: "var(--text3)", fontSize: 12 }}>No active staff in this month.</td></tr>
                )}
                {salaryDetail.staffRows.map(r => {
                  const isMuted = r.dayStatus === 'absent' || r.dayStatus === 'not_active';
                  return (
                    <tr key={r.id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <TD style={{ fontWeight: 600, color: isMuted ? "var(--text3)" : "var(--text)", textDecoration: isMuted ? "line-through" : "none" }}>{r.name}</TD>
                      <TD style={{ color: "var(--text3)", fontSize: 11 }}>{r.role || "—"}</TD>
                      <TD right style={{ color: "var(--text3)" }}>{INR(r.base)}</TD>
                      <TD right style={{ fontWeight: 700, color: "var(--blue)" }}>{INR(Math.round(r.proRated))}</TD>
                      {isDaily && <TD>{statusPill(r.dayStatus)}</TD>}
                      {isDaily && (
                        <TD right style={{ color: r.dayShare > 0 ? "var(--accent)" : "var(--red)", fontWeight: r.dayShare > 0 ? 700 : 500 }}>
                          {r.dayShare > 0 ? INR(Math.round(r.dayShare)) : "—"}
                        </TD>
                      )}
                    </tr>
                  );
                })}
                {salaryDetail.staffRows.length > 0 && (
                  <tr style={{ background: "var(--bg3)", borderTop: "2px solid var(--border2)", fontWeight: 800 }}>
                    <TD style={{ color: "var(--gold)" }}>TOTAL</TD>
                    <TD></TD>
                    <TD right style={{ color: "var(--text2)" }}>{INR(salaryDetail.staffRows.reduce((s, r) => s + r.base, 0))}</TD>
                    <TD right style={{ color: "var(--blue)" }}>{INR(Math.round(salaryDetail.monthlyTotal))}</TD>
                    {isDaily && <TD></TD>}
                    {isDaily && (
                      <TD right style={{ color: "var(--accent)" }}>{INR(Math.round(salaryDetail.dayTotal))}</TD>
                    )}
                  </tr>
                )}
              </tbody>
            </table>
          </Card>

          <div style={{ fontSize: 11, color: "var(--text3)", lineHeight: 1.5 }}>
            Pro-rated uses each staff&apos;s join/exit dates, mid-month transfers, and approved unpaid leaves.
            Leave quota is the branch type&apos;s monthly allowance (overridden by global settings if set); the
            first N approved leave days of the month are paid, anything beyond is unpaid.
          </div>
        </div>
      </Modal>
    );
  })() : null;

  // ── Branch Detail View ───────────────────────────────────────────
  if (selectedBranch) {
    const b = branches.find(x => x.id === selectedBranch);
    if (!b) { setSelectedBranch(null); return null; }

    // Constants for the entire Detail View
    // Roster must honour active transfers: a staff temporarily transferred to
    // another branch shows under the destination branch (not home) for the period,
    // and borrowed staff show under the host. Resolve each staff's effective branch
    // on a reference date inside the selected period via effectiveBranchOnDate.
    const _ny = NOW.getFullYear(), _nm = NOW.getMonth() + 1, _nd = NOW.getDate();
    let rosterRefDate;
    if (filterMode === "month") {
      const dim = new Date(filterYear, filterMonth, 0).getDate();
      if (filterYear === _ny && filterMonth === _nm) rosterRefDate = `${filterPrefix}-${String(_nd).padStart(2, "0")}`;
      else if (filterYear > _ny || (filterYear === _ny && filterMonth > _nm)) rosterRefDate = `${filterPrefix}-01`;
      else rosterRefDate = `${filterPrefix}-${String(dim).padStart(2, "0")}`;
    } else {
      if (filterYear < _ny) rosterRefDate = `${filterYear}-12-31`;
      else if (filterYear > _ny) rosterRefDate = `${filterYear}-01-01`;
      else rosterRefDate = `${_ny}-${String(_nm).padStart(2, "0")}-${String(_nd).padStart(2, "0")}`;
    }
    const branchStaff = staff.filter(s => effectiveBranchOnDate(s, rosterRefDate, transfers) === b.id);
    const periodEntries = entries.filter(e => e.branch_id === b.id && inPeriod(e.date));

    // Calculate stats based on range (Pro-rata for yearly)
    const isYearly = filterMode === "year";
    const currentYear = NOW.getFullYear();
    const currentMonthNum = NOW.getMonth() + 1;
    const isPastYear = filterYear < currentYear;
    const endMonth = isPastYear ? 12 : ((isYearly && filterYear === currentYear) ? currentMonthNum : (isYearly ? 12 : filterMonth));
    const startMonthStats = isYearly ? 1 : filterMonth; 
    const factor = (endMonth - startMonthStats + 1);
    const breakdownStats = [];
    const isPastMonth = !isPastYear && filterMonth < currentMonthNum;
    const isCurrentMonth = !isPastYear && filterYear === currentYear && filterMonth === currentMonthNum;

    // Material source toggles from global settings — default: allocations only.
    const matUseAllocations = globalSettings?.mat_use_allocations !== false;
    const matUseLumpsum = globalSettings?.mat_use_lumpsum === true;
    const allocsTotal = (arr) => arr.reduce((s, a) => s + (Number(a.total) || (a.items || []).reduce((ss, it) => ss + (Number(it.line_total) || (Number(it.qty) * Number(it.price_at_transfer)) || 0), 0)), 0);

    if (filterMode === "month") {
      const isFutureMonth = (filterYear > currentYear) || (filterYear === currentYear && filterMonth > currentMonthNum);
      const daysCount = new Date(filterYear, filterMonth, 0).getDate();
      const endDay = isFutureMonth ? 0 : (isCurrentMonth ? NOW.getDate() : daysCount);
      const dayFactor = 1 / daysCount;
      const gstPctLocal = globalSettings?.gst_pct || 0;

      // Active staff + month salary are constant for the month — hoist out of the loop.
      const activeStaffInMonth = staff.filter(s => s.branch_id === b.id && staffStatusForMonth(s, filterPrefix).status !== 'inactive');

      // Per-day salary share = Σ (base / daysInMonth) for each staff that was actually present or on
      // paid leave on that specific day. Mirrors the breakdown modal so clicking Salary gives numbers
      // that sum back to this column. The month's quota is consumed chronologically — the first N
      // approved leave days are paid, the rest are LOP (excluded from the share for that day).
      const computeDayShareFor = (dayPrefix) => {
        let share = 0;
        for (const st of activeStaffInMonth) {
          if (st.join && dayPrefix < st.join) continue;
          if (st.exit_date && dayPrefix > st.exit_date) continue;
          const base = Number(st.salary) || 0;
          const stBranch = branches.find(x => x.id === st.branch_id);
          let q = stBranch?.type === 'unisex' ? 3 : 2;
          if (stBranch?.type === 'mens' && globalSettings?.mens_leaves !== undefined) q = globalSettings.mens_leaves;
          if (stBranch?.type === 'unisex' && globalSettings?.unisex_leaves !== undefined) q = globalSettings.unisex_leaves;
          const staffLeaves = leaves.filter(l => l.staff_id === st.id && l.status === 'approved' && l.date?.startsWith(filterPrefix))
            .sort((x, y) => (x.date || '').localeCompare(y.date || ''));
          let paidUsed = 0;
          let onLeave = false, leavePaid = false;
          for (const l of staffLeaves) {
            const days = Number(l.days) || 1;
            const paidHere = Math.min(days, Math.max(0, q - paidUsed));
            if (l.date === dayPrefix) { onLeave = true; leavePaid = paidHere > 0; break; }
            paidUsed += paidHere;
          }
          if (!onLeave || leavePaid) share += base / daysCount;
        }
        return share;
      };

      // Iterate every day in the month. Any day without an entry (past *or* future) renders
      // as a projection row with its pro-rated fixed-cost + (for past-only) salary share, so the
      // daily total reconciles with the top Full Net P&L. Future days show projected salary in
      // the Future Salary column for visibility, but it doesn't flow into PL (the top KPI caps
      // salary at yesterday so only past-day shares are owed).
      const mfDaily = getMonthlyFixed(b, filterPrefix, monthlyExpenses, fixedExpenses);
      for (let d = 1; d <= daysCount; d++) {
        const dayPrefix = `${filterYear}-${String(filterMonth).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dEntries = entries.filter(e => e.branch_id === b.id && e.date === dayPrefix);
        const dLeaves = leaves.filter(l => l.staff_id && activeStaffInMonth.some(as => as.id === l.staff_id) && l.status === 'approved' && l.date === dayPrefix).reduce((s, l) => s + (l.days || 1), 0);
        const isProjected = dEntries.length === 0;

        const dShopRent = mfDaily.shop_rent * dayFactor;
        const dRoomRent = mfDaily.room_rent * dayFactor;
        const dElec = (mfDaily.shop_elec + mfDaily.room_elec) * dayFactor;
        const dWifi = mfDaily.wifi * dayFactor;
        const dFixedFees = dShopRent + dRoomRent + dElec + dWifi;
        const dSalaryShare = computeDayShareFor(dayPrefix);
        const label = `${d} ${new Date(filterYear, filterMonth - 1).toLocaleString('default', { month: 'short' })}`;

        if (isProjected) {
          // Future/empty day — fixed cost accrues, Future Salary is informational only (not in PL)
          // so the grand total still matches Full Net P&L which uses capped-at-yesterday salary.
          const estExpense = dFixedFees;
          breakdownStats.push({
            label, date: dayPrefix,
            income: 0, incentives: 0, material: 0, lumpsumMat: 0, others: 0,
            shopRent: dShopRent, roomRent: dRoomRent, elec: dElec, wifi: dWifi,
            salary: 0, futureSalary: dSalaryShare,
            gst: 0, estExpense,
            leaves: dLeaves,
            pl: -estExpense,
            expectedCih: 0, actualCih: null, cashDiff: null,
            isFuture: true,
          });
          continue;
        }

        const dOnline = dEntries.reduce((s, e) => s + (e.online || 0), 0);
        const dCash = dEntries.reduce((s, e) => s + (e.cash || 0), 0);
        const dMatInc = dEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.material || 0), 0), 0);
        const dIncExp = dEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.incentive || 0) + (sb.mat_incentive || 0), 0), 0);
        // Pull the day's material cost from the allocations collection rather
        // than stored entry.mat_expense so the numbers match Materials Received.
        const dAllocMat = allocsTotal(materialAllocations.filter(a => a.branch_id === b.id && (a.date || (a.transferred_at || "").slice(0, 10)) === dayPrefix));
        const dLumpMat = dEntries.reduce((s, e) => s + (Number(e.mat_expense) || 0), 0);
        const dMatExp = (matUseAllocations ? dAllocMat : 0) + (matUseLumpsum ? dLumpMat : 0);
        const dOtherExp = dEntries.reduce((s, e) => s + (e.others || 0) + (e.petrol || 0), 0);
        const dGst = (dOnline * gstPctLocal) / 100;

        const dIncome = dOnline + dCash + dMatInc;
        const dExpenses = dIncExp + dMatExp + dOtherExp + dFixedFees + dSalaryShare + dGst;

        const dExpectedCih = dEntries.reduce((s, e) => s + (Number(e.cash_in_hand) || 0), 0);
        const dActualRecorded = dEntries.some(e => e.actual_cash != null);
        const dActualCih = dActualRecorded ? dEntries.reduce((s, e) => s + (Number(e.actual_cash) || 0), 0) : null;
        const dDiffRecorded = dEntries.some(e => e.cash_diff != null);
        const dCashDiff = dDiffRecorded ? dEntries.reduce((s, e) => s + (Number(e.cash_diff) || 0), 0) : null;

        breakdownStats.push({
          label, date: dayPrefix,
          income: dIncome,
          incentives: dIncExp,
          material: dAllocMat,
          lumpsumMat: dLumpMat,
          others: dOtherExp,
          shopRent: dShopRent, roomRent: dRoomRent, elec: dElec, wifi: dWifi,
          salary: dSalaryShare,
          futureSalary: 0,
          gst: dGst,
          estExpense: 0,
          leaves: dLeaves,
          pl: dIncome - dExpenses,
          expectedCih: dExpectedCih, actualCih: dActualCih, cashDiff: dCashDiff,
          isFuture: false,
        });
      }
    } else {
      // Yearly Mode: Month-by-month
      for (let m = 1; m <= endMonth; m++) {
        const monthPrefix = `${filterYear}-${m < 10 ? '0' + m : m}`;
        const mEntries = entries.filter(e => e.branch_id === b.id && e.date.startsWith(monthPrefix));
        
        const mOnline = mEntries.reduce((s, e) => s + (e.online || 0), 0);
        const mCash = mEntries.reduce((s, e) => s + (e.cash || 0), 0);
        const mMatInc = mEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.material || 0), 0), 0);
        const mIncExp = mEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.incentive || 0) + (sb.mat_incentive || 0), 0), 0);
        const mAllocMat = allocsTotal(materialAllocations.filter(a => a.branch_id === b.id && (a.date || (a.transferred_at || "").slice(0, 10) || "").startsWith(monthPrefix)));
        const mLumpMat = mEntries.reduce((s, e) => s + (Number(e.mat_expense) || 0), 0);
        const mMatExp = (matUseAllocations ? mAllocMat : 0) + (matUseLumpsum ? mLumpMat : 0);
        const mOtherExp = mEntries.reduce((s, e) => s + (e.others || 0) + (e.petrol || 0), 0);
        
        const mfYearly = getMonthlyFixed(b, monthPrefix, monthlyExpenses, fixedExpenses);
        const mFixed = mfYearly.shop_rent + mfYearly.room_rent + mfYearly.wifi + mfYearly.shop_elec + mfYearly.room_elec;
        const activeStaffInMonth = branchStaff.filter(s => staffStatusForMonth(s, monthPrefix).status !== 'inactive');
        const mActualSalary = salaryByBranchForMonth(monthPrefix, entries, branches, salHistory, staff, globalSettings, leaves).get(b.id) || 0;
        const mLeaves = activeStaffInMonth.reduce((s, st) => s + staffLeavesInMonth(st.id, monthPrefix, leaves), 0);

        const mIncome = mOnline + mCash + mMatInc;
        const mExpenses = mIncExp + mMatExp + mOtherExp + mFixed + mActualSalary;

        const mExpectedCih = mEntries.reduce((s, e) => s + (Number(e.cash_in_hand) || 0), 0);
        const mActualRecorded = mEntries.some(e => e.actual_cash != null);
        const mActualCih = mActualRecorded ? mEntries.reduce((s, e) => s + (Number(e.actual_cash) || 0), 0) : null;
        const mDiffRecorded = mEntries.some(e => e.cash_diff != null);
        const mCashDiff = mDiffRecorded ? mEntries.reduce((s, e) => s + (Number(e.cash_diff) || 0), 0) : null;

        breakdownStats.push({
          label: new Date(filterYear, m - 1).toLocaleString('default', { month: 'short' }),
          monthPrefix,
          income: mIncome,
          incentives: mIncExp,
          material: mAllocMat,
          lumpsumMat: mLumpMat,
          others: mOtherExp,
          shopRent: mfYearly.shop_rent,
          roomRent: mfYearly.room_rent,
          elec: mfYearly.shop_elec + mfYearly.room_elec,
          wifi: mfYearly.wifi,
          salary: mActualSalary,
          futureSalary: 0,
          gst: 0,
          estExpense: 0,
          leaves: mLeaves,
          pl: mIncome - mExpenses,
          expectedCih: mExpectedCih, actualCih: mActualCih, cashDiff: mCashDiff,
          isFuture: false,
        });
      }
    }

    // Always use these sums for top KPI cards (which follow filter selection)
    let totalOnline = 0, totalCash = 0, totalMatInc = 0;
    let totalIncentiveExp = 0, totalMatExp = 0, totalOtherExp = 0;
    let totalFixedSalaryComp = 0;
    let totalShopRent = 0, totalRoomRent = 0, totalElec = 0, totalWifi = 0, totalSalary = 0;

    for (let m = startMonthStats; m <= endMonth; m++) {
      const monthPrefix = `${filterYear}-${m < 10 ? '0' + m : m}`;
      const mEntries = entries.filter(e => e.branch_id === b.id && e.date.startsWith(monthPrefix));
      const mOnline = mEntries.reduce((s, e) => s + (e.online || 0), 0);
      const mCash = mEntries.reduce((s, e) => s + (e.cash || 0), 0);
      const mMatInc = mEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.material || 0), 0), 0);
      const mIncExp = mEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.incentive || 0) + (sb.mat_incentive || 0), 0), 0);
      // Material cost respects the admin's source toggles (allocations /
      // lumpsum / both) from Master Setup → Material Expense Source.
      const mAllocMatKpi = allocsTotal(materialAllocations.filter(a => a.branch_id === b.id && (a.date || (a.transferred_at || "").slice(0, 10) || "").startsWith(monthPrefix)));
      const mLumpMatKpi = mEntries.reduce((s, e) => s + (Number(e.mat_expense) || 0), 0);
      const mMatExp = (matUseAllocations ? mAllocMatKpi : 0) + (matUseLumpsum ? mLumpMatKpi : 0);
      const mOtherExp = mEntries.reduce((s, e) => s + (e.others || 0) + (e.petrol || 0), 0);
      const mf = getMonthlyFixed(b, monthPrefix, monthlyExpenses, fixedExpenses);
      const mFixed = mf.shop_rent + mf.room_rent + mf.wifi + mf.shop_elec + mf.room_elec;
      // Transfer-aware: use the same branchStaff universe as the roster so the
      // Salary line in the expense breakdown matches the staff table total
      // (staff transferred INTO the branch belong here even if their home
      // branch_id still points elsewhere).
      const actSal = salaryByBranchForMonth(monthPrefix, entries, branches, salHistory, staff, globalSettings, leaves).get(b.id) || 0;

      totalOnline += mOnline; totalCash += mCash; totalMatInc += mMatInc;
      totalIncentiveExp += mIncExp; totalMatExp += mMatExp; totalOtherExp += mOtherExp;
      totalShopRent += mf.shop_rent; totalRoomRent += mf.room_rent;
      totalElec += mf.shop_elec + mf.room_elec; totalWifi += mf.wifi;
      totalSalary += actSal;
      totalFixedSalaryComp += (mFixed + actSal);
    }

    const gstPct = globalSettings?.gst_pct || 0;
    const totalGstEst = (totalOnline * gstPct) / 100;
    const totalIncSum = totalOnline + totalCash + totalMatInc;
    const totalVarExp = totalIncentiveExp + totalMatExp + totalOtherExp;
    const netSum = totalIncSum - totalVarExp;
    const fullNetSum = netSum - totalFixedSalaryComp - totalGstEst;

    return (
      <div>
        {/* Pill-row table styling — each row becomes a rounded card with breathing room.
            Scoped class so it only applies to tables that opt in. */}
        <style>{`
          .pill-table { border-collapse: separate !important; border-spacing: 0 8px !important; }
          .pill-table thead th { background: transparent !important; border-bottom: none !important; padding-bottom: 4px !important; }
          .pill-table tbody tr { transition: transform .15s, box-shadow .15s; }
          .pill-table tbody tr > td { background: var(--bg3); border-top: 1px solid rgba(255,255,255,0.04); border-bottom: 1px solid rgba(0,0,0,0.2); padding: 14px 18px; }
          .pill-table tbody tr > td:first-child { border-left: 1px solid rgba(255,255,255,0.04); border-radius: 10px 0 0 10px; }
          .pill-table tbody tr > td:last-child { border-right: 1px solid rgba(0,0,0,0.2); border-radius: 0 10px 10px 0; }
          .pill-table tbody tr:hover > td { background: var(--bg4); }
          .pill-table tbody tr.totals-row > td { background: linear-gradient(180deg, var(--bg4), var(--bg3)) !important; border-top: 1px solid rgba(var(--gold-rgb),0.25); border-bottom: 1px solid rgba(var(--gold-rgb),0.25); }
          .pill-table tbody tr.totals-row > td:first-child { border-left: 1px solid rgba(var(--gold-rgb),0.25); }
          .pill-table tbody tr.totals-row > td:last-child { border-right: 1px solid rgba(var(--gold-rgb),0.25); }
        `}</style>

        {/* Back header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
          <button onClick={() => setSelectedBranch(null)} style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--bg3)", border: "1px solid var(--border2)", borderRadius: 8, padding: "8px 14px", fontSize: 12, fontFamily: "var(--font-outfit)", fontWeight: 600, cursor: "pointer", color: "var(--text2)" }}>
            <Icon name="back" size={14} /> Back
          </button>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>{b.name}</div>
          <Pill label={b.type === "unisex" ? "Unisex" : "Mens"} color={b.type === "unisex" ? "purple" : "blue"} />
          {b.location && <span style={{ fontSize: 12, color: "var(--text3)" }}>📍 {b.location}</span>}
          {canEdit && (
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button onClick={() => { setRecalcModal({ branches: [{ id: b.id, name: b.name }] }); setRecalcLog([]); setRecalcDone(false); }}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, background: "rgba(96,165,250,0.12)", border: "1px solid rgba(96,165,250,0.3)", color: "var(--blue, #60a5fa)", cursor: "pointer", fontWeight: 600, fontSize: 12 }}>
                <Icon name="check" size={14} /> Recalculate
              </button>
              <button onClick={() => handleEdit(b)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text2)", cursor: "pointer", fontWeight: 600, fontSize: 12 }}>
                <Icon name="edit" size={14} /> Edit
              </button>
              {isAdmin && <button onClick={() => handleDelete(b.id)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 8, background: "var(--red-bg)", border: "1px solid rgba(248,113,113,0.3)", color: "var(--red)", cursor: "pointer", fontWeight: 600, fontSize: 12 }}>
                <Icon name="del" size={14} /> Delete
              </button>}
            </div>
          )}
        </div>

        <PeriodWidget filterMode={filterMode} setFilterMode={setFilterMode} filterYear={filterYear} setFilterYear={setFilterYear} filterMonth={filterMonth} setFilterMonth={setFilterMonth} />

        {/* KPIs — admin/accountant can click Variable Exp, Fixed Costs, or Total Expense for breakdown */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, marginBottom: 24 }}>
          {[
            { l: "Total Income", v: INR(totalIncSum), c: "var(--green)" },
            { l: "Variable Exp", v: INR(totalVarExp), c: "var(--red)", click: canEdit ? "variable" : null },
            { l: "Fixed Costs", v: canEdit ? INR(totalFixedSalaryComp) : "•••••", c: "var(--orange)", click: canEdit ? "fixed" : null },
            { l: "GST Est.", v: canEdit ? INR(totalGstEst) : "•••••", c: "var(--red)" },
            { l: "Total Expense", v: canEdit ? INR(totalVarExp + totalFixedSalaryComp + totalGstEst) : "•••••", c: "var(--red)", click: canEdit ? "total" : null },
            { l: "Full Net P&L", v: canEdit ? (INR(fullNetSum)) : "•••••", c: fullNetSum >= 0 ? "var(--green)" : "var(--red)" },
          ].map(({ l, v, c, click }) => {
            const content = (
              <>
                <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, display: "flex", alignItems: "center", gap: 6 }}>
                  {l}
                  {click && <span title="Click for breakdown" style={{ fontSize: 10, color: "var(--accent)", opacity: 0.85 }}>ⓘ</span>}
                </div>
                <div style={{ fontSize: 22, fontWeight: 800, color: c, whiteSpace: "nowrap", marginTop: 4 }}>{v}</div>
                <div style={{ fontSize: 10, color: "var(--blue)", fontWeight: 600, marginTop: 4 }}>{isYearly ? "This Year" : "This Month"}</div>
              </>
            );
            if (!click) {
              return (
                <Card key={l} style={{ padding: "16px 20px", display: "flex", flexDirection: "column", minHeight: 90, justifyContent: "center" }}>
                  {content}
                </Card>
              );
            }
            // Clickable KPI — use a plain div so onClick / hover handlers actually work.
            return (
              <div key={l}
                role="button"
                tabIndex={0}
                onClick={() => setKpiBreakdown(click)}
                onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setKpiBreakdown(click); } }}
                onMouseEnter={ev => { ev.currentTarget.style.transform = "translateY(-2px)"; ev.currentTarget.style.boxShadow = "0 6px 18px rgba(var(--accent-rgb),0.18)"; ev.currentTarget.style.borderColor = "rgba(var(--accent-rgb),0.35)"; }}
                onMouseLeave={ev => { ev.currentTarget.style.transform = "none"; ev.currentTarget.style.boxShadow = "none"; ev.currentTarget.style.borderColor = "var(--border)"; }}
                style={{
                  padding: "16px 20px",
                  minHeight: 90,
                  background: "var(--bg2)",
                  border: "1px solid var(--border)",
                  borderRadius: 12,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                  cursor: "pointer",
                  transition: "transform .15s, box-shadow .15s, border-color .15s",
                  userSelect: "none",
                }}>
                {content}
              </div>
            );
          })}
        </div>

        {/* KPI breakdown popup */}
        {kpiBreakdown && canEdit && (() => {
          const nMonths = factor;
          const shopRent = totalShopRent;
          const roomRent = totalRoomRent;
          const wifi = totalWifi;
          const elec = totalElec;
          const salaryPortion = totalSalary;

          let rows; let total; let title; let titleColor;
          if (kpiBreakdown === "variable") {
            title = "Variable Expenses"; titleColor = "var(--red)"; total = totalVarExp;
            rows = [
              { label: "Staff Incentives", value: totalIncentiveExp, hint: "Sum of staff incentive + mat_incentive across all entries in period", color: "var(--red)" },
              { label: "Material Cost", value: totalMatExp, hint: "Sum of mat_expense across all entries in period", color: "var(--red)" },
              { label: "Other / Petrol", value: totalOtherExp, hint: "Sum of others + petrol (online expenses paid by HO)", color: "var(--red)" },
            ];
          } else if (kpiBreakdown === "fixed") {
            title = "Fixed Costs"; titleColor = "var(--orange)"; total = totalFixedSalaryComp;
            rows = [
              { label: "Shop Rent", value: shopRent, hint: `Sum across ${nMonths} month${nMonths === 1 ? "" : "s"} (per-month overrides honored)`, color: "var(--orange)" },
              { label: "Room Rent", value: roomRent, hint: `Sum across ${nMonths} month${nMonths === 1 ? "" : "s"} (per-month overrides honored)`, color: "var(--orange)" },
              { label: "Electricity (Shop + Room)", value: elec, hint: `Sum across ${nMonths} month${nMonths === 1 ? "" : "s"} (per-month overrides honored)`, color: "var(--orange)" },
              { label: "WiFi", value: wifi, hint: `Sum across ${nMonths} month${nMonths === 1 ? "" : "s"} (per-month overrides honored)`, color: "var(--orange)" },
              { label: "Actual Salary (pro-rated)", value: salaryPortion, hint: "Sum of active staff's pro-rata salaries across the months in period", color: "var(--blue)" },
            ];
          } else {
            title = "Total Expense"; titleColor = "var(--red)"; total = totalVarExp + totalFixedSalaryComp + totalGstEst;
            rows = [
              { label: "Variable — Staff Incentives", value: totalIncentiveExp, hint: "Included in Variable Exp", color: "var(--red)" },
              { label: "Variable — Material Cost", value: totalMatExp, hint: "Included in Variable Exp", color: "var(--red)" },
              { label: "Variable — Other / Petrol", value: totalOtherExp, hint: "Included in Variable Exp", color: "var(--red)" },
              { label: "Fixed — Shop Rent", value: shopRent, hint: `Sum across ${nMonths} month${nMonths === 1 ? "" : "s"} (per-month overrides honored)`, color: "var(--orange)" },
              { label: "Fixed — Room Rent", value: roomRent, hint: `Sum across ${nMonths} month${nMonths === 1 ? "" : "s"} (per-month overrides honored)`, color: "var(--orange)" },
              { label: "Fixed — Electricity", value: elec, hint: `Sum across ${nMonths} month${nMonths === 1 ? "" : "s"} (per-month overrides honored)`, color: "var(--orange)" },
              { label: "Fixed — WiFi", value: wifi, hint: `Sum across ${nMonths} month${nMonths === 1 ? "" : "s"} (per-month overrides honored)`, color: "var(--orange)" },
              { label: "Fixed — Actual Salary", value: salaryPortion, hint: "Pro-rated across months in period", color: "var(--blue)" },
              { label: "GST Estimate (5%)", value: totalGstEst, hint: "GST extracted from online revenue", color: "var(--red)" },
            ];
          }
          return (
            <div onClick={() => setKpiBreakdown(null)}
              style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.55)", backdropFilter: "blur(6px)", zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
              <div onClick={ev => ev.stopPropagation()}
                style={{ width: "100%", maxWidth: 560, maxHeight: "90vh", overflowY: "auto", background: "var(--bg2)", borderRadius: 16, boxShadow: "0 24px 80px rgba(0,0,0,0.5)" }}>
                <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, position: "sticky", top: 0, background: "var(--bg2)", zIndex: 1 }}>
                  <div>
                    <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Breakdown</div>
                    <div style={{ fontSize: 17, fontWeight: 800, color: titleColor, marginTop: 2 }}>
                      {title} — {INR(total)}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4 }}>{plabel}</div>
                  </div>
                  <button onClick={() => setKpiBreakdown(null)}
                    style={{ background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text2)", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontSize: 14, fontWeight: 700 }}>✕</button>
                </div>
                <div style={{ padding: "10px 22px 18px" }}>
                  {rows.map(r => (
                    <div key={r.label} style={{ padding: "12px 0", borderBottom: "1px solid var(--border)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{r.label}</span>
                        <span style={{ fontSize: 14, fontWeight: 800, color: r.color, whiteSpace: "nowrap" }}>{INR(r.value)}</span>
                      </div>
                      <div style={{ fontSize: 10.5, color: "var(--text3)", marginTop: 3 }}>{r.hint}</div>
                    </div>
                  ))}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, paddingTop: 12, borderTop: "2px solid var(--border2)" }}>
                    <span style={{ fontSize: 12, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>TOTAL</span>
                    <span style={{ fontSize: 18, fontWeight: 800, color: titleColor }}>{INR(total)}</span>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Two-column detail */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
          {/* Income Breakdown */}
          <Card style={{ padding: 0 }}>
            <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", fontWeight: 700, color: "var(--gold)", fontSize: 12, textTransform: "uppercase", letterSpacing: 1 }}>Income Breakdown</div>
            <div style={{ padding: 16 }}>
              {/* Each line links to the page its number is computed from, so a
                  wrong figure can be traced to source. `q` carries branch + month
                  (entry/materials read these; the others just land on the page). */}
              {(() => {
                const q = `?branch=${b.id}` + (filterMode === "month" ? `&month=${filterPrefix}` : "");
                return [
                  ["Online / UPI", INR(totalOnline), "var(--green)", `/dashboard/entry${q}`],
                  ["Cash Collections", INR(totalCash), "var(--green)", `/dashboard/entry${q}`],
                  ["Material Sales", INR(totalMatInc), "var(--green)", `/dashboard/entry${q}`],
                ].map(([l, v, c, to]) => (
                <div key={l} onClick={() => router.push(to)} title={`Open source: ${to.split("?")[0]}`}
                  style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)", fontSize: 13, cursor: "pointer" }}>
                  <span style={{ color: "var(--accent)", fontWeight: 500, textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 }}>{l}</span>
                  <span style={{ fontWeight: 600, color: c }}>{v}</span>
                </div>
                ));
              })()}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", fontSize: 14, fontWeight: 700 }}>
                <span style={{ color: "var(--gold)" }}>TOTAL</span>
                <span style={{ color: "var(--green)" }}>{INR(totalIncSum)}</span>
              </div>
            </div>
          </Card>

          {/* Expense Breakdown */}
          <Card style={{ padding: 0 }}>
            <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", fontWeight: 700, color: "var(--red)", fontSize: 12, textTransform: "uppercase", letterSpacing: 1 }}>Expense Breakdown</div>
            <div style={{ padding: 16 }}>
              {/* Each line links to its source page so a wrong figure is traceable.
                  entry/materials filter by ?branch&month; expenses/payroll just land. */}
              {(() => {
                const q = `?branch=${b.id}` + (filterMode === "month" ? `&month=${filterPrefix}` : "");
                const matTo = `/dashboard/materials${q}&tab=transfers&view=branches`;
                return [
                  ["Staff Incentives", INR(totalIncentiveExp), "var(--red)", `/dashboard/incentive-calculator${q}`],
                  ["Material Cost", INR(totalMatExp), "var(--red)", matTo],
                  ["Other / Petrol", INR(totalOtherExp), "var(--red)", `/dashboard/entry${q}`],
                  ["Shop Rent", INR(totalShopRent), "var(--orange)", `/dashboard/expenses${q}&row=${encodeURIComponent("Shop Rent")}`],
                  ["Room Rent", INR(totalRoomRent), "var(--orange)", `/dashboard/expenses${q}&row=${encodeURIComponent("Room Rent")}`],
                  ["Electricity", INR(totalElec), "var(--orange)", `/dashboard/expenses${q}&row=${encodeURIComponent("Electricity Shop")}`],
                  ["WiFi", INR(totalWifi), "var(--orange)", `/dashboard/expenses${q}&row=${encodeURIComponent("WiFi Bill")}`],
                  ...(isAdmin ? [["Salary", INR(totalSalary), "var(--orange)", `/dashboard/payroll${q}${filterMode === "month" ? "&by=work" : ""}`]] : []),
                  [`GST Extraction (${gstPct}%)`, INR(totalGstEst), "var(--red)", `/dashboard/entry${q}`],
                ].map(([l, v, c, to]) => (
                <div key={l} onClick={() => router.push(to)} title={`Open source: ${to.split("?")[0]}`}
                  style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--border)", fontSize: 12, cursor: "pointer" }}>
                  <span style={{ color: "var(--accent)", fontWeight: 500, textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 }}>{l}</span>
                  <span style={{ fontWeight: 600, color: c }}>{v}</span>
                </div>
                ));
              })()}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0 4px", fontSize: 14, fontWeight: 700 }}>
                <span style={{ color: "var(--red)" }}>TOTAL</span>
                <span style={{ color: "var(--red)" }}>{INR(totalVarExp + totalShopRent + totalRoomRent + totalElec + totalWifi + (isAdmin ? totalSalary : 0) + totalGstEst)}</span>
              </div>
            </div>
          </Card>
        </div>

        {/* Shop Target — the branch should bill at least 3× its salary cost.
            Admin-only since it derives from salary. Income (collection) is the
            "achieved" figure, matching the Income Breakdown total above. */}
        {isAdmin && (() => {
          const shopTgt = Math.round(totalSalary * 3);
          const shopPct = shopTgt > 0 ? Math.round(totalIncSum / shopTgt * 100) : 0;
          const shopMet = shopTgt > 0 && totalIncSum >= shopTgt;
          const shopShort = Math.max(0, shopTgt - totalIncSum);
          const shopExcess = Math.max(0, totalIncSum - shopTgt);
          const accent = shopMet ? "var(--green)" : "var(--red)";
          const stat = (label, value, color) => (
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>{label}</div>
              <div style={{ fontSize: 20, fontWeight: 900, color, marginTop: 4, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{value}</div>
            </div>
          );
          return (
            <Card style={{ marginBottom: 20, padding: 0, overflow: "hidden",
              border: `1px solid ${shopMet ? "rgba(74,222,128,0.35)" : "rgba(248,113,113,0.35)"}`,
              boxShadow: shopMet ? "0 0 24px -10px rgba(74,222,128,0.5)" : "0 0 24px -10px rgba(248,113,113,0.5)" }}>
              <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div style={{ fontWeight: 700, color: accent, fontSize: 12, textTransform: "uppercase", letterSpacing: 1 }}>
                  🎯 Shop Target · 3× Salary
                </div>
                <span style={{ fontSize: 11, fontWeight: 900, letterSpacing: 1, textTransform: "uppercase", padding: "4px 12px", borderRadius: 20,
                  color: accent, background: shopMet ? "rgba(74,222,128,0.12)" : "rgba(248,113,113,0.12)", border: `1px solid ${accent}` }}>
                  {shopTgt <= 0 ? "No target" : shopMet ? "Met ✓" : "Not met"}
                </span>
              </div>
              <div style={{ padding: 16, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 18, alignItems: "center" }}>
                {stat("Target (3× Salary)", INR(shopTgt), "var(--text)")}
                {stat("Achieved (Income)", INR(totalIncSum), "var(--green)")}
                {shopMet
                  ? stat("Excess", `+${INR(shopExcess)}`, "var(--green)")
                  : stat("Shortfall", INR(shopShort), "var(--red)")}
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>
                    <span>Achieved</span><span style={{ color: accent }}>{shopPct}%</span>
                  </div>
                  <div style={{ height: 8, background: "var(--border)", borderRadius: 8, overflow: "hidden" }}>
                    <div style={{ width: `${Math.min(shopPct, 100)}%`, height: "100%", borderRadius: 8, background: shopMet ? "linear-gradient(90deg,#22a354,var(--green))" : "linear-gradient(90deg,#2f6fb0,var(--blue, #60a5fa))" }} />
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 6 }}>Salary {INR(totalSalary)} × 3</div>
                </div>
              </div>
            </Card>
          );
        })()}

        {/* Quick action: open the standalone attendance calendar modal for this branch.
            Kept above the detail sections so it stays in a fixed spot. */}
        <div style={{ display: "flex", justifyContent: "flex-end", margin: "8px 0 16px" }}>
          <button onClick={() => { setAttendanceCalendar(b.id); setAttendanceMonth(filterMode === "month" ? filterPrefix : `${filterYear}-${String(NOW.getMonth() + 1).padStart(2, "0")}`); setAttendanceSelectedDay(null); }}
            style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 16px", borderRadius: 10, background: "rgba(var(--accent-rgb),0.1)", border: "1px solid rgba(var(--accent-rgb),0.35)", color: "var(--accent)", fontSize: 12, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", cursor: "pointer" }}>
            📅 View Attendance Calendar
          </button>
        </div>

        {/* Collection trend + staff-wise sales split — visible on every branch tab.
            Clicking a bar (month mode only) jumps to Daily Entry for that date.
            If no entry yet exists, ?date=+?branch= preloads the form; existing entries open via ?edit=. */}
        {(() => {
          const openDay = (dateStr, entryId) => {
            const params = new URLSearchParams();
            if (entryId) params.set("edit", entryId);
            else { params.set("date", dateStr); params.set("branch", b.id); }
            router.push(`/dashboard/entry?${params.toString()}`);
          };
          return (<>
            <BranchCollectionChart periodEntries={periodEntries} allEntries={entries} branchId={b.id} filterMode={filterMode} filterYear={filterYear} filterMonth={filterMonth} endMonth={endMonth} onDayClick={openDay}
              monthlyExpense={Object.fromEntries(breakdownStats.filter(s => s.monthPrefix).map(s => [s.monthPrefix, (s.income || 0) - (s.pl || 0)]))} />
            {filterMode === "month" && (
              <BranchSameDateCompareChart allEntries={entries} branchId={b.id} filterYear={filterYear} filterMonth={filterMonth} />
            )}
            {filterMode === "year" && isAdmin && (
              <BranchExpenseChart breakdownStats={breakdownStats} filterYear={filterYear}
                salaryBreakup={Object.fromEntries(breakdownStats.filter(s => s.monthPrefix).map(s => [
                  s.monthPrefix,
                  staff.map(st => {
                    const share = branchSalaryShare(st.id, s.monthPrefix, b.id, entries, st.branch_id);
                    if (!share) return null;
                    const amt = Math.round(proRataSalary(st, s.monthPrefix, branches, salHistory, staff, globalSettings, leaves, entries) * share);
                    return amt > 0 ? { name: st.name, amt } : null;
                  }).filter(Boolean).sort((a, b) => b.amt - a.amt),
                ]))} />
            )}
            {filterMode === "year" && isAdmin && <BranchPLTrendChart breakdownStats={breakdownStats} filterYear={filterYear} />}
            <BranchStaffSalesChart periodEntries={periodEntries} branchStaff={branchStaff} allStaff={staff} filterMode={filterMode} filterYear={filterYear} filterMonth={filterMonth} endMonth={endMonth} onDayClick={openDay} />
          </>);
        })()}

        {/* Section picker — click a card to reveal its detail table below.
            Multiple cards may be open at once so we can cross-reference numbers. */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12, marginBottom: 18 }}>
          {[
            { id: "cashflow", label: "Daily Cash Flow", sub: "Match bank deposits", emoji: "💰", accent: "var(--blue, #60a5fa)" },
            { id: "performance", label: "Performance Breakdown", sub: filterMode === "month" ? "Day-by-day P&L" : "Month-by-month P&L", emoji: "📊", accent: "var(--gold)" },
            { id: "materials", label: "Materials Received", sub: "Stock transfers", emoji: "📦", accent: "var(--accent)" },
            { id: "entries", label: "Recent Entries", sub: "Latest daily entries", emoji: "📝", accent: "var(--green)" },
            { id: "staff", label: `Branch Staff (${branchStaff.length})`, sub: "Roster · billing · leaves", emoji: "👥", accent: "var(--accent)" },
          ].map(s => {
            const isOpen = openSections.has(s.id);
            return (
              <div key={s.id} onClick={() => toggleSection(s.id)}
                role="button" tabIndex={0}
                onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggleSection(s.id); } }}
                style={{
                  padding: "18px 20px",
                  borderRadius: 12,
                  background: isOpen ? "rgba(var(--accent-rgb),0.1)" : "var(--bg3)",
                  border: `1.5px solid ${isOpen ? "var(--accent)" : "var(--border2)"}`,
                  cursor: "pointer",
                  transition: "background .15s, border .15s, transform .15s",
                  transform: isOpen ? "translateY(-1px)" : "none",
                  boxShadow: isOpen ? "0 6px 18px rgba(var(--accent-rgb),0.22)" : "none",
                  userSelect: "none",
                  display: "flex", alignItems: "center", gap: 14,
                  minHeight: 76,
                }}>
                <div style={{ fontSize: 30, lineHeight: 1, flexShrink: 0 }}>{s.emoji}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: s.accent, lineHeight: 1.2 }}>{s.label}</div>
                  <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4 }}>{s.sub}</div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 800, color: isOpen ? "var(--accent)" : "var(--text3)", flexShrink: 0 }}>{isOpen ? "▲" : "▼"}</div>
              </div>
            );
          })}
        </div>

        {/* Cash Flow — daily (month mode) or monthly (year mode), matchable against bank deposits */}
        {openSections.has("cashflow") && (() => {
          const rows = filterMode === "month"
            ? [...periodEntries]
                .sort((a, b) => a.date.localeCompare(b.date))
                .map(e => ({ label: e.date, cash: e.cash || 0, online: e.online || 0, cih: effectiveCashInHand(e) }))
            : Array.from({ length: endMonth }, (_, idx) => {
                const m = idx + 1;
                const monthPrefix = `${filterYear}-${String(m).padStart(2, '0')}`;
                const mEntries = periodEntries.filter(e => e.date.startsWith(monthPrefix));
                return {
                  label: new Date(filterYear, m - 1).toLocaleString('default', { month: 'short' }),
                  cash: mEntries.reduce((s, e) => s + (e.cash || 0), 0),
                  online: mEntries.reduce((s, e) => s + (e.online || 0), 0),
                  cih: mEntries.reduce((s, e) => s + effectiveCashInHand(e), 0),
                };
              }).filter(r => r.cash || r.online || r.cih);
          const totals = rows.reduce((acc, r) => ({ cash: acc.cash + r.cash, online: acc.online + r.online, cih: acc.cih + r.cih }), { cash: 0, online: 0, cih: 0 });
          return (
            <Card style={{ marginBottom: 16, overflow: "hidden" }}>
              <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)", fontWeight: 700, color: "var(--blue, #60a5fa)", fontSize: 12, textTransform: "uppercase", letterSpacing: 1, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>{filterMode === "month" ? "Daily Cash Flow" : "Monthly Cash Flow"}</span>
                <span style={{ fontSize: 10, color: "var(--text3)", textTransform: "none", letterSpacing: 0 }}>Match against bank deposits · Left-over cash still at branch</span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="pill-table" style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12, minWidth: 480 }}>
                  <thead>
                    <tr>
                      <TH>{filterMode === "month" ? "Date" : "Month"}</TH>
                      <TH right>Cash Sales</TH>
                      <TH right>Online / UPI</TH>
                      <TH right>Cash In Hand</TH>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && (
                      <tr><td colSpan={4} style={{ padding: 20, textAlign: "center", color: "var(--text3)" }}>No entries in {plabel}</td></tr>
                    )}
                    {rows.map((r, i) => (
                      <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                        <TD style={{ fontWeight: 600 }}>{r.label}</TD>
                        <TD right style={{ color: "var(--green)" }}>{INR(r.cash)}</TD>
                        <TD right style={{ color: "var(--blue, #60a5fa)" }}>{INR(r.online)}</TD>
                        <TD right style={{ color: r.cih >= 0 ? "var(--gold)" : "var(--red)", fontWeight: 700 }}>{INR(r.cih)}</TD>
                      </tr>
                    ))}
                    {rows.length > 0 && (
                      <tr className="totals-row" style={{ background: "var(--bg3)", borderTop: "2px solid var(--border2)" }}>
                        <TD style={{ fontWeight: 800, color: "var(--gold)" }}>TOTAL</TD>
                        <TD right style={{ fontWeight: 800, color: "var(--green)" }}>{INR(totals.cash)}</TD>
                        <TD right style={{ fontWeight: 800, color: "var(--blue, #60a5fa)" }}>{INR(totals.online)}</TD>
                        <TD right style={{ fontWeight: 800, color: "var(--gold)" }}>{INR(totals.cih)}</TD>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          );
        })()}

        {/* Staff Table */}
        {openSections.has("staff") && (() => {
          // Precompute every derived value per staff once, then sort + render.
          // Why: sorting must order by computed metrics (days worked, salary,
          // billing, etc.) which don't exist on the raw staff doc.
          const fmtShort = (iso) => {
            if (!iso) return "—";
            const d = new Date(iso);
            if (isNaN(d.getTime())) return iso;
            return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
          };
          const quotaPerMonth = (b.type === 'unisex' ? globalSettings?.unisex_leaves : globalSettings?.mens_leaves) || (b.type === 'unisex' ? 3 : 2);
          const computePayrollDays = (mPrefix) => {
            const [yr, mo] = mPrefix.split('-').map(Number);
            const daysInMo = new Date(yr, mo, 0).getDate();
            const mStart = new Date(yr, mo - 1, 1);
            const mEnd = new Date(yr, mo, 0);
            return (s) => {
              const jd = parseLocalDate(s.join);
              const ed = parseLocalDate(s.exit_date);
              const now = new Date();
              const isCurrent = now.getFullYear() === yr && now.getMonth() + 1 === mo;
              let capEnd = mEnd;
              if (isCurrent) {
                const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
                if (y < mStart) return 0;
                if (y < mEnd) capEnd = y;
              }
              const effStart = (jd && jd > mStart) ? jd : mStart;
              const effEnd = (ed && ed < capEnd) ? ed : capEnd;
              if (effStart > effEnd) return 0;
              const cal = Math.round((effEnd - effStart) / 86400000) + 1;
              const mLeaves = staffLeavesInMonth(s.id, mPrefix, leaves);
              const proPaid = Math.ceil(quotaPerMonth * cal / daysInMo);
              const unpaid = Math.max(0, mLeaves - proPaid);
              return Math.max(0, cal - unpaid);
            };
          };

          // Days a staff was actually present in a month — one entry per branch/day,
          // counted when they appear in staff_billing with present !== false. This is
          // the attendance basis for both the DAYS column and salary.
          const presentDaysInMonth = (sid, prefix) =>
            periodEntries.filter(e => e.date?.startsWith(prefix) && (e.staff_billing || []).some(x => x.staff_id === sid && x.present !== false)).length;

          // Borrowed-in staff: present in this branch's entries this period but
          // home elsewhere. Surface them so the roster + its salary total
          // reconcile with the branch P&L, which already charges their
          // here-portion of salary to this branch.
          const homeIds = new Set(branchStaff.map(s => s.id));
          const borrowedIds = new Set();
          periodEntries.forEach(e => (e.staff_billing || []).forEach(sb => {
            if (sb.staff_id && !homeIds.has(sb.staff_id) && (sb.present !== false)) borrowedIds.add(sb.staff_id);
          }));
          const borrowedStaff = [...borrowedIds].map(id => staff.find(x => x.id === id)).filter(Boolean);
          const rosterStaff = [...branchStaff, ...borrowedStaff];

          const monthlySalaryRef = filterMode === "month" ? filterPrefix : `${filterYear}-${String(endMonth).padStart(2, '0')}`;
          const [refYr, refMo] = monthlySalaryRef.split('-').map(Number);
          const daysInRefMonth = new Date(refYr, refMo, 0).getDate(); // per-day rate denominator (matches proRataSalary)
          const rawRows = rosterStaff.map((s) => {
            const borrowed = !homeIds.has(s.id);
            // Full contracted monthly salary (history-aware) — reference figure,
            // independent of attendance / branch split shown in the Salary column.
            const monthlySalary = getStaffSalaryForMonth(s.id, monthlySalaryRef, salHistory, staff);
            let billing = 0, matSale = 0, tips = 0, staffTInc = 0;
            let curSalary = 0, leavesTaken = 0, daysWorked = 0, paidLeaves = 0, lop = 0, payrollDays = 0;
            const monthlyDays = []; // year mode: [{ m: "Jan", days }] for months with any worked days

            if (filterMode === 'month') {
              leavesTaken = staffLeavesInMonth(s.id, filterPrefix, leaves);
              daysWorked = presentDaysInMonth(s.id, filterPrefix);
              paidLeaves = Math.min(leavesTaken, quotaPerMonth);
              lop = Math.max(0, leavesTaken - quotaPerMonth);
              // Days paid = days present at THIS branch + paid-leave days.
              payrollDays = daysWorked + paidLeaves;
              // Salary earned here = days paid × per-day rate (monthly ÷ days in
              // month). Matches the "N days paid" line and the Monthly Sal /day
              // figure, so e.g. 7 days × ₹500 = ₹3,500.
              curSalary = Math.round(payrollDays * (monthlySalary / daysInRefMonth));
            } else {
              for (let m = 1; m <= endMonth; m++) {
                const mPrefix = `${filterYear}-${String(m).padStart(2, '0')}`;
                const [my, mm] = mPrefix.split('-').map(Number);
                const mDaysInMonth = new Date(my, mm, 0).getDate();
                const mMonthlySal = getStaffSalaryForMonth(s.id, mPrefix, salHistory, staff);
                const mLeaves = staffLeavesInMonth(s.id, mPrefix, leaves);
                const mDays = presentDaysInMonth(s.id, mPrefix);
                const mPaidLeave = Math.min(mLeaves, quotaPerMonth);
                leavesTaken += mLeaves;
                paidLeaves += mPaidLeave;
                lop += Math.max(0, mLeaves - quotaPerMonth);
                daysWorked += mDays;
                // Per-month: days paid here × that month's per-day rate.
                curSalary += Math.round((mDays + mPaidLeave) * (mMonthlySal / mDaysInMonth));
                if (mDays > 0) monthlyDays.push({ m: new Date(filterYear, m - 1, 1).toLocaleString("default", { month: "short" }), days: mDays });
              }
              payrollDays = daysWorked + paidLeaves;
            }

            periodEntries.forEach(e => {
              const sb = (e.staff_billing || []).find(x => x.staff_id === s.id);
              if (sb) {
                billing += (sb.billing || 0);
                matSale += (sb.material || 0);
                tips += (sb.tips || 0);
                staffTInc += (sb.staff_total_inc || (sb.incentive || 0) + (sb.mat_incentive || 0) + (sb.tips || 0));
              }
            });
            const totalSale = billing + matSale + tips;
            const pct = Math.min(Math.round(billing / (s.target || 50000) * 100), 100);
            return { s, borrowed, billing, matSale, tips, staffTInc, totalSale, pct, curSalary, monthlySalary, daysWorked, paidLeaves, lop, payrollDays, monthlyDays };
          });

          // Active rows sort after exited rows when sorting by End date; use
          // 9999 as a sentinel so "Active" lands at the top on asc / bottom on desc
          // (consistent with treating no-exit as the latest possible end).
          const sortedRows = staffRosterSort.sortRows(rawRows, {
            name:       r => (r.s.name || "").toLowerCase(),
            role:       r => (r.s.role || "").toLowerCase(),
            start:      r => r.s.join || "",
            end:        r => r.s.exit_date || "9999-12-31",
            days:       r => r.daysWorked,
            paid:       r => r.paidLeaves,
            lop:        r => r.lop,
            monthly:    r => r.monthlySalary,
            salary:     r => r.curSalary,
            billing:    r => r.billing,
            staffTInc:  r => r.staffTInc,
            totalSale:  r => r.totalSale,
          });

          // Active/inactive is relative to the SELECTED period, not just whether an
          // exit date exists. A staff who worked any days in the period — or whose
          // exit falls on/after the period start — counts as Active for that period
          // (so their pro-rata salary + billing land in the Active total and P&L).
          // Inactive = exited before the period began with zero contribution.
          const periodStart = filterMode === "month" ? `${filterPrefix}-01` : `${filterYear}-01-01`;
          const periodEnd = filterMode === "month"
            ? `${filterPrefix}-${String(new Date(filterYear, filterMonth, 0).getDate()).padStart(2, '0')}`
            : `${filterYear}-${String(endMonth).padStart(2, '0')}-${String(new Date(filterYear, endMonth, 0).getDate()).padStart(2, '0')}`;
          // A staff who joins AFTER the period ends never worked in it, even with no
          // exit_date — otherwise future joiners show "Active" with ₹0 salary/0 days.
          const isActiveInPeriod = (r) => (!r.s.join || r.s.join <= periodEnd) && (r.daysWorked > 0 || !r.s.exit_date || r.s.exit_date >= periodStart);
          const activeRows = sortedRows.filter(isActiveInPeriod);
          const inactiveRows = sortedRows.filter(r => !isActiveInPeriod(r));
          const shownRows = staffTab === "inactive" ? inactiveRows : activeRows;
          const totSalary = shownRows.reduce((sum, r) => sum + r.curSalary, 0);
          const totMonthly = shownRows.reduce((sum, r) => sum + r.monthlySalary, 0);
          const totBilling = shownRows.reduce((sum, r) => sum + r.billing, 0);
          const totStaffInc = shownRows.reduce((sum, r) => sum + r.staffTInc, 0);
          const totSale = shownRows.reduce((sum, r) => sum + r.totalSale, 0);

          return (<>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--gold)" }}>Branch Staff ({branchStaff.length})</div>
          <ToggleGroup
            options={[["active", `Active (${activeRows.length})`], ["inactive", `Inactive (${inactiveRows.length})`]]}
            value={staffTab}
            onChange={setStaffTab}
          />
        </div>
        <Card>
          <table className="pill-table" style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5 }}>
            <thead><tr>
              <TH>#</TH>
              <TH sort={staffRosterSort} sortKey="name">Name</TH>
              <TH sort={staffRosterSort} sortKey="role">Role</TH>
              <TH sort={staffRosterSort} sortKey="start">Start</TH>
              <TH sort={staffRosterSort} sortKey="end">End</TH>
              <TH right title="Days the staff was active in this period (join/exit-aware, excludes LOP)" sort={staffRosterSort} sortKey="days">Days</TH>
              <TH right title="Approved leaves within the monthly quota" sort={staffRosterSort} sortKey="paid">Paid</TH>
              <TH right title="Loss-of-pay: leaves beyond the monthly quota" sort={staffRosterSort} sortKey="lop">LOP</TH>
              {isAdmin && <TH right title="Full contracted monthly salary (before attendance / branch split)" sort={staffRosterSort} sortKey="monthly">Monthly Sal</TH>}
              {isAdmin && <TH right sort={staffRosterSort} sortKey="salary">Salary</TH>}
              <TH right sort={staffRosterSort} sortKey="billing">Billing ({plabel})</TH>
              <TH right sort={staffRosterSort} sortKey="staffTInc">Staff T.Inc</TH>
              <TH right sort={staffRosterSort} sortKey="totalSale">Staff T.Sale</TH>
              <TH> </TH>
            </tr></thead>
            <tbody>
              {shownRows.map((row, i) => {
                const { s, borrowed, billing, staffTInc, totalSale, pct, curSalary, monthlySalary, daysWorked, paidLeaves, lop, payrollDays, monthlyDays } = row;
                const hasExit = !!s.exit_date;
                const homeBranchName = borrowed ? (branches.find(x => x.id === s.branch_id)?.name || "another branch") : null;
                const isFocused = staffFocusId === s.id;
                return (
                  <tr key={s.id} id={`staff-row-${s.id}`}
                    style={isFocused ? {
                      background: "linear-gradient(90deg, rgba(var(--accent-rgb),0.18), rgba(var(--accent-rgb),0.04))",
                      boxShadow: "inset 3px 0 0 var(--accent)",
                      transition: "background 0.6s ease",
                    } : undefined}>
                    <TD style={{ color: "var(--text3)" }}>{i + 1}</TD>
                    <TD style={{ fontWeight: 600 }}>
                      {s.name}
                      {borrowed && (
                        <span title={`Borrowed from ${homeBranchName} — salary shown is this branch's share`}
                          style={{ marginLeft: 6, fontSize: 9, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--gold)", background: "rgba(234,179,8,0.12)", border: "1px solid rgba(234,179,8,0.35)", borderRadius: 5, padding: "1px 5px", verticalAlign: "middle" }}>
                          Loan
                        </span>
                      )}
                    </TD>
                    <TD><Pill label={s.role || "—"} color="blue" /></TD>
                    <TD style={{ color: "var(--text2)", fontSize: 11, fontWeight: 600 }} title={s.join && s.join < periodStart ? `Joined ${fmtShort(s.join)} — showing this period's start` : undefined}>
                      {/* In month view, a staff who was already employed before the month
                          started effectively worked from the 1st, so show the period start
                          rather than their original (earlier) join date. */}
                      {filterMode === "month" && s.join && s.join < periodStart ? fmtShort(periodStart) : fmtShort(s.join)}
                    </TD>
                    <TD style={{ color: hasExit ? "var(--red)" : "var(--green)", fontSize: 11, fontWeight: 600 }}>
                      {hasExit ? fmtShort(s.exit_date) : "Active"}
                    </TD>
                    <TD right style={{ fontWeight: 700, color: "var(--blue, #60a5fa)" }}>
                      {daysWorked}
                      {filterMode === "year" && monthlyDays && monthlyDays.length > 0 && (
                        <div style={{ marginTop: 3, display: "flex", flexDirection: "column", gap: 1, alignItems: "flex-end" }}>
                          {monthlyDays.map(md => (
                            <span key={md.m} style={{ fontSize: 9.5, fontWeight: 600, color: "var(--text3)" }}>
                              {md.m}: <span style={{ color: "var(--blue, #60a5fa)" }}>{md.days}d</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </TD>
                    <TD right style={{ fontWeight: 700, color: paidLeaves > 0 ? "var(--green)" : "var(--text3)" }}>{paidLeaves}</TD>
                    <TD right style={{ fontWeight: 700, color: lop > 0 ? "var(--red)" : "var(--text3)" }}>{lop}</TD>
                    {isAdmin && (
                      <TD right style={{ color: "var(--text2)", fontWeight: 600 }}>
                        {INR(monthlySalary)}
                        <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2, fontWeight: 600 }} title={`Per-day rate = monthly salary ÷ ${daysInRefMonth} days`}>
                          {INR(Math.round(monthlySalary / daysInRefMonth))}/day
                        </div>
                      </TD>
                    )}
                    {isAdmin && (
                      <TD right style={{ color: "var(--gold)", fontWeight: 600 }}>
                        {INR(curSalary)}
                        <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2, fontWeight: 600 }} title="Payable days used for the pro-rata calc (current month caps at yesterday, LOP subtracted)">
                          {payrollDays} day{payrollDays === 1 ? "" : "s"} paid
                        </div>
                      </TD>
                    )}
                    <TD right>
                      <span style={{ color: pct >= 100 ? "var(--green)" : "var(--blue)", fontWeight: 600 }}>{INR(billing)}</span>
                      <div style={{ height: 4, background: "var(--border2)", borderRadius: 4, marginTop: 4, overflow: "hidden", minWidth: 60 }}>
                        <div style={{ height: "100%", width: `${pct}%`, background: pct >= 100 ? "var(--green)" : pct >= 60 ? "var(--gold)" : "var(--blue)", borderRadius: 4 }} />
                      </div>
                      <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>{pct}%</div>
                    </TD>
                    <TD right style={{ fontWeight: 700, color: "var(--text2)" }}>{INR(staffTInc)}</TD>
                    <TD right style={{ color: "var(--text3)", fontWeight: 700 }}>{INR(totalSale)}</TD>
                    <TD>
                      {filterMode === "year" ? (
                        <button
                          onClick={() => setSelectedStaffHistory(s.id === selectedStaffHistory ? null : s.id)}
                          style={{ background: s.id === selectedStaffHistory ? "var(--gold)" : "rgba(255,255,255,0.05)", border: "none", color: s.id === selectedStaffHistory ? "#000" : "var(--gold)", borderRadius: 6, width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all .2s" }}
                          title="View Monthly History"
                        >
                          <Icon name="log" size={14} />
                        </button>
                      ) : (
                        <button
                          onClick={() => setStaffSalesCal(s.id)}
                          style={{ background: "rgba(255,255,255,0.05)", border: "none", color: "var(--accent)", borderRadius: 6, width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all .2s" }}
                          title="View daily sales calendar"
                        >
                          <Icon name="calendar" size={14} />
                        </button>
                      )}
                    </TD>
                  </tr>
                );
              })}
              {shownRows.length === 0 && <tr><td colSpan={isAdmin ? 14 : 12} style={{ textAlign: "center", padding: 24, color: "var(--text3)" }}>No {staffTab} staff in this branch</td></tr>}
              {shownRows.length > 0 && (
                <tr className="totals-row" style={{ background: "var(--bg3)", borderTop: "2px solid var(--border2)" }}>
                  <TD colSpan={8} style={{ fontWeight: 800, color: "var(--gold)" }}>
                    TOTAL ({shownRows.length} {staffTab})
                  </TD>
                  {isAdmin && <TD right style={{ fontWeight: 800, color: "var(--text2)" }}>{INR(totMonthly)}</TD>}
                  {isAdmin && <TD right style={{ fontWeight: 800, color: "var(--gold)" }}>{INR(totSalary)}</TD>}
                  <TD right style={{ fontWeight: 800, color: "var(--blue)" }}>{INR(totBilling)}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--text2)" }}>{INR(totStaffInc)}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--text3)" }}>{INR(totSale)}</TD>
                  <TD></TD>
                </tr>
              )}
            </tbody>
          </table>
        </Card>

        {/* Per-staff daily sales calendar (month view) */}
        {staffSalesCal && (() => {
          const s = branchStaff.find(x => x.id === staffSalesCal) || staff.find(x => x.id === staffSalesCal);
          if (!s) return null;
          const daysInMonth = new Date(filterYear, filterMonth, 0).getDate();
          // Map each day → this staff's sale (billing + material + tips) for that date.
          const byDay = {};
          periodEntries.forEach(e => {
            if (!e.date) return;
            const sb = (e.staff_billing || []).find(x => x.staff_id === s.id);
            if (!sb) return;
            const sale = (sb.billing || 0) + (sb.material || 0) + (sb.tips || 0);
            byDay[e.date] = (byDay[e.date] || 0) + sale;
          });
          const monthName = new Date(filterYear, filterMonth - 1, 1).toLocaleString("default", { month: "long" });
          const firstDow = new Date(filterYear, filterMonth - 1, 1).getDay();
          const cells = [];
          for (let i = 0; i < firstDow; i++) cells.push(null);
          for (let d = 1; d <= daysInMonth; d++) cells.push(d);
          const totalSaleMonth = Object.values(byDay).reduce((a, b) => a + b, 0);
          const workedDays = Object.values(byDay).filter(v => v > 0).length;
          return (
            <Modal isOpen onClose={() => setStaffSalesCal(null)} title={`${s.name} — Daily Sales · ${monthName} ${filterYear}`} width={560}>
              <div style={{ padding: 16 }}>
                <div style={{ display: "flex", gap: 16, marginBottom: 14, flexWrap: "wrap" }}>
                  <div><div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>Month Sale</div><div style={{ fontSize: 16, fontWeight: 800, color: "var(--green)" }}>{INR(totalSaleMonth)}</div></div>
                  <div><div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>Days w/ Sale</div><div style={{ fontSize: 16, fontWeight: 800, color: "var(--blue, #60a5fa)" }}>{workedDays}</div></div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
                  {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                    <div key={i} style={{ textAlign: "center", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", padding: "2px 0" }}>{d}</div>
                  ))}
                  {cells.map((d, i) => {
                    if (d === null) return <div key={`e${i}`} />;
                    const dateStr = `${filterYear}-${String(filterMonth).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
                    const sale = byDay[dateStr] || 0;
                    const has = sale > 0;
                    return (
                      <div key={dateStr} title={`${fmtShort(dateStr)}: ${INR(sale)}`}
                        style={{ minHeight: 52, borderRadius: 8, padding: "5px 4px", background: has ? "rgba(74,222,128,0.10)" : "var(--bg3)", border: has ? "1px solid rgba(74,222,128,0.3)" : "1px solid var(--border2)", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)" }}>{d}</div>
                        <div style={{ fontSize: 10.5, fontWeight: 800, color: has ? "var(--green)" : "var(--text3)", textAlign: "right" }}>{has ? INR(sale) : "₹0"}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </Modal>
          );
        })()}
        </>);
        })()}

        {/* Individual Staff Monthly History Breakdown — yearly view only */}
        {selectedStaffHistory && filterMode === "year" && (() => {
          const s = staff.find(x => x.id === selectedStaffHistory);
          if (!s) return null;
          const hist = [];
          for (let m = 1; m <= 12; m++) {
            if (!isPastYear && m > currentMonthNum) break; 
            const mPrefix = `${filterYear}-${String(m).padStart(2, '0')}`;
            const status = staffStatusForMonth(s, mPrefix);
            const mSal = proRataSalary(s, mPrefix, branches, salHistory, staff, globalSettings, leaves, entries);
            const mLeaves = staffLeavesInMonth(s.id, mPrefix, leaves);

            // Performance for the month
            const mEntries = entries.filter(e => e.branch_id === b.id && e.date.startsWith(mPrefix));
            let mBilling = 0, mInc = 0;
            mEntries.forEach(ent => {
              const sb = (ent.staff_billing || []).find(x => x.staff_id === s.id);
              if (sb) {
                mBilling += (sb.billing || 0);
                mInc += (sb.staff_total_inc || (sb.incentive || 0) + (sb.mat_incentive || 0) + (sb.tips || 0));
              }
            });

            hist.push({ month: mPrefix, ...status, salary: mSal, leaves: mLeaves, billing: mBilling, incentive: mInc });
          }
          return (
            <div style={{ marginTop: 20, animation: "fadeIn .3s ease-out" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--gold)" }}>Monthly Attendance & Performance History: {s.name} ({filterYear})</div>
                <button onClick={() => setSelectedStaffHistory(null)} style={{ background: "none", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>CLOSE ✕</button>
              </div>
              <Card>
                <table className="pill-table" style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
                  <thead><tr>
                    <TH>Month</TH><TH>Status</TH><TH right>Days Worked</TH><TH right>Leaves</TH><TH right>Billing</TH><TH right>Incentives</TH><TH right>Salary Drawn</TH>
                  </tr></thead>
                  <tbody>
                    {hist.map(h => (
                      <tr key={h.month}>
                        <TD style={{ fontWeight: 600 }}>{new Date(h.month + "-01").toLocaleString('default', { month: 'long' })}</TD>
                        <TD>
                          <Pill 
                            label={h.status.toUpperCase()} 
                            color={h.status === 'active' ? 'green' : h.status === 'partial' ? 'blue' : 'gray'} 
                          />
                        </TD>
                        <TD right style={{ fontWeight: 700 }}>{h.daysWorked} days</TD>
                        <TD right style={{ color: "var(--red)", fontWeight: 600 }}>{h.leaves > 0 ? h.leaves : "—"}</TD>
                        <TD right style={{ color: "var(--blue)", fontWeight: 700 }}>{INR(h.billing)}</TD>
                        <TD right style={{ color: "var(--text2)", fontWeight: 700 }}>{INR(h.incentive)}</TD>
                        <TD right style={{ color: "var(--gold)", fontWeight: 700 }}>{INR(h.salary)}</TD>
                      </tr>
                    ))}
                    <tr className="totals-row" style={{ background: "var(--bg3)", borderTop: "2px solid var(--border2)" }}>
                      <TD style={{ fontWeight: 800, color: "var(--gold)" }}>YEARLY TOTAL</TD>
                      <TD colSpan={2}></TD>
                      <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{hist.reduce((s, x) => s + x.leaves, 0)}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--blue)" }}>{INR(hist.reduce((s, x) => s + x.billing, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--text2)" }}>{INR(hist.reduce((s, x) => s + x.incentive, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--gold)" }}>{INR(hist.reduce((s, x) => s + x.salary, 0))}</TD>
                    </tr>
                  </tbody>
                </table>
              </Card>
            </div>
          );
        })()}

        {/* Breakdown Table */}
        {openSections.has("performance") && (
        <div style={{ marginTop: 24, marginBottom: 24 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, color: "var(--gold)" }}>
            {filterMode === "month" ? "Daily Performance Breakdown" : "Monthly Performance Breakdown"} ({filterYear})
          </div>
            <Card>
              <table className="pill-table" style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5 }}>
                <thead><tr>
                  <TH>{filterMode === "month" ? "Date" : "Month"}</TH>
                  <TH right>Income</TH>
                  <TH right>Inc.</TH>
                  <TH right>Mat.</TH>
                  <TH right title="Lumpsum material typed into the Daily Entry form">Lumpsum Mat.</TH>
                  <TH right>Petrol</TH>
                  <TH right>Rent (S)</TH>
                  <TH right>Rent (R)</TH>
                  <TH right>Elec.</TH>
                  <TH right>WiFi</TH>
                  <TH right>Salary</TH>
                  <TH right title="Projected salary for future days not yet entered">Future Salary</TH>
                  <TH right title={`GST extraction @ ${gstPct}% on online income`}>GST ({gstPct}%)</TH>
                  <TH right title="Projected fixed cost + salary share for future days not yet entered">Est. Expense</TH>
                  <TH right>{filterMode === "month" ? "Leave Entry" : "Leaves"}</TH>
                  <TH right title="Expected cash in drawer per the formula">Expected CIH</TH>
                  <TH right title="Physically counted cash">Actual CIH</TH>
                  <TH right title="Actual − Expected. Positive = excess, negative = deficit.">Def / Exc</TH>
                  <TH right>Net P&L</TH>
                </tr></thead>
                <tbody>
                  {breakdownStats.map(m => (
                    <tr key={m.label} style={m.isFuture ? { background: "rgba(251,146,60,0.04)" } : undefined}>
                      <TD style={{ fontWeight: 600, color: m.isFuture ? "var(--text3)" : undefined }}>
                        {m.label} {filterYear}
                        {m.isFuture && <span style={{ marginLeft: 6, fontSize: 9, padding: "1px 5px", borderRadius: 4, background: "rgba(251,146,60,0.15)", color: "var(--orange)", fontWeight: 700, letterSpacing: 0.5 }}>EST</span>}
                      </TD>
                      <TD right style={{ color: "var(--green)" }}>{m.income > 0 ? INR(m.income) : "—"}</TD>
                      <TD right style={{ color: "var(--red)" }}>{m.incentives > 0 ? INR(m.incentives) : "—"}</TD>
                      <TD right style={{ color: "var(--red)" }}>{m.material > 0 ? INR(m.material) : "—"}</TD>
                      <TD right style={{ color: "var(--accent)" }}>{(m.lumpsumMat || 0) > 0 ? INR(m.lumpsumMat) : "—"}</TD>
                      <TD right style={{ color: "var(--red)" }}>{m.others > 0 ? INR(m.others) : "—"}</TD>
                      <TD right style={{ color: "var(--orange)" }}>{INR(m.shopRent)}</TD>
                      <TD right style={{ color: "var(--orange)" }}>{INR(m.roomRent)}</TD>
                      <TD right style={{ color: "var(--orange)" }}>{INR(m.elec)}</TD>
                      <TD right style={{ color: "var(--orange)" }}>{INR(m.wifi)}</TD>
                      <TD right style={{ color: "var(--blue)" }}>
                        {m.salary > 0 ? (
                          isAdmin ? (
                            <button
                              onClick={() => {
                                const monthPrefix = filterMode === "month" ? filterPrefix : m.monthPrefix;
                                if (!monthPrefix) return;
                                const daysInMonth = new Date(Number(monthPrefix.slice(0, 4)), Number(monthPrefix.slice(5, 7)), 0).getDate();
                                const monthStaff = staff.filter(s => s.branch_id === b.id && staffStatusForMonth(s, monthPrefix).status !== 'inactive');
                                // For daily mode we also work out per-staff presence on THAT specific day,
                                // so each row's "Day Share" reflects base/30 when present (or on paid leave)
                                // and 0 when absent — matching the salon's actual payroll arithmetic.
                                const specificDate = filterMode === "month" ? m.date : null;
                                const staffRows = monthStaff.map(s => {
                                  const base = Number(s.salary) || 0;
                                  const proRated = proRataSalary(s, monthPrefix, branches, salHistory, staff, globalSettings, leaves, entries);
                                  let dayStatus = 'present';
                                  let dayShare = base / daysInMonth;
                                  if (specificDate) {
                                    // String-compare YYYY-MM-DD values — lexicographic order equals chronological
                                    // and avoids the timezone mismatch between `new Date("2026-04-01")` (UTC midnight)
                                    // and `new Date("2026-04-01T00:00")` (local midnight). In IST the latter was
                                    // 5.5h earlier, so a staff joining on the same day was wrongly flagged NOT_ACTIVE.
                                    const sameOrAfterJoin = !s.join || specificDate >= s.join;
                                    const sameOrBeforeExit = !s.exit_date || specificDate <= s.exit_date;
                                    if (!sameOrAfterJoin || !sameOrBeforeExit) {
                                      dayStatus = 'not_active';
                                      dayShare = 0;
                                    } else {
                                      // Approved leaves this month for this staff, ordered — first N (per branch type quota)
                                      // are paid; anything beyond is unpaid.
                                      const staffLeaves = leaves.filter(l => l.staff_id === s.id && l.status === 'approved' && l.date?.startsWith(monthPrefix))
                                        .sort((x, y) => (x.date || '').localeCompare(y.date || ''));
                                      const branch = branches.find(x => x.id === s.branch_id);
                                      let quota = branch?.type === 'unisex' ? 3 : 2;
                                      if (branch?.type === 'mens' && globalSettings?.mens_leaves !== undefined) quota = globalSettings.mens_leaves;
                                      if (branch?.type === 'unisex' && globalSettings?.unisex_leaves !== undefined) quota = globalSettings.unisex_leaves;
                                      // Running count of paid-leave days as we walk ordered leaves — once quota is hit,
                                      // the next day of leave is unpaid.
                                      let paidUsed = 0;
                                      let thisLeave = null;
                                      let thisLeavePaid = false;
                                      for (const l of staffLeaves) {
                                        const days = Number(l.days) || 1;
                                        const paidHere = Math.min(days, Math.max(0, quota - paidUsed));
                                        if (l.date === specificDate) {
                                          thisLeave = l;
                                          thisLeavePaid = paidHere > 0;
                                          break;
                                        }
                                        paidUsed += paidHere;
                                      }
                                      if (thisLeave) {
                                        if (thisLeavePaid) {
                                          dayStatus = 'paid_leave';
                                          dayShare = base / daysInMonth;
                                        } else {
                                          dayStatus = 'absent';
                                          dayShare = 0;
                                        }
                                      }
                                    }
                                  }
                                  return { id: s.id, name: s.name, role: s.role || "", base, proRated, dayStatus, dayShare };
                                }).sort((a, z) => z.dayShare - a.dayShare || z.proRated - a.proRated);
                                const monthlyTotal = staffRows.reduce((s, r) => s + r.proRated, 0);
                                const dayTotal = staffRows.reduce((s, r) => s + r.dayShare, 0);
                                setSalaryDetail({
                                  branchName: b.name,
                                  label: m.label,
                                  mode: filterMode,
                                  daysInMonth,
                                  monthlyTotal,
                                  salary: m.salary,
                                  dayTotal,
                                  staffRows,
                                });
                              }}
                              style={{ background: "transparent", border: "none", color: "var(--blue)", cursor: "pointer", padding: 0, fontSize: "inherit", fontWeight: "inherit", fontFamily: "inherit", textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 }}
                              title="Salary breakdown — admin only"
                            >
                              {INR(m.salary)}
                            </button>
                          ) : INR(m.salary)
                        ) : "—"}
                      </TD>
                      <TD right style={{ color: "var(--purple, #c084fc)" }}>{(m.futureSalary || 0) > 0 ? INR(m.futureSalary) : "—"}</TD>
                      <TD right style={{ color: "var(--red)" }}>{(m.gst || 0) > 0 ? INR(m.gst) : "—"}</TD>
                      <TD right style={{ color: "var(--orange)" }}>{(m.estExpense || 0) > 0 ? INR(m.estExpense) : "—"}</TD>
                      <TD right style={{ fontWeight: 600, color: "var(--text3)" }}>{m.leaves}</TD>
                      <TD right style={{ fontWeight: 700, color: (m.expectedCih || 0) >= 0 ? "var(--green)" : "var(--red)" }}>{m.isFuture || (m.expectedCih || 0) === 0 ? "—" : INR(m.expectedCih)}</TD>
                      <TD right style={{ fontWeight: 700, color: m.actualCih == null ? "var(--text3)" : m.actualCih >= 0 ? "var(--green)" : "var(--red)" }}>{m.actualCih == null ? "—" : INR(m.actualCih)}</TD>
                      <TD right style={{ fontWeight: 700, whiteSpace: "nowrap", color: m.cashDiff == null ? "var(--text3)" : m.cashDiff === 0 ? "var(--green)" : m.cashDiff > 0 ? "var(--green)" : "var(--red)" }}
                        title={m.cashDiff == null ? "Actual cash not recorded" : m.cashDiff === 0 ? "Match" : m.cashDiff > 0 ? `Excess ${INR(m.cashDiff)}` : `Deficit ${INR(Math.abs(m.cashDiff))}`}>
                        {m.cashDiff == null ? "—" : m.cashDiff === 0 ? "✓ Match" : m.cashDiff > 0 ? `▲ ${INR(m.cashDiff)}` : `▼ ${INR(Math.abs(m.cashDiff))}`}
                      </TD>
                      <TD right style={{ fontWeight: 700, color: m.pl >= 0 ? "var(--green)" : "var(--red)" }}>{isAdmin ? (INR(m.pl)) : "•••••"}</TD>
                    </tr>
                  ))}
                  {breakdownStats.length > 0 && (
                    <tr className="totals-row" style={{ background: "var(--bg3)", borderTop: "2px solid var(--border2)" }}>
                      <TD style={{ fontWeight: 800, color: "var(--gold)" }}>TOTAL ({plabel})</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--green)" }}>{INR(breakdownStats.reduce((s, m) => s + m.income, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{INR(breakdownStats.reduce((s, m) => s + m.incentives, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{INR(breakdownStats.reduce((s, m) => s + m.material, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--accent)" }}>{INR(breakdownStats.reduce((s, m) => s + (m.lumpsumMat || 0), 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{INR(breakdownStats.reduce((s, m) => s + m.others, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{INR(breakdownStats.reduce((s, m) => s + m.shopRent, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{INR(breakdownStats.reduce((s, m) => s + m.roomRent, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{INR(breakdownStats.reduce((s, m) => s + m.elec, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{INR(breakdownStats.reduce((s, m) => s + m.wifi, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--blue)" }}>{INR(breakdownStats.reduce((s, m) => s + m.salary, 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--purple, #c084fc)" }}>{INR(breakdownStats.reduce((s, m) => s + (m.futureSalary || 0), 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{INR(breakdownStats.reduce((s, m) => s + (m.gst || 0), 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{INR(breakdownStats.reduce((s, m) => s + (m.estExpense || 0), 0))}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--text2)" }}>{breakdownStats.reduce((s, m) => s + m.leaves, 0)}</TD>
                      {(() => {
                        const totExp = breakdownStats.reduce((s, m) => s + (m.expectedCih || 0), 0);
                        const anyActual = breakdownStats.some(m => m.actualCih != null);
                        const totAct = anyActual ? breakdownStats.reduce((s, m) => s + (m.actualCih || 0), 0) : null;
                        const anyDiff = breakdownStats.some(m => m.cashDiff != null);
                        const totDiff = anyDiff ? breakdownStats.reduce((s, m) => s + (m.cashDiff || 0), 0) : null;
                        return <>
                          <TD right style={{ fontWeight: 800, color: totExp >= 0 ? "var(--green)" : "var(--red)" }}>{INR(totExp)}</TD>
                          <TD right style={{ fontWeight: 800, color: totAct == null ? "var(--text3)" : totAct >= 0 ? "var(--green)" : "var(--red)" }}>{totAct == null ? "—" : INR(totAct)}</TD>
                          <TD right style={{ fontWeight: 800, whiteSpace: "nowrap", color: totDiff == null ? "var(--text3)" : totDiff === 0 ? "var(--green)" : totDiff > 0 ? "var(--green)" : "var(--red)" }}>
                            {totDiff == null ? "—" : totDiff === 0 ? "✓ Match" : totDiff > 0 ? `▲ ${INR(totDiff)}` : `▼ ${INR(Math.abs(totDiff))}`}
                          </TD>
                        </>;
                      })()}
                      <TD right style={{ fontWeight: 800, color: breakdownStats.reduce((s, m) => s + m.pl, 0) >= 0 ? "var(--green)" : "var(--red)" }}>
                        {isAdmin ? INR(breakdownStats.reduce((s, m) => s + m.pl, 0)) : "•••••"}
                      </TD>
                    </tr>
                  )}
                </tbody>
              </table>
            </Card>
          </div>
        )}

        {/* Materials Received */}
        {openSections.has("materials") && (() => {
          const matIdToGroup = new Map(materialsMaster.map(m => [m.id, (m.group || "").toString()]));
          const branchAllocs = materialAllocations.filter(a => a.branch_id === b.id && (a.date || a.transferred_at || "").startsWith(filterMode === "year" ? String(filterYear) : filterPrefix));
          const flatRowsAll = branchAllocs.flatMap(a =>
            (a.items || []).map((it, i) => ({
              ...it,
              group: it.group || matIdToGroup.get(it.material_id) || "",
              date: a.date || (a.transferred_at || "").slice(0, 10),
              transferred_at: a.transferred_at,
              allocation_id: a.id,
              key: `${a.id}-${i}`,
              line_total: Number(it.line_total) || (Number(it.qty) * Number(it.price_at_transfer)) || 0,
            }))
          );
          const groupOptions = Array.from(new Set(flatRowsAll.map(r => r.group).filter(Boolean))).sort();
          const search = matSearch.trim().toLowerCase();
          const filteredRows = flatRowsAll.filter(r => {
            if (matGroupFilter && r.group !== matGroupFilter) return false;
            if (search && !(r.name || "").toLowerCase().includes(search) && !(r.group || "").toLowerCase().includes(search)) return false;
            return true;
          });
          const flatRows = matSort.sortRows(filteredRows, {
            date:  r => r.date || "",
            name:  r => (r.name || "").toLowerCase(),
            group: r => (r.group || "").toLowerCase(),
            qty:   r => Number(r.qty) || 0,
            unit:  r => (r.unit || "").toLowerCase(),
            price: r => Number(r.price_at_transfer) || 0,
            total: r => Number(r.line_total) || 0,
          });
          // Default sort: newest date first, then biggest line.
          if (!matSort.sortCol) {
            flatRows.sort((x, y) => (y.date || "").localeCompare(x.date || "") || (y.line_total - x.line_total));
          }
          const totalReceived = flatRows.reduce((s, r) => s + r.line_total, 0);
          const totalQty = flatRows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
          const totalAll = flatRowsAll.reduce((s, r) => s + r.line_total, 0);
          return (
            <div style={{ marginTop: 24, marginBottom: 24 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 10 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--gold)" }}>
                    Materials Received — {filterMode === "year" ? String(filterYear) : plabel}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>
                    Showing <strong style={{ color: "var(--text2)" }}>{flatRows.length}</strong> of {flatRowsAll.length} line{flatRowsAll.length === 1 ? "" : "s"}
                    {(matSearch || matGroupFilter) && <span style={{ color: "var(--accent)", marginLeft: 6 }}>· filtered</span>}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "var(--text3)", textAlign: "right" }}>
                  <div>Filtered total <strong style={{ color: "var(--accent)", fontSize: 14, marginLeft: 4 }}>{INR(totalReceived)}</strong></div>
                  {(matSearch || matGroupFilter) && totalAll !== totalReceived && (
                    <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>Period grand total {INR(totalAll)}</div>
                  )}
                </div>
              </div>
              {/* Toolbar — search + group filter + reset */}
              <Card style={{ padding: 12, marginBottom: 10, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                <div style={{ position: "relative", flex: "1 1 240px", minWidth: 200 }}>
                  <input value={matSearch} onChange={e => setMatSearch(e.target.value)}
                    placeholder="Search material or group…"
                    style={{ width: "100%", padding: "9px 32px 9px 34px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12.5, outline: "none" }} />
                  <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "var(--text3)", pointerEvents: "none" }}>🔍</span>
                  {matSearch && (
                    <button onClick={() => setMatSearch("")} title="Clear search"
                      style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", padding: "2px 8px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text3)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>✕</button>
                  )}
                </div>
                <SearchSelect
                  value={matGroupFilter}
                  onChange={v => setMatGroupFilter(v || "")}
                  options={groupOptions.map(g => ({ value: g, label: g }))}
                  allowEmpty
                  placeholder="All Groups"
                  buttonStyle={{ padding: "9px 14px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12.5, minWidth: 160 }}
                />
                {(matSearch || matGroupFilter) && (
                  <button onClick={() => { setMatSearch(""); setMatGroupFilter(""); }}
                    style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text2)", fontSize: 11, fontWeight: 700, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
                    Reset
                  </button>
                )}
                <div style={{ marginLeft: "auto", fontSize: 10, color: "var(--text3)", display: "flex", gap: 14, flexWrap: "wrap" }}>
                  <span>Qty <strong style={{ color: "var(--blue)", fontSize: 12 }}>{totalQty}</strong></span>
                  <span>Lines <strong style={{ color: "var(--text2)", fontSize: 12 }}>{flatRows.length}</strong></span>
                </div>
              </Card>
              <Card style={{ padding: 0, overflowX: "auto" }}>
                <table className="pill-table" style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5, minWidth: 720 }}>
                  <thead><tr>
                    <TH sort={matSort} sortKey="date">Date</TH>
                    <TH sort={matSort} sortKey="name">Material</TH>
                    <TH sort={matSort} sortKey="group">Group</TH>
                    <TH right sort={matSort} sortKey="qty">Qty</TH>
                    <TH sort={matSort} sortKey="unit">Unit</TH>
                    <TH right sort={matSort} sortKey="price">Unit Price</TH>
                    <TH right sort={matSort} sortKey="total">Line Total</TH>
                  </tr></thead>
                  <tbody>
                    {flatRows.map(r => (
                      <tr key={r.key}>
                        <TD style={{ whiteSpace: "nowrap", fontWeight: 600 }}>{r.date || "—"}</TD>
                        <TD style={{ fontWeight: 700 }}>{r.name}</TD>
                        <TD>{r.group ? (
                          <span style={{ padding: "2px 8px", borderRadius: 999, background: "rgba(34,211,238,0.12)", color: "var(--accent)", fontSize: 9.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap" }}>{r.group}</span>
                        ) : <span style={{ color: "var(--text3)", fontSize: 11, fontStyle: "italic" }}>—</span>}</TD>
                        <TD right style={{ color: "var(--blue)", fontWeight: 700 }}>{r.qty}</TD>
                        <TD style={{ color: "var(--text3)" }}>{r.unit || "pcs"}</TD>
                        <TD right style={{ color: "var(--text3)" }}>{INR(r.price_at_transfer || 0)}</TD>
                        <TD right style={{ color: "var(--green)", fontWeight: 800 }}>{INR(r.line_total)}</TD>
                      </tr>
                    ))}
                    {flatRows.length === 0 && (
                      <tr><td colSpan={7} style={{ textAlign: "center", padding: 24, color: "var(--text3)", fontStyle: "italic" }}>
                        {flatRowsAll.length === 0 ? "No materials transferred to this branch in this period." : "No rows match the current filters."}
                      </td></tr>
                    )}
                    {flatRows.length > 0 && (
                      <tr className="totals-row" style={{ background: "var(--bg3)", borderTop: "2px solid var(--border2)" }}>
                        <TD style={{ fontWeight: 800, color: "var(--gold)" }} colSpan={3}>TOTAL</TD>
                        <TD right style={{ fontWeight: 800, color: "var(--blue)" }}>{totalQty}</TD>
                        <TD colSpan={2}></TD>
                        <TD right style={{ fontWeight: 800, color: "var(--accent)" }}>{INR(totalReceived)}</TD>
                      </tr>
                    )}
                  </tbody>
                </table>
              </Card>

              {/* Material Consumption Dashboard — per-material cards. Click any
                  card to reveal its date-by-date timeline + line chart for this
                  branch in the current period. */}
              {flatRows.length > 0 && (() => {
                const byMat = new Map();
                flatRows.forEach(r => {
                  const key = r.material_id || r.name;
                  const e = byMat.get(key) || { key, name: r.name, unit: r.unit || "pcs", qty: 0, value: 0, count: 0, dates: new Map() };
                  const lt = Number(r.line_total) || (Number(r.qty) * Number(r.price_at_transfer)) || 0;
                  const q = Number(r.qty) || 0;
                  e.qty += q; e.value += lt; e.count += 1;
                  const dr = e.dates.get(r.date) || { qty: 0, value: 0 };
                  dr.qty += q; dr.value += lt;
                  e.dates.set(r.date, dr);
                  byMat.set(key, e);
                });
                const matCards = Array.from(byMat.values()).map(m => ({
                  ...m,
                  series: Array.from(m.dates.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => ({ date, qty: v.qty, value: v.value })),
                })).sort((a, b) => b.value - a.value);
                const grandValue = matCards.reduce((s, m) => s + m.value, 0);
                const expanded = matCards.find(m => m.key === expandedMat);
                return (
                  <div style={{ marginTop: 24 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, flexWrap: "wrap", gap: 10 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "var(--accent)" }}>
                        Material Consumption Dashboard ({matCards.length})
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text3)" }}>
                        Click any card to drill into its date-by-date timeline. Sorted by spend.
                      </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
                      {matCards.map(m => {
                        const isOpen = expandedMat === m.key;
                        const sharePct = grandValue > 0 ? (m.value / grandValue) * 100 : 0;
                        const maxQty = m.series.reduce((mx, s) => Math.max(mx, s.qty), 0) || 1;
                        const W = 220, H = 36;
                        const step = m.series.length > 1 ? W / (m.series.length - 1) : 0;
                        const points = m.series.map((s, i) => `${(i * step).toFixed(1)},${(H - (s.qty / maxQty) * (H - 4) - 2).toFixed(1)}`).join(" ");
                        return (
                          <div key={m.key} role="button" tabIndex={0}
                            onClick={() => setExpandedMat(isOpen ? null : m.key)}
                            onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setExpandedMat(isOpen ? null : m.key); } }}
                            style={{
                              padding: 14, borderRadius: 12,
                              background: isOpen ? "rgba(34,211,238,0.1)" : "var(--bg3)",
                              border: `1.5px solid ${isOpen ? "var(--accent)" : "var(--border2)"}`,
                              cursor: "pointer",
                              transition: "background .15s, border .15s, transform .15s",
                              transform: isOpen ? "translateY(-1px)" : "none",
                              boxShadow: isOpen ? "0 6px 18px rgba(34,211,238,0.22)" : "none",
                              display: "flex", flexDirection: "column", gap: 8,
                            }}>
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                              <div style={{ fontSize: 12.5, fontWeight: 800, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={m.name}>{m.name}</div>
                              <div style={{ fontSize: 9, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.6 }}>{sharePct.toFixed(1)}%</div>
                            </div>
                            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                              <div>
                                <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6 }}>Qty</div>
                                <div style={{ fontSize: 14, fontWeight: 800, color: "var(--blue)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{m.qty} <span style={{ fontSize: 10, color: "var(--text3)", fontWeight: 600 }}>{m.unit}</span></div>
                              </div>
                              <div style={{ textAlign: "right" }}>
                                <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6 }}>Value</div>
                                <div style={{ fontSize: 14, fontWeight: 800, color: "var(--green)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(m.value)}</div>
                              </div>
                            </div>
                            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H }}>
                              <polyline points={points} fill="none" stroke={isOpen ? "var(--accent)" : "rgba(34,211,238,0.55)"} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
                              {m.series.map((s, i) => (
                                <circle key={i} cx={(i * step).toFixed(1)} cy={(H - (s.qty / maxQty) * (H - 4) - 2).toFixed(1)} r={1.8} fill={isOpen ? "var(--accent)" : "rgba(34,211,238,0.7)"} />
                              ))}
                            </svg>
                            <div style={{ fontSize: 10, color: "var(--text3)", display: "flex", justifyContent: "space-between" }}>
                              <span>{m.count} transfer{m.count === 1 ? "" : "s"}</span>
                              <span>{m.series.length} day{m.series.length === 1 ? "" : "s"}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {expanded && (() => {
                      const maxBarQty = expanded.series.reduce((mx, s) => Math.max(mx, s.qty), 0) || 1;
                      const W = 720, H = 160, padL = 36, padR = 12, padT = 12, padB = 28;
                      const innerW = W - padL - padR, innerH = H - padT - padB;
                      const step = expanded.series.length > 0 ? innerW / Math.max(expanded.series.length, 1) : 0;
                      return (
                        <Card style={{ marginTop: 14, padding: 16, border: "1.5px solid var(--accent)", background: "rgba(34,211,238,0.05)" }}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
                            <div>
                              <div style={{ fontSize: 9, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1.2 }}>Detail</div>
                              <div style={{ fontSize: 16, fontWeight: 800, color: "var(--text)", marginTop: 2 }}>{expanded.name}</div>
                            </div>
                            <div style={{ display: "flex", gap: 14, alignItems: "baseline" }}>
                              <div><span style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>Qty</span> <strong style={{ fontSize: 14, color: "var(--blue)", marginLeft: 4 }}>{expanded.qty} {expanded.unit}</strong></div>
                              <div><span style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>Value</span> <strong style={{ fontSize: 14, color: "var(--green)", marginLeft: 4 }}>{INR(expanded.value)}</strong></div>
                              <button onClick={() => setExpandedMat(null)}
                                style={{ padding: "6px 12px", borderRadius: 8, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Close</button>
                            </div>
                          </div>
                          <div style={{ overflowX: "auto" }}>
                            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 480, height: H }}>
                              {[0, 0.5, 1].map(t => (
                                <line key={t} x1={padL} x2={W - padR} y1={padT + innerH * (1 - t)} y2={padT + innerH * (1 - t)} stroke="var(--border)" strokeDasharray="3 3" />
                              ))}
                              {[0, 0.5, 1].map(t => (
                                <text key={t} x={padL - 4} y={padT + innerH * (1 - t) + 3} textAnchor="end" fontSize={9} fill="var(--text3)">{Math.round(maxBarQty * t)}</text>
                              ))}
                              {expanded.series.map((s, i) => {
                                const barW = Math.max(step * 0.55, 8);
                                const barH = (s.qty / maxBarQty) * innerH;
                                const x = padL + i * step + (step - barW) / 2;
                                const y = padT + innerH - barH;
                                return (
                                  <g key={s.date}>
                                    <rect x={x} y={y} width={barW} height={barH} fill="url(#matBarGrad)" rx={2}>
                                      <title>{`${s.date} · ${s.qty} ${expanded.unit} · ${INR(s.value)}`}</title>
                                    </rect>
                                    <text x={x + barW / 2} y={H - padB + 12} textAnchor="middle" fontSize={8} fill="var(--text3)">{s.date.slice(8, 10)}</text>
                                  </g>
                                );
                              })}
                              <defs>
                                <linearGradient id="matBarGrad" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.95" />
                                  <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.45" />
                                </linearGradient>
                              </defs>
                            </svg>
                          </div>
                          <div style={{ marginTop: 12, overflowX: "auto" }}>
                            <table className="pill-table" style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
                              <thead><tr>
                                <TH>Date</TH>
                                <TH right>Qty</TH>
                                <TH>Unit</TH>
                                <TH right>Value</TH>
                              </tr></thead>
                              <tbody>
                                {expanded.series.map(s => (
                                  <tr key={s.date}>
                                    <TD style={{ fontWeight: 600 }}>{s.date}</TD>
                                    <TD right style={{ color: "var(--blue)", fontWeight: 700 }}>{s.qty}</TD>
                                    <TD style={{ color: "var(--text3)" }}>{expanded.unit}</TD>
                                    <TD right style={{ color: "var(--green)", fontWeight: 800 }}>{INR(s.value)}</TD>
                                  </tr>
                                ))}
                                <tr className="totals-row">
                                  <TD style={{ fontWeight: 800, color: "var(--gold)" }}>TOTAL</TD>
                                  <TD right style={{ fontWeight: 800, color: "var(--blue)" }}>{expanded.qty}</TD>
                                  <TD style={{ color: "var(--text3)" }}>{expanded.unit}</TD>
                                  <TD right style={{ fontWeight: 800, color: "var(--accent)" }}>{INR(expanded.value)}</TD>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </Card>
                      );
                    })()}
                  </div>
                );
              })()}
            </div>
          );
        })()}

        {/* Recent Entries */}
        {openSections.has("entries") && (<>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, color: "var(--gold)" }}>Recent Entries ({periodEntries.length})</div>
        <Card>
          <table className="pill-table" style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5 }}>
            <thead><tr>
              <TH>Date</TH><TH right>Online</TH><TH right>Cash</TH><TH right>GST</TH><TH right>Billing</TH><TH right>Incentive</TH><TH right>Staff T.Inc</TH><TH right>Staff T.Sale</TH><TH right>Expected CIH</TH><TH right>Actual CIH</TH><TH right>Def / Exc</TH>
              {canEdit && <TH sticky> </TH>}
            </tr></thead>
            <tbody>
              {periodEntries.map(e => {
                const totalBillingE = (e.staff_billing || []).reduce((s, sb) => s + (sb.billing || 0), 0);
                const totalMatE = (e.staff_billing || []).reduce((s, sb) => s + (sb.material || 0), 0);
                const totalIncE = (e.staff_billing || []).reduce((s, sb) => s + (sb.incentive || 0) + (sb.mat_incentive || 0), 0);
                const totalTipsE = (e.staff_billing || []).reduce((s, sb) => s + (sb.tips || 0), 0);
                const staffTIncE = (e.staff_billing || []).reduce((s, sb) => s + (sb.staff_total_inc || 0), 0);
                const staffTSaleE = totalBillingE + totalMatE + totalTipsE;
                const cih = e.cash_in_hand !== undefined ? e.cash_in_hand : (e.cash || 0) - totalIncE - totalTipsE - (e.others || 0);
                const actualCih = e.actual_cash == null ? null : Number(e.actual_cash) || 0;
                return (
                  <tr key={e.id}>
                    <TD style={{ fontWeight: 600 }}>{e.date}</TD>
                    <TD right style={{ color: "var(--green)" }}>{INR(e.online || 0)}</TD>
                    <TD right style={{ color: "var(--green)" }}>{INR(e.cash || 0)}</TD>
                    <TD right style={{ color: "var(--green)" }}>{INR(e.total_gst || 0)}</TD>
                    <TD right style={{ fontWeight: 600, color: "var(--green)" }}>{INR(totalBillingE)}</TD>
                    <TD right style={{ color: "var(--red)" }}>{INR(totalIncE)}</TD>
                    <TD right style={{ color: "var(--gold)", fontWeight: 700 }}>{INR(staffTIncE)}</TD>
                    <TD right style={{ color: "var(--text2)", fontWeight: 700 }}>{INR(staffTSaleE)}</TD>
                    <TD right style={{ fontWeight: 700, color: cih >= 0 ? "var(--green)" : "var(--red)" }} title="Expected cash-in-hand">{INR(cih)}</TD>
                    <TD right style={{ fontWeight: 700, color: actualCih == null ? "var(--text3)" : actualCih >= 0 ? "var(--green)" : "var(--red)" }} title={actualCih == null ? "Actual cash not recorded" : "Physically counted cash"}>{actualCih == null ? "—" : INR(actualCih)}</TD>
                    <TD right style={{ fontWeight: 700, color: e.cash_diff == null ? "var(--text3)" : e.cash_diff === 0 ? "var(--green)" : e.cash_diff > 0 ? "var(--green)" : "var(--red)", whiteSpace: "nowrap" }}
                      title={e.cash_diff == null ? "Actual cash not recorded" : e.cash_diff === 0 ? "Match" : e.cash_diff > 0 ? `Excess ${INR(e.cash_diff)}` : `Deficit ${INR(Math.abs(e.cash_diff))}`}>
                      {e.cash_diff == null ? "—" : e.cash_diff === 0 ? "✓ Match" : e.cash_diff > 0 ? `▲ ${INR(e.cash_diff)}` : `▼ ${INR(Math.abs(e.cash_diff))}`}
                    </TD>
                    {canEdit && <TD sticky><div style={{ display: "flex", gap: 6 }}>
                      <IconBtn name="log" title="View log" variant="secondary" onClick={() => setLogView(e)} />
                      <IconBtn name="edit" title="Edit" variant="secondary" onClick={() => router.push(`/dashboard/entry?edit=${e.id}`)} />
                      <IconBtn name="del" title="Delete" variant="danger" onClick={() => handleDeleteEntry(e.id)} />
                    </div></TD>}
                  </tr>
                );
              })}
              {periodEntries.length === 0 && <tr><td colSpan={canEdit ? 12 : 11} style={{ textAlign: "center", padding: 24, color: "var(--text3)" }}>No entries for this period</td></tr>}
            </tbody>
          </table>
        </Card>
        </>)}

        {/* Audit Log Modal */}
        {logView && (
          <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
            <div style={{ background: "rgba(15,15,20,0.95)", border: "1px solid rgba(255,215,0,0.2)", borderRadius: 24, padding: 32, width: "100%", maxWidth: 420, boxShadow: "0 25px 50px -12px rgba(0,0,0,0.5)", position: "relative" }}>
              <button onClick={() => setLogView(null)} style={{ position: "absolute", top: 20, right: 20, background: "rgba(255,255,255,0.05)", border: "none", color: "var(--text3)", borderRadius: "50%", width: 32, height: 32, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all .2s" }}>✕</button>
              <div style={{ fontSize: 20, fontWeight: 800, color: "var(--gold)", marginBottom: 24, letterSpacing: 0.5 }}>Activity Timeline</div>
              <div style={{ maxHeight: 400, overflowY: "auto", paddingRight: 10, display: "flex", flexDirection: "column", gap: 0 }}>
                {(logView.activity_log || []).slice().reverse().map((log, idx) => (
                  <div key={idx} style={{ display: "flex", gap: 16, position: "relative", paddingBottom: 24 }}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                      <div style={{ width: 10, height: 10, borderRadius: "50%", background: log.action === "Create" ? "var(--green)" : "var(--gold)", marginTop: 4, zIndex: 1 }} />
                      {idx !== (logView.activity_log || []).length - 1 && (
                        <div style={{ width: 2, flex: 1, background: "rgba(255,255,255,0.1)", margin: "4px 0" }} />
                      )}
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: "var(--text3)", marginBottom: 4, fontWeight: 700, textTransform: "uppercase" }}>
                        {new Date(log.time).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} · {new Date(log.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>{log.action} by {log.user}</div>
                      <div style={{ fontSize: 12, color: "var(--text3)", lineHeight: "1.5", background: "rgba(255,255,255,0.03)", padding: "8px 12px", borderRadius: 8 }}>{log.notes}</div>
                    </div>
                  </div>
                ))}
                {(!logView.activity_log || logView.activity_log.length === 0) && (
                  <div style={{ color: "var(--text3)", fontSize: 14, textAlign: "center", padding: 40, border: "2px dashed rgba(255,255,255,0.05)", borderRadius: 16 }}>No history records found.</div>
                )}
              </div>
              <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text3)" }}>
                <span>REF: {logView.id.slice(0, 8)}</span>
                <span style={{ color: "var(--red)", fontWeight: 700 }}>GST {logView.global_gst_pct || 0}%</span>
              </div>
            </div>
          </div>
        )}
        {attendanceModalEl}
        {recalcModalEl}
        {salaryDetailEl}
        {ConfirmDialog}
        {ToastContainer}
      </div>
    );
  }

  // ── Main Branch List ─────────────────────────────────────────────
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>Branches</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", flex: 1, justifyContent: "flex-end", minWidth: 0 }}>
          <BranchEmployeeSearch
            branches={branches}
            staff={staff}
            onSelect={({ type, branchId, staffId }) => {
              setSelectedBranch(branchId);
              setStaffFocusId(type === "staff" ? staffId : null);
              if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            placeholder="Search branch or employee..."
            style={{ maxWidth: 360 }}
          />
          {isAdmin && <button onClick={() => { setForm({ name: "", type: "mens", location: "", shop_rent: "", room_rent: "", salary_budget: "", wifi: "", shop_elec: "", room_elec: "" }); setEditId(null); setShowForm(!showForm); }} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderRadius: 10, background: "linear-gradient(135deg,var(--gold),var(--gold2))", color: "#000", border: "none", cursor: "pointer", fontWeight: 700, fontSize: 13 }}>
            <Icon name="plus" size={14} /> Add Branch
          </button>}
        </div>
      </div>

      <PeriodWidget filterMode={filterMode} setFilterMode={setFilterMode} filterYear={filterYear} setFilterYear={setFilterYear} filterMonth={filterMonth} setFilterMonth={setFilterMonth} />

      {/* Bulk recalculate action bar — always visible for admin/accountant so
          "Select all / Recalculate all" is a one-click action. */}
      {canEdit && branches.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", padding: "10px 16px", marginBottom: 12, borderRadius: 10, background: selectedBranches.size > 0 ? "linear-gradient(135deg, rgba(96,165,250,0.10), rgba(34,211,238,0.06))" : "var(--bg3)", border: `1px solid ${selectedBranches.size > 0 ? "rgba(96,165,250,0.25)" : "var(--border)"}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
            {selectedBranches.size > 0 ? (
              <>
                <span style={{ fontWeight: 800, color: "var(--blue, #60a5fa)" }}>{selectedBranches.size}</span>
                <span style={{ color: "var(--text2)", fontWeight: 600 }}>of {branches.length} branch{branches.length === 1 ? "" : "es"} selected</span>
              </>
            ) : (
              <span style={{ color: "var(--text3)", fontWeight: 600 }}>No branches selected — tick cards or use Select All to batch recalculate.</span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {selectedBranches.size === branches.length ? (
              <button onClick={clearBranchSelection}
                style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", fontWeight: 700, fontSize: 11, cursor: "pointer" }}>
                Clear
              </button>
            ) : (
              <button onClick={selectAllBranches}
                style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg4)", color: "var(--accent)", border: "1px solid var(--border2)", fontWeight: 700, fontSize: 11, cursor: "pointer" }}>
                Select All ({branches.length})
              </button>
            )}
            {selectedBranches.size > 0 && selectedBranches.size < branches.length && (
              <button onClick={clearBranchSelection}
                style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 11, cursor: "pointer" }}>
                Clear
              </button>
            )}
            <button onClick={openBulkRecalc} disabled={selectedBranches.size === 0}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, background: selectedBranches.size === 0 ? "var(--bg4)" : "linear-gradient(135deg, var(--accent), var(--gold2))", color: selectedBranches.size === 0 ? "var(--text3)" : "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: selectedBranches.size === 0 ? "not-allowed" : "pointer", opacity: selectedBranches.size === 0 ? 0.6 : 1 }}>
              <Icon name="check" size={13} /> Recalculate {selectedBranches.size === 0 ? "" : selectedBranches.size === branches.length ? "All" : "Selected"}
            </button>
          </div>
        </div>
      )}

      {/* Add/Edit Form */}
      {showForm && isAdmin && (
        <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: "inset 0 2px 10px rgba(0,0,0,.2)" }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 16, paddingBottom: 10, borderBottom: "1px solid var(--border)", color: "var(--gold)", textTransform: "uppercase" }}>{editId ? "Edit Branch" : "Add Branch"}</div>
          <form onSubmit={handleSave}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 12, marginBottom: 16 }}>
              {[["Name","name","text"],["Location","location","text"],["Shop Rent","shop_rent","number"],["Room Rent","room_rent","number"],["Salary Budget","salary_budget","number"],["WiFi","wifi","number"],["Shop Electricity","shop_elec","number"],["Room Electricity","room_elec","number"]].map(([label, key, type]) => (
                <div key={key} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={{ fontSize: 12, color: "var(--text2)", fontWeight: 700, textTransform: "capitalize", letterSpacing: 1 }}>{label}</label>
                  <input type={type} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} style={{ padding: "12px 16px", border: "2px solid var(--input-border)", borderRadius: 10, fontSize: 14, background: "var(--bg2)", color: "var(--text)", fontFamily: "var(--font-outfit)", width: "100%", outline: "none" }} />
                </div>
              ))}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 12, color: "var(--text2)", fontWeight: 700, textTransform: "capitalize", letterSpacing: 1 }}>Type</label>
                <SearchSelect
                  value={form.type}
                  onChange={v => setForm({ ...form, type: v })}
                  options={[{ value: "mens", label: "Mens" }, { value: "unisex", label: "Unisex" }]}
                  allowEmpty={false}
                  style={{ width: "100%" }}
                  buttonStyle={{ padding: "12px 16px", border: "2px solid var(--input-border)", borderRadius: 10, fontSize: 14, background: "var(--bg2)", color: "var(--text)", fontFamily: "var(--font-outfit)" }}
                />
              </div>
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
              <button type="submit" style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 18px", borderRadius: 10, background: "linear-gradient(135deg,var(--gold),var(--gold2))", color: "#000", border: "none", cursor: "pointer", fontWeight: 700 }}>
                <Icon name="save" size={14} /> {editId ? "Update" : "Save"} Branch
              </button>
              <button type="button" onClick={() => setShowForm(false)} style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", cursor: "pointer", fontWeight: 600 }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", border: "1px solid var(--border2)", borderRadius: 10, background: "var(--bg4)" }}>
          <ToggleGroup label="P&L" options={[["all","All"],["profit","Profit"],["loss","Loss"]]} value={brFilter} onChange={setBrFilter} />
        </div>
        {isAdmin && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", border: "1px solid var(--border2)", borderRadius: 10, background: "var(--bg4)" }}>
            <ToggleGroup label="Target" options={[["all","All"],["met","Met"],["notmet","Not Met"]]} value={brTargetFilter} onChange={setBrTargetFilter}
              colors={{ all: "var(--blue)", met: "var(--green)", notmet: "var(--red)" }} />
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", border: "1px solid var(--border2)", borderRadius: 10, background: "var(--bg4)" }}>
          <ToggleGroup label="Type" options={[["all","All"],["mens","Mens"],["unisex","Unisex"]]} value={brTypeFilter} onChange={setBrTypeFilter} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".5px" }}>Sort</span>
          <SearchSelect
            value={brSortCol}
            onChange={v => setBrSortCol(v)}
            options={[{ value: "name", label: "Name" }, { value: "income", label: "Income" }, { value: "pl", label: "Net P&L" }, { value: "expense", label: "Expenses" }]}
            allowEmpty={false}
            buttonStyle={{ padding: "4px 8px", border: "1px solid var(--border2)", borderRadius: 16, fontSize: 11, background: "var(--bg4)", color: "var(--text)", fontFamily: "var(--font-outfit)" }}
          />
          <ToggleGroup options={[["asc","Asc ↑"],["desc","Desc ↓"]]} value={brSortDir} onChange={setBrSortDir} />
          <button
            title="Save current sort as default"
            onClick={() => {
              try { localStorage.setItem("vcut_branch_sort", JSON.stringify({ col: brSortCol, dir: brSortDir })); } catch {}
              const colLabel = { income: "Income", pl: "Net P&L", expense: "Expenses", name: "Name" }[brSortCol] || brSortCol;
              toast({ title: "Default saved", message: `Branch sort: ${colLabel} ${brSortDir === "desc" ? "↓" : "↑"}`, type: "success" });
            }}
            style={{ padding: "4px 8px", borderRadius: 16, fontSize: 10, fontWeight: 700, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--accent)", cursor: "pointer", letterSpacing: ".5px", textTransform: "uppercase" }}
          >
            Save default
          </button>
        </div>
        <div style={{ marginLeft: "auto" }}>
          <ToggleGroup label="View" options={[["card","⬛ Cards"],["table","☰ Table"],["summary","📋 Summary"]]} value={brView} onChange={setBrView} />
        </div>
      </div>

      {/* Summary View */}
      {brView === "summary" ? (
        <SummaryView
          summaryTab={summaryTab}
          setSummaryTab={setSummaryTab}
          branchData={branchData}
          branches={branches}
          entries={entries}
          globalSettings={globalSettings}
          filterMode={filterMode}
          filterPrefix={filterPrefix}
          filterYear={filterYear}
          filterMonth={filterMonth}
          isAdmin={isAdmin}
          initialDailyCashExpanded={dailyCashExpanded}
          onDailyCashExpandedConsumed={() => setDailyCashExpanded(null)}
        />
      ) : brView === "table" ? (
        <Card style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 11.5, minWidth: 1000 }}>
            <thead><tr>
              {canEdit && (
                <TH style={{ width: 32, textAlign: "center" }}>
                  <input type="checkbox"
                    checked={branchData.length > 0 && selectedBranches.size === branchData.length}
                    onChange={() => {
                      if (selectedBranches.size === branchData.length) clearBranchSelection();
                      else setSelectedBranches(new Set(branchData.map(d => d.b.id)));
                    }}
                    style={{ cursor: "pointer", accentColor: "var(--accent)" }} />
                </TH>
              )}
              <TH>Branch</TH>
              <TH>Type</TH>
              <TH right>Income</TH>
              <TH right>Inc.</TH>
              <TH right>Mat.</TH>
              <TH right>Petrol</TH>
              <TH right>Rent (S)</TH>
              <TH right>Rent (R)</TH>
              <TH right>Elec.</TH>
              <TH right>WiFi</TH>
              <TH right>Salary</TH>
              <TH right>Leaves</TH>
              <TH right>Net P&L</TH>
            </tr></thead>
            <tbody>
              {branchData.map(({ b, i, vInc, vMatE, vPetrol, fShopRent, fRoomRent, fElec, fWifi, actualSalary, actualLeaves, n }) => (
                <tr key={b.id} style={{ cursor: "pointer" }} onClick={() => setSelectedBranch(b.id)}>
                  {canEdit && (
                    <TD style={{ textAlign: "center" }} onClick={e => { e.stopPropagation(); toggleBranchSelect(b.id); }}>
                      <input type="checkbox" readOnly checked={selectedBranches.has(b.id)}
                        style={{ cursor: "pointer", accentColor: "var(--accent)" }} />
                    </TD>
                  )}
                  <TD style={{ fontWeight: 700, whiteSpace: "nowrap" }}>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <button onClick={e => { e.stopPropagation(); setAttendanceCalendar(b.id); setAttendanceMonth(filterMode === "month" ? filterPrefix : `${filterYear}-${String(NOW.getMonth() + 1).padStart(2, "0")}`); setAttendanceSelectedDay(null); }}
                        title="Attendance calendar"
                        style={{ background: "rgba(var(--accent-rgb),0.08)", border: "1px solid rgba(var(--accent-rgb),0.3)", color: "var(--accent)", borderRadius: 6, padding: "2px 6px", cursor: "pointer", fontSize: 11, lineHeight: 1 }}>📅</button>
                      <span>{b.name.replace("V-CUT ", "")}</span>
                    </div>
                  </TD>
                  <TD><Pill label={b.type === "unisex" ? "Unisex" : "Mens"} color={b.type === "unisex" ? "purple" : "blue"} /></TD>
                  <TD right style={{ color: "var(--green)", fontWeight: 600 }}>{INR(i)}</TD>
                  <TD right style={{ color: "var(--red)" }}>{INR(vInc)}</TD>
                  <TD right style={{ color: "var(--red)" }}>{INR(vMatE)}</TD>
                  <TD right style={{ color: "var(--red)" }}>{INR(vPetrol)}</TD>
                  <TD right style={{ color: "var(--orange)" }}>{INR(fShopRent)}</TD>
                  <TD right style={{ color: "var(--orange)" }}>{INR(fRoomRent)}</TD>
                  <TD right style={{ color: "var(--orange)" }}>{INR(fElec)}</TD>
                  <TD right style={{ color: "var(--orange)" }}>{INR(fWifi)}</TD>
                  <TD right style={{ color: "var(--blue)" }}>{isAdmin ? INR(actualSalary) : MASK}</TD>
                  <TD right style={{ color: "var(--text3)", fontWeight: 600 }}>{actualLeaves}</TD>
                  <TD right style={{ fontWeight: 700, color: n >= 0 ? "var(--green)" : "var(--red)" }}>
                    {isAdmin ? (INR(n)) : MASK}
                  </TD>
                </tr>
              ))}
              {branchData.length > 0 && (
                <tr className="totals-row" style={{ background: "var(--bg3)", borderTop: "2px solid var(--border2)" }}>
                  {canEdit && <TD></TD>}
                  <TD style={{ fontWeight: 800, color: "var(--gold)" }}>TOTAL ({plabel})</TD>
                  <TD> </TD>
                  <TD right style={{ fontWeight: 800, color: "var(--green)" }}>{INR(branchData.reduce((s, d) => s + d.i, 0))}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{INR(branchData.reduce((s, d) => s + d.vInc, 0))}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{INR(branchData.reduce((s, d) => s + d.vMatE, 0))}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{INR(branchData.reduce((s, d) => s + d.vPetrol, 0))}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{INR(branchData.reduce((s, d) => s + d.fShopRent, 0))}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{INR(branchData.reduce((s, d) => s + d.fRoomRent, 0))}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{INR(branchData.reduce((s, d) => s + d.fElec, 0))}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{INR(branchData.reduce((s, d) => s + d.fWifi, 0))}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--blue)" }}>{isAdmin ? INR(branchData.reduce((s, d) => s + d.actualSalary, 0)) : MASK}</TD>
                  <TD right style={{ fontWeight: 800, color: "var(--text2)" }}>{branchData.reduce((s, d) => s + d.actualLeaves, 0)}</TD>
                  <TD right style={{ fontWeight: 800, color: branchData.reduce((s, d) => s + d.n, 0) >= 0 ? "var(--green)" : "var(--red)" }}>
                    {isAdmin ? INR(branchData.reduce((s, d) => s + d.n, 0)) : MASK}
                  </TD>
                </tr>
              )}
              {branchData.length === 0 && <tr><td colSpan={canEdit ? 14 : 13} style={{ textAlign: "center", padding: 20, color: "var(--text3)" }}>No branches match filters</td></tr>}
            </tbody>
          </table>
        </Card>
      ) : (
        /* Card View */
        <DraggableBranchGrid
           branchData={branchData}
           isAdmin={isAdmin}
           canSelect={canEdit}
           selectedBranches={selectedBranches}
           onToggleSelect={toggleBranchSelect}
           onCardClick={setSelectedBranch}
           onCalendarClick={(bid) => { setAttendanceCalendar(bid); setAttendanceMonth(filterMode === "month" ? filterPrefix : `${filterYear}-${String(NOW.getMonth() + 1).padStart(2, "0")}`); setAttendanceSelectedDay(null); }}
        />
      )}
      {attendanceModalEl}
      {recalcModalEl}
      {salaryDetailEl}
      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}

// ─── Draggable Branch Card Grid (Branches Page Version) ────────────────────────

function DraggableBranchGrid({ branchData, isAdmin, canSelect, selectedBranches, onToggleSelect, onCardClick, onCalendarClick }) {
  const [cardOrder, setCardOrder] = useState([]);
  const [dragOver, setDragOver] = useState(null);
  const [dragging, setDragging] = useState(null);
  const dragId = useRef(null);
  const wasDragged = useRef(false);

  // Build ordered list using cardOrder (array of branch ids), fallback to branchData order
  const ordered = (() => {
    if (cardOrder.length === 0) return branchData;
    const map = Object.fromEntries(branchData.map(d => [d.b.id, d]));
    const list = cardOrder.map(id => map[id]).filter(Boolean);
    // Add any new ones
    branchData.forEach(d => { if (!cardOrder.includes(d.b.id)) list.push(d); });
    return list;
  })();

  const handleDragStart = (e, bid) => {
    wasDragged.current = true;
    dragId.current = bid;
    setDragging(bid);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", bid);
    }
  };

  const handleDragOver = (e, bid) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (dragId.current !== bid) setDragOver(bid);
  };

  const handleDrop = (e, targetId) => {
    e.preventDefault();
    const srcId = dragId.current;
    if (!srcId || srcId === targetId) { setDragOver(null); return; }
    const ids = ordered.map(d => d.b.id);
    const srcIdx = ids.indexOf(srcId);
    const tgtIdx = ids.indexOf(targetId);
    const newIds = [...ids];
    newIds.splice(srcIdx, 1);
    newIds.splice(tgtIdx, 0, srcId);
    setCardOrder(newIds);
    setDragOver(null);
  };

  const handleDragEnd = () => {
    dragId.current = null;
    setDragging(null);
    setDragOver(null);
    setTimeout(() => { wasDragged.current = false; }, 100);
  };

  const handleClick = (e, bid) => {
    if (wasDragged.current) {
      e.preventDefault();
      return;
    }
    onCardClick(bid);
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 16 }}>
      {ordered.map(({ b, i, vInc, vMatE, vOther, fShopRent, fRoomRent, fWifi, fElec, actualSalary, actualLeaves, n, staffCount, totalDeficit, totalExcess, netDiff, reconciledDays, shopTgt, targetMet, targetPct, targetShort, targetExcess }) => {
        const isDragging = dragging === b.id;
        const isOver = dragOver === b.id;
        const isSelected = selectedBranches?.has(b.id) || false;
        const isProfit = n > 0;
        const accent = isSelected ? "var(--accent)" : isProfit ? "var(--green)" : "var(--red)";
        const accentBg = isSelected ? "rgba(34,211,238,0.06)" : isProfit ? "rgba(74,222,128,0.06)" : "rgba(248,113,113,0.06)";

        return (
          <div key={b.id}
            draggable="true"
            onDragStart={(ev) => handleDragStart(ev, b.id)}
            onDragOver={(ev) => handleDragOver(ev, b.id)}
            onDrop={(ev) => handleDrop(ev, b.id)}
            onDragEnd={handleDragEnd}
            onClick={(ev) => handleClick(ev, b.id)}
            style={{
              position: "relative",
              background: `linear-gradient(168deg, var(--bg3) 0%, var(--bg2) 100%)`,
              border: isOver
                ? "1.5px dashed var(--gold)"
                : `1px solid ${isSelected ? "rgba(34,211,238,0.45)" : isProfit ? "rgba(74,222,128,0.22)" : "rgba(248,113,113,0.22)"}`,
              borderRadius: 14,
              overflow: "hidden",
              cursor: isDragging ? "grabbing" : "grab",
              transition: "transform .2s ease, box-shadow .2s ease, border-color .2s",
              opacity: isDragging ? 0.45 : 1,
              transform: isOver ? "scale(1.015)" : "scale(1)",
              boxShadow: isOver
                ? "0 10px 28px rgba(var(--gold-rgb),0.22)"
                : isDragging
                  ? "0 14px 36px rgba(0,0,0,0.55)"
                  : isSelected
                    ? "0 6px 22px rgba(34,211,238,0.25)"
                    : isProfit
                      ? "0 4px 18px rgba(0,0,0,0.28), 0 0 0 1px rgba(74,222,128,0.04) inset"
                      : "0 4px 18px rgba(0,0,0,0.28), 0 0 0 1px rgba(248,113,113,0.04) inset",
              userSelect: "none"
            }}
            onMouseEnter={ev => {
              if (!isDragging) ev.currentTarget.style.transform = "translateY(-2px)";
            }}
            onMouseLeave={ev => {
              if (!isDragging && !isOver) ev.currentTarget.style.transform = "scale(1)";
            }}
          >
            {/* Left accent stripe — profit/loss indicator at a glance */}
            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: `linear-gradient(180deg, ${accent}, transparent)`, opacity: 0.8 }} />

            {/* Header */}
            <div style={{ padding: "12px 14px 10px", display: "flex", alignItems: "center", gap: 8 }}>
              {canSelect && (
                <span
                  role="button"
                  tabIndex={-1}
                  draggable={false}
                  onClick={ev => { ev.stopPropagation(); ev.preventDefault(); onToggleSelect?.(b.id); }}
                  onMouseDown={ev => ev.stopPropagation()}
                  onPointerDown={ev => ev.stopPropagation()}
                  onDragStart={ev => { ev.preventDefault(); ev.stopPropagation(); }}
                  title={isSelected ? "Click to deselect" : "Click to select for bulk recalculate"}
                  style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: 22, height: 22, borderRadius: 5, flexShrink: 0,
                    background: isSelected ? "rgba(34,211,238,0.22)" : "var(--bg4)",
                    border: `1px solid ${isSelected ? "var(--accent)" : "var(--border2)"}`,
                    cursor: "pointer", transition: "all .15s",
                  }}>
                  {isSelected && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="3.5"><polyline points="20 6 9 17 4 12"/></svg>}
                </span>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div title={b.name} style={{ fontSize: 13, fontWeight: 800, color: "var(--text)", letterSpacing: 0.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{b.name.replace("V-CUT ", "")}</div>
                <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", marginTop: 1 }}>
                  {b.type === "unisex" ? "Unisex" : "Mens"} · {staffCount} staff
                </div>
              </div>
              <button onClick={ev => { ev.stopPropagation(); onCalendarClick?.(b.id); }}
                title="Attendance calendar"
                draggable={false}
                onMouseDown={ev => ev.stopPropagation()}
                onDragStart={ev => { ev.preventDefault(); ev.stopPropagation(); }}
                style={{ background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.3)", color: "var(--accent)", borderRadius: 7, width: 26, height: 26, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              </button>
            </div>

            {/* Hero: Income + P&L chip */}
            <div style={{ padding: "2px 14px 12px", display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 8.5, color: "var(--text3)", fontWeight: 800, letterSpacing: 1.4, textTransform: "uppercase" }}>Income</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "var(--green)", fontFamily: "var(--font-headline, var(--font-outfit))", letterSpacing: -0.5, lineHeight: 1.15 }}>
                  {INR(i)}
                </div>
              </div>
              <div style={{
                padding: "5px 10px", borderRadius: 999,
                background: isAdmin ? accentBg : "var(--bg4)",
                border: `1px solid ${isAdmin ? accent : "var(--border)"}`,
                color: isAdmin ? accent : "var(--text3)",
                fontSize: 11, fontWeight: 800, letterSpacing: 0.3,
                fontFamily: "var(--font-headline, var(--font-outfit))",
                whiteSpace: "nowrap", flexShrink: 0,
              }}>
                {isAdmin ? (n > 0 ? "▲ " : n < 0 ? "▼ " : "") + INR(Math.abs(n)) : "P&L •••"}
              </div>
            </div>

            {/* Metric grid — two columns, grouped visually by a thin inner divider */}
            <div style={{ padding: "0 14px 12px", display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 12, rowGap: 10, borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 0 }}>
              <ElegantRow label="Salary" val={isAdmin ? INR(actualSalary) : "•••••"} col="var(--blue)" />
              <ElegantRow label="Inc / Mat" val={INR(vInc + vMatE)} col="var(--red)" />
              <ElegantRow label="Rent (Shop)" val={INR(fShopRent)} col="var(--orange)" />
              <ElegantRow label="Rent (Room)" val={INR(fRoomRent)} col="var(--orange)" />
              <ElegantRow label="Elec / WiFi" val={INR(fElec + fWifi)} col="var(--orange)" />
              <ElegantRow label="Travel" val={INR(vOther)} col="var(--red)" />
              <ElegantRow label="Leaves" val={actualLeaves > 0 ? `${actualLeaves} days` : "None"} col={actualLeaves > 0 ? "var(--purple, #c084fc)" : "var(--text3)"} />
              <ElegantRow label="Staff" val={`${staffCount}`} col="var(--text2)" />
            </div>

            {/* Shop target pill — 3× salary. Admin-only (derives from salary). */}
            {isAdmin && shopTgt > 0 && (
              <div style={{ padding: "0 14px 12px" }}>
                <div style={{ padding: "7px 10px", borderRadius: 8,
                  background: targetMet ? "rgba(74,222,128,0.08)" : "rgba(248,113,113,0.08)",
                  border: `1px solid ${targetMet ? "rgba(74,222,128,0.3)" : "rgba(248,113,113,0.3)"}`,
                  display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 9, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>🎯 Target 3× · {INR(shopTgt)}</span>
                  <span style={{ fontSize: 10.5, fontWeight: 800, color: targetMet ? "var(--green)" : "var(--red)", letterSpacing: 0.3, whiteSpace: "nowrap" }}>
                    {targetMet ? `Met · +${INR(targetExcess)}` : `Short ${INR(targetShort)}`} · {targetPct}%
                  </span>
                </div>
              </div>
            )}

            {/* Reconciliation pill — replaces the old Deficit / Excess / Net cells */}
            {reconciledDays > 0 && (
              <div style={{ padding: "0 14px 12px" }}>
                {(() => {
                  let bg, bd, fg, label;
                  if (netDiff === 0) { bg = "rgba(74,222,128,0.10)"; bd = "rgba(74,222,128,0.3)"; fg = "var(--green)"; label = `✓ Reconciled · ${reconciledDays} day${reconciledDays === 1 ? "" : "s"}`; }
                  else if (netDiff > 0) { bg = "rgba(74,222,128,0.08)"; bd = "rgba(74,222,128,0.3)"; fg = "var(--green)"; label = `▲ Excess ${INR(netDiff)} · ${reconciledDays}d`; }
                  else { bg = "rgba(248,113,113,0.08)"; bd = "rgba(248,113,113,0.3)"; fg = "var(--red)"; label = `▼ Deficit ${INR(Math.abs(netDiff))} · ${reconciledDays}d`; }
                  return (
                    <div style={{ padding: "6px 10px", borderRadius: 8, background: bg, border: `1px solid ${bd}`, color: fg, fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3, textAlign: "center", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 9, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Cash recon</span>
                      <span>{label}</span>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Footer hint */}
            <div style={{ padding: "8px 14px", borderTop: "1px solid var(--border)", background: "rgba(0,0,0,0.15)", fontSize: 9, color: "var(--text3)", fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", textAlign: "center" }}>
              ⋮⋮ Drag · Click to open
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CompactStat({ label, val, col, bold }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 7, color: "var(--text3)", textTransform: "uppercase", fontWeight: 700, marginBottom: 1 }}>{label}</div>
      <div style={{ fontSize: 10.5, fontWeight: bold ? 800 : 700, color: col, whiteSpace: "nowrap" }}>{val}</div>
    </div>
  );
}

function ElegantRow({ label, val, col }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 8.5, color: "var(--text3)", fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      <span style={{ fontSize: 12.5, fontWeight: 700, color: col, fontFamily: "var(--font-headline, var(--font-outfit))", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", letterSpacing: -0.2 }}>{val}</span>
    </div>
  );
}

// ─── Summary View (read-only Excel-like layout) ─────────────────────────────

function SummaryView({ summaryTab, setSummaryTab, branchData, branches, entries, globalSettings, filterMode, filterPrefix, filterYear, filterMonth, isAdmin, initialDailyCashExpanded, onDailyCashExpandedConsumed }) {
  const MASK = "•••••";
  const gstPct = globalSettings?.gst_pct || 0;

  // Per-branch aggregates for the selected period
  const rows = branchData.map(d => {
    const b = d.b;
    const bEntries = entries.filter(e => e.branch_id === b.id && (filterMode === "month" ? e.date?.startsWith(filterPrefix) : e.date?.startsWith(String(filterYear))));
    const online = bEntries.reduce((s, e) => s + (e.online || 0), 0);
    const cash   = bEntries.reduce((s, e) => s + (e.cash || 0), 0);
    const matSale = bEntries.reduce((s, e) => s + (e.staff_billing || []).reduce((ss, sb) => ss + (sb.material || 0), 0), 0);
    const incomeTotal = online + cash + matSale;
    const cashExp = bEntries.reduce((s, e) => s + (e.others || 0), 0); // misc cash spent at branch
    // Keep GST as float (no per-branch round). Dashboard's Net P&L sums raw
    // floats and rounds once at INR() display, so per-branch rounding here was
    // drifting the grand P&L by a few rupees vs the Dashboard.
    const gst = (online * gstPct) / 100;
    const totalExp = d.vInc + d.vMatE + d.vPetrol + d.fShopRent + d.fRoomRent + d.fElec + d.fWifi + d.actualSalary + cashExp + gst;
    return { b, online, cash, matSale, incomeTotal, cashExp, gst, totalExp, d };
  });

  const totals = rows.reduce((acc, r) => ({
    online: acc.online + r.online,
    cash: acc.cash + r.cash,
    matSale: acc.matSale + r.matSale,
    incomeTotal: acc.incomeTotal + r.incomeTotal,
    cashExp: acc.cashExp + r.cashExp,
    vInc: acc.vInc + r.d.vInc,
    actualSalary: acc.actualSalary + r.d.actualSalary,
    fElec: acc.fElec + r.d.fElec,
    fShopElec: acc.fShopElec + (r.d.fShopElec || 0),
    fRoomElec: acc.fRoomElec + (r.d.fRoomElec || 0),
    fWifi: acc.fWifi + r.d.fWifi,
    fShopRent: acc.fShopRent + r.d.fShopRent,
    fRoomRent: acc.fRoomRent + r.d.fRoomRent,
    vPetrol: acc.vPetrol + r.d.vPetrol,
    vMatE: acc.vMatE + r.d.vMatE,
    gst: acc.gst + r.gst,
    totalExp: acc.totalExp + r.totalExp,
  }), { online: 0, cash: 0, matSale: 0, incomeTotal: 0, cashExp: 0, vInc: 0, actualSalary: 0, fElec: 0, fShopElec: 0, fRoomElec: 0, fWifi: 0, fShopRent: 0, fRoomRent: 0, vPetrol: 0, vMatE: 0, gst: 0, totalExp: 0 });

  // Per-branch salary stays masked to hide the breakdown, but the salary
  // subtotal cell + all totals show the full figure (including salary) so
  // the P&L actually reflects the business's bottom line.
  const grandPL = totals.incomeTotal - totals.totalExp;

  return (
    <div>
      {/* Sub-tab toggle — Summary vs Daily Cash & Online */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {[["summary", "📊 Summary View"], ["monthly", "📆 Monthly Business"], ["dailycash", "📅 Daily Cash & Online"]].map(([k, label]) => (
          <button key={k} onClick={() => setSummaryTab(k)}
            style={{
              padding: "10px 18px", borderRadius: 10, border: summaryTab === k ? "1px solid var(--accent)" : "1px solid var(--border)",
              background: summaryTab === k ? "linear-gradient(135deg, rgba(var(--accent-rgb),0.18), rgba(var(--accent-rgb),0.06))" : "var(--bg3)",
              color: summaryTab === k ? "var(--accent)" : "var(--text2)",
              fontWeight: 700, fontSize: 12, cursor: "pointer", transition: "all .15s",
              boxShadow: summaryTab === k ? "0 0 18px rgba(var(--accent-rgb),0.25)" : "none",
            }}>
            {label}
          </button>
        ))}
      </div>

      {summaryTab === "summary" ? (
        // Explicit 1:2 grid with minmax(0, …) so children can shrink below
        // their content width — that's what lets the inner overflow-x wrappers
        // actually trigger scroll instead of the whole card pushing past the
        // viewport edge. A one-off <style> adds a stacking breakpoint so
        // phones get each table full-width.
        <>
        <style>{`@media (max-width: 900px) { .vcut-summary-grid { grid-template-columns: minmax(0, 1fr) !important; } }`}</style>
        <div className="vcut-summary-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)", gap: 16 }}>
          {/* INCOME TABLE */}
          <Card style={{ padding: 0, overflow: "hidden", minWidth: 0 }}>
            <div style={{ padding: "12px 16px", background: "linear-gradient(135deg, rgba(74,222,128,0.18), rgba(74,222,128,0.04))", borderBottom: "1px solid rgba(74,222,128,0.25)", fontWeight: 800, color: "var(--green)", fontSize: 13, letterSpacing: 1.5, textAlign: "center" }}>INCOME</div>
            <div style={{ overflowX: "auto" }}>
              {/* minWidth forces the table wider than any narrow card so the
                  overflow-x wrapper's scrollbar always triggers when there's
                  not enough room — same pattern the Expenses table uses at
                  1100px. 560 gives each of the 5 columns ~110px of breathing
                  room so values like ₹1,15,880 never clip. */}
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 560 }}>
                <thead>
                  <tr style={{ background: "var(--bg4)" }}>
                    <TH style={{ width: 40 }}>SL</TH>
                    <TH>Branch</TH>
                    <TH right>Online</TH>
                    <TH right>Cash</TH>
                    <TH right>Total</TH>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.b.id}>
                      <TD style={{ color: "var(--text3)" }}>{i + 1}</TD>
                      <TD style={{ fontWeight: 700, whiteSpace: "nowrap" }}>{r.b.name.replace("V-CUT ", "")}</TD>
                      <TD right style={{ color: "var(--blue)" }}>{INR(r.online)}</TD>
                      <TD right style={{ color: "var(--green)" }}>{INR(r.cash)}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--green)" }}>{INR(r.incomeTotal)}</TD>
                    </tr>
                  ))}
                  <tr style={{ background: "var(--bg4)", borderTop: "2px solid var(--border2)" }}>
                    <TD></TD>
                    <TD style={{ fontWeight: 800, color: "var(--gold)" }}>SUB TOTAL</TD>
                    <TD right style={{ fontWeight: 800, color: "var(--blue)" }}>{INR(totals.online)}</TD>
                    <TD right style={{ fontWeight: 800, color: "var(--green)" }}>{INR(totals.cash)}</TD>
                    <TD right style={{ fontWeight: 800, color: "var(--green)" }}>{INR(totals.incomeTotal)}</TD>
                  </tr>
                  <tr style={{ background: "rgba(74,222,128,0.06)" }}>
                    <TD></TD>
                    <TD colSpan={3} style={{ fontWeight: 800, color: "var(--gold)", textAlign: "right" }}>TOTAL</TD>
                    <TD right style={{ fontWeight: 900, color: "var(--green)", fontSize: 14 }}>{INR(totals.incomeTotal)}</TD>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>

          {/* EXPENSES TABLE */}
          {/* minWidth: 0 lets this grid child actually shrink below its content
              width so the overflow-x wrapper underneath can scroll instead of
              pushing the whole page. */}
          <Card style={{ padding: 0, overflow: "hidden", minWidth: 0 }}>
            <div style={{ padding: "12px 16px", background: "linear-gradient(135deg, rgba(248,113,113,0.2), rgba(248,113,113,0.05))", borderBottom: "1px solid rgba(248,113,113,0.25)", fontWeight: 800, color: "var(--red)", fontSize: 13, letterSpacing: 1.5, textAlign: "center" }}>EXPENSES</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: 1100 }}>
                <thead>
                  <tr style={{ background: "var(--bg4)" }}>
                    <TH style={{ width: 32, fontSize: 9 }}>SL</TH>
                    <TH style={{ fontSize: 9 }}>Branch</TH>
                    <TH right style={{ fontSize: 9 }}>Cash Exp</TH>
                    <TH right style={{ fontSize: 9 }}>Incentives</TH>
                    <TH right style={{ fontSize: 9 }}>Salary</TH>
                    <TH right style={{ fontSize: 9 }}>Shop Elec</TH>
                    <TH right style={{ fontSize: 9 }}>Room Elec</TH>
                    <TH right style={{ fontSize: 9 }}>WiFi</TH>
                    <TH right style={{ fontSize: 9 }}>Shop Rent</TH>
                    <TH right style={{ fontSize: 9 }}>Room Rent</TH>
                    <TH right style={{ fontSize: 9 }}>Petrol</TH>
                    <TH right style={{ fontSize: 9 }}>Material</TH>
                    <TH right style={{ fontSize: 9 }}>GST 5%</TH>
                    <TH right style={{ fontSize: 9 }}>Total</TH>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.b.id}>
                      <TD style={{ color: "var(--text3)", fontSize: 10 }}>{i + 1}</TD>
                      <TD style={{ fontWeight: 700, whiteSpace: "nowrap", fontSize: 11 }}>{r.b.name.replace("V-CUT ", "")}</TD>
                      <TD right style={{ color: "var(--red)" }}>{INR(r.cashExp)}</TD>
                      <TD right style={{ color: "var(--red)" }}>{INR(r.d.vInc)}</TD>
                      <TD right style={{ color: "var(--blue)" }}>{isAdmin ? INR(r.d.actualSalary) : MASK}</TD>
                      <TD right style={{ color: "var(--orange)" }}>{INR(r.d.fShopElec)}</TD>
                      <TD right style={{ color: "var(--orange)" }}>{r.d.fRoomElec > 0 ? INR(r.d.fRoomElec) : "—"}</TD>
                      <TD right style={{ color: "var(--orange)" }}>{INR(r.d.fWifi)}</TD>
                      <TD right style={{ color: "var(--orange)" }}>{INR(r.d.fShopRent)}</TD>
                      <TD right style={{ color: "var(--orange)" }}>{INR(r.d.fRoomRent)}</TD>
                      <TD right style={{ color: "var(--red)" }}>{INR(r.d.vPetrol)}</TD>
                      <TD right style={{ color: "var(--red)" }}>{INR(r.d.vMatE)}</TD>
                      <TD right style={{ color: "var(--red)" }}>{INR(r.gst)}</TD>
                      <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{INR(r.totalExp)}</TD>
                    </tr>
                  ))}
                  <tr style={{ background: "var(--bg4)", borderTop: "2px solid var(--border2)" }}>
                    <TD></TD>
                    <TD style={{ fontWeight: 800, color: "var(--gold)" }}>SUB TOTAL</TD>
                    <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{INR(totals.cashExp)}</TD>
                    <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{INR(totals.vInc)}</TD>
                    <TD right style={{ fontWeight: 800, color: "var(--blue)" }}>{INR(totals.actualSalary)}</TD>
                    <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{INR(totals.fShopElec)}</TD>
                    <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{totals.fRoomElec > 0 ? INR(totals.fRoomElec) : "—"}</TD>
                    <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{INR(totals.fWifi)}</TD>
                    <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{INR(totals.fShopRent)}</TD>
                    <TD right style={{ fontWeight: 800, color: "var(--orange)" }}>{INR(totals.fRoomRent)}</TD>
                    <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{INR(totals.vPetrol)}</TD>
                    <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{INR(totals.vMatE)}</TD>
                    <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{INR(totals.gst)}</TD>
                    <TD right style={{ fontWeight: 900, color: "var(--red)" }}>{INR(totals.totalExp)}</TD>
                  </tr>
                  <tr style={{ background: "rgba(248,113,113,0.06)" }}>
                    <TD></TD>
                    <TD colSpan={12} style={{ fontWeight: 800, color: "var(--gold)", textAlign: "right" }}>TOTAL</TD>
                    <TD right style={{ fontWeight: 900, color: "var(--red)", fontSize: 14 }}>{INR(totals.totalExp)}</TD>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>

          {/* P&L summary card */}
          <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "center", marginTop: 8 }}>
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 16, padding: "18px 32px",
              borderRadius: 14, border: `2px solid ${grandPL >= 0 ? "var(--green)" : "var(--red)"}`,
              background: grandPL >= 0 ? "rgba(74,222,128,0.08)" : "rgba(248,113,113,0.08)",
              boxShadow: grandPL >= 0 ? "0 0 24px rgba(74,222,128,0.3)" : "0 0 24px rgba(248,113,113,0.3)",
            }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "var(--gold)", letterSpacing: 1.5 }}>PROFIT / LOSS</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: grandPL >= 0 ? "var(--green)" : "var(--red)" }}>
                {INR(grandPL)}
              </div>
            </div>
          </div>
        </div>
        </>
      ) : summaryTab === "monthly" ? (
        <MonthlyBusinessMatrix branches={branches} entries={entries} filterYear={filterYear} />
      ) : (
        <DailyCashOnline
          branches={branches}
          entries={entries}
          filterMode={filterMode}
          filterPrefix={filterPrefix}
          filterYear={filterYear}
          filterMonth={filterMonth}
          initialExpanded={initialDailyCashExpanded}
          onInitialExpandedConsumed={onDailyCashExpandedConsumed}
        />
      )}
    </div>
  );
}

// ─── Monthly Business Matrix — branch (rows) × month (columns) ───────────────
// Each cell = that branch's business (online + cash + material) for the month.
// A "Till Day N" mode re-sums every month over the same 1..N day window (N =
// the running month's latest day with data) so all months are comparable, and
// marks each prior month +/- vs the current month. Total column + Network row.
function MonthlyBusinessMatrix({ branches = [], entries = [], filterYear }) {
  const [mode, setMode] = useState("full"); // "full" | "till"
  const curYear = NOW.getFullYear();
  const curMonth = NOW.getMonth() + 1;
  const maxMonth = filterYear === curYear ? curMonth : 12;
  const monthCols = Array.from({ length: maxMonth }, (_, i) => i + 1);
  const tdMonth = filterYear === curYear ? curMonth : maxMonth; // reference month

  // "Till today" cutoff day — the running month's latest day with data (so the
  // window matches the dashboard's month-to-date). Falls back to today's date.
  const tillN = (() => {
    const prefix = `${curYear}-${String(curMonth).padStart(2, "0")}`;
    let last = 0;
    if (filterYear === curYear) {
      entries.forEach(e => { if (e.date && e.date.startsWith(prefix)) { const d = Number(e.date.slice(8, 10)); if (d > last) last = d; } });
    }
    return last || NOW.getDate();
  })();

  // Single pass → both full-month and till-N business per `${branchId}|${month}`.
  const cellFull = new Map(), cellTill = new Map();
  entries.forEach(e => {
    if (!e.date || !e.date.startsWith(String(filterYear))) return;
    const m = Number(e.date.slice(5, 7));
    if (m < 1 || m > maxMonth) return;
    const day = Number(e.date.slice(8, 10));
    const mat = (e.staff_billing || []).reduce((s, sb) => s + (sb.material || 0), 0);
    const v = (e.online || 0) + (e.cash || 0) + mat;
    const k = `${e.branch_id}|${m}`;
    cellFull.set(k, (cellFull.get(k) || 0) + v);
    if (day <= tillN) cellTill.set(k, (cellTill.get(k) || 0) + v);
  });
  const cell = mode === "till" ? cellTill : cellFull;
  const refIdx = monthCols.indexOf(tdMonth);

  const matrix = branches.map(b => {
    const perMonth = monthCols.map(m => cell.get(`${b.id}|${m}`) || 0);
    const refVal = refIdx >= 0 ? perMonth[refIdx] : 0;
    // In till-mode: how the current (reference) month compares to each month.
    const deltas = monthCols.map((m, ci) => (mode === "till" && m !== tdMonth) ? (refVal - perMonth[ci]) : null);
    return { b, perMonth, deltas, total: perMonth.reduce((s, v) => s + v, 0) };
  }).sort((a, b) => b.total - a.total);

  const colTotals = monthCols.map((_, ci) => matrix.reduce((s, r) => s + r.perMonth[ci], 0));
  const grandTotal = colTotals.reduce((s, v) => s + v, 0);

  // Compact ₹ for the dense cells; full INR lives in title tooltips + the Total column.
  const fmtK = (v) => v >= 100000 ? `₹${(v / 100000).toFixed(2)}L` : v >= 1000 ? `₹${Math.round(v / 1000)}k` : v > 0 ? `₹${v}` : "—";
  const fmtDK = (n) => { const a = Math.abs(Math.round(n)); const s = a >= 100000 ? `₹${(a / 100000).toFixed(1)}L` : a >= 1000 ? `₹${Math.round(a / 1000)}k` : `₹${a}`; return (n > 0 ? "▲ +" : n < 0 ? "▼ −" : "· ") + s; };
  const monLabel = (m) => new Date(filterYear, m - 1, 1).toLocaleString("en-US", { month: "short" });

  const thBase = { padding: "10px 12px", fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.8, color: "var(--text3)", whiteSpace: "nowrap", borderBottom: "1px solid var(--border)" };
  const stickyLeft = { position: "sticky", left: 0, zIndex: 2, background: "var(--bg2)" };
  const totalLabel = mode === "till" ? "Total · till N" : "Total";

  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "16px 18px 8px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 900, color: "var(--text)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>Monthly Business · {filterYear}</div>
          <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>
            Business = Online + Cash + Material per branch.{" "}
            {mode === "till"
              ? `Every month summed over days 1–${tillN} · +/- shows ${monLabel(tdMonth)} vs that month (same window).`
              : (filterYear === curYear ? `${monLabel(tdMonth)} is till date.` : "Full year.")}
          </div>
        </div>
        {/* Full-month vs same-window toggle */}
        <div style={{ display: "inline-flex", gap: 2, background: "var(--bg4)", padding: 3, borderRadius: 8, border: "1px solid var(--border)" }}>
          {[["full", "Full Month"], ["till", `Till Day ${tillN}`]].map(([k, label]) => (
            <button key={k} onClick={() => setMode(k)}
              style={{ padding: "5px 12px", borderRadius: 6, fontSize: 10.5, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", background: mode === k ? "var(--accent)" : "transparent", color: mode === k ? "#001418" : "var(--text3)", border: "none", cursor: "pointer" }}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, minWidth: 640 }}>
          <thead>
            <tr>
              <th style={{ ...thBase, ...stickyLeft, textAlign: "left", minWidth: 150 }}>Branch</th>
              {monthCols.map(m => (
                <th key={m} style={{ ...thBase, textAlign: "right", color: m === tdMonth ? "var(--accent)" : "var(--text3)" }}>
                  {monLabel(m)}{m === tdMonth ? (mode === "till" ? " · TD*" : " · TD") : ""}
                </th>
              ))}
              <th style={{ ...thBase, textAlign: "right", color: "var(--green)", background: "var(--bg3)" }}>{totalLabel}</th>
            </tr>
          </thead>
          <tbody>
            {matrix.map(r => (
              <tr key={r.b.id} style={{ transition: "background .15s" }}
                onMouseEnter={e => e.currentTarget.style.background = "var(--bg4)"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <td style={{ ...stickyLeft, padding: "9px 12px", fontSize: 12.5, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap", borderBottom: "1px solid var(--border)" }}>
                  {(r.b.name || "").replace("V-CUT ", "")}
                </td>
                {r.perMonth.map((v, ci) => {
                  const isRef = monthCols[ci] === tdMonth;
                  const delta = r.deltas[ci];
                  return (
                    <td key={ci} title={v > 0 ? INR(v) : ""} style={{ padding: "9px 12px", textAlign: "right", fontSize: 12, fontWeight: 700, color: v > 0 ? (isRef ? "var(--accent)" : "var(--text2)") : "var(--text3)", whiteSpace: "nowrap", borderBottom: "1px solid var(--border)", background: isRef ? "rgba(34,211,238,0.05)" : "transparent", fontFamily: "var(--font-headline, var(--font-outfit))" }}>
                      <div>{fmtK(v)}</div>
                      {delta != null && (
                        <div style={{ fontSize: 9, fontWeight: 800, marginTop: 1, color: delta > 0 ? "var(--green)" : delta < 0 ? "var(--red)" : "var(--text3)" }}>{fmtDK(delta)}</div>
                      )}
                    </td>
                  );
                })}
                <td style={{ padding: "9px 12px", textAlign: "right", fontSize: 12.5, fontWeight: 900, color: "var(--green)", whiteSpace: "nowrap", borderBottom: "1px solid var(--border)", background: "var(--bg3)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>
                    {INR(r.total)}
                </td>
              </tr>
            ))}
            {matrix.length === 0 && (
              <tr><td colSpan={monthCols.length + 2} style={{ padding: 24, textAlign: "center", color: "var(--text3)", fontStyle: "italic", fontSize: 12 }}>No business recorded for {filterYear}.</td></tr>
            )}
          </tbody>
          {matrix.length > 0 && (
            <tfoot>
              <tr>
                <td style={{ ...stickyLeft, padding: "11px 12px", fontSize: 11, fontWeight: 900, color: "var(--gold)", textTransform: "uppercase", letterSpacing: 0.8, borderTop: "2px solid var(--border2)", background: "var(--bg3)" }}>Network</td>
                {colTotals.map((v, ci) => {
                  const isRef = monthCols[ci] === tdMonth;
                  const delta = (mode === "till" && !isRef) ? (colTotals[refIdx] - v) : null;
                  return (
                    <td key={ci} title={v > 0 ? INR(v) : ""} style={{ padding: "11px 12px", textAlign: "right", fontSize: 12, fontWeight: 800, color: isRef ? "var(--accent)" : "var(--text)", whiteSpace: "nowrap", borderTop: "2px solid var(--border2)", background: "var(--bg3)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>
                      <div>{fmtK(v)}</div>
                      {delta != null && (
                        <div style={{ fontSize: 9, fontWeight: 800, marginTop: 1, color: delta > 0 ? "var(--green)" : delta < 0 ? "var(--red)" : "var(--text3)" }}>{fmtDK(delta)}</div>
                      )}
                    </td>
                  );
                })}
                <td style={{ padding: "11px 12px", textAlign: "right", fontSize: 13, fontWeight: 900, color: "var(--green)", whiteSpace: "nowrap", borderTop: "2px solid var(--border2)", background: "rgba(74,222,128,0.08)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(grandTotal)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {mode === "till" && (
        <div style={{ padding: "8px 18px 14px", fontSize: 10, color: "var(--text3)" }}>
          * {monLabel(tdMonth)} is the reference month (days 1–{tillN}). ▲ green = {monLabel(tdMonth)} ahead of that month over the same window · ▼ red = behind.
        </div>
      )}
    </Card>
  );
}

// ─── Daily Cash & Online — three collapsible cards ─────────────────────────

function DailyCashOnline({ branches, entries, filterMode, filterPrefix, filterYear, filterMonth, initialExpanded, onInitialExpandedConsumed }) {
  const [expanded, setExpanded] = useState(null); // "online" | "cash" | "total" | "missing" | null

  // Honour an initial ?expand=... deep-link from the dashboard once, then clear
  // it so the user can collapse the card freely afterwards without it snapping
  // back on re-render.
  useEffect(() => {
    if (initialExpanded && ["online", "cash", "total", "missing"].includes(initialExpanded)) {
      setExpanded(initialExpanded);
      onInitialExpandedConsumed?.();
    }
  }, [initialExpanded, onInitialExpandedConsumed]);

  // Build the list of days in the selected period.
  const days = (() => {
    const out = [];
    if (filterMode === "month") {
      const count = new Date(filterYear, filterMonth, 0).getDate();
      for (let d = 1; d <= count; d++) out.push(`${filterPrefix}-${String(d).padStart(2, "0")}`);
    } else {
      for (let m = 1; m <= 12; m++) {
        const prefix = `${filterYear}-${String(m).padStart(2, "0")}`;
        const count = new Date(filterYear, m, 0).getDate();
        for (let d = 1; d <= count; d++) out.push(`${prefix}-${String(d).padStart(2, "0")}`);
      }
    }
    return out;
  })();

  // `${branch_id}|${date}` → { online, cash } for O(1) lookup
  const byKey = new Map();
  entries.forEach(e => {
    if (!e.branch_id || !e.date) return;
    const k = `${e.branch_id}|${e.date}`;
    const prev = byKey.get(k) || { online: 0, cash: 0 };
    byKey.set(k, { online: prev.online + (e.online || 0), cash: prev.cash + (e.cash || 0) });
  });

  const dayOfWeek = (dateStr) => new Date(`${dateStr}T00:00:00`).toLocaleDateString("en-US", { weekday: "short" }).toUpperCase();
  // `field` = "online" | "cash" | "total" — total pulls both streams.
  const cell = (bid, date, field) => {
    const rec = byKey.get(`${bid}|${date}`);
    if (!rec) return 0;
    if (field === "total") return rec.online + rec.cash;
    return rec[field] || 0;
  };

  // Per-card stats: grand total + daily average (only days with any business).
  const stats = (field) => {
    let total = 0, activeDays = 0;
    days.forEach(d => {
      const dayTotal = branches.reduce((s, b) => s + cell(b.id, d, field), 0);
      total += dayTotal;
      if (dayTotal > 0) activeDays += 1;
    });
    const avg = activeDays ? Math.round(total / activeDays) : 0;
    return { total, avg, activeDays };
  };

  const cards = [
    { key: "online", label: "Daily Online / UPI", color: "var(--blue)", rgb: "34,211,238" },
    { key: "cash",   label: "Daily Cash",         color: "var(--green)", rgb: "74,222,128" },
    { key: "total",  label: "Daily Total",        color: "var(--gold)",  rgb: "250,204,21" },
    { key: "missing", label: "Missing Entries",   color: "var(--red)",   rgb: "248,113,113" },
  ];

  // Capped at yesterday — today's entry may still be in progress, so only
  // past-and-closed days count as "missing". Compare as YYYY-MM-DD strings
  // so local vs UTC midnight doesn't come into play (same pitfall as the
  // staff join-day salary bug).
  const yesterdayStr = (() => {
    const now = new Date();
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
  })();
  const missingRows = days
    .filter(d => d <= yesterdayStr)
    .map(date => ({ date, missing: branches.filter(b => !byKey.has(`${b.id}|${date}`)) }))
    .filter(r => r.missing.length > 0);
  const missingCount = missingRows.reduce((s, r) => s + r.missing.length, 0);

  const renderMissing = () => (
    <div style={{ borderTop: "1px solid var(--border)", overflowX: "auto", maxHeight: "60vh" }}>
      {missingRows.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--green)", fontWeight: 700, fontSize: 13 }}>
          ✓ All branches have entries through {yesterdayStr}
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 11 }}>
          <thead style={{ position: "sticky", top: 0, zIndex: 5 }}>
            <tr style={{ background: "var(--bg4)" }}>
              <TH style={{ fontSize: 10, width: 90 }}>Day</TH>
              <TH style={{ fontSize: 10, width: 110 }}>Date</TH>
              <TH style={{ fontSize: 10 }}>Missing Branches</TH>
              <TH right style={{ fontSize: 10, width: 70 }}>Count</TH>
            </tr>
          </thead>
          <tbody>
            {missingRows.map(({ date, missing }) => {
              const dow = dayOfWeek(date);
              const isWeekend = dow === "SAT" || dow === "SUN";
              return (
                <tr key={date} style={{ background: isWeekend ? "rgba(251,146,60,0.07)" : "var(--bg3)" }}>
                  <TD style={{ fontWeight: 800, color: isWeekend ? "var(--orange)" : "var(--text2)", fontSize: 10 }}>{dow}</TD>
                  <TD style={{ color: isWeekend ? "var(--orange)" : "var(--text3)", fontSize: 10, fontFamily: "monospace" }}>{date}</TD>
                  <TD>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {missing.map(b => (
                        <span key={b.id} style={{ padding: "3px 10px", borderRadius: 999, background: "rgba(248,113,113,0.12)", color: "var(--red)", fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap", border: "1px solid rgba(248,113,113,0.25)" }}>
                          {b.name.replace("V-CUT ", "")}
                        </span>
                      ))}
                    </div>
                  </TD>
                  <TD right style={{ fontWeight: 800, color: "var(--red)" }}>{missing.length}</TD>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );

  const renderTable = (field, color) => {
    const colTotals = branches.map(b => days.reduce((s, d) => s + cell(b.id, d, field), 0));
    const grandTotal = colTotals.reduce((s, n) => s + n, 0);
    // Pre-compute per-day totals so we know the max (top-collection day)
    // without walking the rows twice per render.
    const rowTotals = days.map(d => branches.reduce((s, b) => s + cell(b.id, d, field), 0));
    const maxRowTotal = Math.max(0, ...rowTotals);
    return (
      <div style={{ borderTop: "1px solid var(--border)", overflowX: "auto", maxHeight: "60vh" }}>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 11, minWidth: "max-content" }}>
          <thead style={{ position: "sticky", top: 0, zIndex: 5 }}>
            <tr style={{ background: "var(--bg4)" }}>
              <TH style={{ position: "sticky", left: 0, background: "var(--bg4)", zIndex: 6, fontSize: 10, width: 90 }}>Day</TH>
              <TH style={{ position: "sticky", left: 90, background: "var(--bg4)", zIndex: 6, fontSize: 10, width: 100 }}>Date</TH>
              {branches.map(b => <TH key={b.id} right style={{ fontSize: 9, whiteSpace: "nowrap", background: "var(--bg4)" }}>{b.name.replace("V-CUT ", "")}</TH>)}
              <TH right style={{ fontSize: 10, background: "var(--bg4)", borderLeft: "1px solid var(--border2)" }}>Total</TH>
            </tr>
          </thead>
          <tbody>
            {days.map((date, idx) => {
              const rowTotal = rowTotals[idx];
              const hasAny = rowTotal > 0;
              const dow = dayOfWeek(date);
              const isWeekend = dow === "SAT" || dow === "SUN";
              const isTop = hasAny && rowTotal === maxRowTotal;
              // Top day wins over weekend when they collide (e.g. a Saturday
              // that is also the best-collection day reads as "celebrate").
              const rowTint = isTop
                ? "rgba(74,222,128,0.08)"   // green
                : isWeekend
                  ? "rgba(251,146,60,0.07)" // orange
                  : "var(--bg3)";
              const stickyTint = isTop
                ? "rgba(74,222,128,0.12)"
                : isWeekend
                  ? "rgba(251,146,60,0.10)"
                  : "var(--bg3)";
              return (
                <tr key={date} style={{ opacity: hasAny ? 1 : 0.45, background: rowTint }}>
                  <TD style={{ position: "sticky", left: 0, background: stickyTint, fontWeight: 800, color: isTop ? "var(--green)" : isWeekend ? "var(--orange)" : "var(--text2)", fontSize: 10 }}>{dow}</TD>
                  <TD style={{ position: "sticky", left: 90, background: stickyTint, color: isTop ? "var(--green)" : isWeekend ? "var(--orange)" : "var(--text3)", fontSize: 10, fontFamily: "monospace" }}>{date}</TD>
                  {branches.map(b => {
                    const v = cell(b.id, date, field);
                    return <TD key={b.id} right style={{ color: v > 0 ? color : "var(--text3)", fontWeight: v > 0 ? 600 : 400, fontSize: 11 }}>{v > 0 ? INR(v) : "—"}</TD>;
                  })}
                  <TD right style={{ fontWeight: 800, color: isTop ? "var(--green)" : hasAny ? color : "var(--text3)", borderLeft: "1px solid var(--border2)" }}>{hasAny ? INR(rowTotal) : "—"}</TD>
                </tr>
              );
            })}
            <tr style={{ background: "var(--bg4)", borderTop: "2px solid var(--border2)" }}>
              <TD style={{ position: "sticky", left: 0, background: "var(--bg4)", fontWeight: 800, color: "var(--gold)" }}>TOTAL</TD>
              <TD style={{ position: "sticky", left: 90, background: "var(--bg4)" }}></TD>
              {branches.map((b, i) => <TD key={b.id} right style={{ fontWeight: 800, color }}>{INR(colTotals[i])}</TD>)}
              <TD right style={{ fontWeight: 900, color, borderLeft: "1px solid var(--border2)", fontSize: 13 }}>{INR(grandTotal)}</TD>
            </tr>
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {cards.map(c => {
        const isMissing = c.key === "missing";
        const s = isMissing ? null : stats(c.key);
        const isOpen = expanded === c.key;
        return (
          <Card key={c.key} style={{ padding: 0, overflow: "hidden" }}>
            {/* Clickable header — always shows Avg + Total (or missing count) */}
            <div onClick={() => setExpanded(isOpen ? null : c.key)}
              role="button" tabIndex={0}
              onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setExpanded(isOpen ? null : c.key); } }}
              style={{
                padding: "16px 20px",
                background: isOpen
                  ? `linear-gradient(135deg, rgba(${c.rgb},0.18), rgba(${c.rgb},0.04))`
                  : `linear-gradient(135deg, rgba(${c.rgb},0.08), rgba(${c.rgb},0.02))`,
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
                cursor: "pointer", userSelect: "none",
                transition: "all .15s",
                boxShadow: isOpen ? `0 0 20px rgba(${c.rgb},0.25)` : "none",
              }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: isOpen ? "var(--accent)" : "var(--text3)" }}>{isOpen ? "▼" : "▶"}</div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: c.color, textTransform: "uppercase", letterSpacing: 1.5 }}>{c.label}</div>
                  <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>
                    {isMissing
                      ? (missingRows.length === 0 ? `Complete through ${yesterdayStr}` : `${missingRows.length} day${missingRows.length === 1 ? "" : "s"} with gaps`)
                      : `${s.activeDays} ${s.activeDays === 1 ? "day" : "days"} of business`}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 28, alignItems: "center" }}>
                {isMissing ? (
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>Missing Entries</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: missingCount === 0 ? "var(--green)" : c.color, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{missingCount === 0 ? "None" : missingCount}</div>
                  </div>
                ) : (<>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>Daily Avg</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: c.color, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(s.avg)}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>Total</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: c.color, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(s.total)}</div>
                  </div>
                </>)}
              </div>
            </div>
            {isOpen && (isMissing ? renderMissing() : renderTable(c.key, c.color))}
          </Card>
        );
      })}
    </div>
  );
}
