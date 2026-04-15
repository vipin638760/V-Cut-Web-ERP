"use client";
import { useEffect, useState, Fragment } from "react";
import { collection, onSnapshot, doc, setDoc, addDoc, query, orderBy } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser, getCurrentUser } from "@/lib/currentUser";
import { INR, proRataSalary, makeFilterPrefix, staffStatusForMonth, staffLeavesInMonth } from "@/lib/calculations";
import { Card, Pill, TH, TD, PeriodWidget, Modal, Icon, useConfirm, useToast } from "@/components/ui";
import VLoader from "@/components/VLoader";


function generatePayslipPDF(employee, branch, earned, advApproved, advPending, net, baseSalary, period, periodAdvances, { daysWorked, leavesTaken, payMode: overrideMode, payDate: overrideDate } = {}) {
  const fmt = (v) => Math.round(v || 0).toLocaleString('en-IN');
  const payMode = overrideMode || employee.pay_mode || "Bank Transfer";
  const payDate = overrideDate ? new Date(overrideDate).toLocaleDateString('en-IN') : new Date().toLocaleDateString('en-IN');
  const advRows = (periodAdvances || []).map(a => {
    const sc = a.status === 'approved' ? '#16a34a' : a.status === 'rejected' ? '#dc2626' : '#ea580c';
    return `<tr><td>${a.date||'—'}</td><td>&#8377;${fmt(a.amount)}</td><td>${a.mode||'Cash'}</td><td>${a.reason||'—'}</td><td><span style="color:${sc};font-weight:700;font-size:11px;padding:3px 8px;background:${sc}12;border-radius:4px;">${(a.status||'pending').toUpperCase()}</span></td></tr>`;
  }).join('');

  // Convert signature image to base64, auto-crop whitespace
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    // Auto-crop whitespace, then darken the signature ink
    const imgData = ctx.getImageData(0, 0, c.width, c.height);
    const d = imgData.data;
    let top = c.height, left = c.width, bottom = 0, right = 0;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (d[i] < 210 || d[i+1] < 210 || d[i+2] < 210) {
          if (y < top) top = y;
          if (y > bottom) bottom = y;
          if (x < left) left = x;
          if (x > right) right = x;
        }
      }
    }
    const pad = 16;
    top = Math.max(0, top - pad);
    left = Math.max(0, left - pad);
    bottom = Math.min(c.height, bottom + pad);
    right = Math.min(c.width, right + pad);
    const cw = right - left, ch = bottom - top;
    const cropped = document.createElement('canvas');
    cropped.width = cw;
    cropped.height = ch;
    const cCtx = cropped.getContext('2d');
    cCtx.drawImage(c, left, top, cw, ch, 0, 0, cw, ch);
    // Darken ink: boost contrast on non-white pixels
    const cd = cCtx.getImageData(0, 0, cw, ch);
    for (let i = 0; i < cd.data.length; i += 4) {
      const r = cd.data[i], g = cd.data[i+1], b = cd.data[i+2];
      if (r < 210 || g < 210 || b < 210) {
        cd.data[i]   = Math.max(0, Math.round(r * 0.18));
        cd.data[i+1] = Math.max(0, Math.round(g * 0.18));
        cd.data[i+2] = Math.max(0, Math.round(b * 0.35));
        cd.data[i+3] = 255;
      }
    }
    cCtx.putImageData(cd, 0, 0);
    openPayslipWindow(cropped.toDataURL('image/png'));
  };
  img.onerror = () => openPayslipWindow('');
  img.src = '/signature-scan.png';

  function openPayslipWindow(sigDataUri) {
  const w = window.open('', '_blank', 'width=800,height=900');
  if (!w) return alert("Please allow popups for payslip generation.");
  const sigImg = sigDataUri ? `<img src="${sigDataUri}" style="height:70px;max-width:220px;margin-bottom:2px;object-fit:contain"/>` : '';
  const html = `<!DOCTYPE html><html><head><title>Payslip - ${employee.name} - ${period}</title>
<link href="https://fonts.googleapis.com/css2?family=Great+Vibes&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}@page{size:A4;margin:16mm}body{font-family:'Segoe UI',system-ui,sans-serif;background:#fff;color:#1a1a1a;padding:36px;max-width:800px;margin:0 auto;font-size:13px}.watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-20deg);font-size:100px;font-weight:900;color:rgba(0,0,0,.018);pointer-events:none;white-space:nowrap;font-style:italic;letter-spacing:10px}.header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px;padding-bottom:20px;border-bottom:2px solid #065f46}.brand{display:flex;align-items:baseline;gap:0}.brand-v{color:#f06464;font-size:48px;font-weight:400;font-family:'Great Vibes',cursive;text-shadow:0 0 10px rgba(240,100,100,0.4)}.brand-cut{color:#1a1a1a;font-size:38px;font-weight:400;font-family:'Great Vibes',cursive}.brand-salon{font-size:13px;font-weight:800;letter-spacing:5px;background:linear-gradient(90deg,#b8860b,#daa520);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-left:8px;font-family:'Segoe UI',system-ui,sans-serif}.doc-title{text-align:right}.doc-title h2{font-size:20px;font-weight:700;letter-spacing:1px;text-transform:uppercase}.doc-title p{font-size:11px;color:#888;margin-top:3px}.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:28px}.info-box{background:#f7f9fa;padding:16px 18px;border-radius:8px}.info-box h4{font-size:8px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px}.info-row{display:flex;justify-content:space-between;padding:4px 0;font-size:12px}.info-row .label{color:#777}.info-row .value{font-weight:700}.section{margin-bottom:28px}.section-title{font-size:10px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:2.5px;margin-bottom:12px;display:flex;align-items:center;gap:8px}.section-title::before{content:'';display:inline-block;width:3px;height:14px;background:#0891b2;border-radius:2px}table{width:100%;border-collapse:collapse}th{background:#f2f4f5;color:#555;padding:10px 14px;text-align:left;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;border-bottom:1px solid #e5e5e5}th:nth-child(2),td:nth-child(2){text-align:right}td{padding:11px 14px;border-bottom:1px solid #f0f0f0;font-size:12px}.earning{color:#16a34a;font-weight:700}.deduction{color:#dc2626;font-weight:700}.total-row td{border-top:2px solid #065f46;border-bottom:none;font-weight:800;padding-top:14px;font-size:14px;color:#065f46}.net-box{background:linear-gradient(135deg,#064e3b,#065f46);color:#fff;padding:22px 28px;border-radius:10px;display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}.net-box .lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#a7f3d0}.net-box .sub{font-size:11px;color:#6ee7b7;margin-top:3px}.net-box .amt{font-size:28px;font-weight:800;color:#ecfdf5;font-family:'Courier New',monospace}.pay-badge{display:inline-flex;align-items:center;gap:6px;background:#f0fdf4;border:1px solid #bbf7d0;color:#16a34a;padding:4px 10px;border-radius:6px;font-size:10px;font-weight:700;text-transform:uppercase}.footer{text-align:center;padding-top:24px;border-top:1px solid #eee;color:#bbb;font-size:9px;letter-spacing:1px;margin-top:16px}.sig-grid{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:32px;align-items:end}.sig-box{display:flex;flex-direction:column;align-items:center;justify-content:flex-end}.sig-line{text-align:center;border-top:1px solid #ccc;padding-top:8px;font-size:10px;color:#999;width:100%}@media print{body{padding:0}.no-print{display:none!important}}</style></head><body>
<div class="watermark">V-Cut Salon</div>
<div class="header"><div><div class="brand"><span class="brand-v">V</span><span class="brand-cut">-Cut</span><span class="brand-salon">SALON</span></div><p style="font-size:10px;color:#aaa;margin-top:3px;letter-spacing:1px">Salon Management System</p></div><div class="doc-title"><h2>Pay Slip</h2><p>Period: ${period}</p><p>Pay Date: ${payDate}</p></div></div>
<div class="info-grid"><div class="info-box"><h4>Employee Details</h4><div class="info-row"><span class="label">Name</span><span class="value">${employee.name}</span></div><div class="info-row"><span class="label">ID</span><span class="value">${employee.id}</span></div><div class="info-row"><span class="label">Role</span><span class="value">${employee.designation||employee.role||'—'}</span></div><div class="info-row"><span class="label">Joining Date</span><span class="value">${employee.join ? new Date(employee.join).toLocaleDateString('en-IN') : (employee.joined||employee.join_date||'—')}</span></div></div><div class="info-box"><h4>Attendance &amp; Payment</h4><div class="info-row"><span class="label">Days Worked</span><span class="value">${daysWorked ?? '—'}</span></div><div class="info-row"><span class="label">Leaves Taken</span><span class="value">${leavesTaken ?? 0}</span></div><div class="info-row"><span class="label">Branch</span><span class="value">${branch?.name||'—'}</span></div><div class="info-row"><span class="label">Pay Period</span><span class="value">${period}</span></div><div class="info-row"><span class="label">Payment Mode</span><span class="value"><span class="pay-badge">${payMode}</span></span></div></div></div>
<div class="section"><div class="section-title">Salary Disbursement</div><table><thead><tr><th>Description</th><th>Amount</th><th>Mode</th></tr></thead><tbody><tr><td>Base Salary</td><td class="earning">&#8377;${fmt(baseSalary)}</td><td style="font-size:11px;color:#888">—</td></tr><tr><td>Earned Salary (Pro-rata)</td><td class="earning">&#8377;${fmt(earned)}</td><td><span class="pay-badge">${payMode}</span></td></tr>${advApproved>0?`<tr><td>Less: Advance Deduction</td><td class="deduction">-&#8377;${fmt(advApproved)}</td><td style="font-size:11px;color:#888">Auto-deducted</td></tr>`:''}<tr class="total-row"><td>Net Payable</td><td>&#8377;${fmt(net)}</td><td></td></tr></tbody></table></div>
<div class="net-box"><div><div class="lbl">Net Pay</div><div class="sub">Disbursed via ${payMode}</div></div><div class="amt">&#8377;${fmt(net)}</div></div>
<div class="section"><div class="section-title">Advance Requests</div>${(periodAdvances||[]).length>0?`<table><thead><tr><th>Date</th><th>Amount</th><th>Mode</th><th>Reason</th><th>Status</th></tr></thead><tbody>${advRows}</tbody></table><div style="margin-top:12px;display:flex;gap:24px;font-size:11px"><div><span style="color:#888">Approved:</span> <strong style="color:#16a34a">&#8377;${fmt(advApproved)}</strong></div><div><span style="color:#888">Pending:</span> <strong style="color:#ea580c">&#8377;${fmt(advPending)}</strong></div></div>`:'<p style="color:#aaa;font-size:12px;padding:16px 0">No advance requests for this period.</p>'}</div>
<div class="sig-grid"><div class="sig-box"><div style="height:70px"></div><div class="sig-line">Employee Signature</div></div><div class="sig-box">${sigImg}<div class="sig-line">CEO &amp; MD &mdash; Shweta Tiwari</div></div></div>
<div class="footer"><p>System-generated payslip &mdash; V-Cut Salon</p></div>
<div class="no-print" style="text-align:center;margin-top:20px"><button onclick="window.print()" style="padding:12px 32px;background:#065f46;color:#fff;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px">Print / Save as PDF</button></div>
</body></html>`;
  w.document.write(html);
  w.document.close();
  }
}

export default function PayrollTab() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [branches, setBranches] = useState([]);
  const [staff, setStaff] = useState([]);
  const [advances, setAdvances] = useState([]);
  const [leaves, setLeaves] = useState([]);
  const [salHistory, setSalHistory] = useState([]);
  const [payrollReleases, setPayrollReleases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedStaff, setExpandedStaff] = useState(null);
  const [viewTab, setViewTab] = useState("salary");
  const [releaseModal, setReleaseModal] = useState(null); // { staffId, name, net, earned, ... }
  const [releaseMode, setReleaseMode] = useState("Bank Transfer");
  const [releaseDate, setReleaseDate] = useState(new Date().toISOString().split("T")[0]);
  const [advModal, setAdvModal] = useState(null); // { request, status }
  const [advMode, setAdvMode] = useState("Cash");
  const [advDate, setAdvDate] = useState(new Date().toISOString().split("T")[0]);

  const [filterMode, setFilterMode] = useState("month");
  const [filterYear, setFilterYear] = useState(new Date().getFullYear());
  const [filterMonth, setFilterMonth] = useState(new Date().getMonth() + 1);
  const filterPrefix = filterMode === "month" ? makeFilterPrefix(filterYear, filterMonth) : String(filterYear);

  const currentUser = useCurrentUser() || {};
  const isAdmin = currentUser.role === "admin";
  const isAccountant = currentUser.role === "accountant";

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "staff"), sn => setStaff(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "salary_history"), sn => setSalHistory(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "leaves"), sn => setLeaves(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "payroll_releases"), sn => setPayrollReleases(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(query(collection(db, "staff_advances"), orderBy("date", "desc")), sn => {
        setAdvances(sn.docs.map(d => ({ ...d.data(), id: d.id })));
        setLoading(false);
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  const openAdvanceApproval = (request, status) => {
    if (status === 'rejected') {
      confirm({
        title: "Reject Advance",
        message: `<strong>${request.staff_name}</strong>, are you sure you want to reject the advance of <strong>₹${Number(request.amount).toLocaleString('en-IN')}</strong>?`,
        confirmText: "Yes, Reject",
        cancelText: "No, Keep",
        type: "danger",
        onConfirm: () => processAdvance(request, 'rejected', null, null),
      });
      return;
    } else {
      setAdvModal({ request, status });
      setAdvMode(request.mode || "Cash");
      setAdvDate(new Date().toISOString().split("T")[0]);
    }
  };

  const processAdvance = async (request, newStatus, mode, paymentDate) => {
    try {
      const user = getCurrentUser() || {};
      const update = { status: newStatus, processed_at: new Date().toISOString(), processed_by: user.id || "admin" };
      if (mode) update.mode = mode;
      if (paymentDate) update.payment_date = paymentDate;
      await setDoc(doc(db, "staff_advances", request.id), update, { merge: true });
      if (newStatus === "approved") {
        const s = staff.find(x => x.id === request.staff_id);
        if (s?.branch_id) {
          await addDoc(collection(db, "fixed_expenses"), { branch_id: s.branch_id, type: "Staff Advance", amount: Number(request.amount), date: request.date || new Date().toISOString().split("T")[0], note: `Advance for ${s.name} — ${mode} (${request.month_str || filterPrefix})`, by: user.id || "admin", at: new Date().toISOString() });
        }
      }
      setAdvModal(null);
      toast({ title: newStatus === 'approved' ? "Advance Approved" : "Advance Rejected", message: `${request.staff_name}'s advance of ₹${Number(request.amount).toLocaleString('en-IN')} has been ${newStatus}.`, type: newStatus === 'approved' ? "success" : "warning" });
    } catch (e) { confirm({ title: "Error", message: e.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} }); }
  };

  const handleReleaseSalary = async () => {
    if (!releaseModal) return;
    try {
      const user = getCurrentUser() || {};
      const releaseKey = `${releaseModal.staffId}_${filterPrefix}`;
      await setDoc(doc(db, "payroll_releases", releaseKey), {
        staff_id: releaseModal.staffId,
        staff_name: releaseModal.name,
        period: filterPrefix,
        net: releaseModal.net,
        earned: releaseModal.earned,
        base_salary: releaseModal.baseSalary,
        mode: releaseMode,
        payment_date: releaseDate,
        released_by: user.id || "admin",
        released_at: new Date().toISOString(),
      });
      // Generate payslip after release
      generatePayslipPDF(
        releaseModal.employee, releaseModal.branch,
        releaseModal.earned, releaseModal.advApproved, releaseModal.advPending,
        releaseModal.net, releaseModal.baseSalary, filterPrefix, releaseModal.periodAdvances,
        { daysWorked: releaseModal.daysWorked, leavesTaken: releaseModal.leavesTaken, payMode: releaseMode, payDate: releaseDate }
      );
      toast({ title: "Salary Released", message: `${releaseModal.name}'s salary of ${INR(releaseModal.net)} released via ${releaseMode}.`, type: "success" });
      setReleaseModal(null);
    } catch (e) { confirm({ title: "Error", message: e.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} }); }
  };

  const getRelease = (staffId) => payrollReleases.find(r => r.staff_id === staffId && r.period === filterPrefix);

  if (loading) return <VLoader fullscreen label="Loading" />;

  const getStaffAdvances = (staffId) => advances.filter(a => {
    if (a.staff_id !== staffId) return false;
    if (filterMode === 'year') return (a.month_str?.startsWith(String(filterYear))) || (a.date?.startsWith(String(filterYear)));
    return (a.month_str === filterPrefix) || (a.date?.startsWith(filterPrefix));
  });

  const TS = { padding: "7px 16px", borderRadius: 8, fontSize: 11, fontWeight: 700, border: "none", cursor: "pointer", transition: "all .2s", textTransform: "uppercase", letterSpacing: 0.5 };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
        <h2 style={{ fontSize: 28, fontWeight: 800, color: "var(--text)", letterSpacing: -0.5, margin: 0, fontFamily: "var(--font-headline, var(--font-outfit))" }}>Payroll Management</h2>
        <div style={{ display: "flex", gap: 3, background: "var(--bg4)", padding: 3, borderRadius: 10 }}>
          <button onClick={() => setViewTab("salary")} style={{ ...TS, background: viewTab === "salary" ? "linear-gradient(135deg, var(--accent), var(--gold2))" : "transparent", color: viewTab === "salary" ? "#000" : "var(--text3)" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><Icon name="wallet" size={13} /> Salary</span>
          </button>
          <button onClick={() => setViewTab("advances")} style={{ ...TS, background: viewTab === "advances" ? "linear-gradient(135deg, var(--accent), var(--gold2))" : "transparent", color: viewTab === "advances" ? "#000" : "var(--text3)" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><Icon name="log" size={13} /> Advances</span>
          </button>
        </div>
      </div>

      <PeriodWidget filterMode={filterMode} setFilterMode={setFilterMode} filterYear={filterYear} setFilterYear={setFilterYear} filterMonth={filterMonth} setFilterMonth={setFilterMonth} />

      {/* Salary View */}
      {viewTab === "salary" && <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
          <thead>
            <tr>
              <TH>Employee</TH>
              <TH>Branch</TH>
              {!isAccountant && <TH right>Base Salary</TH>}
              <TH right>Earned</TH>
              <TH right>Adv Taken</TH>
              <TH right>Adv Pending</TH>
              <TH right>Net Pay</TH>
              <TH right>Advance Log</TH>
              <TH right>Release</TH>
            </tr>
          </thead>
          <tbody>
            {staff.filter(s => {
              if (filterMode === 'month') {
                const ms = staffStatusForMonth(s, filterPrefix);
                return ms.status !== 'inactive';
              }
              return s.status !== 'inactive';
            }).sort((a,b) => a.name.localeCompare(b.name)).map(s => {
              const b = branches.find(x => x.id === s.branch_id);
              let earned = 0;
              if (filterMode === 'year') {
                const limit = (filterYear === new Date().getFullYear()) ? new Date().getMonth() + 1 : 12;
                for (let m = 1; m <= limit; m++) earned += proRataSalary(s, `${filterYear}-${String(m).padStart(2,'0')}`, branches, salHistory, staff);
              } else {
                earned = proRataSalary(s, filterPrefix, branches, salHistory, staff);
              }

              const periodAdvances = getStaffAdvances(s.id);
              const advApproved = periodAdvances.filter(a => a.status === 'approved').reduce((sum, a) => sum + Number(a.amount), 0);
              const advPending = periodAdvances.filter(a => a.status === 'pending').reduce((sum, a) => sum + Number(a.amount), 0);
              const net = earned - advApproved;
              const isExpanded = expandedStaff === s.id;
              const hasAdvances = periodAdvances.length > 0;
              const monthStatus = staffStatusForMonth(s, filterPrefix);
              const leavesTaken = staffLeavesInMonth(s.id, filterPrefix, leaves);

              // Payslip only available for completed (past) months
              const now = new Date();
              const currentYM = now.getFullYear() * 12 + now.getMonth(); // 0-based month
              const selectedYM = filterYear * 12 + (filterMonth - 1);
              const isCompletedMonth = filterMode === 'month' && selectedYM < currentYM;

              return (
                <Fragment key={s.id}>
                  <tr style={{ transition: "background 0.15s" }}
                    onMouseEnter={e => e.currentTarget.style.background = "var(--bg4)"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <TD style={{ fontWeight: 700 }}>{s.name}</TD>
                    <TD style={{ color: "var(--text3)", fontSize: 11 }}>{b?.name?.replace("V-CUT ","") || "—"}</TD>
                    {!isAccountant && <TD right style={{ color: "var(--text3)" }}>{INR(s.salary)}</TD>}
                    <TD right style={{ fontWeight: 600, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(earned)}</TD>
                    <TD right style={{ color: advApproved > 0 ? "var(--red)" : "var(--text3)", fontWeight: 700 }}>{advApproved > 0 ? `-${INR(advApproved)}` : "—"}</TD>
                    <TD right style={{ color: advPending > 0 ? "var(--orange)" : "var(--text3)", fontWeight: 700 }}>{advPending > 0 ? INR(advPending) : "—"}</TD>
                    <TD right style={{ fontSize: 14, fontWeight: 800, color: net < 0 ? "var(--red)" : "var(--accent)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(net)}</TD>
                    <TD right>
                      <button onClick={() => hasAdvances && setExpandedStaff(isExpanded ? null : s.id)}
                        style={{ padding: "4px 10px", borderRadius: 6, background: isExpanded ? "var(--accent)" : "var(--bg4)", color: isExpanded ? "#000" : hasAdvances ? "var(--accent)" : "var(--text3)", border: "none", cursor: hasAdvances ? "pointer" : "default", fontSize: 10, fontWeight: 700, transition: "all .2s", display: "inline-flex", alignItems: "center", gap: 5, minWidth: 52, justifyContent: "center" }}>
                        <Icon name="log" size={12} />
                        {periodAdvances.length}
                      </button>
                    </TD>
                    <TD right>
                      {(() => {
                        const rel = getRelease(s.id);
                        if (rel) {
                          // Already released — show PDF download + released badge
                          return (
                            <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>
                              <button onClick={() => generatePayslipPDF(s, b, earned, advApproved, advPending, net, s.salary || 0, filterPrefix, periodAdvances, { daysWorked: monthStatus.daysWorked, leavesTaken, payMode: rel.mode, payDate: rel.payment_date })}
                                title={`Payslip — ${rel.mode} on ${rel.payment_date}`}
                                style={{ padding: 0, background: "none", border: "none", cursor: "pointer", opacity: 0.85, display: "inline-flex" }}
                                onMouseEnter={e => e.currentTarget.style.opacity = "1"}
                                onMouseLeave={e => e.currentTarget.style.opacity = "0.85"}>
                                <svg width="22" height="22" viewBox="0 0 32 32" fill="none"><path d="M7 2h12l8 8v18a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="#fff" stroke="#e53e3e" strokeWidth="1.5"/><path d="M19 2v8h8" fill="#ffeaea" stroke="#e53e3e" strokeWidth="1.5" strokeLinejoin="round"/><rect x="6" y="20" width="20" height="9" rx="1" fill="#e53e3e"/><text x="16" y="27" textAnchor="middle" fill="#fff" fontSize="7" fontWeight="800" fontFamily="Arial,sans-serif">PDF</text></svg>
                              </button>
                              <Pill label="Paid" color="green" />
                            </div>
                          );
                        }
                        if (!isCompletedMonth) {
                          return <span title={filterMode === 'year' ? "Switch to month view" : "Month not completed"} style={{ opacity: 0.25, display: "inline-flex", cursor: "not-allowed", fontSize: 10, color: "var(--text3)" }}>—</span>;
                        }
                        // Not released yet — show Release button
                        return (
                          <button onClick={() => { setReleaseModal({ staffId: s.id, name: s.name, net, earned, baseSalary: s.salary || 0, employee: s, branch: b, advApproved, advPending, periodAdvances, daysWorked: monthStatus.daysWorked, leavesTaken }); setReleaseMode(s.pay_mode || "Bank Transfer"); setReleaseDate(new Date().toISOString().split("T")[0]); }}
                            style={{ padding: "5px 12px", borderRadius: 8, background: "linear-gradient(135deg, var(--accent), var(--gold2))", color: "#000", border: "none", cursor: "pointer", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
                            Release
                          </button>
                        );
                      })()}
                    </TD>
                  </tr>
                  {/* Expanded advance log for this employee */}
                  {isExpanded && periodAdvances.length > 0 && (
                    <tr>
                      <td colSpan={isAccountant ? 8 : 9} style={{ padding: 0, background: "var(--bg4)" }}>
                        <div style={{ padding: "12px 20px 16px" }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 10 }}>Advance Log — {s.name}</div>
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                            <thead>
                              <tr style={{ background: "var(--bg5)" }}>
                                <th style={{ padding: "8px 12px", textAlign: "left", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Date</th>
                                <th style={{ padding: "8px 12px", textAlign: "right", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Amount</th>
                                <th style={{ padding: "8px 12px", textAlign: "left", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Mode</th>
                                <th style={{ padding: "8px 12px", textAlign: "left", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Reason</th>
                                <th style={{ padding: "8px 12px", textAlign: "left", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Status</th>
                                {isAdmin && <th style={{ padding: "8px 12px", textAlign: "right", fontSize: 9, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Actions</th>}
                              </tr>
                            </thead>
                            <tbody>
                              {periodAdvances.map(a => (
                                <tr key={a.id}>
                                  <td style={{ padding: "8px 12px", color: "var(--text3)" }}>{a.date || "—"}</td>
                                  <td style={{ padding: "8px 12px", textAlign: "right", fontWeight: 700, color: "var(--accent)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(a.amount)}</td>
                                  <td style={{ padding: "8px 12px", color: "var(--text3)" }}>{a.mode || "Cash"}</td>
                                  <td style={{ padding: "8px 12px", color: "var(--text3)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.reason || "—"}</td>
                                  <td style={{ padding: "8px 12px" }}><Pill label={a.status || "pending"} color={a.status === "approved" ? "green" : a.status === "rejected" ? "red" : "orange"} /></td>
                                  {isAdmin && (
                                    <td style={{ padding: "8px 12px", textAlign: "right" }}>
                                      {a.status === "pending" ? (
                                        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                                          <button onClick={() => openAdvanceApproval(a, 'approved')} style={{ background: "rgba(74,222,128,0.08)", color: "var(--green)", border: "none", padding: "4px 8px", borderRadius: 6, fontSize: 9, fontWeight: 700, cursor: "pointer" }}>Approve</button>
                                          <button onClick={() => openAdvanceApproval(a, 'rejected')} style={{ background: "rgba(248,113,113,0.08)", color: "var(--red)", border: "none", padding: "4px 8px", borderRadius: 6, fontSize: 9, fontWeight: 700, cursor: "pointer" }}>Reject</button>
                                        </div>
                                      ) : <span style={{ fontSize: 10, color: "var(--text3)" }}>—</span>}
                                    </td>
                                  )}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        </div>
      </Card>}

      {/* Advances View */}
      {viewTab === "advances" && <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
          <thead>
            <tr>
              <TH>Employee</TH>
              <TH>Branch</TH>
              <TH>Request Date</TH>
              <TH right>Amount</TH>
              <TH>Mode</TH>
              <TH>Reason</TH>
              <TH>Status</TH>
              <TH>Processed On</TH>
              {isAdmin && <TH right>Actions</TH>}
            </tr>
          </thead>
          <tbody>
            {advances.filter(a => {
              if (filterMode === 'year') return (a.month_str?.startsWith(String(filterYear))) || (a.date?.startsWith(String(filterYear)));
              return (a.month_str === filterPrefix) || (a.date?.startsWith(filterPrefix));
            }).map(a => {
              const s = staff.find(x => x.id === a.staff_id);
              const b = branches.find(x => x.id === s?.branch_id);
              return (
                <tr key={a.id} style={{ transition: "background 0.15s" }}
                  onMouseEnter={e => e.currentTarget.style.background = "var(--bg4)"}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <TD style={{ fontWeight: 700 }}>{a.staff_name || s?.name || "—"}</TD>
                  <TD style={{ color: "var(--text3)", fontSize: 11 }}>{b?.name?.replace("V-CUT ", "") || "—"}</TD>
                  <TD style={{ color: "var(--text3)" }}>{a.date || "—"}</TD>
                  <TD right style={{ fontWeight: 700, color: "var(--accent)", fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(a.amount)}</TD>
                  <TD style={{ color: "var(--text3)" }}>{a.mode || "Cash"}</TD>
                  <TD style={{ color: "var(--text3)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.reason || "—"}</TD>
                  <TD><Pill label={a.status || "pending"} color={a.status === "approved" ? "green" : a.status === "rejected" ? "red" : "orange"} /></TD>
                  <TD style={{ color: "var(--text3)", fontSize: 11 }}>{a.payment_date || (a.processed_at ? a.processed_at.split("T")[0] : "—")}</TD>
                  {isAdmin && (
                    <TD right>
                      {a.status === "pending" ? (
                        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                          <button onClick={() => openAdvanceApproval(a, 'approved')} style={{ background: "rgba(74,222,128,0.08)", color: "var(--green)", border: "none", padding: "5px 10px", borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>Approve</button>
                          <button onClick={() => openAdvanceApproval(a, 'rejected')} style={{ background: "rgba(248,113,113,0.08)", color: "var(--red)", border: "none", padding: "5px 10px", borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>Reject</button>
                        </div>
                      ) : <span style={{ fontSize: 10, color: "var(--text3)" }}>—</span>}
                    </TD>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </Card>}

      {/* Advance Approval Modal — ask payment mode */}
      <Modal isOpen={!!advModal} onClose={() => setAdvModal(null)} title="Approve Advance">
        {advModal && (
          <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ fontSize: 14, color: "var(--text)" }}>
              Approve <strong>{INR(advModal.request.amount)}</strong> advance for <strong>{advModal.request.staff_name}</strong>?
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "block" }}>Payment Mode</label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {["Cash", "Bank Transfer", "UPI", "Cheque"].map(m => (
                  <button key={m} onClick={() => setAdvMode(m)}
                    style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid", borderColor: advMode === m ? "var(--accent)" : "var(--border)", background: advMode === m ? "rgba(0,255,255,0.08)" : "var(--bg4)", color: advMode === m ? "var(--accent)" : "var(--text3)", fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all .2s" }}>
                    {m}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "block" }}>Payment Date</label>
              <input type="date" value={advDate} onChange={e => setAdvDate(e.target.value)}
                style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg4)", color: "var(--text)", fontSize: 13, fontWeight: 600, outline: "none", width: "100%" }} />
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              <button onClick={() => processAdvance(advModal.request, 'approved', advMode, advDate)}
                style={{ flex: 1, padding: "12px 0", borderRadius: 10, background: "linear-gradient(135deg, var(--green), #16a34a)", color: "#fff", border: "none", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                Approve
              </button>
              <button onClick={() => setAdvModal(null)}
                style={{ padding: "12px 20px", borderRadius: 10, background: "var(--bg4)", color: "var(--text3)", border: "none", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Salary Release Modal — ask mode + date */}
      <Modal isOpen={!!releaseModal} onClose={() => setReleaseModal(null)} title="Release Salary">
        {releaseModal && (
          <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ background: "var(--bg4)", padding: 16, borderRadius: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>Summary</div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 13 }}>
                <span style={{ color: "var(--text3)" }}>Employee</span>
                <strong>{releaseModal.name}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 13 }}>
                <span style={{ color: "var(--text3)" }}>Period</span>
                <strong>{filterPrefix}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 13 }}>
                <span style={{ color: "var(--text3)" }}>Net Payable</span>
                <strong style={{ color: "var(--accent)", fontSize: 16, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{INR(releaseModal.net)}</strong>
              </div>
            </div>

            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "block" }}>Payment Mode</label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {["Bank Transfer", "Cash", "UPI", "Cheque"].map(m => (
                  <button key={m} onClick={() => setReleaseMode(m)}
                    style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid", borderColor: releaseMode === m ? "var(--accent)" : "var(--border)", background: releaseMode === m ? "rgba(0,255,255,0.08)" : "var(--bg4)", color: releaseMode === m ? "var(--accent)" : "var(--text3)", fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all .2s" }}>
                    {m}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "block" }}>Payment Date</label>
              <input type="date" value={releaseDate} onChange={e => setReleaseDate(e.target.value)}
                style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg4)", color: "var(--text)", fontSize: 13, fontWeight: 600, outline: "none", width: "100%" }} />
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
              <button onClick={handleReleaseSalary}
                style={{ flex: 1, padding: "12px 0", borderRadius: 10, background: "linear-gradient(135deg, var(--accent), var(--gold2))", color: "#000", border: "none", fontWeight: 700, fontSize: 13, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
                Release &amp; Generate Payslip
              </button>
              <button onClick={() => setReleaseModal(null)}
                style={{ padding: "12px 20px", borderRadius: 10, background: "var(--bg4)", color: "var(--text3)", border: "none", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </Modal>

      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}
