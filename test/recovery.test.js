import test from 'node:test';
import assert from 'node:assert/strict';
import { noteRecovery, recoveryCauseOf, RECOVERY_KINDS, HEALTHY_STATUS, ABNORMAL_STATUS } from '../recovery.js';

let seq = 0;
const mkRun = (status, extra = {}) => ({
  id: `run-${(seq += 1)}`,
  checkedAt: new Date(Date.UTC(2026, 8, 30, 2, 0, seq)).toISOString(),
  status,
  ...extra,
});
const emptyTask = () => ({ recovery: { history: [] } });

// ---------- 一、分类覆盖 ----------

test('健康 / 异常两个集合必须覆盖全部状态且互不重叠', () => {
  const all = ['triggered', 'not_triggered', 'cooldown', 'deduplicated', 'skipped', 'error', 'degraded', 'restricted', 'conflict'];
  for (const s of all) {
    const healthy = HEALTHY_STATUS.has(s);
    const abnormal = ABNORMAL_STATUS.has(s);
    assert.ok(healthy !== abnormal, `${s} 必须且只能属于健康或异常之一`);
  }
});

// 用户点名的六种覆盖：暂停后恢复、接口故障恢复、服务重启恢复、错过计划补跑、数据源恢复后重查、恢复后不重复提醒
test('用户点名的恢复路径都有独立分类', () => {
  const required = {
    after_pause: '暂停后恢复',
    after_error: '接口故障恢复',
    after_restart: '服务重启恢复',
    missed_schedule: '错过计划补跑',
    source_recovered: '数据源恢复后重查',
  };
  for (const [kind, label] of Object.entries(required)) {
    assert.equal(RECOVERY_KINDS[kind]?.label, label, `缺少恢复分类 ${kind}`);
  }
});

test('每一种恢复处理都必须写明「未产生重复提醒」', () => {
  for (const [kind, meta] of Object.entries(RECOVERY_KINDS)) {
    assert.ok(meta.label && meta.action, `${kind} 缺少说明`);
    assert.match(meta.action, /未产生重复提醒/, `${kind} 未写明恢复后的去重承诺`);
  }
});

// ---------- 二、六条恢复路径逐一验证 ----------

test('暂停后恢复：记录恢复时间、处理动作，并写入可追溯历史', () => {
  const task = emptyTask();
  task.recovery.pendingCause = 'after_pause';
  const r = mkRun('not_triggered');
  noteRecovery(task, r, null, false);

  assert.equal(task.recovery.recoveryKind, 'after_pause');
  assert.equal(task.recovery.recoveryLabel, '暂停后恢复');
  assert.equal(task.recovery.recoveredAt, r.checkedAt);
  assert.equal(task.recovery.lastSuccessAt, r.checkedAt);
  assert.equal(task.recovery.recoveryCount, 1);
  assert.equal(task.recovery.history.length, 1);
  assert.equal(task.recovery.history[0].to.status, 'not_triggered');
  assert.equal(r.recovery.label, '暂停后恢复', '检查记录本身也要带上恢复信息');
});

test('归档后重新启用：恢复处理说明与暂停区分开，避免两件事看起来一样', () => {
  const task = emptyTask();
  task.recovery.pendingCause = 'after_archive';
  noteRecovery(task, mkRun('not_triggered'), null, false);
  assert.equal(task.recovery.recoveryLabel, '归档后重新启用');
  assert.match(task.recovery.recoveryAction, /重新启用/);
});

test('接口故障恢复：上一轮是数据源错误时归类为「数据源恢复后重查」，并保留异常原因', () => {
  const task = emptyTask();
  const prev = mkRun('error', { reasonCode: 'SOURCE_ERROR', reason: '扶摇接口请求超时' });
  noteRecovery(task, mkRun('not_triggered'), prev, false);

  assert.equal(task.recovery.recoveryKind, 'source_recovered');
  assert.equal(task.recovery.recoveryFrom.status, 'error');
  assert.equal(task.recovery.recoveryFrom.reason, '扶摇接口请求超时', '恢复历史必须能说清"上次坏在什么上"');
  assert.equal(task.recovery.recoveryFrom.checkedAt, prev.checkedAt);
});

test('接口故障恢复（非数据源类错误）归类为「接口故障恢复」', () => {
  const task = emptyTask();
  const prev = mkRun('error', { reasonCode: 'FIELD_MISSING', reason: '行情缺少价格字段' });
  noteRecovery(task, mkRun('triggered'), prev, false);
  assert.equal(task.recovery.recoveryKind, 'after_error');
});

test('降级解除：上一轮是降级 / 受限 / 冲突时单独归类，不混进接口故障', () => {
  for (const status of ['degraded', 'restricted', 'conflict']) {
    const task = emptyTask();
    const prev = mkRun(status, { reasonCode: 'DATA_STALE', reason: '历史行情落后' });
    noteRecovery(task, mkRun('not_triggered'), prev, false);
    assert.equal(task.recovery.recoveryKind, 'after_degrade', `${status} 恢复应归类为降级解除`);
  }
});

test('服务重启恢复：优先级高于「上一次是异常」', () => {
  const task = emptyTask();
  task.recovery.pendingCause = 'after_restart';
  const prev = mkRun('error', { reasonCode: 'SOURCE_ERROR', reason: '超时' });
  noteRecovery(task, mkRun('not_triggered'), prev, false);
  assert.equal(task.recovery.recoveryKind, 'after_restart', '用户最需要知道的是"机器重启过"，而不是"上次超时了"');
});

test('错过计划补跑：实际间隔超过两个周期时记为补跑', () => {
  const task = emptyTask();
  const prev = mkRun('not_triggered');
  noteRecovery(task, mkRun('not_triggered'), prev, true);
  assert.equal(task.recovery.recoveryKind, 'missed_schedule');
  assert.match(task.recovery.recoveryAction, /补跑/);
});

// ---------- 三、红线 ----------

test('本次仍然失败时不得记为已恢复：待恢复标记必须保留到下一次', () => {
  const task = emptyTask();
  task.recovery.pendingCause = 'after_pause';
  noteRecovery(task, mkRun('error', { reasonCode: 'SOURCE_ERROR', reason: '扶摇接口请求超时' }), null, false);

  assert.equal(task.recovery.recoveryKind, undefined, '失败的那一次不能被记成恢复');
  assert.equal(task.recovery.history.length, 0);
  assert.equal(task.recovery.pendingCause, 'after_pause', '标记要留到真正恢复的那一次');
  assert.equal(task.recovery.lastErrorStatus, 'error');
  assert.equal(task.recovery.lastErrorReason, '扶摇接口请求超时');

  const ok = mkRun('triggered');
  noteRecovery(task, ok, null, false);
  assert.equal(task.recovery.recoveryKind, 'after_pause', '恢复后仍要如实标出最初的恢复原因');
  assert.equal(task.recovery.history.length, 1);
});

test('日常连续正常检查不产生恢复记录（避免把例行检查写成恢复叙事）', () => {
  const task = emptyTask();
  noteRecovery(task, mkRun('not_triggered'), mkRun('not_triggered'), false);
  assert.equal(task.recovery.history.length, 0);
  assert.equal(task.recovery.recoveryKind, undefined);
  assert.ok(task.recovery.lastSuccessAt, '成功检查时间照常记录');
});

test('「未触发」与「已触发」都算有结论，都能构成一次恢复', () => {
  for (const status of ['not_triggered', 'triggered', 'cooldown']) {
    const task = emptyTask();
    task.recovery.pendingCause = 'after_error';
    noteRecovery(task, mkRun(status), null, false);
    assert.equal(task.recovery.recoveryKind, 'after_error', `${status} 应被认作有结论`);
  }
});

test('恢复历史可追溯且有上限，超限只裁掉最旧的', () => {
  const task = emptyTask();
  for (let i = 0; i < 25; i += 1) {
    task.recovery.pendingCause = 'after_error';
    noteRecovery(task, mkRun('not_triggered'), null, false);
  }
  assert.equal(task.recovery.history.length, 20, '历史最多保留 20 条');
  assert.equal(task.recovery.recoveryCount, 25, '累计次数如实统计');
  const head = task.recovery.history[0];
  assert.ok(head.at && head.label && head.action && head.to, '每条历史都要能说清时间、类型、处理与结果');
});

test('恢复原因优先级：人工干预 > 重启 > 上一次异常 > 调度缺口', () => {
  const abnormal = mkRun('error', { reasonCode: 'SOURCE_ERROR' });
  assert.equal(recoveryCauseOf(abnormal, 'after_pause', true), 'after_pause');
  assert.equal(recoveryCauseOf(abnormal, 'after_restart', true), 'after_restart');
  assert.equal(recoveryCauseOf(abnormal, null, true), 'source_recovered');
  assert.equal(recoveryCauseOf(mkRun('not_triggered'), null, true), 'missed_schedule');
  assert.equal(recoveryCauseOf(mkRun('not_triggered'), null, false), null);
  assert.equal(recoveryCauseOf(null, null, false), null);
});
