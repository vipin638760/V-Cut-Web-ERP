"use client";
import LeaveTab from "../users/tabs/LeaveTab";

export default function ApplyLeavePage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h1 style={{ fontSize: 28, fontWeight: 900, color: "var(--gold)", letterSpacing: 1, textTransform: "uppercase" }}>Apply Leave</h1>
        <p style={{ fontSize: 13, color: "var(--text3)", marginTop: 4 }}>Submit new leave requests and track your attendance status.</p>
      </div>
      
      {/* 
         Note: LeaveTab handles its own filtering based on the logged-in user 
         when in 'employee' mode. I've designed it to be smart enough to detect the role.
      */}
      <LeaveTab view="employee" />
    </div>
  );
}
