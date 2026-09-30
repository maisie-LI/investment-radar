const $ = (s) => document.querySelector(s);
// 表单字段 id 规则：编辑弹窗为 edit + 首字母大写（editKind / editComboList / editCompositeEditor），
// 草稿区无前缀（kind / comboList）。此处统一由 fid() 生成，避免手动拼接时大小写不一致 ——
// 曾因把小写的字段名直接拼在前缀后面，导致编辑弹窗所有字段取不到元素、编辑功能整体失效（2026-09-30 修复）。
const fid = (p, base) => '#' + (p ? p + base[0].toUpperCase() + base.slice(1) : base);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const names = { pending: '待检查', triggered: '已触发', not_triggered: '未触发', cooldown: '冷却中', deduplicated: '已去重', degraded: '已降级', error: '检查失败', restricted: '数据受限', conflict: '数据存在冲突', skipped: '未执行' };
let editing = null;
let lastData = { tasks: [], runs: [] };
// 展开状态按记录 id 记住：刷新（如手动检查后）不应把用户展开的记录收回去
const RUN_OPEN = new Set();

// 各条件类型的表单形态：决定显示哪些字段、可选操作符、阈值输入类型
const KIND_UI = {
  price: { symbol: true, ops: [['above', '高于'], ['below', '低于']], th: { label: '阈值（元）', type: 'number', ph: '1500' } },
  heat: { symbol: true, ops: [['in_top', '进入热股榜前 N 名']], th: { label: '名次 N', type: 'number', ph: '10' } },
  event: { symbol: true, ops: [['contains', '异动关键词命中']], th: { label: '关键词', type: 'text', ph: '跌停' } },
  calendar: { symbol: false, ops: [['is_trade_day', '今日是交易日'], ['is_not_trade_day', '今日是非交易日']], th: null },
};
const KIND_LABEL = { price: '价格', heat: '热度', event: '事件', calendar: '日历', composite: '组合' };
// 取不到类型时如实标注「未标注」，不要默认成「价格」——对历史记录乱猜等于展示假信息
const kindLabel = (k) => KIND_LABEL[k] || k || '未标注';

// 子条件的一句话描述。服务端判定证据里也带同样口径的 label（evidence.parts[].label），
// 这里是为了任务卡 / 版本历史这类"还没有证据"的场景也能显示组合结构。
function condLabel(c) {
  const kind = c?.kind || 'price';
  if (kind === 'heat') return `热度 ${c.symbol} 进入热榜前 ${c.threshold} 名`;
  if (kind === 'event') return `事件 ${c.symbol} 出现「${c.threshold}」`;
  if (kind === 'calendar') return c.operator === 'is_trade_day' ? '日历 今日为交易日' : '日历 今日为非交易日';
  return `价格 ${c.symbol} ${c.operator === 'above' ? '高于' : '低于'} ${c.threshold} 元`;
}

// 组合条件的展示文本：逻辑 + 每个子条件
function compositeText(rule) {
  const logic = rule.logic === 'OR' ? '或者（任一满足）' : '并且（同时满足）';
  const list = (rule.conditions || []).map((c, i) => `${i + 1}. ${condLabel(c)}`).join('；');
  return `${logic}：${list}`;
}

function ruleText(r) {
  if (!r) return '—';
  if (r.kind === 'composite') return compositeText(r);
  if (r.kind === 'heat') return `${r.symbol} · 进入热股榜前 ${r.threshold} 名`;
  if (r.kind === 'event') return `${r.symbol} · 异动关键词「${r.threshold}」`;
  if (r.kind === 'calendar') return r.operator === 'is_trade_day' ? '今日为交易日时提醒' : '今日为非交易日时提醒';
  return `${r.symbol} · ${r.operator === 'above' ? '高于' : '低于'} ${r.threshold} 元`;
}

// 无法给出结论的状态：界面必须统一写「本次未执行条件判断」，
// 不能让"数据没拿到"和"检查过了、只是没触发"看起来像同一件事。
const NO_DECISION = ['degraded', 'error', 'restricted', 'conflict'];
const NO_DECISION_TEXT = '本次未执行条件判断';
const RETRY_ADVICE = '等待下一次检查或手动重试';

// 组合条件里单个子条件的判定状态
const PART_STATUS = { satisfied: '满足', not_satisfied: '未满足', unavailable: '数据不可用', restricted: '数据受限', conflict: '数据存在冲突' };
const partStatusLabel = (s) => PART_STATUS[s] || s;

function evidenceText(e, kind) {
  if (!e) return '没有用于判定的有效数据（异常时不编造结论）';
  if (kind === 'composite') {
    const parts = e.parts || [];
    if (!parts.length) return '组合条件没有可展示的子条件证据';
    return `${e.logicLabel || e.logic || ''} · ${parts.map((p) => `${p.index}.${partStatusLabel(p.status)}`).join('，')}`;
  }
  if (kind === 'heat') {
    // 热度三态：业务时间可用 / 只有抓取时间 / 都不可用。展示上必须让用户一眼看出
    // 这个结论建立在什么时点的数据上，而不是给一句含义不明的"数据时间：不可用"。
    const parts = [
      e.inList ? `榜单第 ${e.rank ?? '—'} 名` : '未进入榜单',
      `榜内共 ${e.listSize ?? '—'} 条`,
      `当前榜首 ${e.topName || '—'}`,
    ];
    if (e.dataTimeStatus === 'dataset_time') {
      parts.push(`榜单业务时间 ${e.datasetTime ? dt(e.datasetTime) : '—'}`);
    } else if (e.dataTimeStatus === 'fetch_time') {
      parts.push(`获取时间 ${e.fetchedAt ? dt(e.fetchedAt) : '—'}`);
      parts.push('榜单业务时间：数据源未提供');
    } else {
      parts.push('榜单业务时间：不可用');
    }
    if (e.confidence) parts.push(`可信度：${e.confidence}`);
    return parts.join(' · ');
  }
  if (kind === 'event') return e.matched ? `异动标签「${e.tagName || '—'}」· 关键词 ${(e.keywords || []).join('、') || '—'}` : `本次异动列表中未出现该标的（共 ${e.listSize} 条）`;
  if (kind === 'calendar') return `今日 ${e.today} · ${e.isTradeDay ? '交易日' : '非交易日'} · 最近交易日 ${e.latestTradingDate || '—'}`;
  if (e.today) return `今日 ${e.today} 非交易日，未执行判定`;
  // 数据冲突：把两份数据各自的价格与业务时点并排摆出来，让人一眼看清冲突到底在哪，
  // 而不是只看到一句"数据冲突"却不知道是哪两份数据在打架。
  if (e.conflictCode) {
    return `实时快照 ${e.snapshotPrice} 元（业务时点 ${e.snapshotAsOf || '—'}，来源 ${e.snapshotAsOfSource || '—'}）· 日线最新收盘 ${e.historicalClose} 元（${e.klineDate || '—'}）· 两份数据所属时点不同，未执行判定`;
  }
  return `${e.price} 元 · 行情日期 ${e.marketDate || '待验证'} · ${e.sessionLabel || ''}`;
}

async function api(url, options = {}) {
  // 超时是必需的：没有超时的话，请求悬挂会让页面永远停在「正在检查…」，
  // 这本身就是我们最反对的「静默错误」——必须失败得明明白白。
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000), ...options });
  const b = await r.json();
  if (!r.ok) throw Error(b.error || '请求失败');
  return b;
}
const dt = (v) => (v ? new Date(v).toLocaleString() : '尚未运行');

// 启动期的任何异常都必须显示出来：静默停在「正在检查数据服务状态」等于向用户撒谎。
function surfaceBootError(message) {
  const el = $('#healthBanner');
  if (el) { el.className = 'health-banner error'; el.textContent = message; }
  const badge = $('#dataBadge');
  if (badge) badge.textContent = '连接失败';
}
window.addEventListener('error', (ev) => surfaceBootError(`页面脚本异常：${ev.message || '未知错误'}（请刷新页面；若持续出现请反馈）`));
window.addEventListener('unhandledrejection', (ev) => surfaceBootError(`页面请求异常：${(ev.reason && ev.reason.message) || ev.reason || '未知错误'}（请刷新页面；若持续出现请反馈）`));

// 安全绑定：元素缺失时不再抛错中断整个脚本，改为在控制台留下可排查的记录
function on(selector, event, handler) {
  const el = $(selector);
  if (!el) { console.warn('[radar] 缺少元素，已跳过绑定：', selector); return false; }
  el[event] = handler;
  return true;
}

// 类型切换：动态调整字段可见性与操作符选项
function syncKindFields(kind, p) {
  const isCombo = kind === 'composite';
  const ui = KIND_UI[kind] || KIND_UI.price;
  const sf = $(fid(p, 'symbolField'));
  const of = $(fid(p, 'operatorField'));
  const tf = $(fid(p, 'thresholdField'));
  // 组合条件下，标的 / 操作符 / 阈值由每个子条件行各自管理，顶层不再显示这三个字段
  if (sf) sf.classList.toggle('hidden', isCombo || !ui.symbol);
  if (of) of.classList.toggle('hidden', isCombo);
  if (tf) tf.classList.toggle('hidden', isCombo || !ui.th);
  const editor = $(fid(p, 'compositeEditor'));
  if (editor) editor.classList.toggle('hidden', !isCombo);

  if (isCombo) {
    const list = $(fid(p, 'comboList'));
    if (list && !list.querySelector('.cond')) {
      renderCombo({ logic: 'AND', conditions: [{ kind: 'price', symbol: '', operator: 'below', threshold: '' }] }, p);
    }
    return;
  }

  const op = $(fid(p, 'operator'));
  if (op) op.innerHTML = ui.ops.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  const th = $(fid(p, 'threshold'));
  if (th && ui.th) {
    th.type = ui.th.type;
    th.placeholder = ui.th.ph;
    if (ui.th.type === 'number') th.setAttribute('step', '0.01');
    else th.removeAttribute('step');
  }
}

// ---------- 组合条件的子条件编辑器 ----------
const COMBO_KINDS = [['price', '价格'], ['heat', '热度'], ['event', '事件'], ['calendar', '日历']];

function condRowHtml(c, i) {
  const ui = KIND_UI[c.kind] || KIND_UI.price;
  return `<div class="cond" data-i="${i}">
      <span class="cond-idx">${i + 1}</span>
      <select class="c-kind">${COMBO_KINDS.map(([v, l]) => `<option value="${v}"${v === c.kind ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <input class="c-symbol" value="${esc(c.symbol || '')}" placeholder="600519.SH"${ui.symbol ? '' : ' disabled'}>
      <select class="c-op">${ui.ops.map(([v, l]) => `<option value="${v}"${v === c.operator ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <input class="c-th" value="${esc(c.threshold ?? '')}" placeholder="${esc(ui.th ? ui.th.ph : '')}"${ui.th ? '' : ' disabled'}>
      <button class="ghost c-del" type="button">删除</button>
    </div>`;
}

function readCondRow(row) {
  const kind = row.querySelector('.c-kind')?.value || 'price';
  const ui = KIND_UI[kind] || KIND_UI.price;
  const raw = row.querySelector('.c-th')?.value ?? '';
  return {
    kind,
    symbol: ui.symbol ? (row.querySelector('.c-symbol')?.value.trim().toUpperCase() || null) : null,
    operator: row.querySelector('.c-op')?.value || ui.ops[0][0],
    threshold: ui.th ? (ui.th.type === 'number' ? (String(raw).trim() === '' ? null : Number(raw)) : String(raw).trim()) : null,
  };
}

function collectConditions(p) {
  const list = $(fid(p, 'comboList'));
  if (!list) return [];
  return [...list.querySelectorAll('.cond')].map(readCondRow);
}

function bindComboRows(p) {
  const list = $(fid(p, 'comboList'));
  if (!list) return;
  list.querySelectorAll('.cond').forEach((row) => {
    const kindSel = row.querySelector('.c-kind');
    if (kindSel) {
      kindSel.onchange = () => {
        // 换类型就重建整组行：操作符可选项和字段可用性都随类型变化，
        // 其余行先读回当前值，避免用户已填的内容被冲掉。
        const next = [...list.querySelectorAll('.cond')].map(readCondRow);
        const i = Number(row.dataset.i);
        next[i] = { kind: kindSel.value, symbol: null, operator: (KIND_UI[kindSel.value] || KIND_UI.price).ops[0][0], threshold: null };
        list.innerHTML = next.map(condRowHtml).join('');
        bindComboRows(p);
      };
    }
    const del = row.querySelector('.c-del');
    if (del) {
      del.onclick = () => {
        const next = [...list.querySelectorAll('.cond')].map(readCondRow).filter((_, i) => i !== Number(row.dataset.i));
        if (!next.length) next.push({ kind: 'price', symbol: null, operator: 'below', threshold: null });
        list.innerHTML = next.map(condRowHtml).join('');
        bindComboRows(p);
      };
    }
  });
}

function renderCombo(rule, p) {
  const list = $(fid(p, 'comboList'));
  if (!list) return;
  const logic = $(fid(p, 'comboLogic'));
  if (logic) logic.value = rule?.logic === 'OR' ? 'OR' : 'AND';
  const conditions = rule?.conditions?.length
    ? rule.conditions
    : [{ kind: 'price', symbol: null, operator: 'below', threshold: null }];
  list.innerHTML = conditions.map(condRowHtml).join('');
  bindComboRows(p);
}

function addCondRow(p) {
  const list = $(fid(p, 'comboList'));
  if (!list) return;
  const next = [...list.querySelectorAll('.cond')].map(readCondRow);
  if (next.length >= 5) return;
  next.push({ kind: 'price', symbol: null, operator: 'below', threshold: null });
  list.innerHTML = next.map(condRowHtml).join('');
  bindComboRows(p);
}

// 任务卡：三种生命周期状态（运行中 / 已暂停 / 已归档）在按钮与状态标签上都要分得清。
// 归档刻意不提供永久删除——这是审计型产品，记录本身就是产物。
function taskCard(t) {
  const archived = t.archived === true;
  const stateLabel = archived ? '已归档' : (t.enabled ? '运行中' : '已暂停');
  const statusText = archived ? '已归档' : (t.enabled ? (names[t.lastStatus] || t.lastStatus) : '已暂停');
  const tail = archived
    ? `不再调度 · 归档于 ${dt(t.archivedAt)}（历史与证据完整保留）`
    : `下次：${dt(t.nextRunAt)}`;
  const actions = archived
    ? `<button class="ghost unarchive" data-id="${t.id}">恢复启用</button>
      <button class="ghost edit" data-id="${t.id}">编辑</button>
      <button class="ghost detail" data-id="${t.id}">详情</button>`
    : `<button class="ghost check" data-id="${t.id}">立即检查</button>
      <button class="ghost toggle" data-id="${t.id}" data-enabled="${t.enabled}">${t.enabled ? '暂停' : '恢复'}</button>
      <button class="ghost edit" data-id="${t.id}">编辑</button>
      <button class="ghost archive" data-id="${t.id}">归档</button>
      <button class="ghost detail" data-id="${t.id}">详情</button>`;
  return `<article class="task ${!archived && !t.enabled ? 'off' : ''}${archived ? ' archived' : ''}">
    <div>
      <b>${esc(t.title)}</b>
      <div class="meta"><span class="kind-tag">${kindLabel(t.rule.kind)}</span> ${esc(ruleText(t.rule))} · 每 ${t.rule.intervalMinutes} 分钟 · 冷却 ${t.rule.cooldownMinutes} 分钟 · v${t.version}</div>
      <div class="meta">${stateLabel} · 最近检查：${dt(t.lastCheckedAt)} · ${tail}</div>
    </div>
    <div class="task-actions">
      <span class="status ${archived ? 'archived' : (t.lastStatus || '')}">${esc(statusText)}</span>
      ${actions}
    </div>
  </article>`;
}

// 原始字段：把所有可直接回溯的字段摊平，便于截图留证
function rawOf(r) {
  const e = r.evidence || {};
  return [
    `reason_code=${r.reasonCode || ''}`,
    `status=${r.status || ''}`,
    `decision=${r.decision || 'N/A'}`,
    `kind=${r.kind || ''}`,
    `checked_at=${r.checkedAt || ''}`,
    `rule_version=v${r.version ?? '?'}`,
    `mode=${r.mode || ''}`,
    `request_id=${e.requestId || 'N/A'}`,
    `as_of=${e.asOf || 'N/A'}`,
    `as_of_source=${e.asOfSource || 'N/A'}`,
    `data_time_status=${e.dataTimeStatus || 'N/A'}`,
    `market_date=${e.marketDate || 'N/A'}`,
    `snapshot_as_of=${e.snapshotAsOf || 'N/A'}`,
    `kline_date=${e.klineDate || 'N/A'}`,
    `attempts=${e.attempts ?? 'N/A'}`,
  ].join(' · ');
}

// 组合条件的证据不是一句话，而是「每个子条件一行 + 组合逻辑 + 最终结果」。
// 压成一行会让人看不出到底是哪个子条件没满足、哪个子条件数据不可用。
function compositeBlock(r) {
  const e = r.evidence || {};
  const parts = e.parts || [];
  if (!parts.length) return '';
  const rows = parts.map((p) => `<span class="composite-row"><b>${esc(p.index)}</b> <span class="part-status ${esc(p.status)}">${esc(partStatusLabel(p.status))}</span> <span class="part-label">${esc(p.label || '')}</span> <span class="meta">${esc(p.reason || '')}</span></span>`).join('');
  return `<div class="run-line"><b>组合逻辑</b><span>${esc(e.logicLabel || e.logic || '')}</span></div>
      <div class="run-line"><b>子条件</b><span class="composite-list">${rows}</span></div>
      <div class="run-line"><b>组合结果</b><span>${esc(names[r.status] || r.status)}：${esc(r.reason || '')}</span></div>`;
}

// 无结论的三行必须显式给出：结果 / 原因 / 建议。
// 只写一句"数据冲突"会让人以为"系统检查过了、只是没触发"，那是完全不同的意思。
function noDecisionBlock(r) {
  if (!NO_DECISION.includes(r.status)) return '';
  return `<div class="run-line"><b>结果</b><span class="no-decision">${esc(r.decision || NO_DECISION_TEXT)}</span></div>
      <div class="run-line"><b>原因</b><span>${esc(r.reason || '—')}</span></div>
      <div class="run-line"><b>建议</b><span>${esc(r.advice || RETRY_ADVICE)}</span></div>`;
}

function runCard(r) {
  const e = r.evidence;
  const open = RUN_OPEN.has(r.id) ? ' open' : '';
  const diag = r.diagnostics
    ? `<div class="run-line"><b>诊断</b><span class="raw">${esc(JSON.stringify(r.diagnostics))}</span></div>`
    : '';
  // 没有判定就没有"判定依据"，如实改叫"数据情况"
  const basisLabel = NO_DECISION.includes(r.status) ? '数据情况' : '判定依据';
  const recoveryLine = r.recovery
    ? `<div class="run-line"><b>恢复</b><span>${esc(r.recovery.label || '')}：${esc(r.recovery.action || '')}</span></div>`
    : '';
  return `<details class="run" data-run="${esc(r.id)}"${open}>
    <summary class="run-head">
      <span class="caret" aria-hidden="true"></span>
      <span class="run-main">
        <span class="status ${esc(r.status)}">${esc(names[r.status] || r.status)}</span>
        <span class="reason-code">${esc(r.reasonCode || '')}</span>
        <span class="kind-tag small">${esc(kindLabel(r.kind))}</span>
        <span class="run-reason">${esc(r.reason)}</span>
      </span>
      <time>${dt(r.checkedAt)}</time>
    </summary>
    <div class="run-body">
      <div class="run-line"><b>任务</b><span>${esc(r.taskTitle || r.symbol || '—')} · 规则 v${esc(r.version ?? '—')} · ${r.mode === 'scheduled' ? '定时检查' : '手动检查'}${r.durationMs != null ? ` · 耗时 ${esc(r.durationMs)}ms` : ''}</span></div>
      ${noDecisionBlock(r)}
      <div class="run-line"><b>${basisLabel}</b><span>${esc(evidenceText(e, r.kind))}</span></div>
      ${r.kind === 'composite' ? compositeBlock(r) : ''}
      ${recoveryLine}
      <div class="run-line"><b>原始字段</b><span class="raw">${esc(rawOf(r))}</span></div>
      ${diag}
    </div>
  </details>`;
}

// 上海时区日期，用于「今天」这类区间判断（与后端去重用同一时区口径）
function shanghaiDayOf(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}${g('month')}${g('day')}`;
}

// 「结果」筛选把状态收敛成 5 组，避免下拉框过长。
// 数据受限 / 数据冲突并入"降级"组：它们和降级是同一类语义——数据不足以给出结论。
const STATUS_GROUPS = {
  triggered: (r) => r.status === 'triggered',
  not_triggered: (r) => r.status === 'not_triggered',
  suppressed: (r) => r.status === 'cooldown' || r.status === 'deduplicated',
  skipped: (r) => r.status === 'skipped',
  degraded: (r) => ['degraded', 'error', 'restricted', 'conflict'].includes(r.status),
};

function filterRuns() {
  const taskId = $('#runFilter')?.value || '';
  const status = $('#runStatus')?.value || '';
  const kind = $('#runKind')?.value || '';
  const range = $('#runRange')?.value || 'all';
  const now = Date.now();
  const today = shanghaiDayOf(now);
  const from = range === '24h' ? now - 86400000 : range === '7d' ? now - 7 * 86400000 : null;
  return lastData.runs.filter((r) => {
    if (taskId && r.taskId !== taskId) return false;
    if (kind && r.kind !== kind) return false;
    if (status && !(STATUS_GROUPS[status] || (() => false))(r)) return false;
    if (range === 'today') return shanghaiDayOf(r.checkedAt) === today;
    if (from != null) return Date.parse(r.checkedAt) >= from;
    return true;
  });
}

function bindRunToggles() {
  document.querySelectorAll('#runs .run').forEach((el) => {
    el.addEventListener('toggle', () => {
      if (el.open) RUN_OPEN.add(el.dataset.run); else RUN_OPEN.delete(el.dataset.run);
    });
  });
}

function renderRuns() {
  const runs = filterRuns();
  const total = lastData.runs.length;
  const empty = total
    ? '<p>当前筛选条件下没有记录。可以放宽时间区间或把「结果」改回全部结果。</p>'
    : '<p>还没有检查记录。创建任务后点击任务卡上的「立即检查」即可生成第一条。</p>';
  $('#runs').innerHTML = runs.length ? runs.map(runCard).join('') : empty;
  const count = $('#runCount');
  if (count) count.textContent = total ? `显示 ${runs.length} / ${total} 条记录` : '';
  const btn = $('#runToggleAll');
  if (btn) btn.textContent = runs.length && runs.every((r) => RUN_OPEN.has(r.id)) ? '全部收起' : '全部展开';
  bindRunToggles();
}

// 数据指纹：内容没变就不重建 DOM。
// 自动轮询每 30 秒跑一次，若无条件重渲染，用户正在展开的记录和滚动位置会被反复重置。
let lastFingerprint = '';

// 任务列表按生命周期筛选：运行中 / 已暂停 / 已归档 是三个互斥的可见状态，
// 长期运行后必须能一眼分清哪些还在跑、哪些只是暂停、哪些已经收起来了。
function filterTasks() {
  const f = $('#taskFilter')?.value || 'all';
  const all = lastData.tasks || [];
  if (f === 'active') return all.filter((t) => !t.archived && t.enabled);
  if (f === 'paused') return all.filter((t) => !t.archived && !t.enabled);
  if (f === 'archived') return all.filter((t) => t.archived);
  return all;
}

function renderTasks() {
  const box = $('#tasks');
  if (!box) return;
  const list = filterTasks();
  box.innerHTML = list.length
    ? list.map(taskCard).join('')
    : (lastData.tasks.length
      ? '<p>当前筛选条件下没有任务。把「任务状态」改回「全部」即可看到。</p>'
      : '<p>尚无任务，请先添加关注条件。</p>');
  bindActions();
}

async function refresh() {
  const b = await api('/api/tasks');
  lastData = b;
  // 新触发检测每次都跑：它判断的是"有没有新触发的记录"，与是否重渲染无关
  announceTriggers(b.runs);
  $('#dataBadge').textContent = b.liveDataConfigured ? '扶摇行情已连接' : '未配置实时行情密钥';
  $('#healthBanner').className = 'health-banner ' + b.health.status;
  $('#healthBanner').textContent = b.health.message;

  const counts = b.counts || {};
  const setText = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
  setText('#sumTotal', counts.total ?? b.tasks.length);
  setText('#sumActive', counts.active ?? b.tasks.filter((t) => !t.archived && t.enabled).length);
  setText('#sumPaused', counts.paused ?? b.tasks.filter((t) => !t.archived && !t.enabled).length);
  setText('#sumArchived', counts.archived ?? b.tasks.filter((t) => t.archived).length);
  setText('#sumTriggered', b.runs.filter((r) => r.status === 'triggered').length);
  setText('#sumIssues', b.runs.filter((r) => ['error', 'degraded', 'restricted', 'conflict'].includes(r.status)).length);

  const fingerprint = JSON.stringify({ tasks: b.tasks, runs: b.runs });
  if (fingerprint === lastFingerprint) return;
  lastFingerprint = fingerprint;

  renderTasks();
  const selected = $('#runFilter').value;
  $('#runFilter').innerHTML = '<option value="">全部任务</option>' + b.tasks.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join('');
  $('#runFilter').value = selected;
  renderRuns();
}

function bindActions() {
  document.querySelectorAll('.check').forEach((x) => {
    x.onclick = async () => {
      const id = x.dataset.id;
      x.disabled = true;
      x.textContent = '检查中…';
      try {
        await api('/api/tasks/' + id + '/check', { method: 'POST' });
      } catch (e) {
        // 409「任务正在检查中」通常意味着定时检查刚好在跑，不是故障：
        // 等它落地即可。此前这里直接弹原始终端文案且不刷新，界面会停在旧状态。
        if (!/正在检查中/.test(e.message)) alert(e.message);
        else await new Promise((r) => setTimeout(r, 2500));
      } finally {
        x.disabled = false;
        x.textContent = '立即检查';
      }
      // 无论成功还是"已经有人在检查"，都要把最新状态拉回来
      try { await refresh(); } catch (e) { surfaceBootError(`刷新失败：${e.message}`); }
    };
  });
  document.querySelectorAll('.toggle').forEach((x) => {
    x.onclick = async () => {
      await api('/api/tasks/' + x.dataset.id, { method: 'PATCH', body: JSON.stringify({ enabled: x.dataset.enabled !== 'true' }) });
      await refresh();
    };
  });
  document.querySelectorAll('.edit').forEach((x) => { x.onclick = () => openEdit(lastData.tasks.find((t) => t.id === x.dataset.id)); });
  document.querySelectorAll('.detail').forEach((x) => { x.onclick = () => openDetail(lastData.tasks.find((t) => t.id === x.dataset.id)); });
  document.querySelectorAll('.archive').forEach((x) => {
    x.onclick = async () => {
      const t = lastData.tasks.find((y) => y.id === x.dataset.id);
      // 归档是较重的操作，给一次确认；但要说清它"只收纳、不删除"，避免用户以为会丢数据。
      const ok = window.confirm(`归档「${t ? t.title : '该任务'}」？\n\n归档后不再调度检查，但版本历史与全部检查记录都会保留，随时可以「恢复启用」。本产品不提供永久删除。`);
      if (!ok) return;
      try {
        await api('/api/tasks/' + x.dataset.id, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
        await refresh();
      } catch (e) { alert(e.message); }
    };
  });
  document.querySelectorAll('.unarchive').forEach((x) => {
    x.onclick = async () => {
      try {
        await api('/api/tasks/' + x.dataset.id, { method: 'PATCH', body: JSON.stringify({ archived: false }) });
        await refresh();
      } catch (e) { alert(e.message); }
    };
  });
}

// 把一条规则填进表单（草稿区 p=''、编辑弹窗 p='edit'）
function applyRule(rule, p) {
  const kind = rule?.kind || 'price';
  const kEl = $(fid(p, 'kind'));
  if (kEl) kEl.value = kind;
  syncKindFields(kind, p);

  if (kind === 'composite') {
    renderCombo(rule, p);
  } else {
    const ui = KIND_UI[kind] || KIND_UI.price;
    const sym = $(fid(p, 'symbol'));
    const op = $(fid(p, 'operator'));
    const th = $(fid(p, 'threshold'));
    if (sym) sym.value = ui.symbol ? (rule.symbol || '') : '';
    if (op) op.value = rule.operator;
    if (th) th.value = rule.threshold ?? '';
  }
  const itv = $(fid(p, 'interval'));
  const cd = $(fid(p, 'cooldown'));
  if (itv) itv.value = rule.intervalMinutes;
  if (cd) cd.value = rule.cooldownMinutes;
}

function openEdit(t) {
  editing = t;
  $('#editTitle').value = t.title;
  applyRule(t.rule, 'edit');
  $('#taskModal').classList.remove('hidden');
}

// 运行状态：把"恢复"讲成一个过程，而不是一句"现在正常"。
// 评审要能看到四件事——什么时候坏的、坏在什么上、什么时候好的、好起来时做了什么处理。
function recoveryBlock(t) {
  const rec = t.recovery || {};
  const hist = Array.isArray(rec.history) ? rec.history : [];
  const errorText = rec.lastErrorAt
    ? `${dt(rec.lastErrorAt)} ${rec.lastErrorStatus ? (names[rec.lastErrorStatus] || rec.lastErrorStatus) : ''}${rec.lastErrorReason ? ' · ' + rec.lastErrorReason : ''}`
    : '暂无异常';
  const rows = hist.length
    ? hist.map((h) => `<span class="recovery-row"><b>${esc(dt(h.at))}</b><span class="part-status ok">${esc(h.label || '')}</span><span class="meta">${esc(h.action || '')}</span></span>`).join('')
    : '<p class="meta">尚无恢复记录。暂停后恢复、归档后重新启用、接口故障恢复、服务重启恢复、错过计划补跑、数据源恢复后重查，都会记录在这里。</p>';
  return `<div class="detail-section"><b>运行状态</b>
      <div class="fact-grid">
        <div class="fact"><span>最近成功检查</span><b>${rec.lastSuccessAt ? esc(dt(rec.lastSuccessAt)) : '暂无'}</b></div>
        <div class="fact"><span>最近异常</span><b>${esc(errorText)}</b></div>
        <div class="fact"><span>恢复时间</span><b>${rec.recoveredAt ? esc(dt(rec.recoveredAt)) : '暂无'}</b></div>
      </div>
      <p class="meta"><b>恢复处理</b>：${rec.recoveryAction ? esc(rec.recoveryAction) : '暂无恢复记录'}</p>
      ${rec.recoveryFrom ? `<p class="meta">恢复自：${esc(names[rec.recoveryFrom.status] || rec.recoveryFrom.status)}${rec.recoveryFrom.reason ? ' · ' + esc(rec.recoveryFrom.reason) : ''} · ${esc(dt(rec.recoveryFrom.checkedAt))}</p>` : ''}
      <div class="recovery-list">${rows}</div>
      <p class="meta">累计恢复 ${rec.recoveryCount || 0} 次。恢复不等于重新提醒：恢复后的检查仍走同一套去重与冷却逻辑，不会因为"刚恢复"就补发一次通知。</p>
    </div>`;
}

function openDetail(t) {
  const runs = lastData.runs.filter((r) => r.taskId === t.id);
  const latest = runs[0];
  const e = latest?.evidence;
  const typeNames = KIND_UI[t.rule.kind] || KIND_UI.price;
  const knownOps = (typeNames.ops || []).find(([v]) => v === t.rule.operator);
  const stateLabel = t.archived ? '已归档' : (t.enabled ? '运行中' : '已暂停');
  $('#detailContent').innerHTML = `
    <div class="detail-section"><h3>${esc(t.title)}</h3>
      <div class="fact-grid">
        <div class="fact"><span>任务状态</span><b>${stateLabel}</b></div>
        <div class="fact"><span>条件类型</span><b>${kindLabel(t.rule.kind)}</b></div>
        <div class="fact"><span>当前版本</span><b>v${t.version}</b></div>
        <div class="fact"><span>检查次数</span><b>${runs.length}</b></div>
        <div class="fact"><span>下次检查</span><b>${t.archived ? '已归档，不再调度' : dt(t.nextRunAt)}</b></div>
        <div class="fact"><span>最近状态</span><b>${names[t.lastStatus] || t.lastStatus || '—'}</b></div>
      </div>
    </div>
    ${recoveryBlock(t)}
    <div class="detail-section"><b>当前规则</b>
      <p>${esc(ruleText(t.rule))}${knownOps ? `（${esc(knownOps[1])}）` : ''}；每 ${t.rule.intervalMinutes} 分钟检查；冷却 ${t.rule.cooldownMinutes} 分钟。</p>
    </div>
    <div class="detail-section"><b>最近证据</b>
      ${latest ? `<p>${esc(latest.reason)}</p>${latest.decision ? `<p class="meta">结果：${esc(latest.decision)}　建议：${esc(latest.advice || RETRY_ADVICE)}</p>` : ''}<p class="meta">${esc(evidenceText(e, latest.kind))}</p><div class="raw">reason_code=${esc(latest.reasonCode)} · kind=${esc(latest.kind || '')} · checked_at=${esc(latest.checkedAt)} · request_id=${esc(e?.requestId || 'N/A')} · as_of=${esc(e?.asOf || 'N/A')} (${esc(e?.asOfSource || 'N/A')}) · attempts=${esc(e?.attempts ?? 'N/A')}</div>` : '<p>尚无检查记录。</p>'}
    </div>
    <div class="detail-section"><b>版本历史</b>
      ${(t.versions || []).map((v) => `<div class="version-row"><span><b>v${v.version}</b> · ${esc(v.note)}<br><span class="meta">${esc(ruleText(v.rule))}</span></span><span>${dt(v.changedAt)}</span></div>`).join('')}
    </div>`;
  $('#detailModal').classList.remove('hidden');
}

on('.close', 'onclick', () => $('#taskModal').classList.add('hidden'));
on('.detail-close', 'onclick', () => $('#detailModal').classList.add('hidden'));
on('#runFilter', 'onchange', renderRuns);
on('#taskFilter', 'onchange', renderTasks);
on('#runRange', 'onchange', renderRuns);
on('#runStatus', 'onchange', renderRuns);
on('#runKind', 'onchange', renderRuns);

on('#runReset', 'onclick', () => {
  [['#runFilter', ''], ['#runStatus', ''], ['#runKind', ''], ['#runRange', 'all']].forEach(([sel, val]) => {
    const el = $(sel);
    if (el) el.value = val;
  });
  renderRuns();
});

on('#runToggleAll', 'onclick', () => {
  const els = [...document.querySelectorAll('#runs .run')];
  if (!els.length) return;
  const allOpen = els.every((x) => x.open);
  els.forEach((x) => { x.open = !allOpen; });
  const btn = $('#runToggleAll');
  if (btn) btn.textContent = allOpen ? '全部展开' : '全部收起';
});
on('#kind', 'onchange', () => syncKindFields($('#kind').value, ''));
on('#editKind', 'onchange', () => syncKindFields($('#editKind').value, 'edit'));
on('#comboAdd', 'onclick', () => addCondRow(''));
on('#editComboAdd', 'onclick', () => addCondRow('edit'));

function readRule(p) {
  const kind = $(fid(p, 'kind')).value;
  const base = {
    intervalMinutes: Number($(fid(p, 'interval')).value),
    cooldownMinutes: Number($(fid(p, 'cooldown')).value),
  };
  if (kind === 'composite') {
    return { kind: 'composite', logic: $(fid(p, 'comboLogic')).value, conditions: collectConditions(p), ...base };
  }
  const ui = KIND_UI[kind] || KIND_UI.price;
  return {
    kind,
    symbol: ui.symbol ? $(fid(p, 'symbol')).value.trim().toUpperCase() : null,
    operator: $(fid(p, 'operator')).value,
    threshold: ui.th ? (ui.th.type === 'number' ? Number($(fid(p, 'threshold')).value) : $(fid(p, 'threshold')).value.trim()) : null,
    ...base,
  };
}

on('#saveEdit', 'onclick', async () => {
  try {
    await api('/api/tasks/' + editing.id, { method: 'PATCH', body: JSON.stringify({ title: $('#editTitle').value, rule: readRule('edit') }) });
    $('#taskModal').classList.add('hidden');
    await refresh();
  } catch (e) { alert(e.message); }
});

on('#parse', 'onclick', async () => {
  const note = $('#parseNote');
  try {
    const b = await api('/api/parse', { method: 'POST', body: JSON.stringify({ text: $('#intent').value }) });
    if (b.refused) {
      // 预测 / 荐股类请求：产品明确不做这件事，给出对应说明 + 可执行的替代写法。
      // 不生成草案（没有可执行规则），也不把它渲染成"红色报错"——它不是错误，是产品边界。
      $('#draft').classList.add('hidden');
      if (note) {
        note.className = 'refusal';
        note.textContent = b.note;
        if (b.sample) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ghost sample-fill';
          btn.textContent = '填入替代写法';
          btn.onclick = () => { $('#intent').value = b.sample; $('#intent').focus(); };
          note.appendChild(btn);
        }
      }
      return;
    }
    applyRule(b.rule, '');
    $('#draft').classList.remove('hidden');
    if (note) { note.className = ''; note.textContent = b.note; }
  } catch (e) {
    if (note) { note.className = 'error'; note.textContent = e.message; }
  }
});

document.querySelectorAll('.example').forEach((x) => { x.onclick = () => { $('#intent').value = x.dataset.text; }; });

on('#create', 'onclick', async () => {
  try {
    await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: $('#intent').value, rule: readRule('') }) });
    $('#draft').classList.add('hidden');
    $('#intent').value = '';
    await refresh();
  } catch (e) { alert(e.message); }
});

on('#refresh', 'onclick', () => { refresh().catch((e) => surfaceBootError(`刷新失败：${e.message}`)); });

// =====================================================================
// 通知与提醒
//
// 两条通道职责不同，缺一不可：
// - 桌面通知走浏览器，零配置、即时，但要求页面开着；
// - 微信推送走服务端，页面关掉也收得到，是真正"无人值守"的那条。
// =====================================================================

// ---------- ① 浏览器桌面通知 ----------
const DESKTOP_KEY = 'radar.desktopNotify';
let prevRunIds = new Set();
let firstLoad = true;

const desktopSupported = () => typeof Notification !== 'undefined';
function desktopEnabled() {
  try { return localStorage.getItem(DESKTOP_KEY) === 'on'; } catch { return false; }
}
function setDesktopEnabled(on) {
  try { localStorage.setItem(DESKTOP_KEY, on ? 'on' : 'off'); } catch { /* 隐私模式下写入失败，忽略 */ }
}

function renderDesktopState() {
  const btn = $('#desktopToggle');
  const state = $('#desktopState');
  if (!btn || !state) return;
  if (!desktopSupported()) {
    btn.disabled = true;
    btn.textContent = '当前浏览器不支持';
    state.className = 'meta';
    state.textContent = '这个浏览器没有提供桌面通知能力。站内检查记录不受影响，仍会完整保存；如需即时提醒，可配置下面的微信推送。';
    return;
  }
  const on = desktopEnabled() && Notification.permission === 'granted';
  btn.disabled = false;
  state.className = 'meta' + (on ? ' on' : '');
  if (on) {
    btn.textContent = '关闭桌面通知';
    state.textContent = '已开启：条件触发时会弹出系统通知。';
    return;
  }
  btn.textContent = Notification.permission === 'denied' ? '重新授权' : '开启桌面通知';
  state.textContent = Notification.permission === 'denied'
    ? '已被浏览器拒绝。需要在地址栏左侧的站点设置里把「通知」改回允许，再点左侧按钮。'
    : '尚未开启。点击左侧按钮后浏览器会询问一次是否允许。';
}

async function toggleDesktop() {
  if (!desktopSupported()) return;
  if (desktopEnabled() && Notification.permission === 'granted') {
    setDesktopEnabled(false);
    renderDesktopState();
    return;
  }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm === 'granted') {
    setDesktopEnabled(true);
    try {
      new Notification('桌面通知已开启', { body: '条件触发时会在这里提醒你。页面保持打开即可，后台标签页也可以。' });
    } catch { /* 少数浏览器在非 HTTPS 下会抛错，忽略 */ }
  } else {
    setDesktopEnabled(false);
  }
  renderDesktopState();
}

// 只对「本次刷新新出现、且状态为已触发」的记录弹通知。
// 首次加载一律不弹：页面上本来就有历史记录，一进来弹一堆等于噪声。
function announceTriggers(runs) {
  const ids = new Set(runs.map((r) => r.id));
  if (!firstLoad && desktopSupported() && desktopEnabled() && Notification.permission === 'granted') {
    for (const r of runs) {
      if (r.status !== 'triggered' || prevRunIds.has(r.id)) continue;
      try {
        new Notification(`【监控触发】${r.taskTitle || r.symbol || ''}`, {
          body: `${r.reason || '条件已满足'}\n${dt(r.checkedAt)}`,
          tag: r.id,
        });
      } catch { /* 同上，通知失败不能影响页面本身 */ }
    }
  }
  prevRunIds = ids;
  firstLoad = false;
}

// ---------- ② 微信推送渠道配置 ----------
let channelTypes = [];
let savedChannels = [];

const channelMeta = (type) => channelTypes.find((t) => t.type === type) || { label: type, delivery: '', hint: '', placeholder: '' };

function renderChannelList() {
  const box = $('#channelList');
  if (!box) return;
  const empty = $('#channelEmpty');
  if (empty) empty.classList.toggle('hidden', savedChannels.length > 0);
  box.innerHTML = savedChannels.map((c) => {
    const m = channelMeta(c.type);
    return `<div class="channel ${c.enabled ? '' : 'off'}">
      <div class="channel-main">
        <b>${esc(m.label)}</b>
        <span class="meta">${esc(m.delivery || '')} · 凭证 ${c.hasTarget ? esc(c.targetMasked) : '未填写'}</span>
      </div>
      <button class="ghost ch-toggle" type="button" data-id="${esc(c.id)}" data-enabled="${c.enabled}">${c.enabled ? '停用' : '启用'}</button>
      <button class="ghost ch-test" type="button" data-id="${esc(c.id)}">测试</button>
      <button class="ghost ch-del" type="button" data-id="${esc(c.id)}">删除</button>
    </div>`;
  }).join('');
  bindChannelActions();
}

function setTestResult(text, kind) {
  const out = $('#channelTestResult');
  if (!out) return;
  out.className = 'meta' + (kind ? ' ' + kind : '');
  out.textContent = text;
}

// 回传已有渠道时统一带 keepTarget：告诉服务端"这一项没改"，凭证留在服务端不回显
const asPayload = (list) => list.map((c) => ({ id: c.id, type: c.type, enabled: c.enabled, keepTarget: true }));

async function saveChannels(list) {
  const b = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ channels: list }) });
  savedChannels = b.channels || [];
  renderChannelList();
}

function bindChannelActions() {
  document.querySelectorAll('.ch-toggle').forEach((x) => {
    x.onclick = async () => {
      const want = x.dataset.enabled !== 'true';
      try {
        await saveChannels(savedChannels.map((c) => ({ id: c.id, type: c.type, enabled: c.id === x.dataset.id ? want : c.enabled })));
      } catch (e) { setTestResult(e.message, 'bad'); }
    };
  });
  document.querySelectorAll('.ch-del').forEach((x) => {
    x.onclick = async () => {
      try {
        await saveChannels(savedChannels.filter((c) => c.id !== x.dataset.id));
        setTestResult('已删除该渠道。', '');
      } catch (e) { setTestResult(e.message, 'bad'); }
    };
  });
  document.querySelectorAll('.ch-test').forEach((x) => {
    x.onclick = async () => {
      const c = savedChannels.find((y) => y.id === x.dataset.id);
      if (!c) return;
      x.disabled = true;
      setTestResult('正在发送…', '');
      try {
        const b = await api('/api/settings/test', { method: 'POST', body: JSON.stringify({ channel: { id: c.id, type: c.type, keepTarget: true } }) });
        const r = (b.results || [])[0];
        if (r?.ok) setTestResult('测试消息已发出，请查看手机或客户端。', 'ok');
        else setTestResult(`发送失败：${r?.detail || '未知原因'}`, 'bad');
      } catch (e) { setTestResult(e.message, 'bad'); }
      finally { x.disabled = false; }
    };
  });
}

function syncChannelHint() {
  const m = channelMeta($('#channelType')?.value);
  const input = $('#channelTarget');
  const hint = $('#channelHint');
  if (input) input.placeholder = m.placeholder || '';
  if (hint) hint.textContent = m.hint || '';
}

async function addChannel() {
  const type = $('#channelType')?.value;
  const target = $('#channelTarget')?.value.trim() || '';
  if (!type) return;
  if (!target) { setTestResult('请先填写凭证或地址。', 'bad'); return; }
  try {
    await saveChannels([...asPayload(savedChannels), { type, target, enabled: true }]);
    const input = $('#channelTarget');
    if (input) input.value = '';
    setTestResult('已保存。建议点该渠道右侧的「测试」确认能否真的收到。', 'ok');
  } catch (e) { setTestResult(e.message, 'bad'); }
}

async function testAllChannels() {
  const btn = $('#channelTest');
  if (btn) btn.disabled = true;
  setTestResult('正在发送…', '');
  try {
    const b = await api('/api/settings/test', { method: 'POST', body: JSON.stringify({}) });
    const results = b.results || [];
    const bad = results.filter((r) => !r.ok);
    if (bad.length) {
      setTestResult(`成功 ${results.length - bad.length} / ${results.length}；失败：${bad.map((r) => `${channelMeta(r.type).label}（${r.detail}）`).join('；')}`, 'bad');
    } else {
      setTestResult(`${results.length} 个渠道全部发送成功，请查看手机或客户端。`, 'ok');
    }
  } catch (e) { setTestResult(e.message, 'bad'); }
  finally { if (btn) btn.disabled = false; }
}

async function loadSettings() {
  const b = await api('/api/settings');
  channelTypes = b.channelTypes || [];
  savedChannels = b.channels || [];
  const sel = $('#channelType');
  if (sel) sel.innerHTML = channelTypes.map((t) => `<option value="${esc(t.type)}">${esc(t.label)}（${esc(t.delivery || '')}）</option>`).join('');
  syncChannelHint();
  renderChannelList();
}

on('#desktopToggle', 'onclick', () => { toggleDesktop().catch(() => {}); });
on('#channelType', 'onchange', syncChannelHint);
on('#channelAdd', 'onclick', () => { addChannel().catch(() => {}); });
on('#channelTest', 'onclick', () => { testAllChannels().catch(() => {}); });

// 自动轮询：桌面通知靠它才有意义，否则用户不点「刷新状态」就永远收不到。
// 前台 30 秒一次；后台标签页会被浏览器节流到约 1 分钟一次，仍然够用。
// 切回页面时立刻补一次，避免看到过期状态。
const POLL_MS = 30000;
setInterval(() => { refresh().catch(() => {}); }, POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh().catch(() => {}); });

// 启动：失败必须可见，绝不静默停在「正在检查数据服务状态」
async function boot() {
  try {
    syncKindFields('price', '');
    renderDesktopState();
    await refresh();
  } catch (e) {
    surfaceBootError(`页面初始化失败：${e.message}（请刷新页面；若持续出现请反馈）`);
  }
  // 通知配置加载失败不应让整页报错：核心监控功能并不依赖它
  loadSettings().catch((e) => {
    const hint = $('#channelHint');
    if (hint) hint.textContent = `通知设置加载失败：${e.message}`;
  });
}
boot();
