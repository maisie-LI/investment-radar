// notifier.js —— 出站通知（服务端），零外部依赖
//
// 为什么必须由服务端推送，而不是前端轮询后弹窗：
// 前端弹窗依赖页面处于打开状态。用户关掉页面，任何「已触发」都不会被告知，
// 而这恰恰是监控类产品最该覆盖的场景。服务端在判定触发的那一刻直接发请求，
// 才能真正做到无人值守。
//
// 三条硬约定（与项目其他模块保持一致）：
// 1. 只用 Node 原生 fetch，不引入任何第三方 SDK；
// 2. 通知失败绝不向上抛：所有异常在此文件内消化为 { ok:false, detail }，
//    绝不允许因为"推送没发出去"而让检查本身失败或记录丢失；
// 3. 凭证只存放在运行时状态里（data/state.json 已在 .gitignore 中排除），
//    对外接口一律返回脱敏形态，原文不出服务端。

const TIMEOUT_MS = 10000;

export const CHANNEL_TYPES = [
  {
    type: 'wecom',
    label: '企业微信群机器人',
    delivery: '推送到企业微信群',
    hint: '在企业微信群里点右上角「…」→ 添加群机器人，把生成的完整 Webhook 地址粘贴过来。免费、无条数限制。',
    placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…',
  },
  {
    type: 'serverchan',
    label: 'Server 酱',
    delivery: '推送到个人微信',
    hint: '在 sct.ftqq.com 用微信扫码登录并绑定，把 SendKey 粘贴过来（也支持直接粘贴完整发送地址）。',
    placeholder: 'SCT… 或 https://sctapi.ftqq.com/xxx.send',
  },
  {
    type: 'pushplus',
    label: 'PushPlus',
    delivery: '推送到个人微信',
    hint: '在 pushplus.plus 微信扫码登录，把「一对一推送」的 token 粘贴过来。',
    placeholder: '你的 pushplus token',
  },
  {
    type: 'custom',
    label: '自定义 Webhook',
    delivery: 'POST 到你自己的地址',
    hint: '任何接受 POST JSON 的地址，我们会发送 { title, content, url } 三个字段。',
    placeholder: 'https://example.com/hook',
  },
];

export function isKnownType(type) {
  return CHANNEL_TYPES.some((t) => t.type === type);
}

// 脱敏：只保留尾部 4 位。读取接口一律返回这个形态，完整凭证永远不出服务端。
export function maskTarget(value) {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 8) return '••••';
  return `••••${s.slice(-4)}`;
}

function beijingTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso || '');
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(t);
}

// 通知正文里的「依据」单独写一份精简版，不复用前端的 evidenceText：
// 前端那份会带 HTML 无关的中文长句，而推送渠道对长度更敏感。
function evidenceLine(run) {
  const e = run.evidence;
  if (!e) return '本次没有可用于判定的有效数据';
  if (run.kind === 'heat') return `热股榜第 ${e.rank ?? '—'} 名（榜内共 ${e.listSize} 条）`;
  if (run.kind === 'event') return `命中异动标签「${e.tagName || '—'}」`;
  if (run.kind === 'calendar') return `今日 ${e.today} · ${e.isTradeDay ? '交易日' : '非交易日'}`;
  return `最新价 ${e.price} 元 · 行情日期 ${e.marketDate || '待验证'}`;
}

export function buildMessage(run, task) {
  const title = `【监控触发】${run.taskTitle || task?.title || run.symbol || '监控任务'}`;
  const content = [
    `条件：${run.reason || '条件已满足'}`,
    `依据：${evidenceLine(run)}`,
    `时间：${beijingTime(run.checkedAt)}（北京时间）`,
    `规则版本：v${run.version ?? '—'}`,
  ].join('\n');
  return { title, content, url: process.env.PUBLIC_URL || '' };
}

function endpointOf(channel) {
  const target = String(channel.target || '').trim();
  if (!target) throw new Error('未填写推送地址或密钥');
  const looksLikeUrl = /^https?:\/\//i.test(target);

  switch (channel.type) {
    case 'wecom':
      if (!looksLikeUrl) throw new Error('企业微信机器人需要填写完整 Webhook 地址（以 https:// 开头）');
      return target;
    case 'serverchan':
      // 兼容两代 Server 酱：新版是完整地址，老版只有 SendKey
      return looksLikeUrl ? target : `https://sctapi.ftqq.com/${target}.send`;
    case 'pushplus':
      return 'https://www.pushplus.plus/send';
    case 'custom':
      if (!looksLikeUrl) throw new Error('自定义 Webhook 需要以 http(s):// 开头');
      return target;
    default:
      throw new Error(`未知的推送渠道类型：${channel.type}`);
  }
}

function payloadOf(channel, message) {
  const target = String(channel.target || '').trim();
  switch (channel.type) {
    case 'wecom':
      return { msgtype: 'text', text: { content: `${message.title}\n${message.content}` } };
    case 'serverchan':
      return { title: message.title, desp: message.content };
    case 'pushplus':
      return { token: target, title: message.title, content: message.content, template: 'txt' };
    default:
      return { title: message.title, content: message.content, url: message.url };
  }
}

// 这三家都是 HTTP 200 + 业务错误码的返回风格，只看状态码会把失败当成成功，
// 所以必须逐家判断业务字段。
function judge(channel, status, text) {
  if (status < 200 || status >= 300) return { ok: false, detail: `HTTP ${status}：${text.slice(0, 120)}` };
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON：以 HTTP 2xx 视为已送达 */ }
  if (!body) return { ok: true, detail: `HTTP ${status}` };

  if (channel.type === 'wecom') {
    return body.errcode === 0
      ? { ok: true, detail: 'errcode=0' }
      : { ok: false, detail: `errcode=${body.errcode} ${body.errmsg || ''}`.trim() };
  }
  if (channel.type === 'serverchan') {
    const code = body.code ?? body.data?.code;
    return code === 0
      ? { ok: true, detail: 'code=0' }
      : { ok: false, detail: `code=${code} ${body.message || body.msg || body.info || ''}`.trim() };
  }
  if (channel.type === 'pushplus') {
    return body.code === 200
      ? { ok: true, detail: 'code=200' }
      : { ok: false, detail: `code=${body.code} ${body.msg || ''}`.trim() };
  }
  return { ok: true, detail: `HTTP ${status}` };
}

// 把「渠道 + 消息」翻译成一次 HTTP 请求（地址 + 载荷）。
// 单独抽出来是为了让测试能直接断言各家渠道的地址与字段约定，不必真的发出去。
export function buildRequest(channel, message) {
  return { url: endpointOf(channel), body: payloadOf(channel, message) };
}

async function deliver(channel, message) {
  try {
    const { url, body } = buildRequest(channel, message);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = (await res.text()).slice(0, 400);
    return judge(channel, res.status, text);
  } catch (e) {
    const detail = e.name === 'TimeoutError' ? `请求超时（超过 ${TIMEOUT_MS}ms）` : (e.message || String(e));
    return { ok: false, detail };
  }
}

// 逐个渠道发送并汇总结果。任何单渠道失败都不影响其他渠道，也不影响调用方。
export async function notifyChannels(channels, message) {
  const usable = (channels || []).filter((c) => c && c.enabled !== false && c.target);
  if (!usable.length) return [];
  const settled = await Promise.all(usable.map(async (c) => {
    const r = await deliver(c, message);
    return { channelId: c.id, type: c.type, ok: r.ok, detail: r.detail };
  }));
  return settled;
}
