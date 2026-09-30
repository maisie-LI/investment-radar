// 检查记录迁移回归测试
//
// 背景（2026-09-30 真实缺陷）：
//   更早版本的代码没有把 kind / durationMs 落库到每条检查记录里。
//   server.js 启动时会迁移 state.tasks，但漏掉了 state.runs。
//   后果不是"少个字段"这么轻：
//     1. 前端「条件类型」筛选对全部历史记录失效（kind 为 undefined，任何类型都筛不出来）；
//     2. 判定依据 evidenceText(e, kind) 会走错分支，把热度/事件/日历记录按价格口径渲染。
//
// 这组用例用真实的服务进程 + 夹具数据锁死迁移行为。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return await r.json();
    } catch { /* 还没起来，继续等 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('服务在超时时间内未就绪');
}

// 任务一律 enabled:false，避免启动与请求触发真实的外部行情调用（测试不依赖网络）
function fixture() {
  const base = { intervalMinutes: 5, cooldownMinutes: 60, symbol: '600519.SH', threshold: 1500 };
  return {
    tasks: [{
      id: 'task-1',
      title: '夹具任务',
      version: 2,
      enabled: false,
      createdAt: '2026-09-01T00:00:00.000Z',
      lastCheckedAt: null,
      lastStatus: 'pending',
      rule: { kind: 'price', operator: 'above', ...base },
      versions: [
        { version: 2, changedAt: '2026-09-02T00:00:00.000Z', rule: { kind: 'price', operator: 'above', ...base }, note: '用户修改规则' },
        { version: 1, changedAt: '2026-09-01T00:00:00.000Z', rule: { kind: 'heat', operator: 'in_top', ...base, threshold: 10 }, note: '创建任务' },
      ],
    }],
    runs: [
      // v1 是热度规则 → 迁移后应为 heat（不能被"当前规则 = price"覆盖）
      { id: 'run-v1', taskId: 'task-1', taskTitle: '夹具任务', version: 1, status: 'not_triggered', reasonCode: 'CONDITION_NOT_MET', reason: '旧记录', checkedAt: '2026-09-01T01:00:00.000Z', evidence: null },
      // v2 是价格规则 → 迁移后应为 price
      { id: 'run-v2', taskId: 'task-1', taskTitle: '夹具任务', version: 2, status: 'not_triggered', reasonCode: 'CONDITION_NOT_MET', reason: '旧记录', checkedAt: '2026-09-02T01:00:00.000Z', evidence: null },
      // 已带 kind 的新记录 → 必须保持原值不动
      { id: 'run-new', taskId: 'task-1', taskTitle: '夹具任务', version: 2, kind: 'calendar', durationMs: 12, status: 'not_triggered', reasonCode: 'CONDITION_NOT_MET', reason: '新记录', checkedAt: '2026-09-03T01:00:00.000Z', evidence: null },
    ],
  };
}

test('启动时迁移历史检查记录：按产生该记录时的规则版本补齐 kind', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-mig-'));
  const dataFile = join(dir, 'state.json');
  await writeFile(dataFile, JSON.stringify(fixture(), null, 2));
  const port = await freePort();

  const child = spawn(process.execPath, [join(root, 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_FILE: dataFile, FUYAO_API_KEY: '' },
    stdio: 'ignore',
  });
  t.after(() => {
    // 只结束本测试自己拉起的进程
    if (!child.killed) child.kill();
    return rm(dir, { recursive: true, force: true });
  });

  await waitForHealth(port);
  const r = await fetch(`http://127.0.0.1:${port}/api/tasks`, { signal: AbortSignal.timeout(5000) });
  assert.equal(r.status, 200, '/api/tasks 应可用');
  const body = await r.json();
  const byId = Object.fromEntries(body.runs.map((x) => [x.id, x]));

  assert.equal(byId['run-v1'].kind, 'heat', 'v1 记录应按 v1 规则迁移为 heat，而不是取当前规则的 price');
  assert.equal(byId['run-v2'].kind, 'price', 'v2 记录应迁移为 price');
  assert.equal(byId['run-new'].kind, 'calendar', '已带 kind 的记录不得被覆盖');

  // 迁移结果必须对所有记录可用，否则前端「条件类型」筛选会落空
  assert.equal(body.runs.filter((x) => !x.kind).length, 0, '迁移后不应再有缺 kind 的记录');
});
