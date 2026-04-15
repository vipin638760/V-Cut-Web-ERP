"use client";
import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, orderBy, deleteDoc, doc, updateDoc, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR } from "@/lib/calculations";
import { Icon, IconBtn, Pill, Card, PeriodWidget, TH, TD, Modal, useConfirm, useToast } from "@/components/ui";
import VLoader from "@/components/VLoader";


const NOW = new Date();

export default function LeavesPage() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [leaves, setLeaves]   = useState([]);
  const [staff, setStaff]     = useState([]);
  const [branches, setBranches] = useState([]);
  const [globalSettings, setGlobalSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("pending");

  // Apply leave form
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    branch_ids: [], staff_ids: [],
    date: new Date().toISOString().slice(0, 10),
    days: 1, type: "Auto", reason: ""
  });
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  // Period
  const [filterMode, setFilterMode]   = useState("month");
  const [filterYear, setFilterYear]   = useState(NOW.getFullYear());
  const [filterMonth, setFilterMonth] = useState(NOW.getMonth() + 1);
  const filterPrefix = filterYear + "-" + String(filterMonth).padStart(2, "0");

  const currentUser = useCurrentUser() || {};
  const isAdmin = currentUser?.role === "admin";
  const canAction = ["admin", "accountant"].includes(currentUser?.role);

  useEffect(() => {
    if (!db) return;
    const unsubBranches = onSnapshot(collection(db, "branches"), sn =>
      setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id }))));
    const unsubStaff = onSnapshot(collection(db, "staff"), sn =>
      setStaff(sn.docs.map(d => ({ ...d.data(), id: d.id }))));
    const unsubSettings = onSnapshot(doc(db, "settings", "global"), sn => setGlobalSettings(sn.data()));
    const unsubLeaves = onSnapshot(
      query(collection(db, "leaves"), orderBy("date", "desc")),
      sn => { setLeaves(sn.docs.map(d => ({ ...d.data(), id: d.id }))); setLoading(false); }
    );
    return () => { unsubBranches(); unsubStaff(); unsubSettings(); unsubLeaves(); };
  }, []);

  // Leave quota per staff (based on branch type + global settings)
  const getStaffQuota = (s) => {
    const b = branches.find(x => x.id === s.branch_id);
    if (!b) return 2;
    if (b.type === "unisex") return globalSettings?.unisex_leaves ?? 3;
    return globalSettings?.mens_leaves ?? 2;
  };

  // Month used (approved + pending) for a given staff and month prefix
  const getStaffUsed = (staffId, monthPrefix) => {
    return leaves
      .filter(l => l.staff_id === staffId && l.status !== "rejected" && l.date?.startsWith(monthPrefix))
      .reduce((sum, l) => sum + (parseInt(l.days) || 1), 0);
  };

  // For the date in the form, calculate remaining quota per staff
  const applyMonthPrefix = (form.date || "").slice(0, 7);
  const staffInfo = useMemo(() => {
    const map = {};
    staff.forEach(s => {
      const quota = getStaffQuota(s);
      const used = getStaffUsed(s.id, applyMonthPrefix);
      map[s.id] = { quota, used, remaining: Math.max(0, quota - used) };
    });
    return map;
  }, [staff, leaves, branches, globalSettings, applyMonthPrefix]);

  // Auto-compute the next numbered leave slot for a given staff based on how many they've used this month.
  // Example: used 0 → "Leave 1"; used 1 → "Leave 2"; used 2 (unisex) → "Leave 3"; beyond quota → null.
  const resolveAutoLeaveType = (staffId) => {
    const info = staffInfo[staffId];
    if (!info) return "Leave 1";
    const nextSlot = info.used + 1;
    return `Leave ${nextSlot}`;
  };

  // Top-level dropdown: "Auto (numbered)" or "Sick Leave" override
  const leaveTypeOptions = ["Auto", "Sick Leave"];
  useEffect(() => {
    if (!leaveTypeOptions.includes(form.type) && !["Leave 1", "Leave 2", "Leave 3"].includes(form.type)) {
      setForm(f => ({ ...f, type: "Auto" }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve what leave type a given staff will actually receive on submit
  const effectiveLeaveTypeFor = (staffId) => {
    if (form.type === "Sick Leave") return "Sick Leave";
    // Treat "Auto" or any pre-existing numbered selection as auto-assign
    return resolveAutoLeaveType(staffId);
  };

  const inPeriod = (dateStr) => {
    if (!dateStr) return false;
    return filterMode === "month"
      ? dateStr.startsWith(filterPrefix)
      : dateStr.startsWith(String(filterYear));
  };

  const pending  = leaves.filter(l => l.status === "pending");
  const approved = leaves.filter(l => l.status === "approved");
  const rejected = leaves.filter(l => l.status === "rejected");

  const displayLeaves = (() => {
    const pool = activeTab === "all"
      ? leaves
      : activeTab === "pending"  ? pending
      : activeTab === "approved" ? approved
      : rejected;
    return pool.filter(l => inPeriod(l.date));
  })();

  const handleApprove = async (id) => {
    try { await updateDoc(doc(db, "leaves", id), { status: "approved" }); toast({ title: "Approved", message: "Leave request approved.", type: "success" }); }
    catch (e) { confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
  };
  const handleReject = async (id) => {
    try { await updateDoc(doc(db, "leaves", id), { status: "rejected" }); toast({ title: "Rejected", message: "Leave request rejected.", type: "success" }); }
    catch (e) { confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
  };
  const handleDelete = async (id) => {
    confirm({
      title: "Delete Leave Record",
      message: "Are you sure you want to delete this <strong>leave record</strong>?",
      confirmText: "Yes, Delete",
      cancelText: "Cancel",
      type: "danger",
      onConfirm: async () => {
        try { await deleteDoc(doc(db, "leaves", id)); toast({ title: "Deleted", message: "Leave record has been removed.", type: "success" }); }
        catch (e) { confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
      }
    });
  };

  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [editLeave, setEditLeave] = useState(null); // { id, staff_id, date, days, type, reason }

  const handleSaveEdit = async () => {
    if (!editLeave) return;
    try {
      await updateDoc(doc(db, "leaves", editLeave.id), {
        date: editLeave.date,
        days: Number(editLeave.days) || 1,
        type: editLeave.type,
        reason: editLeave.reason,
        updated_by: currentUser?.id || "admin",
        updated_at: new Date().toISOString(),
      });
      toast({ title: "Updated", message: "Leave record updated.", type: "success" });
      setEditLeave(null);
    } catch (e) {
      confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} });
    }
  };

  const handleApply = async (e) => {
    e.preventDefault();
    if (form.staff_ids.length === 0 || !form.date) { setSaveMsg("❌ Select at least one staff and a date."); return; }

    const days = Number(form.days) || 1;
    const exhausted = [];
    const insufficient = [];
    form.staff_ids.forEach(id => {
      const info = staffInfo[id];
      const s = staff.find(x => x.id === id);
      if (!info || info.remaining <= 0) exhausted.push(s?.name || id);
      else if (info.remaining < days) insufficient.push(`${s?.name || id} (only ${info.remaining} left)`);
    });
    if (exhausted.length > 0) {
      confirm({
        title: "Leave Balance Exhausted",
        message: `The following staff have no remaining leaves for ${applyMonthPrefix}:<br/><strong>${exhausted.join(", ")}</strong><br/><br/>Please deselect them and try again.`,
        confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {}
      });
      return;
    }
    if (insufficient.length > 0) {
      confirm({
        title: "Insufficient Leave Balance",
        message: `Requested ${days} day(s) but these staff don't have enough:<br/><strong>${insufficient.join("<br/>")}</strong>`,
        confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {}
      });
      return;
    }

    // Open review modal instead of committing directly
    setSaveMsg("");
    setShowConfirmModal(true);
  };

  const handleCommitLeaves = async () => {
    const days = Number(form.days) || 1;
    setSaving(true); setSaveMsg("");
    try {
      const batch = writeBatch(db);
      form.staff_ids.forEach(id => {
        const ref = doc(collection(db, "leaves"));
        batch.set(ref, {
          staff_id: id, date: form.date,
          days, type: effectiveLeaveTypeFor(id),
          reason: form.reason, status: "pending",
          applied_by: currentUser?.id || "admin",
          applied_at: new Date().toISOString(),
        });
      });
      await batch.commit();
      const count = form.staff_ids.length;
      setSaveMsg(`✅ ${count} leave${count > 1 ? "s" : ""} applied!`);
      toast({ title: "Saved", message: `${count} leave application${count > 1 ? "s" : ""} submitted.`, type: "success" });
      setForm({ branch_ids: [], staff_ids: [], date: new Date().toISOString().slice(0, 10), days: 1, type: "Auto", reason: "" });
      setShowConfirmModal(false);
    } catch (err) { setSaveMsg("❌ " + err.message); }
    setSaving(false);
  };

  // Branch type currently locked in by the user's first pick (mens/unisex). Can't mix.
  const selectedBranchType = (() => {
    const firstId = form.branch_ids[0];
    if (!firstId) return null;
    return branches.find(b => b.id === firstId)?.type || "mens";
  })();

  const toggleBranch = (bid) => {
    const b = branches.find(x => x.id === bid);
    if (!b) return;
    const isIn = form.branch_ids.includes(bid);
    // Block mixing mens + unisex branches
    if (!isIn && selectedBranchType && (b.type || "mens") !== selectedBranchType) {
      confirm({
        title: "Cannot Mix Branch Types",
        message: `You're already working with <strong>${selectedBranchType.toUpperCase()}</strong> branches. To add this <strong>${(b.type || "mens").toUpperCase()}</strong> branch, clear the current selection first (leave quotas differ between Mens and Unisex).`,
        confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {}
      });
      return;
    }
    setForm(f => {
      const newBranches = isIn ? f.branch_ids.filter(x => x !== bid) : [...f.branch_ids, bid];
      const newStaffIds = f.staff_ids.filter(sid => {
        const s = staff.find(x => x.id === sid);
        return s && newBranches.includes(s.branch_id);
      });
      return { ...f, branch_ids: newBranches, staff_ids: newStaffIds };
    });
  };

  const toggleStaff = (sid) => {
    const info = staffInfo[sid];
    if (info && info.remaining <= 0 && !form.staff_ids.includes(sid)) {
      const s = staff.find(x => x.id === sid);
      confirm({
        title: "Leave Exhausted",
        message: `<strong>${s?.name || "This employee"}</strong> has already used all ${info.quota} leave(s) for ${applyMonthPrefix}. Cannot select.`,
        confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {}
      });
      return;
    }
    setForm(f => ({
      ...f,
      staff_ids: f.staff_ids.includes(sid) ? f.staff_ids.filter(x => x !== sid) : [...f.staff_ids, sid]
    }));
  };

  const eligibleStaff = staff.filter(s => form.branch_ids.includes(s.branch_id));

  const statusColor = { pending: "orange", approved: "green", rejected: "red" };

  if (loading) return <VLoader fullscreen label="Loading Leaves" />;

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>Leave Requests</div>
        {canAction && (
          <button onClick={() => setShowForm(!showForm)}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderRadius: 10, background: "linear-gradient(135deg,var(--gold),var(--gold2))", color: "#000", border: "none", cursor: "pointer", fontWeight: 700, fontSize: 13 }}>
            <Icon name="plus" size={14} /> Apply Leave
          </button>
        )}
      </div>

      <PeriodWidget
        filterMode={filterMode} setFilterMode={setFilterMode}
        filterYear={filterYear} setFilterYear={setFilterYear}
        filterMonth={filterMonth} setFilterMonth={setFilterMonth}
      />

      {/* KPI strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 12, marginBottom: 20 }}>
        {[
          { label: "Total Requests", value: leaves.filter(l => inPeriod(l.date)).length, color: "var(--text)" },
          { label: "Pending",        value: leaves.filter(l => l.status === "pending" && inPeriod(l.date)).length, color: "var(--orange)" },
          { label: "Approved",       value: leaves.filter(l => l.status === "approved" && inPeriod(l.date)).length, color: "var(--green)" },
          { label: "Rejected",       value: leaves.filter(l => l.status === "rejected" && inPeriod(l.date)).length, color: "var(--red)" },
          { label: "Total Days",     value: leaves.filter(l => l.status === "approved" && inPeriod(l.date)).reduce((s, l) => s + (parseInt(l.days) || 1), 0), color: "var(--blue)" },
        ].map(k => (
          <div key={k.label} style={{ background: "linear-gradient(180deg,var(--bg3),var(--bg2))", border: "1px solid var(--border)", borderRadius: 12, padding: 14, position: "relative", overflow: "hidden", boxShadow: "0 4px 16px rgba(0,0,0,.2)" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "linear-gradient(90deg,transparent,var(--gold),transparent)", opacity: .8 }} />
            <div style={{ fontSize: 11, color: "var(--text2)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, fontWeight: 600 }}>{k.label}</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: k.color }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Apply Leave Form */}
      {showForm && canAction && (
        <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: "inset 0 2px 10px rgba(0,0,0,.2)" }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 16, paddingBottom: 10, borderBottom: "1px solid var(--border)", color: "var(--gold)", textTransform: "uppercase", letterSpacing: 1 }}>Apply Leave</div>
          <form onSubmit={handleApply}>

            {/* Branches multi-select */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
                <label style={{ fontSize: 12, color: "var(--text2)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Select Branches ({form.branch_ids.length})</label>
                {selectedBranchType && (
                  <span style={{ padding: "3px 10px", borderRadius: 999, background: selectedBranchType === "unisex" ? "rgba(255,215,0,0.15)" : "rgba(34,211,238,0.15)", color: selectedBranchType === "unisex" ? "var(--gold)" : "var(--accent)", fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1 }}>
                    Locked to {selectedBranchType}
                  </span>
                )}
              </div>
              {(() => {
                const mensBranches = branches.filter(b => (b.type || "mens") === "mens");
                const unisexBranches = branches.filter(b => b.type === "unisex");
                const renderPill = (b) => {
                  const active = form.branch_ids.includes(b.id);
                  const bType = b.type || "mens";
                  const disabled = !active && selectedBranchType && bType !== selectedBranchType;
                  return (
                    <button key={b.id} type="button" onClick={() => toggleBranch(b.id)}
                      title={disabled ? `Locked to ${selectedBranchType} branches — clear selection to switch` : undefined}
                      style={{ padding: "8px 14px", borderRadius: 10, fontSize: 12, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer", transition: "all .2s",
                        background: active
                          ? (bType === "unisex" ? "linear-gradient(135deg,var(--gold),var(--gold2))" : "linear-gradient(135deg,var(--accent),var(--gold2))")
                          : "var(--bg4)",
                        color: active ? "#000" : (disabled ? "var(--text3)" : "var(--text2)"),
                        border: active
                          ? `1px solid ${bType === "unisex" ? "var(--gold)" : "var(--accent)"}`
                          : `1px solid ${disabled ? "rgba(255,255,255,0.06)" : "var(--border2)"}`,
                        opacity: disabled ? 0.45 : 1,
                        display: "inline-flex", alignItems: "center", gap: 6,
                      }}>
                      {active && <Icon name="check" size={11} color="#000" />}
                      {b.name.replace("V-CUT ", "")}
                    </button>
                  );
                };
                const renderGroup = (title, groupBranches, accentColor) => {
                  if (groupBranches.length === 0) return null;
                  const groupType = groupBranches[0]?.type || "mens";
                  const selectedInGroup = groupBranches.filter(b => form.branch_ids.includes(b.id)).length;
                  const allSelected = selectedInGroup === groupBranches.length;
                  const groupDisabled = selectedBranchType && groupType !== selectedBranchType && !allSelected;
                  return (
                    <div style={{ border: `1px solid ${accentColor}33`, borderRadius: 12, padding: 12, background: "var(--bg3)", opacity: groupDisabled ? 0.5 : 1 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ width: 8, height: 8, borderRadius: 4, background: accentColor }} />
                          <span style={{ fontSize: 11, fontWeight: 900, color: accentColor, textTransform: "uppercase", letterSpacing: 1.5 }}>{title}</span>
                          <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)" }}>{selectedInGroup}/{groupBranches.length} selected</span>
                        </div>
                        <button type="button" disabled={groupDisabled} onClick={() => {
                          if (allSelected) {
                            // Clear this group
                            setForm(f => ({
                              ...f,
                              branch_ids: f.branch_ids.filter(id => !groupBranches.some(b => b.id === id)),
                              staff_ids: f.staff_ids.filter(sid => {
                                const s = staff.find(x => x.id === sid);
                                return s && !groupBranches.some(b => b.id === s.branch_id);
                              }),
                            }));
                          } else {
                            // Select all in this group — but only if compatible with current lock
                            if (selectedBranchType && groupType !== selectedBranchType) {
                              confirm({ title: "Cannot Mix Branch Types", message: `Clear ${selectedBranchType.toUpperCase()} selection first to switch to ${groupType.toUpperCase()}.`, confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} });
                              return;
                            }
                            const ids = Array.from(new Set([...form.branch_ids, ...groupBranches.map(b => b.id)]));
                            setForm(f => ({ ...f, branch_ids: ids }));
                          }
                        }}
                          style={{ padding: "4px 10px", borderRadius: 8, fontSize: 10, fontWeight: 800, background: "transparent", color: accentColor, border: `1px solid ${accentColor}55`, cursor: groupDisabled ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
                          {allSelected ? "Clear" : "Select All"}
                        </button>
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {groupBranches.map(renderPill)}
                      </div>
                    </div>
                  );
                };
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {renderGroup("Mens Branches", mensBranches, "#22d3ee")}
                    {renderGroup("Unisex Branches", unisexBranches, "#ffd700")}
                  </div>
                );
              })()}
            </div>

            {/* Staff multi-select grouped by branch */}
            {form.branch_ids.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <label style={{ fontSize: 12, color: "var(--text2)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Select Staff ({form.staff_ids.length} / {eligibleStaff.length})</label>
                  <button type="button" onClick={() => {
                    const eligibleIds = eligibleStaff.filter(s => (staffInfo[s.id]?.remaining || 0) > 0).map(s => s.id);
                    setForm(f => ({ ...f, staff_ids: f.staff_ids.length >= eligibleIds.length ? [] : eligibleIds }));
                  }}
                    style={{ padding: "4px 10px", borderRadius: 8, fontSize: 10, fontWeight: 800, background: "var(--bg4)", color: "var(--accent)", border: "1px solid var(--border2)", cursor: "pointer", textTransform: "uppercase" }}>
                    Toggle All Eligible
                  </button>
                </div>
                <div style={{ maxHeight: 520, overflowY: "auto", padding: 4, display: "flex", flexDirection: "column", gap: 16 }}>
                  {form.branch_ids.map(bid => {
                    const b = branches.find(x => x.id === bid);
                    if (!b) return null;
                    const branchStaff = eligibleStaff.filter(s => s.branch_id === bid);
                    const branchSelected = branchStaff.filter(s => form.staff_ids.includes(s.id)).length;
                    const branchEligible = branchStaff.filter(s => (staffInfo[s.id]?.remaining || 0) > 0);
                    const allEligibleSelected = branchEligible.length > 0 && branchEligible.every(s => form.staff_ids.includes(s.id));
                    return (
                      <div key={bid} style={{ border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg3)", overflow: "hidden" }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: "var(--bg4)", borderBottom: "1px solid var(--border)", gap: 10, flexWrap: "wrap" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minWidth: 0, flex: "1 1 auto" }}>
                            <div style={{ width: 6, height: 6, borderRadius: 3, background: b.type === "unisex" ? "var(--gold)" : "var(--accent)", flexShrink: 0 }} />
                            <span style={{ fontSize: 13, fontWeight: 800, color: "var(--text)", whiteSpace: "nowrap" }}>{b.name.replace("V-CUT ", "")}</span>
                            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: b.type === "unisex" ? "rgba(255,215,0,0.12)" : "rgba(34,211,238,0.12)", color: b.type === "unisex" ? "var(--gold)" : "var(--accent)", textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap" }}>{b.type || "mens"}</span>
                            <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, whiteSpace: "nowrap" }}>{branchSelected}/{branchStaff.length} selected</span>
                          </div>
                          {branchEligible.length > 0 && (
                            <button type="button" onClick={() => {
                              setForm(f => {
                                const ids = new Set(f.staff_ids);
                                if (allEligibleSelected) branchEligible.forEach(s => ids.delete(s.id));
                                else branchEligible.forEach(s => ids.add(s.id));
                                return { ...f, staff_ids: Array.from(ids) };
                              });
                            }}
                              style={{ padding: "4px 10px", borderRadius: 8, fontSize: 10, fontWeight: 700, background: "transparent", color: "var(--accent)", border: "1px solid var(--border2)", cursor: "pointer", textTransform: "uppercase", whiteSpace: "nowrap", flexShrink: 0 }}>
                              {allEligibleSelected ? "Clear" : "All Eligible"}
                            </button>
                          )}
                        </div>
                        {branchStaff.length === 0 ? (
                          <div style={{ padding: 16, color: "var(--text3)", fontSize: 12, textAlign: "center", fontStyle: "italic" }}>No staff in this branch.</div>
                        ) : (
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 8, padding: 10 }}>
                            {branchStaff.map(s => {
                              const info = staffInfo[s.id] || { quota: 2, used: 0, remaining: 0 };
                              const exhausted = info.remaining <= 0;
                              const selected = !exhausted && form.staff_ids.includes(s.id);
                              return (
                                <div key={s.id} onClick={() => toggleStaff(s.id)}
                                  style={{ display: "flex", alignItems: "center", gap: 10, padding: 10, borderRadius: 10, cursor: exhausted ? "not-allowed" : "pointer",
                                    background: exhausted ? "rgba(248,113,113,0.05)" : (selected ? "rgba(34,211,238,0.1)" : "var(--bg2)"),
                                    border: exhausted ? "1px dashed rgba(248,113,113,0.4)" : (selected ? "1px solid var(--accent)" : "1px solid var(--border)"),
                                    transition: "all .15s" }}>
                                  {/* Indicator */}
                                  {exhausted ? (
                                    <div title="Leave quota exhausted" style={{ width: 18, height: 18, borderRadius: 5, background: "rgba(248,113,113,0.18)", color: "var(--red)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 12, fontWeight: 900, border: "1px solid rgba(248,113,113,0.4)" }}>✕</div>
                                  ) : (
                                    <div style={{ width: 18, height: 18, borderRadius: 5, border: `1.5px solid ${selected ? "var(--accent)" : "var(--border2)"}`, background: selected ? "var(--accent)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                                      {selected && <Icon name="check" size={11} color="#000" />}
                                    </div>
                                  )}
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: 13, fontWeight: 700, color: exhausted ? "var(--text3)" : "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textDecoration: exhausted ? "line-through" : "none" }}>{s.name}</div>
                                    <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>{s.role || "—"}</div>
                                  </div>
                                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                                    <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", fontWeight: 700, letterSpacing: 0.5 }}>{exhausted ? "Used" : "Left"}</div>
                                    <div style={{ fontSize: 14, fontWeight: 800, color: exhausted ? "var(--red)" : info.remaining === 1 ? "var(--orange)" : "var(--green)" }}>{info.remaining}/{info.quota}</div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {eligibleStaff.length === 0 && (
                    <div style={{ padding: 16, color: "var(--text3)", fontSize: 12, textAlign: "center" }}>No staff in selected branches.</div>
                  )}
                </div>
              </div>
            )}

            {/* Date / Days / Type / Reason row */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 12, marginBottom: 16 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 12, color: "var(--text2)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Date</label>
                <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })}
                  style={{ padding: "12px 16px", border: "2px solid var(--input-border)", borderRadius: 10, fontSize: 14, background: "var(--bg2)", color: "var(--text)", fontFamily: "var(--font-outfit)", width: "100%", outline: "none" }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 12, color: "var(--text2)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Days</label>
                <input type="number" min="1" max="30" value={form.days} onChange={e => setForm({ ...form, days: e.target.value })}
                  style={{ padding: "12px 16px", border: "2px solid var(--input-border)", borderRadius: 10, fontSize: 14, background: "var(--bg2)", color: "var(--text)", fontFamily: "var(--font-outfit)", width: "100%", outline: "none" }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 12, color: "var(--text2)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Leave Type</label>
                <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}
                  style={{ padding: "12px 16px", border: "2px solid var(--input-border)", borderRadius: 10, fontSize: 14, background: "var(--bg2)", color: "var(--text)", fontFamily: "var(--font-outfit)", width: "100%", outline: "none" }}>
                  {leaveTypeOptions.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, gridColumn: "span 2" }}>
                <label style={{ fontSize: 12, color: "var(--text2)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Reason (optional)</label>
                <input type="text" placeholder="Optional reason" value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })}
                  style={{ padding: "12px 16px", border: "2px solid var(--input-border)", borderRadius: 10, fontSize: 14, background: "var(--bg2)", color: "var(--text)", fontFamily: "var(--font-outfit)", width: "100%", outline: "none" }} />
              </div>
            </div>

            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <button type="submit" disabled={saving || form.staff_ids.length === 0}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", borderRadius: 10, background: "linear-gradient(135deg,var(--gold),var(--gold2))", color: "#000", border: "none", cursor: saving || form.staff_ids.length === 0 ? "not-allowed" : "pointer", fontWeight: 700, opacity: saving || form.staff_ids.length === 0 ? 0.5 : 1 }}>
                <Icon name="save" size={14} />
                {saving ? "Saving..." : `Submit ${form.staff_ids.length} Leave${form.staff_ids.length === 1 ? "" : "s"}`}
              </button>
              <button type="button" onClick={() => setShowForm(false)}
                style={{ padding: "10px 16px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", cursor: "pointer", fontWeight: 600 }}>
                Cancel
              </button>
              {saveMsg && <span style={{ fontSize: 13, color: saveMsg.startsWith("✅") ? "var(--green)" : "var(--red)" }}>{saveMsg}</span>}
            </div>
          </form>
        </div>
      )}

      {/* Tab Strip */}
      <div style={{ display: "flex", gap: 4, marginBottom: 16, background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 10, padding: 4, flexWrap: "wrap" }}>
        {[
          ["pending",  `⏳ Pending (${pending.length})`],
          ["approved", "✅ Approved"],
          ["rejected", "❌ Rejected"],
          ["all",      "📋 All"],
        ].map(([tab, label]) => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            style={{ flex: 1, minWidth: 120, padding: "8px 14px", fontSize: 12, fontWeight: 700, border: "none", borderRadius: 8, cursor: "pointer", transition: "all .2s", textTransform: "uppercase", letterSpacing: ".5px", fontFamily: "var(--font-outfit)",
              background: activeTab === tab
                ? tab === "pending" ? "var(--orange)" : tab === "approved" ? "var(--green)" : tab === "rejected" ? "var(--red)" : "var(--gold)"
                : "transparent",
              color: activeTab === tab ? (tab === "all" ? "#000" : "#fff") : "var(--text3)",
            }}>
            {label}
          </button>
        ))}
      </div>

      {/* Leaves Table */}
      <Card>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5 }}>
          <thead>
            <tr>
              <TH>Staff</TH><TH>Date</TH><TH right>Days</TH><TH>Type</TH><TH>Reason</TH><TH>Status</TH>
              {canAction && <TH sticky>Actions</TH>}
            </tr>
          </thead>
          <tbody>
            {displayLeaves.map(l => {
              const s = staff.find(x => x.id === l.staff_id);
              return (
                <tr key={l.id}>
                  <TD style={{ fontWeight: 600 }}>{s ? s.name : l.staff_id}</TD>
                  <TD style={{ fontWeight: 500, whiteSpace: "nowrap" }}>{l.date || "—"}</TD>
                  <TD right style={{ color: "var(--blue)", fontWeight: 600 }}>{l.days || 1}</TD>
                  <TD style={{ fontSize: 11, color: "var(--text2)" }}>{l.type || "Leave"}</TD>
                  <TD style={{ fontSize: 11, color: "var(--text3)", maxWidth: 180 }}>{l.reason || "—"}</TD>
                  <TD><Pill label={l.status || "pending"} color={statusColor[l.status] || "orange"} /></TD>
                  {canAction && (
                    <TD sticky>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        {l.status === "pending" ? (
                          <>
                            <button onClick={() => handleApprove(l.id)} title="Approve"
                              style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 6, background: "rgba(74,222,128,0.15)", border: "1px solid rgba(74,222,128,0.35)", color: "var(--green)", cursor: "pointer", fontWeight: 700, fontSize: 11 }}>
                              <Icon name="check" size={12} /> Approve
                            </button>
                            <button onClick={() => handleReject(l.id)} title="Reject"
                              style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", borderRadius: 6, background: "rgba(248,113,113,0.12)", border: "1px solid rgba(248,113,113,0.3)", color: "var(--red)", cursor: "pointer", fontWeight: 700, fontSize: 11 }}>
                              <Icon name="close" size={12} /> Reject
                            </button>
                          </>
                        ) : (
                          <span style={{ fontSize: 11, color: "var(--text3)", marginRight: 4 }}>Processed</span>
                        )}
                        <IconBtn name="edit" title="Edit record" variant="secondary" onClick={() => setEditLeave({ id: l.id, staff_id: l.staff_id, date: l.date || "", days: l.days || 1, type: l.type || "Leave 1", reason: l.reason || "" })} />
                        {isAdmin && <IconBtn name="del" title="Delete record" variant="danger" onClick={() => handleDelete(l.id)} />}
                      </div>
                    </TD>
                  )}
                </tr>
              );
            })}
            {displayLeaves.length === 0 && (
              <tr>
                <td colSpan={7} style={{ textAlign: "center", padding: 32, color: "var(--text3)" }}>
                  No leave requests for this period
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      {/* Edit Leave Modal */}
      <Modal isOpen={!!editLeave} onClose={() => setEditLeave(null)} title="Edit Leave Record" width={520}>
        {editLeave && (() => {
          const s = staff.find(x => x.id === editLeave.staff_id);
          const b = branches.find(x => x.id === s?.branch_id);
          const typeOptions = (b?.type === "unisex") ? ["Leave 1", "Leave 2", "Leave 3", "Sick Leave"] : ["Leave 1", "Leave 2", "Sick Leave"];
          const ip = { padding: "12px 16px", border: "2px solid var(--input-border)", borderRadius: 10, fontSize: 14, background: "var(--bg2)", color: "var(--text)", fontFamily: "var(--font-outfit)", width: "100%", outline: "none" };
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ padding: 12, borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border)" }}>
                <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Staff</div>
                <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text)" }}>{s?.name || "—"} <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 500 }}>· {b?.name?.replace("V-CUT ", "") || "—"}</span></div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Date</label>
                  <input type="date" value={editLeave.date} onChange={e => setEditLeave({ ...editLeave, date: e.target.value })} style={ip} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Days</label>
                  <input type="number" min="1" max="30" value={editLeave.days} onChange={e => setEditLeave({ ...editLeave, days: e.target.value })} style={ip} />
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Type</label>
                <select value={editLeave.type} onChange={e => setEditLeave({ ...editLeave, type: e.target.value })} style={ip}>
                  {typeOptions.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Reason</label>
                <input type="text" placeholder="Optional" value={editLeave.reason} onChange={e => setEditLeave({ ...editLeave, reason: e.target.value })} style={ip} />
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 8 }}>
                <button onClick={() => setEditLeave(null)}
                  style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>
                  Cancel
                </button>
                <button onClick={handleSaveEdit}
                  style={{ padding: "10px 20px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Icon name="save" size={13} /> Save Changes
                </button>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* Review & Confirm Modal */}
      <Modal isOpen={showConfirmModal} onClose={() => !saving && setShowConfirmModal(false)} title="Review Leave Applications" width={720}>
        {(() => {
          const days = Number(form.days) || 1;
          const rows = form.staff_ids.map(id => {
            const s = staff.find(x => x.id === id);
            const b = branches.find(x => x.id === s?.branch_id);
            const info = staffInfo[id] || { quota: 2, used: 0, remaining: 0 };
            const after = info.remaining - days;
            const leaveType = effectiveLeaveTypeFor(id);
            return { id, s, b, info, after, leaveType };
          });
          const byBranch = {};
          rows.forEach(r => {
            const key = r.b?.id || "_other";
            if (!byBranch[key]) byBranch[key] = { branch: r.b, rows: [] };
            byBranch[key].rows.push(r);
          });
          return (
            <div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
                {[
                  ["Staff", rows.length, "var(--accent)"],
                  ["Branches", Object.keys(byBranch).length, "var(--gold)"],
                  ["Days Each", days, "var(--blue)"],
                  ["Mode", form.type === "Sick Leave" ? "Sick Leave" : "Auto-numbered", "var(--green)"],
                ].map(([l, v, c]) => (
                  <div key={l} style={{ padding: 10, borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border)" }}>
                    <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: c, marginTop: 4 }}>{v}</div>
                  </div>
                ))}
              </div>

              <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 10 }}>
                Applying <strong style={{ color: "var(--text)" }}>{form.type === "Sick Leave" ? "Sick Leave" : "auto-numbered leaves"}</strong> · <strong style={{ color: "var(--text)" }}>{days} day{days > 1 ? "s" : ""}</strong> · from <strong style={{ color: "var(--text)" }}>{form.date}</strong>{form.reason ? ` · "${form.reason}"` : ""}
              </div>

              <div style={{ maxHeight: 360, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 10 }}>
                <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
                  <thead style={{ position: "sticky", top: 0, background: "var(--bg4)", zIndex: 1 }}>
                    <tr>
                      <TH>Staff</TH><TH>Role</TH><TH>Type</TH><TH right>Current Balance</TH><TH right>After</TH>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.values(byBranch).map(group => (
                      <>
                        <tr key={"h-" + (group.branch?.id || "x")}>
                          <td colSpan={5} style={{ padding: "8px 12px", background: "var(--bg3)", fontSize: 11, fontWeight: 800, color: "var(--gold)", textTransform: "uppercase", letterSpacing: 1 }}>
                            {group.branch?.name?.replace("V-CUT ", "") || "Other"} · {group.rows.length} employee{group.rows.length > 1 ? "s" : ""}
                          </td>
                        </tr>
                        {group.rows.map(r => {
                          const isSick = r.leaveType === "Sick Leave";
                          const pillBg = isSick ? "rgba(251,146,60,0.15)" : "rgba(34,211,238,0.12)";
                          const pillColor = isSick ? "var(--orange)" : "var(--accent)";
                          return (
                            <tr key={r.id}>
                              <TD style={{ fontWeight: 700 }}>{r.s?.name || "—"}</TD>
                              <TD style={{ color: "var(--text3)" }}>{r.s?.role || "—"}</TD>
                              <TD>
                                <span style={{ padding: "3px 10px", borderRadius: 999, background: pillBg, color: pillColor, fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap" }}>
                                  {r.leaveType}
                                </span>
                              </TD>
                              <TD right style={{ color: "var(--green)", fontWeight: 700 }}>{r.info.remaining}/{r.info.quota}</TD>
                              <TD right style={{ color: r.after <= 0 ? "var(--red)" : r.after === 1 ? "var(--orange)" : "var(--green)", fontWeight: 800 }}>{r.after}/{r.info.quota}</TD>
                            </tr>
                          );
                        })}
                      </>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
                <button onClick={() => setShowConfirmModal(false)} disabled={saving}
                  style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: saving ? "wait" : "pointer" }}>
                  Back to Edit
                </button>
                <button onClick={handleCommitLeaves} disabled={saving}
                  style={{ padding: "10px 20px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: saving ? "wait" : "pointer", opacity: saving ? 0.6 : 1, display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Icon name="check" size={14} /> {saving ? "Applying..." : `Confirm & Apply ${rows.length} Leave${rows.length > 1 ? "s" : ""}`}
                </button>
              </div>
            </div>
          );
        })()}
      </Modal>

      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}
