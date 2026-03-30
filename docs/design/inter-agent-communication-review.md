# 多 Agent 协作通讯系统设计评审意见

## 一、总体评价

该设计文档非常清晰且结构严谨。采用 **Mailbox（消息） + Artifact（外部制品存储）** 的通讯模式，是当前多 Agent 协作系统中最合理的架构之一。这种设计既解耦了控制流（Agent 可以自主决定何时回复、是否发起新线程），又有效地解决了上下文 Token 爆炸的问题（大文件落盘，按需读取）。

方案与现有的 Session、QueryQueue 和 Event 系统天然兼容（特别是将 Auto-resume 转化为普通的 Query 进入队列），极大地降低了实现复杂度和侵入性，是一个非常优秀且务实的设计。

---

## 二、架构亮点

1. **单 Session 机制**：将 Thread 和 Session 绑定，每个 Thread 中 Agent 拥有独立的上下文，这让多轮迭代时的长程记忆变得非常自然，无需额外拼接上下文。
2. **Lazy Session 初始化**：在扇出（Fan-out）和被动响应的场景下，仅在必要时才创建 Session，避免了不必要的资源浪费。
3. **Artifact 与 Message 分离**：有效避免多 Agent 协作时冗长的内容在各种 prompt 中互相复制粘贴导致 token 快速耗尽。
4. **无缝对接 QueryQueue**：复用了现有的排队调度机制，避免了引入新的复杂分布式任务调度器。

---

## 三、潜在风险与优化建议

在实际落地和生产环境中，该系统可能会面临一些边缘情况，以下是针对各模块的评审意见和建议：

### 1. 消息投递与可靠性 (Reliability)
- **风险**：消息状态定义了 `pending | delivered | failed`。如果消息送达目标 Agent 的 QueryQueue 后，该 Agent 在处理（Turn）过程中发生崩溃报错，该消息的状态已经回不去 `failed` 了。从对方视角看，消息已 `delivered` 但石沉大海。
- **建议**：明确消息被消费后的确认机制。如果 Turn 失败，应当有机制通知发送方（如由系统以 System Agent 的身份回复一条 Error 消息），或者将消息状态标记为处理失败并支持自动重试。

### 2. 死锁与超时机制 (Deadlocks & Timeouts)
- **风险**：Agent 互相等待，或者在多节点协作（比如 Master 等待 Creator，且 Creator 卡在等待外部 API 或用户输入）时，目前设计只有最大轮数（`maxTurns`）兜底，缺乏时间维度上的兜底。如果某 Agent 迟迟不回复，Thread 将永远处于 `active` 但停滞的状态。
- **建议**：在 Thread 配置中不仅要有 `maxTurns`，还应该引入 `timeout`（空闲超时机制）。当线程在设定时间（如 1 小时）内没有任何新活动时，可以将 Thread 状态置为 `stalled` 甚至系统自动发总结消息结束 Thread。

### 3. 上下文不断增长的风险 (Context Window Limits)
- **风险**：虽然大文件存在了 Artifact 里，但如果两个 Agent 讨论激烈（例如 10+ 个回合的 review），因为 Session 是复用的，历史 Message 会导致当前 Session 的 history 越来越长，依然有超 Token 的危险。
- **建议**：在构造 `buildThreadContext` 或组装 Session 历史记忆时，考虑引入基于轮次或 Token 余量的消息摘要（Summarization）机制或截断机制，以保证 Thread 的长期可持续性。

### 4. 制品并发冲突 (Artifact Concurrency)
- **风险**：如果通过 "broadcast" 触发多个 Agent 同时处理，且他们由于幻觉同时调用 `save_artifact` 写入同一个固定名字的制品（如 `report.md`），会出现覆盖问题。
- **建议**：
  - 规定只有制品的创建者才能覆写，或者引入乐观锁/版本号管理（如文档中示例的 `draft-v1.md`），建议在工具层面对重名覆盖进行告警或自动加上后缀（如 `report_copy.md`）。
  - 给 `save_artifact` 提供读取（read_artifact）工具链或者与现有的读文件 tool 统一抽象防范并发问题。

### 5. Thread 显式完成与释放 (Thread Termination)
- **风险**：当前设计是“Agent 判断工作完成时，不再调用 `send_message`，其 Session 自然进入 idle 状态”。这意味着系统只能通过长时间 idle 或 `maxTurns` 耗尽来判断 Thread 结束，不够显式。在复杂的层级 Thread 树（如附录中的示例）中，父级 Thread（如 Master）很难明确知道子 Thread 是否已经 100% 工作完毕。
- **建议**：可以在 `send_message` 或者独立的 tool 中引入显式的 `status` 汇报（如：`send_message(to="@master", content="...", mark_thread_completed=true)`），便于根节点的 Agent 感知任务分支的彻底终结。

### 6. Broadcast 的局限性
- **风险**：Broadccast 给所有 participant，在参与者较多时（>3）可能会引起“聊天室杂音”问题——所有 Agent 都会被唤醒（生成新的 Query），并且可能所有 Agent 都会尝试去回复，消耗大量计算资源且导致逻辑混乱。
- **建议**：
  - 在初期限制 Broadcast 的使用场景（或者对某些 Agent 禁用响应 Broadcast）。
  - 或者支持“订阅组”概念，而非一刀切的全部唤起分析。

---

## 四、API 与数据模型细节

- **`ThreadParticipant` 数据结构**：当前只记录了 `joinedAt`，建议增加 `lastActiveAt`，可以很好地帮助实现上述的超时监控。
- **发送附件的引用安全**：`send_message` 参数中有 `artifacts?: string[] // 文件名称列表`。如果是子线程发送来的文件，不同 Agent 内部名称可能重复，最好要求发送的是 `artifactId` 或者明确的绝对路径引用。

## 五、总结

**架构设计方向非常正确，且深入结合了 CodeCrab 现有特性。** 该设计只要在**超时处理**、**异常状态的向上冒泡（Error Bubble Up）**以及**显式的状态完结标记**上稍加补齐，就足以支撑复杂的生产级 Multi-Agent 协作场景。建议按照此方案予以实现，在后续迭代中根据实际观察再引入更复杂的死锁检测和摘要压缩机制。
