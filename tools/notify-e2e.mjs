// 通知功能端到端验收（可选工具，非构建依赖）
//
// 与 tools/e2e-check.mjs 的分工：那个检查页面能不能跑起来；这个检查
// 「触发之后消息到底有没有真的发出去」——所以它在本地起一个接收端，
// 让应用真的朝它 POST，而不是只断言界面文字。
//
// 运行前需要可用的 playwright（项目本身零依赖，不在此声明）：
//   npm i -D playwright && npx playwright install msedge
//   node tools/notify-e2e.mjs --url http://127.0.0.1:3000/ --out ./shots
//
// 建议配合独立数据文件运行，避免污染本机演示数据：
//   DATA_FILE=/tmp/radar-e2e.json PORT=3000 node server.js

import http from 'node:http';
import { chromium } from 'playwright';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const BASE = arg('url', 'http://127.0.0.1:3000/');
const OUTDIR = arg('out', '.');

const log = [];
const check = (name, ok, extra = '') => log.push(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);

// ---- 本地接收端：代替企业微信 / Server 酱，记录真实收到的请求 ----
const received = [];
const hook = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  try { received.push(JSON.parse(body || '{}')); } catch { received.push({ raw: body }); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
});
await new Promise((r) => hook.listen(0, '127.0.0.1', r));
const hookUrl = `http://127.0.0.1:${hook.address().port}/hook`;

const browser = await chromium.launch({ channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
// 接管 Notification：目的是断言"通知确实被触发过"，而不依赖真实系统弹窗
await context.addInitScript(() => {
  window.__notifs = [];
  function Fake(title, opts) { window.__notifs.push({ title, body: opts && opts.body }); }
  Fake.permission = 'granted';
  Fake.requestPermission = async () => 'granted';
  window.Notification = Fake;
});

const page = await context.newPage();
const errors = [];
const dialogs = [];
page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

// ---- ① 通知板块 ----
check('「通知与提醒」板块可见', await page.locator('#notifyBlock').isVisible());
const notifyText = await page.locator('#notifyBlock').innerText();
check('板块含两条通道说明', notifyText.includes('① 浏览器桌面通知') && notifyText.includes('② 微信推送'));
check('如实标注桌面通知的局限', /关掉页面就收不到|页面关掉就收不到/.test(notifyText));

// ---- ② 桌面通知 ----
const before = await page.locator('#desktopState').innerText();
check('桌面通知状态启动后已渲染（不停留在「正在检测」）', !before.includes('正在检测'), before.slice(0, 50));
await page.click('#desktopToggle');
await page.waitForTimeout(400);
check('点击后进入已开启状态', /已开启/.test(await page.locator('#desktopState').innerText()));
check('开启时有反馈提示', (await page.evaluate(() => (window.__notifs || []).length)) >= 1);

// ---- ③ 渠道配置（默认折叠，需展开） ----
const pushBlock = page.locator('#notifyBlock .guide-block').nth(1);
check('② 微信推送子块默认可折叠', !(await pushBlock.locator('#channelType').isVisible()));
await pushBlock.locator('summary').click();
await page.waitForTimeout(300);
check('② 微信推送子块可展开', await pushBlock.locator('#channelType').isVisible());

const opts = await page.locator('#channelType option').allInnerTexts();
check('渠道类型由服务端下发', opts.length >= 4, opts.map((x) => x.split('（')[0]).join(' / '));

await page.selectOption('#channelType', 'custom');
await page.fill('#channelTarget', hookUrl);
await page.click('#channelAdd');
await page.waitForTimeout(900);
const row = (await page.locator('.channel').first().innerText()).replace(/\s+/g, ' ');
check('渠道已保存', row.length > 0, row.slice(0, 70));
check('页面只展示脱敏后的凭证', row.includes('••••'));
check('页面未回显完整凭证', !row.includes(hookUrl));

// ---- ④ 接口不泄露明文 ----
const settingsRaw = await (await fetch(BASE.replace(/\/$/, '') + '/api/settings')).text();
check('GET /api/settings 不含明文凭证', !settingsRaw.includes(hookUrl));
check('GET /api/settings 返回脱敏字段', settingsRaw.includes('targetMasked'));

// ---- ⑤ 测试推送真的发出去 ----
await page.click('#channelTest');
await page.waitForTimeout(2000);
const testHit = received.find((m) => JSON.stringify(m).includes('测试'));
check('测试消息已送达接收端', !!testHit, testHit ? JSON.stringify(testHit).slice(0, 100) : '未收到');
check('界面反馈发送成功', /成功|已发出/.test(await page.locator('#channelTestResult').innerText()));

// ---- ⑥ 真实触发 -> 服务端自动推送 ----
// 取样必须在创建任务之前：任务一落库，定时检查就会立刻跑一次并判定触发
const countBefore = received.length;
await page.fill('#intent', '当 600519.SH 高于 1 元时提醒我');
await page.click('#parse');
await page.waitForSelector('#draft:not(.hidden)');
await page.click('#create');
await page.waitForTimeout(800);
check('任务创建成功', (await page.locator('#tasks .task').count()) >= 1);

let triggerHit = null;
for (let i = 0; i < 25 && !triggerHit; i++) {
  await page.waitForTimeout(1000);
  triggerHit = received.slice(countBefore).find((m) => JSON.stringify(m).includes('监控触发'));
}
check('条件触发后服务端自动推送', !!triggerHit, triggerHit ? JSON.stringify(triggerHit).slice(0, 110) : '25 秒内未收到');
const triggerRaw = JSON.stringify(triggerHit || {});
check('推送含判定依据与时间', /依据/.test(triggerRaw) && /北京时间/.test(triggerRaw));
check('推送带真实行情价与行情日期', /最新价/.test(triggerRaw) && /2026\d{4}/.test(triggerRaw));

const beforeManual = received.length;
await page.click('#tasks .task .check');
await page.waitForTimeout(6000);
check('冷却期内不重复推送（去重语义在推送侧同样生效）', received.length === beforeManual, `手动检查后新增 ${received.length - beforeManual} 条`);

const notifs = await page.evaluate(() => (window.__notifs || []).filter((n) => (n.title || '').includes('监控触发')));
check('桌面通知同样被触发', notifs.length >= 1, notifs.map((n) => n.title).join(' | ').slice(0, 80));

check('检查记录里存在已触发记录', /已触发/.test(await page.locator('#runs').innerText()));
check('页面已刷新出记录列表', (await page.locator('#runs .run').count()) >= 1);

// ---- ⑦ 错误面 ----
// 409 是「该任务正在检查中」：任务创建后定时检查会立刻跑一次，与手动点击重叠属正常，
// 必须由界面静默消化（等待后自动刷新），既不弹原始报错，也不能停在旧状态。
const conflicts = errors.filter((e) => /409 \(Conflict\)/.test(e)).length;
const realErrors = errors.filter((e) => !/409 \(Conflict\)/.test(e));
check('页面无脚本错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
check('定时检查与手动检查重叠时不弹原始报错', dialogs.length === 0, dialogs.join(' | '));

if (OUTDIR !== '.') {
  await page.evaluate(() => document.querySelector('#notifyBlock')?.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(400);
  await page.locator('#notifyBlock').screenshot({ path: `${OUTDIR}/特写4_通知与提醒.png` });
  await page.screenshot({ path: `${OUTDIR}/界面预览_通知功能.png`, fullPage: true });
}

console.log(log.join('\n'));
console.log(`\n接收端共收到 ${received.length} 条推送；页面展示的凭证：${row}`);
console.log(`[说明] 观察到 ${conflicts} 次预期的 409（定时检查与手动检查重叠），已由界面静默处理并自动刷新`);

await browser.close();
await new Promise((r) => hook.close(r));
process.exit(log.some((l) => l.startsWith('❌')) ? 1 : 0);
