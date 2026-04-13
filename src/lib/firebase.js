import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDmGhRW3CAIydXCKRTgrAh1xg2_t9-nhgI",
  authDomain: "v-cut-8e496.firebaseapp.com",
  projectId: "v-cut-8e496",
  storageBucket: "v-cut-8e496.firebasestorage.app",
  messagingSenderId: "279998839455",
  appId: "1:279998839455:web:fa71333bfb7ed33b4440aa"
};

// Initialize Firebase only if there are no existing initialized apps
const app = !getApps().length ? initializeApp(firebaseConfig, "vcut_primary") : getApp("vcut_primary");
const db = getFirestore(app);

export { app, db };
