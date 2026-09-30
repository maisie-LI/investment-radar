import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRule, validateRule, evaluate } from '../engine.js';

const PRICE_RESULT = {
  ok: true, price: 100, volume: 10, turnover: 1000, fetchedAt: Date.now(),
  marketDate: '20260929', latestTradingDate: '20260929', requestId: 'req-p',
  sessionLabel: '交易时段实时快照', priceField: 'last_price',
  historicalClose: 99, historicalAdjust: 'forward', changeRatioPct: 1.2, prevClose: 98.8,
  asOf: '20260929', asOfSource: 'kline_date', attempts: 1,
};
const HEAT_RESULT = {
  ok: true, inList: true, rank: 3, heat: 4042688, name: '贵州茅台', listSize: 30,
  topName: '万科A', fetchedAt: Date.now(), requestId: 'req-h', attempts: 1,
  asOf: null, asOfSource: 'unavailable',
};
const HEAT_ABSENT = { ...HEAT_RESULT, inList: false, rank: null, heat: null, name: null };
const EVENT_RESULT = {
  ok: true, matched: true, tagName: '跌停', keywords: ['粮食板块下跌', '此前涨幅较大'],
  analysis: '归因文本', listSize: 175, fetchedAt: Date.now(), requestId: 'req-e', attempts: 1,
  asOf: '2026-09-30T06:56:00.000Z', asOfSource: 'api_timestamp',
};
const CALENDAR_RESULT = {
  ok: true, today: '20260930', isTradeDay: true, latestTradingDate: '20260930',
  previousTradingDate: '20260929', sessionLabel: '交易时段实时快照', fetchedAt: Date.now(),
  requestId: 'req-c', attempts: 1, asOf: '20260930', asOfSource: 'trading_calendar',
};
const resolveOne = async () => ({ ok: true, candidates: [{ symbol: '600519.SH', name: '贵州茅台' }] });
const shanghaiDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms).replace(/-/g, '');

// ---------- 解析 ----------
test('解析带后缀价格规则', async () => {
  const r = await parseRule('当 600519.SH 高于 1500 时提醒我');
  assert.equal(r.kind, 'price');
  assert.equal(r.symbol, '600519.SH');
  assert.equal(r.operator, 'above');
  assert.equal(r.threshold, 1500);
});
test('解析无后缀代码', async () => {
  const r = await parseRule('600519 高于 1500');
  assert.equal(r.symbol, '600519.SH');
});
test('中文名通过唯一检索结果解析', async () => {
  const r = await parseRule('茅台跌破1400', resolveOne);
  assert.equal(r.symbol, '600519.SH');
  assert.equal(r.parseMeta.channel, 'ticker_search');
});
test('中文名多候选不得自动猜测', async () => {
  await assert.rejects(() => parseRule('银行低于10', async () => ({ ok: true, candidates: [{ symbol: '000001.SZ', name: '平安银行' }, { symbol: '600000.SH', name: '浦发银行' }] })), /多个可能标的/);
});
test('解析热度条件（含中文数字）', async () => {
  const r = await parseRule('贵州茅台进入热榜前十', resolveOne);
  assert.equal(r.kind, 'heat');
  assert.equal(r.symbol, '600519.SH');
  assert.equal(r.operator, 'in_top');
  assert.equal(r.threshold, 10);
});
test('解析事件条件', async () => {
  const r = await parseRule('茅台出现跌停异动时提醒我', resolveOne);
  assert.equal(r.kind, 'event');
  assert.equal(r.symbol, '600519.SH');
  assert.equal(r.operator, 'contains');
  assert.equal(r.threshold, '跌停');
});
test('解析日历条件', async () => {
  const r = await parseRule('提醒我今天是不是交易日');
  assert.equal(r.kind, 'calendar');
  assert.equal(r.operator, 'is_trade_day');
});

// ---------- 校验 ----------
test('组合条件被明确拒绝并给出拆分指引', () => {
  assert.throws(() => validateRule({ kind: 'composite', intervalMinutes: 5, cooldownMinutes: 60 }), /组合条件/);
});
test('四类条件均可通过校验', () => {
  assert.doesNotThrow(() => validateRule({ kind: 'price', symbol: '600519.SH', operator: 'above', threshold: 1500, intervalMinutes: 5, cooldownMinutes: 60 }));
  assert.doesNotThrow(() => validateRule({ kind: 'heat', symbol: '600519.SH', operator: 'in_top', threshold: 10, intervalMinutes: 15, cooldownMinutes: 240 }));
  assert.doesNotThrow(() => validateRule({ kind: 'event', symbol: '600519.SH', operator: 'contains', threshold: '跌停', intervalMinutes: 15, cooldownMinutes: 240 }));
  assert.doesNotThrow(() => validateRule({ kind: 'calendar', symbol: null, operator: 'is_trade_day', threshold: null, intervalMinutes: 60, cooldownMinutes: 720 }));
});
test('热度名次越界被拒绝', () => {
  assert.throws(() => validateRule({ kind: 'heat', symbol: '600519.SH', operator: 'in_top', threshold: 0, intervalMinutes: 15, cooldownMinutes: 240 }), /名次/);
});
test('事件关键词为空被拒绝', () => {
  assert.throws(() => validateRule({ kind: 'event', symbol: '600519.SH', operator: 'contains', threshold: '   ', intervalMinutes: 15, cooldownMinutes: 240 }), /关键词/);
});
test('日历条件仅接受是/非交易日', () => {
  assert.throws(() => validateRule({ kind: 'calendar', symbol: null, operator: 'above', threshold: null, intervalMinutes: 60, cooldownMinutes: 720 }), /交易日/);
});

// ---------- 判定：价格与降级 ----------
test('数据失败不会变成未触发', () => {
  const r = evaluate({ kind: 'price', symbol: '600519.SH' }, { ok: false, error: '超时', reasonCode: 'SOURCE_ERROR' });
  assert.equal(r.status, 'error');
  assert.equal(r.reasonCode, 'SOURCE_ERROR');
});
test('过期数据进入降级', () => {
  const r = evaluate({ kind: 'price', symbol: '600519.SH' }, { ok: false, degraded: true, error: '落后交易日', reasonCode: 'DATA_STALE' });
  assert.equal(r.status, 'degraded');
  assert.equal(r.reasonCode, 'DATA_STALE');
});
test('未满足条件包含证据', () => {
  const r = evaluate({ kind: 'price', symbol: '600519.SH', operator: 'above', threshold: 101 }, PRICE_RESULT);
  assert.equal(r.status, 'not_triggered');
  assert.equal(r.evidence.marketDate, '20260929');
});
test('冷却和去重显式区分', () => {
  const now = Date.now();
  const rule = { kind: 'price', symbol: '600519.SH', operator: 'above', threshold: 99, cooldownMinutes: 60 };
  assert.equal(evaluate(rule, PRICE_RESULT, now, { lastMatched: true, lastTriggeredAt: new Date(now - 1000).toISOString() }).status, 'cooldown');
  assert.equal(evaluate(rule, PRICE_RESULT, now, { lastMatched: true, lastTriggeredAt: new Date(now - 3600000).toISOString() }).status, 'deduplicated');
});

// ---------- 判定：热度 / 事件 / 日历 ----------
test('热度：在榜且进入前 N 名触发', () => {
  const r = evaluate({ kind: 'heat', symbol: '600519.SH', operator: 'in_top', threshold: 10, cooldownMinutes: 240 }, HEAT_RESULT);
  assert.equal(r.status, 'triggered');
  assert.equal(r.evidence.rank, 3);
});
test('热度：在榜但未进入前 N 名为未触发', () => {
  const r = evaluate({ kind: 'heat', symbol: '600519.SH', operator: 'in_top', threshold: 2, cooldownMinutes: 240 }, HEAT_RESULT);
  assert.equal(r.status, 'not_triggered');
  assert.equal(r.reasonCode, 'CONDITION_NOT_MET');
});
test('热度：不在榜为未触发而非失败', () => {
  const r = evaluate({ kind: 'heat', symbol: '600519.SH', operator: 'in_top', threshold: 50, cooldownMinutes: 240 }, HEAT_ABSENT);
  assert.equal(r.status, 'not_triggered');
  assert.equal(r.evidence.inList, false);
});
test('事件：关键词命中触发', () => {
  const r = evaluate({ kind: 'event', symbol: '600519.SH', operator: 'contains', threshold: '跌停', cooldownMinutes: 240 }, EVENT_RESULT);
  assert.equal(r.status, 'triggered');
  assert.equal(r.evidence.tagName, '跌停');
});
test('事件：未命中关键词为未触发', () => {
  const r = evaluate({ kind: 'event', symbol: '600519.SH', operator: 'contains', threshold: '涨停', cooldownMinutes: 240 }, EVENT_RESULT);
  assert.equal(r.status, 'not_triggered');
});
test('日历：交易日命中、非交易日不命中', () => {
  assert.equal(evaluate({ kind: 'calendar', operator: 'is_trade_day', cooldownMinutes: 720 }, CALENDAR_RESULT).status, 'triggered');
  assert.equal(evaluate({ kind: 'calendar', operator: 'is_not_trade_day', cooldownMinutes: 720 }, CALENDAR_RESULT).status, 'not_triggered');
});

// ---------- 去重与冷却的交易日边界 ----------
test('同一交易日重复满足被去重，跨交易日可重新触发', () => {
  const now = Date.now();
  const rule = { kind: 'price', symbol: '600519.SH', operator: 'above', threshold: 99, cooldownMinutes: 0 };
  const sameDay = evaluate(rule, PRICE_RESULT, now, {
    lastMatched: true, lastTriggeredAt: new Date(now - 60000).toISOString(), lastMatchedDate: shanghaiDay(now),
  });
  assert.equal(sameDay.status, 'deduplicated');
  const nextDay = evaluate(rule, PRICE_RESULT, now, {
    lastMatched: true, lastTriggeredAt: new Date(now - 86400000).toISOString(), lastMatchedDate: '20000101',
  });
  assert.equal(nextDay.status, 'triggered');
});

// ---------- 红线 ----------
test('红线：四类条件的任何数据异常都不得折算为未触发', () => {
  const failures = [
    { ok: false, error: '超时', reasonCode: 'SOURCE_ERROR' },
    { ok: false, degraded: true, error: '数据过期', reasonCode: 'DATA_STALE' },
    { ok: false, error: '鉴权失败', reasonCode: 'AUTH_INVALID' },
    { ok: false, degraded: true, error: '限流', reasonCode: 'RATE_LIMITED' },
    { ok: false, error: '字段缺失', reasonCode: 'FIELD_MISSING' },
  ];
  for (const kind of ['price', 'heat', 'event', 'calendar']) {
    for (const f of failures) {
      const r = evaluate({ kind, symbol: '600519.SH', operator: 'above', threshold: 1, cooldownMinutes: 60 }, f);
      assert.notEqual(r.status, 'not_triggered', `${kind}/${f.reasonCode} 被错误折算为未触发`);
      assert.notEqual(r.status, 'triggered', `${kind}/${f.reasonCode} 被错误折算为已触发`);
      assert.ok(['degraded', 'error'].includes(r.status));
      assert.equal(r.evidence, null);
    }
  }
});
