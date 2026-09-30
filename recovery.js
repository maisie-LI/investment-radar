// 恢复叙事：把「系统曾经坏过、又是怎么好起来的」拆成可追溯的事件。
//
// 为什么单独成模块：这段逻辑如果写在服务入口里，就没法被单元测试直接覆盖，
// 而"恢复后不重复提醒"这类结论恰恰是最需要被断言、而不是被口头保证的。
//
// 术语：
//   健康状态（HEALTHY）  = 本次检查给出了明确结论，或按规则有意跳过（非交易日）
//   异常状态（ABNORMAL） = 本次检查没能给出结论（降级 / 失败 / 数据受限 / 数据冲突）
// 「恢复」= 从异常回到健康，且能说清触发原因与处理动作。
export const HEALTHY_STATUS = new Set(['triggered', 'not_triggered', 'cooldown', 'deduplicated', 'skipped']);
export const ABNORMAL_STATUS = new Set(['error', 'degraded', 'restricted', 'conflict']);

// 六种恢复路径，每一类都明确写出"恢复时做了什么处理"。
// 其中「未产生重复提醒」是恢复处理的核心承诺：恢复不等于重新提醒一遍。
export const RECOVERY_KINDS = {
  after_pause: { label: '暂停后恢复', action: '恢复调度并重新检查，未产生重复提醒' },
  after_archive: { label: '归档后重新启用', action: '重新启用并恢复调度，未产生重复提醒' },
  after_error: { label: '接口故障恢复', action: '重新检查，未产生重复提醒' },
  after_restart: { label: '服务重启恢复', action: '重启后重新检查，未产生重复提醒' },
  missed_schedule: { label: '错过计划补跑', action: '补跑错过的检查，未产生重复提醒' },
  source_recovered: { label: '数据源恢复后重查', action: '数据源恢复后重新检查，未产生重复提醒' },
  after_degrade: { label: '降级解除后重查', action: '数据恢复后重新检查，未产生重复提醒' },
};

// 触发原因优先级：人工干预（暂停 / 归档）> 进程重启 > 上一次是异常 > 调度缺口。
// 顺序不能反：一次重启后的首次检查往往同时"上一次是异常"，
// 但用户最需要知道的是"机器重启过"，而不是"上次接口超时了"。
export function recoveryCauseOf(prev, pendingCause, missedGap) {
  if (pendingCause && RECOVERY_KINDS[pendingCause]) return pendingCause;
  if (prev && ABNORMAL_STATUS.has(prev.status)) {
    if (prev.reasonCode === 'SOURCE_ERROR' || prev.reasonCode === 'RATE_LIMITED') return 'source_recovered';
    if (prev.status === 'error') return 'after_error';
    return 'after_degrade';
  }
  if (missedGap) return 'missed_schedule';
  return null;
}

// 就地更新 task.recovery，并在 run 上挂一份（这样检查记录列表里也能直接看到恢复动作）
export function noteRecovery(task, run, prev, missedGap) {
  const rec = task.recovery ??= { history: [] };
  rec.history ??= [];

  if (HEALTHY_STATUS.has(run.status)) rec.lastSuccessAt = run.checkedAt;
  if (ABNORMAL_STATUS.has(run.status)) {
    rec.lastErrorAt = run.checkedAt;
    rec.lastErrorStatus = run.status;
    rec.lastErrorCode = run.reasonCode || null;
    rec.lastErrorReason = run.reason || null;
  }

  // 只有真正回到健康状态才消费掉"待恢复原因"。
  // 若这次仍然失败，标记必须保留到下一次——否则一次失败就被记成"已恢复"，
  // 恢复历史会变成一份好看但失真的记录。
  if (!HEALTHY_STATUS.has(run.status)) return;

  const cause = recoveryCauseOf(prev, rec.pendingCause, missedGap);
  rec.pendingCause = null;
  if (!cause) return;

  const meta = RECOVERY_KINDS[cause];
  const from = prev
    ? { status: prev.status, reasonCode: prev.reasonCode || null, reason: prev.reason || null, checkedAt: prev.checkedAt }
    : (rec.lastErrorAt
      ? { status: rec.lastErrorStatus, reasonCode: rec.lastErrorCode, reason: rec.lastErrorReason, checkedAt: rec.lastErrorAt }
      : null);

  const entry = {
    kind: cause,
    label: meta.label,
    action: meta.action,
    at: run.checkedAt,
    runId: run.id,
    from,
    to: { status: run.status, reasonCode: run.reasonCode || null },
  };

  rec.recoveredAt = run.checkedAt;
  rec.recoveryKind = cause;
  rec.recoveryLabel = meta.label;
  rec.recoveryAction = meta.action;
  rec.recoveryFrom = from;
  rec.recoveryCount = (rec.recoveryCount || 0) + 1;
  rec.history.unshift(entry);
  rec.history.splice(20);

  run.recovery = entry;
  return entry;
}
