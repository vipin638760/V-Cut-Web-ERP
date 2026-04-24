"use client";
import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, orderBy, addDoc, updateDoc, deleteDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { Card, Icon, IconBtn, Modal, useConfirm, useToast } from "@/components/ui";
import VLoader from "@/components/VLoader";

// Canonical tag list — editable via the inline "Add tag" input in the form.
const DEFAULT_TAGS = [
  "Vendor", "Service Provider", "Emergency", "Landlord",
  "Legal", "Utility", "Staff", "Other",
];

// vCard 3.0 encoder — pure text so mobile phones recognise the .vcf file and
// import every card in one go. Escapes commas/semicolons/newlines per RFC 2426.
const vcardEscape = (v) => (v || "").toString().replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
function contactToVCard(c) {
  const last = "";
  const first = c.name || "";
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${vcardEscape(first)}`,
    `N:${vcardEscape(last)};${vcardEscape(first)};;;`,
  ];
  if (c.phone) lines.push(`TEL;TYPE=CELL:${vcardEscape(c.phone)}`);
  if (c.alt_phone) lines.push(`TEL;TYPE=WORK:${vcardEscape(c.alt_phone)}`);
  if (c.email) lines.push(`EMAIL:${vcardEscape(c.email)}`);
  if (c.company) lines.push(`ORG:${vcardEscape(c.company)}`);
  if (c.tag) lines.push(`CATEGORIES:${vcardEscape(c.tag)}`);
  if (c.notes) lines.push(`NOTE:${vcardEscape(c.notes)}`);
  lines.push("END:VCARD");
  return lines.join("\r\n");
}
function downloadVCard(filename, body) {
  const blob = new Blob([body], { type: "text/vcard;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".vcf") ? filename : `${filename}.vcf`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export default function ContactsPage() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const currentUser = useCurrentUser() || {};
  const canAccess = ["admin", "accountant"].includes(currentUser.role);

  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [editId, setEditId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", alt_phone: "", email: "", company: "", tag: "", notes: "" });

  useEffect(() => {
    if (!db || !canAccess) return;
    const unsub = onSnapshot(query(collection(db, "contacts"), orderBy("name", "asc")),
      sn => { setContacts(sn.docs.map(d => ({ ...d.data(), id: d.id }))); setLoading(false); },
      () => setLoading(false));
    return () => unsub();
  }, [canAccess]);

  const allTags = useMemo(() => {
    const set = new Set(DEFAULT_TAGS);
    contacts.forEach(c => { if (c.tag) set.add(c.tag); });
    return [...set].sort();
  }, [contacts]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return contacts.filter(c => {
      if (tagFilter && (c.tag || "") !== tagFilter) return false;
      if (!q) return true;
      return [c.name, c.phone, c.alt_phone, c.email, c.company, c.tag, c.notes]
        .filter(Boolean)
        .some(v => v.toString().toLowerCase().includes(q));
    });
  }, [contacts, search, tagFilter]);

  const byTag = useMemo(() => {
    const map = new Map();
    contacts.forEach(c => {
      const k = c.tag || "Other";
      if (!map.has(k)) map.set(k, 0);
      map.set(k, map.get(k) + 1);
    });
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [contacts]);

  const resetForm = () => setForm({ name: "", phone: "", alt_phone: "", email: "", company: "", tag: "", notes: "" });

  const openAdd = () => {
    resetForm();
    setEditId(null);
    setShowForm(true);
  };

  const openEdit = (c) => {
    setForm({
      name: c.name || "",
      phone: c.phone || "",
      alt_phone: c.alt_phone || "",
      email: c.email || "",
      company: c.company || "",
      tag: c.tag || "",
      notes: c.notes || "",
    });
    setEditId(c.id);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.phone.trim()) {
      toast({ title: "Missing info", message: "Name and Phone are required.", type: "warning" });
      return;
    }
    try {
      const payload = {
        name: form.name.trim(),
        phone: form.phone.trim(),
        alt_phone: form.alt_phone.trim(),
        email: form.email.trim(),
        company: form.company.trim(),
        tag: form.tag.trim(),
        notes: form.notes.trim(),
      };
      if (editId) {
        await updateDoc(doc(db, "contacts", editId), {
          ...payload,
          updated_at: new Date().toISOString(),
          updated_by: currentUser?.name || "user",
        });
        toast({ title: "Updated", message: `${payload.name} saved.`, type: "success" });
      } else {
        await addDoc(collection(db, "contacts"), {
          ...payload,
          created_at: new Date().toISOString(),
          created_by: currentUser?.name || "user",
        });
        toast({ title: "Added", message: `${payload.name} saved.`, type: "success" });
      }
      setShowForm(false);
      setEditId(null);
      resetForm();
    } catch (e) {
      confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} });
    }
  };

  const handleDelete = (c) => {
    confirm({
      title: "Delete Contact",
      message: `Delete <strong>${c.name}</strong>${c.company ? ` (${c.company})` : ""}?`,
      confirmText: "Delete",
      cancelText: "Cancel",
      type: "danger",
      onConfirm: async () => {
        try {
          await deleteDoc(doc(db, "contacts", c.id));
          toast({ title: "Deleted", message: `${c.name} removed.`, type: "success" });
        } catch (e) {
          confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} });
        }
      },
    });
  };

  const downloadOne = (c) => {
    downloadVCard(`${c.name.replace(/[^a-zA-Z0-9]/g, "_")}_vcard`, contactToVCard(c));
  };

  const downloadAll = () => {
    if (filtered.length === 0) return;
    // Multi-card .vcf: just concatenate — every phone OS imports them all.
    const body = filtered.map(contactToVCard).join("\r\n");
    const ts = new Date().toISOString().slice(0, 10);
    const fname = tagFilter
      ? `vcut_contacts_${tagFilter.replace(/[^a-zA-Z0-9]/g, "_")}_${ts}`
      : `vcut_contacts_${ts}`;
    downloadVCard(fname, body);
    toast({ title: "Downloaded", message: `${filtered.length} contact${filtered.length === 1 ? "" : "s"} exported as .vcf — open on phone to import.`, type: "success" });
  };

  if (!canAccess) {
    return (
      <Card style={{ padding: 40, textAlign: "center" }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: "var(--red)" }}>Access Restricted</div>
        <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 6 }}>
          The contact directory is visible to admin and accountant roles only.
        </div>
      </Card>
    );
  }

  if (loading && contacts.length === 0) return <VLoader fullscreen label="Loading Contacts" />;

  const inp = { padding: "10px 12px", borderRadius: 10, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, outline: "none", width: "100%", boxSizing: "border-box" };

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 2 }}>Directory</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>Important Contacts</div>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, marginTop: 4 }}>
            Vendor / staff / emergency numbers · admin + accountant only
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={downloadAll} disabled={filtered.length === 0}
            title={filtered.length === 0 ? "No contacts to export" : `Export ${filtered.length} contact${filtered.length === 1 ? "" : "s"} as .vcf (import into your phone)`}
            style={{ padding: "10px 16px", borderRadius: 10, background: filtered.length === 0 ? "var(--bg4)" : "var(--bg3)", border: `1px solid ${filtered.length === 0 ? "var(--border)" : "rgba(74,222,128,0.4)"}`, color: filtered.length === 0 ? "var(--text3)" : "var(--green)", fontWeight: 800, fontSize: 11, cursor: filtered.length === 0 ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Icon name="save" size={12} /> Download .vcf
          </button>
          <button onClick={openAdd}
            style={{ padding: "10px 18px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 11, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Icon name="plus" size={14} /> Add Contact
          </button>
        </div>
      </div>

      {/* KPI strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 16 }}>
        {[
          ["Total Contacts", contacts.length, "var(--accent)"],
          ["Tags Used", byTag.length, "var(--gold)"],
          ["Showing", filtered.length, "var(--green)"],
        ].map(([l, v, c]) => (
          <div key={l} style={{ padding: 14, borderRadius: 12, background: "var(--bg3)", border: "1px solid var(--border)" }}>
            <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: c, marginTop: 4 }}>{v}</div>
          </div>
        ))}
      </div>

      {/* Tag pills — click to filter */}
      {byTag.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
          <button onClick={() => setTagFilter("")}
            style={{ padding: "6px 12px", borderRadius: 999, background: tagFilter === "" ? "linear-gradient(135deg,var(--accent),var(--gold2))" : "var(--bg3)", color: tagFilter === "" ? "#000" : "var(--text3)", border: tagFilter === "" ? "none" : "1px solid var(--border2)", fontSize: 11, fontWeight: 800, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
            All ({contacts.length})
          </button>
          {byTag.map(([tag, count]) => (
            <button key={tag} onClick={() => setTagFilter(tag === tagFilter ? "" : tag)}
              style={{ padding: "6px 12px", borderRadius: 999, background: tagFilter === tag ? "rgba(var(--accent-rgb),0.2)" : "var(--bg3)", color: tagFilter === tag ? "var(--accent)" : "var(--text2)", border: `1px solid ${tagFilter === tag ? "rgba(var(--accent-rgb),0.45)" : "var(--border2)"}`, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              {tag} <span style={{ color: "var(--text3)", marginLeft: 4 }}>{count}</span>
            </button>
          ))}
        </div>
      )}

      {/* Search */}
      <Card style={{ padding: 14, marginBottom: 16, overflow: "visible" }}>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search by name, phone, company, tag, note…"
          style={{ ...inp, fontSize: 13.5 }} />
      </Card>

      {/* Contact cards */}
      {filtered.length === 0 ? (
        <Card style={{ padding: 40, textAlign: "center", color: "var(--text3)", fontSize: 13 }}>
          {contacts.length === 0
            ? <>No contacts yet. Click <strong style={{ color: "var(--accent)" }}>Add Contact</strong> to save your first number.</>
            : <>No matches for your search.</>}
        </Card>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 12 }}>
          {filtered.map(c => (
            <Card key={c.id} style={{ padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis" }} title={c.name}>{c.name}</div>
                  {c.company && <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, marginTop: 2 }}>{c.company}</div>}
                  {c.tag && (
                    <span style={{ display: "inline-block", marginTop: 6, padding: "2px 8px", borderRadius: 999, background: "rgba(var(--accent-rgb),0.12)", color: "var(--accent)", fontSize: 9.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.8 }}>
                      {c.tag}
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <IconBtn name="save" variant="secondary" title="Download this contact's vCard" onClick={() => downloadOne(c)} />
                  <IconBtn name="edit" variant="secondary" title="Edit" onClick={() => openEdit(c)} />
                  <IconBtn name="del" variant="danger" title="Delete" onClick={() => handleDelete(c)} />
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {c.phone && (
                  <a href={`tel:${c.phone}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700, color: "var(--green)", textDecoration: "none" }}>
                    <span style={{ fontSize: 11 }}>📞</span> {c.phone}
                  </a>
                )}
                {c.alt_phone && (
                  <a href={`tel:${c.alt_phone}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--blue, #60a5fa)", textDecoration: "none" }}>
                    <span style={{ fontSize: 10 }}>📞</span> {c.alt_phone}
                  </a>
                )}
                {c.email && (
                  <a href={`mailto:${c.email}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--text2)", textDecoration: "none" }}>
                    <span style={{ fontSize: 10 }}>✉️</span> {c.email}
                  </a>
                )}
                {c.notes && (
                  <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 4, lineHeight: 1.5, padding: "6px 8px", background: "var(--bg4)", borderRadius: 6, border: "1px dashed var(--border2)" }}>
                    {c.notes}
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Add / Edit Modal */}
      <Modal isOpen={showForm} onClose={() => { setShowForm(false); setEditId(null); }} title={editId ? "Edit Contact" : "Add Contact"} width={540}>
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "block" }}>Name <span style={{ color: "var(--red)" }}>*</span></label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={inp} placeholder="Contact name" autoFocus />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "block" }}>Primary Phone <span style={{ color: "var(--red)" }}>*</span></label>
              <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} style={inp} placeholder="+91 98765 43210" inputMode="tel" />
            </div>
            <div>
              <label style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "block" }}>Alt Phone</label>
              <input value={form.alt_phone} onChange={e => setForm(f => ({ ...f, alt_phone: e.target.value }))} style={inp} placeholder="Optional" inputMode="tel" />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "block" }}>Company</label>
              <input value={form.company} onChange={e => setForm(f => ({ ...f, company: e.target.value }))} style={inp} placeholder="Optional" />
            </div>
            <div>
              <label style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "block" }}>Tag</label>
              <input value={form.tag} onChange={e => setForm(f => ({ ...f, tag: e.target.value }))}
                list="contact-tag-options"
                placeholder="Vendor / Emergency / custom…" style={inp} />
              <datalist id="contact-tag-options">
                {allTags.map(t => <option key={t} value={t} />)}
              </datalist>
            </div>
          </div>
          <div>
            <label style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "block" }}>Email</label>
            <input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} style={inp} placeholder="Optional" type="email" />
          </div>
          <div>
            <label style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "block" }}>Notes</label>
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={3}
              placeholder="Context for the follow-up (who referred, payment cycle, etc.)"
              style={{ ...inp, resize: "vertical", fontFamily: "inherit" }} />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 4 }}>
            <button onClick={() => { setShowForm(false); setEditId(null); }}
              style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Cancel</button>
            <button onClick={handleSave}
              style={{ padding: "10px 22px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
              {editId ? "Save Changes" : "Add Contact"}
            </button>
          </div>
        </div>
      </Modal>

      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}
