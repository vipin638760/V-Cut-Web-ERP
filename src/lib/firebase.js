import { initializeApp, getApps, getApp } from "firebase/app";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  getFirestore,
  CACHE_SIZE_UNLIMITED,
} from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyDmGhRW3CAIydXCKRTgrAh1xg2_t9-nhgI",
  authDomain: "v-cut-8e496.firebaseapp.com",
  projectId: "v-cut-8e496",
  storageBucket: "v-cut-8e496.firebasestorage.app",
  messagingSenderId: "279998839455",
  appId: "1:279998839455:web:fa71333bfb7ed33b4440aa"
};

const app = !getApps().length ? initializeApp(firebaseConfig, "vcut_primary") : getApp("vcut_primary");

// Enable IndexedDB-backed cache so subsequent tab loads serve from local storage.
// Only in the browser — Node / SSR / build-time prerender has no IndexedDB and would throw.
let db;
const isBrowser = typeof window !== "undefined" && typeof indexedDB !== "undefined";
if (isBrowser) {
  try {
    db = initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
        // Default 40MB LRU-evicts the fat `entries` collection; unlimited keeps
        // the whole dataset local so dashboards open instantly from cache.
        cacheSizeBytes: CACHE_SIZE_UNLIMITED,
      }),
      // Some ISPs/proxies/antivirus break Firestore's WebChannel streaming while
      // plain HTTPS works fine (login's REST fallback proved this in the field).
      // Long-polling rides ordinary HTTPS requests, so reads work everywhere.
      experimentalForceLongPolling: true,
    });
  } catch {
    // Already initialized (hot reload) or unsupported (e.g. private mode) — fall back.
    db = getFirestore(app);
  }
} else {
  db = getFirestore(app);
}

const storage = getStorage(app);

export { app, db, storage };
