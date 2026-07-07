// src/context/AuthContext.js
import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  sendEmailVerification,
  updateEmail,
  GoogleAuthProvider,
  signInWithPopup,
} from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '../services/firebase';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        setUser(firebaseUser);
        const profileDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
        if (profileDoc.exists()) {
          const data = profileDoc.data();
          if (!data.role) {
            await setDoc(doc(db, 'users', firebaseUser.uid), { role: 'free' }, { merge: true });
            data.role = 'free';
          }
          setUserProfile(data);
        } else {
          const defaultProfile = {
            uid: firebaseUser.uid,
            email: firebaseUser.email,
            displayName: firebaseUser.displayName || firebaseUser.email.split('@')[0],
            role: 'free',
            tinkoffToken: '',
            depositSize: 0,
            dailyLossLimit: 3,
            maxRiskPerTrade: 1,
            createdAt: serverTimestamp(),
          };
          await setDoc(doc(db, 'users', firebaseUser.uid), defaultProfile);
          setUserProfile(defaultProfile);
        }
      } else {
        setUser(null);
        setUserProfile(null);
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const login = async (email, password) => {
    return signInWithEmailAndPassword(auth, email, password);
  };

  // Вход через Google — создаёт профиль в Firestore если это первый вход
  const loginWithGoogle = async () => {
    const provider = new GoogleAuthProvider();
    const cred = await signInWithPopup(auth, provider);
    const profileDoc = await getDoc(doc(db, 'users', cred.user.uid));
    if (!profileDoc.exists()) {
      const defaultProfile = {
        uid: cred.user.uid,
        email: cred.user.email,
        displayName: cred.user.displayName || cred.user.email.split('@')[0],
        role: 'free',
        tinkoffToken: '',
        depositSize: 0,
        dailyLossLimit: 3,
        maxRiskPerTrade: 1,
        createdAt: serverTimestamp(),
      };
      await setDoc(doc(db, 'users', cred.user.uid), defaultProfile);
    }
    // Google-аккаунты уже подтверждены Google — сразу считаем почту верифицированной
    return cred;
  };

  // Публичная регистрация
  const register = async (email, password, displayName) => {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(cred.user, { displayName });
    const profile = {
      uid: cred.user.uid,
      email,
      displayName,
      role: 'free',
      tinkoffToken: '',
      depositSize: 0,
      dailyLossLimit: 3,
      maxRiskPerTrade: 1,
      createdAt: serverTimestamp(),
    };
    await setDoc(doc(db, 'users', cred.user.uid), profile);

    // Отправляем письмо с подтверждением почты сразу после регистрации
    try {
      await sendEmailVerification(cred.user);
    } catch (e) {
      // Не блокируем регистрацию если письмо не отправилось (например лимит Firebase)
      console.warn('Не удалось отправить письмо верификации:', e.message);
    }

    return cred;
  };

  // Повторная отправка письма верификации (для баннера в интерфейсе)
  const resendVerificationEmail = async () => {
    if (!auth.currentUser) throw new Error('Пользователь не авторизован');
    if (auth.currentUser.emailVerified) throw new Error('Почта уже подтверждена');
    return sendEmailVerification(auth.currentUser);
  };

  // Смена email до подтверждения — на случай если пользователь ошибся при регистрации
  const changeEmail = async (newEmail) => {
    if (!auth.currentUser) throw new Error('Пользователь не авторизован');
    await updateEmail(auth.currentUser, newEmail);
    // Обновляем профиль в Firestore
    await setDoc(doc(db, 'users', auth.currentUser.uid), { email: newEmail }, { merge: true });
    setUserProfile(prev => ({ ...prev, email: newEmail }));
    // Отправляем письмо верификации на новый адрес
    await sendEmailVerification(auth.currentUser);
    // Обновляем локальный user чтобы email в интерфейсе тоже обновился
    setUser({ ...auth.currentUser });
  };

  // Принудительно обновить статус верификации (после того как пользователь подтвердил почту в другой вкладке)
  const refreshEmailVerified = async () => {
    if (!auth.currentUser) return false;
    await auth.currentUser.reload();
    setUser({ ...auth.currentUser });
    return auth.currentUser.emailVerified;
  };

  // Сброс пароля
  const resetPassword = async (email) => {
    return sendPasswordResetEmail(auth, email);
  };

  const logout = async () => {
    await signOut(auth);
  };

  const updateUserProfile = async (data) => {
    if (!user) return;
    const ref = doc(db, 'users', user.uid);
    await setDoc(ref, data, { merge: true });
    setUserProfile((prev) => ({ ...prev, ...data }));
  };

  const isAdmin = userProfile?.role === 'admin';
  const isPro   = userProfile?.role === 'pro' || userProfile?.role === 'admin';
  const isEmailVerified = user?.emailVerified ?? false;

  return (
    <AuthContext.Provider value={{
      user, userProfile, loading,
      login, register, logout, resetPassword,
      loginWithGoogle,
      updateUserProfile, isAdmin, isPro,
      isEmailVerified, resendVerificationEmail, refreshEmailVerified,
      changeEmail,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
