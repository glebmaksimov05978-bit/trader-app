// src/components/onboarding/OnboardingContext.js
//
// Состояние обучающих туров: что пройдено, какой тур идёт сейчас, когда запускать сам.
//
// Правила самозапуска (чтобы не раздражать):
//  • только новым пользователям: в профиле при регистрации ставится onboarding.eligible — у старых аккаунтов
//    туры сами не появляются (их можно запустить кнопкой «Подсказки» или в Настройках);
//  • сначала общий тур, потом — при первом заходе в раздел — короткий тур по нему; каждый один раз;
//  • «Пропустить» засчитывает тур пройденным; «Больше не показывать» отключает самозапуск совсем.
// Пройденное хранится в профиле (Firestore) и дублируется в localStorage на случай сбоя записи.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { TOURS, GENERAL_ID, tourForPath } from './tours';
import TourOverlay from './TourOverlay';

const LS_PREFIX = 'tp_onboarding_v1:';

function readLocal(uid) {
  try { return JSON.parse(localStorage.getItem(LS_PREFIX + uid) || '{}') || {}; } catch { return {}; }
}
function writeLocal(uid, data) {
  try { localStorage.setItem(LS_PREFIX + uid, JSON.stringify(data)); } catch { /* приватный режим — не страшно */ }
}

const OnboardingContext = createContext(null);

// Без провайдера (например, в снимках страниц для проверки) хук возвращает «пустой» объект.
const NOOP = { active: null, start: () => {}, startForPath: () => {}, isDone: () => false, disabled: false, setDisabled: () => {}, reset: () => {} };
export const useOnboarding = () => useContext(OnboardingContext) || NOOP;

export function OnboardingProvider({ children, autoStartDelay = 1100 }) {
  const { user, userProfile, updateUserProfile } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [active, setActive] = useState(null); // { tourId, index, auto }
  const [local, setLocal] = useState({});
  const uid = user?.uid;

  useEffect(() => { if (uid) setLocal(readLocal(uid)); }, [uid]);

  const stored = userProfile?.onboarding || {};
  const doneMap = useMemo(() => ({ ...(local.done || {}), ...(stored.done || {}) }), [local.done, stored.done]);
  const disabled = stored.disabled === true || local.disabled === true;
  const eligible = stored.eligible === true;
  const isDone = useCallback((id) => !!doneMap[id], [doneMap]);

  const persist = useCallback(async (patchDone, patchDisabled) => {
    if (!uid) return;
    const nextLocal = {
      done: { ...(local.done || {}), ...(patchDone || {}) },
      disabled: patchDisabled ?? local.disabled ?? false,
    };
    setLocal(nextLocal);
    writeLocal(uid, nextLocal);
    try {
      // Пишем ВЕСЬ объект onboarding: профиль в памяти обновляется поверхностным слиянием, и записать только
      // изменённое поле значило бы потерять eligible и ранее пройденные туры до перезагрузки страницы.
      const next = { ...stored, done: { ...(stored.done || {}), ...(patchDone || {}) } };
      if (patchDisabled != null) next.disabled = patchDisabled;
      await updateUserProfile({ onboarding: next });
    } catch (e) {
      console.warn('Не удалось сохранить прогресс обучения (останется в этом браузере):', e.message);
    }
  }, [uid, local, stored, updateUserProfile]);

  const start = useCallback((tourId, opts = {}) => {
    const tour = TOURS[tourId];
    if (!tour) return;
    if (tour.route && tour.route !== location.pathname && !opts.stay) navigate(tour.route);
    setActive({ tourId, index: 0, auto: !!opts.auto });
  }, [location.pathname, navigate]);

  // Кнопка «Подсказки»: тур текущего раздела, а если для страницы его нет — общий.
  const startForPath = useCallback(() => {
    const t = tourForPath(location.pathname);
    start(t ? t.id : GENERAL_ID, { stay: true });
  }, [location.pathname, start]);

  const finish = useCallback((markDone = true) => {
    if (active && markDone) persist({ [active.tourId]: Date.now() });
    setActive(null);
  }, [active, persist]);

  const goTo = useCallback((delta) => {
    setActive((a) => {
      if (!a) return a;
      const n = TOURS[a.tourId].steps.length;
      const index = Math.min(n - 1, Math.max(0, a.index + delta));
      return { ...a, index };
    });
  }, []);

  const setDisabled = useCallback((value) => persist(null, !!value), [persist]);
  const reset = useCallback(async () => {
    // Сбросить пройденное: тур снова будет предлагаться заново (по кнопке «Пройти снова» в Настройках).
    const cleared = Object.fromEntries(Object.keys(TOURS).map((k) => [k, null]));
    await persist(cleared, false);
  }, [persist]);

  // Самозапуск: общий тур новичку, затем тур раздела при первом заходе.
  useEffect(() => {
    if (!userProfile || !uid || active || disabled || !eligible) return undefined;
    const t = setTimeout(() => {
      if (!isDone(GENERAL_ID)) { start(GENERAL_ID, { auto: true, stay: true }); return; }
      const section = tourForPath(location.pathname);
      if (section && !isDone(section.id)) start(section.id, { auto: true, stay: true });
    }, autoStartDelay);
    return () => clearTimeout(t);
  }, [userProfile, uid, active, disabled, eligible, isDone, location.pathname, start, autoStartDelay]);

  // Общий тур зовёт переход по кнопке действия.
  const act = useCallback((to) => { finish(true); if (to) navigate(to); }, [finish, navigate]);

  const value = useMemo(() => ({ active, start, startForPath, isDone, disabled, setDisabled, reset }), [active, start, startForPath, isDone, disabled, setDisabled, reset]);
  const tour = active ? TOURS[active.tourId] : null;

  return (
    <OnboardingContext.Provider value={value}>
      {children}
      {tour && (
        <TourOverlay
          key={`${active.tourId}`}
          tour={tour}
          index={active.index}
          auto={active.auto}
          onNext={() => (active.index >= tour.steps.length - 1 ? finish(true) : goTo(1))}
          onPrev={() => goTo(-1)}
          onSkip={() => finish(true)}
          onDisable={() => { persist({ [active.tourId]: Date.now() }, true); setActive(null); }}
          onAction={act}
        />
      )}
    </OnboardingContext.Provider>
  );
}

