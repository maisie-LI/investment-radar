import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchHeat } from '../provider.js';

const okBody = (item) => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { item }, request_id: 'r-ok' }) });

async function withMock(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

test('瞬时故障会退避重试，成功后返回并记录尝试次数', async () => {
  let calls = 0;
  const r = await withMock(async () => {
    calls += 1;
    if (calls === 1) { const e = new Error('socket hang up'); e.name = 'TypeError'; throw e; }
    return okBody([{ thscode: '600519.SH', name: '贵州茅台', rank: 5, heat: '100' }]);
  }, () => fetchHeat('600519.SH', 'test-key'));

  assert.equal(calls, 2, '应发生一次重试');
  assert.equal(r.ok, true);
  assert.equal(r.rank, 5);
  assert.equal(r.attempts, 2, '证据链应记录实际尝试次数');
});

test('凭证/参数类错误不做重试，立即返回', async () => {
  let calls = 0;
  const r = await withMock(async () => {
    calls += 1;
    return { ok: false, status: 401, json: async () => ({ code: 2003, message: 'Invalid or revoked API key' }) };
  }, () => fetchHeat('600519.SH', 'test-key'));

  assert.equal(calls, 1, '鉴权失败不应重试');
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'AUTH_INVALID');
  assert.equal(r.meta.error.attempts, 1);
});

test('重试耗尽后返回最后一次错误', async () => {
  let calls = 0;
  const r = await withMock(async () => {
    calls += 1;
    return { ok: false, status: 503, json: async () => ({ code: 5003, message: 'upstream unavailable' }) };
  }, () => fetchHeat('600519.SH', 'test-key'));

  assert.equal(calls, 3, '应为 1 次初始 + 2 次重试');
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'SOURCE_ERROR');
  assert.equal(r.meta.error.attempts, 3);
});

test('未配置 Key 时直接返回鉴权错误，不发起请求', async () => {
  let calls = 0;
  const r = await withMock(async () => { calls += 1; return okBody([]); }, () => fetchHeat('600519.SH', ''));
  assert.equal(calls, 0);
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'AUTH_INVALID');
});

test('热股榜返回空列表时按“数据未就绪”降级，而不是判定为不在榜', async () => {
  const r = await withMock(async () => okBody([]), () => fetchHeat('600519.SH', 'test-key'));
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'DATA_NOT_READY');
});
