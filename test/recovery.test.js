import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  computeRecoveryPlan,
  RecoverySession,
  MIGRATION_STATUS,
  EVENT_TYPES,
} from '../src/recovery.js';

const blockRefs = [
  { blockId: 'b0', tokenStart: 0, tokenEnd: 16, version: 3 },
  { blockId: 'b1', tokenStart: 16, tokenEnd: 32, version: 3 },
  { blockId: 'b2', tokenStart: 32, tokenEnd: 48, version: 2 },
];

const allMigrated = [
  { blockId: 'b0', version: 3, tokenEnd: 16 },
  { blockId: 'b1', version: 3, tokenEnd: 32 },
  { blockId: 'b2', version: 2, tokenEnd: 48 },
];

const baseInput = {
  requestId: 'req-1',
  outputTokens: 40,
  blockRefs,
  migratedBlocks: allMigrated,
  migrationStatus: MIGRATION_STATUS.COMPLETE,
  clientAck: { ackedTokens: 24, connected: true },
};

describe('迁移中断', () => {
  it('块引用未完整迁移且迁移仍在进行时禁止继续生成', () => {
    const plan = computeRecoveryPlan({
      ...baseInput,
      migratedBlocks: allMigrated.slice(0, 2),
      migrationStatus: MIGRATION_STATUS.IN_PROGRESS,
      events: [{ eventId: 'ev-1', type: EVENT_TYPES.FAILOVER, newNodeOffset: 8 }],
    });

    assert.equal(plan.blocked, true);
    assert.equal(plan.recoverable, false);
    assert.deepEqual(plan.blockedReasons, ['migration_incomplete', 'block_refs_incomplete']);
    assert.deepEqual(plan.missingBlockIds, ['b2']);
    assert.equal(plan.kvSafeEnd, 32);
    assert.equal(plan.recoveryPosition, null);
    assert.equal(plan.continueFrom, null);
    assert.equal(plan.duplicatePrefix.tokenCount, 16);
    assert.deepEqual(plan.duplicatePrefix, { start: 8, end: 24, tokenCount: 16 });
  });

  it('后续故障转移事件补齐块后恢复，并从确认位置继续', () => {
    const session = new RecoverySession({
      ...baseInput,
      migratedBlocks: allMigrated.slice(0, 2),
      migrationStatus: MIGRATION_STATUS.IN_PROGRESS,
      clientAck: { ackedTokens: 24, connected: true },
    });

    const first = session.applyEvent({
      eventId: 'ev-fail-1',
      type: EVENT_TYPES.FAILOVER,
      newNodeOffset: 8,
    }).plan;
    assert.equal(first.blocked, true);

    const second = session.applyEvent({
      eventId: 'ev-fail-2',
      type: EVENT_TYPES.FAILOVER,
      migrationStatus: MIGRATION_STATUS.COMPLETE,
      newNodeOffset: 24,
      migratedBlocks: [{ blockId: 'b2', version: 2, tokenEnd: 48 }],
    }).plan;

    assert.equal(second.blocked, false);
    assert.equal(second.recoveryPosition, 24);
    assert.equal(second.continueFrom, 40);
    assert.equal(second.kvSafeEnd, 48);
    assert.equal(second.duplicatePrefix, null);
    assert.deepEqual(second.redeliverRange, { start: 24, end: 40, tokenCount: 16 });
    assert.equal(second.regenerateRange, null);
  });
});

describe('客户端断线', () => {
  it('恢复位置可计算但交付挂起，重连后再投递', () => {
    const session = new RecoverySession({
      ...baseInput,
      clientAck: { ackedTokens: 24, connected: false },
    });

    const offline = session.applyEvent({
      eventId: 'ev-offline',
      type: EVENT_TYPES.FAILOVER,
      newNodeOffset: 24,
    }).plan;

    assert.equal(offline.blocked, false);
    assert.equal(offline.status, 'awaiting_reconnect');
    assert.equal(offline.deliveryBlocked, true);
    assert.equal(offline.recoveryPosition, 24);
    assert.deepEqual(offline.redeliverRange, { start: 24, end: 40, tokenCount: 16 });

    const reconnected = session.applyEvent({
      eventId: 'ev-reconnect',
      type: EVENT_TYPES.RECONNECT,
    }).plan;

    assert.equal(reconnected.status, 'ready');
    assert.equal(reconnected.deliveryBlocked, false);
    assert.equal(reconnected.clientConnected, true);
  });

  it('断线期间到达的 ACK 提升确认位置后，恢复位置同步提升', () => {
    const session = new RecoverySession({
      ...baseInput,
      clientAck: { ackedTokens: 24, connected: false },
    });
    session.applyEvent({ eventId: 'ev-fail', type: EVENT_TYPES.FAILOVER, newNodeOffset: 24 });
    session.applyEvent({ eventId: 'ev-ack', type: EVENT_TYPES.ACK, ackedTokens: 30 });

    const plan = session.plan();
    assert.equal(plan.clientAckTokens, 30);
    assert.equal(plan.recoveryPosition, 30);
    assert.deepEqual(plan.redeliverRange, { start: 30, end: 40, tokenCount: 10 });
  });
});

describe('块冲突', () => {
  it('版本冲突落在确认前缀内时阻断，必须重建 KV 前缀', () => {
    const plan = computeRecoveryPlan({
      ...baseInput,
      migratedBlocks: [
        { blockId: 'b0', version: 3, tokenEnd: 16 },
        { blockId: 'b1', version: 2, tokenEnd: 32 },
        { blockId: 'b2', version: 2, tokenEnd: 48 },
      ],
      events: [{ eventId: 'ev-1', type: EVENT_TYPES.FAILOVER, newNodeOffset: 16 }],
    });

    assert.equal(plan.blocked, true);
    assert.deepEqual(plan.blockedReasons, ['kv_prefix_incomplete']);
    assert.deepEqual(plan.conflictingBlockIds, ['b1']);
    assert.equal(plan.kvSafeEnd, 16);
    assert.deepEqual(plan.rebuildKvRange, { start: 16, end: 24, tokenCount: 8 });
  });

  it('版本冲突落在确认位置之后时不阻断，冲突区间重新生成', () => {
    const plan = computeRecoveryPlan({
      ...baseInput,
      clientAck: { ackedTokens: 16, connected: true },
      migratedBlocks: [
        { blockId: 'b0', version: 3, tokenEnd: 16 },
        { blockId: 'b1', version: 2, tokenEnd: 32 },
        { blockId: 'b2', version: 2, tokenEnd: 48 },
      ],
      events: [{ eventId: 'ev-1', type: EVENT_TYPES.FAILOVER, newNodeOffset: 16 }],
    });

    assert.equal(plan.blocked, false);
    assert.equal(plan.recoveryPosition, 16);
    assert.deepEqual(plan.conflictingBlockIds, ['b1']);
    assert.equal(plan.redeliverRange, null);
    assert.deepEqual(plan.regenerateRange, { start: 16, end: 40, tokenCount: 24 });
  });

  it('同一 blockId 出现两个迁移版本视为歧义冲突', () => {
    const session = new RecoverySession(baseInput);
    const plan = session.applyEvent({
      eventId: 'ev-conflict',
      type: EVENT_TYPES.FAILOVER,
      newNodeOffset: 24,
      migratedBlocks: [
        { blockId: 'b2', version: 2, tokenEnd: 48 },
        { blockId: 'b2', version: 9, tokenEnd: 48 },
      ],
    }).plan;

    assert.deepEqual(plan.conflictingBlockIds, ['b2']);
    assert.equal(plan.blocked, false);
    assert.deepEqual(plan.regenerateRange, { start: 32, end: 40, tokenCount: 8 });
  });
});

describe('重复恢复', () => {
  it('重复事件 ID 被幂等抑制，不重复改变状态', () => {
    const session = new RecoverySession(baseInput);
    const event = { eventId: 'ev-same', type: EVENT_TYPES.FAILOVER, newNodeOffset: 16 };

    const first = session.applyEvent(event);
    assert.equal(first.suppressed, false);
    assert.equal(first.plan.duplicatePrefix.tokenCount, 8);

    const second = session.applyEvent({ ...event });
    assert.equal(second.suppressed, true);
    assert.equal(second.reason, 'duplicate_event');
    assert.equal(session.appliedEvents.length, 1);
    assert.equal(second.plan.duplicatePrefix.tokenCount, 8);
  });

  it('后续故障转移使用正确偏移后，重复前缀诊断消失', () => {
    const session = new RecoverySession(baseInput);
    session.applyEvent({ eventId: 'ev-1', type: EVENT_TYPES.FAILOVER, newNodeOffset: 16 });
    const healed = session.applyEvent({
      eventId: 'ev-2',
      type: EVENT_TYPES.FAILOVER,
      newNodeOffset: 24,
    }).plan;

    assert.equal(healed.duplicatePrefix, null);
    assert.equal(healed.recoveryPosition, 24);
  });
});

describe('偏移与确认不变量', () => {
  it('新节点偏移落后确认位置时输出重复前缀，且恢复位置不得低于确认位置', () => {
    const plan = computeRecoveryPlan({
      ...baseInput,
      events: [{ eventId: 'ev-1', type: EVENT_TYPES.FAILOVER, newNodeOffset: 10 }],
    });

    assert.deepEqual(plan.duplicatePrefix, { start: 10, end: 24, tokenCount: 14 });
    assert.ok(plan.recoveryPosition >= plan.clientAckTokens);
    if (plan.redeliverRange) {
      assert.ok(plan.redeliverRange.start >= plan.clientAckTokens);
    }
  });

  it('新节点偏移超前已输出位置时报告 offsetGap', () => {
    const plan = computeRecoveryPlan({
      ...baseInput,
      events: [{ eventId: 'ev-1', type: EVENT_TYPES.FAILOVER, newNodeOffset: 55 }],
    });

    assert.deepEqual(plan.offsetGap, { start: 40, end: 55, tokenCount: 15 });
    assert.equal(plan.duplicatePrefix, null);
  });

  it('ACK 超过已输出 token 数时被钳制', () => {
    const plan = computeRecoveryPlan({
      ...baseInput,
      clientAck: { ackedTokens: 999, connected: true },
    });
    assert.equal(plan.clientAckTokens, 40);
    assert.equal(plan.recoveryPosition, 40);
    assert.equal(plan.redeliverRange, null);
  });

  it('尚未输出任何 token 时从位置 0 恢复', () => {
    const plan = computeRecoveryPlan({
      requestId: 'req-empty',
      outputTokens: 0,
      blockRefs: [{ blockId: 'b0', tokenStart: 0, tokenEnd: 16, version: 1 }],
      migratedBlocks: [{ blockId: 'b0', version: 1, tokenEnd: 16 }],
      migrationStatus: MIGRATION_STATUS.COMPLETE,
      clientAck: { ackedTokens: 0, connected: true },
    });
    assert.equal(plan.status, 'ready');
    assert.equal(plan.recoveryPosition, 0);
    assert.equal(plan.redeliverRange, null);
    assert.equal(plan.regenerateRange, null);
  });
});
