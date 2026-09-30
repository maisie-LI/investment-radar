import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, REASONS, ADVICE_OF, reasonText, RETRY_ADVICE, NO_DECISION_TEXT } from '../engine.js';

// 起因：演示环境里任务卡与记录直接显示数据源返回的
// 「Unknown A-share thscode: 600001.SH」，用户看不懂，也分不清
// 「代码写错了」和「数据源暂时取不到」。底层错误必须被翻译，但不能丢。

const RULE = { kind: 'price', symbol: '600001.SH', operator: 'below', threshold: 10, intervalMinutes: 1440, cooldownMinutes: 1440 };
const RAW_TICKER = 'Unknown A-share thscode: 600001.SH';

test('数据源英文错误 → 原因中文化，同时保留原始返回', () => {
  const run = evaluate(RULE, { ok: false, reasonCode: 'TICKER_NOT_FOUND', error: RAW_TICKER });
  assert.equal(run.status, 'error');
  assert.match(run.reason, /股票代码不存在或已退市/, '必须给出用户能看懂的中文结论');
  assert.doesNotMatch(run.reason, /^Unknown/, '不得以英文原文开头');
  assert.match(run.reason, /Unknown A-share thscode: 600001.SH/, '原始返回必须保留，供排查与审计');
  assert.equal(run.rawError, RAW_TICKER, '原始错误单独留一份，便于界面分栏展示');
});

test('代码打错时，建议不是「等待重试」', () => {
  const run = evaluate(RULE, { ok: false, reasonCode: 'TICKER_NOT_FOUND', error: RAW_TICKER });
  assert.notEqual(run.advice, RETRY_ADVICE, '重试不会让错误代码变对，不能只让用户干等');
  assert.match(run.advice, /核对股票代码/);
});

test('已是中文的错误原文不被套前缀复读', () => {
  const raw = '历史行情最后日期 2026-09-25 落后于最近应完成交易日 2026-09-30';
  const run = evaluate({ ...RULE, symbol: '600519.SH' }, { ok: false, degraded: true, reasonCode: 'DATA_STALE', error: raw });
  assert.equal(run.status, 'degraded');
  assert.equal(run.reason, raw, '数据源已本地化的句子应原样呈现');
  assert.equal(run.advice, RETRY_ADVICE, '数据源延迟属于重试可恢复，建议仍是等待重试');
});

test('未知编码不编造中文，退回原文', () => {
  const run = evaluate(RULE, { ok: false, reasonCode: 'SOMETHING_NEW', error: 'gateway exploded' });
  assert.equal(run.reason, 'gateway exploded');
});

test('异常一律写明「本次未执行条件判断」', () => {
  for (const code of ['TICKER_NOT_FOUND', 'SOURCE_ERROR', 'RATE_LIMITED']) {
    const run = evaluate(RULE, { ok: false, reasonCode: code, error: 'boom' });
    assert.equal(run.decision, NO_DECISION_TEXT, `${code} 必须显式声明未执行判定`);
  }
});

test('reasonText：拼接与兜底规则', () => {
  assert.equal(
    reasonText('TICKER_NOT_FOUND', RAW_TICKER),
    '股票代码不存在或已退市（数据源返回：Unknown A-share thscode: 600001.SH）',
  );
  assert.equal(reasonText('TICKER_NOT_FOUND', ''), '股票代码不存在或已退市');
  assert.equal(reasonText('UNKNOWN_CODE', ''), '数据源不可用');
  assert.equal(reasonText('UNKNOWN_CODE', 'raw text'), 'raw text');
});

test('建议映射只覆盖「重试无用」的情形', () => {
  assert.ok(ADVICE_OF.TICKER_NOT_FOUND, '代码错误必须有专门建议');
  assert.ok(ADVICE_OF.AUTH_INVALID, '凭证失效必须有专门建议');
  assert.equal(ADVICE_OF.DATA_STALE, undefined, '数据源延迟应回落到通用重试建议');
  assert.equal(REASONS.TICKER_NOT_FOUND, '股票代码不存在或已退市');
});
