// 端到端验收：用真实浏览器打开页面，确认前端真的渲染出来、且各交互区块可用。
//
// 为什么需要它：接口全部返回 200，不代表页面能用。
// 2026-09-30 就出现过「所有 API 正常、但页面永久停在『正在检查数据服务状态』」的事故，
// 根因是 index.html 里 <script> 的位置早于它要绑定的 DOM。
// 只测接口抓不到这类问题，必须真的把页面打开一次。
// 后续两次界面改版（说明板块折叠、检查记录筛选、通知与提醒）也由它守护。
//
// 用法（需要本机可用的 Chromium 内核浏览器）：
//   node tools/e2e-check.mjs --url http://127.0.0.1:3000/
//   node tools/e2e-check.mjs --url https://invest-radar.app.workbuddy.host/ --shots ./shots
//   BROWSER_PATH="/path/to/chrome" node tools/e2e-check.mjs --url https://example.com/
//
// 依赖 playwright（可选依赖，不参与 npm test 的默认用例，避免 CI 需要浏览器）。

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

// playwright 是可选依赖：先用 CJS 解析（支持 NODE_PATH 指向外部共享安装，
// 便于在没有 node_modules 的仓库里直接跑本脚本），失败再退回 ESM 解析。
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
const rows = [];
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  rows.push({ 检查项: name, 结果: ok ? '通过' : '失败', 说明: String(detail).slice(0, 120) });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + String(detail).slice(0, 120) : ''}`);
};

const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' });
const page = await context.newPage();
const errors = [];
const failedRequests = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('requestfailed', (r) => failedRequests.push(`${r.url()} ${r.failure()?.errorText}`));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('#tasks .task, #tasks article, #tasks p', { timeout: 45000 });
await page.waitForTimeout(2500);

// ---- ① 页面真的跑起来了（事故回归点）----
const banner = ((await page.locator('#healthBanner').innerText().catch(() => '')) || '').trim();
check('横幅已更新，不是初始化文案', banner.length > 0 && !banner.includes('正在检查数据服务状态'), banner);
check('连接徽标已渲染', (((await page.locator('#dataBadge').innerText().catch(() => '')) || '').trim()).length > 0);
const taskCount = await page.locator('#tasks .task, #tasks article').count();
const runCount = await page.locator('#runs details.run, #runs article').count();
check('任务卡已渲染', taskCount >= 1, `${taskCount} 个`);
check('检查记录已渲染', runCount >= 1, `${runCount} 条`);

// ---- ② 状态图例圆点必须有颜色（缺陷 #5 回归点）----
const dots = await page.evaluate(() => [...document.querySelectorAll('.legend .dot, .dot')].map((d) => getComputedStyle(d).backgroundColor));
check('状态图例圆点有可见颜色', dots.length > 0 && dots.every((c) => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent'), `${dots.length} 个圆点`);

// ---- ③ 说明板块（整块可折叠 + 三个子块）----
check('说明板块可折叠', (await page.locator('details.guide:not(.notify)').count()) === 1);
check('说明板块含三个子块', (await page.locator('details.guide:not(.notify) > details.guide-block').count()) === 3);
check('通知与提醒板块存在', (await page.locator('#notifyBlock').count()) === 1);
check('通知板块含两个子块', (await page.locator('#notifyBlock > details.guide-block').count()) === 2);

// ---- ④ 检查记录筛选器 ----
for (const [id, label] of [['runFilter', '查看任务'], ['runRange', '时间区间'], ['runStatus', '结果'], ['runKind', '条件类型'], ['runReset', '重置筛选'], ['runToggleAll', '全部展开']]) {
  check(`筛选控件「${label}」`, (await page.locator('#' + id).count()) === 1);
}
if ((await page.locator('#runKind').count()) === 1) {
  await page.selectOption('#runKind', 'price');
  await page.waitForTimeout(700);
  const byKind = await page.locator('#runs details.run, #runs article').count();
  check('按条件类型筛选能取到记录', byKind > 0, `价格类 ${byKind} 条`);
  await page.click('#runReset');
  await page.waitForTimeout(500);
  const all = await page.locator('#runs details.run, #runs article').count();
  check('重置筛选恢复全部记录', all >= byKind, `${all} 条`);
}

// ---- ⑤ 记录折叠交互 ----
const foldable = await page.locator('#runs details').count();
check('检查记录为可折叠结构', foldable >= 1, `${foldable} 条`);
if (foldable >= 1) {
  await page.click('#runToggleAll');
  await page.waitForTimeout(800);
  const opened = await page.evaluate(() => [...document.querySelectorAll('#runs details')].filter((d) => d.open).length);
  check('全部展开生效', opened >= 1, `${opened} 条已展开`);
  const label = ((await page.locator('#runToggleAll').innerText()) || '').trim();
  check('按钮文案切换为收起', /收起/.test(label), label);
  await page.click('#runToggleAll');
  await page.waitForTimeout(600);
  const stillOpen = await page.evaluate(() => [...document.querySelectorAll('#runs details')].filter((d) => d.open).length);
  check('全部收起生效', stillOpen === 0, `${stillOpen} 条仍展开`);
}

// ---- ⑥ 通知渠道配置入口 ----
const channels = await page.evaluate(() => [...document.querySelectorAll('#channelType option')].map((o) => (o.textContent || '').trim()));
check('推送渠道类型齐全（含个人微信）', channels.length >= 4, channels.map((x) => x.split('（')[0].trim()).join(' / '));
const desktopState = ((await page.locator('#desktopState').innerText().catch(() => '')) || '').trim();
check('桌面通知状态已检测', desktopState.length > 0 && !desktopState.includes('正在检测'), desktopState);
// 「② 微信推送」默认折叠（有意设计），先展开再验证其内容存在
if ((await page.locator('#notifyBlock > details.guide-block').count()) === 2) {
  await page.locator('#notifyBlock > details.guide-block').nth(1).locator('summary').click();
  await page.waitForTimeout(500);
  check('展开后凭证输入框可见', await page.locator('#channelTarget').isVisible());
}

// ---- ⑦ 无脚本错误与失败请求 ----
check('页面无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
check('无失败请求', failedRequests.length === 0, failedRequests.slice(0, 2).join(' | '));

if (shotDir) {
  await page.locator('#notifyBlock').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shotDir}/e2e_通知与提醒.png` });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shotDir}/e2e_整页顶部.png` });
}

await browser.close();

console.log('\n' + JSON.stringify({ 页面: url, 任务卡: taskCount, 记录: runCount, 检查项: rows.length, 失败: failed, 脚本错误: errors.length, 失败请求: failedRequests.length }, null, 2));
console.log(failed ? `\n❌ 端到端检查未通过（${failed} 项）` : '\n✅ 端到端检查全部通过');
process.exit(failed ? 1 : 0);
