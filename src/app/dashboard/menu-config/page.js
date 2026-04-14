"use client";
import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc } from "firebase/firestore";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage } from "@/lib/firebase";
import { useCurrentUser } from "@/lib/currentUser";
import { INR } from "@/lib/calculations";
import { Icon, IconBtn, Card, Pill, Modal, useConfirm, useToast } from "@/components/ui";

// ── Seed data pulled from the V-Cut PDF menus ──
// Multi-column rows (Ladies/Gents, INOA/Masirel/Schwarzkoph, S/M/L, etc.) are flattened
// into individual items so each line is billable in POS. Prices can be edited afterwards.
const SEED_UNISEX = {
  name: "V-Cut Unisex Menu",
  type: "unisex",
  groups: [
    { name: "Hair Styling", items: [
      { icon: "✂️", name: "Basic Hair Cut · Ladies", price: 400, time: "30m" },
      { icon: "✂️", name: "Basic Hair Cut · Gents", price: 150, time: "20m" },
      { icon: "✂️", name: "Adv Hair Cut · Ladies", price: 700, time: "45m" },
      { icon: "✂️", name: "Adv Hair Cut · Gents", price: 250, time: "30m" },
      { icon: "💇", name: "Fringe / Bangs", price: 200, time: "15m" },
      { icon: "🪒", name: "Shaving", price: 100, time: "15m" },
      { icon: "🧔", name: "Beard Trimming", price: 100, time: "15m" },
      { icon: "👶", name: "Baby's Basic Haircut · Ladies", price: 500, time: "30m" },
      { icon: "👶", name: "Baby's Basic Haircut · Gents", price: 200, time: "20m" },
      { icon: "👶", name: "Baby Adv Haircut · Ladies", price: 350, time: "30m" },
      { icon: "👶", name: "Baby Adv Haircut · Gents", price: 300, time: "30m" },
      { icon: "🛁", name: "Hair Wash with Conditioner · Ladies", price: 500, time: "20m" },
      { icon: "🛁", name: "Hair Wash with Conditioner · Gents", price: 100, time: "15m" },
      { icon: "💆", name: "Oil Massage + Hairwash", price: 300, time: "30m" },
      { icon: "🥚", name: "Head Shave", price: 400, time: "25m" },
    ]},
    { name: "Hair Colour", items: [
      { icon: "🎨", name: "Essensity Root Touchup · INOA", price: 400 },
      { icon: "🎨", name: "Essensity Root Touchup · Masirel", price: 350 },
      { icon: "🎨", name: "Essensity Root Touchup · Schwarzkoph", price: 450 },
      { icon: "🧔", name: "Beard Colour · Masirel", price: 500 },
      { icon: "🧔", name: "Beard & Moustache Colour · INOA", price: 700 },
      { icon: "🧔", name: "Beard & Moustache Colour · Masirel", price: 600 },
      { icon: "🧔", name: "Beard & Moustache Colour · Schwarzkoph", price: 800 },
      { icon: "🎨", name: "Root Touchup upto 2\" · INOA", price: 1200 },
      { icon: "🎨", name: "Root Touchup upto 2\" · Masirel", price: 1000 },
      { icon: "🎨", name: "Root Touchup upto 2\" · Schwarzkoph", price: 1400 },
      { icon: "🎨", name: "Global Colour Short · INOA", price: 2000 },
      { icon: "🎨", name: "Global Colour Short · Masirel", price: 1200 },
      { icon: "🎨", name: "Global Colour Short · Schwarzkoph", price: 1600 },
      { icon: "🎨", name: "Global Colour Medium · INOA", price: 2500 },
      { icon: "🎨", name: "Global Colour Medium · Masirel", price: 3500 },
      { icon: "🎨", name: "Global Colour Medium · Schwarzkoph", price: 4000 },
      { icon: "🎨", name: "Fashion Colour · INOA", price: 2499 },
      { icon: "🎨", name: "Fashion Colour · Masirel", price: 2799 },
      { icon: "🎨", name: "Fashion Colour · Schwarzkoph", price: 2999 },
      { icon: "💡", name: "Highlights per Strip · INOA", price: 3000 },
      { icon: "💡", name: "Highlights per Strip · Masirel", price: 3500 },
      { icon: "💡", name: "Highlights per Strip · Schwarzkoph", price: 4000 },
      { icon: "🖌️", name: "Balayage / Cap Colour · INOA", price: 2999 },
      { icon: "🖌️", name: "Balayage / Cap Colour · Masirel", price: 3499 },
      { icon: "🖌️", name: "Balayage / Cap Colour · Schwarzkoph", price: 3899 },
    ]},
    { name: "Facials", items: [
      { icon: "🌿", name: "Nature Gentle Facial", price: 700 },
      { icon: "🍊", name: "Fruit Facial", price: 900 },
      { icon: "✨", name: "Korean Glass Skin Facial", price: 1000 },
      { icon: "✨", name: "VLCC Gold", price: 1100 },
      { icon: "✨", name: "Lotus Gold", price: 1100 },
      { icon: "💎", name: "Lotus Diamond", price: 1200 },
      { icon: "🍷", name: "Herbal Wine", price: 1300 },
      { icon: "✨", name: "Raaga Gold", price: 1400 },
      { icon: "🌿", name: "Raaga Anti-Acne", price: 1400 },
      { icon: "🌸", name: "Aroma Magic Pearl", price: 1400 },
      { icon: "⚪", name: "VLCC Pearl", price: 1500 },
      { icon: "💎", name: "Raaga Platinum", price: 1500 },
      { icon: "✨", name: "Raaga Fairness", price: 1600 },
      { icon: "✨", name: "Shahnaz Husain Gold", price: 1700 },
      { icon: "⚪", name: "Lotus Radiant Pearl", price: 1500 },
      { icon: "⏳", name: "Raaga Antiaging", price: 1400 },
      { icon: "✨", name: "Lotus Adv Skin Whitening", price: 1800 },
      { icon: "💧", name: "Kanpeki Pro Hydra (7 steps)", price: 1800 },
      { icon: "✨", name: "Korean Glass Skin Facial (Adv)", price: 2200 },
      { icon: "🌟", name: "O3+ Shine & Glow", price: 2200 },
      { icon: "💎", name: "Shahnaz Husain Diamond", price: 2300 },
      { icon: "⏳", name: "Lotus Adv Anti Aging", price: 2500 },
      { icon: "✨", name: "Lotus Adv Skin Radiance", price: 2500 },
      { icon: "👰", name: "O3+ Bridal", price: 2700 },
    ]},
    { name: "Waxing", items: [
      { icon: "💅", name: "Chin · Rica", price: 50 },
      { icon: "💅", name: "Chin · Rica Premium", price: 100 },
      { icon: "💅", name: "Upper Lip · Rica", price: 50 },
      { icon: "💅", name: "Upper Lip · Rica Premium", price: 100 },
      { icon: "💪", name: "Under Arms · Rica", price: 150 },
      { icon: "💪", name: "Under Arms · Rica Premium", price: 200 },
      { icon: "🦵", name: "Half Leg · Rica", price: 350 },
      { icon: "🦵", name: "Half Leg · Rica Premium", price: 400 },
      { icon: "💪", name: "Full Hand · Rica", price: 450 },
      { icon: "💪", name: "Full Hand · Rica Premium", price: 500 },
      { icon: "💆", name: "Full Face · Rica", price: 400 },
      { icon: "💆", name: "Full Face · Rica Premium", price: 500 },
      { icon: "🦵", name: "Full Leg · Rica", price: 550 },
      { icon: "🦵", name: "Full Leg · Rica Premium", price: 600 },
      { icon: "👤", name: "Full Back · Rica", price: 650 },
      { icon: "👤", name: "Full Back · Rica Premium", price: 700 },
      { icon: "👤", name: "Full Front · Rica", price: 650 },
      { icon: "👤", name: "Full Front · Rica Premium", price: 700 },
      { icon: "👙", name: "Bikini Wax · Rica", price: 2200 },
      { icon: "👙", name: "Bikini Wax · Rica Premium", price: 2500 },
      { icon: "👤", name: "Full Body · Rica", price: 2500 },
      { icon: "👤", name: "Full Body · Rica Premium", price: 3000 },
    ]},
    { name: "Brazilian", items: [
      { icon: "💅", name: "Upper Lip", price: 100 },
      { icon: "💅", name: "Chin", price: 100 },
      { icon: "💪", name: "Under Arms", price: 200 },
      { icon: "💆", name: "Side Face", price: 250 },
      { icon: "💆", name: "Full Face", price: 500 },
      { icon: "👙", name: "Bikini Wax", price: 3000 },
    ]},
    { name: "Manicure & Pedicure", items: [
      { icon: "💅", name: "Cut & File · Manicure", price: 150 },
      { icon: "🦶", name: "Cut & File · Pedicure", price: 200 },
      { icon: "💅", name: "Cut, File & Polish · Manicure", price: 200 },
      { icon: "🦶", name: "Cut, File & Polish · Pedicure", price: 250 },
      { icon: "💙", name: "Sea Blue · Manicure", price: 500 },
      { icon: "💙", name: "Sea Blue · Pedicure", price: 700 },
      { icon: "🌸", name: "Aroma Magic · Manicure", price: 600 },
      { icon: "🌸", name: "Aroma Magic · Pedicure", price: 800 },
      { icon: "💆", name: "Raaga · Manicure", price: 600 },
      { icon: "💆", name: "Raaga · Pedicure", price: 1000 },
      { icon: "🌹", name: "Lotus Rose · Manicure", price: 700 },
      { icon: "🌹", name: "Lotus Rose · Pedicure", price: 1000 },
      { icon: "🌺", name: "Bombini · Manicure", price: 800 },
      { icon: "🌺", name: "Bombini · Pedicure", price: 1500 },
      { icon: "🦶", name: "Heel Peel Treatment · Pedicure", price: 2000 },
      { icon: "💆", name: "Foot Massage · Pedicure", price: 500 },
    ]},
    { name: "Bleach", items: [
      { icon: "✨", name: "Back · Oxylife", price: 500 },
      { icon: "✨", name: "Back · Gold", price: 450 },
      { icon: "✨", name: "Chest · Oxylife", price: 500 },
      { icon: "✨", name: "Chest · Gold", price: 450 },
      { icon: "💆", name: "Face & Neck · Oxylife", price: 600 },
      { icon: "💆", name: "Face & Neck · Gold", price: 500 },
      { icon: "💪", name: "Full Arms · Oxylife", price: 600 },
      { icon: "💪", name: "Full Arms · Gold", price: 550 },
      { icon: "🦵", name: "Full Legs · Oxylife", price: 700 },
      { icon: "🦵", name: "Full Legs · Gold", price: 600 },
      { icon: "👤", name: "Full Body · Oxylife", price: 2000 },
      { icon: "👤", name: "Full Body · Gold", price: 1500 },
    ]},
    { name: "Clean-up", items: [
      { icon: "🌿", name: "Natures Clean-up", price: 500 },
      { icon: "🍊", name: "Fruit Clean-up", price: 600 },
      { icon: "🪷", name: "Lotus Clean-up", price: 700 },
      { icon: "🌟", name: "O3+ Tan Clear Clean-up", price: 1000 },
    ]},
    { name: "De-Tan", items: [
      { icon: "✨", name: "Raaga", price: 400 },
      { icon: "🦶", name: "Blouse Line / Feet", price: 400 },
      { icon: "💪", name: "Half Arms", price: 450 },
      { icon: "💪", name: "Under Arms", price: 500 },
      { icon: "💆", name: "Specific", price: 550 },
      { icon: "🌟", name: "O3+", price: 600 },
      { icon: "🦵", name: "Half Legs / Full Arms", price: 600 },
      { icon: "💆", name: "Face & Neck", price: 650 },
      { icon: "🦵", name: "Full Legs / Full Back", price: 800 },
      { icon: "👤", name: "Full Body", price: 3000 },
    ]},
    { name: "Threading", items: [
      { icon: "💆", name: "Chin", price: 30 },
      { icon: "💆", name: "Upper Lip", price: 30 },
      { icon: "💆", name: "Lower Lip", price: 30 },
      { icon: "💆", name: "Forehead", price: 40 },
      { icon: "👁️", name: "Eyebrows", price: 50 },
      { icon: "💆", name: "Side Locks", price: 60 },
      { icon: "💆", name: "Full Face", price: 250 },
    ]},
    { name: "Hair Textures", items: [
      { icon: "💇", name: "Kertain Treatment with GK · S", price: 3499 },
      { icon: "💇", name: "Kertain Treatment with GK · M", price: 4999 },
      { icon: "💇", name: "Kertain Treatment with GK · L", price: 5999 },
      { icon: "💉", name: "Botox Treatment · S", price: 3999 },
      { icon: "💉", name: "Botox Treatment · M", price: 4999 },
      { icon: "💉", name: "Botox Treatment · L", price: 6999 },
      { icon: "💫", name: "Nano Plastia · S", price: 3999 },
      { icon: "💫", name: "Nano Plastia · M", price: 4999 },
      { icon: "💫", name: "Nano Plastia · L", price: 6999 },
      { icon: "💆", name: "Smoothening / Straightening · S", price: 2599 },
      { icon: "💆", name: "Smoothening / Straightening · M", price: 3199 },
      { icon: "💆", name: "Smoothening / Straightening · L", price: 4999 },
    ]},
    { name: "Make-up", items: [
      { icon: "👗", name: "Saree Drapping", price: 500 },
      { icon: "👁️", name: "Eye Makeup", price: 700 },
      { icon: "🌸", name: "Day Makeup", price: 1500 },
      { icon: "💄", name: "Party Makeup", price: 2500 },
      { icon: "🌙", name: "Evening Makeup", price: 3000 },
      { icon: "👰", name: "Bridal Makeup", price: 10000 },
    ]},
    { name: "Hair Spa", items: [
      { icon: "🌿", name: "Loreal Deep Nourishing · Ladies S", price: 1200 },
      { icon: "🌿", name: "Loreal Deep Nourishing · Ladies M", price: 1400 },
      { icon: "🌿", name: "Loreal Deep Nourishing · Ladies L", price: 1600 },
      { icon: "🌿", name: "Loreal Deep Nourishing · Gents", price: 700 },
      { icon: "💆", name: "Keratine Restore Hairspa · Ladies S", price: 1500 },
      { icon: "💆", name: "Keratine Restore Hairspa · Ladies M", price: 1700 },
      { icon: "💆", name: "Keratine Restore Hairspa · Ladies L", price: 1800 },
      { icon: "💆", name: "Keratine Restore Hairspa · Gents", price: 900 },
      { icon: "🛁", name: "Anti-Dandruff Treatment + Hairspa · Ladies S", price: 1500 },
      { icon: "🛁", name: "Anti-Dandruff Treatment + Hairspa · Ladies M", price: 1700 },
      { icon: "🛁", name: "Anti-Dandruff Treatment + Hairspa · Ladies L", price: 1800 },
      { icon: "🛁", name: "Anti-Dandruff Treatment + Hairspa · Gents", price: 1000 },
    ]},
    { name: "Straightening", items: [
      { icon: "💇", name: "Loreal Straightening (starts at)", price: 2999 },
      { icon: "💇", name: "Schwarzkoph Straightening (starts at)", price: 3599 },
    ]},
    { name: "Hair Styling (Blowdry & More)", items: [
      { icon: "💨", name: "Blowdry: Straight and Smooth", price: 500 },
      { icon: "🔥", name: "Tong", price: 500 },
      { icon: "🔥", name: "Hot Roller", price: 600 },
      { icon: "💫", name: "Blowdry: In Curl & Out Curl", price: 700 },
      { icon: "🌀", name: "Curls & Waves", price: 700 },
      { icon: "🔥", name: "Iron", price: 800 },
      { icon: "👑", name: "Hair Updo", price: 1000 },
    ]},
  ],
};

const SEED_MENS = {
  name: "V-Cut Mens Menu",
  type: "mens",
  groups: [
    { name: "Hair / Beard", items: [
      { icon: "✂️", name: "Hair Cut", price: 100, time: "20m" },
      { icon: "🪒", name: "Shaving / Trimming", price: 50, time: "15m" },
      { icon: "💆", name: "Head Massage", price: 150, time: "20m" },
      { icon: "🌿", name: "Hair Spa (Loreal)", price: 500, time: "45m" },
    ]},
    { name: "Hair Colour", items: [
      { icon: "🎨", name: "Streax Hair Colour", price: 350 },
      { icon: "🎨", name: "Loreal Masirel Hair Colour", price: 450 },
      { icon: "🎨", name: "Loreal INOA Hair Colour", price: 500 },
    ]},
    { name: "D-Tan with Milk Wash", items: [
      { icon: "✨", name: "VLCC D-Tan", price: 250 },
      { icon: "✨", name: "Raaga D-Tan", price: 400 },
      { icon: "✨", name: "O3+ D-Tan", price: 500 },
    ]},
    { name: "D-Tan + Scrub", items: [
      { icon: "🌿", name: "VLCC D-Tan + Scrub", price: 400 },
      { icon: "🌿", name: "Raaga D-Tan + Scrub", price: 550 },
      { icon: "🌿", name: "O3+ D-Tan + Scrub", price: 600 },
    ]},
    { name: "Facial", items: [
      { icon: "✨", name: "Lotus Anti Tan", price: 700 },
      { icon: "✨", name: "Lotus Gold Facial", price: 850 },
      { icon: "🌿", name: "Herbal Facial", price: 800 },
      { icon: "💎", name: "Lotus Diamond Facial", price: 1200 },
      { icon: "💎", name: "VLCC Diamond Facial", price: 1100 },
      { icon: "🌟", name: "O3+ Facial", price: 1500 },
    ]},
    { name: "Face Massage", items: [
      { icon: "💆", name: "Lotus Massage", price: 300 },
      { icon: "💆", name: "Lotus Scrub", price: 300 },
      { icon: "💆", name: "Massage + Scrub", price: 450 },
    ]},
    { name: "Special Service", items: [
      { icon: "🎁", name: "Hair Cut + Shaving + Face Massage", price: 400 },
      { icon: "🎁", name: "Hair Cut + Shaving + Face Massage (Premium)", price: 500 },
    ]},
  ],
};

const emptyMenu = () => ({
  name: "",
  type: "unisex",
  branches: [],
  groups: [{ name: "New Group", items: [] }],
  pdf_name: "",
  pdf_data: "",
});

export default function MenuConfigPage() {
  const [menus, setMenus] = useState([]);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | { id?, ...menu }
  const [pdfPreview, setPdfPreview] = useState(null); // { name, url }
  const [printMenu, setPrintMenu] = useState(null); // menu being rendered for print
  const [uploadingPdf, setUploadingPdf] = useState(false);
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const currentUser = useCurrentUser() || {};
  const canEdit = ["admin", "accountant"].includes(currentUser?.role);
  const isAdminUser = currentUser?.role === "admin";

  useEffect(() => {
    if (!db) return;
    const unsubs = [
      onSnapshot(collection(db, "menus"), sn => {
        setMenus(sn.docs.map(d => ({ ...d.data(), id: d.id })));
        setLoading(false);
      }),
      onSnapshot(collection(db, "branches"), sn =>
        setBranches(sn.docs.map(d => ({ ...d.data(), id: d.id })))),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  const branchMap = useMemo(() => {
    const m = new Map();
    branches.forEach(b => m.set(b.id, b));
    return m;
  }, [branches]);

  // Auto-create the two V-Cut menus from the PDFs. Idempotent-ish: warns if duplicates by name exist.
  const seedFromPdf = () => {
    const exists = (name) => menus.some(m => (m.name || "").toLowerCase() === name.toLowerCase());
    const dups = [SEED_UNISEX.name, SEED_MENS.name].filter(exists);
    const proceed = () => runSeed();
    if (dups.length > 0) {
      confirm({
        title: "Menus Already Exist",
        message: `A menu named "${dups.join('" and "')}" already exists. Seeding again will create duplicate entries. Continue?`,
        confirmText: "Yes, seed anyway",
        cancelText: "Cancel",
        type: "warning",
        onConfirm: proceed,
      });
    } else {
      confirm({
        title: "Seed V-Cut Menus?",
        message: "This will create <strong>V-Cut Unisex Menu</strong> and <strong>V-Cut Mens Menu</strong> from the PDFs. Unisex will auto-tag branches whose name contains DLF, Hulimav, or HSR. You can edit all items and prices afterwards.",
        confirmText: "Create Menus",
        cancelText: "Cancel",
        type: "success",
        onConfirm: proceed,
      });
    }
  };

  const runSeed = async () => {
    const matchBranch = (keyword) => branches.find(b => (b.name || "").toLowerCase().includes(keyword));
    const unisexBranches = ["dlf", "hulimav", "hsr"]
      .map(matchBranch).filter(Boolean)
      .filter(b => (b.type || "mens") === "unisex")
      .map(b => b.id);
    const now = new Date().toISOString();
    const by = currentUser?.name || "user";
    try {
      await addDoc(collection(db, "menus"), {
        ...SEED_UNISEX,
        branches: unisexBranches,
        pdf_name: "HULIMAUV UNISEX MENU (3).pdf",
        pdf_data: null,
        created_at: now, created_by: by, updated_at: now, updated_by: by,
      });
      await addDoc(collection(db, "menus"), {
        ...SEED_MENS,
        branches: [],
        pdf_name: "V-CUT (8).pdf",
        pdf_data: null,
        created_at: now, created_by: by, updated_at: now, updated_by: by,
      });
      toast({
        title: "Menus Seeded",
        message: `Unisex menu tagged to ${unisexBranches.length} branch(es). Mens menu is untagged — open it and pick branches.`,
        type: "success",
      });
    } catch (err) {
      confirm({ title: "Seed Failed", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    }
  };

  const saveMenu = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!editing) return;
    const name = (editing.name || "").trim();
    if (!name) { confirm({ title: "Name Required", message: "Please enter a menu name.", confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {} }); return; }

    // Conflict check: if any selected branch is already tagged to another menu of the same type,
    // ask the user which menu should own that branch before saving.
    const conflicts = []; // [{ branchId, branchName, existingMenu }]
    (editing.branches || []).forEach(bid => {
      const existing = menus.find(m =>
        m.id !== editing.id &&
        (m.type || "unisex") === editing.type &&
        (m.branches || []).includes(bid)
      );
      if (existing) {
        conflicts.push({
          branchId: bid,
          branchName: branchMap.get(bid)?.name || bid,
          existingMenu: existing,
        });
      }
    });

    if (conflicts.length > 0) {
      const lines = conflicts.map(c => `• <strong>${c.branchName}</strong> is already tagged to <em>${c.existingMenu.name}</em>`).join("<br/>");
      confirm({
        title: "Branch Already Tagged",
        message: `The following ${editing.type === "mens" ? "Mens" : "Unisex"} branch(es) are already tagged to another menu:<br/><br/>${lines}<br/><br/>Do you want to <strong>move</strong> them to "${name}"? This will remove them from the other menu(s).`,
        confirmText: `Move to "${name}"`,
        cancelText: "Keep existing",
        type: "warning",
        onConfirm: async () => {
          // Remove conflict branches from their existing menus
          const byMenu = new Map();
          conflicts.forEach(c => {
            const list = byMenu.get(c.existingMenu.id) || [];
            list.push(c.branchId);
            byMenu.set(c.existingMenu.id, list);
          });
          try {
            for (const [menuId, bids] of byMenu.entries()) {
              const m = menus.find(x => x.id === menuId);
              const remaining = (m?.branches || []).filter(b => !bids.includes(b));
              await updateDoc(doc(db, "menus", menuId), { branches: remaining, updated_at: new Date().toISOString(), updated_by: currentUser?.name || "user" });
            }
            await persistMenu();
          } catch (err) {
            confirm({ title: "Save Failed", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
          }
        },
      });
      return;
    }

    await persistMenu();
  };

  const persistMenu = async () => {
    const name = editing.name.trim();
    const payload = {
      name,
      type: editing.type,
      branches: editing.branches,
      groups: (editing.groups || []).map(g => ({
        name: g.name.trim() || "Untitled Group",
        items: (g.items || []).map(it => ({
          name: (it.name || "").trim(),
          price: Number(it.price) || 0,
          time: (it.time || "").trim() || null,
          icon: (it.icon || "").trim() || null,
        })).filter(it => it.name),
      })),
      pdf_name: editing.pdf_name || null,
      pdf_url: editing.pdf_url || null,
      pdf_path: editing.pdf_path || null,
      pdf_data: editing.pdf_data || null,
      updated_at: new Date().toISOString(),
      updated_by: currentUser?.name || "user",
    };
    try {
      if (editing.id) {
        await updateDoc(doc(db, "menus", editing.id), payload);
        toast({ title: "Menu Updated", message: `${name} saved.`, type: "success" });
      } else {
        payload.created_at = new Date().toISOString();
        payload.created_by = currentUser?.name || "user";
        await addDoc(collection(db, "menus"), payload);
        toast({ title: "Menu Created", message: `${name} added.`, type: "success" });
      }
      setEditing(null);
    } catch (err) {
      confirm({ title: "Save Failed", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
    }
  };

  const handleDelete = (m) => {
    confirm({
      title: "Delete Menu",
      message: `Delete <strong>${m.name}</strong>? Tagged branches will lose this menu.`,
      confirmText: "Yes, Delete",
      cancelText: "Cancel",
      type: "danger",
      onConfirm: async () => {
        try {
          await deleteDoc(doc(db, "menus", m.id));
          toast({ title: "Deleted", message: `${m.name} removed.`, type: "success" });
        } catch (err) {
          confirm({ title: "Error", message: err.message, confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {} });
        }
      },
    });
  };

  // PDF upload: stores the file in Firebase Storage (menus/<timestamp>-<name>) and keeps
  // only the download URL in the Firestore doc. Handles PDFs of any reasonable size.
  const handlePdfUpload = async (file) => {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      confirm({
        title: "PDF Too Large",
        message: `This PDF is ${(file.size / 1024 / 1024).toFixed(1)} MB. Please keep menu PDFs under 20 MB.`,
        confirmText: "OK", cancelText: "Close", type: "warning", onConfirm: () => {},
      });
      return;
    }
    setUploadingPdf(true);
    try {
      const safeName = file.name.replace(/[^\w.\-]+/g, "_");
      const path = `menus/${Date.now()}-${safeName}`;
      const ref = storageRef(storage, path);
      const snap = await uploadBytes(ref, file, { contentType: file.type || "application/pdf" });
      const url = await getDownloadURL(snap.ref);
      setEditing(e => ({ ...e, pdf_name: file.name, pdf_url: url, pdf_path: path, pdf_data: "" }));
      toast({ title: "PDF Uploaded", message: `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB) attached.`, type: "success" });
    } catch (err) {
      confirm({
        title: "Upload Failed",
        message: `${err.message}<br/><br/>If this is a Storage permissions error, update your Firebase Storage rules to allow authenticated writes to <code>menus/</code>.`,
        confirmText: "OK", cancelText: "Close", type: "danger", onConfirm: () => {},
      });
    } finally {
      setUploadingPdf(false);
    }
  };

  if (loading) return <div style={{ textAlign: "center", color: "var(--gold)", padding: 40, fontWeight: 700 }}>Loading menus...</div>;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div className="page-title" style={{ fontSize: 24, fontWeight: 800, color: "var(--gold)", letterSpacing: 1 }}>Menu Configuration</div>
          <div style={{ fontSize: 12, color: "var(--text3)", marginTop: 4 }}>Define digital menus and tag them to branches. POS auto-loads the menu for the selected branch.</div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {canEdit && (
            <button onClick={seedFromPdf}
              style={{ padding: "10px 16px", fontSize: 12, borderRadius: 10, background: "var(--bg4)", color: "var(--accent)", border: "1px solid var(--accent)", cursor: "pointer", fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}
              title="Create V-Cut Unisex + Mens menus from the uploaded PDFs">
              📄 Seed V-Cut PDF Menus
            </button>
          )}
          {canEdit && (
            <button onClick={() => setEditing(emptyMenu())}
              style={{ padding: "10px 18px", fontSize: 13, borderRadius: 10, background: "var(--accent)", color: "#000", border: "none", cursor: "pointer", fontWeight: 800, display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name="plus" size={14} /> New Menu
            </button>
          )}
        </div>
      </div>

      {/* Menu cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
        {menus.map(m => {
          const totalItems = (m.groups || []).reduce((s, g) => s + (g.items || []).length, 0);
          return (
            <Card key={m.id}>
              <div style={{ padding: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 800, color: "var(--text)" }}>{m.name}</div>
                    <div style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <Pill label={m.type === "mens" ? "Mens" : "Unisex"} color={m.type === "mens" ? "blue" : "purple"} />
                      <Pill label={`${totalItems} items`} color="accent" />
                      {m.pdf_name && <Pill label="PDF" color="gold" />}
                    </div>
                  </div>
                  {canEdit && (
                    <div style={{ display: "flex", gap: 4 }}>
                      <IconBtn name="edit" variant="secondary" title="Edit" onClick={() => setEditing({ ...m, branches: m.branches || [], groups: m.groups || [] })} />
                      {isAdminUser && <IconBtn name="del" variant="danger" title="Delete" onClick={() => handleDelete(m)} />}
                    </div>
                  )}
                </div>
                <div style={{ marginTop: 10, fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>Tagged Branches</div>
                <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {(m.branches || []).length === 0 && <span style={{ fontSize: 11, color: "var(--red)" }}>None — not visible in POS</span>}
                  {(m.branches || []).map(bid => (
                    <span key={bid} style={{ padding: "3px 10px", borderRadius: 999, background: "var(--bg4)", border: "1px solid var(--border2)", fontSize: 10, fontWeight: 700, color: "var(--text2)" }}>
                      {branchMap.get(bid)?.name || bid}
                    </span>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
                  <button onClick={() => setPrintMenu(m)}
                    style={{ flex: "1 1 110px", padding: "8px", borderRadius: 8, background: "var(--bg3)", border: "1px solid var(--accent)", color: "var(--accent)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                    👁 Preview
                  </button>
                  <button onClick={() => { setPrintMenu(m); setTimeout(() => window.print(), 350); }}
                    style={{ flex: "1 1 110px", padding: "8px", borderRadius: 8, background: "linear-gradient(135deg, var(--accent), var(--gold2))", border: "none", color: "#000", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                    ⬇ Download PDF
                  </button>
                  {m.pdf_name && (m.pdf_url || m.pdf_data) && (
                    <button onClick={() => setPdfPreview({ name: m.pdf_name, url: m.pdf_url || m.pdf_data })}
                      style={{ flex: "1 1 110px", padding: "8px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text2)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                      📄 Source
                    </button>
                  )}
                </div>
              </div>
            </Card>
          );
        })}
        {menus.length === 0 && (
          <div style={{ gridColumn: "1 / -1", padding: 30, textAlign: "center", color: "var(--text3)", fontSize: 13, background: "var(--bg3)", border: "1px dashed var(--border2)", borderRadius: 12 }}>
            No menus yet. Click <strong>New Menu</strong> to create one — you can upload a PDF for reference and digitize the items.
          </div>
        )}
      </div>

      {/* PDF Preview modal */}
      <Modal isOpen={!!pdfPreview} onClose={() => setPdfPreview(null)} title={pdfPreview?.name || "PDF"} width={900}>
        {pdfPreview && <iframe src={pdfPreview.url} style={{ width: "100%", height: "70vh", border: "none", borderRadius: 10 }} />}
      </Modal>

      {/* Edit / Create Modal */}
      <Modal isOpen={!!editing} onClose={() => setEditing(null)} title={editing?.id ? "Edit Menu" : "New Menu"} width={820}>
        {editing && (
          <form onSubmit={saveMenu} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Sticky Save bar — always visible while editing, even after scrolling through groups */}
            <div style={{
              position: "sticky", top: -1, zIndex: 5,
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
              padding: "10px 12px", borderRadius: 10,
              background: "var(--bg2)", border: "1px solid var(--accent)",
              boxShadow: "0 4px 16px rgba(0,0,0,0.25)", marginBottom: 2,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", letterSpacing: 1, textTransform: "uppercase" }}>
                {editing.id ? "Editing " : "Creating "}<span style={{ color: "var(--accent)" }}>{editing.name || "(untitled)"}</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" onClick={() => setEditing(null)}
                  style={{ padding: "8px 14px", borderRadius: 8, background: "var(--bg3)", color: "var(--text2)", border: "1px solid var(--border)", cursor: "pointer", fontWeight: 600, fontSize: 12 }}>Cancel</button>
                <button type="submit"
                  style={{ padding: "8px 18px", borderRadius: 8, background: "var(--accent)", color: "#000", border: "none", fontWeight: 800, cursor: "pointer", fontSize: 12, letterSpacing: 0.5 }}>
                  💾 Save
                </button>
              </div>
            </div>

            {/* Basic info */}
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
              <Field label="Menu Name *">
                <input required value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="e.g. V-Cut DLF · Unisex" />
              </Field>
              <Field label="Type">
                <select value={editing.type} onChange={e => {
                  const newType = e.target.value;
                  const keep = (editing.branches || []).filter(bid => {
                    const b = branches.find(x => x.id === bid);
                    return b && (b.type || "mens") === newType;
                  });
                  setEditing({ ...editing, type: newType, branches: keep });
                }}>
                  <option value="unisex">Unisex</option>
                  <option value="mens">Mens</option>
                </select>
              </Field>
            </div>

            {/* Branches multi-select — filtered by menu type so a Unisex menu only lists unisex branches */}
            {(() => {
              const matching = branches.filter(b => (b.type || "mens") === editing.type);
              const mismatched = branches.filter(b => (b.type || "mens") !== editing.type);
              return (
                <div>
                  <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 8 }}>
                    Tag to Branches <span style={{ color: "var(--text3)", fontWeight: 500, letterSpacing: 0 }}>— showing {editing.type === "mens" ? "Mens" : "Unisex"} branches only</span>
                  </label>
                  {matching.length === 0 ? (
                    <div style={{ padding: 12, background: "rgba(251,146,60,0.08)", border: "1px solid rgba(251,146,60,0.3)", borderRadius: 8, fontSize: 12, color: "var(--orange, #fb923c)" }}>
                      No {editing.type === "mens" ? "mens" : "unisex"} branches found. Open <strong>Branch Details</strong> and set the branch <strong>type</strong> to <code>{editing.type}</code>.
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {matching.map(b => {
                        const active = (editing.branches || []).includes(b.id);
                        return (
                          <button key={b.id} type="button"
                            onClick={() => setEditing({
                              ...editing,
                              branches: active
                                ? editing.branches.filter(x => x !== b.id)
                                : [...(editing.branches || []), b.id]
                            })}
                            style={{
                              padding: "8px 14px", borderRadius: 999, border: active ? "1px solid var(--accent)" : "1px solid var(--border2)",
                              background: active ? "rgba(34,211,238,0.12)" : "var(--bg3)", color: active ? "var(--accent)" : "var(--text2)",
                              fontSize: 12, fontWeight: 700, cursor: "pointer"
                            }}>
                            {active ? "✓ " : ""}{b.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {mismatched.length > 0 && (
                    <div style={{ marginTop: 8, fontSize: 11, color: "var(--text3)" }}>
                      Hidden ({mismatched.length}): {mismatched.map(b => b.name).join(", ")} — different type.
                    </div>
                  )}
                </div>
              );
            })()}

            {/* PDF upload */}
            <div>
              <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, display: "block", marginBottom: 8 }}>Source PDF (optional)</label>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <label style={{ padding: "10px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px dashed var(--border2)", cursor: uploadingPdf ? "wait" : "pointer", fontSize: 12, fontWeight: 700, color: "var(--text2)", opacity: uploadingPdf ? 0.6 : 1 }}>
                  {uploadingPdf ? "⏳ Uploading…" : `📄 ${editing.pdf_name ? "Replace PDF" : "Browse PDF..."}`}
                  <input type="file" accept="application/pdf" style={{ display: "none" }} disabled={uploadingPdf}
                    onChange={e => handlePdfUpload(e.target.files?.[0])} />
                </label>
                {editing.pdf_name && !uploadingPdf && (
                  <>
                    <span style={{ fontSize: 12, color: "var(--accent)", fontWeight: 700 }}>{editing.pdf_name}</span>
                    {(editing.pdf_url || editing.pdf_data) && (
                      <button type="button" onClick={() => setPdfPreview({ name: editing.pdf_name, url: editing.pdf_url || editing.pdf_data })}
                        style={{ padding: "8px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--accent)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                        Preview
                      </button>
                    )}
                    <button type="button" onClick={() => setEditing({ ...editing, pdf_name: "", pdf_url: "", pdf_path: "", pdf_data: "" })}
                      style={{ padding: "8px 12px", borderRadius: 8, background: "transparent", border: "1px solid var(--red)", color: "var(--red)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                      Remove
                    </button>
                  </>
                )}
              </div>
              <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 6 }}>
                PDFs up to 20 MB are uploaded to Firebase Storage and viewable from the menu card.
              </div>
            </div>

            {/* Groups + Items editor */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Groups &amp; Items</label>
                <button type="button"
                  onClick={() => {
                    const newGroups = [...(editing.groups || []), { name: "New Group", items: [] }];
                    setEditing({ ...editing, groups: newGroups });
                    toast({ title: "Group Added", message: "Scrolled to the new group — rename and add items.", type: "success" });
                    requestAnimationFrame(() => {
                      const target = document.querySelector(`[data-group-index="${newGroups.length - 1}"]`);
                      target?.scrollIntoView({ behavior: "smooth", block: "center" });
                      target?.querySelector("input")?.focus();
                    });
                  }}
                  style={{ padding: "6px 12px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--accent)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                  + Add Group
                </button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {(editing.groups || []).map((g, gi) => (
                  <div key={gi} data-group-index={gi} style={{ background: "var(--bg3)", border: "1px solid var(--border)", borderRadius: 12, padding: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                      <input value={g.name} onChange={e => {
                        const gs = [...editing.groups]; gs[gi] = { ...g, name: e.target.value }; setEditing({ ...editing, groups: gs });
                      }} placeholder="Group name"
                        style={{ flex: 1, padding: "8px 10px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--gold)", fontSize: 13, fontWeight: 800, outline: "none" }} />
                      <button type="button" onClick={() => {
                        const gs = [...editing.groups];
                        const newItems = [...(g.items || []), { name: "", price: "", time: "", icon: "" }];
                        gs[gi] = { ...g, items: newItems };
                        setEditing({ ...editing, groups: gs });
                        toast({ title: "Item Added", message: `Added a new row to "${g.name || "group"}". Fill in the name and price.`, type: "success" });
                        const targetIndex = newItems.length - 1;
                        requestAnimationFrame(() => {
                          const target = document.querySelector(`[data-group-index="${gi}"] [data-item-index="${targetIndex}"]`);
                          target?.scrollIntoView({ behavior: "smooth", block: "center" });
                          const inputs = target?.querySelectorAll("input");
                          if (inputs && inputs.length > 1) inputs[1].focus(); // focus the "Service name" input
                        });
                      }} style={{ padding: "6px 10px", borderRadius: 8, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--accent)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>+ Item</button>
                      <button type="button" onClick={() => {
                        if (!confirm_group_delete_ok(g.name)) return;
                        setEditing({ ...editing, groups: editing.groups.filter((_, i) => i !== gi) });
                      }} style={{ padding: "6px 10px", borderRadius: 8, background: "transparent", border: "1px solid var(--red)", color: "var(--red)", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Delete</button>
                    </div>
                    {(g.items || []).length === 0 ? (
                      <div style={{ fontSize: 11, color: "var(--text3)", padding: "10px 0" }}>No items yet — click <strong>+ Item</strong></div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {(g.items || []).map((it, ii) => (
                          <div key={ii} data-item-index={ii} style={{ display: "grid", gridTemplateColumns: "60px 2fr 1fr 1fr auto", gap: 6, alignItems: "center" }}>
                            <input value={it.icon || ""} onChange={e => {
                              const gs = [...editing.groups]; gs[gi] = { ...g, items: g.items.map((x, j) => j === ii ? { ...x, icon: e.target.value } : x) }; setEditing({ ...editing, groups: gs });
                            }} placeholder="✂️" style={{ padding: "8px", borderRadius: 6, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 14, textAlign: "center", outline: "none" }} />
                            <input value={it.name || ""} onChange={e => {
                              const gs = [...editing.groups]; gs[gi] = { ...g, items: g.items.map((x, j) => j === ii ? { ...x, name: e.target.value } : x) }; setEditing({ ...editing, groups: gs });
                            }} placeholder="Service name" style={{ padding: "8px 10px", borderRadius: 6, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 12, outline: "none" }} />
                            <input type="number" value={it.price || ""} onChange={e => {
                              const gs = [...editing.groups]; gs[gi] = { ...g, items: g.items.map((x, j) => j === ii ? { ...x, price: e.target.value } : x) }; setEditing({ ...editing, groups: gs });
                            }} placeholder="Price ₹" style={{ padding: "8px 10px", borderRadius: 6, background: "var(--bg4)", border: "1px solid var(--green)", color: "var(--green)", fontSize: 12, fontWeight: 700, outline: "none" }} />
                            <input value={it.time || ""} onChange={e => {
                              const gs = [...editing.groups]; gs[gi] = { ...g, items: g.items.map((x, j) => j === ii ? { ...x, time: e.target.value } : x) }; setEditing({ ...editing, groups: gs });
                            }} placeholder="45m" style={{ padding: "8px 10px", borderRadius: 6, background: "var(--bg4)", border: "1px solid var(--border2)", color: "var(--text3)", fontSize: 12, outline: "none" }} />
                            <button type="button" onClick={() => {
                              const gs = [...editing.groups]; gs[gi] = { ...g, items: g.items.filter((_, j) => j !== ii) }; setEditing({ ...editing, groups: gs });
                            }} title="Remove item" style={{ padding: "6px 8px", borderRadius: 6, background: "transparent", border: "1px solid var(--red)", color: "var(--red)", cursor: "pointer" }}>✕</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
              <button type="submit" style={{ flex: 1, padding: "12px", borderRadius: 10, background: "var(--accent)", color: "#000", border: "none", fontWeight: 800, cursor: "pointer" }}>
                {editing.id ? "Update" : "Create"} Menu
              </button>
              <button type="button" onClick={() => setEditing(null)}
                style={{ padding: "12px 20px", borderRadius: 10, background: "var(--bg3)", color: "var(--text2)", border: "1px solid var(--border)", cursor: "pointer", fontWeight: 600 }}>Cancel</button>
            </div>
          </form>
        )}
      </Modal>

      {/* Printable Menu */}
      {printMenu && (
        <div className="menu-print-overlay" onClick={() => setPrintMenu(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.9)", zIndex: 9999, overflow: "auto", padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ maxWidth: 820, margin: "0 auto", display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Action buttons — hidden in print */}
            <div className="no-print" style={{ display: "flex", gap: 10, justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ color: "var(--text2)", fontSize: 13, fontWeight: 700 }}>Preview: {printMenu.name}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setPrintMenu(null)}
                  style={{ padding: "10px 16px", borderRadius: 8, background: "var(--bg3)", color: "var(--text)", border: "1px solid var(--border)", cursor: "pointer", fontWeight: 700 }}>Close</button>
                <button onClick={() => window.print()}
                  style={{ padding: "10px 18px", borderRadius: 8, background: "linear-gradient(135deg, var(--accent), var(--gold2))", color: "#000", border: "none", cursor: "pointer", fontWeight: 900, letterSpacing: 0.5 }}>
                  🖨 Print / Save as PDF
                </button>
              </div>
            </div>

            {/* The printable menu — styled to match the V-Cut PDF aesthetic */}
            <div id="menu-print"
              style={{ background: "#0a0a0a", color: "#f5f5f5", borderRadius: 4, padding: "40px 36px", position: "relative", overflow: "hidden", fontFamily: '"Aptos", "Aptos Display", "Aptos Narrow", "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, "Inter", sans-serif' }}>
              {/* Decorative gold hexagons + lines — matches the V-Cut PDF aesthetic */}
              <GoldDecor />
              {/* Corner dark-red V accent arcs (bottom of page) */}
              <div aria-hidden="true" style={{ position: "absolute", bottom: -40, left: -30, width: 200, height: 120, background: "radial-gradient(ellipse at top, #5a1010 0%, transparent 70%)", pointerEvents: "none" }} />
              <div aria-hidden="true" style={{ position: "absolute", bottom: -40, right: -30, width: 200, height: 120, background: "radial-gradient(ellipse at top, #5a1010 0%, transparent 70%)", pointerEvents: "none" }} />

              {/* Big V watermark — the signature of the PDF */}
              <div aria-hidden="true" style={{
                position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
                pointerEvents: "none", fontFamily: '"Aptos Display", "Aptos", "Segoe UI", Georgia, serif',
                fontSize: 520, fontWeight: 900, color: "#7a1818", letterSpacing: -10, userSelect: "none", lineHeight: 1, opacity: 0.5,
              }}>V</div>

              {/* Header */}
              <div style={{ position: "relative", textAlign: "center", paddingBottom: 16, marginBottom: 22 }}>
                <div style={{ fontSize: 52, fontWeight: 900, letterSpacing: 3, lineHeight: 1, fontFamily: '"Aptos Display", "Aptos", "Segoe UI", Georgia, serif' }}>
                  <span style={{ color: "#dc2626" }}>V</span><span style={{ color: "#f5f5f5" }}>-CUT</span>
                </div>
                <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: 8, color: "#d4af37", marginTop: 8 }}>
                  {printMenu.type === "mens" ? "MENS SALON" : "UNISEX SALON"}
                </div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#aaa", marginTop: 4, letterSpacing: 2 }}>
                  {printMenu.name}
                </div>
              </div>

              {/* Groups in 2-column dense layout; each group renders as either simple list or variant table */}
              <div style={{ position: "relative", columnCount: 2, columnGap: 32 }}>
                {(printMenu.groups || []).map((g, gi) => {
                  const grid = buildVariantGrid(g.items);
                  return (
                    <div key={gi} style={{ breakInside: "avoid", marginBottom: 20, pageBreakInside: "avoid" }}>
                      {/* Group title — styled like PDF's gold underlined headers */}
                      <div style={{
                        fontSize: 18, fontWeight: 900, color: "#d4af37", letterSpacing: 3, textTransform: "uppercase",
                        paddingBottom: 2, marginBottom: 10, display: "inline-block",
                        borderBottom: "2px solid #d4af37", fontFamily: '"Aptos Display", "Aptos", "Segoe UI", Georgia, serif'
                      }}>
                        {g.name}
                      </div>

                      {grid.multi ? (
                        <div>
                          {/* Column headers — SERVICE + each variant in gold */}
                          <div style={{
                            display: "grid", gridTemplateColumns: `1.4fr repeat(${grid.variants.length}, 1fr)`,
                            gap: 6, fontSize: 10, fontWeight: 800, color: "#d4af37", letterSpacing: 1.5,
                            paddingBottom: 4, borderBottom: "1px solid #555", marginBottom: 4, textTransform: "uppercase",
                          }}>
                            <div>Service</div>
                            {grid.variants.map((v, vi) => (
                              <div key={vi} style={{ textAlign: "right" }}>{v}</div>
                            ))}
                          </div>
                          {grid.bases.map((b, bi) => (
                            <div key={bi} style={{
                              display: "grid", gridTemplateColumns: `1.4fr repeat(${grid.variants.length}, 1fr)`,
                              gap: 6, fontSize: 10.5, padding: "3px 0",
                            }}>
                              <div style={{ color: "#f5f5f5", fontWeight: 600 }}>• {b.base}</div>
                              {grid.variants.map((v, vi) => (
                                <div key={vi} style={{ textAlign: "right", color: b.byVariant[v] != null ? "#f5f5f5" : "#555", fontWeight: 700 }}>
                                  {b.byVariant[v] != null ? `${b.byVariant[v]}/-` : "—"}
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {(g.items || []).map((it, ii) => (
                            <div key={ii} style={{ display: "flex", alignItems: "baseline", fontSize: 11, gap: 4 }}>
                              <span style={{ color: "#f5f5f5", fontWeight: 600 }}>• {it.name}</span>
                              <span style={{ flex: 1, borderBottom: "1px dotted #555", minWidth: 10, margin: "0 4px", transform: "translateY(-2px)" }} />
                              <span style={{ color: "#f5f5f5", fontWeight: 700, whiteSpace: "nowrap" }}>{it.price}/-</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Bottom watermark band — SALON SALON-style like the PDF */}
              <div aria-hidden="true" style={{
                position: "absolute", bottom: 30, left: 0, right: 0, textAlign: "center",
                fontSize: 72, fontWeight: 900, color: "#7a1818", letterSpacing: 10, opacity: 0.25,
                fontFamily: '"Aptos Display", "Aptos", "Segoe UI", Georgia, serif', pointerEvents: "none", userSelect: "none", lineHeight: 1,
              }}>
                {printMenu.type === "mens" ? "MENS·SALON" : "UNISEX·SALON"}
              </div>

              {/* Branches footer */}
              {(printMenu.branches || []).length > 0 && (
                <div style={{ position: "relative", marginTop: 28, paddingTop: 16, borderTop: "1px solid #8a6d3b", textAlign: "center" }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: "#d4af37", letterSpacing: 3, textTransform: "uppercase", marginBottom: 6 }}>Available At</div>
                  <div style={{ fontSize: 11, color: "#f5f5f5", display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "4px 16px" }}>
                    {printMenu.branches.map(bid => {
                      const b = branchMap.get(bid);
                      if (!b) return null;
                      return (
                        <span key={bid} style={{ fontWeight: 700 }}>
                          {b.name}{b.location ? <span style={{ color: "#aaa", fontWeight: 500 }}> · {b.location}</span> : null}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Thanks line */}
              <div style={{ position: "relative", textAlign: "center", marginTop: 14 }}>
                <div style={{ fontSize: 10, color: "#aaa", letterSpacing: 2 }}>V-GROUP · CONSISTENCY IS KEY</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}

// Golden hexagon + line decoration overlay — rendered behind menu content to match the PDF
function GoldDecor() {
  const Hex = ({ size, x, y, op = 1, filled = true, rot = 0 }) => (
    <svg viewBox="0 0 100 100" style={{ position: "absolute", left: x, top: y, width: size, height: size, opacity: op, transform: `rotate(${rot}deg)`, pointerEvents: "none" }}>
      <polygon points="50,2 95,27 95,77 50,98 5,77 5,27"
        fill={filled ? "#d4af37" : "none"} stroke="#d4af37" strokeWidth={filled ? 0 : 6} />
    </svg>
  );
  const Dot = ({ size, x, y, op = 1, color = "#d4af37" }) => (
    <div aria-hidden="true" style={{ position: "absolute", left: x, top: y, width: size, height: size, background: color, opacity: op, borderRadius: "50%", pointerEvents: "none" }} />
  );
  // Thin gold lines (shooting-star-ish)
  const Line = ({ x, y, length = 80, rot = -20, op = 0.5 }) => (
    <div aria-hidden="true" style={{ position: "absolute", left: x, top: y, width: length, height: 2, background: "linear-gradient(90deg, transparent, #d4af37, transparent)", transform: `rotate(${rot}deg)`, opacity: op, pointerEvents: "none" }} />
  );
  return (
    <>
      {/* Top cluster */}
      <Hex size={28} x={24}  y={18}  op={0.9} />
      <Hex size={14} x={70}  y={34}  op={0.7} />
      <Hex size={36} x={140} y={8}   op={0.55} />
      <Hex size={18} x={200} y={48}  op={0.8} />
      <Dot size={6}  x={52}  y={56}  op={0.7} />
      <Dot size={4}  x={96}  y={14}  op={0.6} />
      <Dot size={5}  x={178} y={22}  op={0.55} />

      {/* Top-right cluster */}
      <Hex size={22} x="78%" y={24}  op={0.8} />
      <Hex size={12} x="88%" y={56}  op={0.7} />
      <Hex size={32} x="72%" y={60}  op={0.6} filled={false} />
      <Dot size={5}  x="66%" y={32}  op={0.6} />
      <Dot size={7}  x="92%" y={14}  op={0.8} />
      <Line x="60%" y={10}  length={90} rot={18} op={0.55} />
      <Line x="64%" y={28}  length={120} rot={12} op={0.45} />

      {/* Middle subtle */}
      <Hex size={10} x={40}  y="40%" op={0.45} />
      <Hex size={14} x="94%" y="38%" op={0.5} />
      <Dot size={4}  x={18}  y="58%" op={0.4} />
      <Dot size={5}  x="86%" y="52%" op={0.45} />

      {/* Bottom cluster */}
      <Hex size={30} x={32}  y="80%" op={0.7} />
      <Hex size={16} x={84}  y="86%" op={0.75} />
      <Hex size={22} x="80%" y="78%" op={0.7} />
      <Hex size={12} x="62%" y="90%" op={0.6} />
      <Dot size={6}  x={170} y="88%" op={0.6} />
      <Dot size={5}  x="54%" y="82%" op={0.5} />
      <Line x={8}   y="78%" length={110} rot={-15} op={0.45} />
    </>
  );
}

// Rebuild variant tables from flattened items.
// e.g. "Basic Hair Cut · Ladies" + "Basic Hair Cut · Gents" collapse into one row with two columns.
function buildVariantGrid(items) {
  const byBase = new Map();
  const order = [];
  (items || []).forEach(it => {
    const parts = (it.name || "").split(" · ");
    const base = parts[0].trim();
    const variant = parts.slice(1).join(" · ").trim(); // allow multi-level variants
    if (!byBase.has(base)) { byBase.set(base, { base, icon: it.icon, rows: [] }); order.push(base); }
    byBase.get(base).rows.push({ variant: variant || null, price: it.price });
  });

  // Collect all unique variants in group order
  const variantSet = [];
  byBase.forEach(g => {
    g.rows.forEach(r => {
      if (r.variant && !variantSet.includes(r.variant)) variantSet.push(r.variant);
    });
  });

  const multi = variantSet.length > 0 && order.some(b => byBase.get(b).rows.some(r => r.variant));

  return {
    multi,
    variants: variantSet,
    bases: order.map(b => {
      const g = byBase.get(b);
      // Create price lookup per variant; null variants go to "default"
      const byVariant = {};
      g.rows.forEach(r => { byVariant[r.variant || "_"] = r.price; });
      return { base: b, icon: g.icon, byVariant, rows: g.rows };
    }),
  };
}

function confirm_group_delete_ok(name) {
  if (typeof window === "undefined") return true;
  return window.confirm(`Delete group "${name}" and all its items?`);
}

function Field({ label, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={{ fontSize: 11, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>{label}</label>
      <div style={{ display: "contents" }}>
        {children && (() => {
          const baseStyle = { padding: "12px 14px", borderRadius: 10, background: "var(--bg3)", border: "1px solid var(--border2)", color: "var(--text)", fontSize: 14, outline: "none", fontFamily: "inherit", width: "100%", boxSizing: "border-box" };
          return { ...children, props: { ...children.props, style: { ...baseStyle, ...(children.props.style || {}) } } };
        })()}
      </div>
    </div>
  );
}
