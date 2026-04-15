"use client";
import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, orderBy, where, addDoc, updateDoc, deleteDoc, doc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { Icon, IconBtn, Card, TH, TD, Modal, useConfirm, useToast } from "@/components/ui";
import { INR } from "@/lib/calculations";
import BillPrintModal from "@/components/BillPrintModal";

const emptyForm = { name: "", phone: "", email: "", address: "", birthdate: "", marriage_date: "", notes: "" };

export default function CustomersPage() {
  const [customers, setCustomers] = useState([]);
  const [entries, setEntries] = useState([]);
  const [customerInvoices, setCustomerInvoices] = useState([]); // invoices for the customer currently inspected
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState(null); // null | { id?, ...form }
  const [detailOf, setDetailOf] = useState(null); // customer being inspected
  const [invoicePreview, setInvoicePreview] = useState(null); // bill to re-open/print
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const currentUser = useCurrentUser() || {};
  const canEdit = ["admin", "accountant"].includes(currentUser?.role);

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "customers"), sn => {
        setCustomers(sn.docs.map(d => ({ ...d.data(), id: d.id })));
        setLoading(false);
      }),
      onSnapshot(query(collection(db, "entries"), orderBy("date", "desc")), sn =>
        setEntries(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  // Load the selected customer's invoices on demand (avoids pulling every invoice at list view).
  useEffect(() => {
    if (!db || !detailOf?.id) return;
    const q = query(
      collection(db, "invoices"),
      where("customer_id", "==", detailOf.id),
    );
    const unsub = onSnapshot(q, sn =>
      setCustomerInvoices(sn.docs.map(d => ({ ...d.data(), id: d.id })).filter(i => i.status === "settled"))
    );
    return () => { unsub(); setCustomerInvoices([]); };
  }, [detailOf?.id]);

  // Build a visits index by customer_id from entries so we can show visit count + last visit
  const visitsByCustomer = useMemo(() => {
    const m = new Map();
    entries.forEach(e => {
      if (!e.customer_id) return;
      const cur = m.get(e.customer_id) || { visits: 0, last: null, totalBilling: 0 };
      cur.visits += 1;
      if (!cur.last || (e.date && e.date > cur.last)) cur.last = e.date;
      const totalBill = (e.staff_billing || []).reduce((s, sb) => s + (sb.billing || 0) + (sb.material || 0), 0);
      cur.totalBilling += totalBill;
      m.set(e.customer_id, cur);
    });
    return m;
  }, [entries]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q === ""
      ? customers
      : customers.filter(c =>
          (c.name || "").toLowerCase().includes(q) ||
          (c.phone || "").toLowerCase().includes(q) ||
          (c.email || "").toLowerCase().includes(q)
        );
    return list.slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [customers, search]);

  const openNew = () => setEditing({ ...emptyForm });
  const openEdit = (c) => setEditing({
    id: c.id,
    name: c.name || "",
    phone: c.phone || "",
    email: c.email || "",
    address: c.address || "",
    birthdate: c.birthdate || "",
    marriage_date: c.marriage_date || "",
    notes: c.notes || "",
  });

  const save = async (e) => {
    e.preventDefault();
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) {
      confirm({ title: "Name Required", message: "Please enter the customer's name.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} });
      return;
    }
    const payload = {
      name,
      phone: editing.phone.trim() || null,
      email: editing.email.trim() || null,
      address: editing.address.trim() || null,
      birthdate: editing.birthdate || null,
      marriage_date: editing.marriage_date || null,
      notes: editing.notes.trim() || null,
    };
    try {
      if (editing.id) {
        await updateDoc(doc(db, "customers", editing.id), {
          ...payload,
          updated_at: new Date().toISOString(),
          updated_by: currentUser?.name || "user",
        });
        toast({ title: "Updated", message: `${name} updated.`, type: "success" });
      } else {
        await addDoc(collection(db, "customers"), {
          ...payload,
          created_at: new Date().toISOString(),
          created_by: currentUser?.name || "user",
        });
        toast({ title: "Customer Added", message: `${name} saved.`, type: "success" });
      }
      setEditing(null);
    } catch (err) {
      confirm({ title: "Save Failed", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    }
  };

  const handleDelete = (c) => {
    confirm({
      title: "Delete Customer",
      message: `Delete <strong>${c.name}</strong>? This won't remove past billing entries, but the customer will no longer appear in the directory.`,
      confirmText: "Yes, Delete",
      cancelText: "Cancel",
      type: "danger",
      onConfirm: async () => {
        try {
          await deleteDoc(doc(db, "customers", c.id));
          toast({ title: "Deleted", message: `${c.name} removed.`, type: "success" });
        } catch (err) {
          confirm({ title: "Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
        }
      },
    });
  };

  if (loading) return <div style={{ textAlign: "center", color: "var(--gold)", padding: 40, fontWeight: 700 }}>Loading customers...</div>;

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div className="page-title" style={{ fontSize: 24, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>Customers</div>
        {canEdit && (
          <button onClick={openNew}
            style={{ padding: "10px 18px", fontSize: 13, borderRadius: 10, background: "var(--accent)", color: "#000", border: "none", cursor: "pointer", fontWeight: 800, display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="plus" size={14} /> Add Customer
          </button>
        )}
      </div>

      {/* Summary */}
      <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 18px", minWidth: 160 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Total</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--text)" }}>{customers.length}</div>
        </div>
        <div style={{ background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 12, padding: "12px 18px", minWidth: 160 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Repeat Visitors</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--accent)" }}>
            {Array.from(visitsByCustomer.values()).filter(v => v.visits > 1).length}
          </div>
        </div>
      </div>

      {/* Search */}
      <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)", borderRadius: 12, padding: 10, marginBottom: 16, display: "flex", alignItems: "center", gap: 10, position: "relative" }}>
        <div style={{ position: "absolute", left: 22, color: "var(--text3)" }}>
          <Icon name="search" size={14} />
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name, phone, or email..."
          style={{ flex: 1, padding: "10px 12px 10px 34px", background: "var(--bg3)", border: "1px solid var(--border2)", borderRadius: 8, color: "var(--text)", fontSize: 13, outline: "none" }} />
      </div>

      {/* Table */}
      <Card>
        <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
          <thead>
            <tr>
              <TH>Name</TH>
              <TH>Phone</TH>
              <TH>Email</TH>
              <TH>Birth / Marriage</TH>
              <TH right>Visits</TH>
              <TH right>Last Visit</TH>
              {canEdit && <TH right sticky>Actions</TH>}
            </tr>
          </thead>
          <tbody>
            {filtered.map(c => {
              const v = visitsByCustomer.get(c.id);
              return (
                <tr key={c.id} style={{ cursor: "pointer" }} onClick={() => setDetailOf(c)}>
                  <TD>
                    <div style={{ fontWeight: 700 }}>{c.name}</div>
                    {c.address && <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>{c.address}</div>}
                  </TD>
                  <TD style={{ fontFamily: "var(--font-headline, var(--font-outfit))", color: "var(--text2)" }}>{c.phone || "—"}</TD>
                  <TD style={{ color: "var(--text3)", fontSize: 12 }}>{c.email || "—"}</TD>
                  <TD style={{ fontSize: 11, color: "var(--text3)" }}>
                    <div>🎂 {c.birthdate || "—"}</div>
                    <div>💍 {c.marriage_date || "—"}</div>
                  </TD>
                  <TD right style={{ fontWeight: 700, color: v?.visits > 1 ? "var(--accent)" : "var(--text2)" }}>{v?.visits || 0}</TD>
                  <TD right style={{ fontSize: 12, color: "var(--text3)" }}>{v?.last || "—"}</TD>
                  {canEdit && (
                    <TD sticky right onClick={e => e.stopPropagation()}>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <IconBtn name="edit" variant="secondary" title="Edit" onClick={() => openEdit(c)} />
                        <IconBtn name="del" variant="danger" title="Delete" onClick={() => handleDelete(c)} />
                      </div>
                    </TD>
                  )}
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: "center", padding: 30, color: "var(--text3)" }}>
                {search ? "No customers match your search." : "No customers yet. Add one from the POS or the button above."}
              </td></tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* Detail Drawer/Modal */}
      <Modal isOpen={!!detailOf} onClose={() => setDetailOf(null)} title={detailOf?.name || "Customer"} width={720}>
        {detailOf && (() => {
          const v = visitsByCustomer.get(detailOf.id);
          const bills = customerInvoices.slice().sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.invoice_no || "").localeCompare(a.invoice_no || ""));
          const lifetime = bills.reduce((s, inv) => s + (Number(inv.total) || Number(inv.subtotal) || 0), 0);
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, background: "var(--bg4)", padding: 14, borderRadius: 10, fontSize: 12 }}>
                <div><span style={{ color: "var(--text3)" }}>Phone:</span> <strong>{detailOf.phone || "—"}</strong></div>
                <div><span style={{ color: "var(--text3)" }}>Email:</span> <strong>{detailOf.email || "—"}</strong></div>
                <div style={{ gridColumn: "1 / span 2" }}><span style={{ color: "var(--text3)" }}>Address:</span> <strong>{detailOf.address || "—"}</strong></div>
                <div><span style={{ color: "var(--text3)" }}>🎂 Birthday:</span> <strong>{detailOf.birthdate || "—"}</strong></div>
                <div><span style={{ color: "var(--text3)" }}>💍 Anniversary:</span> <strong>{detailOf.marriage_date || "—"}</strong></div>
                <div><span style={{ color: "var(--text3)" }}>Visits:</span> <strong style={{ color: "var(--accent)" }}>{bills.length || v?.visits || 0}</strong></div>
                <div><span style={{ color: "var(--text3)" }}>Last Visit:</span> <strong>{bills[0]?.date || v?.last || "—"}</strong></div>
                <div style={{ gridColumn: "1 / span 2" }}><span style={{ color: "var(--text3)" }}>Lifetime Spend:</span> <strong style={{ color: "var(--gold)" }}>{INR(lifetime)}</strong></div>
                {detailOf.notes && (
                  <div style={{ gridColumn: "1 / span 2" }}><span style={{ color: "var(--text3)" }}>Notes:</span> <strong>{detailOf.notes}</strong></div>
                )}
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Billing History</div>
                {bills.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 360, overflowY: "auto", paddingRight: 6 }}>
                    {bills.map(inv => {
                      const stylists = [...new Set((inv.items || []).map(it => it.staff_name).filter(Boolean))].join(", ");
                      return (
                        <div key={inv.id} style={{ background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700 }}>{inv.date}</div>
                              <div style={{ fontSize: 12, fontWeight: 800, color: "var(--accent)", letterSpacing: 0.3 }}>{inv.invoice_no}</div>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <div style={{ fontSize: 14, fontWeight: 900, color: "var(--gold)" }}>{INR(inv.total || inv.subtotal || 0)}</div>
                              <button onClick={() => setInvoicePreview(inv)} title="Open bill (print / save as PDF)"
                                style={{ background: "rgba(var(--accent-rgb),0.1)", border: "1px solid rgba(var(--accent-rgb),0.3)", color: "var(--accent)", padding: "4px 10px", borderRadius: 8, fontWeight: 700, fontSize: 11, cursor: "pointer" }}>PDF</button>
                            </div>
                          </div>
                          <div style={{ marginTop: 6, fontSize: 11, color: "var(--text2)", lineHeight: 1.5 }}>
                            {(inv.items || []).map((it, i) => (
                              <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                                <span style={{ color: "var(--text2)" }}>· {it.name} {it.staff_name && <span style={{ color: "var(--text3)" }}>— {it.staff_name}</span>}</span>
                                <span style={{ color: "var(--text3)" }}>{INR(it.price || 0)}</span>
                              </div>
                            ))}
                          </div>
                          {stylists && (
                            <div style={{ marginTop: 6, fontSize: 10, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>Stylist: <span style={{ color: "var(--text2)" }}>{stylists}</span></div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : <div style={{ fontSize: 12, color: "var(--text3)" }}>No bills recorded yet.</div>}
              </div>
              {canEdit && (
                <div style={{ display: "flex", gap: 10 }}>
                  <button onClick={() => { openEdit(detailOf); setDetailOf(null); }}
                    style={{ flex: 1, padding: "12px", borderRadius: 10, background: "var(--accent)", color: "#000", border: "none", fontWeight: 800, cursor: "pointer" }}>Edit</button>
                  <button onClick={() => setDetailOf(null)}
                    style={{ padding: "12px 20px", borderRadius: 10, background: "var(--bg3)", color: "var(--text2)", border: "1px solid var(--border)", cursor: "pointer", fontWeight: 600 }}>Close</button>
                </div>
              )}
            </div>
          );
        })()}
      </Modal>

      {/* Add / Edit Modal */}
      <Modal isOpen={!!editing} onClose={() => setEditing(null)} title={editing?.id ? "Edit Customer" : "New Customer"}>
        {editing && (
          <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Field label="Name *">
              <input required autoFocus value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="Full name" />
            </Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Phone">
                <input value={editing.phone} onChange={e => setEditing({ ...editing, phone: e.target.value })} placeholder="10-digit mobile" />
              </Field>
              <Field label="Email">
                <input type="email" value={editing.email} onChange={e => setEditing({ ...editing, email: e.target.value })} placeholder="optional" />
              </Field>
            </div>
            <Field label="Address">
              <input value={editing.address} onChange={e => setEditing({ ...editing, address: e.target.value })} placeholder="optional" />
            </Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Birth Date">
                <input type="date" value={editing.birthdate} onChange={e => setEditing({ ...editing, birthdate: e.target.value })} />
              </Field>
              <Field label="Marriage Date">
                <input type="date" value={editing.marriage_date} onChange={e => setEditing({ ...editing, marriage_date: e.target.value })} />
              </Field>
            </div>
            <Field label="Notes">
              <textarea rows={2} value={editing.notes} onChange={e => setEditing({ ...editing, notes: e.target.value })} placeholder="Preferences, allergies, etc." />
            </Field>
            <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
              <button type="submit" style={{ flex: 1, padding: "12px", borderRadius: 10, background: "var(--accent)", color: "#000", border: "none", fontWeight: 800, cursor: "pointer" }}>
                {editing.id ? "Update" : "Save"} Customer
              </button>
              <button type="button" onClick={() => setEditing(null)}
                style={{ padding: "12px 20px", borderRadius: 10, background: "var(--bg3)", color: "var(--text2)", border: "1px solid var(--border)", cursor: "pointer", fontWeight: 600 }}>Cancel</button>
            </div>
          </form>
        )}
      </Modal>

      {invoicePreview && (
        <BillPrintModal invoice={invoicePreview} onClose={() => setInvoicePreview(null)} />
      )}

      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>{label}</label>
      <div style={{ display: "contents" }}>
        {children && (() => {
          const baseStyle = { padding: "12px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 14, outline: "none", fontFamily: "inherit", width: "100%", boxSizing: "border-box", resize: "vertical" };
          return { ...children, props: { ...children.props, style: { ...baseStyle, ...(children.props.style || {}) } } };
        })()}
      </div>
    </div>
  );
}
