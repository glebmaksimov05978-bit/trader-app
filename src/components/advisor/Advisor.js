// src/components/advisor/Advisor.js
import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { getUserTrades, calcStats } from '../../services/trades';
import toast from 'react-hot-toast';
import './Advisor.css';

const MODES = [
  { id: 'journal', icon: '📊', label: 'Анализ журнала', desc: 'Паттерны ошибок и слабые места' },
  { id: 'trade', icon: '🔍', label: 'Разбор сделки', desc: 'Детальный анализ конкретной позиции' },
  { id: 'psychology', icon: '🧠', label: 'Психологический коуч', desc: 'Работа с эмоциями и дисциплиной' },
  { id: 'chat', icon: '💬', label: 'Свободный вопрос', desc: 'Любой вопрос по трейдингу' },
];

export default function Advisor() {
  const { user, userProfile } = useAuth();
  const [mode, setMode] = useState('journal');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  // Receive question from calculator
  useEffect(() => {
    const q = sessionStorage.getItem('advisorQuestion');
    if (q) {
      sessionStorage.removeItem('advisorQuestion');
      setMode('chat');
      setTimeout(() => sendMessage(q), 300);
    }
  // eslint-disable-next-line
  }, []);
  const [trades, setTrades] = useState([]);
  const [stats, setStats] = useState(null);
  const [selectedTrade, setSelectedTrade] = useState('');
  const chatEndRef = useRef(null);

  useEffect(() => {
    if (!user) return;
    getUserTrades(user.uid).then(t => {
      setTrades(t);
      setStats(calcStats(t));
    });
  }, [user]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const buildSystemPrompt = () => {
    const profile = `Трейдер: ${userProfile?.displayName || 'Аноним'}, депозит: ${userProfile?.depositSize || 100000} ₽, риск/сделку: ${userProfile?.maxRiskPerTrade || 1}%`;
    const statsText = stats ? `
Статистика: ${stats.total} сделок, винрейт ${stats.winrate.toFixed(1)}%, profit factor ${stats.profitFactor.toFixed(2)},
матожидание ${stats.expectancy.toFixed(0)} ₽, макс. просадка ${stats.maxDrawdown.toFixed(0)} ₽,
макс. серия убытков ${stats.maxLossStreak}, средний профит ${stats.avgWin.toFixed(0)} ₽, средний убыток ${stats.avgLoss.toFixed(0)} ₽.` : 'Статистики пока нет.';

    const recentTrades = trades.slice(0, 20).map(t => {
      const d = t.date?.seconds ? new Date(t.date.seconds * 1000).toLocaleDateString('ru-RU') : t.date || '';
      return `${d} ${t.ticker} ${t.direction} вход:${t.entryPrice} выход:${t.exitPrice||'—'} P&L:${t.pnl||'—'} ₽ ${t.emotion||''} ${t.setup||''} ${t.notes||''}`;
    }).join('\n');

    return `Ты — профессиональный торговый советник и психологический коуч для трейдера на российском рынке фьючерсов (MOEX).
${profile}
${statsText}

Последние сделки:
${recentTrades || 'Нет данных'}

Отвечай на русском языке. Будь конкретным, используй данные из журнала. Давай практичные советы. 
Используй markdown для форматирования. Будь честным, даже если нужно указать на ошибки.`;
  };

  const getInitialMessage = () => {
    switch (mode) {
      case 'journal':
        return `Проанализируй мой журнал сделок. Найди паттерны ошибок, слабые места и дай конкретные рекомендации по улучшению.`;
      case 'psychology':
        return `Проанализируй мои эмоциональные состояния во время торговли. Есть ли корреляция между эмоциями и результатами? Как мне улучшить психологическую устойчивость?`;
      case 'trade':
        const t = trades.find(t => t.id === selectedTrade);
        if (!t) return '';
        return `Разбери эту сделку подробно: ${t.ticker} ${t.direction} ${t.date}, вход ${t.entryPrice}, выход ${t.exitPrice}, P&L ${t.pnl} ₽. Заметки: ${t.notes || 'нет'}. Что было сделано правильно и неправильно?`;
      default:
        return input;
    }
  };

  const sendMessage = async (messageText) => {
    const text = messageText || input;
    if (!text.trim() || loading) return;

    const userMsg = { role: 'user', content: text };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    try {
      const response = await fetch('/api/advisor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          systemPrompt: buildSystemPrompt(),
        }),
      });

      if (!response.ok) throw new Error('API error');
      const data = await response.json();
      const assistantMsg = { role: 'assistant', content: data.content };
      setMessages(m => [...m, assistantMsg]);
    } catch (err) {
      toast.error('Ошибка AI советника. Проверьте настройки API.');
      setMessages(m => m.slice(0, -1));
    } finally {
      setLoading(false);
    }
  };

  const startAnalysis = () => {
    const msg = getInitialMessage();
    if (!msg) {
      toast.error('Выберите сделку для разбора');
      return;
    }
    setMessages([]);
    setTimeout(() => sendMessage(msg), 100);
  };

  const renderMarkdown = (text) => {
    return text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/^### (.*$)/gm, '<h3>$1</h3>')
      .replace(/^## (.*$)/gm, '<h2>$1</h2>')
      .replace(/^# (.*$)/gm, '<h1>$1</h1>')
      .replace(/^- (.*$)/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/^(?!<[h|u|l])/gm, '')
      .split('\n').join('<br/>');
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">🤖 AI Советник</h1>
        <p className="page-subtitle">Анализ торговли с помощью искусственного интеллекта</p>
      </div>

      <div className="advisor-layout">
        {/* Left: mode selector */}
        <div className="advisor-sidebar">
          <div className="card">
            <div className="section-title">
              <div className="section-title-icon">🎯</div>
              Режим
            </div>
            <div className="flex flex-col gap-2">
              {MODES.map(m => (
                <button
                  key={m.id}
                  className={`advisor-mode-btn ${mode === m.id ? 'active' : ''}`}
                  onClick={() => { setMode(m.id); setMessages([]); }}
                >
                  <span className="advisor-mode-icon">{m.icon}</span>
                  <div>
                    <div className="advisor-mode-label">{m.label}</div>
                    <div className="advisor-mode-desc">{m.desc}</div>
                  </div>
                </button>
              ))}
            </div>

            {/* Trade selector for 'trade' mode */}
            {mode === 'trade' && (
              <div className="input-group" style={{marginTop:16}}>
                <label className="input-label">Выберите сделку</label>
                <select className="input" value={selectedTrade} onChange={e => setSelectedTrade(e.target.value)}>
                  <option value="">— выберите —</option>
                  {trades.slice(0, 50).map(t => {
                    const d = t.date?.seconds ? new Date(t.date.seconds * 1000).toLocaleDateString('ru-RU') : t.date || '';
                    return (
                      <option key={t.id} value={t.id}>
                        {d} {t.ticker} {t.direction} {t.pnl !== null ? (t.pnl >= 0 ? '+' : '') + Math.round(t.pnl) + '₽' : ''}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}

            {mode !== 'chat' && (
              <button
                className="btn btn-primary w-full"
                style={{marginTop:16}}
                onClick={startAnalysis}
                disabled={loading || (mode === 'trade' && !selectedTrade)}
              >
                {loading ? <><div className="spinner" style={{width:14,height:14}}/> Анализирую...</> : '▶ Запустить анализ'}
              </button>
            )}

            {/* Stats mini */}
            {stats && (
              <div style={{marginTop:16, padding:'12px', background:'var(--bg-surface-2)', borderRadius:'12px'}}>
                <div className="text-xs text-muted" style={{marginBottom:8}}>Данные для анализа:</div>
                <div className="stat-row" style={{padding:'4px 0'}}><span className="text-xs text-secondary">Сделок</span><span className="text-xs font-semibold">{stats.total}</span></div>
                <div className="stat-row" style={{padding:'4px 0'}}><span className="text-xs text-secondary">Винрейт</span><span className="text-xs font-semibold">{stats.winrate.toFixed(1)}%</span></div>
                <div className="stat-row" style={{padding:'4px 0'}}><span className="text-xs text-secondary">PF</span><span className="text-xs font-semibold">{stats.profitFactor.toFixed(2)}</span></div>
              </div>
            )}
          </div>
        </div>

        {/* Chat area */}
        <div className="advisor-chat">
          <div className="card advisor-messages-card">
            <div className="advisor-messages" ref={el => { if (el) el.scrollTop = el.scrollHeight; }}>
              {messages.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon">🤖</div>
                  <div className="empty-state-title">AI Советник готов</div>
                  <div className="empty-state-text">
                    {mode === 'chat'
                      ? 'Задайте вопрос по трейдингу'
                      : 'Нажмите «Запустить анализ», чтобы получить персональные рекомендации'}
                  </div>
                </div>
              ) : (
                messages.map((msg, i) => (
                  <div key={i} className={`advisor-message ${msg.role}`}>
                    <div className="advisor-message-avatar">
                      {msg.role === 'user' ? (userProfile?.displayName || 'Вы')[0] : '🤖'}
                    </div>
                    <div className="advisor-message-bubble">
                      {msg.role === 'assistant' ? (
                        <div
                          className="advisor-message-content"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                        />
                      ) : (
                        <div className="advisor-message-content">{msg.content}</div>
                      )}
                    </div>
                  </div>
                ))
              )}
              {loading && (
                <div className="advisor-message assistant">
                  <div className="advisor-message-avatar">🤖</div>
                  <div className="advisor-message-bubble">
                    <div className="advisor-typing">
                      <div className="loading-dot" />
                      <div className="loading-dot" />
                      <div className="loading-dot" />
                    </div>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input */}
            <div className="advisor-input-row">
              <input
                className="input"
                style={{flex:1, borderRadius:'12px'}}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), sendMessage())}
                placeholder={mode === 'chat' ? 'Спросите что-нибудь...' : 'Дополните или задайте вопрос...'}
                disabled={loading}
              />
              <button
                className="btn btn-primary"
                onClick={() => sendMessage()}
                disabled={loading || !input.trim()}
                style={{borderRadius:12, padding:'10px 16px'}}
              >
                ➤
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
