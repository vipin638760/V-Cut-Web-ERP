"use client";
import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, orderBy, doc, writeBatch, addDoc, getDocs, where, updateDoc, increment, deleteDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR } from "@/lib/calculations";
import { Icon, IconBtn, Card, Pill, TH, TD, Modal, useConfirm, useToast } from "@/components/ui";
import VLoader from "@/components/VLoader";

// ExcelJS is ~200KB — load only when Template/Upload/Export is actually used.
let _excelJSPromise = null;
const loadExcelJS = () => {
  if (!_excelJSPromise) _excelJSPromise = import("exceljs").then(m => m.default || m);
  return _excelJSPromise;
};

// ── PDF text extraction ──
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

// ── Image pre-processing for OCR ──
const preprocessImage = async (file) => {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
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

const MATERIAL_GROUPS = [
  "SHAMPOO", "HAIR SPA", "HAIR COLOUR", "WAX", "HAIR ITEAM", "FACIAL",
  "USE AND THROW", "TOOLS", "SHAVING ITEAM", "OTHERS", "MACHIN", "M&P",
];

const blankRow = () => ({
  name: "", unit: "pcs", group: "", gst_pct: 18, price_inc_gst: "",
  existingId: null, showSuggest: false,
});

export default function MaterialMasterPage() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [materials, setMaterials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [numRows, setNumRows] = useState(10);
  const [rows, setRows] = useState(() => Array.from({ length: 10 }, blankRow));
  const [saving, setSaving] = useState(false);
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const [tab, setTab] = useState("list"); // "list" | "add" | "transfers"
  const [listSearch, setListSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [sort, setSort] = useState({ key: "name", dir: "asc" });
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [qtyMin, setQtyMin] = useState("");
  const [qtyMax, setQtyMax] = useState("");
  const [showAnalytics, setShowAnalytics] = useState(true);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [deleting, setDeleting] = useState(false);
  const [historyModal, setHistoryModal] = useState(null);
  const [mergePreview, setMergePreview] = useState(null); // { groups: [{ name, keeper, losers: [], totalQty }] }
  const [merging, setMerging] = useState(false);

  // Transfers + new-list builder
  const [branches, setBranches] = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [priceHistory, setPriceHistory] = useState([]);
  const [rowCountPrompt, setRowCountPrompt] = useState(null); // { count }
  const [newList, setNewList] = useState(null); // { branch_id, date, note, auto_entry_update, rows:[{search, material_id, name, unit, qty, price_at_transfer}] }
  const [addMoreInput, setAddMoreInput] = useState("");
  const [committingTransfer, setCommittingTransfer] = useState(false);
  const [pickerFocus, setPickerFocus] = useState(-1);

  const currentUser = useCurrentUser() || {};
  const [ioBusy, setIoBusy] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [uploadPreview, setUploadPreview] = useState(null); // { items: [{ name, unit, group, gst_pct, price_inc_gst, qty, existing }] }

  // ── Download Excel Template ─────────────────────────────────────────
  const downloadMasterTemplate = async () => {
    setIoBusy(true);
    try {
      const ExcelJS = await loadExcelJS();
      const wb = new ExcelJS.Workbook();
      wb.creator = "V-Cut";
      wb.created = new Date();
      const ws = wb.addWorksheet("Materials", { views: [{ state: "frozen", ySplit: 1 }] });
      const headers = ["Name", "Group", "Unit", "GST %", "Price (incl. GST)", "Qty"];
      const headerFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFB4D7A8" } };
      const headerFont = { bold: true, color: { argb: "FF1F2937" }, size: 12 };
      const thin = { style: "thin", color: { argb: "FF94A3B8" } };
      const border = { top: thin, left: thin, bottom: thin, right: thin };
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
      ws.columns = [{ width: 36 }, { width: 18 }, { width: 12 }, { width: 10 }, { width: 16 }, { width: 10 }];
      for (let r = 2; r <= 501; r++) {
        const rr = ws.getRow(r);
        rr.getCell(1).border = border;
        rr.getCell(2).border = border;
        rr.getCell(2).dataValidation = {
          type: "list", allowBlank: true,
          formulae: ['"' + MATERIAL_GROUPS.join(",") + '"'],
          showErrorMessage: true, errorStyle: "warning",
          errorTitle: "Unknown group", error: "Pick from the dropdown.",
        };
        rr.getCell(3).border = border;
        rr.getCell(4).border = border; rr.getCell(4).numFmt = "0.00";
        rr.getCell(5).border = border; rr.getCell(5).numFmt = "#,##0.00"; rr.getCell(5).alignment = { horizontal: "right" };
        rr.getCell(6).border = border; rr.getCell(6).numFmt = "0"; rr.getCell(6).alignment = { horizontal: "right" };
      }
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const fileName = `V-Cut_Material_Master_Template_${new Date().toISOString().slice(0, 10)}.xlsx`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast({ title: "Template Downloaded", message: `${fileName} — fill it and upload it back.`, type: "success" });
    } catch (err) {
      toast({ title: "Template Error", message: err.message, type: "error" });
    } finally {
      setIoBusy(false);
    }
  };

  // ── Export current master to Excel ──────────────────────────────────
  const exportMaster = async () => {
    setIoBusy(true);
    try {
      const ExcelJS = await loadExcelJS();
      const wb = new ExcelJS.Workbook();
      wb.creator = "V-Cut";
      wb.created = new Date();
      const ws = wb.addWorksheet("Material Master", { views: [{ state: "frozen", ySplit: 1 }] });
      const headers = ["Name", "Group", "Unit", "GST %", "Base Price", "Price (incl. GST)", "Total Purchased", "Last Updated"];
      const headerFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0891B2" } };
      const headerFont = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      const thin = { style: "thin", color: { argb: "FFCBD5E1" } };
      const border = { top: thin, left: thin, bottom: thin, right: thin };
      const hr = ws.getRow(1);
      headers.forEach((h, i) => {
        const c = hr.getCell(i + 1);
        c.value = h;
        c.font = headerFont;
        c.fill = headerFill;
        c.alignment = { vertical: "middle", horizontal: "center" };
        c.border = border;
      });
      hr.height = 24;
      const sorted = [...materials].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      sorted.forEach((m, idx) => {
        const r = ws.getRow(2 + idx);
        const vals = [m.name || "", m.group || "", m.unit || "pcs", Number(m.gst_pct) || 0, Number(m.base_price) || 0, Number(m.current_price) || 0, Number(m.total_purchased) || 0, m.last_updated ? new Date(m.last_updated).toISOString().slice(0, 10) : ""];
        vals.forEach((v, i) => {
          const c = r.getCell(i + 1);
          c.value = v;
          c.border = border;
          if (i >= 3 && typeof v === "number") {
            c.alignment = { horizontal: "right" };
            c.numFmt = i === 3 ? "0.00" : (i === 6 ? "0" : "#,##0.00");
          }
        });
      });
      ws.columns = [{ width: 36 }, { width: 18 }, { width: 10 }, { width: 10 }, { width: 14 }, { width: 16 }, { width: 14 }, { width: 14 }];
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const fileName = `V-Cut_Material_Master_${new Date().toISOString().slice(0, 10)}.xlsx`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast({ title: "Exported", message: `${fileName} (${materials.length} materials) downloaded.`, type: "success" });
    } catch (err) {
      toast({ title: "Export Error", message: err.message, type: "error" });
    } finally {
      setIoBusy(false);
    }
  };

  // ── Upload filled Excel / PDF / Image → preview modal ───────────────
  const handleUploadMaster = async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    if (!file) return;
    const isExcel = /\.(xlsx|xls)$/i.test(file.name) ||
      file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.type === "application/vnd.ms-excel";
    if (!isExcel) { parseMasterInvoice(file); return; }
    setIoBusy(true);
    try {
      const ExcelJS = await loadExcelJS();
      const buffer = await file.arrayBuffer();
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer);
      if (wb.worksheets.length === 0) throw new Error("Empty workbook.");

      const detectHeader = (ws) => {
        for (let rowNum = 1; rowNum <= Math.min(5, ws.rowCount); rowNum++) {
          const headerRow = ws.getRow(rowNum);
          const cols = {};
          headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
            const v = String(cell.value || "").trim().toLowerCase();
            if (!v) return;
            if (/^name|material|desc/.test(v)) cols.name = col;
            else if (/group/.test(v)) cols.group = col;
            else if (/unit/.test(v)) cols.unit = col;
            else if (/gst/.test(v)) cols.gst = col;
            else if (/price.*incl|price \(incl/.test(v) || v === "price") cols.price = col;
            else if (/rate/.test(v)) cols.rate = col;
            else if (/^qt|qnt|qty|quantity/.test(v)) cols.qty = col;
          });
          if (cols.name && (cols.price || cols.rate)) return { cols, headerRowNum: rowNum };
        }
        return null;
      };

      const matched = [];
      const skipped = [];
      wb.worksheets.forEach(ws => {
        const det = detectHeader(ws);
        if (det) matched.push({ ws, ...det });
        else skipped.push(ws.name);
      });
      if (matched.length === 0) throw new Error("No sheet with a matching header (need at least Name + Price/Rate).");

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
      matched.forEach(({ ws, cols, headerRowNum }) => {
        for (let r = headerRowNum + 1; r <= ws.rowCount; r++) {
          const row = ws.getRow(r);
          const name = String(readCell(row, cols.name) || "").trim();
          if (!name || name.length < 2) continue;
          const priceInc = Number(readCell(row, cols.price) || readCell(row, cols.rate)) || 0;
          if (priceInc <= 0) continue;
          const qty = Number(readCell(row, cols.qty)) || 0;
          const gstPct = Number(readCell(row, cols.gst)) || 18;
          const unit = String(readCell(row, cols.unit) || "pcs").trim();
          const group = String(readCell(row, cols.group) || "").trim();
          const basePrice = +(priceInc / (1 + gstPct / 100)).toFixed(2);
          const existing = materials.find(m => (m.name || "").toLowerCase() === name.toLowerCase()) || null;
          items.push({
            name, unit, group, gst_pct: gstPct,
            price_inc_gst: priceInc, base_price: basePrice, qty,
            existing: existing ? { id: existing.id, old_price: existing.current_price || 0 } : null,
            include: true,
          });
        }
      });

      if (items.length === 0) {
        toast({ title: "Empty Upload", message: "No data rows detected.", type: "warning" });
        return;
      }
      setUploadPreview({ fileName: file.name, items, skippedSheets: skipped });
    } catch (err) {
      confirm({ title: "Upload Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    } finally {
      setIoBusy(false);
    }
  };

  const commitMasterUpload = async () => {
    if (!uploadPreview) return;
    const included = uploadPreview.items.filter(i => i.include && i.name?.trim() && i.price_inc_gst > 0);
    if (included.length === 0) { confirm({ title: "Nothing to Save", message: "No rows selected.", confirmText: "OK", type: "warning", onConfirm: () => {} }); return; }
    setIoBusy(true);
    try {
      const batch = writeBatch(db);
      const nowISO = new Date().toISOString();
      const today = nowISO.slice(0, 10);
      let created = 0, updated = 0, priceChanges = 0;
      for (const it of included) {
        const name = it.name.trim();
        const priceInc = Number(it.price_inc_gst) || 0;
        const gstPct = Number(it.gst_pct) || 0;
        const basePrice = +(priceInc / (1 + gstPct / 100)).toFixed(2);
        const payload = {
          name, unit: it.unit || "pcs", gst_pct: gstPct,
          current_price: priceInc, base_price: basePrice,
          last_updated: nowISO,
          last_updated_by: currentUser?.id || currentUser?.name || "admin",
          ...(it.group ? { group: it.group } : {}),
        };
        const rowQty = Number(it.qty) || 0;
        if (it.existing) {
          const priceChanged = Math.abs((it.existing.old_price || 0) - priceInc) > 0.01;
          batch.set(doc(db, "materials", it.existing.id), payload, { merge: true });
          if (rowQty > 0) batch.update(doc(db, "materials", it.existing.id), { total_purchased: increment(rowQty) });
          if (priceChanged) {
            batch.set(doc(collection(db, "material_price_history")), {
              material_id: it.existing.id, material_name: name,
              old_price: it.existing.old_price || 0, new_price: priceInc,
              gst_pct: gstPct, effective_from: today,
              source: "master-upload", qty: rowQty, event: "price_change",
              changed_by: currentUser?.id || currentUser?.name || "admin",
              changed_at: nowISO,
            });
            priceChanges++;
          } else if (rowQty > 0) {
            batch.set(doc(collection(db, "material_price_history")), {
              material_id: it.existing.id, material_name: name,
              old_price: it.existing.old_price || 0, new_price: priceInc,
              gst_pct: gstPct, effective_from: today,
              source: "master-upload", qty: rowQty, event: "purchase",
              changed_by: currentUser?.id || currentUser?.name || "admin",
              changed_at: nowISO,
            });
          }
          updated++;
        } else {
          const mRef = doc(collection(db, "materials"));
          batch.set(mRef, { ...payload, total_purchased: rowQty });
          batch.set(doc(collection(db, "material_price_history")), {
            material_id: mRef.id, material_name: name,
            old_price: 0, new_price: priceInc,
            gst_pct: gstPct, effective_from: today,
            source: "master-upload", qty: rowQty,
            changed_by: currentUser?.id || currentUser?.name || "admin",
            changed_at: nowISO,
          });
          created++;
        }
      }
      await batch.commit();
      toast({ title: "Uploaded", message: `${created} added, ${updated} updated${priceChanges ? ` (${priceChanges} price change${priceChanges > 1 ? "s" : ""})` : ""}.`, type: "success" });
      setUploadPreview(null);
    } catch (err) {
      confirm({ title: "Save Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    } finally {
      setIoBusy(false);
    }
  };

  // ── OCR text extraction from image ──
  const linesFromImage = async (file) => {
    const Tesseract = (await import("tesseract.js")).default;
    setOcrProgress(0);
    const preprocessed = await preprocessImage(file);
    const { data } = await Tesseract.recognize(preprocessed, "eng", {
      logger: m => { if (m.status === "recognizing text") setOcrProgress(Math.round((m.progress || 0) * 100)); },
      tessedit_pageseg_mode: 6,
      preserve_interword_spaces: "1",
    });
    setOcrProgress(100);
    const words = data?.words || [];
    if (words.length > 0) {
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
        let out = sortedByX[0].text;
        for (let i = 1; i < sortedByX.length; i++) {
          const gap = sortedByX[i].bbox.x0 - sortedByX[i - 1].bbox.x1;
          out += (gap > 18 ? " | " : " ") + sortedByX[i].text;
        }
        return out.trim();
      }).filter(Boolean);
      if (lines.length > 0) return lines;
    }
    return (data.text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  };

  // ── Parse PDF/Image invoice → master upload preview ──
  const parseMasterInvoice = async (file) => {
    setParsing(true);
    try {
      const isPDF = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      const lines = isPDF ? await linesFromPDF(file) : await linesFromImage(file);

      const toNum = (s) => Number(String(s).replace(/[,\s₹]/g, ""));
      const HSN_RX = /^\d{4,8}$/;

      // Build per-HSN GST map from tax summary
      const hsnGstMap = {};
      lines.forEach(raw => {
        const parts = raw.replace(/\|/g, " ").split(/\s+/).map(x => x.trim()).filter(Boolean);
        if (parts.length < 4) return;
        if (!HSN_RX.test(parts[0])) return;
        const pctMatch = parts.find(p => /^\d+(?:\.\d+)?\s*%$/.test(p));
        if (pctMatch) hsnGstMap[parts[0]] = toNum(pctMatch.replace("%", "")) * 2;
      });

      // Detect overall GST from CGST/SGST totals
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
          [5, 12, 18, 28].forEach(s => { if (Math.abs(overallGstPct - s) < 1.5) overallGstPct = s; });
        }
      }

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
      const itemLines = lines.slice(startIdx + 1, endIdx);

      const UNIT = "(?:p[ce]s?|n[eo]s?|units?|kgs?|ltrs?|ml|box|pkt|pack|pair|set|btls?|bottles?)";
      const rowRx = [
        new RegExp(`^\\s*(\\d+)\\s+(.+?)\\s+(\\d{4,10})\\s+(\\d+(?:\\.\\d+)?)\\s+(${UNIT})\\s+([\\d,]+(?:\\.\\d+)?)\\s+([\\d,]+(?:\\.\\d+)?)\\s+(?:${UNIT})?\\s*([\\d,]+(?:\\.\\d+)?)\\s*$`, "i"),
        new RegExp(`^\\s*(\\d+)\\s+(.+?)\\s+(\\d{4,10})\\s+(\\d+(?:\\.\\d+)?)\\s+(${UNIT})\\s+([\\d,]+(?:\\.\\d+)?)\\s+(?:${UNIT})?\\s*([\\d,]+(?:\\.\\d+)?)\\s*$`, "i"),
        new RegExp(`^\\s*(\\d+)\\s+(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s+(${UNIT})\\s+([\\d,]+(?:\\.\\d+)?)\\s+([\\d,]+(?:\\.\\d+)?)\\s+(?:${UNIT})?\\s*([\\d,]+(?:\\.\\d+)?)\\s*$`, "i"),
        new RegExp(`^\\s*(\\d+)\\s+(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s+(${UNIT})\\s+([\\d,]+(?:\\.\\d+)?)\\s+(?:${UNIT})?\\s*([\\d,]+(?:\\.\\d+)?)\\s*$`, "i"),
      ];

      const items = [];
      const scanLines = (linesArr) => {
        linesArr.forEach(raw => {
          const flat = raw.replace(/\|/g, " ").replace(/\s+/g, " ").trim();
          if (flat.length < 8) return;
          if (isHeaderLine(flat) || isEndLine(flat)) return;
          if (/^(sl\s*no|s\.?\s*no|#|description|hsn|sac|qty|quantity|rate|per|amount)\b/i.test(flat)) return;

          let parsed = null;
          for (const rx of rowRx) {
            const m = flat.match(rx);
            if (!m) continue;
            if (m.length === 9) {
              parsed = { name: m[2].trim(), hsn: m[3], qty: Number(m[4]), unit: m[5].toLowerCase(), rate_incl: toNum(m[6]), rate_excl: toNum(m[7]), amount: toNum(m[8]) };
            } else if (m.length === 8) {
              parsed = { name: m[2].trim(), hsn: m[3], qty: Number(m[4]), unit: m[5].toLowerCase(), rate_excl: toNum(m[6]), amount: toNum(m[7]) };
            }
            if (parsed) break;
          }

          if (!parsed) {
            if (/^(sl|s\.?\s*no|#|description|hsn|sac|rate|qty|quantity|per|amount|total|the\s+beauty|lucky\s+store|tax\s+invoice|company|bank|state|gstin|buyer|dispatch|consignee|signatory)\b/i.test(flat)) return;
            let looseM = flat.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s+(pcs?|nos?|units?|kgs?|ltrs?|ml|box|pkt|pack|pair|set|btls?|bottles?)\s+.*?([\d,]+(?:\.\d+)?)\s*$/i);
            if (looseM) {
              const hsnInLine = flat.match(/\b(\d{4,8})\b/);
              parsed = { name: looseM[1].replace(/^\d+\.?\s+/, "").trim(), hsn: hsnInLine ? hsnInLine[1] : "", qty: Number(looseM[2]) || 1, unit: looseM[3].toLowerCase(), amount: toNum(looseM[4]) };
            } else {
              const nums = flat.match(/(\d+(?:,\d+)*(?:\.\d+)?)/g);
              if (!nums || nums.length < 2) return;
              const lastPrice = toNum(nums[nums.length - 1]);
              const qtyGuess = Number(nums[0]) || 1;
              if (!(lastPrice > 0) || lastPrice < 5) return;
              const firstNumIdx = flat.search(/\d/);
              const namePart = flat.slice(0, firstNumIdx).replace(/^\d+\.?\s+/, "").trim();
              if (namePart.length < 3) return;
              parsed = { name: namePart, hsn: (flat.match(/\b(\d{4,8})\b/) || [])[1] || "", qty: qtyGuess > 0 && qtyGuess < 1000 ? qtyGuess : 1, unit: "pcs", amount: lastPrice };
            }
            if (!parsed || !parsed.name || parsed.name.length < 2) return;
            if (!(parsed.amount > 0)) return;
          }

          if (!parsed.name || parsed.name.length < 2) return;
          if (!(parsed.amount > 0)) return;

          let gstPct = hsnGstMap[parsed.hsn];
          if (gstPct == null) gstPct = overallGstPct;
          if (gstPct == null) gstPct = 18;

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
            qty: parsed.qty, unit: parsed.unit,
            price_inc_gst: priceInc, gst_pct: gstPct, base_price: basePrice,
            group: "", // PDF/Image can't reliably detect group
          });
        });
      };

      scanLines(itemLines);
      if (items.length === 0) scanLines(lines);

      // Dedup by name
      const byName = new Map();
      items.forEach(i => byName.set(i.name.toLowerCase(), i));
      const unique = Array.from(byName.values());

      const enriched = unique.map(i => {
        const existing = materials.find(m => m.name?.toLowerCase() === i.name.toLowerCase()) || null;
        return {
          ...i,
          existing: existing ? { id: existing.id, old_price: existing.current_price || 0 } : null,
          include: true,
        };
      });

      if (enriched.length === 0) {
        setUploadPreview({
          fileName: file.name, rawLines: lines.slice(0, 120), manual: true,
          items: [{ name: "", unit: "pcs", group: "", gst_pct: 18, price_inc_gst: 0, base_price: 0, qty: 1, existing: null, include: true }],
        });
        toast({ title: "Auto-detect failed", message: "Add rows manually — raw text from the invoice is shown for reference.", type: "warning" });
        return;
      }

      setUploadPreview({ fileName: file.name, items: enriched, rawLines: lines.slice(0, 120) });
    } catch (err) {
      console.error("Invoice parse error:", err);
      confirm({ title: "Parse Error", message: err.message || "Failed to read invoice.", confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    } finally {
      setParsing(false);
      setOcrProgress(0);
    }
  };

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "materials"), sn => {
        setMaterials(sn.docs.map(d => ({ ...d.data(), id: d.id })));
        setLoading(false);
      }),
      onSnapshot(collection(db, "branches"), sn => setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(query(collection(db, "material_allocations"), orderBy("transferred_at", "desc")), sn =>
        setAllocations(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
      onSnapshot(query(collection(db, "material_price_history"), orderBy("changed_at", "desc")), sn =>
        setPriceHistory(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  // Current-month filter for the transfer tab
  const currentMonthPrefix = new Date().toISOString().slice(0, 7);
  const thisMonthAllocations = useMemo(() => allocations.filter(a => {
    const d = (a.date || a.transferred_at || "").slice(0, 7);
    return d === currentMonthPrefix;
  }), [allocations, currentMonthPrefix]);

  // Transferred qty by material id — built once, used by sort, columns, and analytics
  const transferredByMaterial = useMemo(() => {
    const m = {};
    allocations.forEach(a => {
      const id = a.material_id;
      if (!id) return;
      m[id] = (m[id] || 0) + (Number(a.qty) || 0);
    });
    return m;
  }, [allocations]);

  // ── Duplicate scan: group materials by case-insensitive trimmed name ──
  const scanDuplicates = () => {
    const groups = new Map();
    materials.forEach(m => {
      const k = (m.name || "").trim().toLowerCase();
      if (!k) return;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    });
    const dupGroups = [];
    groups.forEach((arr, k) => {
      if (arr.length < 2) return;
      const sorted = arr.slice().sort((a, b) => {
        const ap = Number(a.total_purchased) || 0;
        const bp = Number(b.total_purchased) || 0;
        if (ap !== bp) return bp - ap;
        const at = Date.parse(a.last_updated || "") || 0;
        const bt = Date.parse(b.last_updated || "") || 0;
        if (at !== bt) return at - bt;
        return (a.id || "").localeCompare(b.id || "");
      });
      const keeper = sorted[0];
      const losers = sorted.slice(1);
      const totalQty = arr.reduce((s, x) => s + (Number(x.total_purchased) || 0), 0);
      const totalAlloc = arr.reduce((s, x) => s + (transferredByMaterial[x.id] || 0), 0);
      const mergedGroup = keeper.group || arr.map(x => x.group).find(Boolean) || "";
      dupGroups.push({ name: keeper.name, key: k, keeper, losers, totalQty, totalAlloc, mergedGroup });
    });
    if (dupGroups.length === 0) {
      toast({ title: "No Duplicates", message: "Every material name in the master is already unique.", type: "info" });
      return;
    }
    dupGroups.sort((a, b) => a.name.localeCompare(b.name));
    setMergePreview({ groups: dupGroups });
  };

  const commitMerge = async () => {
    if (!mergePreview) return;
    setMerging(true);
    try {
      const batch = writeBatch(db);
      let mergedGroups = 0, removedDocs = 0, movedHistory = 0, movedAllocs = 0;
      for (const g of mergePreview.groups) {
        const keeperRef = doc(db, "materials", g.keeper.id);
        batch.set(keeperRef, {
          total_purchased: g.totalQty,
          ...(g.mergedGroup && !g.keeper.group ? { group: g.mergedGroup } : {}),
          last_updated: new Date().toISOString(),
          last_updated_by: currentUser?.id || currentUser?.name || "admin",
          archived: false,
        }, { merge: true });
        for (const loser of g.losers) {
          priceHistory.filter(h => h.material_id === loser.id).forEach(h => {
            batch.update(doc(db, "material_price_history", h.id), { material_id: g.keeper.id, material_name: g.keeper.name });
            movedHistory++;
          });
          allocations.filter(a => a.material_id === loser.id).forEach(a => {
            batch.update(doc(db, "material_allocations", a.id), { material_id: g.keeper.id, material_name: g.keeper.name });
            movedAllocs++;
          });
          batch.delete(doc(db, "materials", loser.id));
          removedDocs++;
        }
        batch.set(doc(collection(db, "material_price_history")), {
          material_id: g.keeper.id, material_name: g.keeper.name,
          old_price: Number(g.keeper.current_price) || 0,
          new_price: Number(g.keeper.current_price) || 0,
          gst_pct: Number(g.keeper.gst_pct) || 0,
          qty: 0,
          effective_from: new Date().toISOString().slice(0, 10),
          event: "merge",
          source: `merge:${g.losers.length}-duplicate${g.losers.length > 1 ? "s" : ""}`,
          changed_by: currentUser?.id || currentUser?.name || "admin",
          changed_at: new Date().toISOString(),
          note: `Merged ${g.losers.length} duplicate${g.losers.length > 1 ? "s" : ""} into this record. Total purchased now ${g.totalQty}.`,
        });
        mergedGroups++;
      }
      await batch.commit();
      toast({
        title: "Merged",
        message: `${mergedGroups} duplicate group${mergedGroups > 1 ? "s" : ""} consolidated · ${removedDocs} extra record${removedDocs > 1 ? "s" : ""} removed · ${movedHistory} history + ${movedAllocs} transfer entries reassigned.`,
        type: "success",
      });
      setMergePreview(null);
    } catch (err) {
      toast({ title: "Merge failed", message: err.message, type: "error" });
    } finally {
      setMerging(false);
    }
  };

  const newBlankTransferRow = () => ({
    search: "", material_id: null, name: "", unit: "pcs", qty: 1, price_at_transfer: 0, gst_pct: 18,
  });

  const startNewList = () => setRowCountPrompt({ count: 10 });

  const confirmRowCount = () => {
    const n = Math.max(1, Math.min(200, Number(rowCountPrompt?.count) || 1));
    const today = new Date().toISOString().slice(0, 10);
    setNewList({
      branch_id: "", date: today, note: "", auto_entry_update: true,
      rows: Array.from({ length: n }, newBlankTransferRow),
    });
    setRowCountPrompt(null);
    setAddMoreInput("");
  };

  const updateTransferRow = (i, patch) => {
    setNewList(prev => prev ? { ...prev, rows: prev.rows.map((r, idx) => idx === i ? { ...r, ...patch } : r) } : prev);
  };

  const pickTransferMaterial = (i, m) => {
    updateTransferRow(i, {
      search: m.name,
      material_id: m.id,
      name: m.name,
      unit: m.unit || "pcs",
      gst_pct: m.gst_pct || 18,
      price_at_transfer: m.current_price || 0,
    });
  };

  const addRowsToList = (n) => {
    const count = Math.max(1, Math.min(200, Number(n) || 1));
    setNewList(prev => prev ? { ...prev, rows: [...prev.rows, ...Array.from({ length: count }, newBlankTransferRow)] } : prev);
    setAddMoreInput("");
  };

  const removeTransferRow = (i) => {
    setNewList(prev => prev ? { ...prev, rows: prev.rows.filter((_, idx) => idx !== i) } : prev);
  };

  const filledTransferRows = newList ? newList.rows.filter(r => r.material_id && Number(r.qty) > 0 && Number(r.price_at_transfer) >= 0) : [];
  const transferTotal = filledTransferRows.reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.price_at_transfer) || 0), 0);

  const commitNewList = async () => {
    if (!newList.branch_id) { confirm({ title: "Branch Required", message: "Please select a destination branch.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} }); return; }
    if (!newList.date) { confirm({ title: "Date Required", message: "Please select a transfer date.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} }); return; }
    if (filledTransferRows.length === 0) { confirm({ title: "Nothing to Transfer", message: "Please pick at least one material from the master.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} }); return; }
    setCommittingTransfer(true);
    try {
      const branch = branches.find(b => b.id === newList.branch_id);
      const nowISO = new Date().toISOString();
      const items = filledTransferRows.map(r => ({
        material_id: r.material_id,
        name: r.name,
        qty: Number(r.qty) || 0,
        unit: r.unit || "pcs",
        price_at_transfer: Number(r.price_at_transfer) || 0,
        line_total: (Number(r.qty) || 0) * (Number(r.price_at_transfer) || 0),
      }));
      await addDoc(collection(db, "material_allocations"), {
        branch_id: newList.branch_id,
        branch_name: branch?.name || "",
        date: newList.date,
        items,
        total: transferTotal,
        note: newList.note || "",
        transferred_by: currentUser?.id || currentUser?.name || "admin",
        transferred_at: nowISO,
      });

      // Auto-update the daily entry's mat_expense
      if (newList.auto_entry_update && transferTotal > 0) {
        const entriesQ = query(
          collection(db, "entries"),
          where("branch_id", "==", newList.branch_id),
          where("date", "==", newList.date),
        );
        const snap = await getDocs(entriesQ);
        if (!snap.empty) {
          const existing = snap.docs[0];
          const data = existing.data();
          const newMat = (Number(data.mat_expense) || 0) + transferTotal;
          const activity = Array.isArray(data.activity_log) ? [...data.activity_log] : [];
          activity.push({
            action: "Material Transfer",
            user: currentUser?.name || currentUser?.id || "admin",
            time: nowISO,
            note: `Added ₹${transferTotal.toFixed(2)} material expense from ${items.length} item(s)`,
          });
          await updateDoc(existing.ref, { mat_expense: newMat, activity_log: activity, updated_at: nowISO });
        } else {
          await addDoc(collection(db, "entries"), {
            branch_id: newList.branch_id,
            date: newList.date,
            online: 0, cash: 0,
            mat_expense: transferTotal,
            others: 0, petrol: 0,
            staff_billing: [],
            total_gst: 0,
            activity_log: [{
              action: "Create",
              user: currentUser?.name || currentUser?.id || "admin",
              time: nowISO,
              note: `Stub created via material transfer (₹${transferTotal.toFixed(2)})`,
            }],
            created_at: nowISO,
          });
        }
      }

      toast({ title: "Transferred", message: `${items.length} material(s) sent to ${branch?.name}. Entry for ${newList.date} updated with ₹${transferTotal.toFixed(0)}.`, type: "success" });
      setNewList(null);
      setTab("transfers");
    } catch (err) {
      confirm({ title: "Transfer Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    } finally {
      setCommittingTransfer(false);
    }
  };

  // Resize the grid when user changes numRows
  const applyNumRows = (n) => {
    const clamped = Math.max(1, Math.min(200, Number(n) || 1));
    setNumRows(clamped);
    setRows(prev => {
      if (prev.length === clamped) return prev;
      if (prev.length > clamped) return prev.slice(0, clamped);
      return [...prev, ...Array.from({ length: clamped - prev.length }, blankRow)];
    });
  };

  const updateRow = (i, patch) => setRows(prev => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r));

  const pickMaterial = (i, m) => {
    updateRow(i, {
      name: m.name,
      unit: m.unit || "pcs",
      group: m.group || "",
      gst_pct: m.gst_pct ?? 18,
      price_inc_gst: m.current_price || "",
      existingId: m.id,
      showSuggest: false,
    });
  };

  const suggestionsFor = (i) => {
    const q = (rows[i]?.name || "").trim().toLowerCase();
    if (q.length < 2) return [];
    return materials.filter(m => (m.name || "").toLowerCase().includes(q)).slice(0, 6);
  };

  const filledRows = useMemo(
    () => rows.filter(r => (r.name || "").trim() && Number(r.price_inc_gst) > 0),
    [rows]
  );

  const handleSave = async () => {
    if (filledRows.length === 0) {
      confirm({ title: "Nothing to Save", message: "Please fill at least one row with a name and price.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} });
      return;
    }
    // Dedup check across filled rows
    const seen = new Map();
    for (const r of filledRows) {
      const k = r.name.trim().toLowerCase();
      if (seen.has(k)) {
        confirm({ title: "Duplicate Name", message: `"${r.name}" appears more than once in the grid. Remove duplicates before saving.`, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
        return;
      }
      seen.set(k, true);
    }

    setSaving(true);
    try {
      const batch = writeBatch(db);
      const nowISO = new Date().toISOString();
      const today = nowISO.slice(0, 10);
      let created = 0, updated = 0, priceChanges = 0;

      for (const r of filledRows) {
        const name = r.name.trim();
        const priceInc = Number(r.price_inc_gst) || 0;
        const gstPct = Number(r.gst_pct) || 0;
        const basePrice = +(priceInc / (1 + gstPct / 100)).toFixed(2);
        const payload = {
          name,
          unit: r.unit || "pcs",
          gst_pct: gstPct,
          current_price: priceInc,
          base_price: basePrice,
          last_updated: nowISO,
          last_updated_by: currentUser?.id || currentUser?.name || "admin",
          ...(r.group ? { group: r.group } : {}),
        };
        const matchingExisting = r.existingId
          ? materials.find(m => m.id === r.existingId)
          : materials.find(m => (m.name || "").toLowerCase() === name.toLowerCase());

        if (matchingExisting) {
          const priceChanged = Math.abs((matchingExisting.current_price || 0) - priceInc) > 0.01;
          batch.set(doc(db, "materials", matchingExisting.id), payload, { merge: true });
          if (priceChanged) {
            batch.set(doc(collection(db, "material_price_history")), {
              material_id: matchingExisting.id,
              material_name: name,
              old_price: matchingExisting.current_price || 0,
              new_price: priceInc,
              gst_pct: gstPct,
              effective_from: today,
              source: "material-master-grid",
              changed_by: currentUser?.id || currentUser?.name || "admin",
              changed_at: nowISO,
            });
            priceChanges++;
          }
          updated++;
        } else {
          const mRef = doc(collection(db, "materials"));
          batch.set(mRef, payload);
          batch.set(doc(collection(db, "material_price_history")), {
            material_id: mRef.id,
            material_name: name,
            old_price: 0,
            new_price: priceInc,
            gst_pct: gstPct,
            effective_from: today,
            source: "material-master-grid",
            changed_by: currentUser?.id || currentUser?.name || "admin",
            changed_at: nowISO,
          });
          created++;
        }
      }

      await batch.commit();

      const skippedEmpty = rows.length - filledRows.length;
      toast({
        title: "Saved",
        message: `${created} added, ${updated} updated${priceChanges ? ` (${priceChanges} price changes)` : ""}${skippedEmpty ? `, ${skippedEmpty} empty row${skippedEmpty > 1 ? "s" : ""} skipped` : ""}.`,
        type: "success",
      });
      // Clear the grid but keep the row count
      setRows(Array.from({ length: numRows }, blankRow));
    } catch (err) {
      confirm({ title: "Save Error", message: err.message || "Unknown error", confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    } finally {
      setSaving(false);
    }
  };

  const clearGrid = () => {
    confirm({
      title: "Clear Grid?",
      message: "All unsaved rows will be cleared.",
      confirmText: "Clear", cancelText: "Cancel", type: "warning",
      onConfirm: () => setRows(Array.from({ length: numRows }, blankRow)),
    });
  };

  if (loading) return <VLoader fullscreen label="Loading Material Master" />;

  const inp = { padding: "8px 10px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, outline: "none", width: "100%" };

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 900, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 2, marginBottom: 4 }}>Inventory</div>
          <div style={{ fontSize: 26, fontWeight: 900, color: "var(--text)", letterSpacing: -0.5 }}>Material Master</div>
          <div style={{ fontSize: 12, color: "var(--text3)", fontWeight: 500, marginTop: 4 }}>{materials.length} material{materials.length === 1 ? "" : "s"} in master · {filledRows.length} filled / {rows.length} rows in grid</div>
        </div>

        {/* Export / Upload / Template */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button onClick={downloadMasterTemplate} disabled={ioBusy} title="Download a blank Excel template"
            style={{ padding: "10px 14px", borderRadius: 10, background: "var(--bg3)", color: "var(--orange)", border: "1px solid rgba(72,72,71,0.15)", cursor: ioBusy ? "wait" : "pointer", fontWeight: 800, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6, opacity: ioBusy ? 0.6 : 1 }}>
            <Icon name="save" size={12} /> Template
          </button>
          <label title="Upload Excel, PDF, or Image to bulk add/update materials"
            style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 18px", borderRadius: 12, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", fontWeight: 800, fontSize: 12, cursor: (ioBusy || parsing) ? "wait" : "pointer", textTransform: "uppercase", letterSpacing: 0.5, opacity: (ioBusy || parsing) ? 0.6 : 1 }}>
            <Icon name="plus" size={14} /> {parsing ? (ocrProgress > 0 && ocrProgress < 100 ? `Scanning Image ${ocrProgress}%` : "Reading File...") : "Upload (Excel / PDF / Image)"}
            <input type="file" accept=".xlsx,.xls,application/pdf,image/*" onChange={handleUploadMaster} disabled={ioBusy || parsing} style={{ display: "none" }} />
          </label>
          <button onClick={exportMaster} disabled={ioBusy || materials.length === 0} title="Export the full master catalog to Excel"
            style={{ padding: "10px 14px", borderRadius: 10, background: "var(--bg3)", color: "var(--green)", border: "1px solid rgba(72,72,71,0.15)", cursor: (ioBusy || materials.length === 0) ? "not-allowed" : "pointer", fontWeight: 800, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6, opacity: (ioBusy || materials.length === 0) ? 0.6 : 1 }}>
            <Icon name="save" size={12} /> Export
          </button>
        </div>
        {tab === "add" && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase" }}>Rows</span>
              {[5, 10, 20, 50, 100].map(n => (
                <button key={n} onClick={() => applyNumRows(n)}
                  style={{ padding: "6px 12px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 800,
                    background: numRows === n ? "linear-gradient(135deg,var(--accent),var(--gold2))" : "var(--bg4)",
                    color: numRows === n ? "#000" : "var(--text3)" }}>
                  {n}
                </button>
              ))}
              <input type="number" min="1" max="200" value={numRows} onChange={e => applyNumRows(e.target.value)}
                style={{ width: 70, padding: "6px 10px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, textAlign: "center", outline: "none" }} />
            </div>
            <button onClick={clearGrid} style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", cursor: "pointer", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Clear</button>
            <button onClick={handleSave} disabled={saving || filledRows.length === 0}
              style={{ padding: "10px 18px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", cursor: saving || filledRows.length === 0 ? "not-allowed" : "pointer", fontWeight: 800, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, opacity: (saving || filledRows.length === 0) ? 0.5 : 1, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Icon name="save" size={14} /> {saving ? "Saving..." : `Save ${filledRows.length} Row${filledRows.length === 1 ? "" : "s"}`}
            </button>
          </div>
        )}
      </div>

      {/* Material Master is history-only. Adding materials happens on the Materials page. */}

      {tab === "list" && (() => {
        const q = listSearch.trim().toLowerCase();
        const sortVal = (m, key) => {
          switch (key) {
            case "name":          return (m.name || "").toLowerCase();
            case "group":         return (m.group || "").toLowerCase();
            case "unit":          return (m.unit || "").toLowerCase();
            case "gst_pct":       return Number(m.gst_pct) || 0;
            case "base_price":    return Number(m.base_price) || 0;
            case "current_price": return Number(m.current_price) || 0;
            case "purchased":     return Number(m.total_purchased) || 0;
            case "transferred":   return transferredByMaterial[m.id] || 0;
            case "available":     return (Number(m.total_purchased) || 0) - (transferredByMaterial[m.id] || 0);
            case "last_updated":  return Number(m.last_updated) || 0;
            default:              return 0;
          }
        };
        const pMin = priceMin === "" ? null : Number(priceMin);
        const pMax = priceMax === "" ? null : Number(priceMax);
        const qMin = qtyMin === "" ? null : Number(qtyMin);
        const qMax = qtyMax === "" ? null : Number(qtyMax);
        const filtered = materials
          .filter(m => !q || (m.name || "").toLowerCase().includes(q) || (m.group || "").toLowerCase().includes(q))
          .filter(m => !groupFilter || (m.group || "") === groupFilter)
          .filter(m => {
            const p = Number(m.current_price) || 0;
            if (pMin !== null && p < pMin) return false;
            if (pMax !== null && p > pMax) return false;
            return true;
          })
          .filter(m => {
            const tp = Number(m.total_purchased) || 0;
            if (qMin !== null && tp < qMin) return false;
            if (qMax !== null && tp > qMax) return false;
            return true;
          })
          .slice()
          .sort((a, b) => {
            const av = sortVal(a, sort.key);
            const bv = sortVal(b, sort.key);
            let cmp;
            if (typeof av === "string" || typeof bv === "string") cmp = String(av).localeCompare(String(bv));
            else cmp = (av < bv ? -1 : av > bv ? 1 : 0);
            return sort.dir === "asc" ? cmp : -cmp;
          });
        const toggleSort = (key) => setSort(s => s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
        const resetAll = () => {
          setSort({ key: "name", dir: "asc" });
          setListSearch(""); setGroupFilter("");
          setPriceMin(""); setPriceMax(""); setQtyMin(""); setQtyMax("");
        };
        const isAdmin = (currentUser?.role || "").toLowerCase() === "admin";
        const toggleRow = (id) => setSelectedIds(prev => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
        });
        const allSelected = filtered.length > 0 && filtered.every(m => selectedIds.has(m.id));
        const someSelected = filtered.some(m => selectedIds.has(m.id));
        const toggleAll = () => setSelectedIds(prev => {
          const next = new Set(prev);
          if (allSelected) filtered.forEach(m => next.delete(m.id));
          else filtered.forEach(m => next.add(m.id));
          return next;
        });
        const deleteSelected = () => {
          const ids = Array.from(selectedIds).filter(id => materials.some(m => m.id === id));
          if (ids.length === 0) return;
          const names = ids.map(id => materials.find(m => m.id === id)?.name).filter(Boolean).slice(0, 5);
          const extra = ids.length - names.length;
          confirm({
            title: `Delete ${ids.length} material${ids.length > 1 ? "s" : ""}?`,
            message: `This will permanently remove: ${names.join(", ")}${extra > 0 ? ` +${extra} more` : ""}. Price history and past transfers are retained.`,
            confirmText: "Delete", cancelText: "Cancel", type: "danger",
            onConfirm: async () => {
              setDeleting(true);
              try {
                const batch = writeBatch(db);
                ids.forEach(id => batch.delete(doc(db, "materials", id)));
                await batch.commit();
                setSelectedIds(new Set());
                toast({ title: "Deleted", message: `${ids.length} material${ids.length > 1 ? "s" : ""} removed from master.`, type: "success" });
              } catch (err) {
                toast({ title: "Delete failed", message: err.message, type: "error" });
              } finally {
                setDeleting(false);
              }
            },
          });
        };
        const hasFiltersOrSort = listSearch || groupFilter || priceMin !== "" || priceMax !== "" || qtyMin !== "" || qtyMax !== "" || sort.key !== "name" || sort.dir !== "asc";

        // ── Analytics ───────────────────────────────────────────────────
        const rank = (scoreFn) => materials
          .map(m => ({ m, score: scoreFn(m) }))
          .filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);
        const topTransferred = rank(m => transferredByMaterial[m.id] || 0);
        const topPurchased   = rank(m => Number(m.total_purchased) || 0);
        const topExpensive   = rank(m => Number(m.current_price) || 0);
        const totalPurchasedAll   = materials.reduce((s, m) => s + (Number(m.total_purchased) || 0), 0);
        const totalTransferredAll = Object.values(transferredByMaterial).reduce((s, n) => s + n, 0);
        const availableAll        = Math.max(0, totalPurchasedAll - totalTransferredAll);
        const zeroStock           = materials.filter(m => ((Number(m.total_purchased) || 0) - (transferredByMaterial[m.id] || 0)) <= 0 && (Number(m.total_purchased) || 0) > 0).length;

        const filterInputStyle = { padding: "8px 10px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, width: 82, outline: "none" };
        const SortableTH = ({ k, children, right }) => {
          const active = sort.key === k;
          const arrow = !active ? "↕" : sort.dir === "asc" ? "↑" : "↓";
          return (
            <TH right={right} style={{ cursor: "pointer", userSelect: "none" }} onClick={() => toggleSort(k)}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: active ? "var(--accent)" : undefined }}>
                {children}
                <span style={{ fontSize: 10, opacity: active ? 1 : 0.4 }}>{arrow}</span>
              </span>
            </TH>
          );
        };
        const groupCounts = {};
        materials.forEach(m => { const g = m.group || "—"; groupCounts[g] = (groupCounts[g] || 0) + 1; });
        const totalValue = materials.reduce((s, m) => s + (Number(m.current_price) || 0), 0);
        return (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12, marginBottom: 16 }}>
              {[
                ["Total Unique Materials", materials.length, "var(--accent)"],
                ["Catalog Value", INR(totalValue), "var(--green)"],
                ["Groups Used", Object.keys(groupCounts).length, "var(--gold)"],
                ["Showing", filtered.length, "var(--blue)"],
              ].map(([l, v, c]) => (
                <div key={l} style={{ padding: 14, borderRadius: 12, background: "var(--bg3)", border: "1px solid var(--border)" }}>
                  <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: c, marginTop: 4 }}>{v}</div>
                </div>
              ))}
            </div>
            {/* ── Analytics panel ──────────────────────────────────────── */}
            <Card style={{ padding: 0, marginBottom: 16 }}>
              <div style={{ padding: "10px 14px", borderBottom: showAnalytics ? "1px solid var(--border)" : "none", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 800, fontSize: 12, letterSpacing: 1, textTransform: "uppercase", color: "var(--text2)" }}>
                  <Icon name="pie" size={14} /> Analytics
                </div>
                <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                  <div style={{ fontSize: 11, color: "var(--text3)" }}>Purchased <strong style={{ color: "var(--text)" }}>{totalPurchasedAll}</strong></div>
                  <div style={{ fontSize: 11, color: "var(--text3)" }}>Transferred <strong style={{ color: "var(--gold)" }}>{totalTransferredAll}</strong></div>
                  <div style={{ fontSize: 11, color: "var(--text3)" }}>Available <strong style={{ color: "var(--green)" }}>{availableAll}</strong></div>
                  <div style={{ fontSize: 11, color: "var(--text3)" }}>Out-of-stock <strong style={{ color: "var(--red)" }}>{zeroStock}</strong></div>
                  <button onClick={() => setShowAnalytics(v => !v)} style={{ padding: "4px 10px", borderRadius: 6, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", cursor: "pointer", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
                    {showAnalytics ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
              {showAnalytics && (
                <div style={{ padding: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 12 }}>
                  {[
                    ["Most Transferred", topTransferred, "var(--gold)", (v) => `${v} used`],
                    ["Most Purchased",   topPurchased,   "var(--accent)", (v) => `${v} bought`],
                    ["Highest Priced",   topExpensive,   "var(--green)", (v) => INR(v)],
                  ].map(([label, list, color, fmt]) => (
                    <div key={label} style={{ padding: 12, borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border)" }}>
                      <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>{label}</div>
                      {list.length === 0 ? (
                        <div style={{ fontSize: 12, color: "var(--text3)", fontStyle: "italic" }}>No data yet</div>
                      ) : list.map((x, i) => (
                        <div key={x.m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", fontSize: 12, borderBottom: i === list.length - 1 ? "none" : "1px dashed var(--border)" }}>
                          <span style={{ color: "var(--text)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "60%" }}>{i + 1}. {x.m.name}</span>
                          <span style={{ color, fontWeight: 800, fontSize: 11 }}>{fmt(x.score)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card style={{ padding: 0, overflowX: "auto" }}>
              <div style={{ padding: 12, borderBottom: "1px solid var(--border)", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <input placeholder="Search name or group…" value={listSearch} onChange={e => setListSearch(e.target.value)}
                  style={{ padding: "8px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, flex: "1 1 240px", minWidth: "min(240px, 100%)", outline: "none" }} />
                <select value={groupFilter} onChange={e => setGroupFilter(e.target.value)}
                  style={{ padding: "8px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, outline: "none" }}>
                  <option value="">All Groups</option>
                  {MATERIAL_GROUPS.map(g => <option key={g} value={g}>{g} ({groupCounts[g] || 0})</option>)}
                </select>
                <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 8, background: "rgba(34,211,238,0.05)", border: "1px dashed rgba(34,211,238,0.2)" }}>
                  <span style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Price</span>
                  <input type="number" placeholder="min" value={priceMin} onChange={e => setPriceMin(e.target.value)} style={filterInputStyle} />
                  <span style={{ color: "var(--text3)" }}>–</span>
                  <input type="number" placeholder="max" value={priceMax} onChange={e => setPriceMax(e.target.value)} style={filterInputStyle} />
                </div>
                <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 8, background: "rgba(245,158,11,0.05)", border: "1px dashed rgba(245,158,11,0.2)" }}>
                  <span style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Qty Purchased</span>
                  <input type="number" placeholder="min" value={qtyMin} onChange={e => setQtyMin(e.target.value)} style={filterInputStyle} />
                  <span style={{ color: "var(--text3)" }}>–</span>
                  <input type="number" placeholder="max" value={qtyMax} onChange={e => setQtyMax(e.target.value)} style={filterInputStyle} />
                </div>
                {hasFiltersOrSort && (
                  <button onClick={resetAll} title="Clear all filters and sort"
                    style={{ padding: "8px 12px", borderRadius: 8, background: "rgba(215,56,59,0.08)", color: "var(--red)", border: "1px solid rgba(215,56,59,0.25)", cursor: "pointer", fontWeight: 800, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Icon name="close" size={12} /> Clear
                  </button>
                )}
                {isAdmin && selectedIds.size > 0 && (
                  <button onClick={deleteSelected} disabled={deleting} title="Delete selected materials"
                    style={{ padding: "8px 14px", borderRadius: 8, background: "linear-gradient(135deg,#ef4444,#b91c1c)", color: "#fff", border: "none", cursor: deleting ? "not-allowed" : "pointer", fontWeight: 800, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6, opacity: deleting ? 0.6 : 1 }}>
                    <Icon name="del" size={12} /> {deleting ? "Deleting…" : `Delete ${selectedIds.size} Selected`}
                  </button>
                )}
                {isAdmin && (
                  <button onClick={scanDuplicates} title="Scan for materials sharing the same name and merge them into one record"
                    style={{ padding: "8px 14px", borderRadius: 8, background: "rgba(245,158,11,0.08)", color: "var(--gold)", border: "1px solid rgba(245,158,11,0.35)", cursor: "pointer", fontWeight: 800, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Icon name="log" size={12} /> Merge Duplicates
                  </button>
                )}
                <button onClick={() => setTab("add")}
                  style={{ padding: "8px 14px", borderRadius: 8, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 800, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginLeft: "auto" }}>
                  <Icon name="plus" size={12} /> Add More Materials
                </button>
              </div>
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
                <thead>
                  <tr>
                    {isAdmin && (
                      <TH style={{ width: 36 }}>
                        <input type="checkbox" checked={allSelected} ref={el => { if (el) el.indeterminate = !allSelected && someSelected; }} onChange={toggleAll} style={{ cursor: "pointer", accentColor: "var(--red)" }} />
                      </TH>
                    )}
                    <TH style={{ width: 40 }}>#</TH>
                    <SortableTH k="name">Material</SortableTH>
                    <SortableTH k="group">Group</SortableTH>
                    <SortableTH k="unit">Unit</SortableTH>
                    <SortableTH k="purchased" right>Purchased</SortableTH>
                    <SortableTH k="transferred" right>Transferred</SortableTH>
                    <SortableTH k="available" right>Available</SortableTH>
                    <SortableTH k="gst_pct" right>GST %</SortableTH>
                    <SortableTH k="base_price" right>Base Price</SortableTH>
                    <SortableTH k="current_price" right>Price (incl. GST)</SortableTH>
                    <SortableTH k="last_updated">Last Updated</SortableTH>
                    <TH right style={{ width: 80 }}>History</TH>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((m, i) => {
                    const pur = Number(m.total_purchased) || 0;
                    const tra = transferredByMaterial[m.id] || 0;
                    const avl = pur - tra;
                    return (
                    <tr key={m.id} style={selectedIds.has(m.id) ? { background: "rgba(215,56,59,0.06)" } : undefined}>
                      {isAdmin && (
                        <TD>
                          <input type="checkbox" checked={selectedIds.has(m.id)} onChange={() => toggleRow(m.id)} style={{ cursor: "pointer", accentColor: "var(--red)" }} />
                        </TD>
                      )}
                      <TD style={{ color: "var(--text3)", fontWeight: 700 }}>{i + 1}</TD>
                      <TD style={{ fontWeight: 700 }}>{m.name}</TD>
                      <TD>{m.group ? <span style={{ padding: "2px 8px", borderRadius: 999, background: "rgba(34,211,238,0.12)", color: "var(--accent)", fontSize: 10, fontWeight: 800 }}>{m.group}</span> : <span style={{ color: "var(--text3)" }}>—</span>}</TD>
                      <TD style={{ color: "var(--text3)" }}>{m.unit || "pcs"}</TD>
                      <TD right style={{ color: "var(--text)", fontWeight: 700 }}>{pur}</TD>
                      <TD right style={{ color: "var(--gold)", fontWeight: 700 }}>{tra}</TD>
                      <TD right style={{ color: avl > 0 ? "var(--green)" : "var(--red)", fontWeight: 800 }}>{avl}</TD>
                      <TD right style={{ color: "var(--orange)", fontWeight: 700 }}>{m.gst_pct || 0}%</TD>
                      <TD right style={{ color: "var(--text3)" }}>{INR(m.base_price || 0)}</TD>
                      <TD right style={{ color: "var(--accent)", fontWeight: 800 }}>{INR(m.current_price || 0)}</TD>
                      <TD style={{ fontSize: 11, color: "var(--text3)" }}>{m.last_updated ? new Date(m.last_updated).toLocaleDateString() : "—"}</TD>
                      <TD right>
                        <IconBtn name="log" title="Purchase & price history" variant="secondary" onClick={() => setHistoryModal(m)} />
                      </TD>
                    </tr>
                    );
                  })}
                  {filtered.length === 0 && (
                    <tr><td colSpan={isAdmin ? 13 : 12} style={{ padding: 40, textAlign: "center", color: "var(--text3)", fontStyle: "italic" }}>
                      {materials.length === 0 ? "No materials yet — click Add Materials to get started." : "No matches. Try clearing filters."}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </Card>
          </>
        );
      })()}

      {tab === "add" && (
        <>
      <div style={{ padding: "10px 12px", marginBottom: 10, borderRadius: 8, background: "rgba(34,211,238,0.05)", border: "1px dashed rgba(34,211,238,0.25)", fontSize: 12, color: "var(--text3)" }}>
        💡 Type in the <strong style={{ color: "var(--text)" }}>Material Name</strong> cell — existing entries from the master appear as suggestions. Pick one to auto-fill unit/group/GST/price. Empty rows are skipped on save.
      </div>

      <Card style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", minWidth: 900, borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
          <thead>
            <tr>
              <TH style={{ width: 40 }}>#</TH>
              <TH>Material Name *</TH>
              <TH style={{ width: 110 }}>Unit</TH>
              <TH style={{ width: 160 }}>Group</TH>
              <TH right style={{ width: 90 }}>GST %</TH>
              <TH right style={{ width: 140 }}>Price (incl. GST) *</TH>
              <TH right style={{ width: 120 }}>Base (ex-GST)</TH>
              <TH style={{ width: 90 }}>Status</TH>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const suggestions = focusedIdx === i ? suggestionsFor(i) : [];
              const basePrice = r.price_inc_gst && Number(r.price_inc_gst) > 0 && Number(r.gst_pct) >= 0
                ? +(Number(r.price_inc_gst) / (1 + Number(r.gst_pct) / 100)).toFixed(2) : 0;
              const match = materials.find(m => m.id === r.existingId)
                || materials.find(m => (m.name || "").toLowerCase() === r.name.trim().toLowerCase());
              const status = !r.name.trim() ? "empty" : match ? (Math.abs((match.current_price || 0) - Number(r.price_inc_gst || 0)) > 0.01 ? "update" : "same") : "new";
              const statusColor = status === "new" ? "var(--green)" : status === "update" ? "var(--accent)" : status === "same" ? "var(--text3)" : "var(--text3)";
              return (
                <tr key={i} style={{ background: focusedIdx === i ? "rgba(34,211,238,0.03)" : "transparent" }}>
                  <TD style={{ color: "var(--text3)", fontWeight: 700 }}>{i + 1}</TD>
                  <TD style={{ position: "relative" }}>
                    <input
                      value={r.name}
                      onChange={e => updateRow(i, { name: e.target.value, existingId: null })}
                      onFocus={() => setFocusedIdx(i)}
                      onBlur={() => setTimeout(() => setFocusedIdx(f => f === i ? -1 : f), 150)}
                      placeholder="Search or type a new material…"
                      style={{ ...inp, fontWeight: 700 }}
                    />
                    {suggestions.length > 0 && (
                      <div style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 2, background: "var(--bg2)", border: "1px solid var(--border2)", borderRadius: 10, boxShadow: "0 12px 30px rgba(0,0,0,0.4)", maxHeight: 220, overflowY: "auto", zIndex: 20 }}>
                        {suggestions.map(m => (
                          <button key={m.id} type="button" onMouseDown={e => e.preventDefault()} onClick={() => pickMaterial(i, m)}
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
                  <TD>
                    <input value={r.unit} onChange={e => updateRow(i, { unit: e.target.value })} placeholder="pcs" style={inp} />
                  </TD>
                  <TD>
                    <select value={r.group} onChange={e => updateRow(i, { group: e.target.value })} style={inp}>
                      <option value="">—</option>
                      {MATERIAL_GROUPS.map(g => <option key={g}>{g}</option>)}
                    </select>
                  </TD>
                  <TD right>
                    <input type="number" min="0" step="0.01" value={r.gst_pct} onChange={e => updateRow(i, { gst_pct: Number(e.target.value) })} style={{ ...inp, textAlign: "right" }} />
                  </TD>
                  <TD right>
                    <input type="number" min="0" step="0.01" value={r.price_inc_gst} onChange={e => updateRow(i, { price_inc_gst: e.target.value })} placeholder="0" style={{ ...inp, textAlign: "right", fontWeight: 700, color: "var(--accent)" }} />
                  </TD>
                  <TD right style={{ color: "var(--text3)" }}>{basePrice > 0 ? INR(basePrice) : "—"}</TD>
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
      )}

      {false && tab === "transfers" && (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 800, color: "var(--text)" }}>Transfers for {new Date().toLocaleString("default", { month: "long", year: "numeric" })}</div>
              <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 2 }}>
                {thisMonthAllocations.length} transfer{thisMonthAllocations.length === 1 ? "" : "s"} · Total value {INR(thisMonthAllocations.reduce((s, a) => s + (Number(a.total) || 0), 0))}
              </div>
            </div>
            <button onClick={startNewList}
              style={{ padding: "10px 18px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
              <Icon name="plus" size={14} /> Create New Transfer List
            </button>
          </div>
          <Card style={{ padding: 0, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 }}>
              <thead>
                <tr>
                  <TH>Date</TH>
                  <TH>Branch</TH>
                  <TH right>Items</TH>
                  <TH right>Total</TH>
                  <TH>Note</TH>
                  <TH>By</TH>
                </tr>
              </thead>
              <tbody>
                {thisMonthAllocations.map(a => (
                  <tr key={a.id}>
                    <TD style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{a.date || (a.transferred_at ? new Date(a.transferred_at).toLocaleDateString() : "—")}</TD>
                    <TD><Pill label={(a.branch_name || "—").replace("V-CUT ", "")} color="blue" /></TD>
                    <TD right>
                      <details>
                        <summary style={{ cursor: "pointer", color: "var(--accent)", fontWeight: 700 }}>{a.items?.length || 0} items</summary>
                        <div style={{ marginTop: 8, fontSize: 11, color: "var(--text3)" }}>
                          {(a.items || []).map((it, i) => (
                            <div key={i}>{it.name} — {it.qty} {it.unit} @ {INR(it.price_at_transfer)} = <strong style={{ color: "var(--text2)" }}>{INR(it.line_total)}</strong></div>
                          ))}
                        </div>
                      </details>
                    </TD>
                    <TD right style={{ fontWeight: 800, color: "var(--green)" }}>{INR(a.total || 0)}</TD>
                    <TD style={{ fontSize: 11, color: "var(--text3)", maxWidth: 220 }}>{a.note || "—"}</TD>
                    <TD style={{ fontSize: 11, color: "var(--text3)" }}>{a.transferred_by || "—"}</TD>
                  </tr>
                ))}
                {thisMonthAllocations.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: 40, textAlign: "center", color: "var(--text3)", fontStyle: "italic" }}>No transfers this month. Click <strong>Create New Transfer List</strong> to start.</td></tr>
                )}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {/* Row Count Popup — asks "how many rows?" before opening the transfer builder */}
      <Modal isOpen={!!rowCountPrompt} onClose={() => setRowCountPrompt(null)} title="Create New Transfer List" width={440}>
        {rowCountPrompt && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 13, color: "var(--text2)" }}>
              How many material rows do you want to start with? You can add more rows later.
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
                onKeyDown={e => { if (e.key === "Enter") confirmRowCount(); }}
                style={{ padding: "10px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 14, outline: "none", fontWeight: 700 }} autoFocus />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 4 }}>
              <button onClick={() => setRowCountPrompt(null)}
                style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>Cancel</button>
              <button onClick={confirmRowCount}
                style={{ padding: "10px 20px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>
                Create {rowCountPrompt.count} Row{rowCountPrompt.count === 1 ? "" : "s"}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* New Transfer List builder */}
      <Modal isOpen={!!newList} onClose={() => !committingTransfer && setNewList(null)} title="New Transfer List" width={980}>
        {newList && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, marginBottom: 12 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Destination Branch *</label>
                <select value={newList.branch_id} onChange={e => setNewList(n => ({ ...n, branch_id: e.target.value }))}
                  style={{ padding: "10px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, outline: "none" }}>
                  <option value="">Select branch…</option>
                  {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Transfer Date *</label>
                <input type="date" value={newList.date} onChange={e => setNewList(n => ({ ...n, date: e.target.value }))}
                  style={{ padding: "10px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 13, outline: "none" }} />
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 10, background: "rgba(74,222,128,0.08)", border: "1px solid rgba(74,222,128,0.25)", marginBottom: 10, fontSize: 11, color: "var(--green)" }}>
              <input type="checkbox" checked={!!newList.auto_entry_update} onChange={e => setNewList(n => ({ ...n, auto_entry_update: e.target.checked }))} />
              <span>Auto-update the branch's daily entry on this date with material expense (<strong>{INR(transferTotal)}</strong>)</span>
            </div>

            <div style={{ maxHeight: 420, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 10 }}>
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
                <thead style={{ position: "sticky", top: 0, background: "var(--bg4)", zIndex: 1 }}>
                  <tr>
                    <TH style={{ width: 40 }}>#</TH>
                    <TH>Material (search the master) *</TH>
                    <TH right style={{ width: 80 }}>Qty *</TH>
                    <TH style={{ width: 80 }}>Unit</TH>
                    <TH right style={{ width: 130 }}>Unit Price</TH>
                    <TH right style={{ width: 120 }}>Line Total</TH>
                    <TH style={{ width: 40 }}></TH>
                  </tr>
                </thead>
                <tbody>
                  {newList.rows.map((r, i) => {
                    const q = (r.search || "").trim().toLowerCase();
                    const suggestions = pickerFocus === i && q.length >= 2
                      ? materials.filter(m => (m.name || "").toLowerCase().includes(q) && !newList.rows.some(rr => rr.material_id === m.id && rr !== r)).slice(0, 6)
                      : [];
                    const inp = { padding: "6px 8px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, width: "100%", outline: "none" };
                    const lineTotal = (Number(r.qty) || 0) * (Number(r.price_at_transfer) || 0);
                    return (
                      <tr key={i}>
                        <TD style={{ color: "var(--text3)", fontWeight: 700 }}>{i + 1}</TD>
                        <TD style={{ position: "relative" }}>
                          <input value={r.search || ""} onChange={e => updateTransferRow(i, { search: e.target.value, material_id: null, name: e.target.value })}
                            onFocus={() => setPickerFocus(i)} onBlur={() => setTimeout(() => setPickerFocus(f => f === i ? -1 : f), 150)}
                            placeholder="Type to search master…" style={{ ...inp, fontWeight: 700 }} />
                          {suggestions.length > 0 && (
                            <div style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 2, background: "var(--bg2)", border: "1px solid var(--border2)", borderRadius: 10, boxShadow: "0 12px 30px rgba(0,0,0,0.4)", maxHeight: 220, overflowY: "auto", zIndex: 30 }}>
                              {suggestions.map(m => (
                                <button key={m.id} type="button" onMouseDown={e => e.preventDefault()} onClick={() => pickTransferMaterial(i, m)}
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
                        </TD>
                        <TD right><input type="number" min="0" step="0.01" value={r.qty} onChange={e => updateTransferRow(i, { qty: Number(e.target.value) })} style={{ ...inp, textAlign: "right" }} /></TD>
                        <TD><input value={r.unit} onChange={e => updateTransferRow(i, { unit: e.target.value })} style={inp} /></TD>
                        <TD right><input type="number" min="0" step="0.01" value={r.price_at_transfer} onChange={e => updateTransferRow(i, { price_at_transfer: Number(e.target.value) })} style={{ ...inp, textAlign: "right", fontWeight: 700, color: "var(--accent)" }} /></TD>
                        <TD right style={{ fontWeight: 800, color: "var(--green)" }}>{INR(lineTotal)}</TD>
                        <TD>
                          {newList.rows.length > 1 && (
                            <button onClick={() => removeTransferRow(i)} title="Remove row"
                              style={{ padding: "4px 8px", borderRadius: 6, background: "var(--red-bg)", color: "var(--red)", border: "1px solid rgba(248,113,113,0.3)", cursor: "pointer", fontSize: 12, fontWeight: 800 }}>×</button>
                          )}
                        </TD>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Add more rows at the bottom — user-supplied count */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 10, padding: 10, borderRadius: 10, background: "var(--bg3)", border: "1px dashed var(--border2)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Add more rows</label>
                <input type="number" min="1" max="200" placeholder="5" value={addMoreInput} onChange={e => setAddMoreInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && addMoreInput) addRowsToList(addMoreInput); }}
                  style={{ width: 90, padding: "6px 10px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, outline: "none", textAlign: "center" }} />
                <button onClick={() => addRowsToList(addMoreInput || 1)}
                  style={{ padding: "6px 14px", borderRadius: 8, background: "var(--bg4)", color: "var(--accent)", border: "1px solid var(--accent)", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 800, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  <Icon name="plus" size={12} /> Add {addMoreInput || 1}
                </button>
                {[1, 5, 10].map(n => (
                  <button key={n} onClick={() => addRowsToList(n)}
                    style={{ padding: "4px 10px", borderRadius: 6, background: "transparent", color: "var(--text3)", border: "1px solid var(--border2)", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
                    +{n}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 13, color: "var(--text3)" }}>
                {filledTransferRows.length} filled / {newList.rows.length} rows · Total <strong style={{ color: "var(--accent)", fontSize: 16 }}>{INR(transferTotal)}</strong>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button onClick={() => setNewList(null)} disabled={committingTransfer}
                style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: committingTransfer ? "wait" : "pointer" }}>Cancel</button>
              <button onClick={commitNewList} disabled={committingTransfer || filledTransferRows.length === 0 || !newList.branch_id}
                style={{ padding: "10px 22px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: committingTransfer ? "wait" : "pointer", opacity: (committingTransfer || filledTransferRows.length === 0 || !newList.branch_id) ? 0.5 : 1, display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Icon name="check" size={13} /> {committingTransfer ? "Transferring..." : `Transfer ${filledTransferRows.length} Item${filledTransferRows.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Upload Preview Modal */}
      <Modal isOpen={!!uploadPreview} onClose={() => !ioBusy && setUploadPreview(null)} title={`Review Upload — ${uploadPreview?.fileName || ""}`} width={920}>
        {uploadPreview && (() => {
          const included = uploadPreview.items.filter(i => i.include && i.name?.trim() && i.price_inc_gst > 0);
          const totalQty = included.reduce((s, i) => s + (Number(i.qty) || 0), 0);
          const totalValue = included.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price_inc_gst) || 0), 0);
          const newCount = included.filter(i => !i.existing).length;
          const priceChangeCount = included.filter(i => i.existing && Math.abs((i.existing.old_price || 0) - (i.price_inc_gst || 0)) > 0.01).length;
          const updateRow = (idx, patch) => setUploadPreview(p => ({ ...p, items: p.items.map((x, i) => i === idx ? { ...x, ...patch } : x) }));
          const inp = { padding: "4px 8px", borderRadius: 6, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, width: "100%", outline: "none" };
          return (
            <div>
              <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 10 }}>
                {uploadPreview.manual
                  ? <>Auto-detection found no rows. Add materials manually below — raw text from the file is shown for reference.</>
                  : <>Review the {uploadPreview.items.length} rows from <strong>{uploadPreview.fileName}</strong>. Uncheck any row to skip. Existing materials get price-history logs when the price changes.</>}
                {uploadPreview.skippedSheets?.length > 0 && <div style={{ marginTop: 4, fontSize: 11 }}>Ignored sheets: <strong>{uploadPreview.skippedSheets.join(", ")}</strong></div>}
              </div>
              {uploadPreview.rawLines?.length > 0 && (
                <details style={{ marginBottom: 12, fontSize: 11, color: "var(--text3)" }}>
                  <summary style={{ cursor: "pointer", fontWeight: 700 }}>Raw extracted text ({uploadPreview.rawLines.length} lines)</summary>
                  <pre style={{ maxHeight: 160, overflowY: "auto", background: "var(--bg2)", padding: 10, borderRadius: 8, marginTop: 6, whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 10, lineHeight: 1.5 }}>
                    {uploadPreview.rawLines.join("\n")}
                  </pre>
                </details>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 8, marginBottom: 12 }}>
                {[
                  ["To Import", included.length, "var(--accent)"],
                  ["Total Qty", totalQty, "var(--blue)"],
                  ["Total Value", INR(totalValue), "var(--green)"],
                  ["New", newCount, "var(--green)"],
                  ["Price Changes", priceChangeCount, "var(--orange)"],
                ].map(([l, v, c]) => (
                  <div key={l} style={{ padding: 10, borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--border)" }}>
                    <div style={{ fontSize: 9, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>{l}</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: c, marginTop: 2 }}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{ maxHeight: 440, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 10 }}>
                <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
                  <thead style={{ position: "sticky", top: 0, background: "var(--bg4)", zIndex: 1 }}>
                    <tr>
                      <TH style={{ width: 30 }}></TH>
                      <TH>Name</TH>
                      <TH>Group</TH>
                      <TH>Unit</TH>
                      <TH right>GST %</TH>
                      <TH right>Price</TH>
                      <TH right>Qty</TH>
                      <TH>Kind</TH>
                    </tr>
                  </thead>
                  <tbody>
                    {uploadPreview.items.map((it, idx) => {
                      const priceChanged = it.existing && Math.abs((it.existing.old_price || 0) - (it.price_inc_gst || 0)) > 0.01;
                      const kind = !it.existing ? "NEW" : priceChanged ? "PRICE CHANGE" : "UPDATE";
                      const kindColor = kind === "NEW" ? "green" : kind === "PRICE CHANGE" ? "orange" : "blue";
                      return (
                        <tr key={idx}>
                          <TD><input type="checkbox" checked={it.include} onChange={e => updateRow(idx, { include: e.target.checked })} /></TD>
                          <TD><input value={it.name} onChange={e => updateRow(idx, { name: e.target.value })} style={{ ...inp, fontWeight: 700 }} /></TD>
                          <TD>
                            <select value={it.group || ""} onChange={e => updateRow(idx, { group: e.target.value })} style={inp}>
                              <option value="">—</option>
                              {MATERIAL_GROUPS.map(g => <option key={g}>{g}</option>)}
                            </select>
                          </TD>
                          <TD><input value={it.unit} onChange={e => updateRow(idx, { unit: e.target.value })} style={{ ...inp, maxWidth: 70 }} /></TD>
                          <TD right><input type="number" min="0" step="0.01" value={it.gst_pct} onChange={e => updateRow(idx, { gst_pct: Number(e.target.value) })} style={{ ...inp, maxWidth: 70, textAlign: "right" }} /></TD>
                          <TD right>
                            <input type="number" min="0" step="0.01" value={it.price_inc_gst} onChange={e => updateRow(idx, { price_inc_gst: Number(e.target.value) })} style={{ ...inp, maxWidth: 100, textAlign: "right", fontWeight: 700, color: "var(--accent)" }} />
                            {priceChanged && <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>Was {INR(it.existing.old_price)}</div>}
                          </TD>
                          <TD right><input type="number" min="0" step="1" value={it.qty} onChange={e => updateRow(idx, { qty: Number(e.target.value) })} style={{ ...inp, maxWidth: 70, textAlign: "right" }} /></TD>
                          <TD><Pill label={kind} color={kindColor} /></TD>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
                <button onClick={() => setUploadPreview(p => ({ ...p, items: [...p.items, { name: "", unit: "pcs", group: "", gst_pct: 18, price_inc_gst: 0, base_price: 0, qty: 1, existing: null, include: true }] }))}
                  style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg3)", color: "var(--accent)", border: "1px solid var(--border2)", fontWeight: 700, fontSize: 11, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <Icon name="plus" size={11} /> Add Row
                </button>
                <div style={{ display: "flex", gap: 10 }}>
                  <button onClick={() => setUploadPreview(null)} disabled={ioBusy}
                    style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", fontWeight: 600, fontSize: 12, cursor: ioBusy ? "wait" : "pointer" }}>Cancel</button>
                  <button onClick={commitMasterUpload} disabled={ioBusy || included.length === 0}
                    style={{ padding: "10px 20px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: (ioBusy || included.length === 0) ? "not-allowed" : "pointer", opacity: (ioBusy || included.length === 0) ? 0.5 : 1, display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <Icon name="save" size={13} /> {ioBusy ? "Saving…" : `Import ${included.length} Row${included.length === 1 ? "" : "s"}`}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* Purchase & Price History Modal */}
      <Modal isOpen={!!historyModal} onClose={() => setHistoryModal(null)} title={`Purchase & Price History — ${historyModal?.name || ""}`} width={680}>
        {historyModal && (() => {
          const hist = priceHistory.filter(h => h.material_id === historyModal.id);
          const totalQty = hist.reduce((s, h) => s + (Number(h.qty) || 0), 0);
          return (
            <div>
              <div style={{ padding: 12, borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border)", marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Current Price</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: "var(--accent)" }}>{INR(historyModal.current_price || 0)}</div>
                </div>
                <div style={{ fontSize: 11, color: "var(--text3)", textAlign: "right" }}>
                  <div>GST <strong style={{ color: "var(--text)" }}>{historyModal.gst_pct || 0}%</strong> · Unit <strong style={{ color: "var(--text)" }}>{historyModal.unit || "—"}</strong></div>
                  <div>Group <strong style={{ color: "var(--text)" }}>{historyModal.group || "—"}</strong></div>
                  <div>Total Purchased <strong style={{ color: "var(--text)" }}>{Number(historyModal.total_purchased) || 0}</strong> · Logged Qty <strong style={{ color: "var(--text)" }}>{totalQty}</strong></div>
                </div>
              </div>
              {hist.length === 0 ? (
                <div style={{ padding: 20, textAlign: "center", color: "var(--text3)", fontStyle: "italic" }}>No purchase or price-change events logged yet.</div>
              ) : (
                <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                  <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 12 }}>
                    <thead style={{ background: "var(--bg4)" }}>
                      <tr><TH>Date</TH><TH>Event</TH><TH right>Qty</TH><TH right>Old</TH><TH right>New</TH><TH right>Δ</TH><TH>Source</TH><TH>By</TH></tr>
                    </thead>
                    <tbody>
                      {hist.map(h => {
                        const diff = (h.new_price || 0) - (h.old_price || 0);
                        const ev = h.event || (h.old_price ? "price_change" : "purchase");
                        const evColor = ev === "first_purchase" ? "var(--green)" : ev === "price_change" ? "var(--gold)" : "var(--accent)";
                        return (
                          <tr key={h.id}>
                            <TD>{h.effective_from || (h.changed_at ? h.changed_at.slice(0, 10) : "—")}</TD>
                            <TD style={{ fontSize: 10, fontWeight: 800, color: evColor, textTransform: "uppercase", letterSpacing: 0.5 }}>{ev.replace("_", " ")}</TD>
                            <TD right style={{ color: "var(--text)", fontWeight: 700 }}>{Number(h.qty) || 0}</TD>
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

      {/* Merge Duplicates Preview */}
      <Modal isOpen={!!mergePreview} onClose={() => !merging && setMergePreview(null)} title="Merge Duplicate Materials" width={760}>
        {mergePreview && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ padding: "10px 14px", borderRadius: 10, background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.25)", fontSize: 12, color: "var(--text2)" }}>
              Found <strong style={{ color: "var(--gold)" }}>{mergePreview.groups.length}</strong> duplicate group{mergePreview.groups.length > 1 ? "s" : ""}.
              For each group, the <strong>keeper</strong> (highest <em>total purchased</em>, then earliest update) absorbs the others.
              Their purchase history and past transfers will be reassigned to the keeper, then the duplicate records will be deleted.
            </div>
            <div style={{ maxHeight: "55vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
              {mergePreview.groups.map(g => (
                <div key={g.key} style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                  <div style={{ padding: "10px 14px", background: "var(--bg3)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                    <div style={{ fontWeight: 800, color: "var(--text)" }}>{g.name}</div>
                    <div style={{ fontSize: 11, color: "var(--text3)" }}>
                      {g.losers.length + 1} records → 1 · qty {g.totalQty} · transferred {g.totalAlloc}
                    </div>
                  </div>
                  <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 11 }}>
                    <thead style={{ background: "var(--bg4)" }}>
                      <tr><TH style={{ width: 70 }}>Role</TH><TH>Group</TH><TH right>Purchased</TH><TH right>Transferred</TH><TH right>Price</TH><TH>Last Updated</TH></tr>
                    </thead>
                    <tbody>
                      {[g.keeper, ...g.losers].map((m, idx) => {
                        const isKeeper = idx === 0;
                        return (
                          <tr key={m.id} style={{ background: isKeeper ? "rgba(74,222,128,0.05)" : "rgba(215,56,59,0.04)" }}>
                            <TD style={{ fontWeight: 800, color: isKeeper ? "var(--green)" : "var(--red)", textTransform: "uppercase", letterSpacing: 0.5, fontSize: 10 }}>
                              {isKeeper ? "Keep" : "Delete"}
                            </TD>
                            <TD style={{ color: "var(--text2)" }}>{m.group || "—"}</TD>
                            <TD right style={{ fontWeight: 700 }}>{Number(m.total_purchased) || 0}</TD>
                            <TD right style={{ color: "var(--gold)", fontWeight: 700 }}>{transferredByMaterial[m.id] || 0}</TD>
                            <TD right style={{ color: "var(--accent)", fontWeight: 700 }}>{INR(m.current_price || 0)}</TD>
                            <TD style={{ fontSize: 10, color: "var(--text3)" }}>{m.last_updated ? new Date(m.last_updated).toLocaleDateString() : "—"}</TD>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button onClick={() => setMergePreview(null)} disabled={merging}
                style={{ padding: "10px 18px", borderRadius: 10, background: "var(--bg4)", color: "var(--text2)", border: "1px solid var(--border2)", fontWeight: 700, fontSize: 12, cursor: merging ? "not-allowed" : "pointer", opacity: merging ? 0.6 : 1 }}>
                Cancel
              </button>
              <button onClick={commitMerge} disabled={merging}
                style={{ padding: "10px 20px", borderRadius: 10, background: "linear-gradient(135deg,var(--accent),var(--gold2))", color: "#000", border: "none", fontWeight: 800, fontSize: 12, cursor: merging ? "not-allowed" : "pointer", display: "inline-flex", alignItems: "center", gap: 6, opacity: merging ? 0.6 : 1 }}>
                <Icon name="save" size={13} /> {merging ? "Merging…" : `Merge ${mergePreview.groups.length} Group${mergePreview.groups.length > 1 ? "s" : ""}`}
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
