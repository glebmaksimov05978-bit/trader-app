// src/services/firebase.js
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { initializeFirestore } from 'firebase/firestore';

// Replace with your Firebase project config
const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// ignoreUndefinedProperties: поле со значением undefined просто не записывается. Без этого любое
// необязательное поле, оставшееся undefined (например stopIsSizingOnly у сделки без стопа),
// роняло сохранение целиком: «Function addDoc() called with invalid data. Unsupported field value:
// undefined» (реальная жалоба при «В журнал» из Калькулятора).
export const db = initializeFirestore(app, { ignoreUndefinedProperties: true });
export default app;
