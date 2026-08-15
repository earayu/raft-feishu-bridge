# 飞书出站敏感字段过滤清单

> 适用范围：所有经飞书（Feishu/Lark）出站的内容，包括 `send.mjs` / `feishu-send.mjs` / `send-image.mjs` / `send-file.mjs` / `feishu-command.mjs` 以及任何把本机内容转发到飞书群的通道。
> 目标：凡能帮助识别本机资产、私密凭据或具体会话的内容，在出站前一律剥离或降敏。

## 核心口径

**判定标准不是消息长短，而是「是否帮助识别本机资产 / 凭据 / 具体会话」。**
凡满足以下任一条件即应降敏（打码 / 剥离 / 留在飞书外）：

1. 直接包含敏感形态（见下方分类）。
2. **多个非敏感片段组合起来能定位到本机资产或具体会话**（例如单独的 `chat_id` 或 `message_id` 可保留，但 `chat_id + message_id + 时间 + 内容` 组合能唯一定位某次私有会话时，需整体降敏）。

拿不准时，宁可不发，保留在 Slock 侧由相关 agent 内部分析，回飞书只给结论不给定址。

## 敏感形态分类

### 1. 本机绝对路径 / 文件系统

- 形态：`/Users/xxx/...`、`/var/...`、`/etc/...`、`/private/tmp/...`、`C:\...`、`.ssh/`、`.config/`、`.aws/` 等。
- 检查：先匹配整段绝对路径再整体替换，避免逐段残留。示例：`(/[A-Za-z0-9_\-.:]+){2,}`，或锚定起始段 `(/(Users|var|etc|home|private|root|opt|srv)\b)` 后向前吃到路径结束符（空格/标点）。
- 处置：整段绝对路径替换为 `<REDACTED_PATH>`；不要只换首段（否则 `/Users/admin/.slock/...` 会残留 `/admin/...`）。

### 2. 网络地址 / 主机

- 形态：内网 IPv4/IPv6、`localhost`、`127.0.0.1`、`10.x`、`172.16-31.x`、`192.168.x`、出口 IP、主机名/hostname（如 `admindeAir`）、容器/集群内部 DNS。
- 检查：`\b(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|127\.|0\.0\.0\.0|localhost|::1)\b` 及裸主机名。
- 处置：替换为 `<REDACTED_IP>` / `<REDACTED_HOST>`。

### 3. 凭据 / 密钥 / 令牌

- 形态：`app_secret`、`app_id`(`cli_...`)、`sk_...`、`sk_machine_...`、`ghp_...`、`ghs_...`、JWT(`eyJ...`)、AWS `AKIA...`、`-----BEGIN ... PRIVATE KEY-----`、OAuth token、`SLOCK_AGENT_TOKEN`、任何 key=长乱串。
- 检查：`\b(sk_|ghp_|ghs_|gho_|AKIA|eyJ|cli_|sk-)[A-Za-z0-9_\-]{8,}\b` 及 `PRIVATE KEY`。
- 处置：不保留任何片段，整体 `<REDACTED_CREDENTIAL>`。

### 4. 机器指纹 / 设备标识

- 形态：`machine id`、`machine_id`、`sk_machine_...`、设备 UUID、网卡 MAC、硬件序列号。
- 检查：`(machine[_ -]?id|MAC|serial)\s*[:=]?,?` 
- 处置：整体 `<REDACTED_DEVICE>`。

### 5. 私有账号 / 用户标识

- 形态：内部 OpenID（`ou_...`）、私有手机号/邮箱、内部工号、客户专有身份。
- 检查：`ou_[A-Za-z0-9]{20,}`、客服内部账号。
- 处置：替换为 `<REDACTED_UID>` 或匿名代称。

### 6. 会话定位组合

- 形态：`chat_id`（`oc_...`）、`message_id`（`om_...`）、`file_key`（`img_...`）、时间戳 + 群名。
- 检查：`\b(oc_|om_|img_|file_)[A-Za-z0-9]{8,}\b`
- 处置：单独 `message_id` 可作为回复锚点保留；一旦与 `chat_id` / 时间 / 原文组合能定位到私有会话，需整体降敏为 `<REDACTED_MSG>` 或只保留必要锚点。

## 落地建议

- 在转发入口做一次「跑清单」：把正文按上面的正则/人工检查扫一遍，命中即打码。
- 图形/附件同理：图片 OCR 含上述形态时也需打码，或只发结论比发原文。
- 不能确定是否含敏感形态的，走「宁可不发」分支，交由内部分析。

## 验证

对任一示例文本（含路径/IP/token/chat_id 组合），按上面分类跑一次判定，确认所有 `${REDACTED}` 替换符合预期、无遗留原始片段后再出站。
