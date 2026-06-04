// src/components/common/ProModal.js
// Использование: import ProModal from '../common/ProModal';
// <ProModal onClose={() => setShowPro(false)} />

import React from 'react';
import { useAuth } from '../../context/AuthContext';

const PRO_FEATURES = [
  { icon: '🤖', title: 'AI Советник', desc: 'Анализ журнала, разбор сделок, психологический коуч' },
  { icon: '📊', title: 'Расширенная статистика', desc: 'По дням недели, времени суток, паттернам поведения' },
  { icon: '📥', title: 'Импорт из Тинькофф', desc: 'Загрузка сделок из отчёта брокера одним кликом' },
  { icon: '📄', title: 'PDF отчёты', desc: 'Еженедельный и ежемесячный отчёт на почту' },
  { icon: '🔔', title: 'Уведомления', desc: 'Превышение лимита, сигналы по вашей стратегии' },
  { icon: '♾️', title: 'Безлимит сделок', desc: 'Без ограничений на количество записей в журнале' },
];

export default function ProModal({ onClose }) {
  const { isPro } = useAuth();

  return (
    <div
      style={{
        position:'fixed', inset:0, zIndex:9000,
        background:'rgba(0,0,0,0.75)', backdropFilter:'blur(12px)',
        display:'flex', alignItems:'center', justifyContent:'center',
        padding:24, animation:'fadeInBg 0.2s ease',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background:'linear-gradient(145deg,#0f1829,#131d35)',
          border:'1px solid rgba(255,255,255,0.1)',
          borderRadius:28, padding:'40px 36px',
          width:'100%', maxWidth:480,
          position:'relative',
          boxShadow:'0 40px 100px rgba(0,0,0,0.6), 0 0 0 1px rgba(79,70,229,0.2)',
          animation:'proModalIn 0.35s cubic-bezier(0.16,1,0.3,1)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Закрыть */}
        <button onClick={onClose} style={{
          position:'absolute', top:16, right:16,
          background:'rgba(255,255,255,0.07)', border:'none', borderRadius:'50%',
          width:30, height:30, cursor:'pointer', color:'rgba(255,255,255,0.5)',
          fontSize:13, display:'flex', alignItems:'center', justifyContent:'center',
        }}>✕</button>

        {/* Заголовок */}
        <div style={{textAlign:'center', marginBottom:28}}>
          <div style={{
            display:'inline-flex', alignItems:'center', gap:8,
            background:'linear-gradient(135deg,rgba(245,158,11,0.15),rgba(251,191,36,0.1))',
            border:'1px solid rgba(245,158,11,0.3)',
            borderRadius:20, padding:'6px 16px', marginBottom:16,
          }}>
            <span style={{fontSize:14}}>⚡</span>
            <span style={{fontSize:12, fontWeight:700, color:'#fbbf24', letterSpacing:'0.5px'}}>TRADERPRO</span>
            <span style={{
              background:'linear-gradient(135deg,#f59e0b,#fbbf24)',
              color:'#000', fontSize:10, fontWeight:800,
              padding:'2px 8px', borderRadius:10, letterSpacing:'0.5px',
            }}>PRO</span>
          </div>
          <h2 style={{
            fontFamily:"'Syne',sans-serif", fontSize:28, fontWeight:800,
            color:'#f0f4ff', letterSpacing:'-0.8px', margin:'0 0 8px',
          }}>
            Повысьте до Pro
          </h2>
          <p style={{fontSize:14, color:'rgba(255,255,255,0.4)', margin:0}}>
            Разблокируйте все возможности TraderPro
          </p>
        </div>

        {/* Фичи */}
        <div style={{display:'flex', flexDirection:'column', gap:12, marginBottom:28}}>
          {PRO_FEATURES.map((f, i) => (
            <div key={i} style={{
              display:'flex', alignItems:'center', gap:14,
              padding:'10px 14px',
              background:'rgba(255,255,255,0.04)',
              borderRadius:12,
              border:'1px solid rgba(255,255,255,0.06)',
            }}>
              <span style={{fontSize:22, flexShrink:0}}>{f.icon}</span>
              <div>
                <div style={{fontSize:13, fontWeight:700, color:'#f0f4ff', marginBottom:2}}>{f.title}</div>
                <div style={{fontSize:12, color:'rgba(255,255,255,0.4)'}}>{f.desc}</div>
              </div>
              <div style={{
                marginLeft:'auto', flexShrink:0,
                width:18, height:18, borderRadius:'50%',
                background:'linear-gradient(135deg,#10b981,#059669)',
                display:'flex', alignItems:'center', justifyContent:'center',
                fontSize:10, color:'#fff',
              }}>✓</div>
            </div>
          ))}
        </div>

        {/* Цена и кнопка */}
        <div style={{
          background:'linear-gradient(135deg,rgba(79,70,229,0.1),rgba(124,58,237,0.08))',
          border:'1px solid rgba(79,70,229,0.25)',
          borderRadius:18, padding:'20px 24px', marginBottom:16, textAlign:'center',
        }}>
          <div style={{display:'flex', alignItems:'baseline', justifyContent:'center', gap:4, marginBottom:4}}>
            <span style={{fontSize:42, fontWeight:800, color:'#f0f4ff', fontFamily:"'Syne',sans-serif"}}>299</span>
            <span style={{fontSize:20, color:'rgba(255,255,255,0.6)', fontWeight:600}}>₽</span>
            <span style={{fontSize:14, color:'rgba(255,255,255,0.35)', marginLeft:4}}>/месяц</span>
          </div>
          <div style={{fontSize:12, color:'rgba(255,255,255,0.35)'}}>
            или <strong style={{color:'rgba(255,255,255,0.6)'}}>2 490 ₽</strong> / год — экономия 40%
          </div>
        </div>

        <button style={{
          width:'100%', padding:16, border:'none', borderRadius:16,
          background:'linear-gradient(135deg,#4f46e5,#7c3aed)',
          color:'#fff', fontFamily:"'DM Sans',sans-serif",
          fontSize:15, fontWeight:700, cursor:'pointer',
          boxShadow:'0 8px 24px rgba(79,70,229,0.45)',
          transition:'transform 0.2s, box-shadow 0.2s',
        }}
          onMouseEnter={e => { e.target.style.transform='translateY(-2px)'; e.target.style.boxShadow='0 12px 32px rgba(79,70,229,0.6)'; }}
          onMouseLeave={e => { e.target.style.transform=''; e.target.style.boxShadow='0 8px 24px rgba(79,70,229,0.45)'; }}
          onClick={() => {
            // TODO: подключить платёжную систему
            alert('Оплата скоро будет доступна! Напишите в поддержку для активации Pro.');
          }}
        >
          ⚡ Перейти на Pro — 299 ₽/мес
        </button>

        <p style={{textAlign:'center', fontSize:11, color:'rgba(255,255,255,0.2)', marginTop:12}}>
          Отмена в любой момент · Безопасная оплата
        </p>

        <style>{`
          @keyframes fadeInBg { from{opacity:0} to{opacity:1} }
          @keyframes proModalIn { from{opacity:0;transform:scale(0.95) translateY(20px)} to{opacity:1;transform:scale(1) translateY(0)} }
        `}</style>
      </div>
    </div>
  );
}
