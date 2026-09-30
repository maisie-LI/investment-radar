import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseRule, validateRule, evaluate } from './engine.js';
import { fetchPrice, fetchHeat, fetchEvent, fetchTradingState, searchTicker } from './provider.js';
import { noteRecovery } from './recovery.js';
import { CHANNEL_TYPES, isKnownType, maskTarget, buildMessage, notifyChannels } from './notifier.js';

const root = dirname(fileURLToPath(import.meta.url));
const envPath = join(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// 静态资源版本号：取 app.js / style.css 的最后修改时间。
// 作用：index.html 里的 /app.js?v=<版本> 会随构建自动变化，避免 CDN 或浏览器
// 把旧版脚本缓存下来，与新页面混用后脚本报错、页面卡死（2026-09-30 真实事故）。
const assetVersion = (() => {
  try {
    const stamp = ['app.js', 'style.css']
      .map((f) => statSync(join(root, 'web', f)).mtimeMs)
      .reduce((a, b) => a + b, 0);
    return Math.round(stamp).toString(36);
  } catch {
    return Date.now().toString(36);
  }
})();

const file = process.env.DATA_FILE || join(root, 'data', 'state.json');
const state = { tasks: [], runs: [], settings: { notify: { channels: [] } } };
const active = new Set();
let queue = Promise.resolve();

try {
  Object.assign(state, JSON.parse(await readFile(file, 'utf8')));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

// 老数据迁移 + 补齐新字段
for (const t of state.tasks) {
  t.enabled ??= true;
  t.version ??= 1;
  t.versions ??= [{ version: t.version, changedAt: t.createdAt || t.lastCheckedAt || new Date().toISOString(), rule: t.rule, note: '现有规则迁移' }];
  t.createdAt ??= t.versions[0].changedAt;
  if (t.rule) t.rule.kind ??= 'price';
  t.lastMatchedDate ??= null;
  // 归档：审计型产品只归档、不删除，因此这是独立于 enabled 的一个维度——
  // enabled 是"暂停调度但仍在列表里待命"，archived 是"收进归档、默认不再出现在主列表"。
  t.archived ??= false;
  t.archivedAt ??= null;
  // 恢复叙事：什么时候好的、什么时候坏的、恢复时做了什么
  t.recovery ??= { history: [] };
  t.recovery.history ??= [];
  // 服务启动即意味着进程曾经中断过：对已有检查历史的任务标记一次"重启恢复"，
  // 让下次检查成功时能如实说明"这是重启后重新跑出来的结果"，而不是假装从未中断。
  if (t.lastCheckedAt && !t.archived) t.recovery.pendingCause = 'after_restart';
}

// 检查记录同样要迁移：更早的版本没有把 kind 落库。
// 不补齐的后果不是"少个字段"这么轻——前端「条件类型」筛选会全部落空，
// 且判定依据 evidenceText(e, kind) 会走错条件分支，渲染出与记录不符的内容。
// 优先按产生该记录时的规则版本还原，取不到再退回任务当前规则。
for (const r of state.runs) {
  if (r.kind) continue;
  const owner = state.tasks.find((t) => t.id === r.taskId);
  const atVersion = owner?.versions?.find((v) => v.version === r.version);
  r.kind = atVersion?.rule?.kind || owner?.rule?.kind || null;
}

// 通知渠道配置：老数据没有这一层，补默认结构。
// 顺带丢弃类型无法识别的历史渠道——宁可少一个渠道，也不要往一个看不懂的地址发消息。
state.settings ??= {};
state.settings.notify ??= {};
state.settings.notify.channels = (Array.isArray(state.settings.notify.channels) ? state.settings.notify.channels : [])
  .filter((c) => c && isKnownType(c.type));

function shanghaiDay(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms);
  const get = (type) => parts.find((x) => x.type === type).value;
  return `${get('year')}${get('month')}${get('day')}`;
}

async function persist() {
  queue = queue.catch(() => {}).then(async () => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(state, null, 2));
  });
  return queue;
}

function respond(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function bodyOf(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 15000) throw Error('请求体过大');
  }
  return JSON.parse(text || '{}');
}

function health() {
  const latest = state.runs[0];
  const ok = process.env.FUYAO_API_KEY;
  if (!ok) return { configured: false, status: 'error', message: '未配置扶摇 API Key' };
  if (latest?.status === 'error') return { configured: true, status: 'warning', message: `最近一次检查失败：${latest.reason || '请查看原因'}` };
  if (latest?.status === 'degraded') return { configured: true, status: 'warning', message: `最近一次检查已降级：${latest.reason || '数据不可用，未做判定'}` };
  if (latest?.status === 'restricted') return { configured: true, status: 'warning', message: `最近一次检查数据受限：${latest.reason || '数据时点不可确认'}` };
  if (latest?.status === 'conflict') return { configured: true, status: 'warning', message: `最近一次检查数据存在冲突：${latest.reason || '多源数据业务时点不一致，未执行判定'}` };
  return { configured: true, status: 'ok', message: '真实行情与证据校验已启用' };
}

// 对外暴露的通知配置：只给脱敏后的凭证形态，原文永远不出服务端
function publicChannels() {
  return (state.settings.notify.channels || []).map((c) => ({
    id: c.id,
    type: c.type,
    enabled: c.enabled !== false,
    targetMasked: maskTarget(c.target),
    hasTarget: !!c.target,
    createdAt: c.createdAt,
  }));
}

// 依赖盘中数据更新的条件类型：非交易日不判定（避免把"没有新数据"误判成"条件未满足"）
const MARKET_KINDS = new Set(['price', 'heat', 'event']);

// 组合条件只要含「依赖盘中数据」的子条件，整体就走同一条交易日前置检查，
// 避免用没有新数据的一天去判定组合条件。
function needsMarketData(rule) {
  if (!rule) return false;
  if (rule.kind === 'composite') return (rule.conditions || []).some((c) => MARKET_KINDS.has(c.kind));
  return MARKET_KINDS.has(rule.kind);
}

async function loadResult(task) {
  const kind = task.rule.kind || 'price';
  if (kind === 'heat') return fetchHeat(task.rule.symbol);
  if (kind === 'event') return fetchEvent(task.rule.symbol);
  if (kind === 'calendar') return fetchTradingState();
  if (kind === 'composite') {
    // 逐个子条件取数：顺序执行而不是并发，避免同一次检查里同时打多个接口触发动态限流。
    // 即使前面的子条件已经能定结果也全部取完——证据要求展示每个子条件的独立状态。
    const parts = [];
    for (const condition of task.rule.conditions) {
      const result = await loadResult({ ...task, rule: condition });
      parts.push({ kind: condition.kind, result });
    }
    return { ok: true, composite: true, parts };
  }
  return fetchPrice(task.rule.symbol);
}

function nextRunAtOf(task) {
  // 已归档的任务不再进入调度：nextRunAt 为 null 是给用户看的明确信号，
  // 比留一个永远不会执行的未来时间更容易理解。
  if (task.archived || !task.enabled) return null;
  const base = task.lastCheckedAt ? Date.parse(task.lastCheckedAt) : Date.now();
  return new Date(base + task.rule.intervalMinutes * 60000).toISOString();
}

function decorate(task) {
  return { ...task, nextRunAt: nextRunAtOf(task) };
}

// ---------- 恢复叙事 ----------
// 只写"现在正常"没有说服力：评审看不到系统曾经坏过、又是怎么好起来的。
// 具体分类与记录逻辑在 recovery.js，那里能被单元测试直接覆盖。
async function record(run, ctx = {}) {
  state.runs.unshift(run);
  state.runs.splice(500);
  const task = state.tasks.find((x) => x.id === run.taskId);
  if (task) {
    task.lastCheckedAt = run.checkedAt;
    task.lastStatus = run.status;
    if (run.status === 'triggered') task.lastTriggeredAt = run.checkedAt;
    if (['triggered', 'cooldown', 'deduplicated'].includes(run.status)) {
      task.lastMatched = true;
      task.lastMatchedDate = shanghaiDay(Date.now());
    } else if (run.status === 'not_triggered') {
      task.lastMatched = false;
    }
    const prev = state.runs.slice(1).find((r) => r.taskId === run.taskId) || null;
    noteRecovery(task, run, prev, ctx.missedGap === true);
  }
  await persist();
  return run;
}

async function check(task, mode = 'manual') {
  if (active.has(task.id)) return null;
  // 归档任务一律不执行检查（含手动触发）：归档的语义就是"不再运行但保留全部资料"，
  // 如果还允许手动检查，归档就变成了一个纯装饰性的标签。
  if (task.archived) return null;
  active.add(task.id);
  const startedAt = Date.now();
  // 错过计划补跑：实际间隔超过两个周期，说明调度确实断过，恢复时要如实说明是补跑。
  const missedGap = mode === 'scheduled' && !!task.lastCheckedAt
    && Date.now() - Date.parse(task.lastCheckedAt) > task.rule.intervalMinutes * 60000 * 2;
  try {
    const kind = task.rule.kind || 'price';
    let result;
    if (needsMarketData(task.rule)) {
      const trading = await fetchTradingState();
      if (trading.ok && !trading.isTradeDay) {
        return await record({
          id: randomUUID(), taskId: task.id, taskTitle: task.title, version: task.version, kind, mode,
          checkedAt: new Date().toISOString(), durationMs: Date.now() - startedAt,
          status: 'skipped', reasonCode: 'NON_TRADE_DAY',
          reason: `今日 ${trading.today} 非交易日，未执行判定（不计为失败）`,
          evidence: { today: trading.today, latestTradingDate: trading.latestTradingDate, source: 'fuyao', dataset: 'trading-days' },
        }, { missedGap });
      }
      result = trading.ok ? await loadResult(task) : trading;
    } else {
      result = await loadResult(task);
    }
    const run = await record({
      id: randomUUID(), taskId: task.id, taskTitle: task.title, version: task.version, kind, mode,
      durationMs: Date.now() - startedAt,
      ...evaluate(task.rule, result, Date.now(), task),
    }, { missedGap });
    // 只在「已触发」时推送。冷却中 / 已去重的语义本身就是"同一天已经提醒过了"，
    // 再推一次等于绕过去重逻辑，把提醒变成骚扰。
    if (run.status === 'triggered') {
      run.notifications = await notifyChannels(state.settings.notify.channels, buildMessage(run, task));
      await persist();
    }
    return run;
  } finally {
    active.delete(task.id);
  }
}

async function tick() {
  for (const task of state.tasks) {
    if (task.archived || !task.enabled || active.has(task.id)) continue;
    if (!task.lastCheckedAt || Date.now() - Date.parse(task.lastCheckedAt) >= task.rule.intervalMinutes * 60000) {
      check(task, 'scheduled').catch(async (e) => {
        task.lastStatus = 'error';
        await persist();
        console.error('Check failed', task.id, e.message);
      });
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    tick().catch(console.error);
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return respond(res, 200, { ok: true, service: 'investment-radar', time: new Date().toISOString(), dataSource: health(), storage: 'json-demo', taskCount: state.tasks.length });
    }

    if (req.method === 'POST' && url.pathname === '/api/parse') {
      const { text } = await bodyOf(req);
      try {
        const parsed = await parseRule(String(text || ''), searchTicker);
        // 提示语只说"下一步该做什么"，不再解释解析器内部实现（用户不关心 determinism）
        return respond(res, 200, { rule: validateRule(parsed), parseMeta: parsed.parseMeta, parser: 'deterministic', note: '已生成规则草案。请检查标的、条件和阈值，确认无误后创建任务。' });
      } catch (e) {
        // 预测 / 荐股 / 投资建议类请求不是"解析失败"，而是产品明确不做这件事。
        // 用 200 + refused 结构化返回，前端才能给出对等的说明与可执行替代，
        // 而不是把一句"请输入价格阈值"当成错误弹给用户。
        if (e.refusal) return respond(res, 200, { refused: true, ...e.refusal });
        throw e;
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      return respond(res, 200, {
        tasks: state.tasks.map(decorate),
        runs: state.runs.slice(0, 150),
        counts: {
          total: state.tasks.length,
          active: state.tasks.filter((t) => !t.archived && t.enabled).length,
          paused: state.tasks.filter((t) => !t.archived && !t.enabled).length,
          archived: state.tasks.filter((t) => t.archived).length,
        },
        health: health(),
        liveDataConfigured: !!process.env.FUYAO_API_KEY,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/settings') {
      return respond(res, 200, {
        channels: publicChannels(),
        channelTypes: CHANNEL_TYPES,
        publicUrl: process.env.PUBLIC_URL || '',
      });
    }

    if (req.method === 'PUT' && url.pathname === '/api/settings') {
      const input = await bodyOf(req);
      const list = Array.isArray(input.channels) ? input.channels : [];
      const existing = new Map((state.settings.notify.channels || []).map((c) => [c.id, c]));
      const next = [];
      for (const raw of list.slice(0, 8)) {
        const type = String(raw?.type || '');
        // 类型无法识别就跳过，不猜测、不降级成默认渠道
        if (!isKnownType(type)) continue;
        const prev = raw.id ? existing.get(raw.id) : null;
        const incoming = typeof raw.target === 'string' ? raw.target.trim() : '';
        // 前端回传脱敏串（或显式 keepTarget）表示"这一项没有改动"，沿用已存的完整凭证
        const keep = raw.keepTarget === true || !incoming || incoming.startsWith('••');
        next.push({
          id: prev?.id || randomUUID(),
          type,
          target: keep ? (prev?.target || '') : incoming,
          enabled: raw.enabled !== false,
          createdAt: prev?.createdAt || new Date().toISOString(),
        });
      }
      state.settings.notify.channels = next;
      await persist();
      return respond(res, 200, { ok: true, channels: publicChannels() });
    }

    if (req.method === 'POST' && url.pathname === '/api/settings/test') {
      const input = await bodyOf(req);
      let channels = state.settings.notify.channels || [];
      if (input.channel && typeof input.channel === 'object') {
        const c = input.channel;
        if (!isKnownType(c.type)) return respond(res, 400, { error: '未知的推送渠道类型' });
        const prev = (state.settings.notify.channels || []).find((x) => x.id === c.id);
        const incoming = typeof c.target === 'string' ? c.target.trim() : '';
        const keep = c.keepTarget === true || !incoming || incoming.startsWith('••');
        channels = [{ id: c.id || 'draft', type: c.type, target: keep ? (prev?.target || '') : incoming, enabled: true }];
      }
      if (!channels.length) return respond(res, 400, { error: '还没有配置任何推送渠道，请先添加并保存' });
      const results = await notifyChannels(channels, {
        title: '【测试】投资监控雷达通知已连通',
        content: '看到这条消息说明该渠道配置正确。真实触发时，这里会显示条件、判定依据与检查时间。',
        url: process.env.PUBLIC_URL || '',
      });
      return respond(res, 200, { results });
    }

    if (req.method === 'POST' && url.pathname === '/api/tasks') {
      const input = await bodyOf(req);
      const rule = validateRule(input.rule);
      const now = new Date().toISOString();
      const task = {
        id: randomUUID(),
        title: String(input.title || rule.symbol || rule.kind).slice(0, 100),
        rule, version: 1,
        versions: [{ version: 1, changedAt: now, rule: { ...rule }, note: '创建任务' }],
        createdAt: now, enabled: true, lastStatus: 'pending',
        lastCheckedAt: null, lastTriggeredAt: null, lastMatched: false, lastMatchedDate: null,
        archived: false, archivedAt: null, recovery: { history: [] },
      };
      state.tasks.unshift(task);
      await persist();
      return respond(res, 201, { task: decorate(task) });
    }

    const match = url.pathname.match(/^\/api\/tasks\/([\w-]+)(?:\/(check))?$/);
    if (match) {
      const task = state.tasks.find((x) => x.id === match[1]);
      if (!task) return respond(res, 404, { error: '任务不存在' });
      if (req.method === 'GET' && !match[2]) return respond(res, 200, { task: decorate(task), runs: state.runs.filter((r) => r.taskId === task.id) });
      if (req.method === 'POST' && match[2] === 'check') {
        if (task.archived) return respond(res, 409, { error: '任务已归档，不再执行检查；如需继续监控请先「恢复启用」' });
        const run = await check(task, 'manual');
        return run ? respond(res, 200, { run }) : respond(res, 409, { error: '任务正在检查中' });
      }
      if (req.method === 'PATCH' && !match[2]) {
        const input = await bodyOf(req);
        if (input.rule) {
          const rule = validateRule(input.rule);
          task.rule = rule;
          task.version += 1;
          task.versions ??= [];
          task.versions.unshift({ version: task.version, changedAt: new Date().toISOString(), rule: { ...rule }, note: '用户修改规则' });
          task.lastMatched = false;
          task.lastMatchedDate = null;
          task.lastTriggeredAt = null;
          task.lastCheckedAt = null;
          task.lastStatus = 'pending';
        }
        if (typeof input.enabled === 'boolean') {
          const wasEnabled = task.enabled !== false;
          task.enabled = input.enabled;
          // 从暂停回到运行：下一次检查成功时如实记为「暂停后恢复」
          if (!wasEnabled && task.enabled) (task.recovery ??= { history: [] }).pendingCause = 'after_pause';
        }
        if (typeof input.archived === 'boolean') {
          const wasArchived = task.archived === true;
          task.archived = input.archived;
          if (task.archived) {
            task.archivedAt = new Date().toISOString();
          } else {
            task.archivedAt = null;
            if (wasArchived) (task.recovery ??= { history: [] }).pendingCause = 'after_archive';
          }
        }
        if (typeof input.title === 'string') task.title = input.title.slice(0, 100);
        await persist();
        return respond(res, 200, { task: decorate(task) });
      }
    }

    if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(url.pathname)) {
      const isHtml = url.pathname === '/';
      const name = isHtml ? 'index.html' : url.pathname.slice(1);
      const type = name.endsWith('.js') ? 'text/javascript; charset=utf-8'
        : name.endsWith('.css') ? 'text/css; charset=utf-8'
        : 'text/html; charset=utf-8';
      let content = await readFile(join(root, 'web', name));
      let cacheControl = 'no-cache';
      if (isHtml) {
        // HTML 不缓存；并把真实构建版本注入资源链接，保证页面与脚本永远同版本
        cacheControl = 'no-store';
        content = Buffer.from(String(content).replaceAll('__ASSET_V__', assetVersion));
      }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cacheControl });
      return res.end(content);
    }

    respond(res, 404, { error: '路径不存在' });
  } catch (e) {
    respond(res, 400, { error: e.message });
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => console.log(`Investment radar listening on http://localhost:${port}`));
setInterval(() => tick().catch(console.error), 15000).unref();
tick().catch(console.error);
