// Проверка меню Telegram: формат ответов и разбор команд (без сети).
import { renderMenuReply, commandOf } from '../workers/telegram-webhook/src/menu.js';
let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? '✓' : '✗'} ${name}`); if (!cond) fails++; };

const snap = {
  at: new Date().toISOString(), chatId: '1',
  real: [{ ticker: 'SBER', dir: 'long', vol: 10, entry: 300, price: 306, pnl: 58.8, pct: 2 },
         { ticker: 'GAZP', dir: 'short', vol: 5, entry: 170, price: 175, pnl: -30, pct: -2.94 }],
  paper: [], paperClosed: { count: 3, pnl: 1200, last: [{ ticker: 'LKOH', pnl: 500 }] },
  radar: [{ ticker: 'SBER', robot: { at: new Date().toISOString(), text: 'условия не сошлись <5%>' } }, { ticker: 'VTBR', robot: null }],
  robot: { lastCheckAt: new Date().toISOString(), radarCount: 2 },
};
const real = renderMenuReply('real', snap);
ok('сделки: тикеры и итог', real.includes('SBER') && real.includes('GAZP') && real.includes('+29') );
ok('сделки: минус со знаком', real.includes('-30 ₽'));
ok('бумажные: пусто + закрытые', renderMenuReply('paper', snap).includes('Открытых нет') && renderMenuReply('paper', snap).includes('Закрыто всего: 3'));
ok('радар: html экранируется', renderMenuReply('radar', snap).includes('&lt;5%&gt;'));
ok('радар: без проверки', renderMenuReply('radar', snap).includes('ещё не проверял'));
ok('робот: свежие данные — всё в порядке', renderMenuReply('robot', snap).includes('отрабатывает'));
ok('робот: старые данные — предупреждение', renderMenuReply('robot', { ...snap, robot: { lastCheckAt: '2020-01-01T00:00:00Z', radarCount: 1 } }).includes('⚠️'));
ok('команды', commandOf('📈 Сделки') === 'real' && commandOf('📄 Бумажные') === 'paper' && commandOf('🎯 Радар') === 'radar' && commandOf('🤖 Робот') === 'robot' && commandOf('/start') === 'start' && commandOf('привет') === null);
const many = { ...snap, real: Array.from({ length: 80 }, (_, i) => ({ ticker: 'T' + i, dir: 'long', vol: 1, entry: 100, price: 101, pnl: 1, pct: 1 })) };
ok('длинный список влезает в лимит Telegram', renderMenuReply('real', many).length < 4096);
if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки меню Telegram прошли ✓');
