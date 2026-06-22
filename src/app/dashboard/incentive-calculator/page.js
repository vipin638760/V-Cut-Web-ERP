"use client";
import Link from "next/link";
import { useEffect, useState, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { collection, onSnapshot, query, where, orderBy, addDoc, writeBatch, doc, deleteDoc, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR } from "@/lib/calculations";
import { Icon, Card, TH, TD, BranchSelect, useConfirm, useToast } from "@/components/ui";
import VLoader from "@/components/VLoader";

export default function IncentiveCalculatorPage() {
  const [entries, setEntries] = useState([]);
  const [branches, setBranches] = useState([]);
  const [staff, setStaff] = useState([]);
  const [releases, setReleases] = useState([]);
  const [globalSettings, setGlobalSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Toggles the "incentive_pct audit" panel that flags staff who fall back
  // to the global mens/unisex rate.
  const [showRateAudit, setShowRateAudit] = useState(false);

  const currentUser = useCurrentUser() || {};
  const canEdit = ["admin", "accountant"].includes(currentUser.role);
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();

  const [mode, setMode] = useState("period");
  const [branchFilter, setBranchFilter] = useState("");
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setDate(1);
    return d.toISOString().slice(0, 10);
  });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10));

  // Deep-link from the Branch "Staff Incentives" breakdown row:
  // ?branch=ID&month=YYYY-MM preselects that branch and sets the date range to
  // the whole month, so the clicked figure is traceable per staff/day.
  const searchParams = useSearchParams();
  useEffect(() => {
    const qBranch = searchParams.get("branch");
    if (qBranch) setBranchFilter(qBranch);
    const qMonth = searchParams.get("month");
    if (qMonth && /^\d{4}-\d{2}$/.test(qMonth)) {
      const [y, m] = qMonth.split("-").map(Number);
      setDateFrom(`${qMonth}-01`);
      setDateTo(`${qMonth}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`);
    }
  }, [searchParams]);

  // Selection for batch release
  const [selected, setSelected] = useState(new Set());
  const [releasing, setReleasing] = useState(false);

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "staff"), sn => { setStaff(sn.docs.map(d => ({ ...d.data(), id: d.id }))); setLoading(false); }),
      onSnapshot(doc(db, "settings", "global"), sn => setGlobalSettings(sn.data() || {})),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  useEffect(() => {
    if (!db || !dateFrom || !dateTo) return;
    try {
      const q = query(
        collection(db, "entries"),
        where("date", ">=", dateFrom),
        where("date", "<=", dateTo),
        orderBy("date", "desc"),
      );
      const unsub = onSnapshot(q,
        sn => setEntries(sn.docs.map(d => ({ ...d.data(), id: d.id }))),
        err => { console.warn("Entries query error:", err); setError(err.message); }
      );
      return () => unsub();
    } catch (err) {
      console.warn("Entries query setup error:", err);
      setError(err.message);
    }
  }, [dateFrom, dateTo]);

  // Fetch incentive releases for the date range
  useEffect(() => {
    if (!db || !dateFrom || !dateTo) return;
    const q = query(
      collection(db, "incentive_releases"),
      where("period_from", ">=", dateFrom),
      where("period_from", "<=", dateTo),
    );
    const unsub = onSnapshot(q,
      sn => setReleases(sn.docs.map(d => ({ ...d.data(), id: d.id }))),
      () => setReleases([])
    );
    return () => unsub();
  }, [dateFrom, dateTo]);

  const branchesById = useMemo(() => new Map(branches.map(b => [b.id, b])), [branches]);
  const staffById = useMemo(() => new Map(staff.map(s => [s.id, s])), [staff]);

  // Audit which staff don't have an explicit incentive_pct on their profile,
  // grouping into "explicit 0%" (probably a mistake) vs "missing → falls back
  // to global rate". Inactive staff are excluded so the list stays actionable.
  // Branch resolution uses the staff master branch_id; a staff with no branch
  // shows up under "no branch resolved" so the user knows the global fallback
  // can't even be applied.
  const incRateAudit = useMemo(() => {
    const mensRate = Number(globalSettings?.mens_inc ?? 10) || 10;
    const unisexRate = Number(globalSettings?.unisex_inc ?? 10) || 10;
    const explicitZero = [];
    const fallback = [];
    staff.forEach(s => {
      if (s.status === "inactive") return;
      const br = branchesById.get(s.branch_id);
      const branchName = br?.name?.replace("V-CUT ", "") || "—";
      const branchType = br?.type || null;
      const fallbackRate = branchType === "unisex" ? unisexRate : (branchType === "mens" ? mensRate : null);
      const row = {
        id: s.id,
        name: s.name || s.id,
        role: s.role || "",
        branch: branchName,
        branchType,
        fallbackRate,
      };
      const v = s.incentive_pct;
      if (v === undefined || v === null || v === "") {
        fallback.push(row);
      } else if (Number(v) === 0) {
        explicitZero.push(row);
      }
    });
    return {
      mensRate, unisexRate,
      explicitZero: explicitZero.sort((a, b) => a.name.localeCompare(b.name)),
      fallback: fallback.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }, [staff, branchesById, globalSettings]);

  const filtered = useMemo(() => {
    if (!branchFilter) return entries;
    return entries.filter(e => e.branch_id === branchFilter);
  }, [entries, branchFilter]);

  // Per-day display uses RAW (5% of billing, 5% of material) so the period
  // total reflects the actual incentive earned. The legacy `sb.incentive` /
  // `sb.mat_incentive` values are stored ceil-10 per-day at entry-save time,
  // which inflates the period sum (15 days × up-to-₹9 each can drift ~₹100).
  // **Why:** User wants to see the real 5% daily and only ceil-to-10 at
  // payout, so the released amount equals ceilTo10(sum of raw) rather than
  // sum(ceilTo10(per-day)).
  // **How to apply:** Read from `entries[*].rawTotalInc` for any pending sum,
  // and call `ceilTo10()` on the resulting sum at release time.
  const MAT_PCT = 0.05;
  const incentiveData = useMemo(() => {
    const map = {};
    filtered.forEach(entry => {
      (entry.staff_billing || []).forEach(sb => {
        if (!sb.staff_id) return;
        const s = staffById.get(sb.staff_id);
        const incPct = (Number(s?.incentive_pct) || 0) / 100;
        const billing = Number(sb.billing) || 0;
        const matSale = Number(sb.material) || 0;
        const rawIncentive = billing * incPct;
        const rawMatIncentive = matSale * MAT_PCT;
        const rawTotalInc = rawIncentive + rawMatIncentive;
        // Skip rows that earn nothing (covers the original totalInc <= 0 guard).
        if (rawTotalInc <= 0) return;
        if (!map[sb.staff_id]) {
          map[sb.staff_id] = {
            name: s?.name || sb.staff_id,
            role: s?.role || "",
            branch_id: sb.home_branch_id || s?.branch_id || "",
            incentive_pct: s?.incentive_pct ?? 10,
            totalIncentive: 0, takenIncentive: 0, pendingIncentive: 0,
            totalSale: 0, totalMatSale: 0,
            days: 0, entries: [],
          };
        }
        const d = map[sb.staff_id];
        d.totalIncentive += rawTotalInc;
        d.totalSale += billing;
        d.totalMatSale += matSale;
        const taken = sb.incentive_taken !== false;
        if (taken) d.takenIncentive += rawTotalInc;
        else d.pendingIncentive += rawTotalInc;
        d.days++;
        d.entries.push({
          date: entry.date,
          entry_id: entry.id,
          branch_id: entry.branch_id,
          branch: branchesById.get(entry.branch_id)?.name || "",
          billing, matSale,
          incentive: rawIncentive,
          mat_incentive: rawMatIncentive,
          totalInc: rawTotalInc,
          taken,
          staff_id: sb.staff_id,
        });
      });
    });
    return Object.entries(map).map(([id, d]) => ({ id, ...d }));
  }, [filtered, staffById, branchesById]);

  // Round payout amount up to the next ₹10 (₹1,703 → ₹1,710, ₹220 → ₹220).
  const ceilTo10 = (n) => Math.ceil((Number(n) || 0) / 10) * 10;

  // Check if a staff already has a release for this period
  const releasesByStaff = useMemo(() => {
    const map = {};
    releases.forEach(r => {
      if (!map[r.staff_id]) map[r.staff_id] = [];
      map[r.staff_id].push(r);
    });
    return map;
  }, [releases]);

  const periodCollectors = incentiveData.filter(d => d.pendingIncentive > 0);
  const dailyCollectors = incentiveData.filter(d => d.pendingIncentive === 0 && d.takenIncentive > 0);
  const baseDisplayed = mode === "daily" ? dailyCollectors : periodCollectors;
  const empQ = employeeSearch.trim().toLowerCase();
  const displayed = empQ
    ? baseDisplayed.filter(d => (d.name || "").toLowerCase().includes(empQ) || (d.role || "").toLowerCase().includes(empQ))
    : baseDisplayed;
  const totalPending = displayed.reduce((s, d) => s + d.pendingIncentive, 0);
  const totalTaken = displayed.reduce((s, d) => s + d.takenIncentive, 0);
  const totalAll = displayed.reduce((s, d) => s + d.totalIncentive, 0);
  const totalSale = displayed.reduce((s, d) => s + d.totalSale, 0);

  const [expandedStaff, setExpandedStaff] = useState(null);

  // Row-level selection in breakdown (set of "staffId_date_entryId" keys)
  const [selectedRows, setSelectedRows] = useState(new Set());

  // Selection helpers
  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const selectAll = () => {
    if (selected.size === displayed.length) setSelected(new Set());
    else setSelected(new Set(displayed.map(d => d.id)));
  };
  const selectedTotal = displayed.filter(d => selected.has(d.id)).reduce((s, d) => s + d.pendingIncentive, 0);

  // Release selected incentives
  const handleRelease = () => {
    const selStaff = displayed.filter(d => selected.has(d.id));
    if (selStaff.length === 0) return;
    // Each staff's payout is the ceil-10 of their raw pending sum, so the
    // released total adds those rounded figures (matches what's actually paid).
    const payoutByStaff = (d) => ceilTo10(d.pendingIncentive);
    const totalPayout = selStaff.reduce((s, d) => s + payoutByStaff(d), 0);
    confirm({
      title: "Release Incentives",
      message: `
        <div style="text-align:center;">
          <div style="font-size:24px;font-weight:800;color:var(--green);margin-bottom:4px;">${INR(totalPayout)}</div>
          <div style="font-size:11px;color:var(--text3);margin-bottom:8px;">Actual: ${INR(selectedTotal)} · rounded up to nearest ₹10</div>
          <div style="font-size:12px;color:var(--text3);">Release pending incentives for <strong>${selStaff.length}</strong> staff member${selStaff.length > 1 ? "s" : ""}?</div>
          <div style="margin-top:10px;font-size:11px;color:var(--text3);max-height:120px;overflow-y:auto;text-align:left;padding:8px 12px;border-radius:8px;background:var(--bg3);">
            ${selStaff.map(d => `<div style="padding:2px 0;">${d.name} — <strong>${INR(payoutByStaff(d))}</strong> <span style="opacity:0.6;">(actual ${INR(d.pendingIncentive)})</span></div>`).join("")}
          </div>
        </div>
      `,
      confirmText: "Release",
      type: "success",
      onConfirm: async () => {
        setReleasing(true);
        try {
          const batch = writeBatch(db);
          const now = new Date().toISOString();

          for (const d of selStaff) {
            const payout = payoutByStaff(d);
            // Create release record
            const releaseRef = doc(collection(db, "incentive_releases"));
            batch.set(releaseRef, {
              staff_id: d.id,
              staff_name: d.name,
              branch_id: d.branch_id,
              branch_name: branchesById.get(d.branch_id)?.name || "",
              period_from: dateFrom,
              period_to: dateTo,
              total_sale: d.totalSale,
              total_incentive: d.totalIncentive,
              amount_released: payout,
              days: d.days,
              released_at: now,
              released_by: currentUser?.name || "user",
              entries_count: d.entries.filter(e => !e.taken).length,
            });

            // Mark pending entries as taken
            const pendingEntries = d.entries.filter(e => !e.taken);
            const entryGroups = {};
            pendingEntries.forEach(e => {
              if (!entryGroups[e.entry_id]) entryGroups[e.entry_id] = [];
              entryGroups[e.entry_id].push(e);
            });

            for (const [entryId] of Object.entries(entryGroups)) {
              const entry = entries.find(e => e.id === entryId);
              if (!entry?.staff_billing) continue;
              const updatedBilling = entry.staff_billing.map(sb => {
                if (sb.staff_id === d.id && sb.incentive_taken === false) {
                  return { ...sb, incentive_taken: true };
                }
                return sb;
              });
              batch.update(doc(db, "entries", entryId), { staff_billing: updatedBilling });
            }
          }

          await batch.commit();
          toast({ title: "Released", message: `Incentives released for ${selStaff.length} staff — ${INR(totalPayout)}`, type: "success" });
          setSelected(new Set());
        } catch (err) {
          toast({ title: "Error", message: err.message, type: "error" });
        } finally {
          setReleasing(false);
        }
      },
    });
  };

  // Release selected individual day rows for a single staff
  const handleReleaseRows = (staffData) => {
    const pendingEntries = staffData.entries.filter(e => !e.taken);
    const selEntries = pendingEntries.filter(e => selectedRows.has(`${staffData.id}_${e.date}_${e.entry_id}`));
    if (selEntries.length === 0) return;
    const rowTotal = selEntries.reduce((s, e) => s + e.totalInc, 0);
    const rowSale = selEntries.reduce((s, e) => s + e.billing, 0);
    const rowPayout = ceilTo10(rowTotal);
    confirm({
      title: "Release Selected Days",
      message: `
        <div style="text-align:center;">
          <div style="font-size:20px;font-weight:800;color:var(--green);margin-bottom:4px;">${INR(rowPayout)}</div>
          <div style="font-size:11px;color:var(--text3);margin-bottom:6px;">Actual: ${INR(rowTotal)} · rounded up to nearest ₹10</div>
          <div style="font-size:12px;color:var(--text3);">Release incentives for <strong>${selEntries.length}</strong> day${selEntries.length > 1 ? "s" : ""} for <strong>${staffData.name}</strong>?</div>
          <div style="font-size:11px;color:var(--text3);margin-top:4px;">Total sale: ${INR(rowSale)}</div>
        </div>
      `,
      confirmText: "Release",
      type: "success",
      onConfirm: async () => {
        setReleasing(true);
        try {
          const batch = writeBatch(db);
          const now = new Date().toISOString();

          // Create release record
          const releaseRef = doc(collection(db, "incentive_releases"));
          batch.set(releaseRef, {
            staff_id: staffData.id,
            staff_name: staffData.name,
            branch_id: staffData.branch_id,
            branch_name: branchesById.get(staffData.branch_id)?.name || "",
            period_from: dateFrom,
            period_to: dateTo,
            total_sale: rowSale,
            total_incentive: rowTotal,
            amount_released: rowPayout,
            days: selEntries.length,
            released_at: now,
            released_by: currentUser?.name || "user",
            entries_count: selEntries.length,
            type: "partial",
          });

          // Mark selected entries as taken
          const entryGroups = {};
          selEntries.forEach(e => {
            if (!entryGroups[e.entry_id]) entryGroups[e.entry_id] = [];
            entryGroups[e.entry_id].push(e);
          });
          for (const [entryId, rows] of Object.entries(entryGroups)) {
            const entry = entries.find(e => e.id === entryId);
            if (!entry?.staff_billing) continue;
            const selectedDates = new Set(rows.map(r => r.date));
            const updatedBilling = entry.staff_billing.map(sb => {
              if (sb.staff_id === staffData.id && sb.incentive_taken === false) {
                return { ...sb, incentive_taken: true };
              }
              return sb;
            });
            batch.update(doc(db, "entries", entryId), { staff_billing: updatedBilling });
          }

          await batch.commit();
          toast({ title: "Released", message: `${selEntries.length} day${selEntries.length > 1 ? "s" : ""} released for ${staffData.name} — ${INR(rowPayout)}`, type: "success" });
          setSelectedRows(new Set());
        } catch (err) {
          toast({ title: "Error", message: err.message, type: "error" });
        } finally {
          setReleasing(false);
        }
      },
    });
  };

  // Reverse a release: delete the release doc, set incentive_taken back to false
  const handleReverse = (release) => {
    confirm({
      title: "Reverse Release",
      message: `
        <div style="text-align:center;">
          <div style="font-size:20px;font-weight:800;color:var(--red);margin-bottom:6px;">${INR(release.amount_released)}</div>
          <div style="font-size:12px;color:var(--text3);">Reverse incentive release for <strong>${release.staff_name}</strong>?</div>
          <div style="font-size:11px;color:var(--text3);margin-top:4px;">Period: ${release.period_from} to ${release.period_to}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:2px;">This will mark ${release.entries_count || "all"} entries back to PENDING.</div>
        </div>
      `,
      confirmText: "Reverse",
      type: "danger",
      onConfirm: async () => {
        setReleasing(true);
        try {
          // Find entries in the release period for this staff and set incentive_taken = false
          const q = query(
            collection(db, "entries"),
            where("date", ">=", release.period_from),
            where("date", "<=", release.period_to),
            orderBy("date", "desc"),
          );
          const sn = await getDocs(q);
          const batch = writeBatch(db);
          let reversed = 0;

          sn.docs.forEach(d => {
            const entry = { ...d.data(), id: d.id };
            if (!entry.staff_billing) return;
            let changed = false;
            const updatedBilling = entry.staff_billing.map(sb => {
              if (sb.staff_id === release.staff_id && sb.incentive_taken === true) {
                changed = true;
                return { ...sb, incentive_taken: false };
              }
              return sb;
            });
            if (changed) {
              batch.update(doc(db, "entries", entry.id), { staff_billing: updatedBilling });
              reversed++;
            }
          });

          // Delete the release record
          batch.delete(doc(db, "incentive_releases", release.id));

          await batch.commit();
          toast({ title: "Reversed", message: `Release reversed for ${release.staff_name} — ${reversed} entries set back to pending.`, type: "success" });
        } catch (err) {
          toast({ title: "Error", message: err.message, type: "error" });
        } finally {
          setReleasing(false);
        }
      },
    });
  };

  if (loading) return <VLoader fullscreen label="Loading Incentive Data" />;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 2 }}>Incentive</div>
        <div style={{ fontSize: 24, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>Incentive Calculator</div>
      </div>

      {error && (
        <div style={{ padding: 14, borderRadius: 10, background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)", color: "var(--red)", fontSize: 12, marginBottom: 16 }}>
          Query error: {error}. Entries may not load until a Firestore index is created.
        </div>
      )}

      {/* Incentive rate audit — admin/accountant only. Surfaces staff whose
          incentive_pct is unset (uses global fallback) or set to 0 (no
          incentive). Click the chip to expand the per-staff list. */}
      {canEdit && (incRateAudit.fallback.length > 0 || incRateAudit.explicitZero.length > 0) && (
        <div style={{ marginBottom: 16, borderRadius: 10, border: "1px solid rgba(251,146,60,0.3)", background: "linear-gradient(135deg, rgba(251,146,60,0.08), rgba(251,146,60,0.02))", overflow: "hidden" }}>
          <button onClick={() => setShowRateAudit(v => !v)}
            style={{ width: "100%", padding: "12px 16px", background: "transparent", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, color: "var(--text)", fontFamily: "inherit" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: "var(--orange)", textTransform: "uppercase", letterSpacing: 1.5 }}>Incentive Rate Audit</span>
              <span style={{ fontSize: 11, color: "var(--text3)" }}>
                {incRateAudit.fallback.length} fallback · {incRateAudit.explicitZero.length} zero ·
                global mens {incRateAudit.mensRate}% / unisex {incRateAudit.unisexRate}%
              </span>
            </div>
            <span style={{ fontSize: 11, color: "var(--text3)" }}>{showRateAudit ? "▲ Hide" : "▼ Show"}</span>
          </button>
          {showRateAudit && (
            <div style={{ padding: "0 16px 16px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 800, color: "var(--orange)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>
                  Falls back to global rate ({incRateAudit.fallback.length})
                </div>
                {incRateAudit.fallback.length === 0 ? (
                  <div style={{ fontSize: 11, color: "var(--text3)", fontStyle: "italic" }}>None — every active staff has an explicit incentive_pct.</div>
                ) : (
                  <div style={{ borderRadius: 8, border: "1px solid var(--border)", maxHeight: 240, overflowY: "auto", background: "var(--bg3)" }}>
                    {incRateAudit.fallback.map(r => (
                      <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid var(--border)", fontSize: 11 }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                          <span style={{ fontWeight: 700, color: "var(--text)" }}>{r.name}</span>
                          <span style={{ color: "var(--text3)", fontSize: 10 }}>{r.branch}{r.role ? ` · ${r.role}` : ""}</span>
                        </div>
                        <span style={{ fontWeight: 700, color: r.fallbackRate != null ? "var(--orange)" : "var(--red)", whiteSpace: "nowrap", fontSize: 11 }}>
                          {r.fallbackRate != null ? `${r.fallbackRate}%` : "no branch"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 800, color: "var(--red)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>
                  Explicitly set to 0% ({incRateAudit.explicitZero.length})
                </div>
                {incRateAudit.explicitZero.length === 0 ? (
                  <div style={{ fontSize: 11, color: "var(--text3)", fontStyle: "italic" }}>None — no active staff has incentive_pct = 0.</div>
                ) : (
                  <div style={{ borderRadius: 8, border: "1px solid var(--border)", maxHeight: 240, overflowY: "auto", background: "var(--bg3)" }}>
                    {incRateAudit.explicitZero.map(r => (
                      <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid var(--border)", fontSize: 11 }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                          <span style={{ fontWeight: 700, color: "var(--text)" }}>{r.name}</span>
                          <span style={{ color: "var(--text3)", fontSize: 10 }}>{r.branch}{r.role ? ` · ${r.role}` : ""}</span>
                        </div>
                        <span style={{ fontWeight: 700, color: "var(--red)", fontSize: 11 }}>0%</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ gridColumn: "1 / -1", fontSize: 11, color: "var(--text3)", lineHeight: 1.5 }}>
                <strong style={{ color: "var(--text2)" }}>What to do:</strong> open <Link href="/dashboard/staff" style={{ color: "var(--accent)", fontWeight: 700 }}>Staff Master</Link> and set <em>Incentive %</em> on the rows above. Until you do, the calculator and expense rollups apply the branch-type fallback shown next to each name.
              </div>
            </div>
          )}
        </div>
      )}

      <Card style={{ marginBottom: 20, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 3, background: "var(--bg4)", padding: 3, borderRadius: 10 }}>
            {[["period", "Period Collectors"], ["daily", "Daily Collectors"]].map(([val, label]) => (
              <button key={val} onClick={() => { setMode(val); setSelected(new Set()); }}
                style={{ padding: "8px 16px", borderRadius: 7, fontSize: 11, fontWeight: 700, border: "none", cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5, background: mode === val ? "linear-gradient(135deg, var(--accent), var(--gold2))" : "transparent", color: mode === val ? "#000" : "var(--text3)" }}>
                {label}
              </button>
            ))}
          </div>
          <BranchSelect value={branchFilter} onChange={setBranchFilter} branches={branches} placeholder="All Branches" />
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>From:</span>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border2)", background: "var(--bg3)", color: "var(--text)", fontSize: 12 }} />
            <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600 }}>To:</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border2)", background: "var(--bg3)", color: "var(--text)", fontSize: 12 }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 220 }}>
            <input type="text" value={employeeSearch} onChange={e => { setEmployeeSearch(e.target.value); setSelected(new Set()); }}
              placeholder="Search employee by name or role…"
              style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border2)", background: "var(--bg3)", color: "var(--text)", fontSize: 12, outline: "none" }} />
            {employeeSearch && (
              <button onClick={() => setEmployeeSearch("")}
                title="Clear search"
                style={{ padding: "6px 10px", borderRadius: 6, background: "var(--bg4)", color: "var(--text3)", border: "1px solid var(--border2)", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>×</button>
            )}
          </div>
        </div>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 20 }}>
        {[
          ["Staff", displayed.length, "var(--accent)"],
          ["Total Sale", INR(totalSale), "var(--blue, #60a5fa)"],
          ["Total Incentive", INR(totalAll), "var(--gold)"],
          [mode === "daily" ? "Taken (Daily)" : "Pending Payout", mode === "daily" ? INR(totalTaken) : INR(totalPending), mode === "daily" ? "var(--green)" : "var(--orange)"],
          ["Entries in Range", filtered.length, "var(--text2)"],
        ].map(([l, v, c]) => (
          <Card key={l} style={{ padding: 14 }}>
            <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: c, marginTop: 4 }}>{v}</div>
          </Card>
        ))}
      </div>

      {/* Selection action bar */}
      {canEdit && mode === "period" && selected.size > 0 && (
        <div style={{ padding: "12px 18px", marginBottom: 12, borderRadius: 12, background: "linear-gradient(135deg, rgba(74,222,128,0.08), rgba(34,211,238,0.06))", border: "1px solid rgba(74,222,128,0.2)", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{selected.size} staff selected</span>
            <span style={{ fontSize: 11, color: "var(--text3)" }}>|</span>
            <span style={{ fontSize: 13, fontWeight: 800, color: "var(--green)" }} title="Payout — rounded up to nearest ₹10 per staff">
              {INR(displayed.filter(d => selected.has(d.id)).reduce((s, d) => s + ceilTo10(d.pendingIncentive), 0))}
            </span>
            <span style={{ fontSize: 11, color: "var(--text3)" }}>(actual {INR(selectedTotal)})</span>
          </div>
          <button onClick={handleRelease} disabled={releasing}
            style={{ padding: "10px 22px", borderRadius: 10, background: "linear-gradient(135deg, #22c55e, #16a34a)", color: "#fff", border: "none", fontWeight: 800, fontSize: 12, cursor: releasing ? "wait" : "pointer", opacity: releasing ? 0.6 : 1, display: "inline-flex", alignItems: "center", gap: 6 }}>
            {releasing ? "Releasing…" : <><Icon name="check" size={13} /> Release Incentives</>}
          </button>
        </div>
      )}

      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", minWidth: 900, borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--bg4)" }}>
              {canEdit && mode === "period" && (
                <TH style={{ width: 36, textAlign: "center" }}>
                  <input type="checkbox" checked={displayed.length > 0 && selected.size === displayed.length} onChange={selectAll}
                    style={{ cursor: "pointer", accentColor: "var(--accent)" }} />
                </TH>
              )}
              <TH>Staff</TH><TH>Role</TH><TH>Branch</TH><TH>Rate</TH>
              <TH right>Days</TH><TH right>Total Sale</TH><TH right>Total Incentive</TH><TH right>Taken</TH><TH right>Pending</TH><TH style={{ width: 30 }}></TH>
            </tr>
          </thead>
          <tbody>
            {displayed.length === 0 && (
              <tr><td colSpan={canEdit && mode === "period" ? 11 : 10} style={{ textAlign: "center", padding: 30, color: "var(--text3)", fontSize: 13 }}>No {mode === "daily" ? "daily" : "period"} collectors found in the selected range.</td></tr>
            )}
            {displayed.flatMap(d => {
              const expanded = expandedStaff === d.id;
              const bName = (branchesById.get(d.branch_id)?.name || "—").replace("V-CUT ", "");
              const staffReleases = releasesByStaff[d.id] || [];
              const rows = [
                <tr key={`row-${d.id}`} style={{ cursor: "pointer", borderBottom: "1px solid var(--border)" }}
                  onClick={() => { setExpandedStaff(expanded ? null : d.id); setSelectedRows(new Set()); }}>
                  {canEdit && mode === "period" && (
                    <TD style={{ textAlign: "center" }} onClick={e => { e.stopPropagation(); toggleSelect(d.id); }}>
                      <input type="checkbox" checked={selected.has(d.id)} readOnly
                        style={{ cursor: "pointer", accentColor: "var(--accent)" }} />
                    </TD>
                  )}
                  <TD style={{ fontWeight: 700 }}>{d.name}</TD>
                  <TD style={{ color: "var(--text3)" }}>{d.role || "—"}</TD>
                  <TD>{bName}</TD>
                  <TD>{d.incentive_pct}%</TD>
                  <TD right>{d.days}</TD>
                  <TD right style={{ color: "var(--blue, #60a5fa)" }}>{INR(d.totalSale)}</TD>
                  <TD right style={{ fontWeight: 700, color: "var(--gold)" }}>{INR(d.totalIncentive)}</TD>
                  <TD right style={{ color: "var(--green)" }}>{INR(d.takenIncentive)}</TD>
                  <TD right style={{ fontWeight: 800, color: d.pendingIncentive > 0 ? "var(--orange)" : "var(--text3)" }}>{d.pendingIncentive > 0 ? INR(d.pendingIncentive) : "—"}</TD>
                  <TD style={{ fontSize: 10, color: "var(--accent)" }}>{expanded ? "▲" : "▼"}</TD>
                </tr>
              ];
              if (expanded && staffReleases.length > 0) {
                staffReleases.forEach((r, ri) => {
                  rows.push(
                    <tr key={`rel-${d.id}-${ri}`} style={{ background: r.reversed ? "rgba(248,113,113,0.04)" : "rgba(74,222,128,0.04)" }}>
                      <td colSpan={canEdit && mode === "period" ? 12 : 11} style={{ padding: "6px 16px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, color: r.reversed ? "var(--red)" : "var(--green)" }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={r.reversed ? "#f87171" : "#4ade80"} strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                          <span style={{ fontWeight: 700 }}>{r.reversed ? "Reversed" : "Released"} {INR(r.amount_released)}</span>
                          <span style={{ color: "var(--text3)" }}>on {r.released_at?.slice(0, 10)}</span>
                          <span style={{ color: "var(--text3)" }}>by {r.released_by}</span>
                          <span style={{ color: "var(--text3)" }}>({r.period_from} to {r.period_to})</span>
                          {canEdit && !r.reversed && (
                            <button onClick={(e) => { e.stopPropagation(); handleReverse(r); }} disabled={releasing}
                              style={{ padding: "3px 10px", borderRadius: 5, background: "rgba(248,113,113,0.12)", border: "1px solid rgba(248,113,113,0.25)", color: "var(--red)", fontSize: 9, fontWeight: 700, cursor: releasing ? "wait" : "pointer", textTransform: "uppercase", letterSpacing: 0.5, marginLeft: 4 }}>
                              Reverse
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                });
              }
              return rows;
            })}
            {displayed.length > 0 && (
              <tr style={{ background: "var(--bg3)", fontWeight: 700, borderTop: "2px solid var(--border2)" }}>
                {canEdit && mode === "period" && <TD></TD>}
                <TD>TOTALS</TD><TD></TD><TD></TD><TD></TD>
                <TD right>{displayed.reduce((s, d) => s + d.days, 0)}</TD>
                <TD right style={{ color: "var(--blue, #60a5fa)" }}>{INR(totalSale)}</TD>
                <TD right style={{ color: "var(--gold)" }}>{INR(totalAll)}</TD>
                <TD right style={{ color: "var(--green)" }}>{INR(totalTaken)}</TD>
                <TD right style={{ color: "var(--orange)", fontWeight: 800 }}>{totalPending > 0 ? INR(totalPending) : "—"}</TD>
                <TD></TD>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {expandedStaff && (() => {
        const d = displayed.find(x => x.id === expandedStaff);
        if (!d) return null;
        const sorted = [...d.entries].sort((a, b) => b.date.localeCompare(a.date));
        const breakdownTotalSale = sorted.reduce((s, e) => s + e.billing, 0);
        const breakdownTotalMatSale = sorted.reduce((s, e) => s + e.matSale, 0);
        const breakdownTotalInc = sorted.reduce((s, e) => s + e.totalInc, 0);
        const breakdownPendingInc = sorted.reduce((s, e) => s + (e.taken ? 0 : e.totalInc), 0);
        const breakdownTakenInc = breakdownTotalInc - breakdownPendingInc;

        // Past releases for this staff
        const staffReleases = releasesByStaff[d.id] || [];

        return (
          <Card style={{ marginTop: 12, padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text)" }}>{d.name} — Day-by-day breakdown</div>
              <div style={{ display: "flex", gap: 12, fontSize: 12, flexWrap: "wrap" }}>
                <span>Sale: <strong style={{ color: "var(--blue, #60a5fa)" }}>{INR(breakdownTotalSale)}</strong></span>
                <span>Mat: <strong style={{ color: "var(--accent)" }}>{INR(breakdownTotalMatSale)}</strong></span>
                <span>Incentive: <strong style={{ color: "var(--gold)" }}>{INR(breakdownTotalInc)}</strong></span>
                <span>Taken: <strong style={{ color: "var(--green)" }}>{INR(breakdownTakenInc)}</strong></span>
                <span>Pending: <strong style={{ color: breakdownPendingInc > 0 ? "var(--orange)" : "var(--text3)" }}>{INR(breakdownPendingInc)}</strong></span>
              </div>
            </div>

            {/* Release history */}
            {staffReleases.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                {staffReleases.map((r, i) => (
                  <div key={i} style={{ padding: "10px 14px", marginBottom: 6, borderRadius: 10, background: r.reversed ? "rgba(248,113,113,0.06)" : "rgba(74,222,128,0.06)", border: `1px solid ${r.reversed ? "rgba(248,113,113,0.15)" : "rgba(74,222,128,0.15)"}`, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={r.reversed ? "#f87171" : "#4ade80"} strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                    <span style={{ fontSize: 12, fontWeight: 800, color: r.reversed ? "var(--red)" : "var(--green)" }}>
                      {r.reversed ? "Reversed" : "Payment Released"}: {INR(r.amount_released)}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text3)" }}>|</span>
                    <span style={{ fontSize: 11, color: "var(--text3)" }}>Period: {r.period_from} to {r.period_to}</span>
                    <span style={{ fontSize: 11, color: "var(--text3)" }}>|</span>
                    <span style={{ fontSize: 11, color: "var(--text3)" }}>Sale: {INR(r.total_sale || 0)}</span>
                    <span style={{ fontSize: 11, color: "var(--text3)" }}>|</span>
                    <span style={{ fontSize: 11, color: "var(--text3)" }}>Released on {r.released_at?.slice(0, 10)} by <strong style={{ color: "var(--text2)" }}>{r.released_by}</strong></span>
                    {canEdit && !r.reversed && (
                      <>
                        <span style={{ fontSize: 11, color: "var(--text3)" }}>|</span>
                        <button onClick={() => handleReverse(r)} disabled={releasing}
                          style={{ padding: "4px 12px", borderRadius: 6, background: "rgba(248,113,113,0.12)", border: "1px solid rgba(248,113,113,0.25)", color: "var(--red)", fontSize: 10, fontWeight: 700, cursor: releasing ? "wait" : "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
                          Reverse
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Row-level selection bar */}
            {(() => {
              const pendingRows = sorted.filter(e => !e.taken);
              const selPending = pendingRows.filter(e => selectedRows.has(`${d.id}_${e.date}_${e.entry_id}`));
              const selRowTotal = selPending.reduce((s, e) => s + e.totalInc, 0);
              const selRowSale = selPending.reduce((s, e) => s + e.billing, 0);
              const hasPending = pendingRows.length > 0;
              return hasPending && canEdit && selPending.length > 0 ? (
                <div style={{ padding: "10px 14px", marginBottom: 10, borderRadius: 10, background: "linear-gradient(135deg, rgba(74,222,128,0.08), rgba(34,211,238,0.06))", border: "1px solid rgba(74,222,128,0.2)", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
                    <span style={{ fontWeight: 700, color: "var(--text)" }}>{selPending.length} day{selPending.length > 1 ? "s" : ""} selected</span>
                    <span style={{ color: "var(--text3)" }}>|</span>
                    <span>Sale: <strong style={{ color: "var(--blue, #60a5fa)" }}>{INR(selRowSale)}</strong></span>
                    <span style={{ color: "var(--text3)" }}>|</span>
                    <span>Incentive: <strong style={{ color: "var(--green)" }}>{INR(ceilTo10(selRowTotal))}</strong> <span style={{ opacity: 0.6 }}>(actual {INR(selRowTotal)})</span></span>
                  </div>
                  <button onClick={() => handleReleaseRows(d)} disabled={releasing}
                    style={{ padding: "8px 18px", borderRadius: 8, background: "linear-gradient(135deg, #22c55e, #16a34a)", color: "#fff", border: "none", fontWeight: 800, fontSize: 11, cursor: releasing ? "wait" : "pointer", opacity: releasing ? 0.6 : 1, display: "inline-flex", alignItems: "center", gap: 5 }}>
                    {releasing ? "Releasing…" : <><Icon name="check" size={12} /> Release Selected</>}
                  </button>
                </div>
              ) : null;
            })()}

            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
              <thead>
                <tr style={{ background: "var(--bg4)" }}>
                  {canEdit && sorted.some(e => !e.taken) && (
                    <TH style={{ width: 36, textAlign: "center" }}>
                      <input type="checkbox"
                        checked={sorted.filter(e => !e.taken).length > 0 && sorted.filter(e => !e.taken).every(e => selectedRows.has(`${d.id}_${e.date}_${e.entry_id}`))}
                        onChange={() => {
                          const pendingKeys = sorted.filter(e => !e.taken).map(e => `${d.id}_${e.date}_${e.entry_id}`);
                          setSelectedRows(prev => {
                            const next = new Set(prev);
                            const allSelected = pendingKeys.every(k => next.has(k));
                            pendingKeys.forEach(k => allSelected ? next.delete(k) : next.add(k));
                            return next;
                          });
                        }}
                        style={{ cursor: "pointer", accentColor: "var(--accent)" }} />
                    </TH>
                  )}
                  <TH>Date</TH><TH>Branch</TH><TH right>Billing</TH><TH right>Mat Sale</TH><TH right>Incentive</TH><TH right>Mat Inc</TH><TH right>Total Inc</TH><TH>Status</TH>
                </tr>
              </thead>
              <tbody>
                {sorted.map((e, i) => {
                  const rowKey = `${d.id}_${e.date}_${e.entry_id}`;
                  const hasPendingCol = sorted.some(r => !r.taken);
                  return (
                    <tr key={i} style={{ borderBottom: "1px solid var(--border)" }}>
                      {canEdit && hasPendingCol && (
                        <TD style={{ textAlign: "center" }}>
                          {!e.taken ? (
                            <input type="checkbox" checked={selectedRows.has(rowKey)}
                              onChange={() => {
                                setSelectedRows(prev => {
                                  const next = new Set(prev);
                                  next.has(rowKey) ? next.delete(rowKey) : next.add(rowKey);
                                  return next;
                                });
                              }}
                              style={{ cursor: "pointer", accentColor: "var(--accent)" }} />
                          ) : null}
                        </TD>
                      )}
                      <TD>
                        {(() => {
                          const [yy, mm] = (e.date || "").split("-");
                          const ymQS = yy && mm ? `&year=${yy}&month=${Number(mm)}` : "";
                          const href = e.entry_id
                            ? `/dashboard/entry?edit=${encodeURIComponent(e.entry_id)}${ymQS}`
                            : `/dashboard/entry?date=${encodeURIComponent(e.date)}${e.branch_id ? `&branch=${encodeURIComponent(e.branch_id)}` : ""}`;
                          return (
                            <Link href={href} title={`Open Daily Entry for ${e.date}`}
                              style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}>
                              {e.date}
                              <span style={{ fontSize: 9, opacity: 0.7 }}>↗</span>
                            </Link>
                          );
                        })()}
                      </TD>
                      <TD>{(e.branch || "—").replace("V-CUT ", "")}</TD>
                      <TD right>{INR(e.billing)}</TD>
                      <TD right style={{ color: "var(--accent)" }}>{e.matSale > 0 ? INR(e.matSale) : "—"}</TD>
                      <TD right style={{ color: "var(--gold)" }}>{INR(e.incentive)}</TD>
                      <TD right style={{ color: "var(--accent)" }}>{e.mat_incentive > 0 ? INR(e.mat_incentive) : "—"}</TD>
                      <TD right style={{ fontWeight: 700, color: "var(--gold)" }}>{INR(e.totalInc)}</TD>
                      <TD>
                        <span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: e.taken ? "rgba(74,222,128,0.12)" : "rgba(251,146,60,0.12)", color: e.taken ? "var(--green)" : "var(--orange)" }}>
                          {e.taken ? "TAKEN" : "PENDING"}
                        </span>
                      </TD>
                    </tr>
                  );
                })}
                <tr style={{ background: "var(--bg3)", fontWeight: 700, borderTop: "2px solid var(--border2)" }}>
                  {canEdit && sorted.some(e => !e.taken) && <TD></TD>}
                  <TD>TOTAL</TD><TD></TD>
                  <TD right style={{ color: "var(--blue, #60a5fa)" }}>{INR(breakdownTotalSale)}</TD>
                  <TD right style={{ color: "var(--accent)" }}>{INR(breakdownTotalMatSale)}</TD>
                  <TD right style={{ color: "var(--gold)" }}>{INR(sorted.reduce((s, e) => s + e.incentive, 0))}</TD>
                  <TD right style={{ color: "var(--accent)" }}>{INR(sorted.reduce((s, e) => s + e.mat_incentive, 0))}</TD>
                  <TD right style={{ color: "var(--gold)", fontWeight: 800 }}>{INR(breakdownTotalInc)}</TD>
                  <TD></TD>
                </tr>
                {/* Taken / Pending split — surfaces the remaining balance to be paid right next to the TOTAL row. */}
                {breakdownTotalInc > 0 && (
                  <tr style={{ background: "var(--bg4)", fontSize: 11 }}>
                    {canEdit && sorted.some(e => !e.taken) && <TD></TD>}
                    <TD style={{ color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Settlement</TD>
                    <TD colSpan={5} style={{ color: "var(--text3)" }}>
                      Taken <strong style={{ color: "var(--green)" }}>{INR(breakdownTakenInc)}</strong>
                      <span style={{ margin: "0 10px", color: "var(--border2)" }}>·</span>
                      Pending <strong style={{ color: breakdownPendingInc > 0 ? "var(--orange)" : "var(--text3)" }}>{INR(breakdownPendingInc)}</strong>
                    </TD>
                    <TD right style={{ color: breakdownPendingInc > 0 ? "var(--orange)" : "var(--text3)", fontWeight: 800 }} title="Remaining incentive balance to be paid">{INR(breakdownPendingInc)}</TD>
                    <TD>
                      {breakdownPendingInc > 0 ? (
                        <span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 9, fontWeight: 700, background: "rgba(251,146,60,0.12)", color: "var(--orange)" }}>BALANCE</span>
                      ) : (
                        <span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 9, fontWeight: 700, background: "rgba(74,222,128,0.12)", color: "var(--green)" }}>SETTLED</span>
                      )}
                    </TD>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>
        );
      })()}

      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}
