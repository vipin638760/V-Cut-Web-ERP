"use client";
import { useEffect, useState } from "react";
import { collection, onSnapshot, doc, setDoc, deleteDoc, addDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { INR } from "@/lib/calculations";
import { Card, Pill, TH, TD, IconBtn, StatCard, Icon, useConfirm, useToast } from "@/components/ui";

export default function ShopsTab() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  
  const [form, setForm] = useState({
    id: "", name: "", type: "mens", location: "",
    shop_rent: "", room_rent: "", salary_budget: "",
    shop_elec: "", room_elec: "", wifi: "", water: "",
    maid: "", garbage: "", ac_service: "", elec_maint: ""
  });

  useEffect(() => {
    if (!db) return;
    const unsub = onSnapshot(collection(db, "branches"), sn => {
      setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })));
      setLoading(false);
    });
    return () => unsub();
  }, []);

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.name) { confirm({ title: "Validation", message: "Shop name required.", confirmText: "OK", type: "warning", onConfirm: () => {} }); return; }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(), type: form.type, location: form.location.trim(),
        shop_rent: Number(form.shop_rent) || 0,
        room_rent: Number(form.room_rent) || 0,
        salary_budget: Number(form.salary_budget) || 0,
        shop_elec: Number(form.shop_elec) || 0,
        room_elec: Number(form.room_elec) || 0,
        wifi: Number(form.wifi) || 0,
        water: Number(form.water) || 0,
        maid: Number(form.maid) || 0,
        garbage: Number(form.garbage) || 0,
        ac_service: Number(form.ac_service) || 0,
        elec_maint: Number(form.elec_maint) || 0,
      };
      if (form.id) {
        await setDoc(doc(db, "branches", form.id), payload, { merge: true });
        toast({ title: "Updated", message: "Shop details updated successfully.", type: "success" });
      } else {
        await addDoc(collection(db, "branches"), payload);
        toast({ title: "Saved", message: "Shop created successfully.", type: "success" });
      }
      setForm({
        id: "", name: "", type: "mens", location: "",
        shop_rent: "", room_rent: "", salary_budget: "",
        shop_elec: "", room_elec: "", wifi: "", water: "",
        maid: "", garbage: "", ac_service: "", elec_maint: ""
      });
    } catch (e) { confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
    setSaving(false);
  };

  const handleDelete = async (id) => {
    confirm({
      title: "Archive Branch",
      message: "Are you sure you want to permanently archive this <strong>branch</strong>?",
      confirmText: "Yes, Archive",
      cancelText: "Cancel",
      type: "danger",
      onConfirm: async () => {
        try { await deleteDoc(doc(db, "branches", id)); toast({ title: "Deleted", message: "Shop has been removed.", type: "success" }); } catch (e) { confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
      }
    });
  };

  if (loading) return <div style={{ padding: 60, textAlign: "center", color: "var(--accent)", fontWeight: 800 }}>Loading commercial infrastructure...</div>;

  const inputStyle = { width: "100%", padding: "12px 14px", border: "1px solid var(--border2)", borderRadius: 10, background: "rgba(255,255,255,0.02)", color: "var(--text)", outline: "none", fontSize: 13, transition: "all 0.2s" };
  
  const sum = (field) => branches.reduce((s, b) => s + (Number(b[field]) || 0), 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32, animation: "fadeIn 0.5s ease-out" }}>
      {/* Analytics Overview */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 24 }}>
        <StatCard 
          label="Network Salary Budget" 
          value={INR(sum("salary_budget"))} 
          subtext={`Total allocated for ${branches.length} branches`}
          icon={<Icon name="wallet" size={20} />}
          color="gold"
        />
        <StatCard 
          label="Total Operational Rent" 
          value={INR(sum("shop_rent") + sum("room_rent"))} 
          subtext="Combined commercial & lodging"
          icon={<Icon name="home" size={20} />}
          color="orange"
        />
        <StatCard 
          label="Utility Provisions" 
          value={INR(sum("shop_elec") + sum("wifi") + sum("water") + sum("maid") + sum("garbage"))} 
          subtext="Estimated monthly overheads"
          icon={<Icon name="zap" size={20} />}
          color="accent"
        />
      </div>

      <Card style={{ padding: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
          <div style={{ background: "rgba(34,211,238,0.1)", padding: 10, borderRadius: 12 }}>
            <Icon name="home" size={20} color="var(--accent)" />
          </div>
          <h3 style={{ fontSize: 18, fontWeight: 950, color: "var(--text)", textTransform: "uppercase", letterSpacing: 1 }}>{form.id ? "Modify Branch Profile" : "Establish New Branch"}</h3>
        </div>

        <form onSubmit={handleSave} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 20 }}>
          <div style={{ gridColumn: form.id ? "span 1" : "span 2" }}>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 8 }}>Branch Descriptor</label>
            <input placeholder="e.g. V-CUT PARK STREET" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 8 }}>Operational Category</label>
            <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} style={{ ...inputStyle, appearance: "none" }}>
              <option value="mens">Men's Specialist</option>
              <option value="unisex">Unisex / Premium</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 8 }}>Geographic Location</label>
            <input placeholder="City, Zone" value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} style={inputStyle} />
          </div>
          
          <div style={{ borderTop: "1px solid var(--border)", gridColumn: "1 / -1", margin: "10px 0" }}></div>

          <div>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--orange)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 8 }}>Commercial Rent</label>
            <input type="number" placeholder="0" value={form.shop_rent} onChange={e => setForm({ ...form, shop_rent: e.target.value })} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 8 }}>Salary Cap Limit</label>
            <input type="number" placeholder="0" value={form.salary_budget} onChange={e => setForm({ ...form, salary_budget: e.target.value })} style={{ ...inputStyle, borderColor: "var(--gold)", background: "rgba(255,215,0,0.03)" }} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 8 }}>Elec provision</label>
            <input type="number" placeholder="0" value={form.shop_elec} onChange={e => setForm({ ...form, shop_elec: e.target.value })} style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 900, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1.5, display: "block", marginBottom: 8 }}>Connectivity (WiFi)</label>
            <input type="number" placeholder="0" value={form.wifi} onChange={e => setForm({ ...form, wifi: e.target.value })} style={inputStyle} />
          </div>

          <div style={{ gridColumn: "1 / -1", display: "flex", gap: 12, marginTop: 16 }}>
            <button type="submit" disabled={saving} style={{ padding: "14px 28px", borderRadius: 14, background: "var(--accent)", color: "#000", border: "none", fontWeight: 950, fontSize: 13, textTransform: "uppercase", letterSpacing: 1.2, cursor: "pointer", boxShadow: "0 10px 20px -10px rgba(34,211,238,0.4)" }}>{saving ? "Processing..." : (form.id ? "Commit Changes" : "Establish Branch")}</button>
            <button type="button" onClick={() => setForm({ id: "", name: "", type: "mens", location: "", shop_rent: "", room_rent: "", salary_budget: "", shop_elec: "", room_elec: "", wifi: "", water: "", maid: "", garbage: "" })} style={{ padding: "14px 28px", borderRadius: 14, background: "rgba(255,255,255,0.05)", color: "var(--text2)", border: "1px solid var(--border)", fontWeight: 700, fontSize: 13, textTransform: "uppercase", letterSpacing: 1, cursor: "pointer" }}>Reset Form</button>
          </div>
        </form>
      </Card>

      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
           <div style={{ height: 2, width: 20, background: "var(--accent)" }}></div>
           <h4 style={{ fontSize: 12, fontWeight: 900, color: "var(--text2)", textTransform: "uppercase", letterSpacing: 2 }}>Physical Infrastructure Logs</h4>
        </div>
        <Card style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
            <thead>
              <tr>
                <TH>Branch Alias</TH>
                <TH>Classification</TH>
                <TH right>Rent (₹)</TH>
                <TH right>Elec (₹)</TH>
                <TH right>WiFi (₹)</TH>
                <TH right>Salary Cap</TH>
                <TH right>Actions</TH>
              </tr>
            </thead>
            <tbody>
              {branches.sort((a,b) => a.name.localeCompare(b.name)).map((b) => (
                <tr key={b.id} onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.01)"} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <TD style={{ fontWeight: 800, color: "var(--text)" }}>{b.name}</TD>
                  <TD><Pill label={b.type === "unisex" ? "Premium Unisex" : "Mens Only"} color={b.type === "unisex" ? "purple" : "blue"} /></TD>
                  <TD right style={{ color: "var(--orange)", fontWeight: 600 }}>{INR(b.shop_rent)}</TD>
                  <TD right style={{ color: "var(--text3)" }}>{INR(b.shop_elec)}</TD>
                  <TD right style={{ color: "var(--text3)" }}>{INR(b.wifi)}</TD>
                  <TD right style={{ fontWeight: 900, color: "var(--gold)" }}>{INR(b.salary_budget)}</TD>
                  <TD right>
                    <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                      <IconBtn name="edit" size={24} onClick={() => setForm({ ...b })} />
                      <IconBtn name="del" size={24} variant="danger" onClick={() => handleDelete(b.id)} />
                    </div>
                  </TD>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        select option { background: #1a1b1e; color: #fff; }
      `}</style>
      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}
