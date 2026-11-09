// scripts/alerts/gate.mjs
//
// Ворота прохода робота: «этот проход уже сделал соседний будильник — пропускаем».
//
// Зачем. Робота будят два-три независимых будильника (Cloudflare Cron, cron-job.org, расписание GitHub), и в :00/:15/:30/:45 они бьют
// почти одновременно — запускается ДВА одинаковых прохода подряд (очередь concurrency ставит их друг за другом). Второй проход ничего нового
// не делает, но заново читает базу. На бесплатном тарифе Firebase (50 000 чтений в сутки) это вдвое ускоряло исчерпание лимита, после чего
// все шаги падали (письма «Run failed» от GitHub, утренняя сводка после 11:00 — см. lib/quota.mjs).
//
// Как решает. Берёт список последних запусков этого workflow и смотрит: нет ли запуска, который (а) создан раньше текущего,
// (б) создан не более 4 минут назад (то есть от того же «удара» будильников) и (в) уже завершён. Если есть — пишет skip=true,
// и все следующие шаги в workflow пропускаются. Любая трудность (нет сети, нет токена, странный ответ) — skip=false: лучше сделать лишний проход, чем пропустить нужный.
// Ручной запуск с галочкой «Проверить даже вне торговой сессии» (force) пропускать нельзя.
//
// Окружение: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_OUTPUT (даёт GitHub), FORCE ('true' при ручном запуске с force).
import fs from 'fs';
import { pathToFileURL } from 'url';

export const TWIN_WINDOW_MS = 4 * 60 * 1000;

/**
 * Упавший сосед считается проходом, только если у него были задания (ranJobs — id запусков, у которых они есть): бывает, что GitHub
 * сам роняет запуск «Internal server error» ещё до первого шага (2026-11-09 18:15) — тогда прохода не было, и этот запуск обязан его сделать.
 * @param {{runs: Array<{id:number, created_at:string, status:string, conclusion:string|null}>, runId:number, windowMs?:number, ranJobs?:Set<number>}} a
 * @returns {{skip:boolean, reason:string, twin?:number}}
 */
export function decideSkip({ runs, runId, windowMs = TWIN_WINDOW_MS, ranJobs = new Set() }) {
  const me = (runs || []).find((r) => Number(r.id) === Number(runId));
  if (!me) return { skip: false, reason: 'свой запуск в списке не найден' };
  const mine = Date.parse(me.created_at);
  if (!Number.isFinite(mine)) return { skip: false, reason: 'время своего запуска не разобрано' };
  const twin = (runs || []).find((r) => {
    if (!(Number(r.id) < Number(runId))) return false;
    if (r.status !== 'completed' || !['success', 'failure'].includes(r.conclusion)) return false;
    if (r.conclusion === 'failure' && !ranJobs.has(Number(r.id))) return false;
    const t = Date.parse(r.created_at);
    return Number.isFinite(t) && mine - t >= 0 && mine - t < windowMs;
  });
  return twin
    ? { skip: true, reason: `проход уже сделал запуск ${twin.id} (создан ${Math.round((mine - Date.parse(twin.created_at)) / 1000)} с назад)`, twin: twin.id }
    : { skip: false, reason: 'соседних проходов нет' };
}

async function main() {
  const out = (skip) => { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `skip=${skip}\n`); };
  if (process.env.FORCE === 'true') { console.log('Ручной запуск «даже вне сессии» — проход не пропускаем.'); out(false); return; }
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId } = process.env;
  if (!token || !repo || !runId) { console.log('Нет данных GitHub — проход не пропускаем.'); out(false); return; }
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/traderpro-alerts.yml/runs?per_page=20`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'traderpro-gate' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const runs = (await res.json()).workflow_runs;
    // У упавших «соседей» (создан раньше, в пределах окна) проверяем, были ли вообще задания.
    const mineRun = runs.find((r) => Number(r.id) === Number(runId));
    const mine = mineRun ? Date.parse(mineRun.created_at) : NaN;
    const ranJobs = new Set();
    for (const r of runs) {
      const t = Date.parse(r.created_at);
      if (Number(r.id) < Number(runId) && r.status === 'completed' && r.conclusion === 'failure' && Number.isFinite(mine) && mine - t >= 0 && mine - t < TWIN_WINDOW_MS) {
        try {
          const jr = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${r.id}/jobs`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'traderpro-gate' }, signal: AbortSignal.timeout(15000) });
          if (jr.ok && ((await jr.json()).total_count || 0) > 0) ranJobs.add(Number(r.id));
        } catch { /* не удалось проверить — сосед не считается проходом */ }
      }
    }
    const verdict = decideSkip({ runs, runId: Number(runId), ranJobs });
    console.log(verdict.reason);
    if (verdict.skip) console.log('::notice title=Дубль прохода::Этот проход уже сделал соседний будильник — пропускаю, чтобы не тратить лимит чтений базы.');
    out(verdict.skip);
  } catch (e) {
    console.log(`Не удалось проверить соседние запуски (${e.message}) — проход не пропускаем.`);
    out(false);
  }
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) main();
