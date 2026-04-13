"use client";
import { useEffect, useState } from "react";
import { collection, query, where, onSnapshot, addDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { proRataSalary, INR, makeFilterPrefix, periodLabel } from "@/lib/calculations";
import { Card, Icon, IconBtn, Pill, PeriodWidget, ToggleGroup, Modal, TH, TD, useConfirm } from "@/components/ui";

const PremiumKPICard = ({ icon, label, value, sub, color, isSelected, onClick }) => {
  const activeColor = color || "var(--accent)";
  const isRed = activeColor.includes("red");
  const isGreen = activeColor.includes("green");
  const isOrange = activeColor.includes("orange");
  const glowColor = isRed ? "248,113,113" : isGreen ? "74,222,128" : isOrange ? "251,146,60" : "34,211,238";

  return (
    <div 
      onClick={onClick}
      style={{ 
        background: isSelected ? `rgba(${glowColor}, 0.08)` : "rgba(255,255,255,0.02)", 
        border: isSelected ? `2px solid ${activeColor}` : "1px solid var(--border)", 
        padding: "24px", 
        borderRadius: 24,
        display: "flex",
        flexDirection: "column",
        gap: 16,
        transition: "all 0.4s cubic-bezier(0.4, 0, 0.2, 1)",
        position: "relative",
        overflow: "hidden",
        cursor: "pointer",
        boxShadow: isSelected ? `0 12px 24px -10px rgba(${glowColor}, 0.3)` : "none"
      }} className="hover:scale-[1.02]">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ 
          background: isSelected ? activeColor : `rgba(${glowColor}, 0.1)`, 
          padding: 12, 
          borderRadius: 16,
          color: isSelected ? "#000" : activeColor,
          transition: "all 0.3s"
        }}>
          <Icon name={icon} size={22} />
        </div>
        <div style={{ textAlign: "right" }}>
          <p style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5 }}>{label}</p>
          <h2 style={{ fontSize: 28, fontWeight: 950, color: "var(--text)", marginTop: 6, letterSpacing: -1 }}>{value}</h2>
        </div>
      </div>
      {sub && <p style={{ fontSize: 12, color: "var(--text3)", fontWeight: 600, borderTop: "1px solid var(--border2)", paddingTop: 12, marginTop: 4 }}>{sub}</p>}
      <div style={{ position: "absolute", top: -20, right: -20, width: 80, height: 80, background: activeColor, filter: "blur(50px)", opacity: isSelected ? 0.2 : 0.05, borderRadius: "50%" }}></div>
    </div>
  );
};

function generatePayslipPDF(employee, branch, earned, advApproved, advPending, net, baseSalary, period, periodAdvances) {
  const w = window.open('', '_blank', 'width=800,height=900');
  if (!w) return;
  const fmt = (v) => Math.round(v || 0).toLocaleString('en-IN');
  const payMode = employee.pay_mode || "Bank Transfer";
  const advRows = (periodAdvances || []).map(a => {
    const sc = a.status === 'approved' ? '#16a34a' : a.status === 'rejected' ? '#dc2626' : '#ea580c';
    return `<tr><td>${a.date||'—'}</td><td>&#8377;${fmt(a.amount)}</td><td>${a.mode||'Cash'}</td><td>${a.reason||'—'}</td><td><span style="color:${sc};font-weight:700;font-size:11px;padding:3px 8px;background:${sc}12;border-radius:4px;">${(a.status||'pending').toUpperCase()}</span></td></tr>`;
  }).join('');
  const html = `<!DOCTYPE html><html><head><title>Payslip - ${employee.name} - ${period}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}@page{size:A4;margin:16mm}body{font-family:'Segoe UI',system-ui,sans-serif;background:#fff;color:#1a1a1a;padding:36px;max-width:800px;margin:0 auto;font-size:13px}.watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-20deg);font-size:100px;font-weight:900;color:rgba(0,0,0,.018);pointer-events:none;white-space:nowrap;font-style:italic;letter-spacing:10px}.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px;padding-bottom:20px;border-bottom:2px solid #0e0e0e}.brand{display:flex;align-items:baseline;gap:2px}.brand-v{color:#f06464;font-size:38px;font-weight:300;font-style:italic}.brand-cut{color:#1a1a1a;font-size:30px;font-weight:300;font-style:italic}.brand-salon{font-size:11px;font-weight:700;letter-spacing:5px;color:#0891b2;margin-left:6px}.doc-title{text-align:right}.doc-title h2{font-size:20px;font-weight:700;letter-spacing:1px;text-transform:uppercase}.doc-title p{font-size:11px;color:#888;margin-top:3px}.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:28px}.info-box{background:#f7f9fa;padding:16px 18px;border-radius:8px}.info-box h4{font-size:8px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px}.info-row{display:flex;justify-content:space-between;padding:4px 0;font-size:12px}.info-row .label{color:#777}.info-row .value{font-weight:700}.section{margin-bottom:28px}.section-title{font-size:10px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:2.5px;margin-bottom:12px;display:flex;align-items:center;gap:8px}.section-title::before{content:'';display:inline-block;width:3px;height:14px;background:#0891b2;border-radius:2px}table{width:100%;border-collapse:collapse}th{background:#f2f4f5;color:#555;padding:10px 14px;text-align:left;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;border-bottom:1px solid #e5e5e5}th:nth-child(2),td:nth-child(2){text-align:right}td{padding:11px 14px;border-bottom:1px solid #f0f0f0;font-size:12px}.earning{color:#16a34a;font-weight:700}.deduction{color:#dc2626;font-weight:700}.total-row td{border-top:2px solid #1a1a1a;border-bottom:none;font-weight:800;padding-top:14px;font-size:14px}.net-box{background:linear-gradient(135deg,#0e0e0e,#1c1c1c);color:#fff;padding:22px 28px;border-radius:10px;display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}.net-box .lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#888}.net-box .sub{font-size:11px;color:#666;margin-top:3px}.net-box .amt{font-size:28px;font-weight:800;color:#22d3ee;font-family:'Courier New',monospace}.pay-badge{display:inline-flex;align-items:center;gap:6px;background:#f0fdf4;border:1px solid #bbf7d0;color:#16a34a;padding:4px 10px;border-radius:6px;font-size:10px;font-weight:700;text-transform:uppercase}.footer{text-align:center;padding-top:24px;border-top:1px solid #eee;color:#bbb;font-size:9px;letter-spacing:1px;margin-top:16px}.sig-grid{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:36px}.sig-line{text-align:center;border-top:1px solid #ccc;padding-top:8px;font-size:10px;color:#999}@media print{body{padding:0}.no-print{display:none!important}}</style></head><body>
<div class="watermark">V-Cut Salon</div>
<div class="header"><div><div class="brand"><span class="brand-v">V</span><span class="brand-cut">-Cut</span><span class="brand-salon">SALON</span></div><p style="font-size:10px;color:#aaa;margin-top:3px;letter-spacing:1px">Salon Management System</p></div><div class="doc-title"><h2>Pay Slip</h2><p>Period: ${period}</p><p>Generated: ${new Date().toLocaleDateString('en-IN')}</p></div></div>
<div class="info-grid"><div class="info-box"><h4>Employee Details</h4><div class="info-row"><span class="label">Name</span><span class="value">${employee.name}</span></div><div class="info-row"><span class="label">ID</span><span class="value">${employee.id}</span></div><div class="info-row"><span class="label">Role</span><span class="value">${employee.designation||employee.role||'—'}</span></div><div class="info-row"><span class="label">Joining Date</span><span class="value">${employee.joined||employee.join_date||'—'}</span></div></div><div class="info-box"><h4>Payment Details</h4><div class="info-row"><span class="label">Branch</span><span class="value">${branch?.name||'—'}</span></div><div class="info-row"><span class="label">Pay Period</span><span class="value">${period}</span></div><div class="info-row"><span class="label">Payment Mode</span><span class="value"><span class="pay-badge">${payMode}</span></span></div><div class="info-row"><span class="label">Pay Date</span><span class="value">${new Date().toLocaleDateString('en-IN')}</span></div></div></div>
<div class="section"><div class="section-title">Salary Disbursement</div><table><thead><tr><th>Description</th><th>Amount (&#8377;)</th><th>Mode</th></tr></thead><tbody><tr><td>Base Salary</td><td class="earning">&#8377;${fmt(baseSalary)}</td><td style="font-size:11px;color:#888">—</td></tr><tr><td>Earned Salary (Pro-rata)</td><td class="earning">&#8377;${fmt(earned)}</td><td><span class="pay-badge">${payMode}</span></td></tr>${advApproved>0?`<tr><td>Less: Advance Deduction</td><td class="deduction">-&#8377;${fmt(advApproved)}</td><td style="font-size:11px;color:#888">Auto-deducted</td></tr>`:''}<tr class="total-row"><td>Net Payable</td><td>&#8377;${fmt(net)}</td><td></td></tr></tbody></table></div>
<div class="net-box"><div><div class="lbl">Net Pay</div><div class="sub">Disbursed via ${payMode}</div></div><div class="amt">&#8377;${fmt(net)}</div></div>
<div class="section"><div class="section-title">Advance Requests &amp; History</div>${(periodAdvances||[]).length>0?`<table><thead><tr><th>Date</th><th>Amount (&#8377;)</th><th>Mode</th><th>Reason</th><th>Status</th></tr></thead><tbody>${advRows}</tbody></table><div style="margin-top:12px;display:flex;gap:24px;font-size:11px"><div><span style="color:#888">Total Approved:</span> <strong style="color:#16a34a">&#8377;${fmt(advApproved)}</strong></div><div><span style="color:#888">Total Pending:</span> <strong style="color:#ea580c">&#8377;${fmt(advPending)}</strong></div></div>`:'<p style="color:#aaa;font-size:12px;padding:16px 0">No advance requests for this period.</p>'}</div>
<div class="sig-grid"><div class="sig-line">Employee Signature</div><div class="sig-line">Authorized Signatory</div></div>
<div class="footer"><p>System-generated payslip from V-Cut Salon Management System.</p><p style="margin-top:3px">Generated on ${new Date().toLocaleString('en-IN')}</p></div>
<div class="no-print" style="text-align:center;margin-top:20px"><button onclick="window.print()" style="padding:12px 32px;background:#0e0e0e;color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px">&#128438; Print / Save as PDF</button></div>
</body></html>`;
  w.document.write(html);
  w.document.close();
}

export default function MyPayrollPage() {
  const { confirm, ConfirmDialog } = useConfirm();
  const [currentUser, setCurrentUser] = useState(null);
  const [staffData, setStaffData] = useState(null);
  const [advances, setAdvances] = useState([]);
  const [branches, setBranches] = useState([]);
  const [salaryHistory, setSalaryHistory] = useState([]);
  const [leaves, setLeaves] = useState([]);
  const [globalSettings, setGlobalSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [selectedCard, setSelectedCard] = useState('balance');
  const [categoryFilter, setCategoryFilter] = useState('all');

  const now = new Date();
  const [filterMode, setFilterMode] = useState("month");
  const [filterYear, setFilterYear] = useState(now.getFullYear());
  const [filterMonth, setFilterMonth] = useState(now.getMonth() + 1);

  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [advanceDate, setAdvanceDate] = useState(now.toISOString().split('T')[0]);
  const [submitting, setSubmitting] = useState(false);
  const [showAdvLog, setShowAdvLog] = useState(false);

  const currentMonthStr = makeFilterPrefix(now.getFullYear(), now.getMonth() + 1);
  const selectedMonthStr = makeFilterPrefix(filterYear, filterMonth);

  useEffect(() => {
    const saved = localStorage.getItem("vcut_user");
    if (saved) setCurrentUser(JSON.parse(saved));
  }, []);

  useEffect(() => {
    if (!currentUser?.id) return;

    const unsubStaff = onSnapshot(collection(db, "staff"), (snap) => {
      const s = snap.docs.find(d => {
        const data = d.data();
        return (currentUser.staff_id && d.id === currentUser.staff_id) ||
               d.id === currentUser.id ||
               data.name?.toLowerCase().trim() === currentUser.name?.toLowerCase().trim();
      });
      if (s) setStaffData({ id: s.id, ...s.data() });
    });

    const unsubAdv = onSnapshot(collection(db, "staff_advances"), (snap) => {
      setAdvances(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => (b.created_at?.seconds || 0) - (a.created_at?.seconds || 0)));
    });

    const unsubBranches = onSnapshot(collection(db, "branches"), (snap) => {
      setBranches(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });

    const unsubHistory = onSnapshot(collection(db, "salary_history"), (snap) => {
      setSalaryHistory(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });

    const unsubSettings = onSnapshot(collection(db, "settings"), (snap) => {
      setGlobalSettings(snap.docs[0]?.data() || {});
    });

    const unsubLeaves = onSnapshot(collection(db, "leaves"), (snap) => {
      setLeaves(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });

    setLoading(false);
    return () => { unsubStaff(); unsubAdv(); unsubBranches(); unsubHistory(); unsubSettings(); unsubLeaves(); };
  }, [currentUser]);

  const handleRequestAdvance = async (e) => {
    e.preventDefault();
    if (!amount || Number(amount) <= 0) { confirm({ title: "Notice", message: "Please enter a valid amount.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} }); return; }
    if (!reason.trim()) { confirm({ title: "Notice", message: "Please provide a reason.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} }); return; }

    setSubmitting(true);
    try {
      await addDoc(collection(db, "staff_advances"), {
        staff_id: staffData?.id || currentUser.staff_id || currentUser.id,
        staff_name: staffData?.name || currentUser.name,
        amount: Number(amount),
        reason: reason.trim(),
        status: 'pending',
        date: advanceDate,
        month_str: advanceDate.substring(0, 7),
        created_at: serverTimestamp(),
        applied_by: currentUser.id,
        branch_id: staffData?.branch_id || ""
      });
      setAmount("");
      setReason("");
      confirm({ title: "Success", message: "Request logged.", confirmText: "OK", cancelText: "Close", type: "success", onConfirm: () => {} });
    } catch (err) {
      confirm({ title: "Error", message: "Error submitting request.", confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    } finally {
      setSubmitting(false);
    }
  };

  const isYearly = filterMode === "year";
  const factor = (isYearly && filterYear === now.getFullYear()) ? (now.getMonth() + 1) : (isYearly ? 12 : 1);
  const isMyAdvance = (a) => a.staff_id === staffData?.id || a.staff_id === currentUser?.id || a.staff_id === currentUser?.staff_id;
  const myAdvances = advances.filter(isMyAdvance);

  let pastSalaryPaid = 0;
  let currentMonthSalary = 0;
  let displayAdvances = 0;
  let displayAdvancesPending = 0;
  let displayAdvancesCleared = 0;

  const isCurrentYear = filterYear === now.getFullYear();
  const currentM = now.getMonth() + 1;
  const currentMPrefix = `${filterYear}-${String(currentM).padStart(2, '0')}`;

  if (isYearly) {
    const limitPast = isCurrentYear ? currentM - 1 : 12;
    for (let m = 1; m <= limitPast; m++) {
      const mPrefix = `${filterYear}-${String(m).padStart(2, '0')}`;
      pastSalaryPaid += proRataSalary(staffData, mPrefix, branches, salaryHistory, [staffData], globalSettings);
      displayAdvancesCleared += myAdvances.filter(a => a.status === 'approved' && ((a.month_str && a.month_str === mPrefix) || (a.date && a.date.startsWith(mPrefix)))).reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
    }
    if (isCurrentYear) {
      currentMonthSalary = proRataSalary(staffData, currentMPrefix, branches, salaryHistory, [staffData], globalSettings);
    }
    displayAdvances = myAdvances.filter(a => a.status === 'approved' && ((a.month_str && a.month_str.startsWith(String(filterYear))) || (a.date && a.date.startsWith(String(filterYear))))).reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
    displayAdvancesPending = myAdvances.filter(a => a.status === 'pending' && ((a.month_str && a.month_str.startsWith(String(filterYear))) || (a.date && a.date.startsWith(String(filterYear))))).reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
  } else {
    currentMonthSalary = staffData ? proRataSalary(staffData, selectedMonthStr, branches, salaryHistory, [staffData], globalSettings) : 0;
    displayAdvances = myAdvances.filter(a => a.status === 'approved' && (a.month_str === selectedMonthStr || (a.date && a.date.startsWith(selectedMonthStr)))).reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
    displayAdvancesPending = myAdvances.filter(a => a.status === 'pending' && (a.month_str === selectedMonthStr || (a.date && a.date.startsWith(selectedMonthStr)))).reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
  }

  const targetPrefix = isYearly ? currentMPrefix : selectedMonthStr;
  const [cyr, cmo] = targetPrefix.split('-').map(Number);
  const daysInTargetMonth = new Date(cyr, cmo, 0).getDate();
  const targetIsCurrentMonth = (cyr === now.getFullYear() && cmo === now.getMonth() + 1);
  const isPastMonth = cyr < now.getFullYear() || (cyr === now.getFullYear() && cmo < (now.getMonth() + 1));
  const daysElapsed = targetIsCurrentMonth ? now.getDate() : daysInTargetMonth;

  if (!isYearly && isPastMonth) displayAdvancesCleared = displayAdvances;
  const displayAdvancesBalance = displayAdvances - displayAdvancesCleared;
  const earnedSoFar = Math.round(currentMonthSalary * daysElapsed / daysInTargetMonth);
  const displaySalary = pastSalaryPaid + currentMonthSalary;

  const curMonthAdvancesOnly = myAdvances.filter(a => a.status === 'approved' && (a.month_str === targetPrefix || (a.date && a.date.startsWith(targetPrefix)))).reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
  const netPayable = earnedSoFar - (isYearly ? curMonthAdvancesOnly : displayAdvances);

  const filteredAdvances = myAdvances.filter(a => {
    if (isYearly) return (a.month_str && a.month_str.startsWith(String(filterYear))) || (a.date && a.date.startsWith(String(filterYear)));
    return a.month_str === selectedMonthStr || (a.date && a.date.startsWith(selectedMonthStr));
  });

  const yearAdvances = myAdvances.filter(a => (a.month_str && a.month_str.startsWith(String(filterYear))) || (a.date && a.date.startsWith(String(filterYear))));
  const hasUpdates = yearAdvances.some(a => a.status === 'pending' || a.status === 'rejected');

  const inputStyle = { width: "100%", padding: "14px 18px", border: "1px solid var(--border2)", borderRadius: 14, background: "rgba(255,255,255,0.02)", color: "var(--text)", outline: "none", fontSize: 15, transition: "all 0.2s" };

  if (loading || !staffData) return <div style={{ padding: 60, textAlign: "center", color: "var(--gold)", fontWeight: 800 }}>Loading encrypted financial data...</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32, animation: "fadeIn 0.6s ease-out" }}>
      {/* Premium Header */}
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 20 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <h1 style={{ fontSize: 32, fontWeight: 950, color: "var(--text)", letterSpacing: -1.5 }}>My Payroll</h1>
            <Pill label={staffData?.designation || "Stylist"} color="gold" />
          </div>
          <p style={{ fontSize: 14, color: "var(--text3)", fontWeight: 600 }}>Personal financial oversight for {periodLabel(filterMode, filterYear, filterMonth)}</p>
        </div>
        
        <div style={{ display: "flex", gap: 12 }}>
          <button onClick={() => setShowAdvLog(true)} style={{ background: "rgba(34,211,238,0.05)", border: "1px solid var(--border)", color: "var(--gold)", padding: "12px 24px", borderRadius: 16, cursor: "pointer", display: "flex", alignItems: "center", gap: 10, fontSize: 13, fontWeight: 800, transition: "all .2s", position: "relative" }}>
            <Icon name="clock" size={18} /> Financial History
            {hasUpdates && <div style={{ position: "absolute", top: -4, right: -4, width: 10, height: 10, background: "var(--red)", borderRadius: "50%", border: "2px solid var(--bg1)" }} />}
          </button>
        </div>
      </header>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 20 }}>
          <PeriodWidget 
            filterMode={filterMode} setFilterMode={setFilterMode} 
            filterYear={filterYear} setFilterYear={setFilterYear} 
            filterMonth={filterMonth} setFilterMonth={setFilterMonth} 
          />
      </div>

      {/* Hero Financial Spread */}
      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr", gap: 24 }}>
        <div 
          onClick={() => setSelectedCard('balance')}
          style={{ 
            background: selectedCard === 'balance' ? "rgba(34,211,238,0.12)" : "rgba(255,255,255,0.01)", 
            padding: 40, 
            borderRadius: 32, 
            border: selectedCard === 'balance' ? "2px solid var(--accent)" : "1px solid var(--border)",
            cursor: "pointer",
            transition: "all 0.4s",
            boxShadow: selectedCard === 'balance' ? "0 20px 40px -15px rgba(34,211,238,0.25)" : "none",
            position: "relative",
            overflow: "hidden"
          }}>
          <div style={{ fontSize: 12, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 2, marginBottom: 12 }}>Available Net Payout</div>
          <div style={{ fontSize: 54, fontWeight: 950, color: "var(--accent)", letterSpacing: -2.5 }}>{INR(netPayable)}</div>
          <div style={{ fontSize: 13, color: "var(--text3)", fontWeight: 600, marginTop: 12 }}>Earned till date minus approved advances.</div>
          <div style={{ position: "absolute", top: -50, right: -50, width: 200, height: 200, background: "var(--accent)", filter: "blur(100px)", opacity: 0.1 }}></div>
        </div>

        <PremiumKPICard 
          isSelected={selectedCard === 'salary'} onClick={() => setSelectedCard('salary')}
          icon="wallet" label="Projected Salary" value={INR(displaySalary)} color="var(--blue)" 
          sub={isYearly ? `Annual total for ${filterYear}` : "Full month expectation"} 
        />
        <PremiumKPICard 
          isSelected={selectedCard === 'earned'} onClick={() => setSelectedCard('earned')}
          icon="trending" label="Earned So Far" value={INR(earnedSoFar)} color="var(--green)" 
          sub={`${daysElapsed} days of active service tracked.`} 
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 32 }}>
        {/* Advance Request Column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <Card style={{ padding: 32 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32 }}>
              <div style={{ background: "rgba(212,175,55,0.1)", padding: 12, borderRadius: 16 }}>
                <Icon name="plus" size={24} color="var(--gold)" />
              </div>
              <h3 style={{ fontSize: 20, fontWeight: 950, color: "var(--text)" }}>Request Advance</h3>
            </div>

            <form onSubmit={handleRequestAdvance} style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Disbursement Date</label>
                <input type="date" value={advanceDate} onChange={e => setAdvanceDate(e.target.value)} required style={inputStyle} />
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Amount Required (₹)</label>
                <input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" required style={inputStyle} />
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 10 }}>Purpose</label>
                <textarea rows="3" value={reason} onChange={e => setReason(e.target.value)} placeholder="Emergency, fuel, personal..." required style={{ ...inputStyle, resize: "none" }} />
              </div>
              <button 
                type="submit" 
                disabled={submitting} 
                style={{ 
                  padding: "18px", 
                  background: "linear-gradient(135deg, var(--gold), #b8860b)", 
                  color: "#000", 
                  border: "none", 
                  borderRadius: 16, 
                  fontWeight: 900, 
                  fontSize: 14,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                  cursor: "pointer", 
                  boxShadow: "0 10px 30px -10px rgba(212,175,55,0.4)",
                  marginTop: 8
                }}>
                {submitting ? "Processing Request..." : "Submit Disbursement Request"}
              </button>
            </form>
          </Card>

          <div style={{ background: "rgba(34,211,238,0.05)", border: "1px dashed rgba(34,211,238,0.3)", borderRadius: 24, padding: 24, display: "flex", gap: 16 }}>
            <Icon name="info" size={20} color="var(--accent)" />
            <div style={{ fontSize: 13, color: "var(--text2)", fontWeight: 500, lineHeight: 1.6 }}>
              All disbursements are subject to manager audit. Approved funds will automatically decrement from your net payable balance.
            </div>
          </div>
        </div>

        {/* History / Breakdown Column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {/* Payslip Download — only for past months */}
          {!isYearly && isPastMonth && (
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
              <button onClick={() => {
                const b = branches.find(x => x.id === staffData.branch_id);
                const mAdvs = myAdvances.filter(a => (a.month_str === selectedMonthStr || (a.date && a.date.startsWith(selectedMonthStr))));
                const mAdvApproved = mAdvs.filter(a => a.status === 'approved').reduce((s, a) => s + Number(a.amount), 0);
                const mAdvPend = mAdvs.filter(a => a.status === 'pending').reduce((s, a) => s + Number(a.amount), 0);
                const mNet = currentMonthSalary - mAdvApproved;
                generatePayslipPDF(staffData, b, currentMonthSalary, mAdvApproved, mAdvPend, mNet, staffData.salary || 0, selectedMonthStr, mAdvs);
              }}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", borderRadius: 10, background: "rgba(248,113,113,0.08)", color: "var(--red)", border: "none", cursor: "pointer", fontWeight: 700, fontSize: 12, transition: "all .2s" }}
                onMouseEnter={e => { e.currentTarget.style.background = "var(--red)"; e.currentTarget.style.color = "#fff"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "rgba(248,113,113,0.08)"; e.currentTarget.style.color = "var(--red)"; }}
              >
                <svg width="18" height="18" viewBox="0 0 32 32" fill="none"><path d="M7 2h12l8 8v18a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="currentColor" opacity="0.15" stroke="currentColor" strokeWidth="1.5"/><path d="M19 2v8h8" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><rect x="6" y="20" width="20" height="9" rx="1" fill="currentColor"/><text x="16" y="27" textAnchor="middle" fill="#fff" fontSize="7" fontWeight="800" fontFamily="Arial,sans-serif">PDF</text></svg>
                Download Payslip
              </button>
            </div>
          )}

          <Card style={{ padding: 0 }}>
             <div style={{ padding: "24px 32px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h3 style={{ fontSize: 16, fontWeight: 950, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1.5 }}>
                  {isYearly ? "Annual Performance Breakdown" : "Transaction History"}
                </h3>
                <ToggleGroup 
                  options={[["all", "All"], ["advance", "Advances"], ["salary", "Payroll"]]} 
                  value={categoryFilter} 
                  onChange={setCategoryFilter} 
                />
             </div>

             <div style={{ overflowX: "auto" }}>
               {isYearly ? (
                 <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
                    <thead>
                      <tr>
                        <TH>Month Period</TH>
                        <TH right>Base Salary</TH>
                        <TH right>Net Advance</TH>
                        <TH right>Settlement</TH>
                        <TH right>Payslip</TH>
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from({ length: factor }, (_, i) => i + 1).map(m => {
                        const mPrefix = `${filterYear}-${String(m).padStart(2, '0')}`;
                        const mSal = proRataSalary(staffData, mPrefix, branches, salaryHistory, [staffData], globalSettings);
                        const mAdv = myAdvances.filter(a => a.status === 'approved' && (a.month_str === mPrefix || (a.date && a.date.startsWith(mPrefix)))).reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
                        const mNet = mSal - mAdv;
                        const mName = new Date(filterYear, m - 1).toLocaleString('default', { month: 'long' });
                        return (
                          <tr key={m} onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.01)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                            <TD style={{ fontWeight: 800, color: "var(--text)" }}>{mName}</TD>
                            <TD right style={{ fontWeight: 600 }}>{INR(mSal)}</TD>
                            <TD right style={{ color: "var(--red)", fontWeight: 700 }}>{INR(mAdv)}</TD>
                            <TD right style={{ fontWeight: 950, color: mNet >= 0 ? "var(--accent)" : "var(--red)", fontSize: 15 }}>{INR(mNet)}</TD>
                            <TD right>
                              {(filterYear < now.getFullYear() || (filterYear === now.getFullYear() && m < now.getMonth() + 1)) ? (
                                <button onClick={() => {
                                  const b = branches.find(x => x.id === staffData.branch_id);
                                  const mAdvs = myAdvances.filter(a => (a.month_str === mPrefix || (a.date && a.date.startsWith(mPrefix))));
                                  const mAdvPending = mAdvs.filter(a => a.status === 'pending').reduce((s, a) => s + Number(a.amount), 0);
                                  generatePayslipPDF(staffData, b, mSal, mAdv, mAdvPending, mNet, staffData.salary || 0, mPrefix, mAdvs);
                                }}
                                  style={{ padding: 0, background: "none", border: "none", cursor: "pointer", opacity: 0.85, display: "inline-flex" }}
                                  onMouseEnter={e => e.currentTarget.style.opacity = "1"}
                                  onMouseLeave={e => e.currentTarget.style.opacity = "0.85"}
                                  title={`Download payslip for ${mName}`}
                                >
                                  <svg width="24" height="24" viewBox="0 0 32 32" fill="none"><path d="M7 2h12l8 8v18a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="#fff" stroke="#e53e3e" strokeWidth="1.5"/><path d="M19 2v8h8" fill="#ffeaea" stroke="#e53e3e" strokeWidth="1.5" strokeLinejoin="round"/><rect x="6" y="20" width="20" height="9" rx="1" fill="#e53e3e"/><text x="16" y="27" textAnchor="middle" fill="#fff" fontSize="7" fontWeight="800" fontFamily="Arial,sans-serif">PDF</text></svg>
                                </button>
                              ) : (
                                <span style={{ fontSize: 10, color: "var(--text3)", opacity: 0.4 }}>—</span>
                              )}
                            </TD>
                          </tr>
                        );
                      })}
                    </tbody>
                 </table>
               ) : (
                 <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
                    <thead>
                      <tr><TH>Activity Date</TH><TH right>Amount</TH><TH>Description</TH><TH right>Status</TH></tr>
                    </thead>
                    <tbody>
                      {filteredAdvances.length === 0 ? (
                        <tr><td colSpan={4} style={{ padding: 60, textAlign: "center", color: "var(--text3)", fontStyle: "italic" }}>No financial activity logged for this period.</td></tr>
                      ) : filteredAdvances.map(a => (
                        <tr key={a.id} onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.01)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <TD style={{ color: "var(--text3)", fontWeight: 700 }}>{a.date || "—"}</TD>
                          <TD right style={{ fontWeight: 950, color: "var(--gold)", fontSize: 15 }}>{INR(a.amount)}</TD>
                          <TD style={{ color: "var(--text2)", fontSize: 13 }}>{a.reason}</TD>
                          <TD right>
                            <Pill label={a.status} color={a.status === 'approved' ? 'green' : 'gold'} />
                          </TD>
                        </tr>
                      ))}
                    </tbody>
                 </table>
               )}
             </div>
          </Card>
        </div>
      </div>

      <Modal isOpen={showAdvLog} title="Historical Salary Disclosures" onClose={() => setShowAdvLog(false)}>
         <div style={{ maxHeight: '60vh', overflowY: "auto" }}>
            <table style={{ width: "100%" }}>
              <thead>
                <tr><TH>Date</TH><TH right>Amount</TH><TH>Audit Status</TH></tr>
              </thead>
              <tbody>
                {yearAdvances.map(a => (
                  <tr key={a.id}>
                    <TD style={{ fontWeight: 700 }}>{a.date || "—"}</TD>
                    <TD right style={{ color: "var(--gold)", fontWeight: 900 }}>{INR(a.amount)}</TD>
                    <TD><Pill label={a.status} color={a.status === 'approved' ? 'green' : 'orange'} /></TD>
                  </tr>
                ))}
              </tbody>
            </table>
         </div>
      </Modal>

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
      {ConfirmDialog}
    </div>
  );
}
