"use client";
import { useEffect, useMemo, useState } from "react";
import { collection, doc, onSnapshot, addDoc, deleteDoc, setDoc, updateDoc, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Card, Icon, IconBtn, Pill, useToast, useConfirm } from "@/components/ui";

const INR = (n) => "₹" + Number(n || 0).toLocaleString("en-IN");

export default function DayWorkingPage() {
  const { toast, ToastContainer } = useToast();
  const { confirm, ConfirmDialog } = useConfirm();

  const [currentUser, setCurrentUser] = useState(null);
  const [staffData, setStaffData] = useState(null);
  const [branchData, setBranchData] = useState(null);
  const [menus, setMenus] = useState([]);
  const [logs, setLogs] = useState([]);
  const [closure, setClosure] = useState(null);
  const [todayEntry, setTodayEntry] = useState(null);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);

  const today = () => new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today());
  const [search, setSearch] = useState("");
  const [tip, setTip] = useState("");
  const [tipIn, setTipIn] = useState("cash");
  const [matSale, setMatSale] = useState("");
  const [matName, setMatName] = useState("");
  const [customPrice, setCustomPrice] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("vcut_user");
    if (saved) setCurrentUser(JSON.parse(saved));
  }, []);

  useEffect(() => {
    if (!db || !currentUser?.staff_id) { setLoading(false); return; }
    const unsubs = [
      onSnapshot(collection(db, "staff"), sn => {
        const s = sn.docs.map(d => ({ ...d.data(), id: d.id })).find(x => x.id === currentUser.staff_id);
        setStaffData(s || null);
      }),
      onSnapshot(collection(db, "branches"), sn => {
        const b = sn.docs.map(d => ({ ...d.data(), id: d.id }));
        const mine = b.find(x => x.id === currentUser.branch_id);
        setBranchData(mine || null);
      }),
      onSnapshot(collection(db, "menus"), sn => {
        setMenus(sn.docs.map(d => ({ ...d.data(), id: d.id })));
      }),
      onSnapshot(doc(db, "settings", "global"), sn => {
        if (sn.exists()) setSettings(sn.data());
      }),
    ];
    setLoading(false);
    return () => unsubs.forEach(u => u());
  }, [currentUser]);

  useEffect(() => {
    if (!db || !currentUser?.staff_id || !date) return;
    const q = query(
      collection(db, "service_logs"),
      where("staff_id", "==", currentUser.staff_id),
      where("date", "==", date),
    );
    const unsub = onSnapshot(q, sn => {
      const list = sn.docs.map(d => ({ ...d.data(), id: d.id }));
      list.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
      setLogs(list);
    });
    return () => unsub();
  }, [currentUser, date]);

  useEffect(() => {
    if (!db || !currentUser?.staff_id || !date) return;
    const closureId = `${currentUser.staff_id}_${date}`;
    const unsubC = onSnapshot(doc(db, "day_closures", closureId), sn => {
      setClosure(sn.exists() ? { ...sn.data(), id: sn.id } : null);
    });
    const unsubE = onSnapshot(
      query(collection(db, "entries"), where("date", "==", date), where("branch_id", "==", currentUser.branch_id)),
      sn => {
        const entries = sn.docs.map(d => ({ ...d.data(), id: d.id }));
        setTodayEntry(entries[0] || null);
      }
    );
    return () => { unsubC(); unsubE(); };
  }, [currentUser, date]);

  const branchMenus = useMemo(
    () => menus.filter(m => (m.branches || []).includes(currentUser?.branch_id)),
    [menus, currentUser]
  );

  const flatServices = useMemo(() => {
    const out = [];
    branchMenus.forEach(m => {
      (m.groups || []).forEach(g => {
        (g.items || []).forEach(it => {
          out.push({
            menu_id: m.id,
            menu_name: m.name,
            menu_type: m.type,
            group: g.name,
            name: it.name,
            price: Number(it.price) || 0,
            icon: it.icon,
            time: it.time,
          });
        });
      });
    });
    return out;
  }, [branchMenus]);

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    const asNum = Number(q);
    const isNum = !Number.isNaN(asNum) && q !== "";
    return flatServices
      .filter(s => {
        if (isNum) return Math.abs(s.price - asNum) <= Math.max(50, asNum * 0.1);
        return s.name.toLowerCase().includes(q) || (s.group || "").toLowerCase().includes(q);
      })
      .slice(0, 25);
  }, [search, flatServices]);

  const totals = useMemo(() => {
    const billing = logs.reduce((a, b) => a + (Number(b.amount) || 0), 0);
    const tips = logs.reduce((a, b) => a + (Number(b.tip) || 0), 0);
    const material = logs.reduce((a, b) => a + (Number(b.material_sale) || 0), 0);
    return { billing, tips, material };
  }, [logs]);

  const rates = useMemo(() => {
    const b = branchData;
    const isUnisex = b?.type === "unisex";
    const incPct = settings
      ? (isUnisex ? (settings.unisex_inc ?? 10) : (settings.mens_inc ?? 10))
      : (staffData?.incentive_pct ?? 10);
    const matPct = 5;
    return { incPct, matPct };
  }, [branchData, settings, staffData]);

  const calc = useMemo(() => {
    const incentive = Math.round(totals.billing * rates.incPct / 100);
    const mat_incentive = Math.round(totals.material * rates.matPct / 100);
    return { incentive, mat_incentive, staff_total_inc: incentive + mat_incentive + totals.tips };
  }, [totals, rates]);

  const entryForMe = useMemo(() => {
    if (!todayEntry || !currentUser?.staff_id) return null;
    return (todayEntry.staff_billing || []).find(sb => sb.staff_id === currentUser.staff_id) || null;
  }, [todayEntry, currentUser]);

  const discrepancy = useMemo(() => {
    if (!entryForMe) return null;
    const diff = (Number(entryForMe.billing) || 0) - totals.billing;
    const tipDiff = (Number(entryForMe.tips) || 0) - totals.tips;
    const matDiff = (Number(entryForMe.material) || 0) - totals.material;
    return { diff, tipDiff, matDiff };
  }, [entryForMe, totals]);

  const isClosed = !!closure?.closed_at;

  async function addService(svc) {
    if (isClosed) { toast({ title: "Day Closed", message: "This day is already closed. Contact your manager to reopen.", type: "warning" }); return; }
    if (!currentUser?.staff_id || !currentUser?.branch_id) return;
    const override = customPrice.trim() === "" ? null : Number(customPrice);
    if (override !== null && (Number.isNaN(override) || override < 0)) {
      toast({ title: "Invalid price", message: "Custom price must be a non-negative number.", type: "warning" });
      return;
    }
    const finalAmount = override !== null ? override : svc.price;
    setSaving(true);
    try {
      await addDoc(collection(db, "service_logs"), {
        staff_id: currentUser.staff_id,
        staff_name: currentUser.name || staffData?.name || "",
        branch_id: currentUser.branch_id,
        date,
        service_name: svc.name,
        service_group: svc.group,
        menu_id: svc.menu_id,
        menu_type: svc.menu_type,
        amount: finalAmount,
        standard_price: svc.price,
        custom_price: override !== null,
        price_note: override !== null && override !== svc.price ? `Customized (standard ${INR(svc.price)})` : "",
        tip: Number(tip) || 0,
        tip_in: tipIn,
        material_sale: Number(matSale) || 0,
        material_name: matName.trim() || "",
        created_at: new Date().toISOString(),
      });
      setSearch(""); setTip(""); setMatSale(""); setMatName(""); setCustomPrice("");
      toast({
        title: "Logged",
        message: `${svc.name} · ${INR(finalAmount)}${override !== null && override !== svc.price ? ` (standard ${INR(svc.price)})` : ""}`,
        type: "success"
      });
    } catch (err) {
      toast({ title: "Error", message: err.message, type: "error" });
    }
    setSaving(false);
  }

  async function updateLogAmount(log, newAmount) {
    if (isClosed) return;
    const val = Number(newAmount);
    if (Number.isNaN(val) || val < 0) {
      toast({ title: "Invalid amount", message: "Enter a non-negative number.", type: "warning" });
      return;
    }
    if (val === Number(log.amount)) return;
    try {
      await updateDoc(doc(db, "service_logs", log.id), {
        amount: val,
        custom_price: val !== Number(log.standard_price || 0),
        price_note: val !== Number(log.standard_price || 0) ? `Customized (standard ${INR(log.standard_price || 0)})` : "",
        edited_at: new Date().toISOString(),
      });
    } catch (err) {
      toast({ title: "Error", message: err.message, type: "error" });
    }
  }

  function removeLog(log) {
    if (isClosed) { toast({ title: "Day Closed", message: "Cannot delete logs after day is closed.", type: "warning" }); return; }
    confirm({
      title: "Remove Service?", message: `Remove "${log.service_name}" (${INR(log.amount)}) from today's log?`,
      confirmText: "Remove", cancelText: "Keep", type: "danger",
      onConfirm: async () => {
        try { await deleteDoc(doc(db, "service_logs", log.id)); }
        catch (err) { toast({ title: "Error", message: err.message, type: "error" }); }
      }
    });
  }

  async function closeDay() {
    if (logs.length === 0) { toast({ title: "Nothing to Close", message: "Log at least one service before closing the day.", type: "warning" }); return; }
    confirm({
      title: "Close Day?",
      message: `<strong>${logs.length}</strong> services · Billing <strong>${INR(totals.billing)}</strong> · Tips <strong>${INR(totals.tips)}</strong> · Material <strong>${INR(totals.material)}</strong><br/><br/>Incentive <strong>${INR(calc.incentive)}</strong> + Material Inc <strong>${INR(calc.mat_incentive)}</strong> = <strong>${INR(calc.staff_total_inc)}</strong><br/><br/>Once closed, logs are locked.`,
      confirmText: "Close Day", cancelText: "Cancel", type: "warning",
      onConfirm: async () => {
        try {
          const id = `${currentUser.staff_id}_${date}`;
          await setDoc(doc(db, "day_closures", id), {
            staff_id: currentUser.staff_id,
            staff_name: currentUser.name || staffData?.name || "",
            branch_id: currentUser.branch_id,
            date,
            services_count: logs.length,
            billing: totals.billing,
            tips: totals.tips,
            material: totals.material,
            incentive: calc.incentive,
            mat_incentive: calc.mat_incentive,
            staff_total_inc: calc.staff_total_inc,
            inc_pct_applied: rates.incPct,
            closed_at: new Date().toISOString(),
          });
          toast({ title: "Day Closed", message: "Incentive locked in. Manager can now reconcile.", type: "success" });
        } catch (err) {
          toast({ title: "Error", message: err.message, type: "error" });
        }
      }
    });
  }

  async function reopenDay() {
    confirm({
      title: "Reopen Day?", message: "Editing services will invalidate the locked incentive. You'll need to close again.",
      confirmText: "Reopen", cancelText: "Cancel", type: "warning",
      onConfirm: async () => {
        try {
          const id = `${currentUser.staff_id}_${date}`;
          await deleteDoc(doc(db, "day_closures", id));
          toast({ title: "Reopened", message: "You can edit logs again.", type: "info" });
        } catch (err) {
          toast({ title: "Error", message: err.message, type: "error" });
        }
      }
    });
  }

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "var(--text3)" }}>Loading...</div>;
  if (!currentUser?.staff_id) return <div style={{ padding: 40, textAlign: "center", color: "var(--red)" }}>Staff profile not linked to your user. Contact your admin.</div>;

  const input = { padding: "12px 14px", border: "1px solid var(--border2)", borderRadius: 10, background: "rgba(255,255,255,0.02)", color: "var(--text)", outline: "none", fontSize: 13, width: "100%" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, padding: "0 4px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, fontWeight: 800 }}>Welcome</div>
          <h2 style={{ fontSize: 24, fontWeight: 900, color: "var(--text)", margin: 0 }}>{staffData?.name || currentUser.name}'s Day</h2>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 4 }}>{branchData?.name?.replace("V-CUT ", "") || currentUser.branch_id} · {branchData?.type || "—"}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <input type="date" value={date} max={today()} onChange={e => setDate(e.target.value)}
            style={{ ...input, width: 170, fontWeight: 700 }} />
          {isClosed
            ? <Pill label={`Closed · ${INR(closure.staff_total_inc)}`} color="gold" />
            : <Pill label="Open" color="green" />}
        </div>
      </div>

      {/* Totals strip */}
      <Card style={{ padding: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 16 }}>
          <Metric label="Services" value={logs.length} color="var(--accent)" />
          <Metric label="Billing" value={INR(totals.billing)} color="var(--green)" />
          <Metric label="Tips" value={INR(totals.tips)} color="var(--gold)" />
          <Metric label="Material Sale" value={INR(totals.material)} color="var(--text2)" />
          <Metric label={`Incentive (${rates.incPct}%)`} value={INR(calc.incentive)} color="var(--gold)" />
          <Metric label="Total Earning" value={INR(calc.staff_total_inc)} color="var(--green)" highlight />
        </div>
      </Card>

      {/* Discrepancy banner */}
      {discrepancy && (discrepancy.diff !== 0 || discrepancy.tipDiff !== 0 || discrepancy.matDiff !== 0) && (
        <div style={{ padding: "12px 16px", borderRadius: 12, background: "rgba(255,180,0,0.08)", border: "1px solid rgba(255,180,0,0.3)", color: "var(--text)", fontSize: 13, display: "flex", alignItems: "center", gap: 10 }}>
          <Icon name="alert" size={18} color="var(--gold)" />
          <div style={{ flex: 1 }}>
            <strong style={{ color: "var(--gold)" }}>Discrepancy with Daily Entry:</strong>{" "}
            {discrepancy.diff !== 0 && <>Billing mismatch <strong>{INR(Math.abs(discrepancy.diff))}</strong> ({discrepancy.diff > 0 ? "daily entry higher" : "logs higher"}). </>}
            {discrepancy.tipDiff !== 0 && <>Tips differ by <strong>{INR(Math.abs(discrepancy.tipDiff))}</strong>. </>}
            {discrepancy.matDiff !== 0 && <>Material differs by <strong>{INR(Math.abs(discrepancy.matDiff))}</strong>.</>}
          </div>
        </div>
      )}

      {/* Search + Add */}
      {!isClosed && (
        <Card style={{ padding: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 900, color: "var(--gold)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 12 }}>Add a Service</div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 12 }}>
            <input placeholder="Search service name or amount (e.g. 'haircut' or 400)"
              value={search} onChange={e => setSearch(e.target.value)} style={input} />
            <input placeholder="Custom price ₹ (optional)" type="number" min="0" value={customPrice} onChange={e => setCustomPrice(e.target.value)}
              title="Override the standard menu price for this log entry" style={{ ...input, borderColor: customPrice ? "var(--gold)" : undefined }} />
            <input placeholder="Tip (optional)" type="number" min="0" value={tip} onChange={e => setTip(e.target.value)} style={input} />
            <select value={tipIn} onChange={e => setTipIn(e.target.value)} style={input}>
              <option value="cash">Tip · Cash</option>
              <option value="online">Tip · Online</option>
            </select>
            <input placeholder="Material sale ₹ (optional)" type="number" min="0" value={matSale} onChange={e => setMatSale(e.target.value)} style={input} />
            <input placeholder="Material name (optional)" value={matName} onChange={e => setMatName(e.target.value)} style={input} />
          </div>

          {search.trim() && (
            <div style={{ maxHeight: 320, overflowY: "auto", background: "var(--bg2)", borderRadius: 10, border: "1px solid var(--border)" }}>
              {searchResults.length === 0 ? (
                <div style={{ padding: 18, fontSize: 12, color: "var(--text3)", textAlign: "center" }}>No matches. Try another name or exact amount.</div>
              ) : searchResults.map((s, i) => {
                const override = customPrice.trim() === "" ? null : Number(customPrice);
                const overridden = override !== null && !Number.isNaN(override) && override !== s.price;
                return (
                  <button key={i} onClick={() => addService(s)} disabled={saving}
                    style={{ display: "flex", width: "100%", padding: "10px 14px", alignItems: "center", gap: 10, justifyContent: "space-between", background: "transparent", border: "none", borderBottom: "1px solid var(--border)", color: "var(--text)", cursor: "pointer", textAlign: "left" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
                      <span style={{ fontSize: 16 }}>{s.icon || "💈"}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</div>
                        <div style={{ fontSize: 10, color: "var(--text3)" }}>{s.group} · {s.menu_name}</div>
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                      {overridden && <span style={{ fontSize: 10, color: "var(--text3)", textDecoration: "line-through" }}>{INR(s.price)}</span>}
                      <span style={{ fontSize: 14, fontWeight: 900, color: overridden ? "var(--gold)" : "var(--green)" }}>{INR(overridden ? override : s.price)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 8 }}>
            Tip/Material are attached to the next service you pick. Leave them blank if not applicable.
          </div>
        </Card>
      )}

      {/* Logs list */}
      <Card style={{ padding: 0 }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 900, color: "var(--gold)", textTransform: "uppercase", letterSpacing: 1.5 }}>Today's Log — {logs.length} service{logs.length === 1 ? "" : "s"}</div>
          {!isClosed
            ? <button onClick={closeDay} disabled={logs.length === 0}
                style={{ padding: "8px 18px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", fontWeight: 900, border: "none", cursor: logs.length === 0 ? "not-allowed" : "pointer", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, opacity: logs.length === 0 ? 0.5 : 1 }}>
                <Icon name="check" size={13} /> Close Day
              </button>
            : <button onClick={reopenDay}
                style={{ padding: "8px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", cursor: "pointer", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
                Reopen
              </button>}
        </div>
        {logs.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--text3)", fontSize: 13 }}>No services logged yet for {date}.</div>
        ) : (
          <div>
            {logs.map(l => (
              <LogRow key={l.id} log={l} isClosed={isClosed} onAmountChange={updateLogAmount} onRemove={removeLog} />
            ))}
          </div>
        )}
      </Card>

      {/* Reconciliation with daily entry */}
      {entryForMe && (
        <Card style={{ padding: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 900, color: "var(--gold)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 12 }}>Daily Entry Reconciliation</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, fontSize: 12 }}>
            <div><div style={{ color: "var(--text3)", fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>&nbsp;</div><div style={{ fontWeight: 700 }}>Billing</div><div style={{ fontWeight: 700, marginTop: 6 }}>Tips</div><div style={{ fontWeight: 700, marginTop: 6 }}>Material</div><div style={{ fontWeight: 700, marginTop: 6 }}>Incentive</div></div>
            <div style={{ textAlign: "right" }}><div style={{ color: "var(--text3)", fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>My Logs</div><div>{INR(totals.billing)}</div><div style={{ marginTop: 6 }}>{INR(totals.tips)}</div><div style={{ marginTop: 6 }}>{INR(totals.material)}</div><div style={{ marginTop: 6 }}>{INR(calc.incentive)}</div></div>
            <div style={{ textAlign: "right" }}><div style={{ color: "var(--text3)", fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Daily Entry</div><div>{INR(entryForMe.billing)}</div><div style={{ marginTop: 6 }}>{INR(entryForMe.tips)}</div><div style={{ marginTop: 6 }}>{INR(entryForMe.material)}</div><div style={{ marginTop: 6 }}>{INR(entryForMe.incentive)}</div></div>
            <div style={{ textAlign: "right" }}><div style={{ color: "var(--text3)", fontSize: 10, textTransform: "uppercase", letterSpacing: 1 }}>Δ</div>
              <Diff a={totals.billing} b={entryForMe.billing} />
              <Diff a={totals.tips} b={entryForMe.tips} />
              <Diff a={totals.material} b={entryForMe.material} />
              <Diff a={calc.incentive} b={entryForMe.incentive} />
            </div>
          </div>
        </Card>
      )}

      {ToastContainer}
      {ConfirmDialog}
    </div>
  );
}

function Metric({ label, value, color, highlight }) {
  return (
    <div style={{ padding: "10px 4px", borderRight: "1px solid var(--border)" }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.2 }}>{label}</div>
      <div style={{ fontSize: highlight ? 22 : 18, fontWeight: 950, color, marginTop: 4, letterSpacing: -0.5 }}>{value}</div>
    </div>
  );
}

function LogRow({ log, isClosed, onAmountChange, onRemove }) {
  const [draft, setDraft] = useState(String(log.amount ?? ""));

  useEffect(() => { setDraft(String(log.amount ?? "")); }, [log.amount]);

  const commit = () => {
    if (draft === "" || draft === String(log.amount)) { setDraft(String(log.amount ?? "")); return; }
    onAmountChange(log, draft);
  };

  const stdPrice = Number(log.standard_price) || 0;
  const customized = stdPrice > 0 && stdPrice !== Number(log.amount);
  const delta = customized ? Number(log.amount) - stdPrice : 0; // +ve = upcharge, -ve = discount
  const isDiscount = delta < 0;
  const isUpcharge = delta > 0;

  return (
    <div style={{ display: "flex", alignItems: "center", padding: "12px 20px", borderBottom: "1px solid var(--border)", gap: 12, flexWrap: "wrap" }}>
      <div style={{ minWidth: 56, fontSize: 10, color: "var(--text3)", fontWeight: 700 }}>
        {log.created_at?.slice(11, 16) || "—"}
      </div>
      <div style={{ flex: 1, minWidth: 180 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{log.service_name}</div>
        <div style={{ fontSize: 10, color: "var(--text3)" }}>
          {log.service_group}
          {log.tip > 0 && <> · Tip {INR(log.tip)} ({log.tip_in})</>}
          {log.material_sale > 0 && <> · Material {INR(log.material_sale)} {log.material_name && `· ${log.material_name}`}</>}
        </div>
      </div>

      {/* Standard price column — always shown */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", minWidth: 90 }}>
        <span style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Standard</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text3)", textDecoration: customized ? "line-through" : "none" }}>
          {stdPrice > 0 ? INR(stdPrice) : "—"}
        </span>
      </div>

      {/* Charged / editable price column */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", minWidth: 110 }}>
        <span style={{ fontSize: 9, color: isDiscount ? "var(--gold)" : isUpcharge ? "var(--green)" : "var(--green)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
          {isDiscount
            ? `Charged · Disc ${INR(Math.abs(delta))}`
            : isUpcharge
              ? `Charged · Extra +${INR(delta)}`
              : "Charged"}
        </span>
        {isClosed ? (
          <span style={{ fontSize: 14, fontWeight: 900, color: isDiscount ? "var(--gold)" : "var(--green)" }}>{INR(log.amount)}</span>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 2, marginTop: 2 }}>
            <span style={{ fontSize: 13, color: "var(--text3)" }}>₹</span>
            <input
              type="number"
              min="0"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={e => { if (e.key === "Enter") { e.currentTarget.blur(); } }}
              style={{ width: 90, padding: "5px 8px", borderRadius: 8, border: `1px solid ${isDiscount ? "var(--gold)" : isUpcharge ? "var(--green)" : "var(--border2)"}`, background: "rgba(255,255,255,0.02)", color: isDiscount ? "var(--gold)" : "var(--green)", fontWeight: 900, fontSize: 14, textAlign: "right", outline: "none" }}
              title="Edit the charged price. Click outside or press Enter to save."
            />
          </div>
        )}
      </div>

      {!isClosed && <IconBtn name="del" title="Remove" variant="danger" size={28} onClick={() => onRemove(log)} />}
    </div>
  );
}

function Diff({ a, b }) {
  const d = (Number(a) || 0) - (Number(b) || 0);
  const match = d === 0;
  return (
    <div style={{ marginTop: 6, fontWeight: 700, color: match ? "var(--green)" : "var(--red)" }}>
      {match ? "✓" : (d > 0 ? "+" : "") + INR(d)}
    </div>
  );
}
