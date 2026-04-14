import { initializeApp, getApps, getApp } from "firebase/app";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  getFirestore,
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
// Snapshots resolve instantly from cache, then sync in the background.
let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
} catch {
  // Already initialized (hot reload) or unsupported environment — fall back.
  db = getFirestore(app);
}

const storage = getStorage(app);

export { app, db, storage };
