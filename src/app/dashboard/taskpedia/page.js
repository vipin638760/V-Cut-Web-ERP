"use client";
import { useEffect, useState, useMemo } from "react";
import { collection, onSnapshot, addDoc, deleteDoc, doc, updateDoc, orderBy, query } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { Icon, Card, Modal, useConfirm, useToast } from "@/components/ui";
import VLoader from "@/components/VLoader";

const COLUMNS = [
  { key: "todo",        label: "TO DO",       color: "var(--blue)",   rgb: "34,211,238" },
  { key: "in_progress", label: "IN PROGRESS", color: "var(--orange)", rgb: "251,146,60" },
  { key: "done",        label: "DONE",        color: "var(--green)",  rgb: "74,222,128" },
];

const todayISO = () => new Date().toISOString().slice(0, 10);

// Resize + compress client-side and return a data: URL. Avoids Firebase
// Storage (the app uses custom Firestore-backed auth, so unauthenticated
// uploadBytes calls hang against default Storage rules). A 1200-px JPEG
// at 0.72 quality comfortably fits in Firestore's 1 MiB doc limit for
// typical screenshots, and the <img> tag handles data: URLs natively.
async function compressImageToDataUrl(file, maxDim = 1200, quality = 0.72) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Could not load image."));
      el.src = url;
    });
    let { width, height } = img;
    if (width > maxDim || height > maxDim) {
      const scale = Math.min(maxDim / width, maxDim / height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, width, height);
    // toDataURL falls back to PNG if the browser doesn't support the
    // requested mime — always shrink PNGs by routing through JPEG.
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function TaskpediaPage() {
  const currentUser = useCurrentUser() || {};
  const isAdmin = currentUser?.role === "admin";
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();

  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newModal, setNewModal] = useState(false);
  const [newForm, setNewForm] = useState({ title: "", description: "", due_date: todayISO(), assignee_ids: [], image: null });
  const [uploading, setUploading] = useState(false);
  const [detail, setDetail] = useState(null); // task being viewed
  const [dateChange, setDateChange] = useState(null); // { new_date, reason }
  // Admin filters
  const [fAssignee, setFAssignee] = useState("");
  const [fStatus, setFStatus] = useState("");
  // Assignee search (inside new-task modal)
  const [assigneeSearch, setAssigneeSearch] = useState("");
  // Drag-and-drop between columns
  const [dragTaskId, setDragTaskId] = useState(null);
  const [dragOverCol, setDragOverCol] = useState(null);

  useEffect(() => {
    if (!db) { setLoading(false); return; }
    const unsubs = [];
    try {
      unsubs.push(onSnapshot(
        query(collection(db, "taskpedia"), orderBy("created_at", "desc")),
        sn => {
          setTasks(sn.docs.map(d => ({ ...d.data(), id: d.id })));
          setLoading(false);
        },
        (err) => {
          // If the collection is empty or rules block reads, fall through
          // to an empty board rather than leaving the spinner up forever.
          console.warn("[taskpedia] tasks subscription error:", err?.message);
          setTasks([]);
          setLoading(false);
        }
      ));
    } catch (err) {
      console.warn("[taskpedia] tasks query build failed:", err?.message);
      setLoading(false);
    }
    try {
      unsubs.push(onSnapshot(
        collection(db, "users"),
        sn => setUsers(sn.docs.map(d => ({ ...d.data(), id: d.id }))),
        () => setUsers([])
      ));
    } catch { /* ignore — assignee list will be empty */ }
    return () => unsubs.forEach(u => u());
  }, []);

  const usersById = useMemo(() => new Map(users.map(u => [u.id, u])), [users]);

  // Handle both the new assignee_ids[] array and the legacy single
  // assignee_id so old docs don't vanish after the multi-assignee migration.
  const taskAssignees = (t) => t?.assignee_ids?.length ? t.assignee_ids : (t?.assignee_id ? [t.assignee_id] : []);
  const taskHasUser = (t, uid) => taskAssignees(t).includes(uid);

  const filtered = useMemo(() => {
    let list = tasks;
    if (isAdmin) {
      if (fAssignee) list = list.filter(t => taskHasUser(t, fAssignee));
      if (fStatus)   list = list.filter(t => t.status === fStatus);
    }
    return list;
  }, [tasks, fAssignee, fStatus, isAdmin]);

  const byStatus = useMemo(() => {
    const m = { todo: [], in_progress: [], done: [] };
    filtered.forEach(t => { if (m[t.status]) m[t.status].push(t); });
    return m;
  }, [filtered]);

  // ── Create / edit task ────────────────────────────────────────────────
  const openNew = () => {
    setNewForm({ title: "", description: "", due_date: todayISO(), assignee_ids: [], image: null });
    setAssigneeSearch("");
    setNewModal(true);
  };

  const toggleNewAssignee = (uid) => setNewForm(f => {
    const has = f.assignee_ids.includes(uid);
    return { ...f, assignee_ids: has ? f.assignee_ids.filter(x => x !== uid) : [...f.assignee_ids, uid] };
  });

  const handleCreate = async () => {
    const { title, description, due_date, assignee_ids, image } = newForm;
    if (!title.trim() || assignee_ids.length === 0 || !due_date) {
      toast({ title: "Incomplete", message: "Title, at least one assignee, and due date are required.", type: "warning" });
      return;
    }
    setUploading(true);
    try {
      let image_url = null;
      if (image) {
        if (image.size > 8 * 1024 * 1024) {
          toast({ title: "Image too large", message: "Please pick an image under 8 MB.", type: "warning" });
          setUploading(false);
          return;
        }
        image_url = await compressImageToDataUrl(image);
      }
      const assignees = assignee_ids.map(id => usersById.get(id)).filter(Boolean);
      const assignee_names = assignees.map(a => a.name);
      // Keep the legacy single-assignee fields populated too so any code path
      // that still reads them (e.g. older filters) keeps working.
      await addDoc(collection(db, "taskpedia"), {
        title: title.trim(),
        description: description.trim(),
        image_url,
        assignee_ids,
        assignee_names,
        assignee_id: assignee_ids[0],
        assignee_name: assignee_names[0] || "",
        assigned_by_id: currentUser?.id || "",
        assigned_by_name: currentUser?.name || "",
        due_date,
        status: "todo",
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        date_changes: [],
        read_by_assignee: false,
      });
      toast({ title: "Task created", message: `"${title.trim()}" assigned to ${assignee_names.join(", ")}.`, type: "success" });
      setNewModal(false);
    } catch (err) {
      toast({ title: "Error", message: err.message, type: "error" });
    } finally {
      setUploading(false);
    }
  };

  // ── Status moves ──────────────────────────────────────────────────────
  const moveTo = async (task, status) => {
    const patch = { status };
    if (status === "in_progress" && !task.started_at) patch.started_at = new Date().toISOString();
    if (status === "done")                           patch.completed_at = new Date().toISOString();
    if (status === "todo")                           patch.started_at = null; // reset if re-opened
    await updateDoc(doc(db, "taskpedia", task.id), patch);
    setDetail(prev => (prev && prev.id === task.id ? { ...prev, ...patch } : prev));
  };

  // Mark a task as read by the assignee (bell badge clears).
  const markRead = async (task) => {
    if (!task || task.read_by_assignee) return;
    if (!taskHasUser(task, currentUser?.id)) return;
    await updateDoc(doc(db, "taskpedia", task.id), { read_by_assignee: true });
  };

  // ── Date change with reason ───────────────────────────────────────────
  const saveDateChange = async () => {
    if (!detail || !dateChange) return;
    const { new_date, reason } = dateChange;
    if (!new_date || !reason?.trim()) {
      toast({ title: "Incomplete", message: "New date and reason required.", type: "warning" });
      return;
    }
    const entry = {
      old_date: detail.due_date,
      new_date,
      reason: reason.trim(),
      changed_at: new Date().toISOString(),
      changed_by: currentUser?.name || currentUser?.id || "",
    };
    await updateDoc(doc(db, "taskpedia", detail.id), {
      due_date: new_date,
      date_changes: [...(detail.date_changes || []), entry],
    });
    setDetail(prev => prev ? { ...prev, due_date: new_date, date_changes: [...(prev.date_changes || []), entry] } : prev);
    setDateChange(null);
    toast({ title: "Date updated", message: "Due date changed with reason logged.", type: "success" });
  };

  // ── Delete ─────────────────────────────────────────────────────────────
  const handleDelete = (task) => {
    confirm({
      title: "Delete task",
      message: `Delete <strong>${task.title}</strong>?`,
      confirmText: "Delete", type: "danger",
      onConfirm: async () => {
        await deleteDoc(doc(db, "taskpedia", task.id));
        setDetail(null);
        toast({ title: "Deleted", message: "Task removed.", type: "success" });
      },
    });
  };

  // Count of unread tasks assigned to me — shown as a subtle badge on the page
  const myUnread = tasks.filter(t => taskHasUser(t, currentUser?.id) && !t.read_by_assignee && t.status !== "done").length;

  // Drag-and-drop handlers (HTML5). The whole card is draggable; the
  // column body is the drop zone. No extra dep — keeps this simple.
  const handleDragStart = (e, task) => {
    setDragTaskId(task.id);
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", task.id); }
  };
  const handleDragEnd = () => { setDragTaskId(null); setDragOverCol(null); };
  const handleColDragOver = (e, colKey) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "move"; if (dragOverCol !== colKey) setDragOverCol(colKey); };
  const handleColDrop = async (e, colKey) => {
    e.preventDefault();
    const id = dragTaskId || e.dataTransfer?.getData("text/plain");
    setDragOverCol(null); setDragTaskId(null);
    if (!id) return;
    const task = tasks.find(t => t.id === id);
    if (!task || task.status === colKey) return;
    await moveTo(task, colKey);
  };

  if (loading) return <VLoader fullscreen label="Loading Taskpedia" />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <style>{`
        .taskpedia-card { transition: transform .15s, box-shadow .15s, border-color .15s; }
        .taskpedia-card:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(var(--accent-rgb),0.18); }
      `}</style>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 2 }}>Collaboration</div>
          <div style={{ fontSize: 26, fontWeight: 800, color: "var(--gold)", fontFamily: "var(--font-headline, var(--font-outfit))", marginTop: 2 }}>
            Taskpedia
            {myUnread > 0 && (
              <span style={{ marginLeft: 10, fontSize: 12, fontWeight: 700, padding: "4px 10px", borderRadius: 999, background: "rgba(248,113,113,0.18)", color: "var(--red)", border: "1px solid rgba(248,113,113,0.35)", verticalAlign: "middle" }}>
                {myUnread} new for you
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4 }}>
            Assign tasks, attach screenshots, track status together.
          </div>
        </div>
        <button onClick={openNew}
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 22px", borderRadius: 12, background: "linear-gradient(135deg, var(--accent), var(--gold2))", color: "#000", border: "none", cursor: "pointer", fontWeight: 800, fontSize: 12, textTransform: "uppercase", letterSpacing: 1 }}>
          <Icon name="plus" size={14} /> New Task
        </button>
      </div>

      {/* Admin filters */}
      {isAdmin && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "10px 14px", background: "var(--bg3)", borderRadius: 10, border: "1px solid var(--border)" }}>
          <span style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Filter</span>
          <select value={fAssignee} onChange={e => setFAssignee(e.target.value)}
            style={{ padding: "8px 12px", background: "var(--bg4)", border: "1px solid var(--border2)", borderRadius: 8, color: "var(--text)", fontSize: 12 }}>
            <option value="">All assignees</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <select value={fStatus} onChange={e => setFStatus(e.target.value)}
            style={{ padding: "8px 12px", background: "var(--bg4)", border: "1px solid var(--border2)", borderRadius: 8, color: "var(--text)", fontSize: 12 }}>
            <option value="">All statuses</option>
            {COLUMNS.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          {(fAssignee || fStatus) && (
            <button onClick={() => { setFAssignee(""); setFStatus(""); }}
              style={{ padding: "8px 14px", borderRadius: 8, background: "rgba(248,113,113,0.1)", color: "var(--red)", border: "1px solid rgba(248,113,113,0.3)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              Clear
            </button>
          )}
          <div style={{ marginLeft: "auto", fontSize: 11, color: "var(--text3)" }}>{filtered.length} task{filtered.length === 1 ? "" : "s"}</div>
        </div>
      )}

      {/* Kanban columns — drag between columns to change status */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
        {COLUMNS.map(col => {
          const isDropTarget = dragOverCol === col.key;
          return (
            <Card key={col.key} style={{ padding: 0, overflow: "hidden", transition: "border-color .15s, box-shadow .15s", borderColor: isDropTarget ? col.color : undefined, boxShadow: isDropTarget ? `0 0 18px rgba(${col.rgb},0.35)` : undefined }}>
              <div style={{ padding: "12px 16px", background: `linear-gradient(135deg, rgba(${col.rgb},0.18), rgba(${col.rgb},0.04))`, borderBottom: `1px solid rgba(${col.rgb},0.25)`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: col.color, letterSpacing: 1.5 }}>{col.label}</div>
                <div style={{ fontSize: 11, fontWeight: 800, color: col.color, padding: "2px 10px", borderRadius: 999, background: `rgba(${col.rgb},0.15)` }}>{byStatus[col.key].length}</div>
              </div>
              <div
                onDragOver={(e) => handleColDragOver(e, col.key)}
                onDragLeave={() => setDragOverCol(null)}
                onDrop={(e) => handleColDrop(e, col.key)}
                style={{
                  padding: 12, display: "flex", flexDirection: "column", gap: 10, minHeight: 200,
                  background: isDropTarget ? `rgba(${col.rgb},0.06)` : undefined,
                  transition: "background .15s",
                }}>
                {byStatus[col.key].length === 0 && (
                  <div style={{ padding: "40px 12px", textAlign: "center", color: "var(--text3)", fontSize: 11, fontStyle: "italic" }}>{isDropTarget ? "Drop here" : "No tasks"}</div>
                )}
                {byStatus[col.key].map(t => {
                  const overdue = col.key !== "done" && t.due_date < todayISO();
                  const isMine = taskHasUser(t, currentUser?.id);
                  const unread = isMine && !t.read_by_assignee && t.status !== "done";
                  const assigneeIds = taskAssignees(t);
                  const assigneeNames = t.assignee_names?.length ? t.assignee_names : (t.assignee_name ? [t.assignee_name] : assigneeIds.map(id => usersById.get(id)?.name || ""));
                  const isDragging = dragTaskId === t.id;
                  return (
                    <div key={t.id} className="taskpedia-card"
                      draggable="true"
                      onDragStart={(e) => handleDragStart(e, t)}
                      onDragEnd={handleDragEnd}
                      onClick={() => { setDetail(t); markRead(t); }}
                      style={{
                        padding: 12, borderRadius: 10, background: "var(--bg3)",
                        border: unread ? "1px solid var(--red)" : overdue ? "1px solid rgba(248,113,113,0.4)" : "1px solid var(--border)",
                        cursor: isDragging ? "grabbing" : "grab",
                        opacity: isDragging ? 0.4 : 1,
                        boxShadow: unread ? "0 0 14px rgba(248,113,113,0.25)" : "none",
                      }}>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
                        <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis" }}>{t.title}</div>
                        {unread && <span title="New for you" style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--red)", flexShrink: 0, marginTop: 4 }} />}
                      </div>
                      {t.description && (
                        <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 8, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{t.description}</div>
                      )}
                      {t.image_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={t.image_url} alt="" style={{ width: "100%", maxHeight: 120, objectFit: "cover", borderRadius: 8, marginBottom: 8, border: "1px solid var(--border)" }} />
                      )}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 10 }}>
                        <div style={{ display: "flex", gap: 3, minWidth: 0, flex: 1, flexWrap: "wrap" }}>
                          {assigneeNames.slice(0, 2).map((n, idx) => (
                            <span key={idx} style={{ padding: "2px 8px", borderRadius: 999, background: "rgba(var(--accent-rgb),0.12)", color: "var(--accent)", fontWeight: 700, whiteSpace: "nowrap" }}>{n || "—"}</span>
                          ))}
                          {assigneeNames.length > 2 && (
                            <span style={{ padding: "2px 6px", borderRadius: 999, background: "var(--bg4)", color: "var(--text3)", fontWeight: 700 }}>+{assigneeNames.length - 2}</span>
                          )}
                        </div>
                        <span style={{ color: overdue ? "var(--red)" : "var(--text3)", fontWeight: overdue ? 800 : 500, whiteSpace: "nowrap" }}>
                          {overdue && "⚠ "}{t.due_date}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        })}
      </div>

      {/* Create Task modal */}
      <Modal isOpen={newModal} onClose={() => !uploading && setNewModal(false)} title="New Task" width={560}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Title *</label>
          <input type="text" placeholder="Short summary of the task" value={newForm.title}
            onChange={e => setNewForm({ ...newForm, title: e.target.value })}
            style={{ padding: "10px 14px", background: "var(--bg4)", border: "1px solid var(--border2)", borderRadius: 8, color: "var(--text)", fontSize: 13, outline: "none" }} />

          <label style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Issue details</label>
          <textarea rows={4} placeholder="What needs doing? Include steps to reproduce if it's a bug." value={newForm.description}
            onChange={e => setNewForm({ ...newForm, description: e.target.value })}
            style={{ padding: "10px 14px", background: "var(--bg4)", border: "1px solid var(--border2)", borderRadius: 8, color: "var(--text)", fontSize: 13, outline: "none", resize: "vertical", fontFamily: "inherit" }} />

          <label style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>
            Assign to * <span style={{ color: "var(--text3)", fontWeight: 500, textTransform: "none", marginLeft: 4 }}>— pick one or more so teammates can work together</span>
          </label>
          <input type="text" placeholder="Search by name or role…" value={assigneeSearch}
            onChange={e => setAssigneeSearch(e.target.value)}
            style={{ padding: "10px 14px", background: "var(--bg4)", border: "1px solid var(--border2)", borderRadius: 8, color: "var(--text)", fontSize: 13, outline: "none" }} />
          {/* Selected chips */}
          {newForm.assignee_ids.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {newForm.assignee_ids.map(id => {
                const u = usersById.get(id);
                return (
                  <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 999, background: "rgba(var(--accent-rgb),0.15)", border: "1px solid rgba(var(--accent-rgb),0.35)", color: "var(--accent)", fontSize: 11, fontWeight: 700 }}>
                    {u?.name || id}
                    <button type="button" onClick={() => toggleNewAssignee(id)}
                      style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12, lineHeight: 1, padding: 0 }}>×</button>
                  </span>
                );
              })}
            </div>
          )}
          {/* Searchable checklist */}
          <div style={{ maxHeight: 160, overflowY: "auto", border: "1px solid var(--border2)", borderRadius: 8, background: "var(--bg4)" }}>
            {users
              .filter(u => {
                const q = assigneeSearch.trim().toLowerCase();
                if (!q) return true;
                return (u.name || "").toLowerCase().includes(q) || (u.role || "").toLowerCase().includes(q);
              })
              .map(u => {
                const checked = newForm.assignee_ids.includes(u.id);
                return (
                  <label key={u.id}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px solid var(--border)", cursor: "pointer", background: checked ? "rgba(var(--accent-rgb),0.08)" : "transparent" }}>
                    <input type="checkbox" checked={checked} onChange={() => toggleNewAssignee(u.id)}
                      style={{ accentColor: "var(--accent)", cursor: "pointer" }} />
                    <span style={{ flex: 1, fontSize: 13, color: "var(--text)", fontWeight: 600 }}>{u.name}</span>
                    <span style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>{u.role}</span>
                  </label>
                );
              })}
            {users.filter(u => {
              const q = assigneeSearch.trim().toLowerCase();
              if (!q) return true;
              return (u.name || "").toLowerCase().includes(q) || (u.role || "").toLowerCase().includes(q);
            }).length === 0 && (
              <div style={{ padding: 16, textAlign: "center", color: "var(--text3)", fontSize: 11, fontStyle: "italic" }}>No matches</div>
            )}
          </div>

          <label style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Due date *</label>
          <input type="date" value={newForm.due_date}
            onChange={e => setNewForm({ ...newForm, due_date: e.target.value })}
            style={{ padding: "10px 14px", background: "var(--bg4)", border: "1px solid var(--border2)", borderRadius: 8, color: "var(--text)", fontSize: 13 }} />

          <label style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Attach image (optional)</label>
          <input type="file" accept="image/*" onChange={e => setNewForm({ ...newForm, image: e.target.files?.[0] || null })}
            style={{ padding: "8px 12px", background: "var(--bg4)", border: "1px dashed var(--border2)", borderRadius: 8, color: "var(--text3)", fontSize: 12 }} />
          {newForm.image && <div style={{ fontSize: 11, color: "var(--accent)" }}>📎 {newForm.image.name}</div>}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
            <button onClick={() => setNewModal(false)} disabled={uploading}
              style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg3)", color: "var(--text3)", border: "1px solid var(--border2)", cursor: "pointer", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Cancel</button>
            <button onClick={handleCreate} disabled={uploading}
              style={{ padding: "10px 18px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", cursor: uploading ? "wait" : "pointer", fontWeight: 800, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, opacity: uploading ? 0.6 : 1 }}>
              {uploading ? "Uploading…" : "Create Task"}
            </button>
          </div>
        </div>
      </Modal>

      {/* Task detail modal */}
      <Modal isOpen={!!detail} onClose={() => { setDetail(null); setDateChange(null); }} title={detail?.title || ""} width={640}>
        {detail && (() => {
          const currentCol = COLUMNS.find(c => c.key === detail.status);
          const canEdit = isAdmin || taskHasUser(detail, currentUser?.id) || detail.assigned_by_id === currentUser?.id;
          const assigneeNames = detail.assignee_names?.length
            ? detail.assignee_names
            : (detail.assignee_name ? [detail.assignee_name] : taskAssignees(detail).map(id => usersById.get(id)?.name || ""));
          return (
            <div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
                <span style={{ padding: "4px 10px", borderRadius: 999, background: `rgba(${currentCol.rgb},0.15)`, color: currentCol.color, fontSize: 10, fontWeight: 800, letterSpacing: 1 }}>{currentCol.label}</span>
                <span style={{ fontSize: 11, color: "var(--text3)", display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                  Assigned to
                  {assigneeNames.filter(Boolean).map((n, i) => (
                    <strong key={i} style={{ color: "var(--accent)", padding: "2px 8px", borderRadius: 999, background: "rgba(var(--accent-rgb),0.12)", fontSize: 10 }}>{n}</strong>
                  ))}
                  {detail.assigned_by_name && <span>by {detail.assigned_by_name}</span>}
                </span>
              </div>

              {detail.description && (
                <div style={{ padding: "12px 14px", background: "var(--bg4)", borderRadius: 10, fontSize: 12, color: "var(--text2)", lineHeight: 1.5, whiteSpace: "pre-wrap", marginBottom: 14 }}>
                  {detail.description}
                </div>
              )}

              {detail.image_url && (
                <a href={detail.image_url} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={detail.image_url} alt="" style={{ width: "100%", maxHeight: 300, objectFit: "contain", borderRadius: 10, marginBottom: 14, border: "1px solid var(--border)" }} />
                </a>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 14 }}>
                <DetailStat label="Due" val={detail.due_date} color={detail.status !== "done" && detail.due_date < todayISO() ? "var(--red)" : "var(--text)"} />
                <DetailStat label="Started" val={detail.started_at ? new Date(detail.started_at).toLocaleDateString() : "—"} color="var(--orange)" />
                <DetailStat label="Completed" val={detail.completed_at ? new Date(detail.completed_at).toLocaleDateString() : "—"} color="var(--green)" />
              </div>

              {/* Status buttons */}
              {canEdit && (
                <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                  {COLUMNS.filter(c => c.key !== detail.status).map(c => (
                    <button key={c.key} onClick={() => moveTo(detail, c.key)}
                      style={{ padding: "8px 16px", borderRadius: 8, background: `rgba(${c.rgb},0.12)`, color: c.color, border: `1px solid rgba(${c.rgb},0.35)`, cursor: "pointer", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
                      Move to {c.label}
                    </button>
                  ))}
                </div>
              )}

              {/* Date change block */}
              {canEdit && (
                <div style={{ padding: 12, borderRadius: 10, border: "1px dashed var(--border2)", marginBottom: 14 }}>
                  {!dateChange ? (
                    <button onClick={() => setDateChange({ new_date: detail.due_date, reason: "" })}
                      style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg3)", color: "var(--accent)", border: "1px solid rgba(var(--accent-rgb),0.3)", cursor: "pointer", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
                      📅 Change Due Date
                    </button>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ fontSize: 10, fontWeight: 800, color: "var(--gold)", textTransform: "uppercase", letterSpacing: 1 }}>Change due date</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8 }}>
                        <input type="date" value={dateChange.new_date}
                          onChange={e => setDateChange({ ...dateChange, new_date: e.target.value })}
                          style={{ padding: "8px 12px", background: "var(--bg4)", border: "1px solid var(--border2)", borderRadius: 8, color: "var(--text)", fontSize: 12 }} />
                        <input type="text" placeholder="Reason (required)" value={dateChange.reason}
                          onChange={e => setDateChange({ ...dateChange, reason: e.target.value })}
                          style={{ padding: "8px 12px", background: "var(--bg4)", border: "1px solid var(--border2)", borderRadius: 8, color: "var(--text)", fontSize: 12 }} />
                      </div>
                      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                        <button onClick={() => setDateChange(null)}
                          style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg3)", color: "var(--text3)", border: "1px solid var(--border2)", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>Cancel</button>
                        <button onClick={saveDateChange}
                          style={{ padding: "8px 14px", borderRadius: 8, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 800 }}>Save</button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Date change history */}
              {(detail.date_changes || []).length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Date changes</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {detail.date_changes.map((c, i) => (
                      <div key={i} style={{ padding: "8px 12px", background: "var(--bg4)", borderRadius: 8, fontSize: 11, borderLeft: "3px solid var(--orange)" }}>
                        <div style={{ color: "var(--text2)", fontWeight: 700 }}>
                          <span style={{ color: "var(--text3)", textDecoration: "line-through" }}>{c.old_date}</span>
                          {" → "}
                          <span style={{ color: "var(--orange)" }}>{c.new_date}</span>
                        </div>
                        <div style={{ color: "var(--text3)", marginTop: 2 }}>{c.reason}</div>
                        <div style={{ color: "var(--text3)", opacity: 0.6, marginTop: 2, fontSize: 10 }}>by {c.changed_by} · {new Date(c.changed_at).toLocaleString()}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Delete (admin or creator only) */}
              {(isAdmin || detail.assigned_by_id === currentUser?.id) && (
                <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                  <button onClick={() => handleDelete(detail)}
                    style={{ padding: "8px 14px", borderRadius: 8, background: "rgba(248,113,113,0.1)", color: "var(--red)", border: "1px solid rgba(248,113,113,0.3)", cursor: "pointer", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
                    Delete Task
                  </button>
                </div>
              )}
            </div>
          );
        })()}
      </Modal>

      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}

function DetailStat({ label, val, color }) {
  return (
    <div style={{ padding: "10px 14px", background: "var(--bg4)", borderRadius: 10, border: "1px solid var(--border)" }}>
      <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 800, color, marginTop: 4 }}>{val}</div>
    </div>
  );
}
