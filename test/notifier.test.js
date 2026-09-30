// 出站通知模块测试
//
// 这一组的重点是「把消息发到哪、发成什么形状」，以及最容易被忽略的一点：
// 这三家渠道都是 HTTP 200 + 业务错误码的返回风格，只看状态码会把失败当成功。
// 所以用例里专门有一个「errcode 非 0 必须判为失败」的断言。
//
// 另外锁死一条产品红线：推送失败绝不能反过来让检查失败。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CHANNEL_TYPES, isKnownType, maskTarget, buildMessage, buildRequest, notifyChannels } from '../notifier.js';

// 起一个本地接收端，记录真实发出去的请求，并按用例指定返回
async function catcher(reply) {
  const received = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ method: req.method, url: req.url, body: JSON.parse(body || '{}') });
    const { status, payload } = reply(received.length);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    received,
    port: server.address().port,
    base: `http://127.0.0.1:${server.address().port}/hook`,
    close: () => new Promise((r) => server.close(r)),
  };
}

const msg = { title: '【监控触发】测试任务', content: '条件：价格满足', url: '' };

test('渠道类型清单完整、唯一，且都带界面所需的说明文案', () => {
  const types = CHANNEL_TYPES.map((t) => t.type);
  assert.equal(new Set(types).size, types.length, '渠道类型不允许重复');
  for (const t of types) assert.ok(['wecom', 'serverchan', 'pushplus', 'custom'].includes(t), `未预期的渠道类型 ${t}`);
  for (const t of CHANNEL_TYPES) {
    assert.ok(t.label && t.delivery && t.hint && t.placeholder, `${t.type} 缺少界面文案`);
  }
  assert.ok(isKnownType('wecom'));
  assert.ok(!isKnownType('feishu'), '未支持的渠道类型必须被识别为未知');
});

test('凭证脱敏只保留尾部 4 位，且不泄露长度', () => {
  assert.equal(maskTarget('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdef123456'), '••••3456');
  assert.equal(maskTarget('SCTabcdefghijklmnop'), '••••mnop');
  assert.equal(maskTarget('short'), '••••', '过短的凭证不暴露任何字符');
  assert.equal(maskTarget(''), '');
  assert.ok(!maskTarget('SCT1234567890abcdef').includes('1234567890'), '脱敏结果不得包含原文中段');
});

test('推送正文包含条件、判定依据、检查时间与规则版本', () => {
  const m = buildMessage({
    taskTitle: '贵州茅台价格突破', kind: 'price', status: 'triggered', version: 2,
    checkedAt: '2026-09-30T04:00:00.000Z',
    reason: '当前价格 1520 元，满足高于 1500 元',
    evidence: { price: 1520, marketDate: '20260929' },
  }, { title: '贵州茅台价格突破' });
  assert.match(m.title, /贵州茅台价格突破/);
  assert.match(m.title, /监控触发/);
  assert.match(m.content, /1520/);
  assert.match(m.content, /20260929/);
  assert.match(m.content, /v2/);
  assert.match(m.content, /北京时间/, '时间必须标注时区，否则收件人无法判断时效');
});

test('推送正文在缺少证据时不编造内容', () => {
  const m = buildMessage({ taskTitle: 'X', kind: 'price', status: 'triggered', version: 1, checkedAt: new Date().toISOString(), reason: '条件满足', evidence: null }, {});
  assert.match(m.content, /没有可用于判定的有效数据/);
});

// ---------- 地址与载荷约定 ----------
test('企业微信群机器人：必须填完整 Webhook 地址，不接受裸 key', () => {
  assert.throws(() => buildRequest({ type: 'wecom', target: 'abc123' }, msg), /完整 Webhook 地址/);
  const r = buildRequest({ type: 'wecom', target: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k1' }, msg);
  assert.equal(r.url, 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k1');
  assert.equal(r.body.msgtype, 'text');
  assert.match(r.body.text.content, /【监控触发】测试任务/);
});

test('Server 酱：只给 SendKey 时自动补全地址，给完整地址时原样使用', () => {
  const a = buildRequest({ type: 'serverchan', target: 'SCTabc' }, msg);
  assert.equal(a.url, 'https://sctapi.ftqq.com/SCTabc.send');
  assert.deepEqual(a.body, { title: msg.title, desp: msg.content });

  const b = buildRequest({ type: 'serverchan', target: 'https://12345.push.ft07.com/send/SCTxyz.send' }, msg);
  assert.equal(b.url, 'https://12345.push.ft07.com/send/SCTxyz.send', '新版 Server 酱的完整地址应原样使用');
});

test('PushPlus：token 走载荷而非常量地址，避免凭证出现在 URL 里', () => {
  const r = buildRequest({ type: 'pushplus', target: 'tok123' }, msg);
  assert.equal(r.url, 'https://www.pushplus.plus/send');
  assert.equal(r.body.token, 'tok123');
  assert.ok(!r.url.includes('tok123'), '凭证不得拼接进 URL（会被日志与浏览器历史记录留痕）');
});

test('自定义 Webhook：发送 title / content / url 三个字段', () => {
  const r = buildRequest({ type: 'custom', target: 'https://example.com/hook' }, { ...msg, url: 'https://radar.example' });
  assert.equal(r.url, 'https://example.com/hook');
  assert.deepEqual(r.body, { title: msg.title, content: msg.content, url: 'https://radar.example' });
  assert.throws(() => buildRequest({ type: 'custom', target: 'example.com/hook' }, msg), /http\(s\)/);
});

test('未知渠道类型与空凭证都被明确拒绝，而不是猜一个默认地址', () => {
  assert.throws(() => buildRequest({ type: 'feishu', target: 'https://a.b' }, msg), /未知的推送渠道类型/);
  assert.throws(() => buildRequest({ type: 'wecom', target: '   ' }, msg), /未填写推送地址或密钥/);
});

// ---------- 真实发送行为 ----------
test('企业微信发送成功：errcode 为 0 才算成功', async () => {
  const c = await catcher(() => ({ status: 200, payload: { errcode: 0, errmsg: 'ok' } }));
  const results = await notifyChannels([{ id: '1', type: 'wecom', target: c.base, enabled: true }], msg);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(c.received[0].method, 'POST');
  await c.close();
});

test('HTTP 200 但业务错误码非 0 必须判为失败', async () => {
  const c = await catcher(() => ({ status: 200, payload: { errcode: 93000, errmsg: 'invalid webhook url' } }));
  const results = await notifyChannels([{ id: '1', type: 'wecom', target: c.base, enabled: true }], msg);
  assert.equal(results[0].ok, false, '只看状态码会把这类失败当成功，用户永远收不到消息却以为一切正常');
  assert.match(results[0].detail, /93000/);
  await c.close();
});

test('HTTP 非 2xx 判为失败，并把返回片段带出来便于排查', async () => {
  const c = await catcher(() => ({ status: 500, payload: { message: 'internal error' } }));
  const results = await notifyChannels([{ id: '1', type: 'wecom', target: c.base, enabled: true }], msg);
  assert.equal(results[0].ok, false);
  assert.match(results[0].detail, /HTTP 500/);
  await c.close();
});

test('渠道不可达时返回失败结果，绝不向上抛异常（推送失败不得让检查失败）', async () => {
  const results = await notifyChannels([{ id: 'x', type: 'custom', target: 'http://127.0.0.1:1/none', enabled: true }], msg);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.ok(results[0].detail, '失败必须给出可排查的原因');
});

test('多渠道路由：未启用与未填凭证的渠道被跳过，不产生任何请求', async () => {
  const results = await notifyChannels([
    { id: 'a', type: 'wecom', target: '', enabled: true },
    { id: 'b', type: 'wecom', target: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k', enabled: false },
    null,
  ], msg);
  assert.deepEqual(results, [], '没有可用渠道时不应发起请求，也不应报错');
});

test('一个渠道失败不影响另一个渠道成功', async () => {
  const c = await catcher(() => ({ status: 200, payload: { errcode: 0, errmsg: 'ok' } }));
  const results = await notifyChannels([
    { id: 'bad', type: 'custom', target: 'http://127.0.0.1:1/none', enabled: true },
    { id: 'good', type: 'wecom', target: c.base, enabled: true },
  ], msg);
  const byId = Object.fromEntries(results.map((r) => [r.channelId, r.ok]));
  assert.equal(byId.bad, false);
  assert.equal(byId.good, true, '一个渠道发不出去，不应连累其他渠道');
  await c.close();
});
