// 统一任务模型：规则解析（自然语言 -> 结构化）、校验、判定（确定性，不使用模型）
export const TYPES = ['price', 'event', 'calendar', 'heat', 'composite'];

export const REASONS = {
  CONDITION_SATISFIED: '条件满足',
  CONDITION_NOT_MET: '条件未满足',
  COOLDOWN_ACTIVE: '冷却中',
  DUPLICATE_SUPPRESSED: '重复已抑制',
  NON_TRADE_DAY: '非交易日',
  SOURCE_ERROR: '数据源错误',
  DATA_STALE: '数据过期',
  DATA_STATIC: '盘中数据无更新',
  DATA_NOT_READY: '数据未就绪',
  SCHEMA_MISMATCH: '数据格式异常',
  FIELD_MISSING: '字段缺失',
  AUTH_INVALID: '鉴权失败',
  RATE_LIMITED: '接口限流',
  CAPABILITY_DISABLED: '该数据源对当前凭证不开放',
  TICKER_NOT_FOUND: '股票代码不存在或已退市',
  DATA_RESTRICTED: '数据时点不可确认',
  DATA_CONFLICT: '数据存在冲突',
};

// 无法给出结论的状态集合（数据层面就没法判，不是"没触发"）。
// 它们在界面上必须统一写明「本次未执行条件判断」，否则用户会读成
// "系统检查过了，只是条件没满足"——那是完全不同、且更危险的一种暗示。
export const INCONCLUSIVE = new Set(['degraded', 'error', 'restricted', 'conflict']);
export const NO_DECISION_TEXT = '本次未执行条件判断';
export const RETRY_ADVICE = '等待下一次检查或手动重试';

// 处置建议必须跟原因走，不能所有异常都甩一句"重试"——
// 代码打错、凭证失效这类问题重试一万次也不会自己好，
// 让用户去等只会浪费他的时间（也误导评审以为系统能自愈）。
export const ADVICE_OF = {
  TICKER_NOT_FOUND: '请核对股票代码后修改规则；重复检查不会自动恢复',
  AUTH_INVALID: '请检查数据源凭证是否有效',
  CAPABILITY_DISABLED: '当前凭证未开通该数据能力，请在数据源侧确认权限',
  RATE_LIMITED: '接口限流，等待下一次检查会自动重试',
  FIELD_MISSING: '数据源返回字段不完整，等待下一次检查或手动重试',
};

// 底层错误原文不丢：中文结论给用户，原始返回给排查。
// 审计型产品必须保得住"这句话是从哪来的"。
// 数据源自带的错误若已是中文（如"历史行情最后日期 … 落后于 …"），说明它已经本地化，
// 直接沿用原文即可，不再套一层归类前缀，避免出现"数据过期（数据源返回：数据过期…）"这类复读。
const HAS_CJK = /[\u4e00-\u9fa5]/;
export function reasonText(code, raw) {
  const label = REASONS[code];
  const detail = String(raw || '').trim();
  if (!detail) return label || '数据源不可用';
  if (!label || HAS_CJK.test(detail)) return detail;
  return `${label}（数据源返回：${detail}）`;
}

const CN_DIGITS = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  十: 10, 二十: 20, 三十: 30, 五十: 50, 一百: 100,
};

function shanghaiDay(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms);
  const get = (type) => parts.find((x) => x.type === type).value;
  return `${get('year')}${get('month')}${get('day')}`;
}

function toCount(raw) {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  return CN_DIGITS[raw] ?? null;
}

// ---------- 标的解析：带后缀代码 -> 裸代码补交易所 -> 中文名检索 ----------
// fallbackSymbol 只用于组合条件：后一个子条件常常省略标的
//（"茅台跌破1400并且进入热榜前10"），此时继承前一个子条件已确定的标的，
// 而不是报"未识别证券代码"让用户重写一遍。
async function resolveSymbol(input, resolveTicker, fallbackSymbol = null) {
  const explicit = input.match(/\b\d{6}\.(?:SH|SZ)\b/i)?.[0]?.toUpperCase();
  if (explicit) return { symbol: explicit, parseMeta: { channel: 'code', query: null, candidates: [explicit] } };

  const rawCode = input.match(/(?<![\d])\d{6}(?![\d])/g)?.[0];
  if (rawCode) {
    const prefix = rawCode[0];
    const suffix = '69'.includes(prefix) ? '.SH' : '023'.includes(prefix) ? '.SZ' : null;
    if (!suffix) throw new Error('无法根据六位代码确定交易所，请改用带后缀代码，例如 600519.SH');
    const symbol = rawCode + suffix;
    return { symbol, parseMeta: { channel: 'code_without_exchange', query: rawCode, candidates: [symbol] } };
  }

  // 疑问助词与口语填充（会不会 / 能不能 / 吗）也必须清洗掉：否则「贵州茅台会不会跌破1400」
  // 会残留成「贵州茅台会不会」去检索标的，检索失败后又被误判为"预测意图"而拒绝（2026-09-30 修复）。
  // 注意：这里的比较词（高于/跌破/站上/突破…）必须与 parsePrice 的阈值识别词保持同步，
  // 否则会出现「阈值识别到了、标的检索却被残留的比较词污染」的隐蔽问题。
  // 同步性由 test/guardrails.test.js 的比较词遍历用例守护。
  const noise = /(高于|超过|低于|跌破|达到|站上|突破|升破|时提醒我|提醒我|提醒|价格|股价|当|在|进入|出现|变成|涨到|跌到|热榜|热度|人气|排名|前|名|异动|跌停|涨停|公告|新闻|原因|交易日|非交易日|休市|开盘|收盘|日历|时候|现在|是不是|是否|会不会|能不能|能否|可不可以|帮我|请问|麻烦|看看|看一下|分析一下|明天|明日|今天|今日|吗|呢|吧|时|[一二三四五六七八九十百千万]+|\d+(?:\.\d+)?)/g;
  const inherited = () => ({ symbol: fallbackSymbol, parseMeta: { channel: 'inherited_from_previous', query: null, candidates: [fallbackSymbol] } });

  const query = input.replace(noise, ' ').replace(/\s+/g, ' ').trim();
  if (!query) {
    if (fallbackSymbol) return inherited();
    throw new Error('未识别证券代码；请使用带后缀代码，或输入中文股票名');
  }
  if (!resolveTicker) {
    if (fallbackSymbol) return inherited();
    throw new Error('未识别证券代码；请使用带后缀代码，或输入中文股票名');
  }
  const found = await resolveTicker(query);
  if (!found.ok) {
    if (fallbackSymbol) return inherited();
    throw new Error(found.error || '标的检索失败，请改用证券代码');
  }
  if (found.candidates.length !== 1) {
    if (fallbackSymbol) return inherited();
    throw new Error(`找到多个可能标的（${found.candidates.map((x) => x.name + ' ' + x.symbol).join('、')}），请改用带后缀代码以避免误选`);
  }
  return { symbol: found.candidates[0].symbol, parseMeta: { channel: 'ticker_search', query, candidates: found.candidates } };
}

async function parsePrice(input, resolveTicker, fallbackSymbol = null) {
  const threshold = input.match(/(?:>=|<=|>|<|高于|超过|低于|跌破|达到|站上|突破|升破|涨到|跌到)\s*(\d+(?:\.\d+)?)/)?.[1];
  if (!threshold) throw new Error('请输入价格阈值，例如“高于 1500”或“跌破 1400”');
  const operator = /低于|跌破|跌到|<=|</.test(input) ? 'below' : 'above';
  const { symbol, parseMeta } = await resolveSymbol(input, resolveTicker, fallbackSymbol);
  return { kind: 'price', symbol, operator, threshold: Number(threshold), intervalMinutes: 5, cooldownMinutes: 60, parseMeta };
}

async function parseHeat(input, resolveTicker, fallbackSymbol = null) {
  const { symbol, parseMeta } = await resolveSymbol(input, resolveTicker, fallbackSymbol);
  const rankMatch = input.match(/(?:前|top)\s*([0-9]+|[一二三四五六七八九十百]+)|([0-9]+|[一二三四五六七八九十百]+)\s*名/i);
  const threshold = toCount(rankMatch?.[1] || rankMatch?.[2]) ?? 10;
  return { kind: 'heat', symbol, operator: 'in_top', threshold, intervalMinutes: 15, cooldownMinutes: 240, parseMeta };
}

async function parseEvent(input, resolveTicker, fallbackSymbol = null) {
  const { symbol, parseMeta } = await resolveSymbol(input, resolveTicker, fallbackSymbol);
  let keyword = '异动';
  for (const kw of ['跌停', '涨停', '停牌', '异动', '风险提示', '业绩', '重组', '解禁']) {
    if (input.includes(kw)) { keyword = kw; break; }
  }
  return { kind: 'event', symbol, operator: 'contains', threshold: keyword, intervalMinutes: 15, cooldownMinutes: 240, parseMeta };
}

function parseCalendar(input) {
  const isNot = /非交易日|休市/.test(input);
  return Promise.resolve({
    kind: 'calendar', symbol: null,
    operator: isNot ? 'is_not_trade_day' : 'is_trade_day',
    threshold: null, intervalMinutes: 60, cooldownMinutes: 720,
    parseMeta: { channel: 'calendar_keyword', query: null, candidates: [] },
  });
}

// ---------- 意图识别：明确拒绝「预测涨跌 / 荐股 / 其他投资建议」----------
// 为什么必须单独做一层：这类请求的失败方式极具误导性。"帮我预测茅台明天涨跌"如果只回
// "请输入价格阈值"，读起来像是"你数字没填完"，而真正的原因是产品不提供这项能力——
// 用户会反复尝试补全数字，永远得不到正确的解释。产品要把"不做"说清楚，并给可执行替代。
export const REFUSALS = {
  forecast: {
    intent: 'forecast',
    note: '本产品不预测未来涨跌。你可以创建基于真实数据的价格、热度、事件或交易日历监控。',
    sample: '贵州茅台跌破 1400 元时提醒我',
  },
  advice: {
    intent: 'advice',
    note: '本产品不提供买卖和仓位建议。你可以设置可验证的观察条件，由系统持续检查并展示依据。',
    sample: '贵州茅台进入热股榜前 10 名时提醒我',
  },
  generic: {
    intent: 'generic',
    note: '本产品不预测股票涨跌，也不提供买卖、仓位或收益建议。你可以把关注点改成可验证的监控条件，例如“贵州茅台跌破1400元时提醒我”。',
    sample: '贵州茅台跌破 1400 元时提醒我',
  },
};

// hard：意图本身就不可执行（"预测""满仓"不是可验证条件），即使语句里带了数字也要拒绝
const HARD_INTENT = [
  ['forecast', [
    /预测/, /预判/, /预计/, /涨跌预测/, /目标价/, /后市/, /能涨到多少/, /能跌到多少/,
    /走势(如何|怎样|怎么样|分析)?/, /涨跌(空间|幅度|概率)/, /明日?涨跌/,
  ]],
  ['advice', [
    /(建议|推荐)[^，。；]{0,6}(买|卖|仓)/, /(该不该|要不要|应不应该|值得|可以)[^，。；]{0,4}(买|卖|入手|建仓|加仓|减仓|抄底|清仓)/,
    /(买入|买进|卖出|满仓|空仓|清仓|加仓|减仓|建仓|补仓|抄底)/, /仓位/, /荐股/, /推票/,
    /(推荐|给)[^，。；]{0,4}(股票|个股|标的|票)/,
  ]],
];

// soft：只在"正常解析已经失败"时才判定，这样"贵州茅台会不会跌破1400"这类语句先走解析，
// 只有解析不出来时才会被当成意图问题；判定目标是措辞里真的表达了预测/建议诉求的输入。
const SOFT_INTENT = [
  ['forecast', [/(会|能|能否|会不会|还能)[^，。；]{0,3}(上涨|下跌|涨|跌)/, /涨还是跌/, /明天[^，。；]{0,4}(涨|跌)/, /未来的?(走势|价格)/]],
  ['advice', [/止盈/, /止损/, /(值得|适合|应该|建议)[^，。；]{0,4}(买入|买进|卖出|买入|持有|入手)/]],
  ['generic', [
    /(收益|回报|盈利)[^，。；]{0,4}(率|怎么样|如何|多少)/, /(这只|这个|该)[^，。；]{0,3}(股票|个股|票)[^，。；]{0,4}(怎么样|如何|好吗|行吗|靠谱)/,
    /投资建议/, /(能赚|赚多少|会赚)/, /分析一下/, /(值得|适合|应该)[^，。；]{0,4}投资/,
  ]],
];

function matchIntent(text, table) {
  for (const [intent, patterns] of table) {
    if (patterns.some((p) => p.test(text))) return REFUSALS[intent];
  }
  return null;
}

export function detectRefusal(text, mode = 'hard') {
  const input = String(text || '').trim();
  if (!input) return null;
  return matchIntent(input, mode === 'soft' ? SOFT_INTENT : HARD_INTENT);
}

function refusalError(refusal) {
  const err = new Error(refusal.note);
  err.refusal = { intent: refusal.intent, note: refusal.note, sample: refusal.sample };
  return err;
}

// ---------- 组合条件：并且/且/and、或者/或/or ----------
const AND_TOKENS = /并且|而且|同时满足|以及|且|(?<![A-Za-z])and(?![A-Za-z])/i;
const OR_TOKENS = /或者|或|(?<![A-Za-z])or(?![A-Za-z])/i;

function splitComposite(input) {
  const hasAnd = AND_TOKENS.test(input);
  const hasOr = OR_TOKENS.test(input);
  if (!hasAnd && !hasOr) return null;
  if (hasAnd && hasOr) {
    throw new Error('同一条规则暂不支持混用「并且」与「或者」，请统一成一种逻辑，或拆成多条任务');
  }
  const logic = hasAnd ? 'AND' : 'OR';
  const tokens = new RegExp(logic === 'AND' ? AND_TOKENS.source : OR_TOKENS.source, 'gi');
  const segments = input.split(tokens).map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) return null;
  if (segments.length > 5) throw new Error('一条规则最多支持 5 个子条件，请拆成多条任务');
  return { logic, segments };
}

const DEFAULT_PACING = {
  price: { intervalMinutes: 5, cooldownMinutes: 60 },
  heat: { intervalMinutes: 15, cooldownMinutes: 240 },
  event: { intervalMinutes: 15, cooldownMinutes: 240 },
  calendar: { intervalMinutes: 60, cooldownMinutes: 720 },
};

async function parseComposite(split, resolveTicker) {
  const conditions = [];
  const segments = [];
  let inherited = null;
  for (const segment of split.segments) {
    const parsed = await parseSingle(segment, resolveTicker, inherited);
    if (!inherited && parsed.symbol) inherited = parsed.symbol;
    conditions.push({
      kind: parsed.kind,
      symbol: parsed.symbol ?? null,
      operator: parsed.operator,
      threshold: parsed.threshold,
    });
    segments.push(segment);
  }
  // 整体检查频率取子条件里最紧的，冷却取最宽松的：
  // 组合条件本来就要求多个条件同时成立，用最保守的参数避免把提醒变成噪声。
  const intervalMinutes = Math.min(...conditions.map((c) => DEFAULT_PACING[c.kind].intervalMinutes));
  const cooldownMinutes = Math.max(...conditions.map((c) => DEFAULT_PACING[c.kind].cooldownMinutes));
  return {
    kind: 'composite',
    logic: split.logic,
    conditions,
    symbol: null,
    intervalMinutes,
    cooldownMinutes,
    parseMeta: { channel: 'composite', query: null, segments, candidates: conditions.map((c) => c.symbol).filter(Boolean) },
  };
}

async function parseSingle(input, resolveTicker, fallbackSymbol = null) {
  if (/热榜|热度|人气|排名|热股/.test(input)) return parseHeat(input, resolveTicker, fallbackSymbol);
  if (/异动|跌停|涨停|公告|新闻|原因/.test(input)) return parseEvent(input, resolveTicker, fallbackSymbol);
  if (/交易日|非交易日|休市|开盘|日历/.test(input)) return parseCalendar(input);
  return parsePrice(input, resolveTicker, fallbackSymbol);
}

// 自然语言 -> 规则草案（受限语法，明确不直接执行，需用户确认）
export async function parseRule(text, resolveTicker = null) {
  const input = String(text || '').trim();
  if (!input) throw new Error('请描述你想监控的条件');

  // ① 明确的预测 / 荐股意图：直接拒绝并给替代路径，绝不落到"请输入价格阈值"
  const hard = detectRefusal(input, 'hard');
  if (hard) throw refusalError(hard);

  // ② 组合条件（拆分本身报错时不要被下面的 soft 意图判定覆盖）
  const split = splitComposite(input);

  try {
    return split ? await parseComposite(split, resolveTicker) : await parseSingle(input, resolveTicker);
  } catch (err) {
    // ③ 正常解析失败后，再看是不是"软性"的预测 / 建议诉求（避免误伤合法监控语句）
    const soft = detectRefusal(input, 'soft');
    if (soft) throw refusalError(soft);
    throw err;
  }
}

// ---------- 校验：按条件类型分别约束，防止模型化规则被写成不可执行状态 ----------
// 单个子条件（组合条件的每个子条件也要过这一关）
function validateCondition(rule) {
  if (!rule || typeof rule !== 'object') throw new Error('子条件内容为空');
  if (!TYPES.includes(rule.kind)) throw new Error('未知条件类型');
  if (rule.kind === 'composite') throw new Error('组合条件不支持嵌套，请把每个子条件写成单一条件');

  if (rule.kind === 'price') {
    if (!/^\d{6}\.(SH|SZ)$/.test(rule.symbol ?? '')) throw new Error('证券代码格式不正确');
    if (!['above', 'below'].includes(rule.operator)) throw new Error('比较方向不正确');
    if (!Number.isFinite(rule.threshold) || rule.threshold <= 0) throw new Error('阈值必须大于零');
  } else if (rule.kind === 'heat') {
    if (!/^\d{6}\.(SH|SZ)$/.test(rule.symbol ?? '')) throw new Error('证券代码格式不正确');
    if (rule.operator !== 'in_top') throw new Error('热度条件仅支持“进入热榜前 N 名”');
    if (!Number.isInteger(rule.threshold) || rule.threshold < 1 || rule.threshold > 100) throw new Error('热榜名次应为 1 至 100 的整数');
  } else if (rule.kind === 'event') {
    if (!/^\d{6}\.(SH|SZ)$/.test(rule.symbol ?? '')) throw new Error('证券代码格式不正确');
    if (rule.operator !== 'contains') throw new Error('事件条件仅支持关键词匹配');
    const keyword = String(rule.threshold ?? '').trim();
    if (!keyword || keyword.length > 20) throw new Error('事件关键词应为 1 至 20 个字符');
    rule.threshold = keyword;
  } else if (rule.kind === 'calendar') {
    if (!['is_trade_day', 'is_not_trade_day'].includes(rule.operator)) throw new Error('日历条件仅支持“是交易日 / 非交易日”');
    rule.symbol = null;
  }
  return rule;
}

export function validateRule(rule) {
  if (!rule || typeof rule !== 'object') throw new Error('规则内容为空');
  if (!TYPES.includes(rule.kind)) throw new Error('未知条件类型');
  if (!Number.isInteger(rule.intervalMinutes) || rule.intervalMinutes < 1 || rule.intervalMinutes > 1440) throw new Error('检查间隔应为 1 至 1440 分钟');
  if (!Number.isInteger(rule.cooldownMinutes) || rule.cooldownMinutes < 0 || rule.cooldownMinutes > 10080) throw new Error('冷却时间应为 0 至 10080 分钟');

  if (rule.kind === 'composite') {
    if (!['AND', 'OR'].includes(rule.logic)) throw new Error('组合条件必须标明是「并且（AND）」还是「或者（OR）」');
    const list = rule.conditions;
    if (!Array.isArray(list) || list.length < 2 || list.length > 5) throw new Error('组合条件需要 2 至 5 个子条件');
    list.forEach((c) => validateCondition(c));
    rule.symbol = null;
    return rule;
  }
  return validateCondition(rule);
}

// ---------- 各类型判定：只做确定性比较，输出证据与理由 ----------
function judgePrice(rule, result) {
  const evidence = {
    price: result.price, volume: result.volume, turnover: result.turnover,
    changeRatioPct: result.changeRatioPct, prevClose: result.prevClose,
    fetchedAt: result.fetchedAt, marketDate: result.marketDate,
    latestTradingDate: result.latestTradingDate, requestId: result.requestId,
    unit: 'CNY/share', source: 'fuyao', sessionLabel: result.sessionLabel,
    priceField: result.priceField, historicalClose: result.historicalClose,
    historicalAdjust: result.historicalAdjust, attempts: result.attempts,
    asOf: result.asOf, asOfSource: result.asOfSource,
  };
  const matched = rule.operator === 'above' ? result.price > rule.threshold : result.price < rule.threshold;
  const direction = rule.operator === 'above' ? '高于' : '低于';
  return {
    matched, evidence,
    metReason: `当前价格 ${result.price} 元，满足${direction} ${rule.threshold} 元`,
    unmetReason: `当前价格 ${result.price} 元，未满足${direction} ${rule.threshold} 元`,
  };
}

function fmtBeijing(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '未知时间';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(n);
  const g = (t) => parts.find((x) => x.type === t)?.value || '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

function judgeHeat(rule, result) {
  // 热度判定必须区分三种数据时点情形——这是最容易把不可靠数据当成正常证据的地方：
  // ① dataset_time：榜单业务时间由数据源提供 → 可判定，且能写清是哪个时点的榜单
  // ② fetch_time  ：只有本次抓取时间      → 仍可判定，但必须写明业务时间缺失与可信度边界
  // ③ unavailable ：两者都拿不到          → 不得输出"未触发"，改为"数据受限"，声明未执行判定
  // 明确禁止"数据时间不可用 → 未触发"这种组合：那等于用一句含糊的话给用户一个结论。
  const dataTimeStatus = result.dataTimeStatus
    || (result.datasetTime ? 'dataset_time' : (Number.isFinite(Number(result.fetchedAt)) ? 'fetch_time' : 'unavailable'));

  const evidence = {
    inList: result.inList, rank: result.rank, heat: result.heat,
    listSize: result.listSize, stockName: result.name, topName: result.topName,
    fetchedAt: result.fetchedAt, datasetTime: result.datasetTime ?? null, dataTimeStatus,
    requestId: result.requestId, attempts: result.attempts,
    source: 'fuyao', dataset: 'hot-stock-list', unit: '榜位',
    asOf: dataTimeStatus === 'dataset_time' ? result.datasetTime : null,
    asOfSource: dataTimeStatus,
    confidence: dataTimeStatus === 'dataset_time'
      ? '榜单业务时间由数据源提供，可用于判断该时点的榜单'
      : dataTimeStatus === 'fetch_time'
        ? '仅能确认本次获取结果，无法验证榜单所属业务时点'
        : '榜单业务时间与获取时间均不可用，无法判断该数据时效',
  };

  if (dataTimeStatus === 'unavailable') {
    return { restricted: true, evidence, unmetReason: '榜单业务时间不可用，本次未执行条件判断' };
  }

  const byDatasetTime = dataTimeStatus === 'dataset_time';
  const stamp = fmtBeijing(byDatasetTime ? result.datasetTime : result.fetchedAt);
  const timeNote = byDatasetTime
    ? ''
    : `；获取时间：${stamp}；榜单业务时间：数据源未提供；可信度提示：仅能确认本次获取结果，无法验证榜单所属业务时点`;
  // 措辞随可信度变化：有业务时点时可以断言"未进入该时点的榜单"，
  // 只有抓取时间时只能说"本次获取的榜单中没找到"——结论强度必须跟着数据强度走。
  const missedText = byDatasetTime
    ? `未进入 ${stamp} 获取的前 ${result.listSize} 名榜单`
    : `本次获取的前 ${result.listSize} 名榜单中未找到该标的`;
  const rankText = byDatasetTime
    ? `位于 ${stamp} 获取的前 ${result.listSize} 名榜单第 ${result.rank} 名`
    : `位于本次获取的前 ${result.listSize} 名榜单第 ${result.rank} 名`;

  if (!result.inList) {
    return { matched: false, evidence, unmetReason: `${missedText}${timeNote}` };
  }
  const matched = result.rank <= rule.threshold;
  return {
    matched, evidence,
    metReason: `${rankText}，满足“进入前 ${rule.threshold} 名”${timeNote}`,
    unmetReason: `${rankText}，未进入前 ${rule.threshold} 名${timeNote}`,
  };
}

function judgeEvent(rule, result) {
  const evidence = {
    matched: result.matched, tagName: result.tagName, keywords: result.keywords,
    analysis: result.analysis, listSize: result.listSize,
    fetchedAt: result.fetchedAt, requestId: result.requestId, attempts: result.attempts,
    source: 'fuyao', dataset: 'anomaly-analysis-list', asOf: result.asOf, asOfSource: result.asOfSource,
  };
  if (!result.matched) {
    return { matched: false, evidence, unmetReason: `本次异动原因列表中未出现该标的（共 ${result.listSize} 条），未检测到“${rule.threshold}”` };
  }
  const haystack = [result.tagName, ...(result.keywords || [])].filter(Boolean).map(String);
  const hitText = haystack.find((t) => t.includes(rule.threshold));
  const matched = Boolean(hitText);
  return {
    matched, evidence,
    metReason: `检测到异动「${hitText}」，命中关键词“${rule.threshold}”`,
    unmetReason: `该标的本次异动标签为「${result.tagName || '无'}」，关键词未命中“${rule.threshold}”`,
  };
}

function judgeCalendar(rule, result) {
  const evidence = {
    today: result.today, isTradeDay: result.isTradeDay,
    latestTradingDate: result.latestTradingDate, previousTradingDate: result.previousTradingDate,
    sessionLabel: result.sessionLabel, fetchedAt: result.fetchedAt,
    requestId: result.requestId, attempts: result.attempts,
    source: 'fuyao', dataset: 'trading-days', asOf: result.asOf, asOfSource: result.asOfSource,
  };
  const wantTradeDay = rule.operator === 'is_trade_day';
  const matched = result.isTradeDay === wantTradeDay;
  const actual = result.isTradeDay ? '交易日' : '非交易日';
  const wanted = wantTradeDay ? '交易日' : '非交易日';
  return {
    matched, evidence,
    metReason: `今日 ${result.today} 是${actual}，满足“${wanted}”`,
    unmetReason: `今日 ${result.today} 是${actual}，未满足“${wanted}”`,
  };
}

// 去重 / 冷却：同一任务同一版本同一交易日同一条件只触发一次
function finalize(base, rule, judged, now, previous) {
  if (!judged.matched) {
    return { ...base, status: 'not_triggered', reasonCode: 'CONDITION_NOT_MET', reason: judged.unmetReason, evidence: judged.evidence };
  }
  const last = previous.lastTriggeredAt ? Date.parse(previous.lastTriggeredAt) : 0;
  const today = shanghaiDay(now);
  // 历史数据没有 lastMatchedDate 时按同日处理，保持行为兼容
  const sameDay = !previous.lastMatchedDate || previous.lastMatchedDate === today;
  if (previous.lastMatched && sameDay && last && now - last < rule.cooldownMinutes * 60000) {
    return { ...base, status: 'cooldown', reasonCode: 'COOLDOWN_ACTIVE', reason: `条件仍成立，处于 ${rule.cooldownMinutes} 分钟冷却期；不会重复提醒`, evidence: judged.evidence };
  }
  if (previous.lastMatched && sameDay) {
    return { ...base, status: 'deduplicated', reasonCode: 'DUPLICATE_SUPPRESSED', reason: '本交易日内该条件已提醒过，已抑制重复；条件解除或进入下一交易日可再次触发', evidence: judged.evidence };
  }
  return { ...base, status: 'triggered', reasonCode: 'CONDITION_SATISFIED', reason: judged.metReason, evidence: judged.evidence };
}

function judgeOne(condition, result) {
  const kind = condition.kind || 'price';
  if (kind === 'heat') return judgeHeat(condition, result);
  if (kind === 'event') return judgeEvent(condition, result);
  if (kind === 'calendar') return judgeCalendar(condition, result);
  return judgePrice(condition, result);
}

// 子条件在界面与证据里的一句话描述（前端拿到的是同一条文案，避免两边各写一套）
export function conditionLabel(condition) {
  const kind = condition?.kind || 'price';
  if (kind === 'heat') return `热度 ${condition.symbol} 进入热榜前 ${condition.threshold} 名`;
  if (kind === 'event') return `事件 ${condition.symbol} 出现「${condition.threshold}」`;
  if (kind === 'calendar') return condition.operator === 'is_trade_day' ? '日历 今日为交易日' : '日历 今日为非交易日';
  return `价格 ${condition.symbol} ${condition.operator === 'above' ? '高于' : '低于'} ${condition.threshold} 元`;
}

// 组合条件：逐子条件独立求值，再按 AND / OR 合并。
// 关键约定：任一子条件降级或受限时，整体标为降级且**不强行判定**——
// 部分子条件未知时给出"满足/未满足"，等于用一半的数据编一个完整结论。
function evaluateComposite(rule, result, now, previous) {
  const base = { checkedAt: new Date(now).toISOString(), source: 'fuyao', symbol: null, kind: 'composite', logic: rule.logic };
  const parts = result.parts || [];
  const rows = [];
  let blocked = null;

  rule.conditions.forEach((condition, i) => {
    const sub = parts[i]?.result;
    const label = conditionLabel(condition);
    if (!sub) {
      rows.push({ index: i + 1, kind: condition.kind, label, matched: null, status: 'unavailable', reasonCode: 'SOURCE_ERROR', reason: '子条件数据不可用' });
      if (!blocked) blocked = { reasonCode: 'SOURCE_ERROR', text: `子条件 ${i + 1}（${label}）数据不可用（SOURCE_ERROR）：子条件数据不可用` };
      return;
    }
    // 子条件自身的数据冲突要先于通用失败分支处理：它同样是"取到了、但时点打架"，
    // 需要单独展示，不能和"接口没取到"混成一句。
    if (sub.conflict) {
      rows.push({ index: i + 1, kind: condition.kind, label, matched: null, status: 'conflict', reasonCode: 'DATA_CONFLICT', reason: sub.error || '子条件数据存在冲突', evidence: sub.evidence || null });
      if (!blocked) blocked = { reasonCode: 'DATA_CONFLICT', text: `子条件 ${i + 1}（${label}）数据存在冲突：${sub.error || ''}` };
      return;
    }
    if (!sub.ok) {
      const reasonCode = sub.reasonCode || 'SOURCE_ERROR';
      const reason = sub.error || '子条件数据不可用';
      rows.push({ index: i + 1, kind: condition.kind, label, matched: null, status: 'unavailable', reasonCode, reason });
      if (!blocked) blocked = { reasonCode, text: `子条件 ${i + 1}（${label}）数据不可用（${reasonCode}）：${reason}` };
      return;
    }
    const judged = judgeOne(condition, sub);
    if (judged.restricted) {
      rows.push({ index: i + 1, kind: condition.kind, label, matched: null, status: 'restricted', reasonCode: 'DATA_RESTRICTED', reason: judged.unmetReason, evidence: judged.evidence });
      if (!blocked) blocked = { reasonCode: 'DATA_RESTRICTED', text: `子条件 ${i + 1}（${label}）数据受限：${judged.unmetReason}` };
      return;
    }
    rows.push({
      index: i + 1, kind: condition.kind, label, matched: judged.matched,
      status: judged.matched ? 'satisfied' : 'not_satisfied',
      reasonCode: judged.matched ? 'CONDITION_SATISFIED' : 'CONDITION_NOT_MET',
      reason: judged.matched ? judged.metReason : judged.unmetReason,
      evidence: judged.evidence,
      asOf: judged.evidence?.asOf ?? null,
      asOfSource: judged.evidence?.asOfSource ?? null,
      requestId: judged.evidence?.requestId ?? null,
    });
  });

  const evidence = {
    logic: rule.logic,
    logicLabel: rule.logic === 'AND' ? '并且（所有子条件同时满足）' : '或者（任一子条件满足即可）',
    parts: rows,
    conditionCount: rule.conditions.length,
    source: 'fuyao',
  };

  if (blocked) {
    return {
      ...base,
      status: 'degraded',
      reasonCode: blocked.reasonCode,
      reason: `${blocked.text}；组合条件不强行判定`,
      decision: NO_DECISION_TEXT,
      advice: RETRY_ADVICE,
      evidence,
    };
  }

  const matched = rule.logic === 'AND'
    ? rows.every((r) => r.matched === true)
    : rows.some((r) => r.matched === true);
  const detail = rows.map((r) => `${r.index}.${r.matched ? '满足' : '未满足'}`).join('，');
  const logicText = rule.logic === 'AND' ? '所有子条件均满足' : '至少一个子条件满足';
  const badText = rule.logic === 'AND' ? '存在未满足的子条件' : '所有子条件均未满足';
  return finalize(base, rule, {
    matched, evidence,
    metReason: `${logicText}（${detail}）`,
    unmetReason: `${badText}（${detail}）`,
  }, now, previous);
}

// ---------- 判定入口 ----------
export function evaluate(rule, result, now = Date.now(), previous = {}) {
  const kind = rule.kind || 'price';
  const base = { checkedAt: new Date(now).toISOString(), source: 'fuyao', symbol: rule.symbol || null, kind };
  if (!result.ok) {
    // conflict 单独成一个状态，不并进 degraded：
    // 降级是"取不到数据"，冲突是"两份数据都取到了、但所属业务时点互相打架"。
    // 后者绝不能挑一份顺手的来用——那正好是用户最容易被误导的地方。
    const status = result.conflict ? 'conflict' : (result.degraded ? 'degraded' : 'error');
    const code = result.reasonCode || 'SOURCE_ERROR';
    return {
      ...base,
      status,
      reasonCode: code,
      // 冲突的原因句由 provider 组装（要写清两份数据各自的时点），已是中文，原样保留；
      // 其余异常把数据源的英文原文包进中文结论，界面不再直接抛 "Unknown A-share thscode"。
      reason: result.conflict ? (result.error || '数据源不可用') : reasonText(code, result.error),
      decision: NO_DECISION_TEXT,
      advice: result.advice || ADVICE_OF[code] || RETRY_ADVICE,
      rawError: result.error || null,
      evidence: result.evidence || null,
      diagnostics: result.meta || null,
    };
  }
  if (kind === 'composite') return evaluateComposite(rule, result, now, previous);

  const judged = judgeOne(rule, result);
  // 数据时点不可确认：单独标为"数据受限"，绝不允许折算成"未触发"
  if (judged.restricted) {
    return {
      ...base,
      status: 'restricted',
      reasonCode: 'DATA_RESTRICTED',
      reason: judged.unmetReason,
      decision: NO_DECISION_TEXT,
      advice: RETRY_ADVICE,
      evidence: judged.evidence,
    };
  }
  return finalize(base, rule, judged, now, previous);
}
