const BASE = 'https://fuyao.aicubes.cn';
let calendarCache = null;

function classify(code, status) {
  if (status === 429 || code === 4001) return 'rate_limited';
  if (code === 2001 || code === 2003) return 'auth_invalid';
  if (code === 2004) return 'capability_disabled';
  if (code === 1001 || code === 1002) return 'bad_request';
  if (code === 3002) return 'not_ready';
  return 'source_unavailable';
}
// 适配器错误类型 -> 对外统一 reason_code（与 02_v2 / 09 契约的 15 个列表一致）
function reasonCodeOf(kind) {
  if (kind === 'auth_invalid') return 'AUTH_INVALID';
  if (kind === 'rate_limited') return 'RATE_LIMITED';
  if (kind === 'capability_disabled') return 'CAPABILITY_DISABLED';
  if (kind === 'bad_request') return 'TICKER_NOT_FOUND';
  if (kind === 'not_ready') return 'DATA_NOT_READY';
  return 'SOURCE_ERROR';
}
const RETRY_DELAYS_MS = [800, 1600];
const RETRYABLE_KINDS = new Set(['timeout', 'source_unavailable', 'not_ready', 'rate_limited']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestOnce(path, key, timeoutMs) {
  try {
    const response = await fetch(BASE + path, { headers:{ 'X-api-key':key }, signal:AbortSignal.timeout(timeoutMs) });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok || !body || body.code !== 0) {
      const code = body?.code;
      return { ok:false, meta:{ error:{ kind:classify(code,response.status), code, message:body?.message || `HTTP ${response.status}` }, requestId:body?.request_id } };
    }
    return { ok:true, data:body.data, meta:{ fetchedAt:Date.now(), requestId:body.request_id } };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError';
    return { ok:false, meta:{ error:{ kind:timedOut ? 'timeout' : 'source_unavailable', message:timedOut ? '扶摇接口请求超时' : '扶摇接口连接或响应格式异常' } } };
  }
}
// 带退避重试：只对瞬时故障重试；凭证/参数类错误立即返回，不做无谓等待
async function request(path, key, timeoutMs = 9000) {
  if (!key) return { ok:false, meta:{ error:{ kind:'auth_invalid', message:'未配置扶摇 API Key', attempts:0 } } };
  let result = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    result = await requestOnce(path, key, timeoutMs);
    if (result.ok) {
      if (attempt > 0) result.meta.attempts = attempt + 1;
      return result;
    }
    const kind = result.meta.error.kind;
    if (!RETRYABLE_KINDS.has(kind) || attempt === RETRY_DELAYS_MS.length) {
      result.meta.error.attempts = attempt + 1;
      return result;
    }
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
  return result;
}
function shanghaiDate(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(ms);
  const get = t => parts.find(x=>x.type===t).value;
  return `${get('year')}${get('month')}${get('day')}`;
}
function dateFromMs(ms) { return shanghaiDate(Number(ms)); }
function fmtDay(v) {
  const s = String(v ?? '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : (s || '未知');
}
function fmtMinute(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(n);
  const g = (t) => parts.find((x) => x.type === t)?.value || '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

// ---------- 多源数据业务时点自洽性检查（价格条件） ----------
// 价格条件要同时用两份数据：实时快照（last_price）与历史日线（最新收盘 close）。
// 两份数据的业务时点天然不同，但必须能归入同一条可解释的时间线：
//   盘中  ：快照 = 今日盘中，日线 = 上一交易日收盘（正常，价格以快照为准）
//   非盘中：快照 = 最近收盘快照，日线 = 同一交易日
// 一旦归不进同一条时间线，就不许挑一份顺手的来用——那等于用一半的数据编一个完整结论。
//
// 判据只有三条，且都是「绝不该发生」的硬矛盾，所以不会误伤盘中的正常价格差：
//   ① 快照业务时点早于日线最新 bar  → 快照比日线还旧
//   ② 日线最新 bar 日期晚于今天     → 未来数据
//   ③ 快照自带行情日期字段时与日线不一致（接口暂未提供该字段，位置预留）
// 特别说明：**价格不同本身不是冲突**。盘中快照 1398 元、昨收 1412 元完全正常，
// 冲突判的是"时点不自洽"，不是"数值不一致"——把数值差异当冲突会让系统天天报警。
export function detectPriceTimeConflict({ snapshotDate, snapshotDateLabel, klineDate, today }) {
  if (!klineDate) return null;
  if (today && klineDate > today) {
    return {
      code: 'kline_in_future',
      reason: `日线最新数据日期 ${fmtDay(klineDate)} 晚于今天 ${fmtDay(today)}，两份数据的业务时点无法对齐`,
    };
  }
  if (snapshotDate && snapshotDate < klineDate) {
    return {
      code: 'snapshot_older_than_kline',
      reason: `实时快照与日线数据所属时点不同（快照业务时点 ${snapshotDateLabel || fmtDay(snapshotDate)}，日线最新收盘 ${fmtDay(klineDate)}）`,
    };
  }
  return null;
}

function sessionLabel(now = Date.now(), isTradeDay = false) {
  const hm = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(now);
  const inSession = isTradeDay && ((hm >= '09:30' && hm <= '11:30') || (hm >= '13:00' && hm <= '15:00'));
  return { inSession, hm, label:inSession ? '交易时段实时快照' : hm < '09:30' ? '交易日盘前，价格口径为上一交易日收盘附近快照' : '非交易时段，价格口径为最近交易日收盘附近快照' };
}
export async function fetchTradingCalendar(key = process.env.FUYAO_API_KEY) {
  if (calendarCache && Date.now() - calendarCache.cachedAt < 86400000) return calendarCache.value;
  const result = await request('/api/a-share/calendar/trading-days', key);
  if (!result.ok) return result;
  const dates = (result.data?.item || []).map(x=>String(x.date || dateFromMs(x.date_ms))).filter(Boolean).sort();
  const value = { ok:true, dates, meta:result.meta };
  calendarCache = { cachedAt:Date.now(), value };
  return value;
}
export async function fetchHistorical(symbol, key = process.env.FUYAO_API_KEY) {
  const end = Date.now(), start = end - 45 * 86400000;
  const path = `/api/a-share/prices/historical?thscode=${encodeURIComponent(symbol)}&interval=1d&start=${start}&end=${end}&adjust=forward`;
  const result = await request(path, key);
  if (!result.ok) return result;
  const items = result.data?.item || [];
  if (!items.length) return { ok:false, meta:{ ...result.meta, error:{ kind:'not_ready', message:'历史行情暂无可用 K 线' } } };
  const last = [...items].sort((a,b)=>Number(a.date_ms)-Number(b.date_ms)).at(-1);
  return { ok:true, lastBar:{ dateMs:Number(last.date_ms), date:dateFromMs(last.date_ms), close:Number(last.close_price) }, meta:{ ...result.meta, interval:result.data.interval || '1d', adjust:result.data.adjust || 'forward' } };
}
export async function searchTicker(query, key = process.env.FUYAO_API_KEY) {
  const q = String(query || '').trim();
  if (!q) return { ok:false, error:'标的名称不能为空', candidates:[] };
  const result = await request('/api/meta/tickers/search?q=' + encodeURIComponent(q), key);
  if (!result.ok) return { ok:false, error:result.meta.error?.message || '标的检索失败', candidates:[], meta:result.meta };
  const candidates = (result.data?.item || []).map(item => ({ symbol:String(item.thscode || '').toUpperCase(), name:item.name || q, ticker:item.ticker || '', exchange:item.exchange || '' })).filter(item => /^\d{6}\.(SH|SZ)$/.test(item.symbol));
  if (!candidates.length) return { ok:false, error:`没有找到“${q}”对应的 A 股标的，请改用证券代码`, candidates, meta:result.meta };
  return { ok:true, candidates, meta:result.meta };
}export async function fetchPrice(symbol, key = process.env.FUYAO_API_KEY) {
  const [snapshot, calendar, historical] = await Promise.all([
    request(`/api/a-share/prices/snapshot?thscodes=${encodeURIComponent(symbol)}`, key),
    fetchTradingCalendar(key), fetchHistorical(symbol,key)
  ]);
  if (!snapshot.ok) return { ok:false, error:snapshot.meta.error.message, errorKind:snapshot.meta.error.kind, reasonCode:reasonCodeOf(snapshot.meta.error.kind), meta:snapshot.meta };
  const item = snapshot.data?.item?.[0];
  if (!item || !Number.isFinite(Number(item.last_price)) || !Number.isFinite(Number(item.volume))) return { ok:false, error:'行情缺少价格或成交量字段', errorKind:'schema_mismatch', reasonCode:'FIELD_MISSING', meta:snapshot.meta };
  if (!calendar.ok || !historical.ok) {
    const failed = !calendar.ok ? calendar : historical;
    return { ok:false, error:`无法验证数据日期：${failed.meta.error.message}`, errorKind:failed.meta.error.kind, reasonCode:'SOURCE_ERROR', meta:{ snapshotRequestId:snapshot.meta.requestId, validationError:failed.meta.error } };
  }
  const today = shanghaiDate();
  const eligible = calendar.dates.filter(d=>d<=today);
  const latestTradingDate = eligible.at(-1);
  const isTradeDay = calendar.dates.includes(today);
  const session = sessionLabel(Date.now(),isTradeDay);
  const previousTradingDate = eligible.length > 1 ? eligible.at(-2) : latestTradingDate;
  const expectedBarDate = isTradeDay && session.hm < '15:10' ? previousTradingDate : latestTradingDate;
  if (!expectedBarDate || historical.lastBar.date < expectedBarDate) return { ok:false, degraded:true, error:`历史行情最后日期 ${historical.lastBar.date || '未知'} 落后于最近应完成交易日 ${expectedBarDate || '未知'}`, errorKind:'stale', reasonCode:'DATA_STALE', meta:{ fetchedAt:snapshot.meta.fetchedAt, latestTradingDate, expectedBarDate, lastBarDate:historical.lastBar.date } };

  // 快照的业务时点：接口带 timestamp 就用它，否则退回本次抓取时刻，并如实标注来源。
  const rawTs = Number(snapshot.data?.timestamp);
  const hasTs = Number.isFinite(rawTs) && rawTs > 0;
  const snapshotAsOfMs = hasTs ? rawTs : Number(snapshot.meta.fetchedAt);
  const snapshotAsOfSource = hasTs ? 'api_timestamp' : 'fetch_time';
  const snapshotDate = Number.isFinite(snapshotAsOfMs) && snapshotAsOfMs > 0 ? dateFromMs(snapshotAsOfMs) : null;
  const snapshotAsOfLabel = fmtMinute(snapshotAsOfMs);

  const conflict = detectPriceTimeConflict({ snapshotDate, snapshotDateLabel: snapshotAsOfLabel, klineDate: historical.lastBar.date, today });
  if (conflict) {
    return {
      ok: false,
      conflict: true,
      reasonCode: 'DATA_CONFLICT',
      error: conflict.reason,
      advice: '等待下一次检查或手动重试',
      // 冲突时同样要给全证据：评审要能一眼看到是哪两份数据、各自的业务时点是什么，
      // 而不是只看到一句"数据冲突"。
      evidence: {
        source: 'fuyao',
        dataset: 'prices/snapshot + prices/historical',
        snapshotPrice: Number(item.last_price),
        historicalClose: historical.lastBar.close,
        snapshotAsOf: snapshotAsOfLabel,
        snapshotAsOfSource,
        snapshotDate,
        klineDate: historical.lastBar.date,
        klineDateMs: historical.lastBar.dateMs,
        conflictCode: conflict.code,
        conflictReason: conflict.reason,
        latestTradingDate,
        expectedBarDate,
        sessionLabel: session.label,
        fetchedAt: snapshot.meta.fetchedAt,
        requestId: snapshot.meta.requestId,
        attempts: snapshot.meta.attempts || 1,
        unit: 'CNY/share',
        asOf: null,
        asOfSource: 'conflict',
      },
      meta: {
        snapshotRequestId: snapshot.meta.requestId,
        historicalRequestId: historical.meta?.requestId,
        conflictCode: conflict.code,
        snapshotDate,
        snapshotAsOfSource,
        klineDate: historical.lastBar.date,
        latestTradingDate,
        expectedBarDate,
      },
    };
  }

  return { ok:true, price:Number(item.last_price), volume:Number(item.volume), turnover:Number(item.turnover), changeRatioPct:Number(item.price_change_ratio_pct), prevClose:Number(item.prev_price), fetchedAt:snapshot.meta.fetchedAt, marketDate:historical.lastBar.date, latestTradingDate, expectedBarDate, requestId:snapshot.meta.requestId, sessionLabel:session.label, inSession:session.inSession, priceField:'last_price', historicalClose:historical.lastBar.close, historicalAdjust:historical.meta.adjust, attempts:snapshot.meta.attempts || 1, snapshotAsOf:snapshotAsOfLabel, snapshotAsOfSource, snapshotDate, timeConflict:null, asOf:historical.lastBar.date, asOfSource:'kline_date' };
}
// 热度条件：热股榜（实测 30 条，字段含 rank / heat 字符串 / name）
export async function fetchHeat(symbol, key = process.env.FUYAO_API_KEY) {
  const result = await request('/api/a-share/special-data/hot-stock-list', key);
  if (!result.ok) return { ok:false, error:result.meta.error.message, errorKind:result.meta.error.kind, reasonCode:reasonCodeOf(result.meta.error.kind), meta:result.meta };
  const items = result.data?.item || [];
  if (!items.length) return { ok:false, error:'热股榜本次返回为空', errorKind:'not_ready', reasonCode:'DATA_NOT_READY', meta:result.meta };
  const hit = items.find((x) => String(x.thscode || '').toUpperCase() === symbol);
  const heatValue = hit ? Number(hit.heat) : NaN;
  // 数据时点三态（配套 engine.js 的 judgeHeat）：
  // 热榜接口的 data.timestamp 是**本次抓取时刻**，不是榜单业务时点（02_v2 §三 实测确认），
  // 因此 datasetTime 恒为 null，当前真实落点是 fetch_time（有抓取时间、无业务时间）；
  // 只有连抓取时刻都记不下来时才会落到 unavailable，此时判定层给出「数据受限」而非「未触发」。
  // 将来接口若提供可信的业务时点，在 datasetTime 填入即可自动升级为 dataset_time。
  const datasetTime = null;
  const fetchTime = Number(result.meta.fetchedAt);
  const dataTimeStatus = datasetTime ? 'dataset_time' : (Number.isFinite(fetchTime) ? 'fetch_time' : 'unavailable');
  return {
    ok:true,
    inList:Boolean(hit),
    rank:hit ? Number(hit.rank) : null,
    heat:Number.isFinite(heatValue) ? heatValue : null,
    name:hit?.name || null,
    listSize:items.length,
    topName:items[0]?.name || null,
    fetchedAt:Number.isFinite(fetchTime) ? fetchTime : null,
    datasetTime,
    dataTimeStatus,
    requestId:result.meta.requestId,
    attempts:result.meta.attempts || 1,
    asOf:datasetTime,
    asOfSource:dataTimeStatus,
  };
}
// 事件条件：个股异动原因（扶摇唯一对 API Key 开放的事件类数据源）
export async function fetchEvent(symbol, key = process.env.FUYAO_API_KEY) {
  const result = await request('/api/a-share/special-data/anomaly-analysis-list', key);
  if (!result.ok) return { ok:false, error:result.meta.error.message, errorKind:result.meta.error.kind, reasonCode:reasonCodeOf(result.meta.error.kind), meta:result.meta };
  const items = result.data?.item || [];
  if (!items.length) return { ok:false, error:'异动原因本次返回为空', errorKind:'not_ready', reasonCode:'DATA_NOT_READY', meta:result.meta };
  const hit = items.find((x) => String(x.thscode || '').toUpperCase() === symbol);
  const dataTs = Number(result.data?.timestamp);
  const asOf = Number.isFinite(dataTs) && dataTs > 0 ? new Date(dataTs).toISOString() : null;
  return {
    ok:true,
    matched:Boolean(hit),
    tagName:hit?.tag_name || null,
    keywords:Array.isArray(hit?.keyword_list) ? hit.keyword_list : [],
    analysis:hit?.analysis_content || null,
    listSize:items.length,
    fetchedAt:result.meta.fetchedAt,
    requestId:result.meta.requestId,
    attempts:result.meta.attempts || 1,
    asOf,
    asOfSource:asOf ? 'api_timestamp' : 'unavailable',
  };
}
// 日历条件：交易日状态（calendar/trading-days 无入参，固定窗口 [今日-1年,今日]）
export async function fetchTradingState(key = process.env.FUYAO_API_KEY) {
  const calendar = await fetchTradingCalendar(key);
  if (!calendar.ok) return { ok:false, error:calendar.meta?.error?.message || '交易日历获取失败', errorKind:calendar.meta?.error?.kind, reasonCode:reasonCodeOf(calendar.meta?.error?.kind), meta:calendar.meta };
  const today = shanghaiDate();
  const eligible = calendar.dates.filter((d) => d <= today);
  const isTradeDay = calendar.dates.includes(today);
  const session = sessionLabel(Date.now(), isTradeDay);
  return {
    ok:true,
    today,
    isTradeDay,
    latestTradingDate:eligible.at(-1) || null,
    previousTradingDate:eligible.length > 1 ? eligible.at(-2) : (eligible.at(-1) || null),
    sessionLabel:session.label,
    inSession:session.inSession,
    fetchedAt:Date.now(),
    requestId:calendar.meta?.requestId,
    attempts:calendar.meta?.attempts || 1,
    asOf:today,
    asOfSource:'trading_calendar',
  };
}
export function resetProviderCache(){ calendarCache=null; }

