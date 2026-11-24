import { readFileSync } from 'node:fs';
import { computeRecoveryPlan } from './recovery.js';

const demoRequest = {
  requestId: 'req-demo-001',
  outputTokens: 40,
  blockRefs: [
    { blockId: 'b0', tokenStart: 0, tokenEnd: 16, version: 3 },
    { blockId: 'b1', tokenStart: 16, tokenEnd: 32, version: 3 },
    { blockId: 'b2', tokenStart: 32, tokenEnd: 48, version: 2 },
  ],
  migratedBlocks: [
    { blockId: 'b0', version: 3, tokenEnd: 16 },
    { blockId: 'b1', version: 3, tokenEnd: 32 },
    { blockId: 'b2', version: 2, tokenEnd: 48 },
  ],
  migrationStatus: 'complete',
  clientAck: { ackedTokens: 24, connected: true },
  events: [
    { eventId: 'ev-failover-1', type: 'failover', newNodeOffset: 16 },
  ],
};

function printPlan(plan) {
  console.log(JSON.stringify(plan, null, 2));
  if (plan.duplicatePrefix) {
    const d = plan.duplicatePrefix;
    console.warn(
      `[告警] 新节点偏移 ${d.start} 落后于客户端确认偏移 ${d.end}，` +
        `重复前缀 token [${d.start}, ${d.end}) 共 ${d.tokenCount} 个，禁止重复发送。`,
    );
  }
  if (plan.blocked) {
    console.warn(`[阻断] 请求 ${plan.requestId} 无法继续生成，原因: ${plan.blockedReasons.join(', ')}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--demo')) {
    printPlan(computeRecoveryPlan(demoRequest));
    return;
  }
  const fileIndex = args.findIndex((arg) => arg === '--input') + 1;
  if (fileIndex === 0) {
    console.error('用法: node src/cli.js --input <request.json> | --demo');
    process.exitCode = 2;
    return;
  }
  const input = JSON.parse(readFileSync(args[fileIndex], 'utf8'));
  printPlan(computeRecoveryPlan(input));
}

main();
