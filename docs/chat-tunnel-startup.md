# Chat Tunnel 启动

Windows 上使用仓库启动器，不再在启动命令里写死代理端口：

```powershell
node scripts/start-chat-tunnel.mjs <tunnel-client.exe路径> <原有profile名或YAML文件路径> <已授权read-config路径>
```

启动器依次验证进程/用户环境中的 HTTP(S) 代理、Windows 当前启用的手动代理，以及直连。使用无密钥的 OpenAI HTTPS 请求验证连接；不会调用模型。系统代理端口变化时下次启动重新读取，不扫描任意本机端口，也不修改系统或用户环境变量。

只将有效路由传给这次 Tunnel 进程。全部连接失败时不启动；启动时连通不等于 Tunnel 鉴权、云端会话或本地主机工具已经可用，还须检查真实调用。密钥复用进程环境或用户变量中的 `OPENAI_API_KEY`，不写入启动参数或诊断。

保留原 profile、Tunnel ID、读取范围和消息记录。profile 内不要另写固定代理，避免与自动探测冲突。此入口不替代原生 `tunnel-client`；以后应通过它启动，直接运行原生客户端不会执行探测。运行中切换端口不热迁移连接，需重新启动该 Tunnel；不重启 Codex 或其他应用。仅 PAC/WPAD、SOCKS 或带用户名密码的代理不由此启动器自动解析；无有效 HTTP(S) 代理时尝试直连，直连也失败则明确停止。

## 按需启动与故障恢复

在现有 registry 同目录放置本机 `chat-tunnel.json`，或显式设置
`AGENT_CORE_CHAT_TUNNEL_CONFIG`。此文件仅包含路径，不包含密钥：

```json
{
  "schemaVersion": 1,
  "client": "C:/existing/tunnel-client.exe",
  "profile": "C:/existing/profile.yaml",
  "launcher": "C:/mailbox/scripts/start-chat-tunnel.mjs",
  "readPolicy": "C:/existing/read-scope.json",
  "stateDir": "C:/existing/tunnel-runtime",
  "healthUrlFile": "C:/existing/health.url"
}
```

Core CLI 的 `discover/read/act`、Core MCP 的初始化及工具调用会按需确保一个后台
运行实例，不依赖临时 PTY，不创建登录自启或定时任务。缺少本机配置时保持原行为；
Tunnel 失败不阻止其他 Core 模块。相同配置的并发请求通过独占文件锁归并为一个实例。
停止只请求该启动代次退出，不按历史 PID 强杀进程。

```powershell
node modules/agent-core/src/cli.mjs chat ensure C:/existing/chat-tunnel.json
node modules/agent-core/src/cli.mjs chat status C:/existing/chat-tunnel.json
node modules/agent-core/src/cli.mjs chat stop C:/existing/chat-tunnel.json
```

守护进程对 Tunnel 异常退出进行最多四次启动尝试，间隔 1/2/4 秒；每次重新探测
当前代理。失败后停止自动尝试，下一次明确的本机需求可以重新启动。状态 JSON
区分启动、就绪、恢复、失败和停止，提供退出码、阶段、本机日志路径及健康检查命令；
不打印密钥、文件内容或消息正文。原生 `/readyz` 只证明 Tunnel 就绪，不证明 Codex
宿主或远端任务启动成功。恢复进程不重放任何消息。

缺运行密钥、读取本机设置失败、网络路由不可达分别保留明确错误原因；进程权限等
系统错误保留错误码。未知异常正文不外发，避免凭据泄露。若守护恰在旧锁回收的
短窗口内崩溃，保守保留 `recovery.lock`，状态命令明确提供排障提示；operator
确认锁 owner 已结束后才能移除该孤立锁，不自动删除未知锁或强杀进程。

远端 Chat 经仍在运行的 Tunnel 可继续调用；**本地执行通道和 Tunnel 全部停止时，
同一个 Tunnel 无法接收用于启动自己的请求**。这时需先由在线的本机执行通道调用
Core，或运行上述 `ensure`。没有额外云端唤醒服务。守护进程本身被结束后也依靠
下一次本机需求恢复，而不是承诺无人自动重生。

## 读取授权默认临时

桌面重启后的绑定由正式启动环境 `CODEX_APP_TOOLS_PIPE_PATH` 提供，Core 的 MCP
声明通过 `env_vars` 保留该字段。按需入口可在本机配置增加可选项：
`"hostBinding": {"module":"已接受的host-notifier.mjs绝对路径","dataDir":"原回传数据目录"}`。
Core 使用同一个共享连接器验证原 operator 身份及可信本机管道，只更新 pipePath；
不猜测其它管道、不读取进程内存，不修改 operator、读取授权或消息记录。
普通 CLI 没有桌面环境变量时，仍先验证已配置的宿主，不把缺少覆盖值误当离线。
旧管道失效而又没有可信新绑定时明确返回 `hostBinding.state=failed` 及具体错误码；
不猜管道、不以 Tunnel ready 冒充宿主恢复成功，也不阻塞其他 Core 模块。

在新的运行区间，私人委托连接可依据会话中本次明确授权调用
`select_codex_task(grantReadAccess:true)`。该操作只启用所选会话的临时读取，
不恢复旧会话名单或文件目录；同区间的明确授权可合并，永久模式不会由此启用。

默认 `grant` 将明确目录/任务范围绑定到本次守护运行区间。Tunnel 子进程异常恢复
不结束区间；守护停止或重新开始后旧授权立即失效，必须重新确认。没有日历过期票据，
旧 schema 1 配置也不会被默认为长期授权。

```powershell
'{"threadIds":["明确授权任务UUID"],"workspaceRoots":["C:/approved/workspace"]}' | node modules/agent-core/src/cli.mjs chat grant C:/existing/chat-tunnel.json
node modules/agent-core/src/cli.mjs chat revoke C:/existing/chat-tunnel.json
```

只有用户明确要求长期授权时，operator 才可使用同样范围输入执行
`chat grant-persistent`。长期模式保留到明确撤销/修改；该命令不提供给远端模型工具。
启动服务本身不续授旧范围，也不把“允许这次读取”改成长时访问。

Chat 会话目录通过本机已装 Codex 的原生 `thread/list` 补齐，显式使用
`modelProviders: []`，避免切换提供方后只看见新提供方会话。启动入口设置本机
`CODEX_CHAT_INVENTORY_EXECUTABLE` 与 `CODEX_CHAT_INVENTORY_HOME`，再合并桌面
列表及侧栏引用并去重；不读原始 transcript、不恢复或发送会话，不改变提供方
配置或历史记录。存储目录没有全局运行状态，相关条目返回 `status: null`；
桌面接口可提供状态的条目保留其原生状态。列表扩大不代表文字或文件读取范围扩大。
