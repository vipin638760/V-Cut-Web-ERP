"use client";
import { useEffect, useState } from "react";
import { collection, onSnapshot, doc, setDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR } from "@/lib/calculations";
import { Card, Pill, TH, TD, StatCard, Icon, useConfirm } from "@/components/ui";
import VLoader from "@/components/VLoader";


export default function SalaryTab() {
  const currentUser = useCurrentUser() || {};
  const isAccountant = currentUser.role === "accountant";

  const { confirm, ConfirmDialog } = useConfirm();
  const [branches, setBranches] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  
  // Local state for mass edits
  const [localStaff, setLocalStaff] = useState({});

  useEffect(() => {
    if (!db) return;
    const unsubB = onSnapshot(collection(db, "branches"), sn => 
      setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id }))));
    const unsubS = onSnapshot(collection(db, "staff"), sn => {
      const s = sn.docs.map(d => ({ ...d.data(), id: d.id }));
      setStaff(s);
      
      // Initialize local state
      const fresh = {};
      s.forEach(st => {
        fresh[st.id] = { salary: st.salary || 0, target: st.target || 0, branch_id: st.branch_id };
      });
      setLocalStaff(fresh);
      setLoading(false);
    });
    return () => { unsubB(); unsubS(); };
  }, []);

  const handleChange = (sid, field, val) => {
    setLocalStaff(prev => ({ ...prev, [sid]: { ...prev[sid], [field]: field === "branch_id" ? val : Number(val) } }));
  };

  const handleSaveSync = async (bid, bStaffIds) => {
    let newBudget = 0;
    try {
      const promises = bStaffIds.map(sid => {
        const payload = localStaff[sid];
        if (payload.branch_id === bid) newBudget += payload.salary;
        return setDoc(doc(db, "staff", sid), payload, { merge: true });
      });
      await Promise.all(promises);
      await setDoc(doc(db, "branches", bid), { salary_budget: newBudget }, { merge: true });
    } catch (e) { confirm({ title: "Sync Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
  };

  if (isAccountant) return (
    <div style={{ padding: 60, textAlign: "center", color: "var(--red)", fontWeight: 800, display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
      <div style={{ fontSize: 40 }}>🔒</div>
      <div style={{ fontSize: 18 }}>Access Restricted</div>
      <div style={{ fontSize: 13, color: "var(--text3)", fontWeight: 500 }}>Salary configuration is not available for your role.</div>
    </div>
  );

  if (loading) return <VLoader fullscreen label="Calibrating payroll infrastructure" />;

  let grandTotal = 0;
  staff.forEach(s => {
    grandTotal += (localStaff[s.id]?.salary || 0);
  });

  const inputStyle = { 
    width: 110, 
    textAlign: "right", 
    padding: "10px 14px", 
    border: "1px solid var(--border2)", 
    borderRadius: 10, 
    background: "rgba(255,255,255,0.02)", 
    color: "var(--text)", 
    outline: "none",
    fontSize: 13,
    fontWeight: 700,
    transition: "all 0.2s"
  };

  const selectStyle = { 
    padding: "10px 14px", 
    border: "1px solid var(--border2)", 
    borderRadius: 10, 
    background: "rgba(255,255,255,0.02)", 
    color: "var(--text)", 
    maxWidth: 180,
    outline: "none",
    fontSize: 13,
    fontWeight: 600
  };

  return (
    <div style={{ animation: "fadeIn 0.5s ease-out", display: "flex", flexDirection: "column", gap: 32 }}>
      
      {/* Financial Overview */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 24 }}>
        <StatCard 
          label="Network Payroll Commitment" 
          value={INR(grandTotal)} 
          subtext={`Consolidated for ${staff.length} employees`}
          icon={<Icon name="wallet" size={24} />}
          color="accent"
        />
        <div style={{ background: "rgba(34,211,238,0.05)", border: "1px dashed var(--accent)", borderRadius: 24, padding: "24px", display: "flex", gap: 16, alignItems: "center" }}>
           <div style={{ background: "rgba(34,211,238,0.1)", padding: 12, borderRadius: 16 }}>
              <Icon name="info" size={20} color="var(--accent)" />
           </div>
           <div style={{ fontSize: 13, color: "var(--text3)", lineHeight: 1.6, fontWeight: 500 }}>
             Configure net base compensation and performance targets. Use <strong style={{color:"var(--accent)"}}>Sync Node</strong> to reconcile personnel costs with branch budgets.
           </div>
        </div>
      </div>

      {branches.sort((a,b) => a.name.localeCompare(b.name)).map(b => {
        const bStaffIds = staff.filter(s => (localStaff[s.id]?.branch_id || s.branch_id) === b.id).map(s => s.id);
        if (!bStaffIds.length) return null;

        const branchTotalSal = bStaffIds.reduce((sum, id) => sum + (localStaff[id]?.salary || 0), 0);
        const budgetMatch = branchTotalSal === (b.salary_budget || 0);

        return (
          <Card key={b.id} style={{ overflow: "visible", padding: 0 }}>
            <div style={{ padding: "24px 32px", borderBottom: "1px solid var(--border2)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 20 }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
                  <span style={{ fontWeight: 950, fontSize: 18, color: "var(--text)", letterSpacing: 0.5 }}>{b.name}</span>
                  <Pill label={b.type === "unisex" ? "Unisex" : "Mens"} color={b.type === "unisex" ? "purple" : "blue"} />
                </div>
                <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 900, textTransform: "uppercase", letterSpacing: 1.5 }}>
                   Node Resource Allocation
                </div>
              </div>
              
              <div style={{ display: "flex", alignItems: "center", gap: 32, flexWrap: "wrap" }}>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 900, textTransform: "uppercase", marginBottom: 4 }}>Node Expenditure</div>
                  <div style={{ fontSize: 18, fontWeight: 950, color: budgetMatch ? "var(--green)" : "var(--gold)" }}>{INR(branchTotalSal)}</div>
                </div>
                {!budgetMatch && (
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 900, textTransform: "uppercase", marginBottom: 4 }}>Audit Target</div>
                    <div style={{ fontSize: 18, fontWeight: 950, color: "var(--text)" }}>{INR(b.salary_budget)}</div>
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  <Pill label={budgetMatch ? "Provisioned" : "Divergent"} color={budgetMatch ? "green" : "orange"} />
                  <button onClick={() => handleSaveSync(b.id, bStaffIds)} style={{ 
                    padding: "12px 24px", 
                    borderRadius: 14, 
                    background: budgetMatch ? "rgba(255,255,255,0.05)" : "var(--accent)", 
                    color: budgetMatch ? "var(--text)" : "#000", 
                    border: budgetMatch ? "1px solid var(--border)" : "none", 
                    fontWeight: 950, 
                    cursor: "pointer", 
                    fontSize: 11, 
                    textTransform: "uppercase", 
                    letterSpacing: 1,
                    boxShadow: budgetMatch ? "none" : "0 10px 20px -10px rgba(34,211,238,0.4)"
                  }}>
                    Sync Node
                  </button>
                </div>
              </div>
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
                <thead>
                  <tr>
                    <TH>Personnel Asset</TH>
                    <TH>Rank/Role</TH>
                    <TH right>Base Monthly (₹)</TH>
                    <TH right>Productivity Target (₹)</TH>
                    <TH>Node Assignment</TH>
                  </tr>
                </thead>
                <tbody>
                  {bStaffIds.map((sid) => {
                    const s = staff.find(x => x.id === sid);
                    return (
                      <tr key={sid} onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.01)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                        <TD style={{ fontWeight: 800, color: "var(--text)" }}>{s.name}</TD>
                        <TD><Pill label={s.role || "Level 1"} color="blue" /></TD>
                        <TD right>
                          <input type="number" value={localStaff[sid]?.salary || 0} onChange={e => handleChange(sid, 'salary', e.target.value)} style={inputStyle} />
                        </TD>
                        <TD right>
                          <input type="number" value={localStaff[sid]?.target || 0} onChange={e => handleChange(sid, 'target', e.target.value)} style={inputStyle} />
                        </TD>
                        <TD>
                          <select value={localStaff[sid]?.branch_id || ""} onChange={e => handleChange(sid, 'branch_id', e.target.value)} style={{ ...selectStyle, appearance: "none" }}>
                            {branches.map(br => <option key={br.id} value={br.id}>{br.name}</option>)}
                          </select>
                        </TD>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        select option { background: #1a1b1e; color: #fff; }
      `}</style>
      {ConfirmDialog}
    </div>
  );
}
