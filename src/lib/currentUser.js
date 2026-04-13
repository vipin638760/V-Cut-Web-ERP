"use client";
import { useEffect, useState } from "react";

const KEY = "vcut_user";

const readUser = () => {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(KEY) || localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};

// Hook returns null on the very first render (server + client) to avoid hydration
// mismatch, then fills in with the real user after mount. Listens to cross-tab
// `storage` events so logout/login in another tab updates this one.
export function useCurrentUser() {
  const [user, setUser] = useState(null);

  useEffect(() => {
    setUser(readUser());
    const onStorage = (e) => { if (!e || e.key === KEY) setUser(readUser()); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return user;
}

// Non-hook accessor for one-off reads inside event handlers (post-hydration only).
export const getCurrentUser = () => readUser();
