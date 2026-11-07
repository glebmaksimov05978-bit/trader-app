// src/index.js
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// Подключает разбор «вечных» фьючерсов (нефть, газ…) к загрузке свечей — достаточно импорта.
import './services/marketData/futuresRoll';

const root = ReactDOM.createRoot(document.getElementById('root'));
// /__harness — стенд графика для разработки (src/qa/ChartHarness.js); в боевой сборке этой ветки нет.
if (process.env.NODE_ENV === 'development' && window.location.pathname === '/__harness') {
  const ChartHarness = require('./qa/ChartHarness').default;
  root.render(<ChartHarness />);
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
