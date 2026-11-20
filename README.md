# magpie-duckai-bridge

把 [duck.ai](https://duck.ai) 的免费模型变成 OpenAI 兼容服务，供 [Magpie](https://github.com/nousresearch/magpie) 网关及其下游 Agent（Hermes / WorkBuddy / Claude Code / Codex 等）直接调用。

## 状态：可用，但有两个硬前提

- ✅ **能调通**：经 Magpie 网关实测多个模型返回真实回复
- ⚠️ **延迟不稳**：duck.ai 的反爬机制会导致偶发 418 重试，单次请求 1～49 秒波动。**靠 Agent 超时设 60s+ 兜底**，不是生产级稳定
- 🌏 **需要能访问 duck.ai 的网络**：duck.ai 对中国大陆 IP 直接返回 451。本项目默认走本机代理 `http://127.0.0.1:29758`，你需要改成自己的代理或直连环境

## 原理

duck.ai 没有公开 API，但网页端有一个私有 SSE 接口。本桥接逆向了它的调用流程：

1. `GET /duckchat/v1/status` 拿一个 base64 编码的 JS 反爬挑战（`x-vqd-hash-1`）
2. 用 **jsdom** 模拟真实浏览器 iframe 执行挑战，算出 `client_hashes`，构造响应头
3. `POST /duckchat/v1/chat`（带解出的 hash）拿到 SSE 流式回复
4. 转换成标准 OpenAI `/v1/chat/completions` 格式

关键处理：
- **418 重试**：每次重新获取并重解挑战（复用旧 hash 无效）
- **role 转换**：duck.ai 只接受 user/assistant；system/developer/tool 消息转成 user 文本前缀（否则 Codex 400）
- **并发锁**：串行化请求，避免并发解挑战互相触发 418
- **模型名前缀**：只剥 `duck-ai/` 第一段，保留 `tinfoil/xxx` 这种含斜杠的模型名

参考实现：[cobbdzon/duckai](https://github.com/cobbdzon/duckai)（getEncodedVqdHash 算法来源）

## 可用模型（实测）

### ✅ 能用（5 个）

| 模型 id | 说明 |
|---|---|
| `gpt-5.4-mini` | GPT-5.4 mini（快）|
| `mistral-small-2603` | Mistral Small 4（最快）|
| `gpt-6-luna` | GPT-6 Luna |
| `claude-haiku-5-5` | Claude Haiku 5.5 |
| `tinfoil/gemma4-31b` | Gemma 4 31B |

### ❌ 标 free 但实测不可用

- `tinfoil/gpt-oss-120b` — duck.ai 后端对该模型有特殊要求，稳定 400

### 🔒 付费模型（匿名账号 404）

`gpt-5.6-terra`、`gpt-5.6-sol`、`claude-sonnet-5-5`、`claude-opus-5-5`

> 模型清单和权限来自 `GET /duckchat/v1/models` 的 `accessTier` 字段，会随 duck.ai 更新变化，以实测为准。

## 安装

```bash
npm install          # 依赖: jsdom + undici
```

## 启动

```bash
# Windows: 双击 start.bat（分离式启动，避免终端关闭导致服务退出）
# 或手动：
node server.mjs      # 监听 http://127.0.0.1:3426
```

bridge 暴露：
- `GET /health` — 健康检查
- `GET /v1/models` — 模型列表
- `POST /v1/chat/completions` — 聊天（支持 stream）

## 接入 Magpie

```bash
magpie provider add duckai name="Duck.ai" chat="http://127.0.0.1:3426/v1" key="dummy"
```

 Magpie 会自动抓取 10 个模型，之后用 `duck-ai/<模型id>` 调用：

```bash
curl http://127.0.0.1:3425/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"duck-ai/gpt-5.4-mini","messages":[{"role":"user","content":"hi"}]}'
```

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DUCKAI_PORT` | `3426` | 监听端口 |
| `DUCKAI_PROXY` | `http://127.0.0.1:29758` | 代理地址；直连环境可设为 `''` 或修改代码里的 ProxyAgent |
| `DUCKAI_UA` | Chrome 138 UA | User-Agent |
| `DUCKAI_VQD_STACK` | 内置 | 反爬 stack；若持续 418，从浏览器 DevTools `new Error().stack` 抓当前值填入 |
| `DUCKAI_BUDGET_MS` | `18000` | 单次请求总预算（毫秒）；长输出可调大，但增加 Agent 超时风险 |
| `DUCKAI_FETCH_TIMEOUT_MS` | `10000` | 单次上游 fetch 超时（毫秒） |

## ⚠️ token 限制（实测，与官方 API 不同）

**不要引用 OpenAI 官方 API 的规格**（1M 上下文 / 64K 输出）。本项目走的是 duck.ai 免费网页接口，限制完全不同：

- **不接受 `max_tokens` 参数**：实测 4096～128000 全部返回 `400 ERR_BAD_REQUEST`。输出长度由 duck.ai 自己决定，bridge 会忽略 Agent 传来的 max_tokens。
- **输入上限约 18000-20000 字符（中文≈9000-18000 token，二分法实测）**：18000 字符正常，20000 字符报 `ERR_INPUT_LIMIT`，128000 字符报 `ERR_CONVERSATION_LIMIT`。
- duck.ai 模型目录里**没有任何 token 限制字段**，官方数字不适用于此链路。

## ⚠️ 已知限制

1. **VQD stack 会过期**：duck.ai 更新前端 bundle 后，内置 stack 失效会导致持续 418。需从真实浏览器抓新值。
2. **延迟波动**：反爬重试导致偶发慢请求，bridge 有 18s 硬预算（Agent 超时建议 60s+）。可用 `DUCKAI_BUDGET_MS` / `DUCKAI_FETCH_TIMEOUT_MS` 调整，但调大会增加 Agent 超时风险。
3. **依赖代理**：直连被 451 封锁的地区必须配代理。
4. **非官方**：逆向私有接口，duck.ai 随时可能改协议导致失效。仅供研究/个人使用。

## License

MIT
