import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPriceTimeConflict } from '../provider.js';
import { evaluate, REASONS, INCONCLUSIVE, NO_DECISION_TEXT } from '../engine.js';

const PRICE_RULE = { kind: 'price', symbol: '600519.SH', operator: 'below', threshold: 1400, intervalMinutes: 5, cooldownMinutes: 60 };

// ---------- 一、时点自洽性判据 ----------

// 这一条就是 README / 界面口径里写的演示场景，把它固化成可重复执行的用例
test('演示场景：快照业务时点 09-29、日线最新收盘 09-30 → 数据冲突', () => {
  const c = detectPriceTimeConflict({
    snapshotDate: '20260929',
    snapshotDateLabel: '2026-09-29 14:55',
    klineDate: '20260930',
    today: '20260930',
  });
  assert.ok(c, '两份数据业务时点不同时必须判为冲突');
  assert.equal(c.code, 'snapshot_older_than_kline');
  assert.match(c.reason, /实时快照与日线数据所属时点不同/);
  assert.match(c.reason, /2026-09-29 14:55/, '原因里要写清快照的业务时点');
  assert.match(c.reason, /2026-09-30/, '原因里要写清日线的业务时点');
});

test('盘中正常情形不判冲突：快照属今日、日线属上一交易日', () => {
  const c = detectPriceTimeConflict({
    snapshotDate: '20260930',
    snapshotDateLabel: '2026-09-30 10:30',
    klineDate: '20260929',
    today: '20260930',
  });
  assert.equal(c, null, '盘中快照比日线新是设计内的正常状态，不能报警');
});

test('非盘中正常情形不判冲突：快照与日线属同一交易日', () => {
  const c = detectPriceTimeConflict({
    snapshotDate: '20260930',
    snapshotDateLabel: '2026-09-30 16:10',
    klineDate: '20260930',
    today: '20260930',
  });
  assert.equal(c, null);
});

test('日线日期晚于今天 → 判为冲突（未来数据）', () => {
  const c = detectPriceTimeConflict({ snapshotDate: '20260930', snapshotDateLabel: null, klineDate: '20261001', today: '20260930' });
  assert.ok(c);
  assert.equal(c.code, 'kline_in_future');
  assert.match(c.reason, /无法对齐/);
});

test('快照业务时点缺失时不做推断：没有时点就不编一个时点出来判冲突', () => {
  const c = detectPriceTimeConflict({ snapshotDate: null, snapshotDateLabel: null, klineDate: '20260930', today: '20260930' });
  assert.equal(c, null, '取不到快照时点时，冲突判据必须放弃而不是猜');
});

test('日线日期缺失时不做判定', () => {
  assert.equal(detectPriceTimeConflict({ snapshotDate: '20260929', klineDate: null, today: '20260930' }), null);
});

// ---------- 二、价格差异本身不是冲突 ----------

test('价格不同不是冲突：盘中快照 1398 元、昨收 1412 元，时点自洽即正常判定', () => {
  const result = {
    ok: true, price: 1398, volume: 12345, historicalClose: 1412,
    marketDate: '20260929', fetchedAt: Date.now(),
    snapshotAsOf: '2026-09-30 10:30', snapshotAsOfSource: 'api_timestamp',
    asOf: '20260929', asOfSource: 'kline_date', timeConflict: null,
  };
  const run = evaluate(PRICE_RULE, result, Date.now(), {});
  assert.notEqual(run.status, 'conflict', '数值差异被当成冲突会让系统天天报警');
  assert.equal(run.status, 'triggered');
  assert.equal(run.evidence.price, 1398);
  assert.equal(run.evidence.historicalClose, 1412);
});

// ---------- 三、冲突状态的结构化输出 ----------

test('冲突时输出独立状态，且绝不输出「触发 / 未触发」', () => {
  const result = {
    ok: false, conflict: true, reasonCode: 'DATA_CONFLICT',
    error: '实时快照与日线数据所属时点不同（快照业务时点 2026-09-29 14:55，日线最新收盘 2026-09-30）',
    advice: '等待下一次检查或手动重试',
    evidence: {
      snapshotPrice: 1398, historicalClose: 1412,
      snapshotAsOf: '2026-09-29 14:55', snapshotAsOfSource: 'api_timestamp',
      klineDate: '20260930', conflictCode: 'snapshot_older_than_kline',
    },
  };
  const run = evaluate(PRICE_RULE, result, Date.now(), {});
  assert.equal(run.status, 'conflict');
  assert.equal(run.reasonCode, 'DATA_CONFLICT');
  assert.equal(REASONS.DATA_CONFLICT, '数据存在冲突');
  assert.ok(!['triggered', 'not_triggered', 'degraded', 'error'].includes(run.status), '冲突必须是独立状态，不能被归到相近语义里');
  assert.equal(run.decision, NO_DECISION_TEXT);
  assert.equal(run.reason, result.error);
  assert.equal(run.advice, '等待下一次检查或手动重试');
  assert.equal(run.evidence.snapshotPrice, 1398);
  assert.equal(run.evidence.historicalClose, 1412);
  assert.ok(INCONCLUSIVE.has('conflict'), '冲突必须被归类为"无法给出结论"');
});

test('红线：冲突不得携带任何"条件满足 / 未满足"的措辞', () => {
  const result = { ok: false, conflict: true, reasonCode: 'DATA_CONFLICT', error: '实时快照与日线数据所属时点不同', evidence: {} };
  const run = evaluate(PRICE_RULE, result, Date.now(), {});
  const text = `${run.reason}${run.decision}${run.advice}`;
  assert.ok(!/条件满足|条件未满足|未触发/.test(text), `冲突文案不得出现结论性措辞：${text}`);
  assert.match(run.decision, /本次未执行条件判断/);
});

test('缺省建议也必须存在：用户要知道下一步做什么', () => {
  const result = { ok: false, conflict: true, reasonCode: 'DATA_CONFLICT', error: '实时快照与日线数据所属时点不同' };
  const run = evaluate(PRICE_RULE, result, Date.now(), {});
  assert.equal(run.advice, '等待下一次检查或手动重试');
});

// ---------- 四、组合条件里的冲突 ----------

test('组合条件中任一子条件冲突 → 整体降级且不强行判定，另一个子条件的结论照常保留', () => {
  const rule = {
    kind: 'composite', logic: 'AND', intervalMinutes: 5, cooldownMinutes: 240,
    conditions: [
      { kind: 'price', symbol: '600519.SH', operator: 'below', threshold: 1400 },
      { kind: 'heat', symbol: '600519.SH', operator: 'in_top', threshold: 10 },
    ],
  };
  const result = {
    ok: true, composite: true,
    parts: [
      { kind: 'price', result: { ok: false, conflict: true, reasonCode: 'DATA_CONFLICT', error: '实时快照与日线数据所属时点不同（快照 2026-09-29 14:55，日线 2026-09-30）' } },
      { kind: 'heat', result: { ok: true, inList: true, rank: 3, listSize: 30, fetchedAt: Date.now(), dataTimeStatus: 'fetch_time', requestId: 'r-heat' } },
    ],
  };
  const run = evaluate(rule, result, Date.now(), {});
  assert.equal(run.status, 'degraded');
  assert.match(run.reason, /不强行判定/);
  assert.equal(run.evidence.parts[0].status, 'conflict');
  assert.equal(run.evidence.parts[1].status, 'satisfied', '另一个子条件的独立结论必须保留，不能被整体抹掉');
  assert.equal(run.decision, NO_DECISION_TEXT);
});

// ---------- 五、与既有状态的边界 ----------

test('单纯取不到数据仍然记「已降级」，不会被误升级成「数据冲突」', () => {
  const run = evaluate(PRICE_RULE, { ok: false, degraded: true, reasonCode: 'DATA_STALE', error: '历史行情落后' }, Date.now(), {});
  assert.equal(run.status, 'degraded');
});

test('真正的接口错误仍然记「检查失败」，不会被误升级成「数据冲突」', () => {
  const run = evaluate(PRICE_RULE, { ok: false, reasonCode: 'SOURCE_ERROR', error: '扶摇接口请求超时' }, Date.now(), {});
  assert.equal(run.status, 'error');
});
