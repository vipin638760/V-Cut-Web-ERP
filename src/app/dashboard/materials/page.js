"use client";
import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, orderBy, addDoc, doc, writeBatch, deleteDoc, increment } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR } from "@/lib/calculations";
import { Icon, IconBtn, Pill, Card, TH, TD, Modal, useConfirm, useToast } from "@/components/ui";
// ExcelJS is ~200KB — load only when Export/Template/Upload is actually used.
let _excelJSPromise = null;
const loadExcelJS = () => {
  if (!_excelJSPromise) _excelJSPromise = import("exceljs").then(m => m.default || m);
  return _excelJSPromise;
};

const MATERIAL_GROUPS = [
  "SHAMPOO", "HAIR SPA", "HAIR COLOUR", "WAX", "HAIR ITEAM", "FACIAL",
  "USE AND THROW", "TOOLS", "SHAVING ITEAM", "OTHERS", "MACHIN", "M&P",
];

export default function MaterialsPage() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [materials, setMaterials] = useState([]);
  const [priceHistory, setPriceHistory] = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);

  const [tab, setTab] = useState("list"); // list | transfers
  const [search, setSearch] = useState("");
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [qtyMin, setQtyMin] = useState("");
  const [qtyMax, setQtyMax] = useState("");
  const [historyModal, setHistoryModal] = useState(null); // material object

  // PDF extraction state
  const [parsing, setParsing] = useState(false);
  const [reviewModal, setReviewModal] = useState(null); // { items: [{ name, qty, unit, price, gst_pct, price_inc_gst, existing }] }

  // Transfer state
  const [selectedIds, setSelectedIds] = useState([]);
  const [transferModal, setTransferModal] = useState(null); // { branch_id, items }
  const [rowCountPrompt, setRowCountPrompt] = useState(null); // { count }
  // Full-catalog transfer grid state
  const [catalogRows, setCatalogRows] = useState([]); // [{ material_id, name, unit, price_at_transfer, gst_pct, qty, branch_id, _uid }]
  const [catalogDate, setCatalogDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [catalogAutoUpdate, setCatalogAutoUpdate] = useState(true);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogGroup, setCatalogGroup] = useState("");
  const [catalogSaving, setCatalogSaving] = useState(false);
  const [catalogReady, setCatalogReady] = useState(false);
  const [branchDetail, setBranchDetail] = useState(null); // branch object to expand in detail
  const [selectedUids, setSelectedUids] = useState([]);
  const [transferConfirmOpen, setTransferConfirmOpen] = useState(false); // date confirm dialog
  const toggleSelectUid = (uid) => setSelectedUids(prev => prev.includes(uid) ? prev.filter(x => x !== uid) : [...prev, uid]);

  // Split: take a row with qty N and qty-branch set, duplicate and halve it (or take a custom split count).
  const splitCatalogRow = (uid) => {
    const src = catalogRows.find(r => r._uid === uid);
    if (!src) return;
    if (!(Number(src.qty) > 0)) {
      confirm({ title: "Enter Qty First", message: "Set a quantity on this row before splitting.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} });
      return;
    }
    const halfA = Math.floor(Number(src.qty) / 2) || 1;
    const halfB = Math.max(0, Number(src.qty) - halfA);
    setCatalogRows(prev => {
      const idx = prev.findIndex(r => r._uid === uid);
      if (idx < 0) return prev;
      const newFirst = { ...prev[idx], qty: halfA };
      const dup = { ...prev[idx], _uid: `${src.material_id}-${Math.random().toString(36).slice(2, 6)}`, branch_id: "", qty: halfB };
      const copy = [...prev];
      copy[idx] = newFirst;
      copy.splice(idx + 1, 0, dup);
      return copy;
    });
  };

  // Seed catalog rows from current materials whenever the Transfers tab is entered.
  useEffect(() => {
    if (tab !== "transfers") return;
    if (catalogReady) return;
    setCatalogRows(materials.map(m => ({
      _uid: `${m.id}-${Math.random().toString(36).slice(2, 6)}`,
      material_id: m.id,
      name: m.name,
      unit: m.unit || "pcs",
      price_at_transfer: Number(m.current_price) || 0,
      gst_pct: Number(m.gst_pct) || 0,
      qty: 0,
      branch_id: "",
    })));
    setCatalogReady(true);
  }, [tab, materials, catalogReady]);

  // Reset catalog when materials master changes meaningfully (count differs)
  useEffect(() => {
    if (!catalogReady) return;
    const existingIds = new Set(catalogRows.map(r => r.material_id));
    const newOnes = materials.filter(m => !existingIds.has(m.id));
    if (newOnes.length > 0) {
      setCatalogRows(prev => [...prev, ...newOnes.map(m => ({
        _uid: `${m.id}-${Math.random().toString(36).slice(2, 6)}`,
        material_id: m.id, name: m.name, unit: m.unit || "pcs",
        price_at_transfer: Number(m.current_price) || 0,
        gst_pct: Number(m.gst_pct) || 0, qty: 0, branch_id: "",
      }))]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materials]);

  const updateCatalogRow = (uid, patch) => setCatalogRows(prev => prev.map(r => r._uid === uid ? { ...r, ...patch } : r));
  const duplicateCatalogRow = (uid) => setCatalogRows(prev => {
    const idx = prev.findIndex(r => r._uid === uid);
    if (idx < 0) return prev;
    const src = prev[idx];
    const dup = { ...src, _uid: `${src.material_id}-${Math.random().toString(36).slice(2, 6)}`, branch_id: "", qty: src.qty };
    const copy = [...prev];
    copy.splice(idx + 1, 0, dup);
    return copy;
  });
  const removeCatalogRow = (uid) => setCatalogRows(prev => prev.filter(r => r._uid !== uid));
  const resetCatalog = () => setCatalogRows(prev => prev.map(r => ({ ...r, qty: 0, branch_id: "" })));

  const filledCatalog = catalogRows.filter(r => r.branch_id && Number(r.qty) > 0);
  const catalogTotal = filledCatalog.reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.price_at_transfer) || 0), 0);

  // Purchased qty per material (sum of qty recorded in price history — populated on new imports)
  const purchasedQtyByMaterial = useMemo(() => {
    const map = {};
    priceHistory.forEach(h => {
      if (!h.material_id) return;
      map[h.material_id] = (map[h.material_id] || 0) + (Number(h.qty) || 0);
    });
    return map;
  }, [priceHistory]);

  // Transferred qty per material (sum of qty across all allocations)
  const transferredQtyByMaterial = useMemo(() => {
    const map = {};
    allocations.forEach(a => {
      (a.items || []).forEach(it => {
        if (!it.material_id) return;
        map[it.material_id] = (map[it.material_id] || 0) + (Number(it.qty) || 0);
      });
    });
    return map;
  }, [allocations]);

  // Qty staged in the current (uncommitted) catalog rows
  const stagedQtyByMaterial = useMemo(() => {
    const map = {};
    catalogRows.forEach(r => {
      if (!r.material_id || !(Number(r.qty) > 0)) return;
      map[r.material_id] = (map[r.material_id] || 0) + Number(r.qty);
    });
    return map;
  }, [catalogRows]);

  // Prefer the denormalized counter on the material doc; fall back to summing history.
  const purchasedFor = (materialId) => {
    const m = materials.find(x => x.id === materialId);
    if (m && Number.isFinite(Number(m.total_purchased))) return Number(m.total_purchased);
    return purchasedQtyByMaterial[materialId] || 0;
  };

  const availableFor = (materialId) => {
    const purchased = purchasedFor(materialId);
    const transferred = transferredQtyByMaterial[materialId] || 0;
    return purchased - transferred;
  };

  // Group filled rows by branch → build per-branch summary
  const catalogByBranch = useMemo(() => {
    const map = {};
    filledCatalog.forEach(r => {
      if (!map[r.branch_id]) map[r.branch_id] = { branch_id: r.branch_id, items: [], total: 0 };
      const g = map[r.branch_id];
      g.items.push(r);
      g.total += (Number(r.qty) || 0) * (Number(r.price_at_transfer) || 0);
    });
    return Object.values(map);
  }, [filledCatalog]);

  const commitCatalogTransfer = async () => {
    if (filledCatalog.length === 0) {
      confirm({ title: "Nothing to Transfer", message: "Enter a quantity and pick a branch for at least one row.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} });
      return;
    }
    if (!catalogDate) {
      confirm({ title: "Date Required", message: "Please select a transfer date.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} });
      return;
    }
    setCatalogSaving(true);
    try {
      const { getDocs, query: fsQuery, where: fsWhere, updateDoc: fsUpdate } = await import("firebase/firestore");
      const nowISO = new Date().toISOString();
      let totalTransfers = 0, totalItems = 0;
      for (const g of catalogByBranch) {
        const branch = branches.find(b => b.id === g.branch_id);
        const items = g.items.map(r => ({
          material_id: r.material_id,
          name: r.name,
          qty: Number(r.qty) || 0,
          unit: r.unit || "pcs",
          price_at_transfer: Number(r.price_at_transfer) || 0,
          line_total: (Number(r.qty) || 0) * (Number(r.price_at_transfer) || 0),
        }));
        await addDoc(collection(db, "material_allocations"), {
          branch_id: g.branch_id,
          branch_name: branch?.name || "",
          date: catalogDate,
          items,
          total: g.total,
          note: "Bulk transfer from catalog",
          transferred_by: currentUser?.id || currentUser?.name || "admin",
          transferred_at: nowISO,
        });
        totalTransfers++;
        totalItems += items.length;

        if (catalogAutoUpdate && g.total > 0) {
          const q = fsQuery(collection(db, "entries"), fsWhere("branch_id", "==", g.branch_id), fsWhere("date", "==", catalogDate));
          const snap = await getDocs(q);
          if (!snap.empty) {
            const existing = snap.docs[0];
            const data = existing.data();
            const newMat = (Number(data.mat_expense) || 0) + g.total;
            const activity = Array.isArray(data.activity_log) ? [...data.activity_log] : [];
            activity.push({
              action: "Material Transfer",
              user: currentUser?.name || currentUser?.id || "admin",
              time: nowISO,
              note: `Added ₹${g.total.toFixed(2)} material expense from ${items.length} item(s)`,
            });
            await fsUpdate(existing.ref, { mat_expense: newMat, activity_log: activity, updated_at: nowISO });
          } else {
            await addDoc(collection(db, "entries"), {
              branch_id: g.branch_id, date: catalogDate,
              online: 0, cash: 0, mat_expense: g.total,
              others: 0, petrol: 0, staff_billing: [], total_gst: 0,
              activity_log: [{ action: "Create", user: currentUser?.name || currentUser?.id || "admin", time: nowISO, note: `Stub created via bulk material transfer (₹${g.total.toFixed(2)})` }],
              created_at: nowISO,
            });
          }
        }
      }
      toast({ title: "Transferred", message: `${totalItems} item(s) across ${totalTransfers} branch transfer(s) for ${catalogDate}.`, type: "success" });
      resetCatalog();
      setTransferConfirmOpen(false);
    } catch (err) {
      confirm({ title: "Transfer Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    } finally {
      setCatalogSaving(false);
    }
  };

  // Manual Add Material form
  const [addMaterialModal, setAddMaterialModal] = useState(null); // { name, unit, group, gst_pct, price_inc_gst, editingId }
  // In-transfer picker: search master to append a row
  const [pickerSearch, setPickerSearch] = useState("");

  // Add-Material grid state
  const addBlankRow = () => ({ name: "", unit: "pcs", group: "", gst_pct: 18, price_inc_gst: "", qty: 1, purchase_date: new Date().toISOString().slice(0, 10), existingId: null });
  const [addRows, setAddRows] = useState([]); // Populated via the row-count popup
  const [addNumRows, setAddNumRows] = useState(10);
  const [addFocusedIdx, setAddFocusedIdx] = useState(-1);
  const [addSaving, setAddSaving] = useState(false);
  const [addRowsPrompt, setAddRowsPrompt] = useState(null); // { count }

  const applyAddNumRows = (n) => {
    const clamped = Math.max(1, Math.min(999, Number(n) || 1));
    setAddNumRows(clamped);
    setAddRows(prev => {
      if (prev.length === clamped) return prev;
      if (prev.length > clamped) return prev.slice(0, clamped);
      return [...prev, ...Array.from({ length: clamped - prev.length }, addBlankRow)];
    });
  };

  const updateAddRow = (i, patch) => setAddRows(prev => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  const pickAddMaterial = (i, m) => {
    updateAddRow(i, {
      name: m.name,
      unit: m.unit || "pcs",
      group: m.group || "",
      gst_pct: m.gst_pct ?? 18,
      price_inc_gst: m.current_price || "",
      existingId: m.id,
    });
  };

  const addRowSuggestions = (i) => {
    const q = (addRows[i]?.name || "").trim().toLowerCase();
    if (q.length < 2) return [];
    return materials.filter(m => (m.name || "").toLowerCase().includes(q)).slice(0, 6);
  };

  const saveAddGrid = async () => {
    const filled = addRows.filter(r => (r.name || "").trim() && Number(r.price_inc_gst) > 0);
    if (filled.length === 0) {
      confirm({ title: "Nothing to Save", message: "Please fill at least one row with a material name and price.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} });
      return;
    }
    const seen = new Map();
    for (const r of filled) {
      const k = r.name.trim().toLowerCase();
      if (seen.has(k)) { confirm({ title: "Duplicate Name", message: `"${r.name}" appears more than once. Remove duplicates and try again.`, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} }); return; }
      seen.set(k, true);
    }
    // Validate qty + date on every filled row
    for (const r of filled) {
      if (!(Number(r.qty) > 0)) { confirm({ title: "Qty Required", message: `Row "${r.name}": purchase quantity must be greater than 0.`, confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} }); return; }
      if (!r.purchase_date) { confirm({ title: "Date Required", message: `Row "${r.name}": purchase date is missing.`, confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} }); return; }
    }
    setAddSaving(true);
    try {
      const batch = writeBatch(db);
      const nowISO = new Date().toISOString();
      let created = 0, updated = 0, priceChanges = 0;
      for (const r of filled) {
        const name = r.name.trim();
        const priceInc = Number(r.price_inc_gst) || 0;
        const gstPct = Number(r.gst_pct) || 0;
        const qty = Number(r.qty) || 0;
        const purchaseDate = r.purchase_date;
        const basePrice = +(priceInc / (1 + gstPct / 100)).toFixed(2);
        const payload = {
          name, unit: r.unit || "pcs", gst_pct: gstPct,
          current_price: priceInc, base_price: basePrice,
          last_updated: nowISO,
          last_updated_by: currentUser?.id || currentUser?.name || "admin",
          ...(r.group ? { group: r.group } : {}),
          archived: false,
        };
        const match = r.existingId
          ? materials.find(m => m.id === r.existingId)
          : materials.find(m => (m.name || "").toLowerCase() === name.toLowerCase());
        let materialId;
        if (match) {
          materialId = match.id;
          const priceChanged = Math.abs((Number(match.current_price) || 0) - priceInc) > 0.01;
          batch.set(doc(db, "materials", materialId), payload, { merge: true });
          batch.update(doc(db, "materials", materialId), { total_purchased: increment(qty) });
          batch.set(doc(collection(db, "material_price_history")), {
            material_id: materialId, material_name: name,
            old_price: Number(match.current_price) || 0, new_price: priceInc,
            gst_pct: gstPct, qty, effective_from: purchaseDate,
            event: priceChanged ? "price_change" : "purchase",
            source: "add-material-grid",
            changed_by: currentUser?.id || currentUser?.name || "admin",
            changed_at: nowISO,
          });
          if (priceChanged) priceChanges++;
          updated++;
        } else {
          const mRef = doc(collection(db, "materials"));
          materialId = mRef.id;
          batch.set(mRef, { ...payload, total_purchased: qty });
          batch.set(doc(collection(db, "material_price_history")), {
            material_id: materialId, material_name: name,
            old_price: 0, new_price: priceInc,
            gst_pct: gstPct, qty, effective_from: purchaseDate,
            event: "first_purchase",
            source: "add-material-grid",
            changed_by: currentUser?.id || currentUser?.name || "admin",
            changed_at: nowISO,
          });
          created++;
        }
      }
      await batch.commit();
      const skipped = addRows.length - filled.length;
      toast({
        title: "Saved to Master",
        message: `${created} new, ${updated} purchase log${updated === 1 ? "" : "s"} appended${priceChanges ? ` (${priceChanges} price change${priceChanges > 1 ? "s" : ""})` : ""}${skipped ? `, ${skipped} empty row${skipped > 1 ? "s" : ""} skipped` : ""}.`,
        type: "success",
      });
      setAddRows(Array.from({ length: addNumRows }, addBlankRow));
    } catch (err) {
      confirm({ title: "Save Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    } finally {
      setAddSaving(false);
    }
  };

  const currentUser = useCurrentUser() || {};

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(collection(db, "materials"), sn => setMaterials(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(query(collection(db, "material_price_history"), orderBy("changed_at", "desc")), sn => setPriceHistory(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(query(collection(db, "material_allocations"), orderBy("transferred_at", "desc")), sn => { setAllocations(sn.docs.map(d => ({ ...d.data(), id: d.id }))); setLoading(false); }),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  const materialsById = useMemo(() => {
    const m = new Map();
    materials.forEach(x => m.set(x.id, x));
    return m;
  }, [materials]);

  // Set lookups for selected ids — replaces O(n) Array.includes per row in select-all and per-row checks.
  const selectedIdSet  = useMemo(() => new Set(selectedIds),  [selectedIds]);
  const selectedUidSet = useMemo(() => new Set(selectedUids), [selectedUids]);

  const filteredMaterials = useMemo(() => {
    const q = search.trim().toLowerCase();
    const pMin = priceMin === "" ? null : Number(priceMin);
    const pMax = priceMax === "" ? null : Number(priceMax);
    const qMin = qtyMin === "" ? null : Number(qtyMin);
    const qMax = qtyMax === "" ? null : Number(qtyMax);
    return materials.filter(m => {
      if (m.archived) return false;
      if (q && !(m.name || "").toLowerCase().includes(q)) return false;
      const price = Number(m.current_price) || 0;
      if (pMin !== null && price < pMin) return false;
      if (pMax !== null && price > pMax) return false;
      const pur = Number.isFinite(Number(m.total_purchased)) ? Number(m.total_purchased) : (purchasedQtyByMaterial[m.id] || 0);
      if (qMin !== null && pur < qMin) return false;
      if (qMax !== null && pur > qMax) return false;
      return true;
    });
  }, [materials, search, priceMin, priceMax, qtyMin, qtyMax, purchasedQtyByMaterial]);

  const [ocrProgress, setOcrProgress] = useState(0);

  // Extract text lines from a PDF
  const linesFromPDF = async (file) => {
    const pdfjsLib = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    const lines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const rowsByY = {};
      content.items.forEach(it => {
        const y = Math.round(it.transform[5]);
        if (!rowsByY[y]) rowsByY[y] = [];
        rowsByY[y].push({ x: it.transform[4], str: it.str });
      });
      Object.keys(rowsByY).sort((a, b) => Number(b) - Number(a)).forEach(y => {
        const row = rowsByY[y].sort((a, b) => a.x - b.x).map(i => i.str).filter(s => s && s.trim()).join(" | ");
        if (row) lines.push(row);
      });
    }
    return lines;
  };

  // Extract text lines from an image via OCR, preserving tabular layout using word bounding boxes.
  const linesFromImage = async (file) => {
    const Tesseract = (await import("tesseract.js")).default;
    setOcrProgress(0);

    // Pre-process: upscale and binarize to boost OCR accuracy on phone-camera invoice shots.
    const preprocessed = await preprocessImage(file);

    const { data } = await Tesseract.recognize(preprocessed, "eng", {
      logger: m => { if (m.status === "recognizing text") setOcrProgress(Math.round((m.progress || 0) * 100)); },
      tessedit_pageseg_mode: 6, // single uniform block — maintains left-to-right row order for tables
      preserve_interword_spaces: "1",
    });
    setOcrProgress(100);

    // Prefer word-level bounding boxes to rebuild rows (like PDF y-grouping).
    const words = data?.words || [];
    if (words.length > 0) {
      // Group by y-midpoint with tolerance close to line height (so row words stay together
      // but different rows don't merge).
      const sorted = [...words].sort((a, b) => a.bbox.y0 - b.bbox.y0);
      const heights = sorted.map(w => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
      const medianHeight = heights[Math.floor(heights.length / 2)] || 12;
      const tol = Math.max(6, medianHeight * 0.5);
      const groups = [];
      sorted.forEach(w => {
        const y = (w.bbox.y0 + w.bbox.y1) / 2;
        const g = groups.find(gg => Math.abs(gg.y - y) <= tol);
        if (g) { g.words.push(w); g.y = (g.y * g.words.length + y) / (g.words.length + 1); }
        else groups.push({ y, words: [w] });
      });
      const lines = groups.map(g => {
        const sortedByX = g.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
        // Join with a pipe between words that are far apart (column gaps), single-space otherwise
        let out = sortedByX[0].text;
        for (let i = 1; i < sortedByX.length; i++) {
          const prev = sortedByX[i - 1];
          const cur = sortedByX[i];
          const gap = cur.bbox.x0 - prev.bbox.x1;
          const sep = gap > 18 ? " | " : " ";
          out += sep + cur.text;
        }
        return out.trim();
      }).filter(Boolean);
      if (lines.length > 0) return lines;
    }

    // Fallback to plain-text line split
    return (data.text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  };

  // Pre-processor: upscale small images and apply grayscale + mild contrast stretch (no hard threshold — preserves thin text).
  const preprocessImage = async (file) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        // Aim for at least ~2000px on the long edge (Tesseract's sweet spot for invoice shots).
        const longEdge = Math.max(img.width, img.height);
        const scale = longEdge < 2400 ? Math.min(3, 2400 / longEdge) : 1;
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        try {
          const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const d = id.data;
          // First pass: collect histogram to find percentile-based dark/light points.
          const histo = new Array(256).fill(0);
          for (let i = 0; i < d.length; i += 4) {
            const gray = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
            histo[gray]++;
          }
          const total = canvas.width * canvas.height;
          let cum = 0, lo = 0, hi = 255;
          for (let g = 0; g < 256; g++) { cum += histo[g]; if (cum >= total * 0.02) { lo = g; break; } }
          cum = 0;
          for (let g = 255; g >= 0; g--) { cum += histo[g]; if (cum >= total * 0.02) { hi = g; break; } }
          const range = Math.max(1, hi - lo);
          // Second pass: stretch contrast to [0,255], grayscale.
          for (let i = 0; i < d.length; i += 4) {
            const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            const v = Math.max(0, Math.min(255, ((gray - lo) / range) * 255));
            d[i] = d[i + 1] = d[i + 2] = v;
          }
          ctx.putImageData(id, 0, 0);
        } catch { /* ignore */ }
        canvas.toBlob(b => resolve(b || file), "image/png");
      };
      img.onerror = () => resolve(file);
      img.src = URL.createObjectURL(file);
    });
  };

  // ── Invoice parser: accepts PDF or image file ─────────────────────
  const parseInvoice = async (file) => {
    setParsing(true);
    try {
      const isPDF = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      const lines = isPDF ? await linesFromPDF(file) : await linesFromImage(file);

      const toNum = (s) => Number(String(s).replace(/[,\s₹]/g, ""));
      const HSN_RX = /^\d{4,8}$/;

      // Step 1: find a per-HSN GST map from the tax summary (Format 2) if present.
      // Look for lines like: "9615  352.38  2.50%  8.81  2.50%  8.81  17.62"
      // We only need the *Taxable Value* → HSN and *rate %* mapping.
      const hsnGstMap = {};
      lines.forEach(raw => {
        // Normalize: strip column separators, split on whitespace/pipe
        const parts = raw.replace(/\|/g, " ").split(/\s+/).map(x => x.trim()).filter(Boolean);
        if (parts.length < 4) return;
        const first = parts[0];
        if (!HSN_RX.test(first)) return;
        const pctMatch = parts.find(p => /^\d+(?:\.\d+)?\s*%$/.test(p));
        if (pctMatch) {
          const rate = toNum(pctMatch.replace("%", ""));
          hsnGstMap[first] = rate * 2; // CGST + SGST
        }
      });

      // Step 2: Detect overall GST from the CGST/SGST totals against the subtotal, if per-HSN map is empty.
      let overallGstPct = null;
      if (Object.keys(hsnGstMap).length === 0) {
        let cgst = 0, sgst = 0, subtotal = 0;
        lines.forEach(raw => {
          const flat = raw.replace(/\|/g, " ");
          const cgstM = flat.match(/CGST[^0-9]*([\d,]+\.\d{2})/i);
          const sgstM = flat.match(/SGST[^0-9]*([\d,]+\.\d{2})/i);
          const subM = flat.match(/(?:Sub[\s-]?Total|Taxable(?:\s+Value)?)[^0-9]*([\d,]+\.\d{2})/i);
          if (cgstM) cgst = toNum(cgstM[1]);
          if (sgstM) sgst = toNum(sgstM[1]);
          if (subM) subtotal = toNum(subM[1]);
        });
        if (subtotal > 0 && (cgst + sgst) > 0) {
          overallGstPct = +(((cgst + sgst) / subtotal) * 100).toFixed(2);
          // snap to common GST slabs
          [5, 12, 18, 28].forEach(s => { if (Math.abs(overallGstPct - s) < 1.5) overallGstPct = s; });
        }
      }

      // Step 3: Identify a likely item-region but fall back to scanning all lines.
      const isHeaderLine = (s) => /description/i.test(s) && /(hsn|sac|quantity|qty|rate|amount)/i.test(s);
      const isEndLine = (s) => /^(\s*)?(c\s*gst|s\s*gst|i\s*gst|cs?gt|sgt|round\s*off|total|grand\s*total|sub[\s-]?total|amount\s+chargeable|tax\s+amount|taxable\s+value|less\s*:?|declaration|e\s*&\s*o\s*e|company['\u2019]s|bank|authorised|subject\s+to)\b/i.test(s);

      let startIdx = lines.findIndex(l => isHeaderLine(l.replace(/\|/g, " ")));
      if (startIdx < 0) startIdx = lines.findIndex(l => /^\s*\d+\.?\s+[A-Za-z]/.test(l.replace(/\|/g, " ")));
      if (startIdx < 0) startIdx = 0;
      let endIdx = lines.length;
      for (let i = startIdx + 1; i < lines.length; i++) {
        const flat = lines[i].replace(/\|/g, " ").replace(/\s+/g, " ").trim();
        if (isEndLine(flat)) { endIdx = i; break; }
      }
      // First try the narrow region; if nothing comes out we'll retry with full lines (later).
      const itemLines = lines.slice(startIdx + 1, endIdx);

      // Step 4: Parse item rows within the identified region.
      // Both invoice formats are: SlNo | Description | HSN | Qty Unit | [Rate incl. Tax] | Rate | per | Amount
      const items = [];
      // Unit class — also accepts OCR-noisy versions (Pcs/Pes/Pc, Nos/Nes/Ns, etc.).
      const UNIT = "(?:p[ce]s?|n[eo]s?|units?|kgs?|ltrs?|ml|box|pkt|pack|pair|set|btls?|bottles?)";
      const rowRx = [
        // Pattern with "Rate (Incl. of Tax)" + plain "Rate" + per + Amount  (Vendor 2)
        new RegExp(`^\\s*(\\d+)\\s+(.+?)\\s+(\\d{4,10})\\s+(\\d+(?:\\.\\d+)?)\\s+(${UNIT})\\s+([\\d,]+(?:\\.\\d+)?)\\s+([\\d,]+(?:\\.\\d+)?)\\s+(?:${UNIT})?\\s*([\\d,]+(?:\\.\\d+)?)\\s*$`, "i"),
        // Single Rate + per + Amount (Vendor 1)
        new RegExp(`^\\s*(\\d+)\\s+(.+?)\\s+(\\d{4,10})\\s+(\\d+(?:\\.\\d+)?)\\s+(${UNIT})\\s+([\\d,]+(?:\\.\\d+)?)\\s+(?:${UNIT})?\\s*([\\d,]+(?:\\.\\d+)?)\\s*$`, "i"),
        // No HSN detected (OCR mangled it) — Vendor 2 layout with rate-incl + rate + amount
        new RegExp(`^\\s*(\\d+)\\s+(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s+(${UNIT})\\s+([\\d,]+(?:\\.\\d+)?)\\s+([\\d,]+(?:\\.\\d+)?)\\s+(?:${UNIT})?\\s*([\\d,]+(?:\\.\\d+)?)\\s*$`, "i"),
        // No HSN — Vendor 1 layout with single rate + amount
        new RegExp(`^\\s*(\\d+)\\s+(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s+(${UNIT})\\s+([\\d,]+(?:\\.\\d+)?)\\s+(?:${UNIT})?\\s*([\\d,]+(?:\\.\\d+)?)\\s*$`, "i"),
      ];

      const scanLines = (linesArr) => {
      linesArr.forEach(raw => {
        const flat = raw.replace(/\|/g, " ").replace(/\s+/g, " ").trim();
        if (flat.length < 8) return;
        if (isHeaderLine(flat) || isEndLine(flat)) return;
        if (/^(sl\s*no|s\.?\s*no|#|description|hsn|sac|qty|quantity|rate|per|amount)\b/i.test(flat)) return;

        // Try structured patterns first
        let parsed = null;
        for (const rx of rowRx) {
          const m = flat.match(rx);
          if (!m) continue;
          if (m.length === 9) {
            // Vendor 2: rate-incl-tax + rate + amount
            parsed = {
              name: m[2].trim(),
              hsn: m[3],
              qty: Number(m[4]),
              unit: m[5].toLowerCase(),
              rate_incl: toNum(m[6]),
              rate_excl: toNum(m[7]),
              amount: toNum(m[8]),
            };
          } else if (m.length === 8) {
            // Vendor 1: single rate + amount (rate is usually excl. tax; amount = qty * rate)
            parsed = {
              name: m[2].trim(),
              hsn: m[3],
              qty: Number(m[4]),
              unit: m[5].toLowerCase(),
              rate_excl: toNum(m[6]),
              amount: toNum(m[7]),
            };
          }
          if (parsed) break;
        }

        // Fallback: OCR'd / messy lines — any line with a qty + unit + price pattern counts as an item.
        if (!parsed) {
          if (/^(sl|s\.?\s*no|#|description|hsn|sac|rate|qty|quantity|per|amount|total|the\s+beauty|lucky\s+store|tax\s+invoice|company|bank|state|gstin|buyer|dispatch|consignee|signatory)\b/i.test(flat)) return;

          // Try "<name> ... <qty> <unit> ... <price>"
          let looseM = flat.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s+(pcs?|nos?|units?|kgs?|ltrs?|ml|box|pkt|pack|pair|set|btls?|bottles?)\s+.*?([\d,]+(?:\.\d+)?)\s*$/i);
          if (looseM) {
            const hsnInLine = flat.match(/\b(\d{4,8})\b/);
            parsed = {
              name: looseM[1].replace(/^\d+\.?\s+/, "").trim(),
              hsn: hsnInLine ? hsnInLine[1] : "",
              qty: Number(looseM[2]) || 1,
              unit: looseM[3].toLowerCase(),
              amount: toNum(looseM[4]),
            };
          } else {
            // Second fallback: any line that has a description + at least two numbers and ends with a price.
            // Useful for tables where units were dropped by OCR.
            const nums = flat.match(/(\d+(?:,\d+)*(?:\.\d+)?)/g);
            if (!nums || nums.length < 2) return;
            const lastPrice = toNum(nums[nums.length - 1]);
            const qtyGuess = Number(nums[0]) || 1;
            if (!(lastPrice > 0) || lastPrice < 5) return;
            // Name is the text before the first number
            const firstNumIdx = flat.search(/\d/);
            const namePart = flat.slice(0, firstNumIdx).replace(/^\d+\.?\s+/, "").trim();
            if (namePart.length < 3) return;
            parsed = {
              name: namePart,
              hsn: (flat.match(/\b(\d{4,8})\b/) || [])[1] || "",
              qty: qtyGuess > 0 && qtyGuess < 1000 ? qtyGuess : 1,
              unit: "pcs",
              amount: lastPrice,
            };
          }
          if (!parsed.name || parsed.name.length < 2) return;
          if (!(parsed.amount > 0)) return;
        }

        if (!parsed.name || parsed.name.length < 2) return;
        if (!(parsed.amount > 0)) return;

        // Decide the GST %
        let gstPct = hsnGstMap[parsed.hsn];
        if (gstPct == null) gstPct = overallGstPct;
        if (gstPct == null) gstPct = 18;

        // Compute per-unit price INCL. GST
        // If vendor 2: rate_incl is per-unit MRP incl tax → use directly
        // Else: price_per_unit = amount / qty, treat as excl; add GST
        let priceInc;
        if (parsed.rate_incl != null) {
          priceInc = parsed.rate_incl;
        } else {
          const perUnitExcl = parsed.qty > 0 ? parsed.amount / parsed.qty : (parsed.rate_excl || 0);
          priceInc = +(perUnitExcl * (1 + gstPct / 100)).toFixed(2);
        }
        const basePrice = +(priceInc / (1 + gstPct / 100)).toFixed(2);

        items.push({
          name: parsed.name.replace(/\s+/g, " ").trim(),
          qty: parsed.qty,
          unit: parsed.unit,
          price_inc_gst: priceInc,
          gst_pct: gstPct,
          base_price: basePrice,
          hsn: parsed.hsn,
          amount: parsed.amount,
        });
      });
      };

      // First pass — only the identified region
      scanLines(itemLines);
      // Retry with all lines if the region gave us nothing
      if (items.length === 0) scanLines(lines);

      // Dedup by name (keep last occurrence)
      const byName = new Map();
      items.forEach(i => byName.set(i.name.toLowerCase(), i));
      const unique = Array.from(byName.values());

      // Attach existing material match + price diff
      const enriched = unique.map(i => {
        const existing = materials.find(m => m.name?.toLowerCase() === i.name.toLowerCase());
        return {
          ...i,
          existing: existing ? { id: existing.id, old_price: existing.current_price || 0, old_gst: existing.gst_pct || 18 } : null,
          include: true,
        };
      });

      if (enriched.length === 0) {
        // Open the Review modal in manual-entry mode, with the raw OCR/PDF text visible as a hint.
        setReviewModal({
          fileName: file.name,
          items: [{ name: "", qty: 1, unit: "pcs", price_inc_gst: 0, gst_pct: 18, base_price: 0, hsn: "", existing: null, include: true }],
          source: isPDF ? "pdf" : "image",
          rawLines: lines.slice(0, 120), // cap to keep modal responsive
          manual: true,
        });
        toast({ title: "Auto-detect failed", message: "Add rows manually — raw text from the invoice is shown for reference.", type: "warning" });
        return;
      }

      setReviewModal({ fileName: file.name, items: enriched, source: isPDF ? "pdf" : "image", rawLines: lines.slice(0, 120) });
    } catch (err) {
      console.error("Invoice parse error:", err);
      confirm({ title: "Parse Error", message: err.message || "Failed to read invoice.", confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    } finally {
      setParsing(false);
      setOcrProgress(0);
    }
  };

  const handleInvoiceUpload = (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file) return;
    const isExcel = /\.(xlsx|xls)$/i.test(file.name) ||
      file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.type === "application/vnd.ms-excel";
    if (isExcel) parseTemplate(file);
    else parseInvoice(file);
  };

  // ── Template: Download an Excel with the standardized columns ──
  const downloadTemplate = async () => {
    try {
      const ExcelJS = await loadExcelJS();
      const wb = new ExcelJS.Workbook();
      wb.creator = "V-Cut";
      wb.created = new Date();
      const ws = wb.addWorksheet("Materials", { views: [{ state: "frozen", ySplit: 1 }] });

      const headerFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFB4D7A8" } };
      const headerFont = { bold: true, color: { argb: "FF1F2937" }, size: 12 };
      const thin = { style: "thin", color: { argb: "FF94A3B8" } };
      const border = { top: thin, left: thin, bottom: thin, right: thin };

      const headers = ["Bill No", "DATE", "VENDOR", "Description", "GROUP", "QTY", "RATE", "AMT"];
      const row = ws.getRow(1);
      headers.forEach((h, i) => {
        const c = row.getCell(i + 1);
        c.value = h;
        c.font = headerFont;
        c.fill = headerFill;
        c.alignment = { vertical: "middle", horizontal: "center" };
        c.border = border;
      });
      row.height = 26;

      ws.columns = [
        { width: 10 }, { width: 12 }, { width: 16 }, { width: 36 },
        { width: 16 }, { width: 8 }, { width: 10 }, { width: 12 },
      ];

      // Data validation + formatting on 200 data rows
      const MAX_ROWS = 201;
      for (let r = 2; r <= MAX_ROWS; r++) {
        const rr = ws.getRow(r);
        // Bill No, Date, Vendor, Description (plain)
        rr.getCell(1).border = border;
        rr.getCell(2).border = border;
        rr.getCell(2).numFmt = "dd-mm-yyyy";
        rr.getCell(2).dataValidation = {
          type: "date", operator: "greaterThan", formulae: [new Date("2020-01-01")],
          showErrorMessage: true, errorStyle: "error", errorTitle: "Invalid date", error: "Enter a valid date (dd-mm-yyyy).",
        };
        rr.getCell(3).border = border;
        rr.getCell(4).border = border;

        // Group — dropdown
        rr.getCell(5).border = border;
        rr.getCell(5).dataValidation = {
          type: "list", allowBlank: true,
          formulae: ['"' + MATERIAL_GROUPS.join(",") + '"'],
          showErrorMessage: true, errorStyle: "warning", errorTitle: "Unknown group", error: "Pick from the dropdown or add to the master list.",
        };
        rr.getCell(5).alignment = { horizontal: "center" };

        // QTY numeric
        rr.getCell(6).border = border;
        rr.getCell(6).numFmt = "0";
        rr.getCell(6).alignment = { horizontal: "center" };
        rr.getCell(6).dataValidation = {
          type: "whole", operator: "greaterThan", formulae: [0],
          showErrorMessage: true, errorStyle: "error", errorTitle: "Invalid qty", error: "Qty must be a positive whole number.",
        };

        // Rate numeric
        rr.getCell(7).border = border;
        rr.getCell(7).numFmt = "#,##0.00";
        rr.getCell(7).alignment = { horizontal: "right" };
        rr.getCell(7).dataValidation = {
          type: "decimal", operator: "greaterThan", formulae: [0],
          showErrorMessage: true, errorStyle: "error", errorTitle: "Invalid rate", error: "Rate must be a positive number.",
        };

        // AMT — formula = QTY * RATE
        rr.getCell(8).value = { formula: `F${r}*G${r}`, result: 0 };
        rr.getCell(8).numFmt = "#,##0.00";
        rr.getCell(8).alignment = { horizontal: "right" };
        rr.getCell(8).border = border;
        rr.getCell(8).font = { bold: true };
      }

      // Autofilter
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };

      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const dt = new Date();
      const fileName = `V-Cut_Materials_Template_${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, "0")}${String(dt.getDate()).padStart(2, "0")}.xlsx`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast({ title: "Template Downloaded", message: `${fileName} — fill and upload it back.`, type: "success" });
    } catch (err) {
      toast({ title: "Template Error", message: err.message || "Unknown error", type: "error" });
    }
  };

  // ── Parse filled Excel template ──
  const parseTemplate = async (file) => {
    setParsing(true);
    try {
      const ExcelJS = await loadExcelJS();
      const buffer = await file.arrayBuffer();
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer);
      if (wb.worksheets.length === 0) throw new Error("Workbook has no sheets.");

      // Build header index map for a given sheet (tolerant to column reordering + row 1/2/3).
      const detectHeader = (ws) => {
        for (let rowNum = 1; rowNum <= Math.min(5, ws.rowCount); rowNum++) {
          const headerRow = ws.getRow(rowNum);
          const colIdx = {};
          headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
            const v = String(cell.value || "").trim().toLowerCase();
            if (!v) return;
            if (/bill/.test(v)) colIdx.billNo = col;
            else if (/date/.test(v)) colIdx.date = col;
            else if (/vendor/.test(v)) colIdx.vendor = col;
            else if (/desc/.test(v)) colIdx.desc = col;
            else if (/group/.test(v)) colIdx.group = col;
            else if (/^qt|qnt|qty|quantity/.test(v)) colIdx.qty = col;
            else if (/rate/.test(v)) colIdx.rate = col;
            else if (/^amt|amount/.test(v)) colIdx.amt = col;
          });
          // Accept only sheets where the core columns are present.
          const has = (k) => !!colIdx[k];
          if (has("desc") && has("rate") && (has("qty") || has("amt"))) return { headerRowNum: rowNum, colIdx };
        }
        return null;
      };

      // Find matching sheets and remember the skipped ones.
      const matched = [];
      const skipped = [];
      wb.worksheets.forEach(ws => {
        const det = detectHeader(ws);
        if (det) matched.push({ ws, ...det });
        else skipped.push(ws.name);
      });
      if (matched.length === 0) throw new Error("No sheet matched the template header. Expected columns: Description, Rate, QTY (or AMT).");

      const readCell = (row, idx) => {
        if (!idx) return undefined;
        const v = row.getCell(idx).value;
        if (v == null) return undefined;
        if (typeof v === "object") {
          if ("result" in v) return v.result;
          if ("text" in v) return v.text;
          if (v instanceof Date) return v.toISOString().slice(0, 10);
        }
        return v;
      };

      const items = [];
      // Scan every matching sheet and combine results. Unmatched sheets are ignored.
      matched.forEach(({ ws: sheet, colIdx: ci, headerRowNum: hrn }) => {
        for (let r = hrn + 1; r <= sheet.rowCount; r++) {
          const row = sheet.getRow(r);
          const desc = readCell(row, ci.desc);
          if (!desc || String(desc).trim().length < 2) continue;
          const qty = Number(readCell(row, ci.qty)) || 1;
          const rate = Number(readCell(row, ci.rate)) || 0;
          const amt = Number(readCell(row, ci.amt)) || (qty * rate);
          if (rate <= 0 && amt <= 0) continue;
          const group = String(readCell(row, ci.group) || "").trim();
          const vendor = String(readCell(row, ci.vendor) || "").trim();
          const billNo = String(readCell(row, ci.billNo) || "").trim();
          const dateV = readCell(row, ci.date);
          const dateStr = dateV instanceof Date ? dateV.toISOString().slice(0, 10)
            : typeof dateV === "string" ? dateV : (dateV ? String(dateV) : "");
          const priceInc = rate > 0 ? rate : (qty > 0 ? amt / qty : 0);
          const gstPct = 18;
          const basePrice = +(priceInc / (1 + gstPct / 100)).toFixed(2);
          const name = String(desc).trim();
          const existing = materials.find(m => m.name?.toLowerCase() === name.toLowerCase()) || null;
          items.push({
            name, qty, unit: "pcs",
            price_inc_gst: priceInc, gst_pct: gstPct, base_price: basePrice,
            hsn: "", amount: amt,
            group, vendor, bill_no: billNo, bill_date: dateStr,
            source_sheet: sheet.name,
            existing: existing ? { id: existing.id, old_price: existing.current_price || 0, old_gst: existing.gst_pct || 18 } : null,
            include: true,
          });
        }
      });

      if (items.length === 0) {
        toast({ title: "Empty Template", message: "Matching sheet(s) had no data rows. Please fill at least one row.", type: "warning" });
        return;
      }

      const matchedNames = matched.map(m => m.ws.name).join(", ");
      if (skipped.length > 0) {
        toast({
          title: `Read ${matched.length} Sheet${matched.length > 1 ? "s" : ""}`,
          message: `Parsed: ${matchedNames}. Ignored: ${skipped.join(", ")} (header didn't match).`,
          type: "info",
        });
      }

      setReviewModal({ fileName: file.name, items, source: "excel", matchedSheets: matchedNames, skippedSheets: skipped });
    } catch (err) {
      confirm({ title: "Upload Error", message: err.message || "Failed to read template.", confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    } finally {
      setParsing(false);
    }
  };

  const commitReview = async () => {
    if (!reviewModal) return;
    try {
      const batch = writeBatch(db);
      const nowISO = new Date().toISOString();
      const today = nowISO.slice(0, 10);
      let created = 0, updated = 0, unchanged = 0, priceChanges = 0;
      const justImported = []; // { material_id, name, unit, qty, price_at_transfer }

      for (const it of reviewModal.items) {
        if (!it.include) continue;
        const payload = {
          name: it.name,
          unit: it.unit || "pcs",
          gst_pct: Number(it.gst_pct) || 0,
          current_price: Number(it.price_inc_gst) || 0,
          base_price: Number(it.base_price) || 0,
          last_updated: nowISO,
          last_updated_by: currentUser?.id || currentUser?.name || "admin",
          ...(it.group ? { group: it.group } : {}),
          ...(it.vendor ? { last_vendor: it.vendor } : {}),
          ...(it.bill_no ? { last_bill_no: it.bill_no } : {}),
          ...(it.bill_date ? { last_bill_date: it.bill_date } : {}),
        };
        let materialId;
        const rowQty = Number(it.qty) || 0;
        if (it.existing) {
          materialId = it.existing.id;
          const priceChanged = Math.abs((it.existing.old_price || 0) - (it.price_inc_gst || 0)) > 0.01;
          // merge the latest metadata + increment the lifetime purchased qty counter
          batch.set(doc(db, "materials", materialId), payload, { merge: true });
          if (rowQty > 0) {
            batch.update(doc(db, "materials", materialId), { total_purchased: increment(rowQty) });
          }
          if (priceChanged) {
            const hRef = doc(collection(db, "material_price_history"));
            batch.set(hRef, {
              material_id: materialId,
              material_name: it.name,
              old_price: it.existing.old_price || 0,
              new_price: it.price_inc_gst,
              gst_pct: it.gst_pct,
              effective_from: today,
              source: reviewModal.source || "upload",
              qty: Number(it.qty) || 0,
              event: "price_change",
              changed_by: currentUser?.id || currentUser?.name || "admin",
              changed_at: nowISO,
            });
            priceChanges++;
            updated++;
          } else {
            unchanged++;
            // Still log a purchase event so qty is captured even when price is unchanged.
            if (Number(it.qty) > 0) {
              const hRef = doc(collection(db, "material_price_history"));
              batch.set(hRef, {
                material_id: materialId,
                material_name: it.name,
                old_price: it.existing.old_price || 0,
                new_price: it.price_inc_gst,
                gst_pct: it.gst_pct,
                effective_from: today,
                source: reviewModal.source || "upload",
                qty: Number(it.qty) || 0,
                event: "purchase",
                changed_by: currentUser?.id || currentUser?.name || "admin",
                changed_at: nowISO,
              });
            }
          }
        } else {
          const mRef = doc(collection(db, "materials"));
          materialId = mRef.id;
          batch.set(mRef, { ...payload, total_purchased: rowQty });
          const hRef = doc(collection(db, "material_price_history"));
          batch.set(hRef, {
            material_id: materialId,
            material_name: it.name,
            old_price: 0,
            new_price: it.price_inc_gst,
            gst_pct: it.gst_pct,
            effective_from: today,
            source: reviewModal.source || "upload",
            qty: Number(it.qty) || 0,
            changed_by: currentUser?.id || currentUser?.name || "admin",
            changed_at: nowISO,
          });
          created++;
        }
        justImported.push({
          material_id: materialId,
          name: it.name,
          unit: it.unit || "pcs",
          qty: Number(it.qty) || 1,
          price_at_transfer: Number(it.price_inc_gst) || 0,
        });
      }
      await batch.commit();
      toast({ title: "Imported", message: `${created} added, ${updated} updated (${priceChanges} price changes), ${unchanged} unchanged.`, type: "success" });
      setReviewModal(null);

      // After import, open the transfer/allocation modal so the user can send these materials to a branch.
      if (justImported.length > 0) {
        setTransferModal({
          branch_id: "",
          date: today,
          items: justImported,
          note: reviewModal.fileName ? `Imported from ${reviewModal.fileName}` : "",
          auto_entry_update: true,
        });
      }
    } catch (err) {
      confirm({ title: "Import Error", message: err.message || "Unknown error", confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    }
  };

  const toggleSelect = (id) => {
    setSelectedIds(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  };

  const openTransferModal = () => {
    if (selectedIds.length === 0) return;
    const items = selectedIds.map(id => {
      const m = materials.find(x => x.id === id);
      return { material_id: id, name: m?.name || "—", unit: m?.unit || "pcs", qty: 1, price_at_transfer: m?.current_price || 0 };
    });
    setTransferModal({ branch_id: "", date: new Date().toISOString().slice(0, 10), items, note: "", auto_entry_update: true });
  };

  const commitTransfer = async () => {
    if (!transferModal || !transferModal.branch_id) {
      confirm({ title: "Branch Required", message: "Please select a destination branch.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} });
      return;
    }
    if (!transferModal.date) {
      confirm({ title: "Date Required", message: "Please select a transfer date.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} });
      return;
    }
    // Skip empty rows (user may have added extra blank rows that were never filled).
    const filledItems = transferModal.items.filter(i => i.material_id && Number(i.qty) > 0);
    if (filledItems.length === 0) {
      confirm({ title: "Nothing to Transfer", message: "Please pick at least one material from the master and enter a qty > 0.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} });
      return;
    }
    try {
      const branch = branches.find(b => b.id === transferModal.branch_id);
      const total = filledItems.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price_at_transfer) || 0), 0);
      const nowISO = new Date().toISOString();
      const transferDate = transferModal.date;

      // Save allocation
      await addDoc(collection(db, "material_allocations"), {
        branch_id: transferModal.branch_id,
        branch_name: branch?.name || "",
        date: transferDate,
        items: filledItems.map(i => ({
          material_id: i.material_id,
          name: i.name,
          qty: Number(i.qty) || 0,
          unit: i.unit,
          price_at_transfer: Number(i.price_at_transfer) || 0,
          line_total: (Number(i.qty) || 0) * (Number(i.price_at_transfer) || 0),
        })),
        total,
        note: transferModal.note || "",
        transferred_by: currentUser?.id || currentUser?.name || "admin",
        transferred_at: nowISO,
      });

      // Auto-update the daily entry's material expense for that branch+date
      if (transferModal.auto_entry_update && total > 0) {
        const { getDocs, query: fsQuery, where, updateDoc: fsUpdate, addDoc: fsAdd } = await import("firebase/firestore");
        const entriesQ = fsQuery(
          collection(db, "entries"),
          where("branch_id", "==", transferModal.branch_id),
          where("date", "==", transferDate)
        );
        const snap = await getDocs(entriesQ);
        if (!snap.empty) {
          const existing = snap.docs[0];
          const data = existing.data();
          const newMat = (Number(data.mat_expense) || 0) + total;
          const activity = Array.isArray(data.activity_log) ? [...data.activity_log] : [];
          activity.push({
            action: "Material Transfer",
            user: currentUser?.name || currentUser?.id || "admin",
            time: nowISO,
            note: `Added ₹${total.toFixed(2)} material expense from ${transferModal.items.length} item(s)`,
          });
          await fsUpdate(existing.ref, { mat_expense: newMat, activity_log: activity, updated_at: nowISO });
        } else {
          // No entry for that day yet — create a minimal one so the expense is captured.
          await fsAdd(collection(db, "entries"), {
            branch_id: transferModal.branch_id,
            date: transferDate,
            online: 0, cash: 0,
            mat_expense: total,
            others: 0, petrol: 0,
            staff_billing: [],
            total_gst: 0,
            activity_log: [{
              action: "Create",
              user: currentUser?.name || currentUser?.id || "admin",
              time: nowISO,
              note: `Stub created via material transfer (₹${total.toFixed(2)})`,
            }],
            created_at: nowISO,
          });
        }
      }

      toast({ title: "Transferred", message: `${filledItems.length} material(s) sent to ${branch?.name} on ${transferDate}. Daily entry updated with ₹${total.toFixed(0)} material expense.`, type: "success" });
      setTransferModal(null);
      setSelectedIds([]);
    } catch (err) {
      confirm({ title: "Transfer Error", message: err.message || "Unknown error", confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    }
  };

  const openAddMaterial = (existing = null) => {
    const today = new Date().toISOString().slice(0, 10);
    setAddMaterialModal(existing
      ? { editingId: existing.id, name: existing.name || "", unit: existing.unit || "pcs", group: existing.group || "", gst_pct: existing.gst_pct ?? 18, price_inc_gst: existing.current_price || 0, qty: 1, purchase_date: today }
      : { editingId: null, name: "", unit: "pcs", group: "", gst_pct: 18, price_inc_gst: 0, qty: 1, purchase_date: today });
  };

  const saveMaterialForm = async () => {
    const f = addMaterialModal;
    if (!f?.name?.trim()) { confirm({ title: "Name Required", message: "Please enter a material name.", confirmText: "OK", type: "warning", onConfirm: () => {} }); return; }
    if (!(f.price_inc_gst > 0)) { confirm({ title: "Price Required", message: "Please enter a price greater than 0.", confirmText: "OK", type: "warning", onConfirm: () => {} }); return; }
    if (!(Number(f.qty) > 0)) { confirm({ title: "Qty Required", message: "Please enter a purchase quantity greater than 0.", confirmText: "OK", type: "warning", onConfirm: () => {} }); return; }
    if (!f.purchase_date) { confirm({ title: "Date Required", message: "Please pick a purchase date.", confirmText: "OK", type: "warning", onConfirm: () => {} }); return; }
    const name = f.name.trim();
    const nowISO = new Date().toISOString();
    const priceInc = Number(f.price_inc_gst) || 0;
    const gstPct = Number(f.gst_pct) || 0;
    const qty = Number(f.qty) || 0;
    const purchaseDate = f.purchase_date;
    const basePrice = +(priceInc / (1 + gstPct / 100)).toFixed(2);

    // Auto-consolidate to existing master record when adding by name
    let targetId = f.editingId;
    let existing = f.editingId ? materials.find(m => m.id === f.editingId) : null;
    if (!targetId) {
      const dup = materials.find(m => (m.name || "").toLowerCase() === name.toLowerCase() && !m.archived);
      if (dup) { targetId = dup.id; existing = dup; }
    }

    const payload = {
      name,
      unit: f.unit || "pcs",
      gst_pct: gstPct,
      current_price: priceInc,
      base_price: basePrice,
      last_updated: nowISO,
      last_updated_by: currentUser?.id || currentUser?.name || "admin",
      ...(f.group ? { group: f.group } : {}),
      archived: false,
    };

    try {
      const batch = writeBatch(db);
      let mId = targetId;
      if (mId) {
        batch.set(doc(db, "materials", mId), payload, { merge: true });
        batch.update(doc(db, "materials", mId), { total_purchased: increment(qty) });
      } else {
        const mRef = doc(collection(db, "materials"));
        mId = mRef.id;
        batch.set(mRef, { ...payload, total_purchased: qty });
      }
      const priceChanged = existing && Math.abs((Number(existing.current_price) || 0) - priceInc) > 0.01;
      batch.set(doc(collection(db, "material_price_history")), {
        material_id: mId, material_name: name,
        old_price: existing ? (Number(existing.current_price) || 0) : 0,
        new_price: priceInc,
        gst_pct: gstPct,
        qty,
        effective_from: purchaseDate,
        event: existing ? (priceChanged ? "price_change" : "purchase") : "first_purchase",
        source: "manual",
        changed_by: currentUser?.id || currentUser?.name || "admin",
        changed_at: nowISO,
      });
      await batch.commit();
      const msg = existing
        ? (priceChanged ? `Purchase logged · price updated ${INR(existing.current_price || 0)} → ${INR(priceInc)}` : `Purchase logged · ${qty} ${f.unit || "pcs"} on ${purchaseDate}`)
        : `${name} added to master · first purchase ${qty} ${f.unit || "pcs"} on ${purchaseDate}`;
      toast({ title: existing ? "Purchase Recorded" : "Material Added", message: msg, type: "success" });
      setAddMaterialModal(null);
    } catch (err) {
      confirm({ title: "Save Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    }
  };

  const handleDeleteMaterial = (m) => {
    confirm({
      title: `Remove ${m.name} from inventory?`,
      message: "The material will disappear from this Materials list, but the record stays in <strong>Material Master</strong> as a purchase log. Price history also stays for audit.",
      confirmText: "Remove", cancelText: "Cancel", type: "danger",
      onConfirm: async () => {
        try {
          await updateDoc(doc(db, "materials", m.id), { archived: true, archived_at: new Date().toISOString() });
          toast({ title: "Removed", message: `${m.name} hidden from inventory — still visible in Material Master.`, type: "success" });
        } catch (e) { confirm({ title: "Error", message: e.message, confirmText: "OK", type: "danger", onConfirm: () => {} }); }
      },
    });
  };

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "var(--accent)", fontWeight: 700 }}>Loading materials...</div>;

  // Summary stats
  const totalValue = materials.reduce((s, m) => s + (Number(m.current_price) || 0), 0);
  const recentPriceChanges = priceHistory.filter(h => h.old_price > 0 && h.new_price !== h.old_price).slice(0, 50);

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 900, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 2, marginBottom: 4 }}>Inventory</div>
          <div style={{ fontSize: 26, fontWeight: 900, color: "var(--text)", letterSpacing: -0.5 }}>Materials</div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button onClick={downloadTemplate}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 16px", borderRadius: 12, background: "var(--bg3)", color: "var(--orange)", border: "1px solid rgba(72,72,71,0.15)", fontWeight: 800, fontSize: 12, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
            <Icon name="save" size={13} /> Template
          </button>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 18px", borderRadius: 12, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", fontWeight: 800, fontSize: 12, cursor: parsing ? "wait" : "pointer", textTransform: "uppercase", letterSpacing: 0.5, opacity: parsing ? 0.6 : 1 }}>
            <Icon name="plus" size={14} /> {parsing ? (ocrProgress > 0 && ocrProgress < 100 ? `Scanning Image ${ocrProgress}%` : "Reading File...") : "Upload (Excel / PDF / Image)"}
            <input type="file" accept=".xlsx,.xls,application/pdf,image/*" style={{ display: "none" }} onChange={handleInvoiceUpload} disabled={parsing} />
          </label>
          {selectedIds.length > 0 && (
            <button onClick={openTransferModal}
              style={{ padding: "10px 18px", borderRadius: 12, background: "var(--gold)", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5 }}>
              Transfer {selectedIds.length} to Branch →
            </button>
          )}
        </div>
      </div>

      {/* KPI strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 20 }}>
        {[
          ["Total Materials", materials.length, "var(--accent)"],
          ["Catalog Value", INR(totalValue), "var(--green)"],
          ["Price Changes Logged", recentPriceChanges.length, "var(--orange)"],
          ["Branch Transfers", allocations.length, "var(--blue)"],
        ].map(([l, v, c]) => (
          <div key={l} style={{ padding: 14, borderRadius: 12, background: "var(--bg3)", border: "1px solid var(--border)" }}>
            <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: c, marginTop: 4 }}>{v}</div>
          </div>
        ))}
      </div>

      {/* Tab switcher */}
      <div style={{ display: "flex", gap: 4, marginBottom: 16, background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 10, padding: 4 }}>
        {[["list", `📦 Material Master (${materials.length})`], ["add", `➕ Add Material`], ["transfers", `🚚 Transfers (${allocations.length})`]].map(([k, l]) => (
          <button key={k} onClick={() => {
            setTab(k);
            if (k === "add" && addRows.length === 0) setAddRowsPrompt({ count: addNumRows || 10 });
          }}
            style={{ flex: 1, padding: "10px 14px", fontSize: 12, fontWeight: 800, border: "none", borderRadius: 8, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.5,
              background: tab === k ? "linear-gradient(135deg,var(--accent),var(--gold2))" : "transparent",
              color: tab === k ? "#000" : "var(--text3)" }}>
            {l}
          </button>
        ))}
      </div>

      {tab === "list" && (() => {
        // Aggregate totals across filtered materials
        const vis = filteredMaterials;
        let totalPurchased = 0, totalTransferred = 0, totalValueIncl = 0, totalPurchasedValue = 0;
        vis.forEach(m => {
          const pur = purchasedFor(m.id);
          const tra = transferredQtyByMaterial[m.id] || 0;
          totalPurchased += pur;
          totalTransferred += tra;
          totalValueIncl += (Number(m.current_price) || 0) * Math.max(0, pur - tra);
          totalPurchasedValue += (Number(m.current_price) || 0) * pur;
        });
        return (
          <>
            {/* KPI strip */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 12, marginBottom: 12 }}>
              {[
                ["Unique Materials", vis.length, "var(--accent)"],
                ["Total Qty Purchased", totalPurchased, "var(--green)"],
                ["Total Qty Transferred", totalTransferred, "var(--orange)"],
                ["Qty Available", Math.max(0, totalPurchased - totalTransferred), "var(--blue)"],
                ["Stock Value (avail × price)", INR(totalValueIncl), "var(--gold)"],
                ["All-Time Purchase Value", INR(totalPurchasedValue), "var(--red)"],
              ].map(([l, v, c]) => (
                <div key={l} style={{ padding: 12, borderRadius: 12, background: "var(--bg3)", border: "1px solid var(--border)" }}>
                  <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: c, marginTop: 4, fontFamily: "var(--font-headline, var(--font-outfit))" }}>{v}</div>
                </div>
              ))}
            </div>
        <Card style={{ padding: 0, overflowX: "auto" }}>
          <div style={{ padding: 12, borderBottom: "1px solid var(--border)", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input placeholder="Search material master..." value={search} onChange={e => setSearch(e.target.value)}
              style={{ padding: "8px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, flex: "1 1 240px", minWidth: "min(240px, 100%)", outline: "none" }} />
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 8, background: "rgba(34,211,238,0.05)", border: "1px dashed rgba(34,211,238,0.2)" }}>
              <span style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Price</span>
              <input type="number" placeholder="min" value={priceMin} onChange={e => setPriceMin(e.target.value)} style={{ padding: "8px 10px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, width: 82, outline: "none" }} />
              <span style={{ color: "var(--text3)" }}>–</span>
              <input type="number" placeholder="max" value={priceMax} onChange={e => setPriceMax(e.target.value)} style={{ padding: "8px 10px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, width: 82, outline: "none" }} />
            </div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 8, background: "rgba(245,158,11,0.05)", border: "1px dashed rgba(245,158,11,0.2)" }}>
              <span style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Qty Purchased</span>
              <input type="number" placeholder="min" value={qtyMin} onChange={e => setQtyMin(e.target.value)} style={{ padding: "8px 10px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, width: 82, outline: "none" }} />
              <span style={{ color: "var(--text3)" }}>–</span>
              <input type="number" placeholder="max" value={qtyMax} onChange={e => setQtyMax(e.target.value)} style={{ padding: "8px 10px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, width: 82, outline: "none" }} />
            </div>
            {(search || priceMin !== "" || priceMax !== "" || qtyMin !== "" || qtyMax !== "") && (
              <button onClick={() => { setSearch(""); setPriceMin(""); setPriceMax(""); setQtyMin(""); setQtyMax(""); }} title="Clear filters"
                style={{ padding: "8px 12px", borderRadius: 8, background: "rgba(215,56,59,0.08)", color: "var(--red)", border: "1px solid rgba(215,56,59,0.25)", cursor: "pointer", fontWeight: 800, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Icon name="close" size={12} /> Clear
              </button>
            )}
            <button onClick={() => openAddMaterial()} title="Add a material manually"
              style={{ padding: "8px 14px", borderRadius: 8, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 800, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
              <Icon name="plus" size={12} /> Add Material
            </button>
            <button onClick={() => {
              confirm({
                title: "Recalculate Purchased Qty?",
                message: "This rebuilds each material's total_purchased counter by summing the qty logged in its price history. Safe to run anytime — no transfers or prices are affected.",
                confirmText: "Recalculate", cancelText: "Cancel", type: "warning",
                onConfirm: async () => {
                  try {
                    const batch = writeBatch(db);
                    const totals = {};
                    priceHistory.forEach(h => {
                      if (!h.material_id) return;
                      totals[h.material_id] = (totals[h.material_id] || 0) + (Number(h.qty) || 0);
                    });
                    let count = 0;
                    materials.forEach(m => {
                      const newTotal = totals[m.id] || 0;
                      if ((Number(m.total_purchased) || 0) !== newTotal) {
                        batch.update(doc(db, "materials", m.id), { total_purchased: newTotal });
                        count++;
                      }
                    });
                    if (count === 0) {
                      toast({ title: "Already in Sync", message: "No changes needed.", type: "info" });
                      return;
                    }
                    await batch.commit();
                    toast({ title: "Recalculated", message: `${count} material${count === 1 ? "" : "s"} updated.`, type: "success" });
                  } catch (e) {
                    confirm({ title: "Error", message: e.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
                  }
                },
              });
            }} title="Rebuild Purchased qty counters from price history"
              style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg4)", color: "var(--gold)", border: "1px solid var(--border2)", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 800, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
              <Icon name="log" size={12} /> Recalc Stock
            </button>
            {selectedIds.length > 0 && (
              <>
                <span style={{ padding: "6px 10px", borderRadius: 8, background: "rgba(34,211,238,0.1)", color: "var(--accent)", fontSize: 11, fontWeight: 800, letterSpacing: 0.5 }}>
                  {selectedIds.length} selected
                </span>
                <button onClick={() => {
                  const names = selectedIds
                    .map(id => materialsById.get(id)?.name)
                    .filter(Boolean);
                  const preview = names.slice(0, 6).join(", ");
                  const more = names.length > 6 ? ` + ${names.length - 6} more` : "";
                  confirm({
                    title: `Remove ${selectedIds.length} Material${selectedIds.length === 1 ? "" : "s"} from inventory?`,
                    message: `<strong>${preview}${more}</strong><br/><br/>They will disappear from this list but stay in <strong>Material Master</strong> as a purchase log. Price history also stays for audit.`,
                    confirmText: "Yes, Remove All",
                    cancelText: "Cancel",
                    type: "danger",
                    onConfirm: async () => {
                      try {
                        const batch = writeBatch(db);
                        const nowISO = new Date().toISOString();
                        selectedIds.forEach(id => batch.update(doc(db, "materials", id), { archived: true, archived_at: nowISO }));
                        await batch.commit();
                        toast({ title: "Removed", message: `${selectedIds.length} material${selectedIds.length === 1 ? "" : "s"} hidden from inventory — still visible in Material Master.`, type: "success" });
                        setSelectedIds([]);
                      } catch (e) {
                        confirm({ title: "Error", message: e.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
                      }
                    },
                  });
                }}
                  style={{ padding: "6px 14px", borderRadius: 8, background: "var(--red-bg)", color: "var(--red)", border: "1px solid rgba(248,113,113,0.4)", cursor: "pointer", fontWeight: 800, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Icon name="del" size={12} /> Delete Selected
                </button>
                <button onClick={() => setSelectedIds([])} style={{ padding: "6px 12px", borderRadius: 8, background: "transparent", color: "var(--text3)", border: "1px solid var(--border2)", cursor: "pointer", fontWeight: 700, fontSize: 11 }}>
                  Clear
                </button>
              </>
            )}
          </div>
          <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
            <thead>
              <tr>
                <TH style={{ width: 40 }}>
                  <input type="checkbox" checked={filteredMaterials.length > 0 && filteredMaterials.every(m => selectedIdSet.has(m.id))}
                    onChange={e => { if (e.target.checked) setSelectedIds(filteredMaterials.map(m => m.id)); else setSelectedIds([]); }} />
                </TH>
                <TH>Material</TH>
                <TH>Group</TH>
                <TH right title="Purchased (tracked) − Transferred till date">Available</TH>
                <TH>Unit</TH>
                <TH right>GST %</TH>
                <TH right>Base Price</TH>
                <TH right>Price (incl. GST)</TH>
                <TH>Last Updated</TH>
                <TH right>Actions</TH>
              </tr>
            </thead>
            <tbody>
              {filteredMaterials.map(m => {
                const hist = priceHistory.filter(h => h.material_id === m.id);
                const latest = hist[0];
                const priceChanged = latest && latest.old_price > 0 && latest.new_price !== latest.old_price;
                const trendUp = priceChanged && latest.new_price > latest.old_price;
                return (
                  <tr key={m.id} style={{ background: selectedIdSet.has(m.id) ? "rgba(34,211,238,0.05)" : "transparent" }}>
                    <TD><input type="checkbox" checked={selectedIdSet.has(m.id)} onChange={() => toggleSelect(m.id)} /></TD>
                    <TD style={{ fontWeight: 700 }}>
                      {m.name}
                      {priceChanged && (
                        <span title={`Changed from ${INR(latest.old_price)} → ${INR(latest.new_price)}`}
                          style={{ marginLeft: 8, padding: "2px 8px", borderRadius: 999, fontSize: 10, fontWeight: 800, background: trendUp ? "rgba(248,113,113,0.15)" : "rgba(74,222,128,0.15)", color: trendUp ? "var(--red)" : "var(--green)" }}>
                          {trendUp ? "↑" : "↓"} {INR(Math.abs(latest.new_price - latest.old_price))}
                        </span>
                      )}
                    </TD>
                    <TD>
                      {m.group ? (
                        <span style={{ padding: "2px 8px", borderRadius: 999, background: "rgba(34,211,238,0.12)", color: "var(--accent)", fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap" }}>{m.group}</span>
                      ) : <span style={{ color: "var(--text3)" }}>—</span>}
                    </TD>
                    {(() => {
                      const purchased = purchasedFor(m.id);
                      const transferred = transferredQtyByMaterial[m.id] || 0;
                      const avail = purchased - transferred;
                      const col = avail < 0 ? "var(--red)" : avail === 0 ? "var(--orange)" : "var(--green)";
                      return (
                        <TD right title={`Purchased: ${purchased} · Transferred: ${transferred}`}>
                          <div style={{ fontWeight: 800, color: col }}>{avail}</div>
                          <div style={{ fontSize: 9, color: "var(--text3)" }}>{purchased} in · {transferred} out</div>
                        </TD>
                      );
                    })()}
                    <TD style={{ color: "var(--text3)" }}>{m.unit || "—"}</TD>
                    <TD right style={{ color: "var(--orange)", fontWeight: 700 }}>{m.gst_pct || 0}%</TD>
                    <TD right style={{ color: "var(--text3)" }}>{INR(m.base_price || 0)}</TD>
                    <TD right style={{ color: "var(--accent)", fontWeight: 800 }}>{INR(m.current_price || 0)}</TD>
                    <TD style={{ fontSize: 11, color: "var(--text3)" }}>{m.last_updated ? new Date(m.last_updated).toLocaleDateString() : "—"}</TD>
                    <TD right>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <IconBtn name="edit" title="Edit" variant="secondary" onClick={() => openAddMaterial(m)} />
                        <IconBtn name="del" title="Delete" variant="danger" onClick={() => handleDeleteMaterial(m)} />
                      </div>
                    </TD>
                  </tr>
                );
              })}
              {filteredMaterials.length === 0 && (
                <tr><td colSpan={10} style={{ padding: 40, textAlign: "center", color: "var(--text3)", fontStyle: "italic" }}>No materials yet. Upload a PDF invoice to get started.</td></tr>
              )}
              {vis.length > 0 && (
                <tr style={{ background: "var(--bg3)", borderTop: "2px solid var(--border2)" }}>
                  <TD colSpan={3} style={{ fontWeight: 900, color: "var(--gold)", textTransform: "uppercase", letterSpacing: 1 }}>TOTAL</TD>
                  <TD right>
                    <div style={{ fontWeight: 900, color: "var(--blue)" }}>{Math.max(0, totalPurchased - totalTransferred)}</div>
                    <div style={{ fontSize: 9, color: "var(--text3)" }}>{totalPurchased} in · {totalTransferred} out</div>
                  </TD>
                  <TD colSpan={3}></TD>
                  <TD right style={{ fontWeight: 900, color: "var(--accent)" }}>{INR(totalPurchasedValue)}</TD>
                  <TD colSpan={2}></TD>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
          </>
        );
      })()}

      {tab === "add" && (() => {
        const addFilled = addRows.filter(r => (r.name || "").trim() && Number(r.price_inc_gst) > 0);
        const addInp = { padding: "8px 10px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, outline: "none", width: "100%" };
        return (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, color: "var(--text3)" }}>
                  <strong style={{ color: "var(--text)" }}>{addRows.length}</strong> row{addRows.length === 1 ? "" : "s"} · <strong style={{ color: "var(--accent)" }}>{addFilled.length}</strong> filled · {addRows.length - addFilled.length} empty will be skipped
                </span>
                <button onClick={() => setAddRowsPrompt({ count: addNumRows || 10 })}
                  style={{ padding: "6px 12px", borderRadius: 8, background: "var(--bg4)", color: "var(--accent)", border: "1px solid var(--accent)", cursor: "pointer", fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  Change Row Count
                </button>
                <button onClick={() => setAddRows(prev => [...prev, ...Array.from({ length: 5 }, addBlankRow)])}
                  style={{ padding: "6px 12px", borderRadius: 8, background: "transparent", color: "var(--text3)", border: "1px solid var(--border2)", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
                  +5 rows
                </button>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => confirm({ title: "Clear Grid?", message: "All unsaved rows will be cleared.", confirmText: "Clear", cancelText: "Cancel", type: "warning", onConfirm: () => setAddRows(Array.from({ length: addNumRows || 10 }, addBlankRow)) })}
                  style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", cursor: "pointer", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Clear</button>
                <button onClick={saveAddGrid} disabled={addSaving || addFilled.length === 0}
                  style={{ padding: "10px 18px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", cursor: addSaving || addFilled.length === 0 ? "not-allowed" : "pointer", fontWeight: 800, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, opacity: (addSaving || addFilled.length === 0) ? 0.5 : 1, display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Icon name="save" size={14} /> {addSaving ? "Saving…" : `Save ${addFilled.length} Row${addFilled.length === 1 ? "" : "s"}`}
                </button>
              </div>
            </div>
            <div style={{ padding: "10px 12px", marginBottom: 10, borderRadius: 8, background: "rgba(34,211,238,0.05)", border: "1px dashed rgba(34,211,238,0.25)", fontSize: 12, color: "var(--text3)" }}>
              💡 Every saved row writes to <strong style={{ color: "var(--text)" }}>Material Master</strong>. If the name already exists there, the row appends a <em>purchase log entry</em> (qty + price + date) and increments the lifetime quantity. New names create the master record with their first purchase event. Suggestions from the master appear below the name field — pick one to auto-fill unit / group / GST / price.
            </div>
            <Card style={{ padding: 0, overflowX: "auto" }}>
              <table style={{ width: "100%", minWidth: 900, borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
                <thead>
                  <tr>
                    <TH style={{ width: 40 }}>#</TH>
                    <TH>Material Name *</TH>
                    <TH style={{ width: 90 }}>Unit</TH>
                    <TH style={{ width: 140 }}>Group</TH>
                    <TH right style={{ width: 70 }}>GST %</TH>
                    <TH right style={{ width: 120 }}>Price (incl. GST) *</TH>
                    <TH right style={{ width: 90 }}>Base</TH>
                    <TH right style={{ width: 80 }}>Qty *</TH>
                    <TH style={{ width: 130 }}>Purchase Date *</TH>
                    <TH style={{ width: 90 }}>Status</TH>
                  </tr>
                </thead>
                <tbody>
                  {addRows.map((r, i) => {
                    const suggestions = addFocusedIdx === i ? addRowSuggestions(i) : [];
                    const basePrice = r.price_inc_gst && Number(r.price_inc_gst) > 0 && Number(r.gst_pct) >= 0
                      ? +(Number(r.price_inc_gst) / (1 + Number(r.gst_pct) / 100)).toFixed(2) : 0;
                    const match = r.existingId
                      ? materials.find(m => m.id === r.existingId)
                      : materials.find(m => (m.name || "").toLowerCase() === (r.name || "").trim().toLowerCase());
                    const status = !(r.name || "").trim() ? "empty"
                      : match ? (Math.abs((match.current_price || 0) - Number(r.price_inc_gst || 0)) > 0.01 ? "update" : "same")
                      : "new";
                    const statusColor = status === "new" ? "var(--green)" : status === "update" ? "var(--accent)" : "var(--text3)";
                    return (
                      <tr key={i} style={{ background: addFocusedIdx === i ? "rgba(34,211,238,0.03)" : "transparent" }}>
                        <TD style={{ color: "var(--text3)", fontWeight: 700 }}>{i + 1}</TD>
                        <TD style={{ position: "relative" }}>
                          <input value={r.name} onChange={e => updateAddRow(i, { name: e.target.value, existingId: null })}
                            onFocus={() => setAddFocusedIdx(i)}
                            onBlur={() => setTimeout(() => setAddFocusedIdx(f => f === i ? -1 : f), 150)}
                            placeholder="Search master or type new name…"
                            style={{ ...addInp, fontWeight: 700 }} />
                          {suggestions.length > 0 && (
                            <div style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 2, background: "var(--bg2)", border: "1px solid var(--border2)", borderRadius: 10, boxShadow: "0 12px 30px rgba(0,0,0,0.4)", maxHeight: 220, overflowY: "auto", zIndex: 20 }}>
                              {suggestions.map(m => (
                                <button key={m.id} type="button" onMouseDown={e => e.preventDefault()} onClick={() => pickAddMaterial(i, m)}
                                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", padding: "8px 12px", background: "transparent", border: "none", color: "var(--text)", cursor: "pointer", fontSize: 12, borderBottom: "1px solid var(--border)" }}>
                                  <div style={{ textAlign: "left" }}>
                                    <div style={{ fontWeight: 700 }}>{m.name}</div>
                                    <div style={{ fontSize: 10, color: "var(--text3)" }}>{m.unit || "pcs"} · {m.group || "—"} · GST {m.gst_pct || 0}%</div>
                                  </div>
                                  <div style={{ color: "var(--accent)", fontWeight: 800 }}>{INR(m.current_price || 0)}</div>
                                </button>
                              ))}
                            </div>
                          )}
                        </TD>
                        <TD><input value={r.unit} onChange={e => updateAddRow(i, { unit: e.target.value })} style={addInp} /></TD>
                        <TD>
                          <select value={r.group} onChange={e => updateAddRow(i, { group: e.target.value })} style={addInp}>
                            <option value="">—</option>
                            {["SHAMPOO","HAIR SPA","HAIR COLOUR","WAX","HAIR ITEAM","FACIAL","USE AND THROW","TOOLS","SHAVING ITEAM","OTHERS","MACHIN","M&P"].map(g => <option key={g}>{g}</option>)}
                          </select>
                        </TD>
                        <TD right><input type="number" min="0" step="0.01" value={r.gst_pct} onChange={e => updateAddRow(i, { gst_pct: Number(e.target.value) })} style={{ ...addInp, textAlign: "right" }} /></TD>
                        <TD right><input type="number" min="0" step="0.01" value={r.price_inc_gst} onChange={e => updateAddRow(i, { price_inc_gst: e.target.value })} placeholder="0" style={{ ...addInp, textAlign: "right", fontWeight: 700, color: "var(--accent)" }} /></TD>
                        <TD right style={{ color: "var(--text3)" }}>{basePrice > 0 ? INR(basePrice) : "—"}</TD>
                        <TD right><input type="number" min="0" step="1" value={r.qty} onChange={e => updateAddRow(i, { qty: e.target.value })} style={{ ...addInp, textAlign: "right", fontWeight: 700 }} /></TD>
                        <TD><input type="date" value={r.purchase_date} onChange={e => updateAddRow(i, { purchase_date: e.target.value })} style={addInp} /></TD>
                        <TD>
                          <span style={{ padding: "3px 8px", borderRadius: 999, fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5,
                            background: status === "new" ? "rgba(74,222,128,0.12)" : status === "update" ? "rgba(34,211,238,0.12)" : "rgba(255,255,255,0.05)",
                            color: statusColor }}>
                            {status}
                          </span>
                        </TD>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          </>
        );
      })()}

      {tab === "transfers" && (() => {
        const q = catalogSearch.trim().toLowerCase();
        const visibleRows = catalogRows.filter(r =>
          (!q || (r.name || "").toLowerCase().includes(q)) &&
          (!catalogGroup || materials.find(m => m.id === r.material_id)?.group === catalogGroup)
        );
        const inp = { padding: "6px 8px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, width: "100%", outline: "none" };
        return (
          <>
            {/* Top controls */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <label style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>Date *</label>
                  <input type="date" value={catalogDate} onChange={e => setCatalogDate(e.target.value)}
                    style={{ padding: "8px 12px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, outline: "none" }} />
                </div>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 10, background: "rgba(74,222,128,0.08)", border: "1px solid rgba(74,222,128,0.25)", fontSize: 11, color: "var(--green)" }}>
                  <input type="checkbox" checked={catalogAutoUpdate} onChange={e => setCatalogAutoUpdate(e.target.checked)} />
                  Auto-update each branch's daily entry
                </label>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={resetCatalog} disabled={catalogSaving}
                  style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", cursor: "pointer", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Clear Qtys</button>
                <button onClick={() => setTransferConfirmOpen(true)} disabled={catalogSaving || filledCatalog.length === 0 || !catalogDate}
                  style={{ padding: "10px 18px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", cursor: (catalogSaving || filledCatalog.length === 0 || !catalogDate) ? "not-allowed" : "pointer", fontWeight: 800, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, opacity: (catalogSaving || filledCatalog.length === 0 || !catalogDate) ? 0.5 : 1, display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Icon name="save" size={14} /> {catalogSaving ? "Transferring…" : `Transfer ${filledCatalog.length} Row${filledCatalog.length === 1 ? "" : "s"}`}
                </button>
              </div>
            </div>

            {/* Catalog filters + stats */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
              <input placeholder="Search material name…" value={catalogSearch} onChange={e => setCatalogSearch(e.target.value)}
                style={{ padding: "8px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, flex: "1 1 240px", minWidth: "min(240px, 100%)", outline: "none" }} />
              <select value={catalogGroup} onChange={e => setCatalogGroup(e.target.value)}
                style={{ padding: "8px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, outline: "none" }}>
                <option value="">All Groups</option>
                {["SHAMPOO","HAIR SPA","HAIR COLOUR","WAX","HAIR ITEAM","FACIAL","USE AND THROW","TOOLS","SHAVING ITEAM","OTHERS","MACHIN","M&P"].map(g => <option key={g}>{g}</option>)}
              </select>
              <div style={{ fontSize: 11, color: "var(--text3)" }}>
                Showing <strong style={{ color: "var(--text)" }}>{visibleRows.length}</strong> of {catalogRows.length} rows · <strong style={{ color: "var(--accent)" }}>{filledCatalog.length}</strong> filled · Grand total <strong style={{ color: "var(--green)" }}>{INR(catalogTotal)}</strong>
              </div>
            </div>

            {/* Bulk action bar (appears when rows are selected) */}
            {selectedUids.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 10, background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.3)", marginBottom: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: "var(--accent)" }}>{selectedUids.length} row{selectedUids.length === 1 ? "" : "s"} selected</span>
                <button onClick={() => { selectedUids.forEach(duplicateCatalogRow); setSelectedUids([]); }}
                  style={{ padding: "6px 14px", borderRadius: 8, background: "var(--accent)", color: "#000", border: "none", cursor: "pointer", fontWeight: 800, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  ⎘ Duplicate All
                </button>
                <button onClick={() => { selectedUids.forEach(removeCatalogRow); setSelectedUids([]); }}
                  style={{ padding: "6px 14px", borderRadius: 8, background: "var(--red-bg)", color: "var(--red)", border: "1px solid rgba(248,113,113,0.3)", cursor: "pointer", fontWeight: 800, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  Remove Selected
                </button>
                <select onChange={e => {
                  const bid = e.target.value;
                  if (!bid) return;
                  setCatalogRows(prev => prev.map(r => selectedUidSet.has(r._uid) ? { ...r, branch_id: bid } : r));
                  e.target.value = "";
                }}
                  style={{ padding: "6px 10px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, outline: "none" }}>
                  <option value="">Set branch for selected…</option>
                  {branches.map(b => <option key={b.id} value={b.id}>{b.name.replace("V-CUT ", "")}</option>)}
                </select>
                <button onClick={() => setSelectedUids([])}
                  style={{ padding: "4px 10px", borderRadius: 8, background: "transparent", color: "var(--text3)", border: "1px solid var(--border2)", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
                  Clear
                </button>
              </div>
            )}

            {/* The big catalog grid */}
            <Card style={{ padding: 0, overflowX: "auto", marginBottom: 16 }}>
              <table style={{ width: "100%", minWidth: 1000, borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
                <thead>
                  <tr>
                    <TH style={{ width: 44 }}>
                      <input type="checkbox"
                        checked={visibleRows.length > 0 && visibleRows.every(r => selectedUidSet.has(r._uid))}
                        onChange={e => {
                          if (e.target.checked) setSelectedUids(Array.from(new Set([...selectedUids, ...visibleRows.map(r => r._uid)])));
                          else setSelectedUids(selectedUids.filter(uid => !visibleRows.some(r => r._uid === uid)));
                        }} />
                    </TH>
                    <TH style={{ width: 40 }}>#</TH>
                    <TH>Material</TH>
                    <TH right style={{ width: 110 }} title="Purchased (tracked) − Transferred till date">Available</TH>
                    <TH style={{ width: 70 }}>Unit</TH>
                    <TH right style={{ width: 110 }}>Unit Price</TH>
                    <TH right style={{ width: 90 }}>Qty</TH>
                    <TH style={{ width: 180 }}>Branch *</TH>
                    <TH right style={{ width: 120 }}>Line Total</TH>
                    <TH style={{ width: 200 }}>Actions</TH>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((r, i) => {
                    const lineTotal = (Number(r.qty) || 0) * (Number(r.price_at_transfer) || 0);
                    const filled = r.branch_id && Number(r.qty) > 0;
                    const isSelected = selectedUidSet.has(r._uid);
                    const dupCount = catalogRows.filter(x => x.material_id === r.material_id).length;
                    return (
                      <tr key={r._uid} style={{ background: isSelected ? "rgba(34,211,238,0.08)" : (filled ? "rgba(74,222,128,0.04)" : "transparent") }}>
                        <TD><input type="checkbox" checked={isSelected} onChange={() => toggleSelectUid(r._uid)} /></TD>
                        <TD style={{ color: "var(--text3)", fontWeight: 700 }}>
                          {i + 1}
                          {dupCount > 1 && <span title={`${dupCount} rows for this material`} style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 999, background: "rgba(34,211,238,0.15)", color: "var(--accent)", fontSize: 9, fontWeight: 800 }}>×{dupCount}</span>}
                        </TD>
                        <TD style={{ fontWeight: 700 }}>{r.name}</TD>
                        <TD right>
                          {(() => {
                            const avail = availableFor(r.material_id);
                            const staged = stagedQtyByMaterial[r.material_id] || 0;
                            const postStage = avail - staged;
                            const col = postStage < 0 ? "var(--red)" : postStage === 0 ? "var(--orange)" : "var(--green)";
                            return (
                              <div title={`Purchased: ${purchasedFor(r.material_id)} · Transferred: ${transferredQtyByMaterial[r.material_id] || 0} · Currently staged: ${staged}`}>
                                <div style={{ fontWeight: 800, color: col }}>{postStage}</div>
                                {staged > 0 && <div style={{ fontSize: 9, color: "var(--text3)" }}>of {avail} ({staged} staged)</div>}
                              </div>
                            );
                          })()}
                        </TD>
                        <TD style={{ color: "var(--text3)" }}>{r.unit}</TD>
                        <TD right style={{ color: "var(--text3)" }}>{INR(r.price_at_transfer)}</TD>
                        <TD right>
                          <input type="number" min="0" step="0.01" value={r.qty || ""}
                            onChange={e => updateCatalogRow(r._uid, { qty: Number(e.target.value) || 0 })}
                            placeholder="0" style={{ ...inp, textAlign: "right", fontWeight: 700 }} />
                        </TD>
                        <TD>
                          <select value={r.branch_id} onChange={e => updateCatalogRow(r._uid, { branch_id: e.target.value })}
                            style={{ ...inp, color: r.branch_id ? "var(--text)" : "var(--text3)" }}>
                            <option value="">Select branch…</option>
                            {branches.map(b => <option key={b.id} value={b.id}>{b.name.replace("V-CUT ", "")}</option>)}
                          </select>
                        </TD>
                        <TD right style={{ fontWeight: 800, color: lineTotal > 0 ? "var(--green)" : "var(--text3)" }}>{lineTotal > 0 ? INR(lineTotal) : "—"}</TD>
                        <TD>
                          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                            <button onClick={() => duplicateCatalogRow(r._uid)} title="Create a copy of this row so you can send it to another branch"
                              style={{ padding: "5px 10px", borderRadius: 6, background: "rgba(34,211,238,0.1)", color: "var(--accent)", border: "1px solid var(--accent)", cursor: "pointer", fontSize: 10, fontWeight: 800, display: "inline-flex", alignItems: "center", gap: 4, textTransform: "uppercase", letterSpacing: 0.3 }}>
                              <Icon name="plus" size={11} /> Duplicate
                            </button>
                            {Number(r.qty) > 1 && (
                              <button onClick={() => splitCatalogRow(r._uid)} title="Split this quantity into two rows (half each) to send to different branches"
                                style={{ padding: "5px 10px", borderRadius: 6, background: "rgba(255,215,0,0.1)", color: "var(--gold)", border: "1px solid var(--gold)", cursor: "pointer", fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.3 }}>
                                Split
                              </button>
                            )}
                            {dupCount > 1 && (
                              <button onClick={() => removeCatalogRow(r._uid)} title="Remove this duplicate row"
                                style={{ padding: "5px 10px", borderRadius: 6, background: "var(--red-bg)", color: "var(--red)", border: "1px solid rgba(248,113,113,0.3)", cursor: "pointer", fontSize: 11, fontWeight: 800 }}>×</button>
                            )}
                          </div>
                        </TD>
                      </tr>
                    );
                  })}
                  {visibleRows.length === 0 && (
                    <tr><td colSpan={10} style={{ padding: 40, textAlign: "center", color: "var(--text3)", fontStyle: "italic" }}>
                      {materials.length === 0 ? "No materials yet — add some on the Add Material tab." : "No materials match the filters."}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </Card>

            {/* Per-branch staged summary */}
            {catalogByBranch.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: "var(--gold)", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>Preview — Grouped by Branch</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 12 }}>
                  {catalogByBranch.map(g => {
                    const b = branches.find(x => x.id === g.branch_id);
                    return (
                      <Card key={g.branch_id} style={{ padding: 0 }}>
                        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", background: "var(--bg4)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div style={{ fontWeight: 800, fontSize: 13 }}>{b?.name || "—"}</div>
                          <div style={{ fontSize: 13, color: "var(--green)", fontWeight: 800 }}>{INR(g.total)}</div>
                        </div>
                        <table style={{ width: "100%", fontSize: 11, borderCollapse: "separate", borderSpacing: 0 }}>
                          <thead><tr style={{ background: "var(--bg3)" }}>
                            <TH>Material</TH><TH right>Qty</TH><TH right>Unit Price</TH><TH right>Line</TH>
                          </tr></thead>
                          <tbody>
                            {g.items.map(it => (
                              <tr key={it._uid}>
                                <TD style={{ fontWeight: 600 }}>{it.name}</TD>
                                <TD right>{it.qty} {it.unit}</TD>
                                <TD right style={{ color: "var(--text3)" }}>{INR(it.price_at_transfer)}</TD>
                                <TD right style={{ fontWeight: 800, color: "var(--green)" }}>{INR(it.qty * it.price_at_transfer)}</TD>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </Card>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Sticky bottom bar — Transfer action is always reachable */}
            <div style={{ position: "sticky", bottom: 0, zIndex: 15, background: "var(--bg2)", border: "1px solid var(--border2)", borderRadius: 12, padding: "12px 16px", marginTop: 16, marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", boxShadow: "0 -8px 20px -10px rgba(0,0,0,0.4)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Filled Rows</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: "var(--accent)" }}>{filledCatalog.length}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Branches</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: "var(--gold)" }}>{catalogByBranch.length}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Grand Total</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: "var(--green)" }}>{INR(catalogTotal)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Date</div>
                  <input type="date" value={catalogDate} onChange={e => setCatalogDate(e.target.value)}
                    style={{ padding: "6px 10px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, outline: "none" }} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={resetCatalog} disabled={catalogSaving}
                  style={{ padding: "10px 14px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", cursor: "pointer", fontWeight: 700, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>Clear Qtys</button>
                <button onClick={() => setTransferConfirmOpen(true)} disabled={catalogSaving || filledCatalog.length === 0 || !catalogDate}
                  style={{ padding: "12px 24px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", cursor: (catalogSaving || filledCatalog.length === 0 || !catalogDate) ? "not-allowed" : "pointer", fontWeight: 800, fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5, opacity: (catalogSaving || filledCatalog.length === 0 || !catalogDate) ? 0.5 : 1, display: "inline-flex", alignItems: "center", gap: 6, boxShadow: "0 4px 14px rgba(34,211,238,0.25)" }}>
                  <Icon name="check" size={14} /> {catalogSaving ? "Transferring…" : `Transfer ${filledCatalog.length} Row${filledCatalog.length === 1 ? "" : "s"} Now`}
                </button>
              </div>
            </div>

            {/* Branch-wise history with date-wise material rollup */}
            <div style={{ fontSize: 13, fontWeight: 800, color: "var(--gold)", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>Transferred Materials by Branch</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", gap: 12 }}>
              {branches.map(b => {
                const bAllocs = allocations.filter(a => a.branch_id === b.id);
                const branchTotal = bAllocs.reduce((s, a) => s + (Number(a.total) || 0), 0);
                return (
                  <Card key={b.id} style={{ padding: 0 }}>
                    <div onClick={() => setBranchDetail(branchDetail?.id === b.id ? null : b)}
                      style={{ padding: "10px 14px", borderBottom: branchDetail?.id === b.id ? "1px solid var(--border)" : "none", background: "var(--bg4)", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: 13 }}>{b.name.replace("V-CUT ", "")}</div>
                        <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>{bAllocs.length} transfer{bAllocs.length === 1 ? "" : "s"}</div>
                      </div>
                      <div style={{ fontSize: 14, color: "var(--green)", fontWeight: 800 }}>{INR(branchTotal)}</div>
                    </div>
                    {branchDetail?.id === b.id && (
                      <div style={{ padding: 10 }}>
                        {bAllocs.length === 0 ? (
                          <div style={{ padding: 12, color: "var(--text3)", fontSize: 11, fontStyle: "italic", textAlign: "center" }}>No transfers yet.</div>
                        ) : (
                          <table style={{ width: "100%", fontSize: 11, borderCollapse: "separate", borderSpacing: 0 }}>
                            <thead><tr style={{ background: "var(--bg3)" }}>
                              <TH>Date</TH><TH>Material</TH><TH right>Qty</TH><TH right>Total</TH>
                            </tr></thead>
                            <tbody>
                              {bAllocs.flatMap(a =>
                                (a.items || []).map((it, i) => ({ ...it, date: a.date || (a.transferred_at || "").slice(0, 10), key: `${a.id}-${i}` }))
                              )
                              .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
                              .slice(0, 40)
                              .map(row => (
                                <tr key={row.key}>
                                  <TD style={{ whiteSpace: "nowrap", color: "var(--text3)" }}>{row.date || "—"}</TD>
                                  <TD style={{ fontWeight: 600 }}>{row.name}</TD>
                                  <TD right>{row.qty} {row.unit}</TD>
                                  <TD right style={{ fontWeight: 800, color: "var(--green)" }}>{INR(row.line_total || (row.qty * row.price_at_transfer) || 0)}</TD>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          </>
        );
      })()}

      {/* PDF Review Modal */}
      <Modal isOpen={!!reviewModal} onClose={() => setReviewModal(null)} title={`Review Extracted Materials ${reviewModal?.fileName ? "— " + reviewModal.fileName : ""}`} width={900}>
        {reviewModal && (
          <div>
            <div style={{ fontSize: 12, color: reviewModal.manual ? "var(--orange)" : "var(--text3)", marginBottom: 12 }}>
              {reviewModal.manual
                ? "⚠️ Automatic extraction didn't find any rows — please enter materials manually below. Raw OCR text is shown for reference."
                : <>Review the {reviewModal.items.length} item{reviewModal.items.length === 1 ? "" : "s"} extracted from the {reviewModal.source === "image" ? "image (via OCR — please double-check values)" : reviewModal.source === "excel" ? "template" : "PDF"}. Uncheck any row you don't want to import. Edit values as needed. Existing materials will have their price updated and a history entry logged automatically.</>
              }
            </div>

            {/* KPI strip — total qty and total value of the selected rows */}
            {(() => {
              const included = reviewModal.items.filter(i => i.include && i.name?.trim() && i.price_inc_gst > 0);
              const totalQty = included.reduce((s, i) => s + (Number(i.qty) || 0), 0);
              const totalValue = included.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price_inc_gst) || 0), 0);
              const totalLineAmount = included.reduce((s, i) => s + (Number(i.amount) || 0), 0);
              const newCount = included.filter(i => !i.existing).length;
              const priceChangeCount = included.filter(i => i.existing && Math.abs((i.existing.old_price || 0) - (i.price_inc_gst || 0)) > 0.01).length;
              return (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 8, marginBottom: 12 }}>
                  {[
                    ["To Import", included.length, "var(--accent)"],
                    ["Total Quantity", totalQty, "var(--blue)"],
                    ["Total Value", INR(totalValue || totalLineAmount), "var(--green)"],
                    ["New Materials", newCount, "var(--green)"],
                    ["Price Changes", priceChangeCount, "var(--orange)"],
                  ].map(([l, v, c]) => (
                    <div key={l} style={{ padding: 10, borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--border)" }}>
                      <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
                      <div style={{ fontSize: 16, fontWeight: 800, color: c, marginTop: 2 }}>{v}</div>
                    </div>
                  ))}
                </div>
              );
            })()}
            {reviewModal.rawLines && reviewModal.rawLines.length > 0 && (
              <details style={{ marginBottom: 12 }}>
                <summary style={{ cursor: "pointer", fontSize: 11, color: "var(--accent)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
                  View Raw OCR Text ({reviewModal.rawLines.length} lines)
                </summary>
                <pre style={{ margin: "8px 0 0", padding: 10, background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 11, color: "var(--text2)", maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap", fontFamily: "monospace" }}>
                  {reviewModal.rawLines.map(l => l.replace(/\|/g, " ")).join("\n")}
                </pre>
              </details>
            )}
            <div style={{ maxHeight: 440, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 10 }}>
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
                <thead style={{ position: "sticky", top: 0, background: "var(--bg4)", zIndex: 1 }}>
                  <tr>
                    <TH style={{ width: 30 }}></TH>
                    <TH>Name</TH>
                    <TH right>Qty</TH>
                    <TH>Unit</TH>
                    <TH right>GST %</TH>
                    <TH right>Price (incl. GST)</TH>
                    <TH right>Kind</TH>
                  </tr>
                </thead>
                <tbody>
                  {reviewModal.items.map((it, idx) => {
                    const update = (patch) => setReviewModal(m => ({ ...m, items: m.items.map((x, i) => i === idx ? { ...x, ...patch, base_price: patch.price_inc_gst != null || patch.gst_pct != null ? +((patch.price_inc_gst ?? x.price_inc_gst) / (1 + (patch.gst_pct ?? x.gst_pct) / 100)).toFixed(2) : x.base_price } : x) }));
                    const priceChanged = it.existing && Math.abs((it.existing.old_price || 0) - (it.price_inc_gst || 0)) > 0.01;
                    const kind = !it.existing ? "NEW" : priceChanged ? (it.price_inc_gst > it.existing.old_price ? "PRICE UP" : "PRICE DOWN") : "UNCHANGED";
                    const kindColor = kind === "NEW" ? "green" : kind === "UNCHANGED" ? "gray" : kind === "PRICE UP" ? "red" : "blue";
                    const inp = { padding: "4px 8px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, width: "100%", outline: "none" };
                    return (
                      <tr key={idx}>
                        <TD><input type="checkbox" checked={it.include} onChange={e => update({ include: e.target.checked })} /></TD>
                        <TD><input value={it.name} onChange={e => update({ name: e.target.value })} style={{ ...inp, fontWeight: 700 }} /></TD>
                        <TD right><input type="number" min="0" step="0.01" value={it.qty} onChange={e => update({ qty: Number(e.target.value) })} style={{ ...inp, maxWidth: 70, textAlign: "right" }} /></TD>
                        <TD><input value={it.unit} onChange={e => update({ unit: e.target.value })} style={{ ...inp, maxWidth: 70 }} /></TD>
                        <TD right><input type="number" min="0" step="0.01" value={it.gst_pct} onChange={e => update({ gst_pct: Number(e.target.value) })} style={{ ...inp, maxWidth: 70, textAlign: "right" }} /></TD>
                        <TD right>
                          <input type="number" min="0" step="0.01" value={it.price_inc_gst} onChange={e => update({ price_inc_gst: Number(e.target.value) })} style={{ ...inp, maxWidth: 100, textAlign: "right", fontWeight: 700, color: "var(--accent)" }} />
                          {it.existing && priceChanged && <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>Was {INR(it.existing.old_price)}</div>}
                        </TD>
                        <TD right><Pill label={kind} color={kindColor} /></TD>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginTop: 16 }}>
              <button onClick={() => setReviewModal(m => ({ ...m, items: [...m.items, { name: "", qty: 1, unit: "pcs", price_inc_gst: 0, gst_pct: 18, base_price: 0, hsn: "", existing: null, include: true }] }))}
                style={{ padding: "8px 14px", borderRadius: 10, background: "var(--bg4)", color: "var(--accent)", border: "1px dashed var(--accent)", fontWeight: 700, fontSize: 11, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
                <Icon name="plus" size={12} /> Add Row
              </button>
              <div style={{ display: "flex", gap: 10 }}>
              <button onClick={() => setReviewModal(null)} style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Cancel</button>
              <button onClick={commitReview} disabled={!reviewModal.items.some(i => i.include && i.name?.trim() && i.price_inc_gst > 0)} style={{ padding: "10px 20px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>
                Import {reviewModal.items.filter(i => i.include && i.name?.trim() && i.price_inc_gst > 0).length} Item(s)
              </button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* Transfer Modal */}
      <Modal isOpen={!!transferModal} onClose={() => setTransferModal(null)} title="Transfer Materials to Branch" width={780}>
        {transferModal && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, marginBottom: 14 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Destination Branch</label>
                <select value={transferModal.branch_id} onChange={e => setTransferModal(t => ({ ...t, branch_id: e.target.value }))}
                  style={{ padding: "10px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, outline: "none" }}>
                  <option value="">Select branch...</option>
                  {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Transfer Date</label>
                <input type="date" value={transferModal.date || ""} onChange={e => setTransferModal(t => ({ ...t, date: e.target.value }))}
                  style={{ padding: "10px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, outline: "none" }} />
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 10, background: "rgba(74,222,128,0.08)", border: "1px solid rgba(74,222,128,0.25)", marginBottom: 12, fontSize: 11, color: "var(--green)" }}>
              <input type="checkbox" checked={!!transferModal.auto_entry_update} onChange={e => setTransferModal(t => ({ ...t, auto_entry_update: e.target.checked }))} />
              <span>Auto-update the branch's daily entry on this date with material expense (<strong>₹{transferModal.items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price_at_transfer) || 0), 0).toFixed(2)}</strong>)</span>
            </div>
            <div style={{ maxHeight: 340, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 12 }}>
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
                <thead style={{ position: "sticky", top: 0, background: "var(--bg4)", zIndex: 1 }}>
                  <tr><TH>Material</TH><TH right>Qty</TH><TH>Unit</TH><TH right>Unit Price</TH><TH right>Line Total</TH></tr>
                </thead>
                <tbody>
                  {transferModal.items.map((it, idx) => {
                    const update = (patch) => setTransferModal(t => ({ ...t, items: t.items.map((x, i) => i === idx ? { ...x, ...patch } : x) }));
                    const lineTotal = (Number(it.qty) || 0) * (Number(it.price_at_transfer) || 0);
                    const inp = { padding: "4px 8px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, width: "100%", outline: "none" };
                    const searchQ = (it.name || "").trim().toLowerCase();
                    const addedIds = new Set(transferModal.items.map(x => x.material_id).filter(Boolean));
                    const suggestions = !it.material_id && searchQ.length >= 2
                      ? materials.filter(m => (m.name || "").toLowerCase().includes(searchQ) && !addedIds.has(m.id)).slice(0, 6)
                      : [];
                    const removeRow = () => setTransferModal(t => ({ ...t, items: t.items.filter((_, i) => i !== idx) }));
                    return (
                      <tr key={idx}>
                        <TD style={{ position: "relative" }}>
                          {it.material_id ? (
                            <span style={{ fontWeight: 700 }}>{it.name}</span>
                          ) : (
                            <>
                              <input value={it.name || ""} onChange={e => update({ name: e.target.value, material_id: null })}
                                placeholder="Search material master…" style={{ ...inp, fontWeight: 700 }} />
                              {suggestions.length > 0 && (
                                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 2, background: "var(--bg2)", border: "1px solid var(--border2)", borderRadius: 10, boxShadow: "0 12px 30px rgba(0,0,0,0.4)", maxHeight: 220, overflowY: "auto", zIndex: 30 }}>
                                  {suggestions.map(m => (
                                    <button key={m.id} type="button" onMouseDown={e => e.preventDefault()}
                                      onClick={() => update({ material_id: m.id, name: m.name, unit: m.unit || "pcs", price_at_transfer: m.current_price || 0 })}
                                      style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", padding: "8px 10px", background: "transparent", border: "none", color: "var(--text)", cursor: "pointer", fontSize: 12, borderBottom: "1px solid var(--border)" }}>
                                      <div style={{ textAlign: "left" }}>
                                        <div style={{ fontWeight: 700 }}>{m.name}</div>
                                        <div style={{ fontSize: 10, color: "var(--text3)" }}>{m.unit || "pcs"} · {m.group || "—"}</div>
                                      </div>
                                      <div style={{ color: "var(--accent)", fontWeight: 800 }}>{INR(m.current_price || 0)}</div>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </>
                          )}
                        </TD>
                        <TD right><input type="number" min="0" step="0.01" value={it.qty} onChange={e => update({ qty: Number(e.target.value) })} style={{ ...inp, maxWidth: 80, textAlign: "right" }} /></TD>
                        <TD>
                          {it.material_id ? it.unit : <input value={it.unit || "pcs"} onChange={e => update({ unit: e.target.value })} style={{ ...inp, maxWidth: 80 }} />}
                        </TD>
                        <TD right>
                          {it.material_id
                            ? <span style={{ color: "var(--text3)" }}>{INR(it.price_at_transfer)}</span>
                            : <input type="number" min="0" step="0.01" value={it.price_at_transfer || 0} onChange={e => update({ price_at_transfer: Number(e.target.value) })} style={{ ...inp, maxWidth: 100, textAlign: "right", fontWeight: 700, color: "var(--accent)" }} />}
                        </TD>
                        <TD right style={{ fontWeight: 800, color: "var(--green)" }}>
                          {INR(lineTotal)}
                          {transferModal.items.length > 1 && (
                            <button onClick={removeRow} title="Remove row"
                              style={{ marginLeft: 8, padding: "2px 6px", borderRadius: 4, background: "var(--red-bg)", color: "var(--red)", border: "1px solid rgba(248,113,113,0.3)", cursor: "pointer", fontSize: 11, fontWeight: 800 }}>×</button>
                          )}
                        </TD>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {/* Add from Master: search + pick */}
            {/* Add more empty rows by user-supplied count */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 10, borderRadius: 10, background: "var(--bg3)", border: "1px dashed var(--border2)", marginBottom: 12, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Add empty rows</span>
              {[1, 5, 10].map(n => (
                <button key={n} onClick={() => setTransferModal(t => ({ ...t, items: [...t.items, ...Array.from({ length: n }, () => ({ material_id: null, name: "", unit: "pcs", qty: 1, price_at_transfer: 0 }))] }))}
                  style={{ padding: "5px 12px", borderRadius: 6, background: "var(--bg4)", color: "var(--accent)", border: "1px solid var(--border2)", cursor: "pointer", fontSize: 11, fontWeight: 800 }}>
                  +{n}
                </button>
              ))}
              <input type="number" min="1" max="200" placeholder="N"
                id="transfer-add-n"
                style={{ width: 70, padding: "5px 10px", borderRadius: 6, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 11, textAlign: "center", outline: "none" }}
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    const n = Math.max(1, Math.min(200, Number(e.target.value) || 1));
                    setTransferModal(t => ({ ...t, items: [...t.items, ...Array.from({ length: n }, () => ({ material_id: null, name: "", unit: "pcs", qty: 1, price_at_transfer: 0 }))] }));
                    e.target.value = "";
                  }
                }} />
              <button onClick={() => {
                const el = document.getElementById("transfer-add-n");
                const n = Math.max(1, Math.min(200, Number(el?.value) || 1));
                setTransferModal(t => ({ ...t, items: [...t.items, ...Array.from({ length: n }, () => ({ material_id: null, name: "", unit: "pcs", qty: 1, price_at_transfer: 0 }))] }));
                if (el) el.value = "";
              }}
                style={{ padding: "5px 12px", borderRadius: 6, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 800, textTransform: "uppercase" }}>
                Add
              </button>
              <span style={{ fontSize: 11, color: "var(--text3)", marginLeft: "auto" }}>
                {transferModal.items.filter(i => i.material_id).length} / {transferModal.items.length} filled
              </span>
            </div>

            <div style={{ marginBottom: 12, position: "relative" }}>
              <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 6 }}>Add from Material Master</label>
              <input value={pickerSearch} onChange={e => setPickerSearch(e.target.value)} placeholder="Search material name…"
                style={{ padding: "10px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, outline: "none", width: "100%" }} />
              {pickerSearch.trim().length >= 2 && (() => {
                const q = pickerSearch.trim().toLowerCase();
                const addedIds = new Set(transferModal.items.map(i => i.material_id));
                const options = materials
                  .filter(m => (m.name || "").toLowerCase().includes(q) && !addedIds.has(m.id))
                  .slice(0, 8);
                if (options.length === 0) return <div style={{ marginTop: 6, padding: "8px 12px", background: "var(--bg3)", border: "1px dashed var(--border2)", borderRadius: 8, fontSize: 11, color: "var(--text3)" }}>No matches. Tip: click <strong>+ Add Material</strong> in the master list first.</div>;
                return (
                  <div style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, background: "var(--bg2)", border: "1px solid var(--border2)", borderRadius: 10, boxShadow: "0 12px 30px rgba(0,0,0,0.4)", maxHeight: 260, overflowY: "auto", zIndex: 20 }}>
                    {options.map(m => (
                      <button key={m.id} type="button"
                        onClick={() => {
                          setTransferModal(t => ({ ...t, items: [...t.items, { material_id: m.id, name: m.name, unit: m.unit || "pcs", qty: 1, price_at_transfer: m.current_price || 0 }] }));
                          setPickerSearch("");
                        }}
                        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", padding: "10px 12px", background: "transparent", border: "none", color: "var(--text)", cursor: "pointer", fontSize: 12, borderBottom: "1px solid var(--border)" }}>
                        <div style={{ textAlign: "left" }}>
                          <div style={{ fontWeight: 700 }}>{m.name}</div>
                          <div style={{ fontSize: 10, color: "var(--text3)" }}>{m.unit || "pcs"} · {m.group || "—"} · GST {m.gst_pct || 0}%</div>
                        </div>
                        <div style={{ color: "var(--accent)", fontWeight: 800 }}>{INR(m.current_price || 0)}</div>
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
              <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Note (optional)</label>
              <input value={transferModal.note} onChange={e => setTransferModal(t => ({ ...t, note: e.target.value }))}
                style={{ padding: "10px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, outline: "none" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 13, color: "var(--text3)" }}>
                Total: <strong style={{ color: "var(--accent)", fontSize: 16 }}>{INR(transferModal.items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price_at_transfer) || 0), 0))}</strong>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={() => setTransferModal(null)} style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Cancel</button>
                <button onClick={commitTransfer} disabled={!transferModal.branch_id} style={{ padding: "10px 20px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: transferModal.branch_id ? "pointer" : "not-allowed", opacity: transferModal.branch_id ? 1 : 0.5 }}>
                  Confirm Transfer
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* Add / Edit Material Modal */}
      <Modal isOpen={!!addMaterialModal} onClose={() => setAddMaterialModal(null)} title={addMaterialModal?.editingId ? "Record Purchase" : "Add Material / Record Purchase"} width={560}>
        {addMaterialModal && (() => {
          const f = addMaterialModal;
          const setF = (patch) => setAddMaterialModal(prev => ({ ...prev, ...patch }));
          const ip = { padding: "10px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, outline: "none", width: "100%" };
          const lbl = { fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 };

          // Live master suggestions when typing a name
          const q = (f.name || "").trim().toLowerCase();
          const suggestions = !f.editingId && q.length >= 2
            ? materials.filter(m => (m.name || "").toLowerCase().includes(q)).slice(0, 6)
            : [];
          const exactMatch = materials.find(m => (m.name || "").toLowerCase() === q);

          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, position: "relative" }}>
                <label style={lbl}>Material Name <span style={{ color: "var(--red)" }}>*</span></label>
                <input value={f.name} onChange={e => setF({ name: e.target.value })} placeholder="Start typing to search the master…" style={ip} autoFocus />
                {suggestions.length > 0 && !exactMatch && (
                  <div style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, background: "var(--bg2)", border: "1px solid var(--border2)", borderRadius: 10, boxShadow: "0 12px 30px rgba(0,0,0,0.4)", maxHeight: 220, overflowY: "auto", zIndex: 10 }}>
                    {suggestions.map(s => (
                      <button key={s.id} type="button" onClick={() => openAddMaterial(s)}
                        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", padding: "10px 12px", background: "transparent", border: "none", color: "var(--text)", cursor: "pointer", fontSize: 12, borderBottom: "1px solid var(--border)" }}>
                        <div style={{ textAlign: "left" }}>
                          <div style={{ fontWeight: 700 }}>{s.name}</div>
                          <div style={{ fontSize: 10, color: "var(--text3)" }}>{s.unit || "pcs"} · {s.group || "—"}</div>
                        </div>
                        <div style={{ color: "var(--accent)", fontWeight: 800 }}>{INR(s.current_price || 0)}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {exactMatch && !f.editingId && (
                <div style={{ padding: "8px 12px", borderRadius: 10, background: "rgba(34,211,238,0.08)", border: "1px solid rgba(34,211,238,0.3)", fontSize: 11, color: "var(--accent)" }}>
                  📚 <strong>{exactMatch.name}</strong> already in master — saving will append this purchase to its log (current price {INR(exactMatch.current_price || 0)}).
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={lbl}>Unit</label>
                  <input value={f.unit} onChange={e => setF({ unit: e.target.value })} placeholder="pcs" style={ip} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={lbl}>Group</label>
                  <select value={f.group} onChange={e => setF({ group: e.target.value })} style={ip}>
                    <option value="">Select group...</option>
                    {MATERIAL_GROUPS.map(g => <option key={g}>{g}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={lbl}>GST %</label>
                  <input type="number" min="0" step="0.01" value={f.gst_pct} onChange={e => setF({ gst_pct: Number(e.target.value) })} style={ip} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={lbl}>Price (incl. GST) <span style={{ color: "var(--red)" }}>*</span></label>
                  <input type="number" min="0" step="0.01" value={f.price_inc_gst} onChange={e => setF({ price_inc_gst: Number(e.target.value) })} style={{ ...ip, fontWeight: 700, color: "var(--accent)" }} />
                </div>
              </div>
              {f.price_inc_gst > 0 && f.gst_pct >= 0 && (
                <div style={{ fontSize: 11, color: "var(--text3)" }}>
                  Base price (ex-GST): <strong style={{ color: "var(--text)" }}>{INR(+(f.price_inc_gst / (1 + (f.gst_pct || 0) / 100)).toFixed(2))}</strong>
                </div>
              )}
              <div style={{ height: 1, background: "var(--border)", margin: "6px 0" }} />
              <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Purchase Log Entry</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={lbl}>Qty Purchased <span style={{ color: "var(--red)" }}>*</span></label>
                  <input type="number" min="0" step="1" value={f.qty} onChange={e => setF({ qty: e.target.value })} style={{ ...ip, fontWeight: 700 }} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <label style={lbl}>Purchase Date <span style={{ color: "var(--red)" }}>*</span></label>
                  <input type="date" value={f.purchase_date} onChange={e => setF({ purchase_date: e.target.value })} style={ip} />
                </div>
              </div>
              <div style={{ fontSize: 11, color: "var(--text3)", fontStyle: "italic" }}>
                {f.editingId || exactMatch
                  ? "Saving appends a purchase event (qty + price + date) to this material's log."
                  : "Saving creates the material and records the first purchase event in its log."}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 6 }}>
                <button onClick={() => setAddMaterialModal(null)} style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Cancel</button>
                <button onClick={saveMaterialForm}
                  style={{ padding: "10px 20px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Icon name="save" size={13} /> {f.editingId || exactMatch ? "Log Purchase" : "Add & Log First Purchase"}
                </button>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* Price History Modal */}
      <Modal isOpen={!!historyModal} onClose={() => setHistoryModal(null)} title={`Price History — ${historyModal?.name || ""}`} width={640}>
        {historyModal && (() => {
          const hist = priceHistory.filter(h => h.material_id === historyModal.id);
          return (
            <div>
              <div style={{ padding: 12, borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border)", marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Current Price</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: "var(--accent)" }}>{INR(historyModal.current_price || 0)}</div>
                </div>
                <div style={{ fontSize: 11, color: "var(--text3)" }}>
                  GST: <strong>{historyModal.gst_pct || 0}%</strong> · Unit: <strong>{historyModal.unit || "—"}</strong>
                </div>
              </div>
              {hist.length === 0 ? (
                <div style={{ padding: 20, textAlign: "center", color: "var(--text3)", fontStyle: "italic" }}>No history entries yet.</div>
              ) : (
                <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                  <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
                    <thead style={{ background: "var(--bg4)" }}>
                      <tr><TH>Effective From</TH><TH right>Old</TH><TH right>New</TH><TH right>Δ</TH><TH>Source</TH><TH>By</TH></tr>
                    </thead>
                    <tbody>
                      {hist.map(h => {
                        const diff = (h.new_price || 0) - (h.old_price || 0);
                        return (
                          <tr key={h.id}>
                            <TD>{h.effective_from}</TD>
                            <TD right style={{ color: "var(--text3)" }}>{INR(h.old_price || 0)}</TD>
                            <TD right style={{ color: "var(--accent)", fontWeight: 700 }}>{INR(h.new_price || 0)}</TD>
                            <TD right style={{ color: diff > 0 ? "var(--red)" : diff < 0 ? "var(--green)" : "var(--text3)", fontWeight: 700 }}>{diff > 0 ? "↑" : diff < 0 ? "↓" : ""} {INR(Math.abs(diff))}</TD>
                            <TD style={{ fontSize: 10, color: "var(--text3)", textTransform: "uppercase" }}>{h.source || "—"}</TD>
                            <TD style={{ fontSize: 10, color: "var(--text3)" }}>{h.changed_by || "—"}</TD>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })()}
      </Modal>

      {/* Row-Count Prompt — opens transferModal with N empty rows */}
      <Modal isOpen={!!rowCountPrompt} onClose={() => setRowCountPrompt(null)} title="Create New Transfer List" width={440}>
        {rowCountPrompt && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 13, color: "var(--text2)" }}>
              How many material rows do you want to start with? You can add more later.
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[5, 10, 20, 50].map(n => (
                <button key={n} onClick={() => setRowCountPrompt({ count: n })}
                  style={{ padding: "8px 14px", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 800, fontSize: 12,
                    background: rowCountPrompt.count === n ? "linear-gradient(135deg,var(--accent),var(--gold2))" : "var(--bg4)",
                    color: rowCountPrompt.count === n ? "#000" : "var(--text3)" }}>
                  {n} rows
                </button>
              ))}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Or enter a custom count</label>
              <input type="number" min="1" max="200" value={rowCountPrompt.count}
                onChange={e => setRowCountPrompt({ count: Number(e.target.value) || 1 })}
                style={{ padding: "10px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 14, outline: "none", fontWeight: 700 }} autoFocus />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button onClick={() => setRowCountPrompt(null)}
                style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Cancel</button>
              <button onClick={() => {
                const n = Math.max(1, Math.min(200, Number(rowCountPrompt.count) || 1));
                setTransferModal({
                  branch_id: "",
                  date: new Date().toISOString().slice(0, 10),
                  items: Array.from({ length: n }, () => ({ material_id: null, name: "", unit: "pcs", qty: 1, price_at_transfer: 0 })),
                  note: "",
                  auto_entry_update: true,
                });
                setRowCountPrompt(null);
              }}
                style={{ padding: "10px 20px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>
                Create {rowCountPrompt.count} Row{rowCountPrompt.count === 1 ? "" : "s"}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Transfer Date Confirmation */}
      <Modal isOpen={transferConfirmOpen} onClose={() => !catalogSaving && setTransferConfirmOpen(false)} title="Confirm Transfer Date" width={560}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 13, color: "var(--text2)" }}>
            Please confirm the date for this transfer. The material expense will be logged to each branch's daily entry on this date.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Transfer Date *</label>
            <input type="date" value={catalogDate} onChange={e => setCatalogDate(e.target.value)}
              style={{ padding: "12px 16px", borderRadius: 10, background: "var(--bg3)", border: "2px solid var(--accent)", color: "var(--text)", fontSize: 15, outline: "none", fontWeight: 700 }} autoFocus />
            <div style={{ fontSize: 10, color: "var(--text3)" }}>Defaults to today. Change it to log against any past or future date.</div>
          </div>

          {/* Summary grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
            {[
              ["Items", filledCatalog.length, "var(--accent)"],
              ["Branches", catalogByBranch.length, "var(--gold)"],
              ["Grand Total", INR(catalogTotal), "var(--green)"],
            ].map(([l, v, c]) => (
              <div key={l} style={{ padding: 10, borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border)" }}>
                <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: c, marginTop: 2 }}>{v}</div>
              </div>
            ))}
          </div>

          {/* Per-branch breakdown */}
          <div style={{ border: "1px solid var(--border)", borderRadius: 10, maxHeight: 200, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
              <thead style={{ background: "var(--bg4)" }}>
                <tr><TH>Branch</TH><TH right>Items</TH><TH right>Subtotal</TH></tr>
              </thead>
              <tbody>
                {catalogByBranch.map(g => {
                  const b = branches.find(x => x.id === g.branch_id);
                  return (
                    <tr key={g.branch_id}>
                      <TD style={{ fontWeight: 700 }}>{b?.name?.replace("V-CUT ", "") || "—"}</TD>
                      <TD right style={{ color: "var(--text3)" }}>{g.items.length}</TD>
                      <TD right style={{ color: "var(--green)", fontWeight: 800 }}>{INR(g.total)}</TD>
                    </tr>
                  );
                })}
                {catalogByBranch.length === 0 && (
                  <tr><td colSpan={3} style={{ padding: 20, textAlign: "center", color: "var(--text3)", fontStyle: "italic" }}>No branches filled.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 10, background: "rgba(74,222,128,0.08)", border: "1px solid rgba(74,222,128,0.25)", fontSize: 11, color: "var(--green)" }}>
            <input type="checkbox" checked={catalogAutoUpdate} onChange={e => setCatalogAutoUpdate(e.target.checked)} />
            <span>Also add the transfer total to each branch's daily entry on <strong>{catalogDate || "—"}</strong></span>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button onClick={() => setTransferConfirmOpen(false)} disabled={catalogSaving}
              style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: catalogSaving ? "wait" : "pointer" }}>
              Cancel
            </button>
            <button onClick={commitCatalogTransfer} disabled={catalogSaving || filledCatalog.length === 0 || !catalogDate}
              style={{ padding: "12px 22px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", cursor: (catalogSaving || filledCatalog.length === 0 || !catalogDate) ? "not-allowed" : "pointer", fontWeight: 800, fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5, opacity: (catalogSaving || filledCatalog.length === 0 || !catalogDate) ? 0.5 : 1, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Icon name="check" size={14} /> {catalogSaving ? "Transferring…" : `Confirm & Transfer ${filledCatalog.length} Row${filledCatalog.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      </Modal>

      {/* Add-Material Row-Count Popup */}
      <Modal isOpen={!!addRowsPrompt} onClose={() => { if (addRows.length === 0) setTab("list"); setAddRowsPrompt(null); }} title="How Many Rows?" width={440}>
        {addRowsPrompt && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 13, color: "var(--text2)" }}>
              Enter how many material rows you want to add. Empty rows are automatically skipped when saving.
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[5, 10, 20, 50, 100].map(n => (
                <button key={n} onClick={() => setAddRowsPrompt({ count: n })}
                  style={{ padding: "8px 14px", borderRadius: 8, border: "none", cursor: "pointer", fontWeight: 800, fontSize: 12,
                    background: addRowsPrompt.count === n ? "linear-gradient(135deg,var(--accent),var(--gold2))" : "var(--bg4)",
                    color: addRowsPrompt.count === n ? "#000" : "var(--text3)" }}>
                  {n} rows
                </button>
              ))}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Or enter any value (1–999)</label>
              <input type="number" min="1" max="999" value={addRowsPrompt.count}
                onChange={e => setAddRowsPrompt({ count: Number(e.target.value) || 1 })}
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    const n = Math.max(1, Math.min(999, Number(addRowsPrompt.count) || 1));
                    setAddNumRows(n);
                    setAddRows(Array.from({ length: n }, addBlankRow));
                    setAddRowsPrompt(null);
                  }
                }}
                autoFocus
                style={{ padding: "10px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 14, outline: "none", fontWeight: 700 }} />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button onClick={() => { if (addRows.length === 0) setTab("list"); setAddRowsPrompt(null); }}
                style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Cancel</button>
              <button onClick={() => {
                const n = Math.max(1, Math.min(999, Number(addRowsPrompt.count) || 1));
                setAddNumRows(n);
                setAddRows(Array.from({ length: n }, addBlankRow));
                setAddRowsPrompt(null);
              }}
                style={{ padding: "10px 20px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>
                Create {addRowsPrompt.count} Row{addRowsPrompt.count === 1 ? "" : "s"}
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
