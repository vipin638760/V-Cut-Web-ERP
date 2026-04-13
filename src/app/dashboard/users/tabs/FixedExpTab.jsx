"use client";
import { useEffect, useState } from "react";
import { collection, onSnapshot, doc, setDoc, deleteDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { INR, proRataSalary, makeFilterPrefix, staffOverallStatus } from "@/lib/calculations";
import { Card, IconBtn, TH, TD, PeriodWidget, StatCard, Icon, Pill, useConfirm, useToast } from "@/components/ui";

const NOW = new Date();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function FixedExpTab() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [branches, setBranches] = useState([]);
  const [staff, setStaff] = useState([]);
  const [salaryHistory, setSalaryHistory] = useState([]);
  const [globalSettings, setGlobalSettings] = useState({});
  const [monthlyExpenses, setMonthlyExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  
  const [filterMode, setFilterMode] = useState("month");
  const [filterYear, setFilterYear] = useState(NOW.getFullYear());
  const [filterMonth, setFilterMonth] = useState(NOW.getMonth() + 1);
  const selectedPeriod = `${filterYear}-${String(filterMonth).padStart(2, "0")}`;

  const [localValues, setLocalValues] = useState({});

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "staff"), sn => setStaff(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "salary_history"), sn => setSalaryHistory(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "settings"), sn => {
        const gs = {}; sn.docs.forEach(d => gs[d.id] = d.data()); setGlobalSettings(gs);
      }),
      onSnapshot(collection(db, "monthly_expenses"), sn => {
        setMonthlyExpenses(sn.docs.map(d => ({ ...d.data(), id: d.id })));
        setLoading(false);
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  const getFallbackFixed = (bid) => {
    const b = branches.find(x => x.id === bid) || {};
    return {
      shop_rent: b.shop_rent || 0,
      room_rent: b.room_rent || 0,
      shop_elec: b.shop_elec || 0,
      room_elec: b.room_elec || 0,
      wifi: b.wifi || 0,
      water: b.water || 0,
    };
  };

  const getMonthlyFixed = (bid, period) => {
    const override = monthlyExpenses.find(m => m.branch_id === bid && m.month === period);
    const fb = getFallbackFixed(bid);
    if (!override) return { ...fb, __custom: false };
    return {
      shop_rent: override.shop_rent ?? fb.shop_rent,
      room_rent: override.room_rent ?? fb.room_rent,
      shop_elec: override.shop_elec ?? fb.shop_elec,
      room_elec: override.room_elec ?? fb.room_elec,
      wifi: override.wifi ?? fb.wifi,
      water: override.water ?? fb.water,
      id: override.id,
      __custom: true
    };
  };

  const getBranchSalary = (bid, period) => {
    return staff
      .filter(s => s.branch_id === bid && staffOverallStatus(s, period) === "active")
      .reduce((s, st) => s + proRataSalary(st, period, branches, salaryHistory, staff, globalSettings.main), 0);
  };

  useEffect(() => {
    const fresh = {};
    branches.forEach(b => {
      fresh[b.id] = { ...getMonthlyFixed(b.id, selectedPeriod) };
    });
    setLocalValues(fresh);
  }, [branches, monthlyExpenses, selectedPeriod]);

  const handleInputChange = (bid, field, val) => {
    setLocalValues(prev => ({ ...prev, [bid]: { ...prev[bid], [field]: Number(val) || 0 } }));
  };

  const handleSave = async (bid) => {
    const vals = localValues[bid];
    if (!vals) return;
    const id = vals.id || `${bid}_${selectedPeriod}`;
    const payload = { 
      branch_id: bid, 
      month: selectedPeriod,
      shop_rent: vals.shop_rent,
      room_rent: vals.room_rent,
      shop_elec: vals.shop_elec,
      room_elec: vals.room_elec,
      wifi: vals.wifi,
      water: vals.water
    };
    try {
      await setDoc(doc(db, "monthly_expenses", id), payload, { merge: true });
      toast({ title: "Saved", message: "Expense configuration saved successfully.", type: "success" });
    } catch (e) { confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
  };

  const handleClear = async (bid) => {
    const id = localValues[bid]?.id;
    if (!id) return;
    confirm({
      title: "Revert to Defaults",
      message: "Are you sure you want to revert to system defaults for this <strong>branch</strong>?",
      confirmText: "Yes, Revert",
      cancelText: "Cancel",
      type: "warning",
      onConfirm: async () => {
        try { await deleteDoc(doc(db, "monthly_expenses", id)); toast({ title: "Reverted", message: "Expense config reverted to defaults.", type: "success" }); } catch (e) { confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
      }
    });
  };

  if (loading) return <div style={{ padding: 60, textAlign: "center", color: "var(--accent)", fontWeight: 800 }}>Syncing operational data...</div>;

  const inputStyle = { width: 70, textAlign: "right", padding: "6px 8px", border: "1px solid var(--border2)", borderRadius: 8, fontSize: 13, background: "rgba(255,255,255,0.02)", color: "var(--text)", outline: "none", transition: "all 0.2s" };

  let netOpex = 0, netSalary = 0, netGrand = 0;
  branches.forEach(b => {
    const mf = getMonthlyFixed(b.id, selectedPeriod);
    const sal = getBranchSalary(b.id, selectedPeriod);
    netOpex += (mf.shop_rent + mf.room_rent + mf.shop_elec + mf.room_elec + mf.wifi + mf.water);
    netSalary += sal;
  });
  netGrand = netOpex + netSalary;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32, animation: "fadeIn 0.5s ease-out" }}>
      {/* Analytics Overview */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 24 }}>
        <StatCard 
          label="Operational Opex" 
          value={INR(netOpex)} 
          subtext="Total fixed costs after overrides"
          icon={<Icon name="zap" size={20} />}
          color="orange"
        />
        <StatCard 
          label="Monthly Workforce Cost" 
          value={INR(netSalary)} 
          subtext="Net pro-rata salary distribution"
          icon={<Icon name="users" size={20} />}
          color="blue"
        />
        <StatCard 
          label="Consolidated Net Total" 
          value={INR(netGrand)} 
          subtext={`Performance for ${selectedPeriod}`}
          icon={<Icon name="trending" size={20} />}
          color="gold"
        />
      </div>

      <div style={{ background: "var(--bg2)", padding: "16px 24px", borderRadius: 24, border: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 20 }}>
        <PeriodWidget filterMode={filterMode} setFilterMode={setFilterMode} filterYear={filterYear} setFilterYear={setFilterYear} filterMonth={filterMonth} setFilterMonth={setFilterMonth} />
        <div style={{ background: "rgba(34,211,238,0.05)", padding: "8px 16px", borderRadius: 12, border: "1px dashed var(--accent)", color: "var(--text3)", fontSize: 12, fontWeight: 500 }}>
          <span style={{ color: "var(--gold)", fontWeight: 700 }}>PRO TIP:</span> Gold borders indicate custom overrides active for this month.
        </div>
      </div>

      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
          {filterMode === "month" ? (
            <>
              <thead>
                <tr>
                  <TH>Operational Unit</TH>
                  <TH right>Shop Rent</TH>
                  <TH right>Room Rent</TH>
                  <TH right>Elec (S/R)</TH>
                  <TH right>Connectivity</TH>
                  <TH right color="var(--blue)">Salary Outflow</TH>
                  <TH right color="var(--gold)">UNIT TOTAL</TH>
                  <TH right>Commit</TH>
                </tr>
              </thead>
              <tbody>
                {branches.sort((a,b) => a.name.localeCompare(b.name)).map(b => {
                  const vals = localValues[b.id];
                  if (!vals) return null;
                  const hasCustom = vals.__custom;
                  const sal = getBranchSalary(b.id, selectedPeriod);
                  const opex = vals.shop_rent + vals.room_rent + vals.shop_elec + vals.room_elec + vals.wifi + vals.water;
                  
                  return (
                    <tr key={b.id} onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.01)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <TD style={{ fontWeight: 800, whiteSpace: "nowrap" }}>
                        {b.name} {hasCustom && <Pill label="Override" color="gold" />}
                      </TD>
                      <TD right><input type="number" value={vals.shop_rent} onChange={e => handleInputChange(b.id, 'shop_rent', e.target.value)} style={{ ...inputStyle, borderColor: hasCustom ? "var(--gold)" : "var(--border2)" }} /></TD>
                      <TD right><input type="number" value={vals.room_rent} onChange={e => handleInputChange(b.id, 'room_rent', e.target.value)} style={{ ...inputStyle, borderColor: hasCustom ? "var(--gold)" : "var(--border2)" }} /></TD>
                      <TD right>
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                          <input type="number" value={vals.shop_elec} onChange={e => handleInputChange(b.id, 'shop_elec', e.target.value)} style={{ ...inputStyle, width: 60, borderColor: hasCustom ? "var(--gold)" : "var(--border2)" }} />
                          <input type="number" value={vals.room_elec} onChange={e => handleInputChange(b.id, 'room_elec', e.target.value)} style={{ ...inputStyle, width: 60, borderColor: hasCustom ? "var(--gold)" : "var(--border2)" }} />
                        </div>
                      </TD>
                      <TD right>
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                          <input type="number" value={vals.wifi} onChange={e => handleInputChange(b.id, 'wifi', e.target.value)} style={{ ...inputStyle, width: 60, borderColor: hasCustom ? "var(--gold)" : "var(--border2)" }} />
                          <input type="number" value={vals.water} onChange={e => handleInputChange(b.id, 'water', e.target.value)} style={{ ...inputStyle, width: 60, borderColor: hasCustom ? "var(--gold)" : "var(--border2)" }} />
                        </div>
                      </TD>
                      <TD right style={{ color: "var(--blue)", fontWeight: 700 }}>{INR(sal)}</TD>
                      <TD right style={{ fontWeight: 950, color: "var(--gold)", fontSize: 15 }}>{INR(opex + sal)}</TD>
                      <TD right>
                        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                          <IconBtn name="check" variant="success" size={28} onClick={() => handleSave(b.id)} />
                          {hasCustom && <IconBtn name="del" variant="danger" size={28} onClick={() => handleClear(b.id)} />}
                        </div>
                      </TD>
                    </tr>
                  );
                })}
              </tbody>
            </>
          ) : (
            <>
              <thead>
                <tr>
                  <TH>Operational Unit</TH>
                  {MONTHS.map(m => <TH key={m} right>{m}</TH>)}
                  <TH right color="var(--gold)">YTD CONSOLIDATED</TH>
                </tr>
              </thead>
              <tbody>
                {branches.map(b => {
                  let yearTotal = 0;
                  return (
                    <tr key={b.id} onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.01)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <TD style={{ fontWeight: 800 }}>{b.name}</TD>
                      {MONTHS.map((m, i) => {
                        const period = makeFilterPrefix(filterYear, i + 1);
                        const mf = getMonthlyFixed(b.id, period);
                        const sal = getBranchSalary(b.id, period);
                        const tot = mf.shop_rent + mf.room_rent + mf.shop_elec + mf.room_elec + mf.wifi + mf.water + sal;
                        yearTotal += tot;
                        return <TD key={i} right style={{ color: tot > 0 ? "var(--text)" : "var(--text3)", fontSize: 11, fontWeight: tot > 0 ? 600 : 400 }}>{tot > 0 ? INR(tot) : "—"}</TD>;
                      })}
                      <TD right style={{ fontWeight: 950, color: "var(--gold)", background: "rgba(255,255,255,0.02)" }}>{INR(yearTotal)}</TD>
                    </tr>
                  );
                })}
              </tbody>
            </>
          )}
        </table>
      </Card>

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}
