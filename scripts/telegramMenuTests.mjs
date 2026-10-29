// Проверка меню Telegram: выбор стратегии, списки, карточка сделки, кнопки (без сети).
import { renderMenuReply, menuReply, renderMenuView, parseMenuCallback, commandOf, strategyCode, MENU_KEYBOARD } from '../workers/telegram-webhook/src/menu.js';

let fails = 0;
const ok = (name, cond) => { console.log(`${cond ? '✓' : '✗'} ${name}`); if (!cond) fails++; };
const strip = (t) => t.replace(/<[^>]+>/g, '');
const EMOJI = /[\u{1F300}-\u{1FAFF}✅❌⚠⏭]/u;
const bytes = (s) => new TextEncoder().encode(s).length;
const now = new Date().toISOString();

const P = (id, ticker, dir, pnl, pct, strategy, tf, extra = {}) => ({ id, ticker, type: 'stock', dir, vol: 10, entry: 100, price: 100 + pct, pnl, pct, strategy, tf, stop: 95, take: 112, openedAt: '2026-10-24T07:00:00Z', phase: 'торги идут', ...extra });
const snap = {
  at: now, chatId: '1',
  real: [P('r1', 'SBER', 'long', 58.8, 2, 'Пробой', 'D1'), P('r2', 'GAZP', 'short', -30, -2.94, 'Пробой', 'D1')],
  paper: [
    P('p1', 'LKOH', 'long', 620, 0.5, 'Пробой максимума', 'H1'),
    P('p2', 'ROSN', 'short', -120, -0.2, 'Пробой максимума', 'H1'),
    P('p3', 'VTBR', 'long', 15, 1, 'Откат к EMA', 'D1', { stop: null, take: null }),
  ],
  paperByStrategy: [
    { label: 'Пробой максимума', open: 2, closed: 12, pnl: 4200, winrate: 58, avgHoldDays: 0.4, timeframes: ['H1'] },
    { label: 'Откат к EMA', open: 1, closed: 3, pnl: -900, winrate: 33, avgHoldDays: 5, timeframes: ['D1'] },
  ],
  realByStrategy: [{ label: 'Пробой', open: 2, closed: 2, pnl: 800, winrate: 100, avgHoldDays: 3, timeframes: ['D1'] }],
  paperClosedList: [
    { id: 'c1', ticker: 'NVTK', dir: 'long', pnl: 1250, pct: 3.2, strategy: 'Пробой максимума' },
    { id: 'c2', ticker: 'SBER', dir: 'short', pnl: -340, pct: -1.1, strategy: 'Пробой максимума' },
    { id: 'c3', ticker: 'MGNT', dir: 'long', pnl: -900, pct: -2, strategy: 'Откат к EMA' },
  ],
  realClosedList: [{ id: 'rc1', ticker: 'YDEX', dir: 'long', pnl: 800, pct: 4, strategy: 'Пробой' }],
  radar: [{ ticker: 'SBER', robot: { at: now, text: 'условия не сошлись <5%>' } }, { ticker: 'VTBR', robot: null }],
  robot: { lastCheckAt: now, radarCount: 2 },
};

// ── команды ──
ok('новые подписи кнопок', commandOf('Реальные') === 'real' && commandOf('Бумажные') === 'paper' && commandOf('Радар') === 'radar' && commandOf('Робот') === 'robot');
ok('старые подписи тоже понятны (клавиатура у вас могла не обновиться)', commandOf('📈 Сделки') === 'real' && commandOf('📄 Бумажные') === 'paper' && commandOf('🧪 Стратегии') === 'paper' && commandOf('🎯 Радар') === 'radar' && commandOf('🤖 Робот') === 'robot');
ok('/start и неизвестное', commandOf('/start') === 'start' && commandOf('привет') === null);
ok('клавиатура меню без эмодзи', !EMOJI.test(JSON.stringify(MENU_KEYBOARD)));

// ── выбор стратегии (бумажные) ──
const pv = menuReply('paper', snap);
const pt = strip(pv.text);
ok('бумажные: у каждой стратегии свой блок с итогом', pt.includes('Пробой максимума') && pt.includes('Откат к EMA') && /закрыто 12, итог \+4\s200 ₽/.test(pt) && /закрыто 3, итог −900 ₽/.test(pt));
ok('бумажные: плавающий результат по стратегии', /открыто 2, плавает \+500 ₽/.test(pt));
ok('бумажные: нет общего итога «по всем» (стратегии не складываем)', !/Итого плавающий|Итог по всем/.test(pt));
const pk = pv.keyboard.inline_keyboard;
ok('бумажные: кнопка на каждую стратегию + «Все открытые»', pk.length === 3 && pk[0][0].callback_data === `m|l|p|${strategyCode('Пробой максимума')}` && pk[2][0].callback_data === 'm|l|p|all');
ok('в экране выбора нет эмодзи', !EMOJI.test(pv.text) && !EMOJI.test(JSON.stringify(pk)));

// ── список одной стратегии ──
const lv = renderMenuView(parseMenuCallback(pk[0][0].callback_data), snap);
const lt = strip(lv.text);
ok('список: название, таймфрейм, сводка', lt.includes('Пробой максимума') && lt.includes('Ч1') && !lt.includes('H1') && /Открыто\s+2\s+плавает \+500 ₽/.test(lt) && /Закрыто\s+12/.test(lt) && /Итог закрытых\s+\+4\s200 ₽/.test(lt) && /Прибыльных\s+58%/.test(lt));
ok('список: открытые сделки таблицей с направлением и результатом', /LKOH\s+лонг\s+\+620 ₽\s+\+0,5%/.test(lt) && /ROSN\s+шорт\s+−120 ₽\s+−0,2%/.test(lt));
ok('список: закрытые этой стратегии (и только её)', /NVTK\s+лонг\s+\+1\s250 ₽\s+\+3,2%/.test(lt) && /SBER\s+шорт\s+−340 ₽/.test(lt) && !lt.includes('MGNT'));
const preLines = [...lv.text.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].flatMap((m) => m[1].split('\n'));
const rowsOpen = preLines.filter((l) => /^(LKOH|ROSN|NVTK|SBER)\s/.test(l));
ok('цифры в колонку: все строки сделок одной ширины', new Set(rowsOpen.map((l) => l.length)).size === 1);
const lb = lv.keyboard.inline_keyboard;
ok('под списком — кнопки-тикеры открытых сделок и «К стратегиям»', lb[0].map((b) => b.text).join() === 'LKOH,ROSN' && lb[0][0].callback_data === 'm|t|p|p1' && lb[lb.length - 1][0].callback_data === 'm|l|p|');
const allBtns = [...pk.flat(), ...lb.flat()];
ok('данные кнопок не длиннее 64 байт', allBtns.every((b) => !b.callback_data || bytes(b.callback_data) <= 64));
ok('таймфрейм стратегии «Откат»: закрытых только её', strip(renderMenuView({ kind: 'list', mode: 'p', sk: strategyCode('Откат к EMA') }, snap).text).includes('MGNT'));

// ── «все открытые» ──
const av = strip(renderMenuView({ kind: 'list', mode: 'p', sk: 'all' }, snap).text);
ok('все открытые: сгруппированы по стратегиям, без общего итога', av.includes('Пробой максимума') && av.includes('Откат к EMA') && av.includes('VTBR') && !/Итог/.test(av));

// ── карточка сделки ──
const tv = renderMenuView(parseMenuCallback('m|t|p|p1'), snap, 'https://my.site');
const tt = strip(tv.text);
ok('карточка: тикер, сторона, тип, стратегия, таймфрейм', /LKOH · лонг\s+бумажная/.test(tt) && tt.includes('«Пробой максимума»') && tt.includes('Ч1') && !tt.includes('H1'));
ok('карточка: вход, цена, стоп и цель с процентами, объём, результат', /Вход\s+100/.test(tt) && /Сейчас\s+100,5\s+\+0,5%/.test(tt) && /Стоп\s+95\s+−5,0%/.test(tt) && /Цель\s+112\s+\+12,0%/.test(tt) && /Объём\s+10/.test(tt) && /Результат\s+\+620 ₽/.test(tt));
const tk = tv.keyboard.inline_keyboard;
ok('карточка: ссылка на ЭТУ сделку в приложении', tk[0][0].url === 'https://my.site/cockpit?activeId=p1' && tk[0][0].text === 'Открыть в приложении');
ok('карточка бумажной: «Открыть реально» → x|o', tk[1][0].callback_data === 'x|o|p1' && tk[1][0].text === 'Открыть реально');
ok('карточка: «К списку» ведёт в свою стратегию', tk[2][0].callback_data === `m|l|p|${strategyCode('Пробой максимума')}`);
const rt = renderMenuView(parseMenuCallback('m|t|r|r2'), snap);
ok('карточка реальной: «Закрыть позицию» → x|c, шорт: стоп выше входа', rt.keyboard.inline_keyboard[1][0].callback_data === 'x|c|r2' && strip(rt.text).includes('реальная') && /шорт/.test(strip(rt.text)));
ok('карточка без стопа и цели: «нет»', /Стоп\s+нет/.test(strip(renderMenuView({ kind: 'trade', mode: 'p', id: 'p3' }, snap).text)));
ok('карточка закрытой/пропавшей сделки: понятное сообщение', renderMenuView({ kind: 'trade', mode: 'p', id: 'zzz' }, snap).text.includes('нет в последнем снимке'));
ok('в карточке и её кнопках нет эмодзи', !EMOJI.test(tv.text) && !EMOJI.test(JSON.stringify(tk)));

// ── реальные ──
const rv = menuReply('real', snap);
ok('реальные: одна стратегия — сразу список, без выбора', strip(rv.text).includes('Пробой') && /SBER\s+лонг\s+\+59 ₽/.test(strip(rv.text)) && /YDEX\s+лонг\s+\+800 ₽/.test(strip(rv.text)));
ok('реальные: кнопки сделок ведут на m|t|r|…', rv.keyboard.inline_keyboard[0][0].callback_data === 'm|t|r|r1');

// ── разбор кнопок ──
ok('разбор m|l / m|t', JSON.stringify(parseMenuCallback('m|l|p|abc')) === '{"kind":"list","mode":"p","sk":"abc"}' && parseMenuCallback('m|t|r|id9').id === 'id9');
ok('разбор: чужое и мусор → null', parseMenuCallback('x|c|1') === null && parseMenuCallback('m|z|p|1') === null && parseMenuCallback('m|l|q|1') === null && parseMenuCallback('m|t|p|') === null && parseMenuCallback(null) === null);
ok('код стратегии стабилен и различает названия', strategyCode('Пробой') === strategyCode('Пробой') && strategyCode('Пробой') !== strategyCode('Откат'));
ok('неизвестная стратегия в старой кнопке — понятное сообщение', renderMenuView({ kind: 'list', mode: 'p', sk: 'nope' }, snap).text.includes('не найдена'));

// ── пустые и старые данные ──
const empty = menuReply('paper', { ...snap, paper: [], paperByStrategy: [], paperClosedList: [] });
ok('бумажных нет — «Открытых нет», без кнопок', empty.text.includes('Открытых нет') && !empty.keyboard);
const old = { at: now, chatId: '1', real: snap.real, paper: snap.paper, paperClosed: { count: 3, pnl: 1200, last: [] }, radar: [], robot: { lastCheckAt: now, radarCount: 0 } };
const oldView = menuReply('paper', old);
ok('снимок старого формата (без закрытых и итогов) не ломает меню', oldView.text.includes('Пробой максимума') && oldView.text.includes('закрытых пока нет'));
ok('снимок старого формата: список стратегии открывается', strip(renderMenuView({ kind: 'list', mode: 'p', sk: strategyCode('Пробой максимума') }, old).text).includes('LKOH'));

// ── экранирование и длина ──
const evil = { ...snap, paper: [P('e1', 'A<B>', 'long', 1, 1, 'X<b>&Y', 'H1')], paperByStrategy: [], paperClosedList: [] };
const ev = renderMenuView({ kind: 'list', mode: 'p', sk: strategyCode('X<b>&Y') }, evil);
ok('спецсимволы в названиях экранируются', !/X<b>&Y/.test(ev.text) && ev.text.includes('X&lt;b&gt;&amp;Y') && ev.text.includes('A&lt;B&gt;'));
const many = { ...snap, paper: Array.from({ length: 80 }, (_, i) => P('m' + i, 'T' + i, 'long', 1, 1, 'Большая', 'H1')), paperByStrategy: [], paperClosedList: Array.from({ length: 60 }, (_, i) => ({ id: 'q' + i, ticker: 'Q' + i, dir: 'long', pnl: 1, pct: 1, strategy: 'Большая' })) };
const mv = renderMenuView({ kind: 'list', mode: 'p', sk: strategyCode('Большая') }, many);
ok('длинный список влезает в лимит Telegram (4096) и не раздувает кнопки', mv.text.length < 4096 && mv.keyboard.inline_keyboard.flat().filter((b) => b.callback_data.startsWith('m|t')).length <= 12);
ok('«все открытые» тоже влезает', renderMenuView({ kind: 'list', mode: 'p', sk: 'all' }, many).text.length < 4096);

// ── радар и робот ──
ok('радар: html экранируется, без проверки — понятно', renderMenuReply('radar', snap).includes('&lt;5%&gt;') && renderMenuReply('radar', snap).includes('ещё не проверял'));
ok('робот: свежие данные — всё в порядке', renderMenuReply('robot', snap).includes('отрабатывает'));
ok('робот: старые данные — предупреждение без эмодзи', (() => { const t = renderMenuReply('robot', { ...snap, robot: { lastCheckAt: '2020-01-01T00:00:00Z', radarCount: 1 } }); return t.includes('Внимание') && !EMOJI.test(t); })());
ok('экран «Робот» без эмодзи, цифры таблицей', !EMOJI.test(renderMenuReply('robot', snap)) && /<pre>/.test(renderMenuReply('robot', snap)));

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки меню Telegram прошли ✓');
