// 端到端验收：产品边界拒绝话术、热度数据时点三态、AND/OR 组合条件、
// 数据冲突（多源业务时点不一致）、任务详情运行状态（恢复叙事）、任务归档。
//
// 为什么单独一个脚本：这些都是「接口返回 200 却仍然可能出错」的类型——
//   · 拒绝话术错了，用户会以为「只差几个数字没填完」；
//   · 热度时点不可确认却输出「未触发」，等于用含糊的话给一个结论；
//   · 组合条件的子条件没逐条展示，等于把三个条件压成一句结论；
//   · 数据冲突只写一句「数据冲突」而不说清是哪两份数据在打架，等于没解释；
//   · 恢复逻辑写对了但页面看不到，等于评审看不见；
//   · 归档做了但按钮和筛选没跟上，等于没有归档。
// 这些只有真的把页面打开、真的点一遍才验得到。
//
// 用法（需要本机可用的 Chromium 内核浏览器）：
//   node tools/e2e-guardrails.mjs --url http://127.0.0.1:3000/
//   node tools/e2e-guardrails.mjs --url https://invest-radar.app.workbuddy.host/ --shots ./shots
//
// 依赖 playwright（可选依赖，不参与 npm test 默认用例，避免 CI 需要浏览器）。
// 说明 1：组合任务的检查会真实调用数据源；若数据源不可用，脚本会自动走「降级不强行判定」的断言分支。
// 说明 2：数据冲突与运行状态两段用"构造数据 + 真实渲染"验证——冲突属于罕见的数据异常，
//         不可能随时随地真实复现，因此把构造好的记录喂给渲染层；归档段则走真实接口，
//         并核对 nextRunAt 与检查记录条数，确认"不再调度"和"不删除历史"两条契约。

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const url = argOf('--url', 'http://127.0.0.1:3000/');
const shotDir = argOf('--shots', null);

const candidates = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = candidates.find((p) => existsSync(p));
if (!executablePath) {
  console.error('未找到可用的 Chromium 内核浏览器，请用 BROWSER_PATH 指定。');
  process.exit(2);
}

let chromium;
try {
  const mod = require(process.env.PLAYWRIGHT_PATH || 'playwright');
  chromium = mod.chromium ?? mod.default?.chromium;
} catch { /* 继续尝试 ESM 解析 */ }
if (!chromium) {
  for (const spec of ['playwright', 'playwright-core']) {
    try {
      const mod = await import(spec);
      chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) break;
    } catch { /* 继续尝试下一个 */ }
  }
}
if (!chromium) {
  console.error('未安装 playwright / playwright-core，跳过端到端检查。');
  process.exit(2);
}

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + String(detail).slice(0, 160) : ''}`);
};
const squash = (s) => String(s).replace(/\s+/g, ' ');

// 构造一条「多源业务时点不一致」的记录并喂给渲染层。
// 真实的数据冲突属于罕见数据异常，不可能随时随地复现，因此构造数据、真实渲染——
// 验的是"页面对这种记录的表达是否完整"，而不是"数据源今天会不会出错"。
async function injectConflictDemo(page) {
  await page.evaluate(() => {
    const conflictRun = {
      id: 'demo-conflict-run',
      taskId: 'demo-conflict-task',
      taskTitle: '【演示】600519.SH 跌破 1400',
      version: 1,
      kind: 'price',
      mode: 'manual',
      checkedAt: new Date().toISOString(),
      durationMs: 812,
      status: 'conflict',
      reasonCode: 'DATA_CONFLICT',
      reason: '实时快照与日线数据所属时点不同（快照业务时点 2026-09-29 14:55，日线最新收盘 2026-09-30）',
      decision: '本次未执行条件判断',
      advice: '等待下一次检查或手动重试',
      evidence: {
        source: 'fuyao',
        dataset: 'prices/snapshot + prices/historical',
        snapshotPrice: 1398,
        historicalClose: 1412,
        snapshotAsOf: '2026-09-29 14:55',
        snapshotAsOfSource: 'api_timestamp',
        klineDate: '20260930',
        conflictCode: 'snapshot_older_than_kline',
        asOf: null,
        asOfSource: 'conflict',
      },
    };
    lastData.runs = [conflictRun, ...lastData.runs.filter((r) => r.id !== conflictRun.id)];
    renderRuns();
  });
}

// 构造一份恢复叙事并挂到第一条任务上（恢复分类逻辑本身由 test/recovery.test.js 单测覆盖，
// 这里验的是"评审在详情页能不能看见"）
async function injectRecoveryDemo(page) {
  return page.evaluate(() => {
    const t = lastData.tasks[0];
    t.recovery = {
      lastSuccessAt: '2026-09-30T02:20:00.000Z',
      lastErrorAt: '2026-09-30T02:10:00.000Z',
      lastErrorStatus: 'error',
      lastErrorReason: '数据源超时',
      recoveredAt: '2026-09-30T02:20:00.000Z',
      recoveryKind: 'after_error',
      recoveryLabel: '接口故障恢复',
      recoveryAction: '重新检查，未产生重复提醒',
      recoveryFrom: { status: 'error', reason: '数据源超时', checkedAt: '2026-09-30T02:10:00.000Z' },
      recoveryCount: 1,
      history: [{ at: '2026-09-30T02:20:00.000Z', label: '接口故障恢复', action: '重新检查，未产生重复提醒', to: { status: 'not_triggered' } }],
    };
    renderTasks();
    return t.title;
  });
}

const browser = await chromium.launch({ executablePath, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
// 409「任务正在检查中」是前端显式处理的正常响应（app.js 有对应分支），不计为脚本错误
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !/409|Conflict/.test(t)) errors.push('console: ' + t);
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('#tasks .task, #tasks p', { timeout: 30000 });
await page.waitForTimeout(1500);

// ---------- ① 预测 / 荐股 / 投资建议：拒绝文案必须准确，且不得落地为「请输入阈值」 ----------
console.log('\n== 意图拒绝 ==');
const refusals = [
  ['帮我预测茅台明天涨跌', '不预测未来涨跌'],
  ['建议我买入贵州茅台', '不提供买卖和仓位建议'],
  ['帮我满仓', '不提供买卖和仓位建议'],
  ['茅台值得投资吗', '不预测股票涨跌，也不提供买卖、仓位或收益建议'],
];
for (const [text, expect] of refusals) {
  await page.fill('#intent', text);
  await page.click('#parse');
  await page.waitForTimeout(900);
  const note = (await page.locator('#parseNote').innerText()).trim();
  check(`「${text}」拒绝文案正确`, note.includes(expect), note.slice(0, 70));
  check(`「${text}」不出现「请输入阈值」`, !/请输入.{0,3}阈值/.test(note));
  check(`「${text}」不展示不可执行的草案`, await page.locator('#draft').isHidden());
  check(`「${text}」提供替代写法入口`, (await page.locator('#parseNote .sample-fill').count()) === 1);
}
await page.click('#parseNote .sample-fill');
const filled = await page.locator('#intent').inputValue();
check('替代写法可一键填入', filled.length > 0, filled);

// 合法监控诉求不得被误拒
await page.fill('#intent', '贵州茅台会不会跌破1400');
await page.click('#parse');
await page.waitForTimeout(1200);
check('合法监控诉求不被误拒（「会不会跌破」应生成草案）', await page.locator('#draft').isVisible());

// ---------- ② 组合条件：解析 → 可编辑 → 创建 ----------
console.log('\n== 组合条件 ==');
// 先把草案收起来：上一段「会不会跌破」已经生成过草案，若不复位，
// waitForSelector('#draft:not(.hidden)') 会立即返回，读到还没更新完的表单。
await page.evaluate(() => document.querySelector('#draft')?.classList.add('hidden'));
await page.fill('#intent', '600519.SH 跌破1400并且进入热榜前10');
await page.click('#parse');
await page.waitForSelector('#draft:not(.hidden)', { timeout: 15000 });
await page.waitForTimeout(400);
check('组合规则草案已生成', true);
check('条件类型为组合', (await page.locator('#kind').inputValue()) === 'composite');
check('组合逻辑为 AND', (await page.locator('#comboLogic').inputValue()) === 'AND');
check('展示 2 个子条件', (await page.locator('#comboList .cond').count()) === 2);
const c1sym = await page.locator('#comboList .cond').nth(0).locator('.c-symbol').inputValue();
const c2sym = await page.locator('#comboList .cond').nth(1).locator('.c-symbol').inputValue();
check('子条件标的正确（第二个继承第一个）', c1sym === '600519.SH' && c2sym === '600519.SH', `${c1sym} / ${c2sym}`);
check('顶层不再显示单一标的字段', await page.locator('#symbolField').isHidden());

await page.locator('#comboList .cond').nth(1).locator('.c-th').fill('5');
await page.click('#comboAdd');
check('可添加子条件', (await page.locator('#comboList .cond').count()) === 3);
await page.locator('#comboList .cond').nth(2).locator('.c-del').click();
check('可删除子条件', (await page.locator('#comboList .cond').count()) === 2);
check('子条件编辑被保留', (await page.locator('#comboList .cond').nth(1).locator('.c-th').inputValue()) === '5');

await page.click('#create');
await page.waitForTimeout(2000);
const taskText = squash(await page.locator('#tasks .task').first().innerText());
check('任务创建成功且显示组合结构', /并且/.test(taskText) && /前 5 名/.test(taskText), taskText.slice(0, 110));

// ---------- ③ 组合任务检查：逐子条件独立证据 ----------
console.log('\n== 组合检查记录 ==');
await page.click('#tasks .task .check');
await page.waitForTimeout(9000);
const firstRun = page.locator('#runs .run').first();
check('生成检查记录', (await page.locator('#runs .run').count()) >= 1);
await firstRun.locator('summary').click();
await page.waitForTimeout(700);
const runBody = squash(await firstRun.innerText());
check('记录含「组合逻辑」行', /组合逻辑/.test(runBody));
check('记录含「子条件」行', /子条件/.test(runBody));
check('记录含「组合结果」行', /组合结果/.test(runBody));
check('每个子条件单独一行', (await firstRun.locator('.composite-row').count()) === 2);
const rowTexts = await firstRun.locator('.composite-row').allInnerTexts();
check(
  '子条件各自带独立状态与原因',
  rowTexts.every((t) => /满足|未满足|数据不可用|数据受限/.test(t)),
  rowTexts.map((t) => squash(t).slice(0, 46)).join(' || ')
);
// 只有出现「数据不可用 / 数据受限」子条件时，才必须不强行判定；否则必须给出正常合并结论
if (rowTexts.some((t) => /数据不可用|数据受限/.test(t))) {
  check('存在不可用子条件 → 整体不强行判定', /不强行判定/.test(runBody), runBody.slice(0, 120));
} else {
  check('子条件均有结论 → 正常合并出触发/未触发', /未触发|已触发/.test(runBody), runBody.slice(0, 120));
  check('有结论时不得出现「不强行判定」', !/不强行判定/.test(runBody));
}

// ---------- ④ 状态与筛选 ----------
console.log('\n== 状态与筛选 ==');
const statusOpts = await page.evaluate(() => [...document.querySelectorAll('#runStatus option')].map((o) => o.textContent.trim()));
check('结果筛选包含数据受限', statusOpts.some((t) => /数据受限/.test(t)), statusOpts.join(' / '));
const kindOpts = await page.evaluate(() => [...document.querySelectorAll('#runKind option')].map((o) => o.textContent.trim()));
check('条件类型筛选包含组合', kindOpts.includes('组合'), kindOpts.join(' / '));
await page.selectOption('#runKind', 'composite');
await page.waitForTimeout(600);
check('按组合筛选能取到记录', (await page.locator('#runs .run').count()) >= 1);
await page.click('#runReset');
await page.waitForTimeout(400);

// ---------- ⑤ 编辑弹窗：组合结构同样可读、可改、可保存 ----------
// 这段是回归守卫：编辑弹窗的字段前缀与草稿区不同，曾因大小写不一致导致整块编辑功能失效。
console.log('\n== 编辑弹窗组合结构 ==');
await page.locator('#tasks .task', { hasText: '并且' }).first().locator('.edit').click();
await page.waitForTimeout(700);
check('编辑弹窗打开且类型为组合', (await page.locator('#editKind').inputValue()) === 'composite', await page.locator('#editKind').inputValue());
check('编辑弹窗隐藏单一标的字段', await page.locator('#editSymbolField').isHidden());
check('编辑弹窗组合编辑器可见', await page.locator('#editCompositeEditor').isVisible());
check('编辑弹窗展示 2 个子条件', (await page.locator('#editComboList .cond').count()) === 2);
check('编辑弹窗回读检查间隔（不是空值）', (await page.locator('#editInterval').inputValue()) !== '');
const editedTitle = await page.locator('#editTitle').inputValue();
if (await page.locator('#editCompositeEditor').isVisible()) {
  await page.selectOption('#editComboLogic', 'OR');
  await page.click('#saveEdit');
  await page.waitForTimeout(2500);
  const editedCard = squash(await page.locator('#tasks .task', { hasText: editedTitle }).first().innerText());
  check('保存后任务卡显示「或者（任一满足）」', /或者/.test(editedCard), editedCard.slice(0, 120));
}

// ---------- ⑥ 数据冲突：四行结论必须完整，且绝不出现「触发 / 未触发」 ----------
console.log('\n== 数据冲突（多源业务时点不一致）==');
await injectConflictDemo(page);
await page.waitForTimeout(500);
const cRun = page.locator('#runs .run[data-run="demo-conflict-run"]');
check('冲突记录可渲染', (await cRun.count()) === 1);
await cRun.locator('summary').click();
await page.waitForTimeout(400);
const cBody = squash(await cRun.innerText());
check('状态显示为「数据存在冲突」', /数据存在冲突/.test(cBody), cBody.slice(0, 120));
check('结果行写明「本次未执行条件判断」', /结果 本次未执行条件判断/.test(cBody), cBody.slice(0, 160));
check('原因行写明「实时快照与日线数据所属时点不同」', /原因 实时快照与日线数据所属时点不同/.test(cBody));
check('建议行写明「等待下一次检查或手动重试」', /建议 等待下一次检查或手动重试/.test(cBody));
check('冲突记录绝不出现「未触发 / 已触发」结论', !/未触发|已触发/.test(cBody), cBody.slice(0, 160));
check('冲突证据并排展示两份数据的价格', /1398/.test(cBody) && /1412/.test(cBody));
check('证据写明两份数据的业务时点', /2026-09-29 14:55/.test(cBody) && /2026-09-30/.test(cBody));
check('原始字段含 decision 与 kline_date', /decision=本次未执行条件判断/.test(cBody) && /kline_date=20260930/.test(cBody));

// ---------- ⑦ 任务详情：运行状态块（恢复叙事） ----------
// 恢复逻辑的正确性由 test/recovery.test.js 单测锁死；这一段验的是"评审能不能看见"。
console.log('\n== 任务详情：运行状态 ==');
const detailRecovery = await injectRecoveryDemo(page);
await page.waitForTimeout(300);
await page.locator('#tasks .task', { hasText: detailRecovery }).first().locator('.detail').click();
await page.waitForTimeout(600);
const detailBody = squash(await page.locator('#detailContent').innerText());
check('详情页含「运行状态」块', /运行状态/.test(detailBody));
check('含「最近成功检查」', /最近成功检查/.test(detailBody));
check('含「最近异常」且带原因', /最近异常/.test(detailBody) && /数据源超时/.test(detailBody), detailBody.slice(0, 200));
check('含「恢复时间」', /恢复时间/.test(detailBody));
check('含「恢复处理」且写明未重复提醒', /恢复处理/.test(detailBody) && /未产生重复提醒/.test(detailBody));
check('恢复历史可追溯（含恢复类型）', /接口故障恢复/.test(detailBody));
check('说明恢复不等于重新提醒', /恢复不等于重新提醒/.test(detailBody));
await page.locator('#detailModal .detail-close').click();
await page.waitForTimeout(300);

// ---------- ⑧ 归档：只收纳不删除，且真的不再调度 ----------
console.log('\n== 任务归档 ==');
const apiBase = new URL(url).origin;
const taskFilterOpts = await page.evaluate(() => [...document.querySelectorAll('#taskFilter option')].map((o) => o.textContent.trim()));
check('任务状态筛选含「已归档」', taskFilterOpts.some((t) => /已归档/.test(t)), taskFilterOpts.join(' / '));
// 归档有二次确认，脚本自动接受
page.on('dialog', (d) => d.accept());

// 先给目标任务一个唯一标题再操作：本地反复调试容易留下同名历史任务，
// 靠标题模糊匹配会把别的任务一起数进来，让"筛选是否真的生效"这类断言误判。
const beforeState = await (await fetch(apiBase + '/api/tasks')).json();
const beforeTask = beforeState.tasks.find((t) => !t.archived);
const marker = `归档验收-${Date.now()}`;
await fetch(`${apiBase}/api/tasks/${beforeTask.id}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: marker }),
});
await page.evaluate(() => refresh());
await page.waitForTimeout(1500);
const targetCard = page.locator('#tasks .task', { hasText: marker });
const beforeRunCount = beforeState.runs.filter((r) => r.taskId === beforeTask.id).length;

await targetCard.first().locator('.archive').click();
await page.waitForTimeout(2500);
const archivedCard = squash(await targetCard.first().innerText());
check('归档后任务卡显示「已归档」', /已归档/.test(archivedCard), archivedCard.slice(0, 140));
check('归档后不再显示「立即检查」', (await targetCard.first().locator('.check').count()) === 0);
check('归档后提供「恢复启用」', (await targetCard.first().locator('.unarchive').count()) === 1);
check('归档后界面提示不再调度', /不再调度/.test(archivedCard), archivedCard.slice(0, 140));

const afterState = await (await fetch(apiBase + '/api/tasks')).json();
const afterTask = afterState.tasks.find((t) => t.id === beforeTask.id);
check('接口层：归档后 nextRunAt 为空（不再排期）', afterTask?.nextRunAt === null, String(afterTask?.nextRunAt));
check('接口层：归档状态已落库', afterTask?.archived === true);
check('接口层：版本历史完整保留', Array.isArray(afterTask?.versions) && afterTask.versions.length >= 1, `versions=${afterTask?.versions?.length}`);
check('接口层：恢复记录结构保留', !!afterTask?.recovery && Array.isArray(afterTask.recovery.history), JSON.stringify(afterTask?.recovery || {}).slice(0, 60));
const afterRunCount = afterState.runs.filter((r) => r.taskId === beforeTask.id).length;
check('接口层：历史检查记录未被删除', afterRunCount >= beforeRunCount, `${beforeRunCount} → ${afterRunCount}`);
const checkResp = await fetch(`${apiBase}/api/tasks/${beforeTask.id}/check`, { method: 'POST' });
check('接口层：归档任务拒绝执行检查（409）', checkResp.status === 409, `HTTP ${checkResp.status}`);

await page.selectOption('#taskFilter', 'archived');
await page.waitForTimeout(600);
check('按「已归档」筛选能看到该任务', (await targetCard.count()) >= 1);
await page.selectOption('#taskFilter', 'active');
await page.waitForTimeout(600);
check('按「运行中」筛选看不到已归档任务', (await targetCard.count()) === 0);
await page.selectOption('#taskFilter', 'all');
await page.waitForTimeout(600);

await targetCard.first().locator('.unarchive').click();
await page.waitForTimeout(2500);
const restoredCard = squash(await targetCard.first().innerText());
check('恢复启用后回到运行中', /运行中/.test(restoredCard) && !/已归档/.test(restoredCard), restoredCard.slice(0, 140));
const restoredState = await (await fetch(apiBase + '/api/tasks')).json();
const restoredTask = restoredState.tasks.find((t) => t.id === beforeTask.id);
check('接口层：恢复启用后重新排期', typeof restoredTask?.nextRunAt === 'string', String(restoredTask?.nextRunAt));
check('接口层：恢复启用后待恢复原因被标记', restoredTask?.recovery?.pendingCause === 'after_archive', String(restoredTask?.recovery?.pendingCause));
check('界面不提供永久删除入口', !/删除任务|永久删除任务/.test(await page.locator('#tasks').innerText()));

check('页面无脚本错误（含 409 之外的 console error）', errors.length === 0, errors.slice(0, 2).join(' | '));

if (shotDir) {
  await page.fill('#intent', '帮我预测茅台明天涨跌');
  await page.click('#parse');
  await page.waitForTimeout(800);
  await page.locator('.hero').screenshot({ path: shotDir + '/e2e_意图拒绝.png' });
  await page.fill('#intent', '600519.SH 跌破1400并且进入热榜前10');
  await page.click('#parse');
  await page.waitForTimeout(1200);
  await page.locator('#draft').screenshot({ path: shotDir + '/e2e_组合草案.png' });
  await page.locator('#runs .run').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shotDir + '/e2e_组合证据.png' });

  // 第二批截图：数据冲突记录 / 运行状态块 / 归档筛选
  // 归档段触发过一次刷新，之前注入的构造数据已被服务端真实数据覆盖，这里重新注入后再截图
  await injectConflictDemo(page);
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const el = document.querySelector('#runs .run[data-run="demo-conflict-run"]');
    if (el) el.open = true;
  });
  await page.waitForTimeout(400);
  const conflictShot = page.locator('#runs .run[data-run="demo-conflict-run"]');
  await conflictShot.scrollIntoViewIfNeeded();
  await conflictShot.screenshot({ path: shotDir + '/e2e_数据冲突.png' });

  const shotTitle = await injectRecoveryDemo(page);
  await page.waitForTimeout(400);
  await page.locator('#tasks .task', { hasText: shotTitle }).first().locator('.detail').click();
  await page.waitForTimeout(700);
  await page.locator('#detailModal .modal-box').screenshot({ path: shotDir + '/e2e_运行状态.png' });
  await page.locator('#detailModal .detail-close').click();
  await page.waitForTimeout(300);

  await page.selectOption('#taskFilter', 'all');
  await page.waitForTimeout(600);
  await page.locator('#tasks').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shotDir + '/e2e_归档.png' });
}

await browser.close();
console.log(`\n===== ${failed === 0 ? '全部通过' : failed + ' 项失败'} =====`);
process.exit(failed === 0 ? 0 : 1);
