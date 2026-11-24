# inference-kv-block-migration-validator

推理节点故障后的 **KV 块迁移校验与恢复位置计算** 工具（Node.js 24.16.0，零依赖）。

## 模拟声明

本项目中的 **所有 KV 块、块引用、块版本、迁移状态、客户端确认和恢复事件均为内存模拟**，
不连接任何真实推理引擎、KV cache 存储或网络服务。所有数据来自调用方传入的 JSON。

## 背景

推理节点故障后，请求的 KV 块迁移到备用节点，但新节点的输出 token 偏移和块版本可能没有同步：

- 新节点从错误的 token 位置继续生成 → 客户端收到已确认 token 的重复前缀；
- 块引用未完整迁移或版本冲突 → 在残缺 KV 上继续生成会产生错误输出。

本工具根据输入计算安全恢复位置，并给出重复前缀与需重新生成的 token 范围。

## 输入字段

| 字段 | 含义 |
| --- | --- |
| `requestId` | 请求 ID |
| `outputTokens` | 已输出 token 数量 |
| `blockRefs` | 块引用列表：`blockId` / `tokenStart` / `tokenEnd` / `version`，必须从 0 连续覆盖 |
| `migratedBlocks` | 已迁移到新节点的块：`blockId` / `version` / `tokenEnd` |
| `migrationStatus` | 迁移状态：`in_progress` 或 `complete` |
| `clientAck` | 客户端确认：`ackedTokens`（已确认输出数）与 `connected`（连接状态） |
| `events` | 恢复事件列表：`failover` / `ack` / `reconnect`，每个事件带唯一 `eventId` |

`failover` 事件可携带 `newNodeOffset`（新节点自认为的输出偏移）、增量 `migratedBlocks`
和新的 `migrationStatus`。

## 恢复规则
1. 沿 `blockRefs` 从 token 0 校验迁移块是否存在、版本是否匹配，得到连续可用的
   `kvSafeEnd`；缺失块或版本冲突处即 KV 覆盖终点。
2. **硬阻断**（`blocked: true`，禁止继续生成）：
   - 迁移未完成（`migration_incomplete`）；
   - 块引用未完整迁移（`block_refs_incomplete`）；
   - 连续 KV 覆盖不到客户端确认位置（`kv_prefix_incomplete`），此时给出 `rebuildKvRange`。
3. 版本冲突若全部落在确认位置之后则不阻断，冲突区间计入 `regenerateRange` 重新生成。
4. 恢复位置 `recoveryPosition` 恒等于客户端确认位置：**已确认输出不会重复发送**；
   确认之后、KV 仍覆盖的已生成 token 放入 `redeliverRange`（至少一次重投，非重复确认前缀）；
   KV 未覆盖的已生成 token 放入 `regenerateRange` 重新生成。
5. `newNodeOffset < ackedTokens` 时输出 `duplicatePrefix`（重复前缀范围），并告警禁止重发；
   `newNodeOffset > outputTokens` 时输出 `offsetGap`。
6. 客户端断线时状态为 `awaiting_reconnect`，恢复位置照常计算但 `deliveryBlocked: true`，
   收到 `reconnect` 事件后恢复投递。
7. 重复 `eventId` 被幂等抑制（`suppressed: true`，原因 `duplicate_event`），不改变会话状态。

## 输出字段（摘要）

| 字段 | 含义 |
| --- | --- |
| `status` | `ready` / `awaiting_reconnect` / `blocked` |
| `recoverable` | 是否可恢复 |
| `recoveryPosition` | 恢复生成的 token 位置（阻断时为 `null`） |
| `continueFrom` | 重投/重生成完成后继续新生成的位置 |
| `kvSafeEnd` | 连续、版本一致的 KV 覆盖终点 |
| `duplicatePrefix` | 重复前缀 token 范围，已确认部分禁止重发 |
| `redeliverRange` | 未确认但 KV 可复用、需重新投递的 token 范围 |
| `regenerateRange` | KV 不可用、需重新生成的 token 范围 |
| `rebuildKvRange` | 确认前缀缺失、需重建 KV 的 token 范围 |
| `missingBlockIds` / `conflictingBlockIds` | 缺失 / 版本冲突的块 |

## 使用方式

```bash
node --test                      # 运行全部测试
node src/cli.js --demo           # 内置模拟场景
node src/cli.js --input examples/request.sample.json
```

编程调用：

```js
import { computeRecoveryPlan, RecoverySession } from './src/recovery.js';

const plan = computeRecoveryPlan(request);          // 一次性计算
const session = new RecoverySession(request);       // 多事件增量恢复
session.applyEvent({ eventId: 'ev-1', type: 'failover', newNodeOffset: 16 });
```

## 测试覆盖

`test/recovery.test.js` 使用内置 `node:test`，覆盖：

- 迁移中断（块未迁完时阻断，补齐后恢复）；
- 客户端断线（交付挂起、重连恢复、断线 ACK）；
- 块冲突（确认前缀内冲突阻断、确认后冲突重生成、同块多版本歧义）；
- 重复恢复（事件幂等、偏移修正后重复前缀消失）；
- 偏移与确认不变量（重复前缀、偏移超前、ACK 钳制、零输出）。
