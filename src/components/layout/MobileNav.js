// src/components/layout/MobileNav.js
import React, { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { TRUSTED_UIDS } from '../../constants/trustedUids';
import { NAV_ITEMS, ADMIN_ITEMS, TRUSTED_ITEMS } from '../../constants/navItems';
import './Sidebar.css';

import Icon from '../shared/Icon';
// Real user report on the FIRST version of this (bottom bar + hamburger for extras
// only): the hamburger button was fixed-position over page content and partially
// covered the "Дашборд" heading, and the drawer only ever held Бэктест — confusing,
// looked broken. Redesigned per the trader's own original ask: no bottom bar on mobile
// at all, a slim top bar with the hamburger is the only mobile chrome, and the drawer
// holds the FULL nav (not just the trusted-only extras) — Sidebar.css gives
// .main-content top padding on mobile so page content never sits under the bar.
export default function MobileNav() {
  const { user, isAdmin } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const isTrusted = isAdmin || TRUSTED_UIDS.includes(user?.uid);
  const items = [
    ...NAV_ITEMS,
    ...(isTrusted ? TRUSTED_ITEMS : []),
    ...(isAdmin ? ADMIN_ITEMS : []),
  ];

  // Свайп открывает и закрывает меню как обычная шторка: от левого края экрана вправо —
  // открыть, по открытому меню влево — закрыть. Слушаем на document, а не только на
  // шапке, — жест должен работать с любой страницы, а не только когда палец стартует
  // ровно на 36-пиксельной кнопке-гамбургере.
  //
  // reactive-state вместо ref для drawerOpen — иначе обработчики, повешенные один раз,
  // видели бы устаревшее значение из замыкания. Слушатели вешаются заново при каждом
  // открытии/закрытии — цена этого меньше, чем цена сверять открыт ли drawer через ref.
  const touchRef = useRef({ x: 0, y: 0, tracking: false });
  useEffect(() => {
    // Зона начала жеста — левая треть экрана (раньше 24 пикселя от самого края: на телефоне туда
    // почти невозможно попасть, а на iPhone край ещё и занят системным «назад»).
    const edgePx = () => Math.max(48, Math.round(window.innerWidth * 0.3));
    const THRESHOLD_PX = 56; // на сколько нужно провести пальцем, чтобы жест засчитался
    const MAX_DRIFT_PX = 50; // вертикальное отклонение больше этого — трейдер скроллит страницу, не свайпает меню

    // Жест не должен перехватывать горизонтальную прокрутку таблиц и графика: если палец начал
    // движение внутри элемента, который сам прокручивается вбок, — это не меню.
    const insideHScroll = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n.tagName === 'CANVAS' || n.hasAttribute?.('data-no-swipe')) return true;
        if (n.scrollWidth > n.clientWidth + 2) {
          const ox = window.getComputedStyle(n).overflowX;
          if (ox === 'auto' || ox === 'scroll') return true;
        }
      }
      return false;
    };

    const onStart = (e) => {
      const t = e.touches[0];
      if (!t) return;
      const canOpen = !drawerOpen && t.clientX <= edgePx() && !insideHScroll(e.target);
      const canClose = drawerOpen;
      touchRef.current = { x: t.clientX, y: t.clientY, tracking: canOpen || canClose };
    };
    const onMove = (e) => {
      const st = touchRef.current;
      if (!st.tracking) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - st.x;
      const dy = Math.abs(t.clientY - st.y);
      if (dy > MAX_DRIFT_PX || (Math.abs(dx) > 12 && dy > Math.abs(dx))) { st.tracking = false; return; }
      if (!drawerOpen && dx > THRESHOLD_PX) {
        setDrawerOpen(true);
        st.tracking = false;
      } else if (drawerOpen && dx < -THRESHOLD_PX) {
        setDrawerOpen(false);
        st.tracking = false;
      }
    };
    const onEnd = () => { touchRef.current.tracking = false; };

    // passive: true — жест только НАБЛЮДАЕТ за пальцем, ничего не блокирует. Обычный
    // вертикальный скролл страницы поверх этого продолжает работать как ни в чём не бывало.
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };
  }, [drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setDrawerOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  return (
    <>
      <div className="mobile-topbar">
        <button className="mobile-hamburger" onClick={() => setDrawerOpen(true)} aria-label="Меню"><Icon name="menu" size={20} /></button>
        <span className="mobile-topbar-title">TraderPro</span>
      </div>
      {drawerOpen && (
        <div className="mobile-drawer-overlay" onClick={() => setDrawerOpen(false)}>
          <div className="mobile-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="mobile-drawer-header">
              <span>Меню</span>
              <button className="mobile-drawer-close" onClick={() => setDrawerOpen(false)} aria-label="Закрыть меню">✕</button>
            </div>
            {items.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
                className={({ isActive }) => `mobile-drawer-item ${isActive ? 'active' : ''}`}
                onClick={() => setDrawerOpen(false)}
              >
                <span className="mobile-nav-icon">{item.icon}</span>
                <span>{item.label}</span>
              </NavLink>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
