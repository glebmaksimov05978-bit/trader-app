// src/components/auth/LoginPrism.js
//
// Фон «Призма»: большой стеклянный шестигранник медленно вращается за карточкой входа. На
// каждой грани свой график — выглядит как кристалл со свечами внутри. Это настоящее 3D на CSS
// (грани и крышки, без картинок и библиотек); цвета берутся из темы, анимация одна — вращение.
import React from 'react';
import { candleSeries } from './loginBackdropUtils';

const FACES = [0, 1, 2, 3, 4, 5];
const FW = 230;
const FH = 530;
const COUNT = 15;

function FaceChart({ seed }) {
  const data = candleSeries(COUNT, seed, { drift: 0.04 });
  const y = (v) => 150 + (1 - v) * 230;
  return (
    <svg viewBox={`0 0 ${FW} ${FH}`} width="100%" height="100%" preserveAspectRatio="none">
      {[0, 1, 2, 3, 4].map((i) => <line key={i} className="lpr-grid" x1="0" x2={FW} y1={150 + i * 57} y2={150 + i * 57} />)}
      {data.map((c, i) => {
        const up = c.c >= c.o;
        const x = 14 + i * 14.5;
        return (
          <g key={i} className={up ? 'lpr-up' : 'lpr-down'}>
            <line x1={x + 3} x2={x + 3} y1={y(c.h)} y2={y(c.l)} />
            <rect x={x} y={y(Math.max(c.o, c.c))} width="6" height={Math.max(2, Math.abs(y(c.o) - y(c.c)))} />
          </g>
        );
      })}
    </svg>
  );
}

function Cap({ bottom }) {
  return (
    <div className={`lpr-cap ${bottom ? 'bottom' : 'top'}`}>
      <svg viewBox="0 0 200 173" width="100%" height="100%">
        <polygon points="50,0 150,0 200,86.6 150,173 50,173 0,86.6" />
        <polygon className="lpr-cap-inner" points="75,43 125,43 150,86.6 125,130 75,130 50,86.6" />
      </svg>
    </div>
  );
}

export default function PrismLayer() {
  return (
    <div className="lpr-stage">
      <div className="lpr-tilt">
        <div className="lpr-body">
          <Cap />
          <Cap bottom />
          {FACES.map((i) => (
            <div key={i} className="lpr-face" style={{ '--i': i }}>
              <FaceChart seed={300 + i * 17} />
            </div>
          ))}
        </div>
      </div>
      <div className="lpr-spark" />
    </div>
  );
}
