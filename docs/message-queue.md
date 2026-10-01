# 统一发送与本地收件箱

## 使用

单条、批量和队伍发送共用 `zcode_send`；队伍只是可选 teamId 标签，不另建队列或成员表。

```javascript
zcode_send({ requestId: "review-round-1", taskIds: [taskA, taskB],
  teamId: "review-team", prompt: "请分别回传当前进展，不修改文件。" });
const page = zcode_read({ view: "inbox", teamId: "review-team" });
zcode_read({ view: "inbox", teamId: "review-team", cursor: page.cursor, waitMs: 30000 });
zcode_control({ action: "pause", scope: "all", expectedRevision: page.worker.controlRevision });
const paused = zcode_read({ view: "inbox" });
zcode_control({ action: "resume", scope: "all", expectedRevision: paused.worker.controlRevision });
```

taskA/taskB 必须为真实、经用户指定的任务 ID。重试同一发送沿用 requestId；正文、收件人、teamId 和 context 必须相同，否则拒绝。新消息使用新 ID。完整记录保留期间持续去重；正文清理后，整个请求所有收件人的精简记录至少再保留 7 天，之后才可一起过期。不要在去重记录过期后重放旧请求。
创建新任务时使用单个 `workspace: { path: "当前窗口中已连接的工作区路径", identity?: "稳定工作区身份" }` 替代 `taskIds`；两者必须恰好传一个。workspace 模式只创建一个任务并发送这条首消息，不公开空任务创建或批量创建。远程工作区须提供 identity。返回的 `targetAddress` 是稳定队列地址，不是任务 ID；仅收到创建 ACK 且持久绑定后才出现真实 `createdTaskId`。同 requestId 重试仍返回原 messageId/targetAddress，不另建任务。
收件箱可按 taskIds、teamId 或两者筛选；不传筛选读取全部队列记录。续读保持相同视图和过滤器，hasMore 时继续读。

发送先持久化，再按需启动后台，不等待模型答复。明确暂停后，新发送只入队；resume 才恢复。后台没有可处理消息时自行退出，下次发送再启动，不随 Codex 启动或系统开机运行。
启动请求不等于已运行：收件箱 worker.starting 表示已预留启动，running/heartbeat 表示实际存活，paused 表示用户暂停。启动预留在进程拉起前保存，过期启动者不能抢回所有权；恢复与退出交错时重新检查是否需要接班。
pause/resume 仍是所有 team 共用的控制，必须明确传 scope:"all" 和最近读到的 worker.controlRevision；旧版本号拒绝，不允许较早的恢复操作覆盖别人刚做的暂停。pause 允许在途请求收尾，不停止 ZCode 模型。

经 Agent Core 调用时，每个目标在原有 `messages[]` 结果内另带一个经 Core 校验的 `messageReceipt`。`deliveryId` 是持久消息 ID，同一 `requestId` 去重重试保持不变；`ownerId` 由规范化队列路径的 SHA-256 派生，并在 schema 7 的 `queue_owner` 单行中持久校验，不接受 sourceAgent、registrationId、PID 或调用方标签冒充。`owner.accepted` 只证明 SQLite 行已耐久写入；`provider` 初始为 `unknown`，worker 已启动、RPC/Sharing Link 可达或 ZCode 回显都不提升为供应商接收或业务完成。批量只返回逐目标事实，不承诺跨 owner 原子性；未知投递仍不重放。

## 顺序与状态

### 实例与输出目录准入

有独占输出的派发应声明 `context: { instanceId: "audit-r4", writeRoot: "E:/audits/audit-r4" }`。也兼容提示词里的显式 `identity={instanceId:"audit-r4"}`、`identity.instanceId="audit-r4"`、JSON 字段及 `writeRoot=...`；有空格的值须加引号，Windows 路径推荐正斜线。多处声明必须一致，无法解析或相对目录拒绝；只提到旧实例、`pairedPrimaryInstanceId` 或 writeRoot 的说明文字不构成声明。

任一声明与另一条保留消息重复都会报 `DUPLICATE_ASSIGNMENT`，包括不同会话/team、已完成、已释放或已取消的记录；更换 requestId 或 session 不能绕过。必须为新派发使用未占用的 instanceId 和 writeRoot。同 requestId/内容/收件人的正常重试仍返回原回执；含声明的请求只允许一个目标，批量任务各自使用独立声明。

检查在入队事务和发送前的 claim 事务内执行。历史积压若已与后来的 fallback 冲突，释放旧 FIFO 队头也不会把它发出去：该消息转 needs_attention，记录 assignment_blocked 事件，收件箱返回 duplicate_assignment 及冲突 messageId；保留原正文和事件，不取消、不重发、不改 campaign 文件。Windows 路径比较归一化大小写、分隔符、点段和末尾分隔符。

声明随 schema 6 升级从仍有正文的旧记录回补，存于独立字段，正文清理后继续保留至原去重记录过期。升级不删除原消息和事件；旧网关不能继续写入新版数据库。保护范围是同一队列库里的显式声明，不是文件系统写隔离：不扫描目录、解析符号链接别名或识别未声明的写入；升级前已清掉正文的声明无法追溯重建。

- 同任务跨队伍共享 FIFO；关联回复读完且原生 completed 后，下一条才发送。先读快照、再刷新原生状态；候选完成时再次读取快照和状态，尾部、消息数及更新时间一致且无待处理输入才给出 completionConfirmed。原生 UI 仍不提供与发送原子绑定的状态锁。
- 不同任务不等待彼此的模型回复；每轮最多 8 个任务，单连接内快照最多 4 并发，跨工作区依次重连。批量快照失败时，每个受影响任务用新连接和原游标独立核验一次，仍要求完整回复与稳定原生终态；单任务核验再次失败则返回错误，不重试发送。隔离恢复会增加这一轮的读取耗时，但不等待各模型依次完成。
- 正常调度每轮先对选中的 `queued` 队首执行发送前检查，再采集其他已派发回合的回复，避免空闲目标等完整个慢速观察批次；共享限流恢复期间保留先观察、按轮转顺序派发，防止新消息抢占重试槽。`retry_wait` 始终先核对迟到回复与外部输入。原生状态准入、FIFO 与去重不变。新消息可能错过已选定轮次，连接排队与远端请求仍有耗时，不保证即时派发。
- 使用同一配置目录/数据库的多个新版插件进程，通过 SQLite 内的顺序票据争用远程连接，不再各自遇锁立即失败。最多 128 个待连接调用，每次等候最多 30 秒，超时尚未开始远程动作；崩溃进程的票据自动回收。模型等待不持有连接。数据库重试仅限本地已回滚的事务，不重试未知发送。不要为同一 Sharing Link 另复制一套独立数据库。
- 没有单独的 team 数量上限或“一次只运行一个 team”的限制。按 taskId 而非 team 公平轮转：12 个 team 各有一个任务，可以分两轮派发，不用等前 8 个完成。100 条待解决消息是全局容量，不是每个 team 各 100 条。单物理连接的发送请求仍顺序执行；模型回合可重叠，实际模型并发受 ZCode/供应商限制。12 team 为确定性调度测试，不是 12 个实机模型并发验收。
- queued=持久化；dispatching=进入可能发送阶段；acknowledged=发送获回执；uncertain=回执不明；completed=关联回复读完且原生回合结束，不等于业务验收。
- workspace 创建在同一消息行中先记 `create_state=pending`；本地 list/bridge 预检失败仍为 queued。创建效果调用前持久写 `started`；此后结果未知或崩溃转 `needs_attention/create_unknown`，绝不自动再建。原生明确拒绝为 `create_failed`，不能伪造任务 ID。创建 ACK 在一个事务中绑定真实 `sess_*`、转 `created/queued`，首发随后才可开始；已绑定而发送尚未开始可重开续发。发送效果开始后结果未知沿用 `uncertain` 和只读 marker 对账，不重放。两种 needs_attention 均保留人工核对与 release 的空间。
- needs_attention 表示历史缺口、竞争输入、归档或失败终态等，只阻塞该任务的后续发送。
- 发送回执、inbox 的 envelopes/messages 都提供 `blockedReason`、`blockedByMessageId`、`blockedByState`；`same_task_fifo` 表示被更早的同 task 消息挡住，`duplicate_assignment` 表示实例/输出目录冲突，`invalid_assignment_declaration` 表示旧声明无法解析。按新 team 过滤仍能看到另一 team 的阻塞消息 ID/状态，不带其正文；续读即使没有新事件，messages 仍返回当前阻塞信息。null 不代表已通过原生状态检查或全局冷却。
- 队伍仅汇总事件，不自动广播、不执行回复中的指令，不实现任务依赖图。

## 回传与人工控制

提示词前加 `[[zcode-ops:<messageId>]]` 传输标识，匹配原生 user 消息及同 turnIndex 的 assistant 正文，不要求模型输出特定备注。
ZCode 会重写发送的消息 ID，因此不能仅靠请求 ID 关联。旧 completed、用户回显、空助手消息或超时都不能证明本次完成。没有匹配标识时保持未确认，不猜测重发。
已匹配原生 user、同回合尾部 assistant 为空、且双快照确认原生 completed 时，旧投递转为 `needs_attention`，通过 `nativeExecutionFailure.reason="empty_response"` 明确报告空响应；游标已读过该空消息也能识别。它不算成功，不自动重发或释放历史队列。协调者核实时效与授权后，可对该消息显式 release，再由已有后续消息正常准入；分页未读完、待处理输入、回合不匹配及未确认终态均不作此判断。

发送前 SQLite 事务保存意图；崩溃后的 dispatching 转 uncertain，只观察、不重发。这不是远程 exactly-once 保证。发送前只读检查失败保持 queued；进入可能发送阶段后的错误不自动重试。

失败态接续复用原发送入口：队首 `queued` 消息本身已获授权，目标的上一回合为 `failed` 时可自动调用原生 `sendPrompt → sendText`，沿用当前模型并开启新回合，无需二次恢复授权或伪造 idle。准入在读取基线和发送前刷新状态时均检查；运行中、归档、取消/中断以及 pending inputs 仍阻止发送。已在 `uncertain/acknowledged/needs_attention` 的旧消息不重新变成 queued。无人值守协调者可在既有授权内核实失败结果、释放阻塞、派发一条新的有界恢复指令；不能因为结果不明而重放旧请求。

```javascript
zcode_control({ action: "cancel_message", messageId }); // 只取消未发项
zcode_control({ action: "release_message", messageId }); // 用户核对后释放阻塞，不证明完成、不重发
zcode_control({ action: "stop_task", taskId }); // 请求原生停止，不取消队列
```

若停止后不应再发队列消息，先 pause。UI 手工输入仍可能竞争；发送前复查空闲，检测竞争后阻塞，不声称跨 UI 原子互斥。
队列仍 requested 且未暂停时，release_message/cancel_message 解除队首后会按需唤醒 worker，继续处理既有后续消息；若启动失败，释放结果仍有效，回执附 startupError，使用 resume 恢复。明确 pause 或从未请求启动的队列不会因此启动。释放一个 needs_attention 队首需要使用 release_message，cancel_message 只适用于 queued。

会话重新分派时，`release_message` 也支持已审阅、确认不再执行的 `queued` 旧消息：它们转为 `released`，保留原 messageId、正文、关联信息及事件，仍遵循原有留存策略，不记取消或业务完成（回执 `businessAccepted: false`），也不会重发。先释放已过时的 queued 后续消息，再释放 needs_attention 队首，避免旧任务抢在新指令前执行；已进入 dispatching 的消息不能这样释放。原生 completed 不会自动释放 needs_attention，必须显式核对该消息及排队链。
默认网关已移除直接发送旁路；旧诊断网关不应参与正常队列操作。

## 上下文与接收确认

可选 context 随提示词传给 ZCode，也随收件箱的 envelopes 返回。支持 sourceAgent、sourceTaskId、sourceWorkspace、replyTo、goal、background、constraints、expectedReply、references，以及用于准入的 instanceId、writeRoot。它们是发送方声明，不是认证身份或新增权限；references 是文本引用，不自动读取附件或授予文件访问。

```javascript
zcode_send({ requestId: "review-2", taskIds: [taskId], teamId: "review-team",
  prompt: "请审阅引用的设计，仅回传意见。",
  context: { sourceAgent: "codex", sourceTaskId: "调用方真实任务ID",
    goal: "检查设计是否能按现有接口实现", constraints: "只读，不修改文件",
    expectedReply: "阻碍、证据、最小修正建议", references: ["双方可访问的计划路径"] } });
// 使用真实且稳定的调用任务 ID；每个独立接收者使用自己的 consumerId。
const consumerId = "调用方真实任务ID";
const result = zcode_read({ view: "inbox", taskIds: [taskId], consumerId });
// 用相同 consumerId 和返回游标继续读；receipt.complete 为 true 后才可确认。
zcode_control({ action: "acknowledge_message", messageId: envelope.messageId,
  consumerId, throughEvent: envelope.receipt.throughEvent });
```

envelopes 为版本 1：携带原始请求、来源声明、目标、team、创建时间、上下文、原生消息/回合映射、状态和 lastEvent；登记读取者时另附 receipt。结果仍是原生角色/正文分段，不把助手文字解析成授权。
只有 completed/released/cancelled 可确认。服务端保存每个 consumerId 连续实际返回的事件位置，throughEvent 必须同时匹配该位置和当前末事件；第一页提前确认、猜测尾部位置或跳过分页均拒绝。事件、envelopes 和读取进度在同一个短事务中处理。
每条记录最多登记 16 个读取者，全部已登记读取者分别确认后才允许清理；新读取者在清理前加入会撤销清理资格。不传 consumerId 只是旁观读取，不取得保留权，也不能确认。无法预先保护尚未登记的未来读取者。consumerId 是本机调用方声明，不是身份认证；不要共享或不断生成新 ID。
确认不表示业务验收；遗弃读取者不会自动超时删除其未确认结果，容量不足时明确回压。

## 容量与自动清理

- 全局最多 500 条完整往返记录；达到条数或字节压力时，按创建顺序清理最旧的“终态且显式确认接收”的提示词、context 与关联事件正文。保留短期消息 ID、请求指纹、回合映射和状态；不删除 ZCode 原生会话。
- 未发、运行中、结果不明以及完成但未确认的记录不自动清理。全部不可清理时拒绝新入队；回传采集到达容量时暂停 worker，保留旧游标和原状态，不伪造完成、不自动重发。清理空间并 resume 后继续读取；远端历史已缺失则仍报告 historyGap。
- 清理在入队、采集、接收确认时进行，无额外定时清理进程。过期清理后的旧游标通过全局 retention.throughEvent 保守报告 historyGap，可能包含其他 team 的清理；调用方须明确接受缺口再建立读取基线。
- 新部署的 Agent Core 共享预算总额为 200,000,000 字节，各 owner allocation 之和必须等于声明总额。显式旧 20,000,000 字节配置仍按原 allocation 读取，不自动改写或重新分配。ZCode 自身 `diskBytes=20,000,000`、`databaseBytes=9,000,000`、`workingBytes=7,000,000` 均未放大，独立于 Core 总额；实际准入取适用限制中更严格者。Core 路径必须先有该 owner 的共享预算分配；每次写事务在 `BEGIN IMMEDIATE` 取得同库跨进程写锁后重查，计入主库、`-journal`、`-wal`、`-shm`，并保守预留页面增长、完整 DELETE journal、扇区余量及后续状态/回执增长。后续增长承诺在锁内由所有非终态 durable messages 重新派生，每条 16 KB，并进入未来主库与回滚日志峰值；completed/released/cancelled 才释放承诺，去重请求不新增承诺。缺少预算、owner 未分配或峰值超额都返回明确字节差额且不新增消息。插件代码、外部附件、人工备份不计入；直接非 Core 路径继续使用本队列内部限制，但不声称占用了 Core 共享预算。因此 500 是条数上限，不保证装得下 500 条长回复。
- 使用 SQLite DELETE 回滚日志、FULL 同步、关闭 cache spilling、每连接设置 max_page_count，不使用无限增长的 WAL，不运行需要额外整库副本的 VACUUM。删除后空间供后续记录复用，文件不必立即缩小；secure_delete 清除释放页中的正文，但不是针对磁盘备份/底层介质的取证销毁保证。机制依据：[SQLite PRAGMA](https://www.sqlite.org/pragma.html#pragma_max_page_count)、[回滚日志机制](https://www.sqlite.org/lockingv3.html)。
- 超预算旧库不自动删除或压缩，保留原文件并拒绝迁移。限制覆盖新版插件正常独占管理的数据库；第三方绕过插件写同一文件不在保证范围内。

## 数据与资源

- 本机 config.json 同目录下的 messages.sqlite 保存提示词、回复和事件，运行时可能有 -journal；默认 CODEX_HOME/zcode-ops/，本机为 E:/Programming/IDE/.codex/zcode-ops/。不进入 Git 或安装包，不开放端口，不搬迁目录。
- schema 7 新增并校验稳定的 `queue_owner`；schema 8 在同一消息行增加 workspace 创建状态、真实任务绑定及首发 ID。旧库按既有迁移链保留消息、事件位置、暂停状态与 schema 6 分派声明。schema 3 没有按读取者记录的完整交付证明，因此未清理正文的旧确认会撤销，必须重新读完并确认；已经清理的正文不会伪造恢复。旧 worker 正在运行时拒绝迁移，先停止旧 worker。不必关闭 Codex 对话：可在当前任务内从已安装目录启动 `scripts/remote-call.mjs` 使用新版 MCP；但不能同时调用旧版远程锁和新版票据。安装清单与当前内置工具入口版本应分别核对。
- 新公开游标是绑定视图和过滤器的不透明字符串；旧内部数字游标不可直接传入，升级后重新读取建立基线。
- 待解决消息最多 100 条，单次最多 8 个任务，提示词最多 31,000 字符且提示词与 context 合计不超过 40,000 UTF-8 字节；context 不超过 8,000 字节，字段至多 2,048 字符，references 最多 10 项。超长请求明确拒绝，发送方应提供摘要及引用，不静默截断。
- 每任务每轮正文 3,000 字符；收件箱每页最多 100 事件，事件与关联 envelopes 共用约 64,000 字节预算，单个历史遗留超大事件仍允许完整返回。附带至多 100 条简短状态记录及容量统计；不是完整对话镜像。
- 有工作时每轮间隔 3 秒，另加请求及轮转时间，不保证 3 秒响应；无可处理工作退出。
- PID 检查保守；不自动抢占可能被复用的 PID。新版不创建 remote.lock，进程崩溃后在下次连接申请时回收票据。遗留旧锁仅在明确的所属 PID 已退出时清理；空文件、非法 PID 或可能仍存活的旧锁拒绝连接，要求核实。后台被外部强杀后，下次 send/resume 可恢复，不提供独立常驻保活服务。
- 后台只采集队列消息。纯只读监控使用 zcode_tasks/zcode_read，不启动后台；采集不需要 Codex 模型轮询，但新事件不主动唤醒 Codex。

## 验证

`npm run smoke` 覆盖 500 条轮换、未确认结果保护、UTF-8 字节限制、去重残留记录、schema-2 WAL/schema-3 真旧库迁移、超额事务回滚和日志计入峰值。并发回归另使用 4 个真实子进程执行 80 轮入队/读取及 12 次模拟远程访问，检查去重、互斥、崩溃回收、分页提前确认、多读取者保护、12 路启动预留、退出时恢复、旧状态与变化中的快照。共享连接故障回归验证健康任务完成对账后能派发下一条，而不可读任务不伪造完成、旧请求不重发。模拟远端不等于实机多模型并发验收。当前验证入口见 [README](../README.zh-CN.md#开发)。

## 限流自动恢复

确认归属于当前投递的原生 `rate_limited` 失败后，消息进入 `retry_wait`。后台自行等待至少 300 秒后重发原消息；智能体无需读秒或重新入队。每条消息最多自动重试 5 次（首次发送不计入），计数与时间存入 SQLite；ACK、助手文字、暂停/恢复和进程重启均不清零。第五次重试仍限流后进入 `needs_attention`，收件箱事件 `temporarily_blocked` 明确报告“本任务暂时堵塞”。通过 `zcode_read` 的 inbox/wait 获取，不会主动唤醒 Codex。

多个任务和 team 共用队列级冷却：任一确认限流都会推迟下一次发送，恢复期每 300 秒最多放行一条；正常读取与回复采集继续。最后一条恢复探测成功且没有待重试项后恢复普通调度。当前没有可靠的账户限额标识，因此不同账户也会被保守地一起降速。

冷却期间仍采集新消息。原回合恢复运行时转为等待回复，确认成功完成后结束投递，不再重发，历史计数保留。外部新输入接管对话时，旧重试进入 `released` 并报告 `retry_stopped`（不是业务验收），后续已授权消息可继续按 FIFO 和原生状态准入。历史缺口、归档或取消/中断仍需处理，不能猜测成功。重发前再次执行相同检查。

计数按单条投递消息隔离，不按 Codex/ZCode 对话累计。后续新消息使用新 `requestId`，从零计数，拥有自己的 5 次重试额度；只有冷却窗口在任务之间共享。重复提交同一 `requestId` 仍是原消息，不能借此清零。无法判断是否送达的传输错误不会自动重放；离线预检不会消耗发送次数。可以全局暂停或显式释放 `retry_wait` 消息，不会重置已用次数。旧版本已落为 `needs_attention` 的消息不会被追溯重发。升级到 SQLite schema 5 前需先停止旧 worker，保留原消息与回执。
