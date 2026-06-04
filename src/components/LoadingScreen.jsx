// src/components/LoadingScreen.jsx
import React, { useEffect, useState } from 'react';

// Свечи идут снизу вверх — каждая следующая выше предыдущей
const CANDLES = [
  { delay: 0.00, bodyH: 28, wickUp: 8,  wickDn: 6,  bull: false, bottom: 0   },
  { delay: 0.18, bodyH: 38, wickUp: 10, wickDn: 8,  bull: true,  bottom: 18  },
  { delay: 0.36, bodyH: 32, wickUp: 12, wickDn: 7,  bull: false, bottom: 30  },
  { delay: 0.54, bodyH: 50, wickUp: 14, wickDn: 9,  bull: true,  bottom: 42  },
  { delay: 0.72, bodyH: 36, wickUp: 10, wickDn: 8,  bull: false, bottom: 58  },
  { delay: 0.90, bodyH: 55, wickUp: 16, wickDn: 10, bull: true,  bottom: 68  },
  { delay: 1.08, bodyH: 44, wickUp: 12, wickDn: 8,  bull: true,  bottom: 88  },
];

const CANDLE_W = 16;
const GAP      = 13;
const ZONE_H   = 180; // высота всей зоны свечей

export default function LoadingScreen() {
  const [fadeOut, setFadeOut] = useState(false);
  const [gone,    setGone]    = useState(false);

  useEffect(() => {
    const t1 = setTimeout(() => setFadeOut(true), 2600);
    const t2 = setTimeout(() => setGone(true),    3100);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  if (gone) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: '#080c14',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      transition: 'opacity 0.5s ease',
      opacity: fadeOut ? 0 : 1,
    }}>

      {/* Фоновое свечение снизу */}
      <div style={{
        position: 'absolute',
        width: 320, height: 200,
        borderRadius: '50%',
        background: 'radial-gradient(ellipse, rgba(79,70,229,0.12) 0%, transparent 70%)',
        bottom: '40%',
        pointerEvents: 'none',
      }}/>

      {/* Зона свечей — фиксированная высота, свечи стоят на базовой линии */}
      <div style={{
        position: 'relative',
        width: CANDLES.length * (CANDLE_W + GAP) - GAP,
        height: ZONE_H,
        marginBottom: 28,
      }}>

        {/* Базовая линия */}
        <div style={{
          position: 'absolute',
          bottom: 0, left: -8, right: -8,
          height: 1,
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.12), transparent)',
          animation: 'fadeIn 0.3s ease 0.3s both',
          opacity: 0,
        }}/>

        {CANDLES.map((c, i) => {
          const color = c.bull ? '#10b981' : '#ef4444';
          const glow  = c.bull
            ? '0 0 16px rgba(16,185,129,0.6), 0 0 32px rgba(16,185,129,0.2)'
            : '0 0 16px rgba(239,68,68,0.5), 0 0 32px rgba(239,68,68,0.15)';
          const totalH = c.wickUp + c.bodyH + c.wickDn;

          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                bottom: c.bottom,      // каждая свеча выше предыдущей
                left: i * (CANDLE_W + GAP),
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                // Анимация: появляется снизу вверх
                animation: `riseUp 0.5s cubic-bezier(0.34,1.4,0.64,1) both`,
                animationDelay: `${c.delay}s`,
                opacity: 0,
                height: totalH,
              }}
            >
              {/* Верхний фитиль */}
              <div style={{
                width: 2, height: c.wickUp,
                background: color, opacity: 0.7, borderRadius: 1, flexShrink: 0,
              }}/>
              {/* Тело свечи */}
              <div style={{
                width: CANDLE_W,
                height: c.bodyH,
                borderRadius: 3,
                flexShrink: 0,
                background: c.bull
                  ? 'linear-gradient(180deg, #34d399, #059669)'
                  : 'linear-gradient(180deg, #f87171, #dc2626)',
                boxShadow: glow,
              }}/>
              {/* Нижний фитиль */}
              <div style={{
                width: 2, height: c.wickDn,
                background: color, opacity: 0.7, borderRadius: 1, flexShrink: 0,
              }}/>
            </div>
          );
        })}

        {/* Линия тренда поверх свечей — рисуется после */}
        <svg
          style={{
            position: 'absolute', inset: 0,
            width: '100%', height: '100%',
            overflow: 'visible', pointerEvents: 'none',
            animation: 'fadeIn 0.6s ease 1.4s both',
            opacity: 0,
          }}
        >
          <defs>
            <linearGradient id="trendGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#ef4444" stopOpacity="0.3"/>
              <stop offset="100%" stopColor="#10b981" stopOpacity="0.8"/>
            </linearGradient>
          </defs>
          {/* Линия тренда через вершины свечей */}
          <polyline
            points={CANDLES.map((c, i) => {
              const x = i * (CANDLE_W + GAP) + CANDLE_W / 2;
              const y = ZONE_H - c.bottom - c.bodyH - c.wickUp;
              return `${x},${y}`;
            }).join(' ')}
            fill="none"
            stroke="url(#trendGrad)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="200"
            strokeDashoffset="200"
            style={{ animation: 'drawLine 0.8s ease 1.4s forwards' }}
          />
        </svg>
      </div>

      {/* Прогресс-бар */}
      <div style={{
        width: 120, height: 2,
        background: 'rgba(255,255,255,0.07)',
        borderRadius: 2, overflow: 'hidden',
        animation: 'fadeIn 0.4s ease 1.2s both',
        opacity: 0,
      }}>
        <div style={{
          height: '100%',
          background: 'linear-gradient(90deg, #4f46e5, #7c3aed, #10b981)',
          borderRadius: 2,
          animation: 'progress 1.4s ease 1.2s both',
          transform: 'scaleX(0)',
          transformOrigin: 'left',
        }}/>
      </div>

      <style>{`
        @keyframes riseUp {
          from {
            opacity: 0;
            transform: translateY(30px) scaleY(0.3);
            transform-origin: bottom;
          }
          to {
            opacity: 1;
            transform: translateY(0) scaleY(1);
            transform-origin: bottom;
          }
        }
        @keyframes fadeIn {
          to { opacity: 1; }
        }
        @keyframes progress {
          from { transform: scaleX(0); }
          to   { transform: scaleX(1); }
        }
        @keyframes drawLine {
          to { stroke-dashoffset: 0; }
        }
      `}</style>
    </div>
  );
}
