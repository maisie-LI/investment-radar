// 本批护栏用例：意图识别、热度数据时点三态、AND/OR 组合条件。
// 这三块共同回答一个评审必问的问题——「什么时候你会拒绝回答，或者承认自己不知道？」
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRule, validateRule, evaluate, detectRefusal, REFUSALS } from '../engine.js';

const refusalOf = async (text) => parseRule(text, null).then(() => null, (e) => e);

// ==================== 一、意图识别：预测 / 荐股 / 其他投资建议 ====================

test('预测涨跌类请求：按 forecast 文案拒绝，不得落到「请输入价格阈值」', async () => {
  for (const text of ['帮我预测茅台明天涨跌', '预测一下茅台', '给我个目标价', '茅台明天涨还是跌']) {
    const err = await refusalOf(text);
    assert.ok(err, `「${text}」应当被拒绝`);
    assert.ok(err.refusal, `「${text}」缺少结构化拒绝信息`);
    assert.equal(err.refusal.intent, 'forecast', `「${text}」意图判定错误：${err.refusal.intent}`);
    assert.match(err.message, /不预测未来涨跌/);
    assert.doesNotMatch(err.message, /请输入价格阈值/, '拒绝文案绝不能是解析器内部错误');
  }
});

test('买卖 / 仓位类请求：按 advice 文案拒绝', async () => {
  for (const text of ['建议我买入贵州茅台', '帮我满仓', '要不要卖出手里的茅台', '现在该不该加仓', '推荐几只股票']) {
    const err = await refusalOf(text);
    assert.ok(err?.refusal, `「${text}」应当被拒绝`);
    assert.equal(err.refusal.intent, 'advice', `「${text}」意图判定错误：${err.refusal?.intent}`);
    assert.match(err.message, /不提供买卖和仓位建议/);
    assert.doesNotMatch(err.message, /请输入价格阈值/);
  }
});

test('其他投资建议类请求：按 generic 文案拒绝', async () => {
  for (const text of ['茅台值得投资吗', '帮我看看这只股票怎么样', '这只票靠谱吗', '茅台能赚多少']) {
    const err = await refusalOf(text);
    assert.ok(err?.refusal, `「${text}」应当被拒绝`);
    assert.equal(err.refusal.intent, 'generic', `「${text}」意图判定错误：${err.refusal?.intent}`);
    assert.match(err.message, /不预测股票涨跌，也不提供买卖、仓位或收益建议/);
  }
});

test('三种拒绝文案彼此不同，且都给出可执行的替代写法', () => {
  const notes = Object.values(REFUSALS).map((r) => r.note);
  assert.equal(new Set(notes).size, 3, '三类意图的文案必须各不相同');
  for (const r of Object.values(REFUSALS)) {
    assert.ok(r.sample && r.sample.length > 0, `意图 ${r.intent} 缺少替代示例`);
    assert.match(r.sample, /提醒我|监控/, '替代示例必须是可执行的监控写法');
  }
});

test('合法监控语句不得被意图判定误伤', async () => {
  const cases = [
    ['当 600519.SH 高于 1500 时提醒我', 'price'],
    ['600519.SH 跌破1400时提醒我', 'price'],
    ['600519.SH 出现跌停时提醒我', 'event'],
    ['提醒我今天是不是交易日', 'calendar'],
    ['600519.SH 进入热榜前十时提醒我', 'heat'],
  ];
  for (const [text, kind] of cases) {
    const rule = await parseRule(text, null);
    assert.equal(rule.kind, kind, `「${text}」应解析为 ${kind}`);
  }
});

test('detectRefusal 分档：hard 命中强词，soft 覆盖弱表达', () => {
  assert.equal(detectRefusal('预测茅台', 'hard')?.intent, 'forecast');
  assert.equal(detectRefusal('茅台会不会涨', 'hard'), null, '弱表达不应进 hard 档（可能误伤合法监控）');
  assert.equal(detectRefusal('茅台会不会涨', 'soft')?.intent, 'forecast');
});

// 回归：曾因噪声词表缺少「会不会 / 能不能 / 吗」等疑问助词，导致
// "贵州茅台会不会跌破1400" 残留成 "贵州茅台会不会" 去检索标的，检索失败后又被当成预测意图拒绝。
test('带疑问助词的合法监控语句必须能解析（疑问词必须被清洗干净）', async () => {
  // 严格 stub：只有清洗后恰好等于「贵州茅台」才算命中，防止清洗不干净时测试假通过
  const resolveTicker = async (query) => (query === '贵州茅台'
    ? { ok: true, candidates: [{ symbol: '600519.SH', name: '贵州茅台', ticker: '600519', exchange: 'SH' }] }
    : { ok: false, error: `未找到与「${query}」匹配的标的` });

  const cases = [
    ['贵州茅台会不会跌破1400', 'below', 1400],
    ['贵州茅台能不能站上1500', 'above', 1500],
    ['请问贵州茅台明天跌破1400吗', 'below', 1400],
  ];
  for (const [text, operator, threshold] of cases) {
    const rule = await parseRule(text, resolveTicker);
    assert.equal(rule.kind, 'price', `「${text}」应解析为价格条件`);
    assert.equal(rule.symbol, '600519.SH', `「${text}」标的应识别为 600519.SH`);
    assert.equal(rule.operator, operator, `「${text}」方向应为 ${operator}`);
    assert.equal(rule.threshold, threshold, `「${text}」阈值应为 ${threshold}`);
  }
});

// 反过来：没有可验证条件的疑问句，仍必须被识别为预测诉求，不能因为"放宽"而漏掉
test('无可验证条件的疑问句仍按预测意图拒绝', async () => {
  const resolveTicker = async () => ({ ok: false, error: '未找到匹配标的' });
  for (const text of ['茅台明天会不会涨', '贵州茅台会涨吗']) {
    await assert.rejects(
      () => parseRule(text, resolveTicker),
      (err) => err.refusal?.intent === 'forecast',
      `「${text}」应被判定为预测意图`
    );
  }
});

// 比较词（高于/跌破/站上…）在 parsePrice 里用于识别阈值，在 resolveSymbol 的噪声词表里
// 用于清洗标的查询。两处必须同步：新增一个比较词却忘了同步噪声词表时，会出现
// "阈值识别到了、标的却被残留的比较词污染"的隐蔽失败。这里遍历全部比较词守护一致性。
test('全部比较词都要能与标的解析协同工作（比较词与噪声词同步）', async () => {
  const belowWords = new Set(['低于', '跌破', '跌到']);
  const words = ['高于', '超过', '低于', '跌破', '达到', '站上', '突破', '升破', '涨到', '跌到'];
  const resolveTicker = async (query) => (query === '贵州茅台'
    ? { ok: true, candidates: [{ symbol: '600519.SH', name: '贵州茅台', ticker: '600519', exchange: 'SH' }] }
    : { ok: false, error: `未找到与「${query}」匹配的标的` });

  for (const w of words) {
    const rule = await parseRule(`贵州茅台${w}1500`, resolveTicker);
    assert.equal(rule.symbol, '600519.SH', `比较词「${w}」未与噪声清洗同步：标的被残留词污染`);
    assert.equal(rule.threshold, 1500, `比较词「${w}」的阈值未能识别`);
    assert.equal(rule.operator, belowWords.has(w) ? 'below' : 'above', `比较词「${w}」的方向判定错误`);
  }
});

// ==================== 二、热度数据时点三态 ====================

const heatRule = () => validateRule({ kind: 'heat', symbol: '600519.SH', operator: 'in_top', threshold: 10, intervalMinutes: 15, cooldownMinutes: 240 });
const heatResult = (extra) => ({ ok: true, inList: false, rank: null, heat: null, listSize: 30, topName: 'XX', requestId: 'req-hot', attempts: 1, ...extra });

test('热度情形①：有榜单业务时间 → 可判定，证据写明是哪个时点的榜单', () => {
  const datasetTime = Date.parse('2026-09-30T10:30:00+08:00');
  const run = evaluate(heatRule(), heatResult({ datasetTime, dataTimeStatus: 'dataset_time', fetchedAt: Date.now() }), Date.now(), {});
  assert.equal(run.status, 'not_triggered');
  assert.match(run.reason, /2026-09-30 10:30 获取的前 30 名榜单/);
  assert.doesNotMatch(run.reason, /数据源未提供/, '业务时间可用时不应再声明缺失');
  assert.equal(run.evidence.asOfSource, 'dataset_time');
  assert.equal(run.evidence.asOf, datasetTime);
});

test('热度情形②：只有抓取时间 → 仍未触发，但必须写明业务时间缺失与可信度边界', () => {
  const fetchedAt = Date.parse('2026-09-30T15:30:00+08:00');
  const run = evaluate(heatRule(), heatResult({ fetchedAt, dataTimeStatus: 'fetch_time' }), Date.now(), {});
  assert.equal(run.status, 'not_triggered');
  assert.match(run.reason, /本次获取的前 30 名榜单中未找到该标的/);
  assert.match(run.reason, /获取时间：2026-09-30 15:30/);
  assert.match(run.reason, /榜单业务时间：数据源未提供/);
  assert.match(run.reason, /可信度提示：仅能确认本次获取结果，无法验证榜单所属业务时点/);
  assert.equal(run.evidence.asOfSource, 'fetch_time');
});

test('热度情形③（红线）：数据时点不可确认时必须标为「数据受限」，绝不出「未触发」', () => {
  const run = evaluate(heatRule(), heatResult({ fetchedAt: null, dataTimeStatus: 'unavailable' }), Date.now(), {});
  assert.equal(run.status, 'restricted', '数据时点不可确认时不得输出未触发');
  assert.equal(run.reasonCode, 'DATA_RESTRICTED');
  assert.notEqual(run.status, 'not_triggered');
  assert.match(run.reason, /未执行条件判断/);
});

test('红线：热度记录不允许出现「数据时间不可用 + 未触发」的组合', () => {
  const cases = [
    heatResult({ fetchedAt: Date.now(), dataTimeStatus: 'fetch_time' }),
    heatResult({ datasetTime: Date.parse('2026-09-30T10:30:00+08:00'), dataTimeStatus: 'dataset_time', fetchedAt: Date.now() }),
    heatResult({ fetchedAt: null, dataTimeStatus: 'unavailable' }),
  ];
  for (const result of cases) {
    const run = evaluate(heatRule(), result, Date.now(), {});
    const vague = /数据时间：?不可用/.test(run.reason || '');
    assert.equal(vague, false, `出现了含糊的「数据时间不可用」表述：${run.reason}`);
    if (run.status === 'not_triggered') {
      assert.match(run.reason, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}|获取时间|业务时间/, '未触发必须交代数据时点');
    }
  }
});

test('热度命中时同样带时间口径（不是只有未命中才说明）', () => {
  const run = evaluate(heatRule(), heatResult({ inList: true, rank: 3, fetchedAt: Date.parse('2026-09-30T15:30:00+08:00'), dataTimeStatus: 'fetch_time' }), Date.now(), {});
  assert.equal(run.status, 'triggered');
  assert.match(run.reason, /位于本次获取的前 30 名榜单第 3 名/);
  assert.match(run.reason, /榜单业务时间：数据源未提供/);
});

// ==================== 三、AND / OR 组合条件 ====================

test('组合解析：AND 识别 + 后置子条件继承标的', async () => {
  const rule = validateRule(await parseRule('600519.SH 跌破1400并且进入热榜前10', null));
  assert.equal(rule.kind, 'composite');
  assert.equal(rule.logic, 'AND');
  assert.equal(rule.conditions.length, 2);
  assert.deepEqual(rule.conditions[0], { kind: 'price', symbol: '600519.SH', operator: 'below', threshold: 1400 });
  assert.deepEqual(rule.conditions[1], { kind: 'heat', symbol: '600519.SH', operator: 'in_top', threshold: 10 }, '第二个子条件应继承前一个的标的');
});

test('组合解析：并且 / 且 / and 归 AND，或者 / 或 / or 归 OR', async () => {
  const andCases = ['600519.SH 跌破1400并且进入热榜前10', '600519.SH 跌破1400 and 进入热榜前10'];
  const orCases = ['600519.SH 低于1400或者高于1500', '600519.SH 低于1400 or 高于1500'];
  for (const text of andCases) assert.equal(validateRule(await parseRule(text, null)).logic, 'AND', text);
  for (const text of orCases) assert.equal(validateRule(await parseRule(text, null)).logic, 'OR', text);
});

test('组合解析：混用 AND 与 OR 必须明确拒绝，不猜测用户意图', async () => {
  await assert.rejects(() => parseRule('600519.SH 低于1400并且高于1500或者今日是交易日', null), /不支持混用/);
});

test('组合校验：子条件数量 2–5，且不允许嵌套', () => {
  const one = { kind: 'price', symbol: '600519.SH', operator: 'below', threshold: 1 };
  assert.throws(() => validateRule({ kind: 'composite', logic: 'AND', conditions: [one], intervalMinutes: 5, cooldownMinutes: 60 }), /2 至 5 个/);
  assert.throws(() => validateRule({ kind: 'composite', logic: 'XOR', conditions: [one, one], intervalMinutes: 5, cooldownMinutes: 60 }), /AND|OR/);
  assert.throws(() => validateRule({ kind: 'composite', logic: 'AND', conditions: [{ kind: 'composite', logic: 'AND', conditions: [one, one] }, one], intervalMinutes: 5, cooldownMinutes: 60 }), /不支持嵌套/);
});

const compositeRule = () => validateRule({
  kind: 'composite', logic: 'AND', intervalMinutes: 5, cooldownMinutes: 240,
  conditions: [
    { kind: 'price', symbol: '600519.SH', operator: 'below', threshold: 1400 },
    { kind: 'heat', symbol: '600519.SH', operator: 'in_top', threshold: 10 },
  ],
});
const priceOk = (price = 1258.62) => ({ ok: true, price, volume: 1, marketDate: '20260929', requestId: 'req-price', attempts: 1, asOf: '20260929', asOfSource: 'kline_date' });
const heatOk = ({ rank = 3, ...rest } = {}) => ({ ok: true, inList: rank != null, rank, listSize: 30, topName: 'X', fetchedAt: Date.now(), dataTimeStatus: 'fetch_time', requestId: 'req-hot', attempts: 1, ...rest });

test('组合判定：AND 全部满足才触发', () => {
  const all = evaluate(compositeRule(), { ok: true, composite: true, parts: [{ kind: 'price', result: priceOk() }, { kind: 'heat', result: heatOk({ rank: 3 }) }] }, Date.now(), {});
  assert.equal(all.status, 'triggered');
  const half = evaluate(compositeRule(), { ok: true, composite: true, parts: [{ kind: 'price', result: priceOk(1600) }, { kind: 'heat', result: heatOk({ rank: 3 }) }] }, Date.now(), {});
  assert.equal(half.status, 'not_triggered');
  assert.match(half.reason, /存在未满足的子条件（1\.未满足，2\.满足）/);
});

test('组合判定：OR 任一满足即触发，全不满足才未触发', () => {
  const orRule = validateRule({
    kind: 'composite', logic: 'OR', intervalMinutes: 5, cooldownMinutes: 60,
    conditions: [
      { kind: 'price', symbol: '600519.SH', operator: 'below', threshold: 1300 },
      { kind: 'price', symbol: '600519.SH', operator: 'below', threshold: 1400 },
    ],
  });
  const one = evaluate(orRule, { ok: true, composite: true, parts: [{ kind: 'price', result: priceOk(1350) }, { kind: 'price', result: priceOk(1350) }] }, Date.now(), {});
  assert.equal(one.status, 'triggered');
  const none = evaluate(orRule, { ok: true, composite: true, parts: [{ kind: 'price', result: priceOk(1500) }, { kind: 'price', result: priceOk(1500) }] }, Date.now(), {});
  assert.equal(none.status, 'not_triggered');
  assert.match(none.reason, /所有子条件均未满足/);
});

test('组合判定：任一子条件数据不可用 → 整体降级，不强行判定', () => {
  const run = evaluate(compositeRule(), {
    ok: true, composite: true,
    parts: [
      { kind: 'price', result: priceOk() },
      { kind: 'heat', result: { ok: false, reasonCode: 'DATA_NOT_READY', error: '热股榜本次返回为空' } },
    ],
  }, Date.now(), {});
  assert.equal(run.status, 'degraded', '部分子条件未知时不得给出满足/未满足的结论');
  assert.equal(run.reasonCode, 'DATA_NOT_READY');
  assert.match(run.reason, /子条件 2/);
  assert.match(run.reason, /不强行判定/);
});

test('组合判定：任一子条件数据受限 → 整体同样不强行判定', () => {
  const run = evaluate(compositeRule(), {
    ok: true, composite: true,
    parts: [
      { kind: 'price', result: priceOk() },
      { kind: 'heat', result: heatOk({ rank: null, inList: false, fetchedAt: null, dataTimeStatus: 'unavailable' }) },
    ],
  }, Date.now(), {});
  assert.equal(run.status, 'degraded');
  assert.equal(run.reasonCode, 'DATA_RESTRICTED');
  assert.equal(run.evidence.parts[1].status, 'restricted');
});

test('组合证据：每个子条件都有独立状态、原因与逻辑说明', () => {
  const run = evaluate(compositeRule(), { ok: true, composite: true, parts: [{ kind: 'price', result: priceOk() }, { kind: 'heat', result: heatOk({ rank: 3 }) }] }, Date.now(), {});
  const e = run.evidence;
  assert.equal(e.logic, 'AND');
  assert.match(e.logicLabel, /并且/);
  assert.equal(e.parts.length, 2);
  assert.deepEqual(e.parts.map((p) => p.index), [1, 2]);
  assert.deepEqual(e.parts.map((p) => p.status), ['satisfied', 'satisfied']);
  assert.match(e.parts[0].label, /价格 600519\.SH 低于 1400 元/);
  assert.match(e.parts[1].label, /热度 600519\.SH 进入热榜前 10 名/);
  assert.ok(e.parts[0].reason && e.parts[1].reason, '每个子条件都要有自己的判定原因');
});

test('组合判定：去重与冷却沿用同一套语义', () => {
  const now = Date.now();
  const previous = { lastMatched: true, lastMatchedDate: new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }).replaceAll('-', ''), lastTriggeredAt: new Date(now - 60000).toISOString() };
  const run = evaluate(compositeRule(), { ok: true, composite: true, parts: [{ kind: 'price', result: priceOk() }, { kind: 'heat', result: heatOk({ rank: 3 }) }] }, now, previous);
  assert.equal(run.status, 'cooldown');
  assert.equal(run.reasonCode, 'COOLDOWN_ACTIVE');
});
