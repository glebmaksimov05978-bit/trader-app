// src/index.js
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// Подключает разбор «вечных» фьючерсов (нефть, газ…) к загрузке свечей — достаточно импорта.
import './services/marketData/futuresRoll';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
