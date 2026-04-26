"use client";
import { useEffect, useMemo, useState, useRef } from "react";
import { collection, onSnapshot, query, orderBy, addDoc, updateDoc, deleteDoc, doc, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { Card, Icon, IconBtn, Modal, SearchSelect, useConfirm, useToast } from "@/components/ui";
import VLoader from "@/components/VLoader";

// Canonical tag list — editable via the inline "Add tag" input in the form.
const DEFAULT_TAGS = [
  "Vendor", "Service Provider", "Emergency", "Landlord",
  "Legal", "Utility", "Staff", "Other",
];

// CSV import/export — the columns the template ships with and that the parser
// expects. Header order is fixed so users can't break import by reordering.
const CSV_HEADERS = ["name", "phone", "alt_phone", "email", "company", "tag", "notes"];

const csvEscape = (v) => {
  const s = (v ?? "").toString();
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function buildCSV(rows) {
  const lines = [CSV_HEADERS.join(",")];
  rows.forEach(r => lines.push(CSV_HEADERS.map(h => csvEscape(r[h])).join(",")));
  return lines.join("\r\n");
}

// Minimal RFC-4180-ish parser: handles quoted fields, escaped quotes, CRLF.
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v && v.trim() !== ""));
}

function downloadBlob(filename, body, mime) {
  const blob = new Blob([body], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// Phone is the de-facto unique key — strip everything except digits so
// "+91 98765-43210" and "9876543210" collide as the same person.
const normalizePhone = (p) => (p || "").toString().replace(/[^0-9]/g, "");

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
  const [tagDocs, setTagDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [view, setView] = useState("cards"); // "cards" | "table"
  const [editId, setEditId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", alt_phone: "", email: "", company: "", tag: "", notes: "" });
  const [addingTag, setAddingTag] = useState(false);
  const [newTagText, setNewTagText] = useState("");

  const fileInputRef = useRef(null);
  const [importPreview, setImportPreview] = useState(null); // { rows, errors, fileName } | null
  const [importing, setImporting] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [dupKeep, setDupKeep] = useState({}); // { groupKey: idToKeep }
  const [dupRemoving, setDupRemoving] = useState(false);

  useEffect(() => {
    if (!db || !canAccess) return;
    const unsubs = [
      onSnapshot(query(collection(db, "contacts"), orderBy("name", "asc")),
        sn => { setContacts(sn.docs.map(d => ({ ...d.data(), id: d.id }))); setLoading(false); },
        () => setLoading(false)),
      onSnapshot(collection(db, "contact_tags"),
        sn => setTagDocs(sn.docs.map(d => ({ ...d.data(), id: d.id }))),
        () => {}),
    ];
    return () => unsubs.forEach(u => u());
  }, [canAccess]);

  // Three sources roll up into the master tag list: defaults, persisted tags
  // (added via the "+ Add new" UI), and any tag already in use on a contact.
  const allTags = useMemo(() => {
    const set = new Set(DEFAULT_TAGS);
    tagDocs.forEach(t => { if (t.name) set.add(t.name); });
    contacts.forEach(c => { if (c.tag) set.add(c.tag); });
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [contacts, tagDocs]);

  const addNewTag = async (raw) => {
    const name = (raw || "").trim();
    if (!name) return null;
    if (allTags.some(t => t.toLowerCase() === name.toLowerCase())) {
      toast({ title: "Already exists", message: `Tag "${name}" is already in the list.`, type: "warning" });
      return name;
    }
    try {
      await addDoc(collection(db, "contact_tags"), {
        name,
        created_at: new Date().toISOString(),
        created_by: currentUser?.name || "user",
      });
      toast({ title: "Tag added", message: `"${name}" is now in the tag list and CSV template.`, type: "success" });
      return name;
    } catch (e) {
      confirm({ title: "Could not add tag", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} });
      return null;
    }
  };

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

  const downloadTemplate = () => {
    // Top of the file is one reference row per known tag — gives the user a
    // copy-pasteable list of every valid tag (CSVs can't do real dropdowns).
    // Followed by blank rows for actual data entry.
    const tagList = allTags.length > 0 ? allTags : DEFAULT_TAGS;
    const refRows = tagList.map((t, i) => ({
      name: i === 0 ? "Acme Plumbing (sample — replace or delete)" : `Sample for tag: ${t}`,
      phone: i === 0 ? "+91 98765 43210" : "",
      alt_phone: "", email: i === 0 ? "support@acme.example" : "",
      company: i === 0 ? "Acme Pvt Ltd" : "",
      tag: t,
      notes: i === 0 ? "Pipe leak guy — bill cycle 30 days" : `Use this tag for ${t.toLowerCase()} contacts`,
    }));
    const blanks = Array.from({ length: 5 }, () => ({ name: "", phone: "", alt_phone: "", email: "", company: "", tag: "", notes: "" }));
    downloadBlob("vcut_contacts_template.csv", buildCSV([...refRows, ...blanks]), "text/csv");
    toast({ title: "Template ready", message: `Includes ${tagList.length} reference row${tagList.length === 1 ? "" : "s"} for every available tag. Replace or delete them, then upload.`, type: "success" });
  };

  const triggerUpload = () => fileInputRef.current?.click();

  const handleFilePicked = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking same file
    if (!file) return;
    try {
      const text = await file.text();
      const grid = parseCSV(text);
      if (grid.length === 0) {
        toast({ title: "Empty file", message: "No rows found in the CSV.", type: "warning" });
        return;
      }
      const headerRow = grid[0].map(h => h.trim().toLowerCase());
      const colIdx = Object.fromEntries(CSV_HEADERS.map(h => [h, headerRow.indexOf(h)]));
      if (colIdx.name === -1 || colIdx.phone === -1) {
        toast({ title: "Bad header", message: `CSV must include "name" and "phone" columns. Download the template for the right format.`, type: "warning" });
        return;
      }
      const rows = [];
      const errors = [];
      const seenPhones = new Set();
      for (let i = 1; i < grid.length; i++) {
        const r = grid[i];
        const get = (k) => (colIdx[k] >= 0 ? (r[colIdx[k]] || "").trim() : "");
        const name = get("name");
        const phone = get("phone");
        if (!name && !phone) continue;
        if (!name) { errors.push({ line: i + 1, reason: "Missing name" }); continue; }
        if (!phone) { errors.push({ line: i + 1, reason: "Missing phone" }); continue; }
        const np = normalizePhone(phone);
        if (seenPhones.has(np)) { errors.push({ line: i + 1, reason: `Duplicate phone in file (${phone})` }); continue; }
        seenPhones.add(np);
        rows.push({
          name, phone,
          alt_phone: get("alt_phone"),
          email: get("email"),
          company: get("company"),
          tag: get("tag"),
          notes: get("notes"),
        });
      }
      setImportPreview({ rows, errors, fileName: file.name });
    } catch (err) {
      toast({ title: "Read failed", message: err.message, type: "danger" });
    }
  };

  const confirmImport = async () => {
    if (!importPreview || importPreview.rows.length === 0) return;
    setImporting(true);
    try {
      // Firestore batches cap at 500 writes; chunk to be safe for big imports.
      const chunks = [];
      for (let i = 0; i < importPreview.rows.length; i += 400) chunks.push(importPreview.rows.slice(i, i + 400));
      const stamp = new Date().toISOString();
      const author = currentUser?.name || "user";
      for (const chunk of chunks) {
        const batch = writeBatch(db);
        chunk.forEach(r => {
          const ref = doc(collection(db, "contacts"));
          batch.set(ref, { ...r, created_at: stamp, created_by: author });
        });
        await batch.commit();
      }
      toast({ title: "Imported", message: `${importPreview.rows.length} contact${importPreview.rows.length === 1 ? "" : "s"} added.`, type: "success" });
      setImportPreview(null);
    } catch (err) {
      confirm({ title: "Import failed", message: err.message, confirmText: "OK", type: "danger", onConfirm: () => {} });
    } finally {
      setImporting(false);
    }
  };

  // Group contacts by normalised phone; any group with 2+ entries is a duplicate set.
  const duplicateGroups = useMemo(() => {
    const map = new Map();
    contacts.forEach(c => {
      const k = normalizePhone(c.phone);
      if (!k) return;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(c);
    });
    return [...map.entries()]
      .filter(([, list]) => list.length >= 2)
      .map(([k, list]) => ({
        key: k,
        list: [...list].sort((a, b) => (a.created_at || "").localeCompare(b.created_at || "")),
      }));
  }, [contacts]);

  const openDuplicates = () => {
    // Default: keep the oldest (first) record in each group.
    const seed = {};
    duplicateGroups.forEach(g => { seed[g.key] = g.list[0]?.id; });
    setDupKeep(seed);
    setDupOpen(true);
  };

  const removeDuplicates = async () => {
    const toDelete = [];
    duplicateGroups.forEach(g => {
      const keepId = dupKeep[g.key];
      g.list.forEach(c => { if (c.id !== keepId) toDelete.push(c.id); });
    });
    if (toDelete.length === 0) {
      toast({ title: "Nothing to remove", message: "Pick which record to keep in each group.", type: "warning" });
      return;
    }
    setDupRemoving(true);
    try {
      const chunks = [];
      for (let i = 0; i < toDelete.length; i += 400) chunks.push(toDelete.slice(i, i + 400));
      for (const chunk of chunks) {
        const batch = writeBatch(db);
        chunk.forEach(id => batch.delete(doc(db, "contacts", id)));
        await batch.commit();
      }
      toast({ title: "Removed", message: `${toDelete.length} duplicate${toDelete.length === 1 ? "" : "s"} deleted.`, type: "success" });
      setDupOpen(false);
    } catch (err) {
      confirm({ title: "Delete failed", message: err.message, confirmText: "OK", type: "danger", onConfirm: () => {} });
    } finally {
      setDupRemoving(false);
    }
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
          <button onClick={downloadTemplate}
            title="Download a CSV template you can fill and re-upload"
            style={{ padding: "10px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text2)", fontWeight: 800, fontSize: 11, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Icon name="save" size={12} /> Template
          </button>
          <button onClick={triggerUpload}
            title="Bulk-import contacts from a filled CSV"
            style={{ padding: "10px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid rgba(96,165,250,0.4)", color: "var(--blue, #60a5fa)", fontWeight: 800, fontSize: 11, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Icon name="edit" size={12} /> Import CSV
          </button>
          <input ref={fileInputRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={handleFilePicked} />
          <button onClick={openDuplicates} disabled={duplicateGroups.length === 0}
            title={duplicateGroups.length === 0 ? "No duplicates detected" : `Review ${duplicateGroups.length} duplicate group${duplicateGroups.length === 1 ? "" : "s"}`}
            style={{ padding: "10px 14px", borderRadius: 10, background: duplicateGroups.length === 0 ? "var(--bg4)" : "var(--bg3)", border: `1px solid ${duplicateGroups.length === 0 ? "var(--border)" : "rgba(248,113,113,0.4)"}`, color: duplicateGroups.length === 0 ? "var(--text3)" : "var(--red)", fontWeight: 800, fontSize: 11, cursor: duplicateGroups.length === 0 ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Icon name="del" size={12} /> Duplicates {duplicateGroups.length > 0 ? `(${duplicateGroups.length})` : ""}
          </button>
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

      {/* Search + view toggle */}
      <Card style={{ padding: 14, marginBottom: 16, overflow: "visible" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, phone number, company, group/tag, note…"
            style={{ ...inp, fontSize: 13.5, flex: 1, minWidth: 240 }} />
          <div style={{ display: "inline-flex", gap: 2, padding: 3, borderRadius: 8, background: "var(--bg4)" }}>
            {[["cards", "Cards"], ["table", "Table by Group"]].map(([v, l]) => (
              <button key={v} onClick={() => setView(v)}
                style={{ padding: "8px 14px", borderRadius: 6, fontSize: 11, fontWeight: 800, border: "none", cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5,
                  background: view === v ? "linear-gradient(135deg,var(--accent),var(--gold2))" : "transparent",
                  color: view === v ? "#000" : "var(--text3)" }}>
                {l}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {/* Contact cards / table-by-group */}
      {filtered.length === 0 ? (
        <Card style={{ padding: 40, textAlign: "center", color: "var(--text3)", fontSize: 13 }}>
          {contacts.length === 0
            ? <>No contacts yet. Click <strong style={{ color: "var(--accent)" }}>Add Contact</strong> to save your first number.</>
            : <>No matches for your search.</>}
        </Card>
      ) : view === "table" ? (() => {
        // Group filtered list by tag (uses "Untagged" bucket for blanks).
        const grouped = new Map();
        filtered.forEach(c => {
          const k = (c.tag || "").trim() || "Untagged";
          if (!grouped.has(k)) grouped.set(k, []);
          grouped.get(k).push(c);
        });
        const groups = [...grouped.entries()]
          .sort((a, b) => {
            if (a[0] === "Untagged") return 1;
            if (b[0] === "Untagged") return -1;
            return a[0].localeCompare(b[0]);
          });
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {groups.map(([tag, list]) => (
              <Card key={tag} style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "10px 14px", background: "linear-gradient(90deg, rgba(var(--accent-rgb),0.12), transparent)", borderBottom: "1px solid var(--border2)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: tag === "Untagged" ? "var(--text3)" : "var(--accent)", textTransform: "uppercase", letterSpacing: 1 }}>{tag}</span>
                    <span style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700 }}>{list.length} contact{list.length === 1 ? "" : "s"}</span>
                  </div>
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: "var(--bg4)" }}>
                        {["Name", "Phone", "Alt Phone", "Company", "Email", "Notes", ""].map((h, i) => (
                          <th key={h + i} style={{ padding: "8px 10px", textAlign: i === 6 ? "center" : "left", fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.8, fontSize: 10, borderBottom: "1px solid var(--border2)", whiteSpace: "nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {list.map(c => (
                        <tr key={c.id} style={{ borderBottom: "1px solid var(--border)" }}>
                          <td style={{ padding: "8px 10px", fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap" }}>{c.name}</td>
                          <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                            {c.phone ? <a href={`tel:${c.phone}`} style={{ color: "var(--green)", textDecoration: "none", fontWeight: 700 }}>{c.phone}</a> : "—"}
                          </td>
                          <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>
                            {c.alt_phone ? <a href={`tel:${c.alt_phone}`} style={{ color: "var(--blue, #60a5fa)", textDecoration: "none" }}>{c.alt_phone}</a> : "—"}
                          </td>
                          <td style={{ padding: "8px 10px", color: "var(--text2)" }}>{c.company || "—"}</td>
                          <td style={{ padding: "8px 10px", color: "var(--text3)" }}>
                            {c.email ? <a href={`mailto:${c.email}`} style={{ color: "var(--text2)", textDecoration: "none" }}>{c.email}</a> : "—"}
                          </td>
                          <td style={{ padding: "8px 10px", color: "var(--text3)", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.notes || ""}>{c.notes || "—"}</td>
                          <td style={{ padding: "8px 10px", textAlign: "center", whiteSpace: "nowrap" }}>
                            <div style={{ display: "inline-flex", gap: 4 }}>
                              <IconBtn name="save" variant="secondary" title="Download vCard" onClick={() => downloadOne(c)} />
                              <IconBtn name="edit" variant="secondary" title="Edit" onClick={() => openEdit(c)} />
                              <IconBtn name="del" variant="danger" title="Delete" onClick={() => handleDelete(c)} />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            ))}
          </div>
        );
      })() : (
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
              <label style={{ fontSize: 10, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6, display: "block" }}>Tag / Group</label>
              {!addingTag ? (
                <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <SearchSelect
                      value={form.tag}
                      onChange={(v) => setForm(f => ({ ...f, tag: v }))}
                      options={allTags.map(t => ({ value: t, label: t }))}
                      placeholder="Select tag…"
                      minWidth={0}
                      buttonStyle={{ padding: "10px 12px", borderRadius: 10, background: "var(--bg4)", color: "var(--text)", fontSize: 13 }}
                    />
                  </div>
                  <button type="button" onClick={() => { setNewTagText(""); setAddingTag(true); }}
                    title="Add a new tag — it'll persist for future contacts and the CSV template"
                    style={{ padding: "8px 12px", borderRadius: 10, background: "rgba(34,211,238,0.12)", color: "var(--accent)", border: "1px solid rgba(34,211,238,0.4)", cursor: "pointer", fontSize: 11, fontWeight: 800, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <Icon name="plus" size={11} /> New
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
                  <input autoFocus value={newTagText} onChange={e => setNewTagText(e.target.value)}
                    onKeyDown={async (e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const saved = await addNewTag(newTagText);
                        if (saved) { setForm(f => ({ ...f, tag: saved })); setAddingTag(false); setNewTagText(""); }
                      } else if (e.key === "Escape") { setAddingTag(false); setNewTagText(""); }
                    }}
                    placeholder="New tag name (e.g. Insurance)…" style={{ ...inp, flex: 1 }} />
                  <button type="button" onClick={async () => {
                    const saved = await addNewTag(newTagText);
                    if (saved) { setForm(f => ({ ...f, tag: saved })); setAddingTag(false); setNewTagText(""); }
                  }}
                    style={{ padding: "8px 14px", borderRadius: 10, background: "var(--green)", color: "#000", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 800, whiteSpace: "nowrap" }}>
                    Save
                  </button>
                  <button type="button" onClick={() => { setAddingTag(false); setNewTagText(""); }}
                    style={{ padding: "8px 12px", borderRadius: 10, background: "var(--bg4)", color: "var(--text3)", border: "1px solid var(--border2)", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
                    ×
                  </button>
                </div>
              )}
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

      {/* CSV Import Preview */}
      <Modal isOpen={!!importPreview} onClose={() => !importing && setImportPreview(null)} title="Review Import" width={620}>
        <div style={{ padding: 20 }}>
          {importPreview && (
            <>
              <div style={{ fontSize: 12, color: "var(--text2)", marginBottom: 10 }}>
                <strong style={{ color: "var(--text)" }}>{importPreview.fileName}</strong> · {importPreview.rows.length} ready · {importPreview.errors.length} skipped
              </div>
              {importPreview.errors.length > 0 && (
                <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.3)", maxHeight: 120, overflowY: "auto" }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: "var(--red)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Skipped rows</div>
                  {importPreview.errors.map((er, i) => (
                    <div key={i} style={{ fontSize: 11, color: "var(--text2)" }}>Line {er.line}: {er.reason}</div>
                  ))}
                </div>
              )}
              {importPreview.rows.length > 0 ? (
                <div style={{ maxHeight: 280, overflowY: "auto", border: "1px solid var(--border2)", borderRadius: 8 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
                    <thead>
                      <tr style={{ background: "var(--bg4)" }}>
                        {["Name", "Phone", "Company", "Tag"].map(h => (
                          <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 0.8, fontSize: 10, borderBottom: "1px solid var(--border2)" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {importPreview.rows.slice(0, 50).map((r, i) => (
                        <tr key={i} style={{ borderBottom: "1px solid var(--border2)" }}>
                          <td style={{ padding: "6px 10px", color: "var(--text)", fontWeight: 600 }}>{r.name}</td>
                          <td style={{ padding: "6px 10px", color: "var(--text2)" }}>{r.phone}</td>
                          <td style={{ padding: "6px 10px", color: "var(--text3)" }}>{r.company}</td>
                          <td style={{ padding: "6px 10px", color: "var(--text3)" }}>{r.tag}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {importPreview.rows.length > 50 && (
                    <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text3)", textAlign: "center", background: "var(--bg4)" }}>
                      … +{importPreview.rows.length - 50} more rows
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ padding: 20, textAlign: "center", color: "var(--text3)", fontSize: 12 }}>No valid rows to import.</div>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 16 }}>
                <button onClick={() => setImportPreview(null)} disabled={importing}
                  style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: importing ? "not-allowed" : "pointer" }}>Cancel</button>
                <button onClick={confirmImport} disabled={importing || importPreview.rows.length === 0}
                  style={{ padding: "10px 22px", borderRadius: 10, background: importPreview.rows.length === 0 ? "var(--bg4)" : "linear-gradient(135deg,var(--accent),var(--gold2))", color: importPreview.rows.length === 0 ? "var(--text3)" : "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: importing || importPreview.rows.length === 0 ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
                  {importing ? "Importing…" : `Import ${importPreview.rows.length}`}
                </button>
              </div>
            </>
          )}
        </div>
      </Modal>

      {/* Duplicate review */}
      <Modal isOpen={dupOpen} onClose={() => !dupRemoving && setDupOpen(false)} title={`Duplicates (${duplicateGroups.length} group${duplicateGroups.length === 1 ? "" : "s"})`} width={680}>
        <div style={{ padding: 20 }}>
          {duplicateGroups.length === 0 ? (
            <div style={{ padding: 20, textAlign: "center", color: "var(--text3)", fontSize: 13 }}>No duplicates detected.</div>
          ) : (
            <>
              <div style={{ fontSize: 12, color: "var(--text2)", marginBottom: 12, lineHeight: 1.5 }}>
                Records sharing the same phone number. Pick which one to <strong style={{ color: "var(--green)" }}>keep</strong> in each group; the others will be deleted.
              </div>
              <div style={{ maxHeight: 380, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
                {duplicateGroups.map(g => (
                  <div key={g.key} style={{ border: "1px solid rgba(248,113,113,0.3)", borderRadius: 10, padding: 10, background: "rgba(248,113,113,0.04)" }}>
                    <div style={{ fontSize: 10, fontWeight: 800, color: "var(--red)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
                      Phone {g.list[0].phone} · {g.list.length} records
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {g.list.map(c => {
                        const keep = dupKeep[g.key] === c.id;
                        return (
                          <label key={c.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: 8, borderRadius: 8, background: keep ? "rgba(74,222,128,0.08)" : "var(--bg3)", border: `1px solid ${keep ? "rgba(74,222,128,0.4)" : "var(--border2)"}`, cursor: "pointer" }}>
                            <input type="radio" name={`keep-${g.key}`} checked={keep}
                              onChange={() => setDupKeep(s => ({ ...s, [g.key]: c.id }))}
                              style={{ marginTop: 3, accentColor: "var(--green)" }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{c.name}</div>
                              <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>
                                {[c.company, c.tag, c.email].filter(Boolean).join(" · ") || <em style={{ opacity: 0.6 }}>no extra info</em>}
                              </div>
                              <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 3 }}>
                                Added {c.created_at ? new Date(c.created_at).toLocaleString() : "—"}{c.created_by ? ` · ${c.created_by}` : ""}
                              </div>
                            </div>
                            {keep && <span style={{ fontSize: 10, fontWeight: 800, color: "var(--green)", textTransform: "uppercase", letterSpacing: 0.5 }}>Keep</span>}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16, gap: 10 }}>
                <div style={{ fontSize: 11, color: "var(--text3)" }}>
                  Will delete <strong style={{ color: "var(--red)" }}>{duplicateGroups.reduce((n, g) => n + g.list.filter(c => c.id !== dupKeep[g.key]).length, 0)}</strong> record(s)
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <button onClick={() => setDupOpen(false)} disabled={dupRemoving}
                    style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: dupRemoving ? "not-allowed" : "pointer" }}>Cancel</button>
                  <button onClick={removeDuplicates} disabled={dupRemoving}
                    style={{ padding: "10px 22px", borderRadius: 10, background: "linear-gradient(135deg,#ef4444,#b91c1c)", color: "#fff", border: "none", fontWeight: 800, fontSize: 12, cursor: dupRemoving ? "not-allowed" : "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
                    {dupRemoving ? "Removing…" : "Remove Duplicates"}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </Modal>

      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}
