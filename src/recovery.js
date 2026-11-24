const MIGRATION_STATUS = Object.freeze({
  IN_PROGRESS: 'in_progress',
  COMPLETE: 'complete',
});

const EVENT_TYPES = Object.freeze({
  FAILOVER: 'failover',
  ACK: 'ack',
  RECONNECT: 'reconnect',
});

const PLAN_STATUS = Object.freeze({
  READY: 'ready',
  AWAITING_RECONNECT: 'awaiting_reconnect',
  BLOCKED: 'blocked',
});

function requireNonNegativeInt(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${field} 必须是非负整数，实际收到: ${String(value)}`);
  }
  return value;
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${field} 必须是非空字符串`);
  }
  return value;
}

function normalizeBlockRefs(blockRefs) {
  if (!Array.isArray(blockRefs) || blockRefs.length === 0) {
    throw new TypeError('blockRefs 必须是非空数组');
  }
  const seen = new Set();
  const refs = blockRefs.map((ref) => {
    const blockId = requireString(ref?.blockId, 'blockRefs[].blockId');
    if (seen.has(blockId)) {
      throw new TypeError(`blockRefs 中存在重复 blockId: ${blockId}`);
    }
    seen.add(blockId);
    return {
      blockId,
      tokenStart: requireNonNegativeInt(ref.tokenStart, `blockRefs[${blockId}].tokenStart`),
      tokenEnd: requireNonNegativeInt(ref.tokenEnd, `blockRefs[${blockId}].tokenEnd`),
      version: requireNonNegativeInt(ref.version, `blockRefs[${blockId}].version`),
    };
  });
  for (const ref of refs) {
    if (ref.tokenEnd <= ref.tokenStart) {
      throw new TypeError(`块 ${ref.blockId} 的 tokenEnd 必须大于 tokenStart`);
    }
  }
  return refs.sort((a, b) => a.tokenStart - b.tokenStart);
}

function normalizeMigratedBlocks(migratedBlocks) {
  if (!Array.isArray(migratedBlocks)) {
    return new Map();
  }
  const map = new Map();
  const ambiguous = new Set();
  for (const block of migratedBlocks) {
    const blockId = requireString(block?.blockId, 'migratedBlocks[].blockId');
    const version = requireNonNegativeInt(block.version, `migratedBlocks[${blockId}].version`);
    const tokenEnd = requireNonNegativeInt(block.tokenEnd, `migratedBlocks[${blockId}].tokenEnd`);
    const existing = map.get(blockId);
    if (existing && existing.version !== version) {
      ambiguous.add(blockId);
    }
    map.set(blockId, { blockId, version, tokenEnd });
  }
  return { map, ambiguous };
}

export function normalizeRequest(input) {
  requireString(input?.requestId, 'requestId');
  const outputTokens = requireNonNegativeInt(input.outputTokens, 'outputTokens');
  const blockRefs = normalizeBlockRefs(input.blockRefs);
  const migrationStatus = input.migrationStatus === MIGRATION_STATUS.COMPLETE
    ? MIGRATION_STATUS.COMPLETE
    : MIGRATION_STATUS.IN_PROGRESS;
  const migrated = normalizeMigratedBlocks(input.migratedBlocks ?? []);
  const rawAck = requireNonNegativeInt(input.clientAck?.ackedTokens ?? 0, 'clientAck.ackedTokens');
  return {
    requestId: input.requestId,
    outputTokens,
    blockRefs,
    migrationStatus,
    migratedBlocks: migrated.map,
    ambiguousVersions: migrated.ambiguous,
    clientConnected: input.clientAck?.connected !== false,
    ackedTokens: Math.min(rawAck, outputTokens),
  };
}

function analyzeBlockChain(request) {
  const missingBlockIds = [];
  const conflictingBlockIds = [...request.ambiguousVersions];
  let cursor = 0;
  let chainBroken = false;

  for (const ref of request.blockRefs) {
    if (ref.tokenStart !== cursor) {
      chainBroken = true;
      break;
    }
    const migrated = request.migratedBlocks.get(ref.blockId);
    if (!migrated) {
      missingBlockIds.push(ref.blockId);
      if (request.migrationStatus === MIGRATION_STATUS.IN_PROGRESS) {
        break;
      }
      chainBroken = true;
      break;
    }
    if (migrated.version !== ref.version || request.ambiguousVersions.has(ref.blockId)) {
      conflictingBlockIds.push(ref.blockId);
      chainBroken = true;
      break;
    }
    cursor = ref.tokenEnd;
  }

  return {
    kvSafeEnd: cursor,
    chainBroken,
    missingBlockIds: [...new Set(missingBlockIds)],
    conflictingBlockIds: [...new Set(conflictingBlockIds)],
  };
}

function diagnoseOffset(newNodeOffset, ackedTokens, outputTokens) {
  if (!Number.isInteger(newNodeOffset)) {
    return null;
  }
  const diagnosis = {
    newNodeOffset,
    duplicatePrefix: null,
    offsetGap: null,
  };
  if (newNodeOffset < ackedTokens) {
    diagnosis.duplicatePrefix = {
      start: newNodeOffset,
      end: ackedTokens,
      tokenCount: ackedTokens - newNodeOffset,
    };
  } else if (newNodeOffset > outputTokens) {
    diagnosis.offsetGap = {
      start: outputTokens,
      end: newNodeOffset,
      tokenCount: newNodeOffset - outputTokens,
    };
  }
  return diagnosis;
}

function buildPlan(state, failover) {
  const chain = analyzeBlockChain(state);
  const { ackedTokens, outputTokens } = state;
  const blockedReasons = [];

  if (state.migrationStatus !== MIGRATION_STATUS.COMPLETE) {
    blockedReasons.push('migration_incomplete');
  }
  if (chain.missingBlockIds.length > 0) {
    blockedReasons.push('block_refs_incomplete');
  }
  if (chain.kvSafeEnd < ackedTokens) {
    blockedReasons.push('kv_prefix_incomplete');
  }

  const blocked = state.migrationStatus !== MIGRATION_STATUS.COMPLETE
    || chain.missingBlockIds.length > 0
    || chain.kvSafeEnd < ackedTokens;
  const offsetDiagnosis = diagnoseOffset(failover?.newNodeOffset, ackedTokens, outputTokens);

  const redeliverEnd = Math.min(chain.kvSafeEnd, outputTokens);
  const redeliverRange = redeliverEnd > ackedTokens
    ? { start: ackedTokens, end: redeliverEnd, tokenCount: redeliverEnd - ackedTokens }
    : null;

  const regenStart = Math.max(chain.kvSafeEnd, ackedTokens);
  const regenerateRange = regenStart < outputTokens
    ? { start: regenStart, end: outputTokens, tokenCount: outputTokens - regenStart }
    : null;

  const rebuildRange = chain.kvSafeEnd < ackedTokens
    ? { start: chain.kvSafeEnd, end: ackedTokens, tokenCount: ackedTokens - chain.kvSafeEnd }
    : null;

  let status = PLAN_STATUS.READY;
  if (blocked) {
    status = PLAN_STATUS.BLOCKED;
  } else if (!state.clientConnected) {
    status = PLAN_STATUS.AWAITING_RECONNECT;
  }

  return {
    requestId: state.requestId,
    status,
    blocked,
    blockedReasons,
    recoverable: !blocked,
    recoveryPosition: blocked ? null : ackedTokens,
    continueFrom: blocked ? null : outputTokens,
    outputTokens,
    clientAckTokens: ackedTokens,
    clientConnected: state.clientConnected,
    migrationStatus: state.migrationStatus,
    kvSafeEnd: chain.kvSafeEnd,
    missingBlockIds: chain.missingBlockIds,
    conflictingBlockIds: chain.conflictingBlockIds,
    duplicatePrefix: offsetDiagnosis?.duplicatePrefix ?? null,
    offsetGap: offsetDiagnosis?.offsetGap ?? null,
    rebuildKvRange: rebuildRange,
    redeliverRange,
    regenerateRange,
    deliveryBlocked: !blocked && !state.clientConnected,
    failoverEventId: failover?.eventId ?? null,
  };
}

export class RecoverySession {
  constructor(input) {
    const request = normalizeRequest(input);
    this.requestId = request.requestId;
    this.outputTokens = request.outputTokens;
    this.ackedTokens = request.ackedTokens;
    this.clientConnected = request.clientConnected;
    this.migrationStatus = request.migrationStatus;
    this.migratedBlocks = request.migratedBlocks;
    this.ambiguousVersions = request.ambiguousVersions;
    this.blockRefs = request.blockRefs;
    this.processedEventIds = new Set();
    this.appliedEvents = [];
    this.latestFailover = null;
  }

  plan() {
    return buildPlan(this, this.latestFailover);
  }

  applyEvent(event) {
    requireString(event?.eventId, 'event.eventId');
    if (this.processedEventIds.has(event.eventId)) {
      return {
        suppressed: true,
        reason: 'duplicate_event',
        eventId: event.eventId,
        plan: this.plan(),
      };
    }

    switch (event.type) {
      case EVENT_TYPES.FAILOVER: {
        if (Number.isInteger(event.newNodeOffset)) {
          requireNonNegativeInt(event.newNodeOffset, 'event.newNodeOffset');
        }
        if (event.migrationStatus === MIGRATION_STATUS.COMPLETE) {
          this.migrationStatus = MIGRATION_STATUS.COMPLETE;
        }
        if (Array.isArray(event.migratedBlocks)) {
          const migrated = normalizeMigratedBlocks(event.migratedBlocks);
          this.migratedBlocks = new Map([...this.migratedBlocks, ...migrated.map]);
          for (const blockId of migrated.ambiguous) {
            this.ambiguousVersions.add(blockId);
          }
        }
        this.latestFailover = {
          eventId: event.eventId,
          newNodeOffset: Number.isInteger(event.newNodeOffset) ? event.newNodeOffset : null,
        };
        break;
      }
      case EVENT_TYPES.ACK: {
        const nextAck = Math.min(
          requireNonNegativeInt(event.ackedTokens, 'event.ackedTokens'),
          this.outputTokens,
        );
        if (nextAck > this.ackedTokens) {
          this.ackedTokens = nextAck;
        }
        break;
      }
      case EVENT_TYPES.RECONNECT: {
        this.clientConnected = true;
        break;
      }
      default:
        throw new TypeError(`未知恢复事件类型: ${String(event.type)}`);
    }

    this.processedEventIds.add(event.eventId);
    this.appliedEvents.push(event.eventId);
    return { suppressed: false, eventId: event.eventId, plan: this.plan() };
  }
}

export function computeRecoveryPlan(input) {
  const session = new RecoverySession(input);
  let lastResult = { suppressed: false, eventId: null, plan: session.plan() };
  for (const event of input.events ?? []) {
    lastResult = session.applyEvent(event);
  }
  return lastResult.plan;
}

export { MIGRATION_STATUS, EVENT_TYPES, PLAN_STATUS };
