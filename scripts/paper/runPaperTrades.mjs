// scripts/paper/runPaperTrades.mjs
//
// Робот бумажных сделок, шаг 2: обходит список радара и ОТКРЫВАЕТ виртуальные сделки,
// когда условия стратегии сошлись. Реальных денег не касается — заявку брокеру он
// физически отправить не может, торгового токена у него нет и не будет.
//
// Ведение и закрытие бумажных сделок — следующий шаг, здесь этого ещё нет.
//
// Почему рядом с runAlerts.mjs, а не внутри него: это разные вопросы к рынку. Тот следит
// за УЖЕ открытыми позициями трейдера, этот ищет НОВЫЕ входы по списку наблюдения. Общий
// у них только способ запуска, поэтому оба шага живут в одном workflow — так GitHub
// поднимает окружение один раз на оба, а не дважды.
//
// Главное правило: вход считается ПО ТЕМ ЖЕ функциям, что и бэктест (buildCtx,
// readinessPercent, computeStopPrice/computeTakePrice, calcTrade). Своя копия этой логики
// разъехалась бы с движком при первой же правке, и тогда бумажная статистика отвечала бы
// на другой вопрос, чем исследование, — а вся ценность фичи именно в сравнимости.
//
// Переменные окружения (Secrets репозитория):
//   FIREBASE_SERVICE_ACCOUNT - JSON сервисного аккаунта Firebase, одной строкой
//   ALERT_UIDS               - через запятую: uid пользователей, чей радар обходить
//
// Флаги: --dry — всё посчитать и показать, но в базу ничего не писать.
//        --force — не смотреть на расписание торгов (для проверки вне сессии).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import admin from 'firebase-admin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

// --- Загрузка исходников приложения в Node ---------------------------------------------
// В src/ лежит браузерный код: относительные импорты без расширений и импорт tinkoff.js,
// который здесь не нужен. Тот же приём, что в runAlerts.mjs: копируем во временную папку,
// дописываем расширения, подменяем ненужный модуль заглушкой.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-paper-'));
function esmify(src, extra = []) {
  let t = fs.readFileSync(src, 'utf8');
  t = t.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, s) => (/\.[a-z]+$/i.test(s) ? m : `from ${q}${s}.js${q}`));
  for (const [a, b] of extra) t = t.split(a).join(b);
  const out = path.join(tmp, path.basename(src));
  fs.writeFileSync(out, t, 'utf8');
  return pathToFileURL(out).href;
}
fs.writeFileSync(path.join(tmp, 'tinkoff.js'), 'export class TinkoffAPI {}\nexport function moneyToFloat(){return 0;}\n');
for (const f of ['indicators', 'candlestickPatterns', 'patterns', 'marketContext', 'strategy', 'exitRules', 'commission', 'portfolio']) {
  esmify(path.join(repoRoot, `src/services/analytics/${f}.js`));
}
esmify(path.join(repoRoot, 'src/utils/calculator.js'));
const engineUrl = esmify(path.join(repoRoot, 'src/services/backtest/engine.js'), [
  ["from '../analytics/", "from './"], ["from '../../utils/calculator.js'", "from './calculator.js'"],
]);
const candlesUrl = esmify(path.join(repoRoot, 'src/services/marketData/candles.js'), [["from '../tinkoff.js'", "from './tinkoff.js'"]]);
const scheduleUrl = esmify(path.join(repoRoot, 'src/services/marketData/tradingSchedule.js'));
const specsUrl = esmify(path.join(repoRoot, 'src/services/marketData/futuresSpecs.js'));
const exitRulesUrl = pathToFileURL(path.join(tmp, 'exitRules.js')).href;
const calcUrl = pathToFileURL(path.join(tmp, 'calculator.js')).href;
const commissionUrl = pathToFileURL(path.join(tmp, 'commission.js')).href;
const portfolioUrl = pathToFileURL(path.join(tmp, 'portfolio.js')).href;

const { buildCtx, readinessPercent } = await import(engineUrl);
const { computeStopPrice, computeTakePrice, computeRiskStopPrice } = await import(exitRulesUrl);
const { calcTrade } = await import(calcUrl);
const { commissionRateFor, DEFAULT_TARIFF } = await import(commissionUrl);
const { computeBaskets, capitalForStrategy } = await import(portfolioUrl);
const { fetchDailyCandles, TIMEFRAMES, DEFAULT_TIMEFRAME } = await import(candlesUrl);
const { shouldWatchNow, marketPhase, anyMarketOpen } = await import(scheduleUrl);
const { fetchActiveFutureCard, fetchStockLot } = await import(specsUrl);

const DRY = process.argv.includes('--dry');
const FORCE = process.argv.includes('--force') || process.env.FORCE_CHECK === 'true';

function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Нет FIREBASE_SERVICE_ACCOUNT');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  return admin.firestore();
}

// Стратегия конкретного тикера: своя, если задана при добавлении в радар, иначе активная
// стратегия профиля. Ровно та же логика, что в приложении (RadarLiveContext).
function strategyFor(item, profile) {
  const all = profile.strategies || [];
  if (item.strategyId) {
    const own = all.find((s) => s.id === item.strategyId);
    if (own) return own;
  }
  return all.find((s) => s.id === profile.activeStrategyId) || all[0] || profile.strategy || null;
}

// Параметры контракта нужны, чтобы посчитать объём по риску. Без них у фьючерса убыток на
// контракт считается неверно — а фьючерсы здесь основной инструмент, так что молча
// подставлять единицы нельзя: помечаем такую сделку как посчитанную приблизительно.
async function loadSpecs(ticker, instrumentType) {
  if (instrumentType === 'future') {
    const card = await fetchActiveFutureCard(ticker);
    if (!card) return { lot: 1, minStep: 1, minStepAmount: 0, initialMargin: 0, approx: true };
    return {
      lot: card.lot || 1,
      minStep: card.minPriceIncrement || 1,
      minStepAmount: card.minPriceIncrementAmount || 0,
      initialMargin: card.initialMargin || 0,
      approx: false,
    };
  }
  const lot = await fetchStockLot(ticker);
  return { lot: lot || 1, minStep: 1, minStepAmount: 0, initialMargin: 0, approx: lot == null };
}

async function checkItem({ db, uid, profile, item, openTickers, allTrades }) {
  const strategy = strategyFor(item, profile);
  if (!strategy?.conditions?.length) return { skipped: 'у стратегии нет условий' };

  const instrumentType = item.instrumentType || 'stock';
  if (!FORCE && !shouldWatchNow(instrumentType, profile.alertPrefs)) {
    return { skipped: marketPhase(instrumentType).label };
  }
  // Не больше одной открытой бумажной на тикер — иначе за месяц накопится свалка из
  // повторных входов по одному и тому же сигналу.
  if (openTickers.has(item.ticker.toUpperCase())) return { skipped: 'бумажная сделка уже открыта' };

  const tfKey = item.timeframe || profile.preferredTimeframe || DEFAULT_TIMEFRAME;
  const tf = TIMEFRAMES[tfKey] || TIMEFRAMES[DEFAULT_TIMEFRAME];
  const candles = await fetchDailyCandles({
    ticker: item.ticker,
    instrumentType,
    toDate: new Date(),
    timeframe: tfKey,
    lookbackDays: tf.lookbackDays,
  });
  // Нужны минимум два бара: на одном ищем сигнал, по открытию следующего входим.
  if (!candles || candles.length < 2) return { skipped: 'мало свечей' };

  // Сигнал считается по ПОСЛЕДНЕМУ ЗАКРЫТОМУ бару, вход — по открытию следующего. Так же
  // считает бэктест, и так же это выглядело бы в жизни: условия видны только на закрытии
  // бара, раньше войти было физически нельзя. Оба бара уже существуют, обе цены реальные.
  const signalBar = candles[candles.length - 2];
  const entryBar = candles[candles.length - 1];

  const baseCtx = buildCtx(candles, signalBar.date, undefined, tf.minutes);
  if (!baseCtx.indicators) return { skipped: 'не хватает истории для индикаторов' };

  const long = readinessPercent(strategy, { ...baseCtx, direction: 'long' });
  const short = readinessPercent(strategy, { ...baseCtx, direction: 'short' });
  const threshold = strategy.readinessThreshold ?? 100;
  const okLong = long.total > 0 && long.pct >= threshold;
  const okShort = short.total > 0 && short.pct >= threshold;

  let direction = null, best = null;
  if (okLong && okShort) { direction = long.pct >= short.pct ? 'long' : 'short'; best = direction === 'long' ? long : short; }
  else if (okLong) { direction = 'long'; best = long; }
  else if (okShort) { direction = 'short'; best = short; }
  if (!direction) {
    return { skipped: `условия не сошлись (лонг ${long.passed}/${long.total}, шорт ${short.passed}/${short.total})` };
  }

  const entryPrice = entryBar.open;
  const rules = strategy.exitRules || {};
  const priceCtx = { atr: baseCtx.indicators.atr14 ?? null, patterns: baseCtx.patterns };
  const stopPrice = computeStopPrice(direction, entryPrice, rules, priceCtx);
  const takePrice = computeTakePrice(direction, entryPrice, rules, priceCtx);
  // Часть стратегий сознательно торгует БЕЗ стопа (проверено: без стопа + следящий выход
  // заметно лучше классики — см. комментарий у computeRiskStopPrice). Реальный exit-стоп
  // (stopPrice, использованный бы для проверки выхода) в этом случае и должен быть null —
  // сделку закрывает следящий выход, не эта цена. Но calcTrade требует хоть какое-то
  // расстояние, чтобы посчитать «% риска от депозита»: используем тот же откалиброванный
  // ATR-порог, что следящий выход уже считает сам себе. ВАЖНО: этот запасной расчёт идёт
  // только в calcTrade — в саму бумажную сделку ниже пишется настоящий stopPrice
  // (возможно null), а не эта цифра. Иначе движок Сопровождения принял бы её за реальный
  // стоп и стал бы закрывать сделку по касанию — ровно то сочетание («ATR-стоп поверх
  // трейлинга»), которое проверено и оказалось хуже, чем стопа не иметь вовсе.
  const sizingStopPrice = stopPrice ?? computeRiskStopPrice(direction, entryPrice, rules, priceCtx);
  if (sizingStopPrice == null) return { skipped: 'нет ни стопа, ни трейлинга — объём по риску не посчитать' };

  const specs = await loadSpecs(item.ticker, instrumentType);
  const strategies = profile.strategies || [];
  const computed = computeBaskets({ userProfile: profile, strategies, trades: allTrades });
  const capital = capitalForStrategy({
    strategyId: strategy.id,
    computed,
    fallbackBalance: Number(profile.depositSize) || 0,
  });
  const commRate = commissionRateFor(profile.brokerTariff || DEFAULT_TARIFF, instrumentType).rate;

  const sizing = calcTrade({
    entryPrice, stopLoss: sizingStopPrice, takeProfit: takePrice ?? 0,
    depositSize: capital,
    riskPercent: profile.maxRiskPerTrade || 1,
    lot: specs.lot, minStep: specs.minStep, minStepAmount: specs.minStepAmount,
    initialMargin: specs.initialMargin,
    commissionRate: commRate,
    maxMarginPercent: parseFloat(profile.maxMarginPercent) || 30,
    instrumentType,
  });
  // По правилам риска объём вполне может выйти нулевым: дорогой инструмент + широкий стоп
  // + небольшой депозит. Для НАСТОЯЩЕЙ торговли это честный отказ — денег на такую позицию
  // действительно нет, и округление вниз тут защита, а не придирка.
  //
  // Но бумажная сделка денег не тратит, а смысл её в наблюдении: трейдеру важно видеть,
  // сработала бы стратегия вообще. Реальный случай — фьючерс на индекс при небольшом
  // депозите вообще никогда не попадал в наблюдение, хотя условия по нему сходились.
  // Галочка в Настройках → «Бумажные сделки» разрешает открыть такой сигнал условным
  // объёмом в 1 контракт и пометить, что реально войти в него было бы нельзя.
  const ignoreRiskSizing = profile.alertPrefs?.paperIgnoreRiskSizing === true;
  const riskTooBig = !sizing || !(sizing.contracts > 0);
  if (riskTooBig && !ignoreRiskSizing) return { skipped: 'объём получился нулевым' };
  const volume = riskTooBig ? 1 : sizing.contracts;

  const paper = {
    ticker: item.ticker.toUpperCase(),
    instrumentType,
    direction,
    entryPrice,
    stopLoss: stopPrice,
    takeProfit: takePrice ?? null,
    volume,
    remainingVolume: volume,
    lot: specs.lot,
    minStep: specs.minStep,
    minStepAmount: specs.minStepAmount,
    commissionRate: commRate,
    status: 'open',
    openedAt: new Date(entryBar.date).toISOString(),
    entryTimeframe: tfKey,
    // Откуда взялась сделка — чтобы потом можно было честно разобрать каждую.
    entryStrategyId: strategy.id || null,
    entryStrategyName: strategy.name || null,
    entryPercent: Math.round(best.pct),
    entryPassed: best.passed,
    entryTotal: best.total,
    signalBarDate: new Date(signalBar.date).toISOString(),
    radarItemId: item.id,
    // Параметры контракта подтянуть не удалось — объём посчитан приблизительно.
    sizingApprox: specs.approx || undefined,
    // У стратегии стоп сознательно выключен: объём посчитан по ATR-порогу следящего
    // выхода, а не по реальной цене стопа (её нет, stopLoss выше — null). Пометка нужна,
    // чтобы при разборе сделки было видно, откуда взялся объём, если стопа не видно.
    sizingFromTrailAdverse: stopPrice == null || undefined,
    // Объём условный: по риску не набралось и одного контракта, сделка открыта только
    // ради наблюдения. Реально войти в неё при текущем депозите было бы нельзя — это
    // должно быть видно и в интерфейсе, и в уведомлении, чтобы результат такой сделки не
    // принимали за достижимый.
    riskTooBig: riskTooBig || undefined,
  };

  if (DRY) return { opened: paper, dry: true };
  await db.collection('paperTrades').add({
    ...paper,
    uid,
    paper: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { opened: paper };
}

async function main() {
  if (!FORCE && !anyMarketOpen()) {
    console.log('Все рынки закрыты — искать входы незачем.');
    return;
  }
  const db = initFirebase();
  const uids = (process.env.ALERT_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!uids.length) throw new Error('Нет ALERT_UIDS');

  for (const uid of uids) {
    const profile = (await db.collection('users').doc(uid).get()).data() || {};

    const radarSnap = await db.collection('radarItems').where('uid', '==', uid).get();
    const items = radarSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!items.length) { console.log(`[${uid}] радар пуст`); continue; }

    // Уже открытые бумажные — чтобы не заводить вторую по тому же тикеру.
    const paperSnap = await db.collection('paperTrades')
      .where('uid', '==', uid)
      .where('status', 'in', ['open', 'partial'])
      .get();
    const openTickers = new Set(paperSnap.docs.map((d) => String(d.data().ticker || '').toUpperCase()));

    // Настоящие сделки нужны только для корзин портфеля: капитал стратегии считается по
    // ним, и без них риск считался бы от всего депозита вместо доли корзины.
    const tradesSnap = await db.collection('trades').where('uid', '==', uid).get();
    const allTrades = tradesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    console.log(`[${uid}] в радаре ${items.length}, открытых бумажных ${openTickers.size}`);
    for (const item of items) {
      try {
        const res = await checkItem({ db, uid, profile, item, openTickers, allTrades });
        if (res.opened) {
          const o = res.opened;
          openTickers.add(o.ticker);
          const stopLabel = o.stopLoss != null ? o.stopLoss : (o.sizingFromTrailAdverse ? 'нет — следящий выход' : '—');
          console.log(
            `[${uid}] ${res.dry ? 'ОТКРЫЛ БЫ' : 'открыл'} ${o.ticker} ${o.direction} `
            + `${o.volume} по ${o.entryPrice} (стоп ${stopLabel}, цель ${o.takeProfit ?? '—'}, `
            + `условия ${o.entryPassed}/${o.entryTotal})${o.sizingApprox ? ' [объём приблизительный]' : ''}`
            + `${o.riskTooBig ? ' [денег на эту сделку не хватило бы — объём условный]' : ''}`,
          );
        } else {
          console.log(`[${uid}] ${item.ticker}: ${res.skipped}`);
        }
      } catch (e) {
        console.error(`[${uid}] ${item.ticker}: ${e.message}`);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
