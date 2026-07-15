import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

// Config-ul se ia din variabile de mediu (Vite le expune doar pe cele cu
// prefixul VITE_). Completeaza-le in fisierul .env (vezi .env.example) local,
// si ca secrete in GitHub Actions pentru build-ul de productie.
//
// NOTA: Folosim DOAR Firestore (nu si Firebase Storage), pentru ca Storage
// cere planul Blaze (cu card de credit atasat) chiar si pentru uz gratuit.
// Firestore ramane complet gratuit pe planul Spark implicit.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

// Daca lipseste cheia principala, consideram Firebase neconfigurat si lasam
// aplicatia sa functioneze normal doar local (fara sincronizare), in loc sa
// arunce erori peste tot.
export const isFirebaseConfigured = Boolean(firebaseConfig.apiKey);

export const app = isFirebaseConfigured ? initializeApp(firebaseConfig) : null;
export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;
export const googleProvider = new GoogleAuthProvider();
