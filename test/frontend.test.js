// 前端加载期回归测试
//
// 背景（2026-09-30 线上真实事故）：
//   web/index.html 里的 <script src="/app.js"> 曾被放在 <div id="detailModal"> 之前。
//   脚本执行时该元素还不存在 → app.js 顶层 `$('.detail-close').onclick = ...`
//   对 null 赋值抛 TypeError → 后续所有绑定与 refresh() 全部中断
//   → 页面永久停在初始文案「正在检查数据服务状态…」。
//   用户看到的表现是「数据一直连不上」，而接口完全是健康的。
//
// 这组用例把「DOM 顺序」「绑定安全」「失败可见」三件事锁死，防止回归。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRule } from '../engine.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
const js = readFileSync(join(root, 'web', 'app.js'), 'utf8');

const scriptIndex = html.indexOf('<script src="/app.js');
const bodyEnd = html.indexOf('</body>');

test('index.html 里 app.js 的 script 标签必须在所有 DOM 之后', () => {
  assert.ok(scriptIndex > 0, 'index.html 必须引用 /app.js');
  const detailModal = html.indexOf('id="detailModal"');
  assert.ok(detailModal > 0, 'index.html 必须有 #detailModal');
  assert.ok(
    scriptIndex > detailModal,
    '脚本出现在 #detailModal 之前，脚本执行时该元素不存在 → 会中断整个前端'
  );
  // 脚本之后除空白、</body></html> 外不应再有其他 DOM
  const tail = html.slice(scriptIndex + '<script src="/app.js"></script>'.length);
  assert.ok(
    !/<\/?(main|section|div|header|article)\b/.test(tail),
    '脚本之后仍有 DOM 结构，应把脚本移到 </body> 之前'
  );
});

test('脚本顶层绑定的选择器，其元素必须在脚本执行前已存在', () => {
  // 只检查绑定期的选择器（on(...)），这些在页面加载时立即求值
  const selectors = [...js.matchAll(/\bon\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(selectors.length > 0, 'app.js 应通过 on() 绑定事件');
  for (const sel of selectors) {
    const before = html.slice(0, scriptIndex);
    const found = sel.startsWith('#')
      ? new RegExp(`id="${sel.slice(1)}"`).test(before)
      : new RegExp(`class="[^"]*\\b${sel.slice(1)}\\b[^"]*"`).test(before);
    assert.ok(found, `绑定期选择器 ${sel} 在脚本之前的 DOM 中不存在`);
  }
});

test('app.js 不得对可能为 null 的元素直接赋值（必须走 on() 空值保护）', () => {
  const unsafe = [...js.matchAll(/^\$\([^)]*\)\.(\w+)\s*=/gm)].map((m) => m[0]);
  assert.deepEqual(unsafe, [], `存在未做空值保护的顶层赋值：${unsafe.join(', ')}`);
});

test('静态资源链接必须带构建版本号，避免 CDN 缓存旧脚本与新页面混用', () => {
  assert.match(html, /\/style\.css\?v=__ASSET_V__/, 'style.css 缺少版本占位符');
  assert.match(html, /\/app\.js\?v=__ASSET_V__/, 'app.js 缺少版本占位符');
});

test('刷新失败必须可见：不得静默停在「正在检查数据服务状态」', () => {
  assert.match(js, /function surfaceBootError/, '缺少启动异常上报函数');
  assert.match(js, /addEventListener\('error'/, '缺少全局脚本错误监听');
  assert.match(js, /addEventListener\('unhandledrejection'/, '缺少未处理 Promise 拒绝监听');
  assert.match(js, /async function boot\(\)/, '缺少 boot 启动包装');
  assert.match(js, /AbortSignal\.timeout\(/, 'fetch 缺少超时，悬挂请求会让页面永久卡住');
});

// 说明板块：整块可折叠 + 三个子块（使用操作指南 / 逻辑规则 / 指标口径说明）
test('使用说明板块可折叠，且包含三个子块', () => {
  assert.match(html, /<details class="guide" open>/, '说明板块必须用 <details> 实现折叠（原生折叠在脚本失败时仍可用）');
  // 只统计「使用说明」这一块，通知板块的 guide-block 不计入
  const guideHtml = html.slice(html.indexOf('<details class="guide" open>'), html.indexOf('id="notifyBlock"'));
  const blocks = [...guideHtml.matchAll(/<details class="guide-block"/g)];
  assert.equal(blocks.length, 3, '说明板块下应有 3 个可折叠子块');
  for (const title of ['使用操作指南', '逻辑规则', '指标口径说明']) {
    assert.ok(guideHtml.includes(`<summary>${title}</summary>`), `缺少子块「${title}」`);
  }
  // 口径说明必须如实标注预留但未生效的 reason_code，避免文档与代码不一致
  assert.ok(html.includes('DATA_STATIC'), '指标口径说明应说明 DATA_STATIC 的现状');
  assert.ok(html.includes('SCHEMA_MISMATCH'), '指标口径说明应说明 SCHEMA_MISMATCH 的现状');
  assert.ok(/预留/.test(html), '未生效的 reason_code 必须标注为「预留」');
});

// 检查记录：筛选控件 + 可折叠记录
test('检查记录的筛选控件齐全，且记录渲染为可折叠结构', () => {
  for (const id of ['runFilter', 'runRange', 'runStatus', 'runKind', 'runReset', 'runToggleAll', 'runCount']) {
    assert.ok(new RegExp(`id="${id}"`).test(html), `检查记录缺少筛选控件 #${id}`);
  }
  assert.match(js, /<details class="run"/, '检查记录必须渲染为可折叠的 <details>');
  assert.match(js, /function filterRuns/, '缺少筛选逻辑函数');
  assert.match(js, /const STATUS_GROUPS/, '缺少「结果」分组定义');
  // 四类条件都要能在「条件类型」里筛到，否则筛选器与规则模型脱节
  for (const k of ['price', 'heat', 'event', 'calendar']) {
    assert.ok(new RegExp(`<option value="${k}">`).test(html), `「条件类型」筛选缺少 ${k}`);
  }
  // 时间区间至少覆盖今天 / 24 小时 / 7 天
  for (const r of ['today', '24h', '7d']) {
    assert.ok(new RegExp(`<option value="${r}">`).test(html), `时间区间缺少 ${r}`);
  }
});

// 筛选不得丢记录：只做过滤，不得改动数据源
test('筛选逻辑只做过滤，不修改原始记录集合', () => {
  const body = js.slice(js.indexOf('function filterRuns'), js.indexOf('function bindRunToggles'));
  assert.ok(/\.filter\(/.test(body), 'filterRuns 应使用 filter 过滤');
  assert.ok(!/\.splice\(|\.sort\(|\.reverse\(|lastData\.runs\s*=/.test(body), '筛选过程不得改动 lastData.runs');
});

// ---------- 通知与提醒 ----------
test('通知板块存在，且两条通道的入口齐全', () => {
  assert.ok(/id="notifyBlock"/.test(html), '缺少「通知与提醒」板块');
  assert.ok(/id="desktopToggle"/.test(html), '缺少桌面通知开关');
  assert.ok(/id="desktopState"/.test(html), '缺少桌面通知状态说明');
  assert.ok(/id="channelType"/.test(html), '缺少推送渠道类型选择');
  assert.ok(/id="channelTarget"/.test(html), '缺少凭证输入框');
  assert.ok(/id="channelAdd"/.test(html), '缺少添加渠道按钮');
  assert.ok(/id="channelTest"/.test(html), '缺少测试推送按钮');
  // 通知板块同样用原生 <details>：脚本挂掉也不会把配置项锁死
  assert.ok(/<details class="guide notify"/.test(html), '通知板块应使用 <details> 实现折叠');
});

test('桌面通知必须走浏览器授权流程，且首次加载不得补弹历史通知', () => {
  assert.match(js, /Notification\.requestPermission\(/, '缺少授权请求，未经允许不得发送通知');
  assert.match(js, /new Notification\(/, '缺少桌面通知发送');
  assert.match(js, /function announceTriggers/, '缺少新触发检测函数');
  assert.match(js, /prevRunIds/, '缺少已见记录集合，无法区分「新触发」与「历史记录」');
  assert.match(js, /firstLoad/, '缺少首次加载标记：一进页面就弹历史通知等于噪声');
  assert.match(js, /r\.status !== 'triggered'/, '只有「已触发」才应弹通知');
});

test('页面必须自动轮询，否则桌面通知永远等不到新触发', () => {
  assert.match(js, /const POLL_MS = \d+/, '缺少轮询间隔常量');
  assert.match(js, /setInterval\(\(\) => \{ refresh\(\)/, '缺少定时刷新');
  assert.match(js, /addEventListener\('visibilitychange'/, '切回页面应立刻补一次刷新');
});

test('前端只使用脱敏后的凭证，绝不回显接口里的原始凭证', () => {
  assert.match(js, /targetMasked/, '前端应展示脱敏后的凭证形态');
  assert.ok(!/\bc\.target\b/.test(js), '前端不得读取接口的明文 target 字段');
  assert.match(js, /keepTarget/, '编辑已有渠道时应显式声明「凭证未改动」，避免覆盖为空');
});

test('自动轮询不得打断用户操作：数据未变化时不重建列表', () => {
  assert.match(js, /lastFingerprint/, '缺少数据指纹，轮询会反复重建 DOM');
  assert.match(js, /if \(fingerprint === lastFingerprint\) return;/, '指纹相同时应直接返回，跳过重渲染');
});

// ---------- 本批新增：预测/荐股拒绝、组合条件、数据受限 ----------

test('预测与荐股类请求：必须给出产品边界说明与替代写法，不得当成解析报错', () => {
  assert.match(js, /if \(b\.refused\)/, '未处理结构化拒绝响应');
  assert.match(js, /note\.className = 'refusal'/, '拒绝文案应使用独立样式，而不是解析错误色');
  assert.match(js, /填入替代写法/, '应提供一键填入替代写法的入口');
  assert.match(js, /b\.sample/, '拒绝响应应带可执行的替代示例');
});

test('组合条件：草稿与编辑弹窗都要有结构化子条件编辑器', () => {
  for (const p of ['', 'edit']) {
    // 编辑弹窗 id 前缀为 edit + 首字母大写（editComboList），草稿区无前缀（comboList）
    const id = (base) => (p ? 'edit' + base[0].toUpperCase() + base.slice(1) : base);
    assert.ok(html.includes(`id="${id('compositeEditor')}"`), `缺少 ${p || '草稿'}组合编辑器`);
    assert.ok(html.includes(`id="${id('comboList')}"`), `缺少 ${p || '草稿'}子条件列表`);
    assert.ok(html.includes(`id="${id('comboLogic')}"`), `缺少 ${p || '草稿'}组合逻辑选择`);
  }
  assert.match(js, /function renderCombo/, '缺少组合结构渲染');
  assert.match(js, /function collectConditions/, '缺少子条件回读（可编辑）');
  assert.match(js, /function condRowHtml/, '缺少子条件行模板');
  assert.match(js, /function addCondRow/, '缺少添加子条件');
  assert.match(js, /kind === 'composite'/, '规则读写未处理组合类型');
});

test('组合条件的证据必须逐子条件展开，而不是压成一行', () => {
  assert.match(js, /function compositeBlock/, '缺少组合证据渲染');
  assert.match(js, /composite-list/, '缺少子条件列表容器');
  assert.match(js, /partStatusLabel/, '缺少子条件状态文案');
  assert.match(js, /组合逻辑/, '缺少组合逻辑行');
  assert.match(js, /组合结果/, '缺少组合结果行');
});

test('数据受限与数据冲突都是独立状态，并入「降级」筛选组，且热度证据展示数据时点', () => {
  assert.match(js, /restricted: '数据受限'/, '缺少数据受限状态名');
  assert.match(js, /conflict: '数据存在冲突'/, '缺少数据冲突状态名');
  assert.match(js, /degraded: \(r\) => \[[^\]]*'degraded'[^\]]*'restricted'[^\]]*'conflict'/, '数据受限 / 数据冲突未并入筛选组');
  assert.match(js, /dataTimeStatus/, '热度证据未展示数据时点口径');
  assert.match(js, /榜单业务时间：数据源未提供/, '热度证据未写明业务时间缺失');
});

test('界面口径说明必须与实现一致（热度三态 / 组合条件已支持）', () => {
  assert.match(html, /DATA_RESTRICTED/, '口径说明应包含数据受限编码');
  assert.match(html, /组合条件（AND \/ OR）/, '应说明组合条件已支持 AND / OR');
  assert.ok(!/当前版本只支持单一条件/.test(html), '旧的「只支持单一条件」口径必须移除');
  assert.match(html, /<option value="composite">/, '草案与筛选应能表达组合类型');
});

// 回归：编辑弹窗 id 为 editKind / editComboList（edit + 首字母大写），草稿区为 kind / comboList。
// 曾用全小写拼接导致编辑弹窗所有字段取不到元素，编辑功能整体失效（2026-09-30 真实缺陷）。
test('表单字段 id 必须统一由 fid() 拼接，禁止手写前缀拼接', () => {
  assert.match(js, /const fid = \(p, base\) =>/, '缺少统一 id 拼接函数 fid');
  assert.ok(!/'#' \+ p \+ '[a-z]/.test(js), '仍存在把全小写字段名直接拼在 p 后面的写法，编辑弹窗会取不到元素');
  assert.match(js, /fid\(p, 'compositeEditor'\)/, '组合编辑器未走统一拼接');
  assert.match(js, /fid\(p, 'comboList'\)/, '子条件列表未走统一拼接');
  assert.match(js, /fid\(p, 'kind'\)/, '条件类型未走统一拼接');
  assert.match(js, /fid\(p, 'interval'\)/, '检查间隔未走统一拼接');
});

// =====================================================================
// 第二批：数据冲突 / 运行状态（恢复叙事）/ 任务归档
// =====================================================================

test('数据冲突按「结果 / 原因 / 建议」三行展开，不能只留一句含糊的结论', () => {
  assert.match(js, /function noDecisionBlock/, '缺少"无结论状态"的统一渲染入口');
  assert.match(js, /本次未执行条件判断/, '缺少「结果：本次未执行条件判断」文案');
  assert.match(js, /等待下一次检查或手动重试/, '缺少「建议」文案');
  assert.match(
    js,
    /const NO_DECISION = \['degraded', 'error', 'restricted', 'conflict'\]/,
    '冲突必须和降级 / 受限同属"无结论"，否则会被渲染成"没触发"'
  );
  assert.match(js, /snapshotAsOf/, '冲突证据应展示快照的业务时点');
  assert.match(js, /historicalClose/, '冲突证据应展示日线收盘价');
  assert.match(js, /<b>结果<\/b>/, '缺「结果」行');
  assert.match(js, /<b>原因<\/b>/, '缺「原因」行');
  assert.match(js, /<b>建议<\/b>/, '缺「建议」行');
});

test('界面口径与图例都要能表达「数据存在冲突」', () => {
  assert.match(html, /conflict: '数据存在冲突'|数据存在冲突/, '界面文案缺少数据冲突');
  assert.match(html, /DATA_CONFLICT/, '口径说明应含冲突的 reason_code');
  assert.match(html, /实时快照与日线数据所属时点不同/, '口径说明应写清冲突判据');
  assert.match(html, /dot red/, '图例缺少冲突状态的颜色标识');
  assert.match(
    html,
    /不能.*未触发|不.*折算|绝不折算/,
    '口径说明应写明冲突不会被折算成未触发'
  );
});

test('任务详情页必须有「运行状态」块，含用户点名的四个字段', () => {
  for (const label of ['运行状态', '最近成功检查', '最近异常', '恢复时间', '恢复处理']) {
    assert.ok(js.includes(label), `任务详情页缺少「${label}」`);
  }
  assert.match(js, /function recoveryBlock/, '缺少运行状态渲染函数');
  assert.match(js, /rec\.history/, '恢复历史应可追溯');
  assert.match(js, /recoveryCount/, '应展示累计恢复次数');
  assert.match(js, /function openDetail[\s\S]{0,1200}recoveryBlock\(t\)/, '运行状态块未接入任务详情');
});

test('归档：只收纳不删除，入口 / 筛选 / 恢复启用三处都要齐', () => {
  assert.match(js, /archived: true/, '缺少归档请求');
  assert.match(js, /archived: false/, '缺少恢复启用请求');
  assert.match(js, /\.archive'\)/, '缺少归档按钮绑定');
  assert.match(js, /\.unarchive'\)/, '缺少恢复启用按钮绑定');
  assert.match(js, /function filterTasks/, '缺少任务状态筛选');
  assert.match(js, /archived: '已归档'|已归档/, '缺少归档状态文案');
  assert.match(html, /id="taskFilter"/, '缺少任务状态筛选控件');
  assert.match(html, /<option value="archived">已归档<\/option>/, '筛选里缺少「已归档」');
  // 审计型产品：不做永久删除
  assert.ok(!/method: 'DELETE'/.test(js), '前端不应出现删除任务的调用');
  assert.ok(!/删除任务|永久删除任务/.test(html), '界面不应提供永久删除入口');
  assert.match(html, /不提供永久删除/, '界面应明确说明不做永久删除');
});

test('界面口径说明补充归档一节', () => {
  assert.match(html, /任务归档/, '逻辑规则板块应说明归档语义');
  assert.match(html, /不再调度/, '应说明归档后不再调度');
  assert.match(html, /历史.*保留|保留.*历史/, '应说明归档保留历史与版本');
});

// ---------- 说明板块文案（2026-09-30 修订）----------
// 说明板块是评审的阅读对象，改错一处就没法自证。这组用例锁三件事：
//   ① 口径说明按 Q1–Q4 组织，Q2 把「每条记录能看到什么」列全；
//   ② 状态口径必须列全所有终态——尤其不能漏掉「数据受限 / 数据存在冲突」，
//      否则会出现「状态机比图例少两个状态」的自相矛盾；
//   ③ **页面上写的示例句必须真的能被解析**：文档里的例子如果照抄就跑不通，
//      评审敲一次就当场失败。所以这里把示例句直接喂给解析器。
test('口径说明按 Q1–Q4 组织，且列出可回溯字段', () => {
  for (const q of ['Q1：数据从哪来？', 'Q2：每条记录你能看到什么？', 'Q3：不同条件的数据时点怎么取？', 'Q4：数据出问题怎么办？']) {
    assert.ok(html.includes(q), `指标口径说明缺少「${q}」`);
  }
  for (const field of ['source', 'unit', 'as_of', 'as_of_source', 'request_id', 'sessionLabel']) {
    assert.ok(html.includes(`<code>${field}</code>`), `可回溯字段清单缺少 ${field}`);
  }
  // 口径要指向真实存在的字段：代码里没有 caliber 这个键，写上去评审查不到
  assert.ok(!html.includes('caliber'), '不得把不存在的字段 caliber 写成可追溯字段');
});

test('状态口径列全所有终态，不得漏掉数据受限与数据存在冲突', () => {
  const start = html.indexOf('<b>状态口径</b>');
  assert.ok(start > 0, '逻辑规则板块应使用「状态口径」这一说法');
  const seg = html.slice(start, html.indexOf('</p>', start));
  for (const s of ['待检查', '已触发', '未触发', '冷却中', '已去重', '已降级', '检查失败', '数据受限', '数据存在冲突', '未执行']) {
    assert.ok(seg.includes(s), `状态口径缺少「${s}」`);
  }
});

test('使用操作指南里的示例句必须真的能解析出来', async () => {
  const m = html.match(/例如「([^」]+)」/);
  assert.ok(m, '使用操作指南应给出一句可以照抄的示例');
  const resolveOne = async () => ({ ok: true, candidates: [{ symbol: '600519.SH', name: '贵州茅台' }] });
  const rule = await parseRule(m[1], resolveOne);
  assert.equal(rule.kind, 'price', `示例句「${m[1]}」应解析为价格条件`);
  assert.equal(rule.symbol, '600519.SH', `示例句「${m[1]}」标的应识别为 600519.SH`);
  assert.equal(rule.operator, 'below', `示例句「${m[1]}」方向应为 below`);
  assert.equal(rule.threshold, 1400, `示例句「${m[1]}」阈值应为 1400`);
});

// 起因：有人看到「组合条件」按钮，认为它点下去只会解析失败，据此建议把按钮置灰。
// 实际组合条件是已实现能力，页面说明书里也从没写过"只支持单一条件"。
// 与其争论，不如让每个示例按钮自己证明——点不动就红。
test('页面上每个示例按钮的句子都必须真的能解析', async () => {
  const btns = [...html.matchAll(/<button class="example" data-text="([^"]+)">([^<]+)<\/button>/g)];
  assert.ok(btns.length >= 6, `示例按钮不应少于 6 个，实际 ${btns.length}`);
  const resolveOne = async () => ({ ok: true, candidates: [{ symbol: '600519.SH', name: '贵州茅台' }] });
  const expectedKind = { 组合条件: 'composite' };
  for (const [, text, label] of btns) {
    let rule;
    try {
      rule = await parseRule(text, resolveOne);
    } catch (e) {
      assert.fail(`示例按钮「${label}」的句子「${text}」解析失败：${e.message}`);
    }
    assert.ok(rule.kind, `示例按钮「${label}」未解析出条件类型`);
    if (expectedKind[label]) {
      assert.equal(rule.kind, expectedKind[label], `「${label}」应解析为 ${expectedKind[label]}，实际 ${rule.kind}`);
    }
  }
});

test('组合条件示例必须真的带出多个子条件', async () => {
  const m = html.match(/data-text="([^"]*并且[^"]*)"/);
  assert.ok(m, '页面应给出一个「并且」组合条件的示例');
  const resolveOne = async () => ({ ok: true, candidates: [{ symbol: '600519.SH', name: '贵州茅台' }] });
  const rule = await parseRule(m[1], resolveOne);
  assert.equal(rule.kind, 'composite', `「${m[1]}」应解析为组合条件`);
  assert.equal(rule.logic, 'AND');
  assert.equal(rule.conditions?.length, 2, '组合条件应含两个子条件');
});

test('通知板块说明站内记录始终保存，未配渠道不等于模块坏了', () => {
  assert.match(html, /站内检查记录始终保存/, '通知板块应说明站内记录是默认可靠渠道');
  assert.match(html, /可选增强/, '外部渠道应被说明为可选增强，而非必需项');
});
