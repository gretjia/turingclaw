# 🦾 TuringClaw: The True Turing Kernel

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Gemini](https://img.shields.io/badge/Google%20Gemini-8E75B2?style=for-the-badge&logo=google&logoColor=white)

TuringClaw 是一个基于“图灵机物理纸带”哲学的原生 AI Agent 引擎。它抛弃了传统大模型应用中脆弱的“上下文数组”和“隐式记忆”，将所有思考、动作、记忆和环境反馈，全部具象化为一条物理可见的 **TAPE.md (纸带)**。

通过引入 **视界投影 (绝对行号)** 和 **物理擦除 (The Rubber)** 机制，TuringClaw 彻底解决了大模型“行号盲”和“上下文无限膨胀”的致命缺陷，实现了一个可以无限期运行、自我修剪、自我进化的 True Turing Kernel。

---

## 📘 Bible 白皮书 (Staff-Level Audit Summary)

本白皮书是对 TuringClaw 架构 Bible 的工程化落地摘要。目标不是“更花哨”，而是“更可存活”。

### 1. 核心宣言
1. `TAPE.md` 是唯一会话状态源（Single Source of Truth）。
2. 引擎内部不维护隐藏历史数组，不依赖隐式上下文。
3. 一切动作必须通过显式协议标签执行：`<EXEC>`, `<ERASE>`, `<ASSERT_DONE>`, `<DONE>`。
4. 系统必须支持物理可审计、可中断恢复、可追责。

### 2. 致命缺陷与修正法则
1. **Rubber Blindness（行号盲）**  
修正：读取纸带时动态注入绝对行号（Vision Projection），模型只能对坐标下刀。
2. **Fragile Pencil（脆弱解析）**  
修正：放弃属性型单行指令，强制块级 `<EXEC>...</EXEC>` 并使用跨行解析。
3. **Painless Discipline（无痛纪律）**  
修正：执行输出硬截断 + 三振熔断，避免 stdout 爆炸与无限复读烧 token。

### 3. 采纳与去除清单
1. **已采纳**：Vision Projection、Block-level EXEC、Rubber Scar、Hard Truncation、3-Strikes、Immutable ROM、ASSERT_DONE、Stagnation Loop Detection。
2. **已去除**：WebSocket/UI 运行依赖、隐式用户消息状态、`MEMORIZE/RECALL` 会话旁路。
3. **保留**：`TURING_MAX_TURNS_PER_RUN` 作为硬预算上限，防止无限循环造成 token 失控。

### 4. 运行准则
1. 默认单线程循环，先稳定再并行。
2. 先保证“可解释与可审计”，再追求“多 agent 吞吐”。
3. 任何高风险动作必须走显式审批 token。

---

## 🌌 核心哲学 (Core Philosophy)

TuringClaw 赋予了 AI 四种基础物理能力：
1. **The Tape (纸带)**：一切皆文件。没有隐藏的 API 状态，所有的对话、思考、系统报错都在 `workspace/TAPE.md` 上公开透明。
2. **The Pencil (铅笔)**：通过 `<EXEC>...</EXEC>` 块级标签，AI 可以自由编写并执行 Bash 或 Python 脚本，直接与宿主机操作系统交互。
3. **The Rubber (橡皮)**：通过 `<ERASE start="x" end="y" />` 标签，AI 能够根据绝对行号物理擦除纸带上的冗余信息，实现主动的上下文修剪（Context Pruning）。
4. **The Discipline (纪律)**：通过输出截断、执行策略、纸带共振防复读与三振熔断机制，AI 在失控前会被硬性制动。
5. **Immutable ROM (创世区块)**：纸带前 N 行（默认 15）为不可擦除目标区，防止目标漂移。
6. **ASSERT_DONE (举证完成)**：通过 `<ASSERT_DONE proof_cmd="..." />` 提交物理证据，系统只认 Exit Code（`0` 通过）。

---

## 📂 项目拓扑 (Project Topology)

```text
turingclaw/
├── workspace/               # 🧠 物理工作区 (AI 的大脑与手脚)
│   ├── TAPE.md              # 核心物理纸带 (所有上下文都在这里)
│   ├── memory/              # 运行辅助配置目录 (非会话记忆)
│   └── skills/              # 技能库 (AI 编写的 Python/Bash 脚本)
│       └── remote_mgr.py    # 预置技能：SSH 远程主机控制器
├── server/                  # ⚙️ 后端引擎 (True Turing Kernel)
│   └── engine.ts            # 核心引擎逻辑 (解析器、沙盒、大模型驱动)
├── tests/                   # 🧪 测试套件
│   └── simulate_openclaw.ts # OpenClaw 核心能力模拟测试
├── cli.ts                   # 💻 启动入口 (CLI 单线程模式)
├── package.json             # 📦 依赖与脚本配置
├── tsconfig.json            # 📐 TypeScript 配置
└── .env.example             # 🔐 环境变量示例
```

---

## 📄 文件功能详解 (File Descriptions)

### 核心引擎层
*   **`server/engine.ts`**
    *   **功能**：TuringClaw 的心脏。负责与大模型通信（支持 Gemini API、Gemini CLI OAuth、Codex CLI OAuth、Kimi Code API），维护 `TAPE.md` 的读写，动态注入行号（视界投影），并解析 AI 输出的 XML 指令（`<EXEC>`, `<ERASE>`, `<DONE>`）。它还包含了安全沙盒、输出截断与三振熔断机制。

### 物理工作区 (Workspace)
*   **`workspace/TAPE.md`**
    *   **功能**：AI 的唯一上下文来源。记录了系统启动、用户输入、AI 思考过程（`<THINK>`）、执行结果和报错信息。
*   **`workspace/skills/remote_mgr.py`**
    *   **功能**：预置的 Python 脚本，封装了安全的 SSH 连接逻辑。允许 TuringClaw 穿透网络，直接管理 Google Cloud VM 或家庭内网主机。

### 交互接口层
*   **`cli.ts`**
    *   **功能**：纯命令行交互入口。无 Web UI、无 WebSocket，默认运行最小单线程循环，适合无头服务器（Headless Server）和长期守护任务。

### 测试与配置
*   **`tests/simulate_openclaw.ts`**
    *   **功能**：核心测试套件。模拟 6 个极限场景（代码执行、协议纪律、物理擦除、语法约束、主机范围硬锁、复杂脚本生成），确保引擎鲁棒性。
*   **`package.json`**
    *   **功能**：定义了项目依赖与启动脚本。`npm run dev` 与 `npm run cli` 都会启动 CLI 内核。

---

## 🚀 快速启动 (Getting Started)

### 1. 环境准备
复制环境变量文件：
```bash
cp .env.example .env
```

**推荐方案 A（OAuth，无需 API Key）：Gemini CLI**
```bash
gemini
# 首次运行按提示完成 Google OAuth 登录
```
`.env` 建议设置：
```bash
LLM_PROVIDER=gemini_cli
# 可选：GEMINI_MODEL=gemini-3-pro-preview
```

**推荐方案 B（OAuth，无需 API Key）：Codex CLI**
```bash
codex login
```
`.env` 建议设置：
```bash
LLM_PROVIDER=codex_cli
# 可选：CODEX_MODEL=gpt-5-codex
```

**方案 C（Kimi Code API）**
```bash
LLM_PROVIDER=kimi_api
KIMI_API_KEY=your_kimi_key_here
# 默认可不填：
# KIMI_BASE_URL=https://api.kimi.com/coding/v1
# KIMI_MODEL=kimi-for-coding
# KIMI_ANTHROPIC_VERSION=2023-06-01
```

**方案 D（传统 Gemini API Key）**
```bash
LLM_PROVIDER=gemini_api
GEMINI_API_KEY=your_api_key_here
```

**执行安全增强（参考 OpenClaw 社区经验）**
默认已开启以下保护：
- 危险命令（`pkill` / `kill` / `reboot` / `shutdown` / `rm -rf` 等）需要用户消息里包含 ` [APPROVE_DANGEROUS] `。
- `mock_ssh.py` 默认仅允许模拟演练，不作为真实运维通道。
- 远程命令中的目标 IP 会对照 `TURING_HOST_SOT_PATHS` 中的权威来源；未登记 IP 需要 ` [ALLOW_UNLISTED_HOST] `。
- 若配置 `TURING_SCOPE_HOSTS`，超出范围的主机会被硬拦截（与模型判断无关）。

可选配置：
```bash
TURING_EXEC_SECURITY=full|allowlist|deny
TURING_EXEC_ASK=off|on-miss|always
TURING_EXEC_ALLOWLIST=ls,cat,python3,ssh
TURING_REQUIRE_DANGEROUS_APPROVAL=true
TURING_ALLOW_MOCK_SSH=false
TURING_VALIDATE_IP_TARGETS=true
TURING_SCOPE_HOSTS=192.168.1.10
TURING_WORKSPACE_ROOT=./workspace-runs
TURING_TASK_ID=task-supervisor-01
TURING_WORKSPACE_ISOLATE=false
TURING_WORKSPACE_DIR=
TURING_MAX_TURNS_PER_RUN=40
TURING_ROM_LINES=15
TURING_STAGNATION_WINDOW_CHARS=2000
```

**个人配置约定（不入库）**
- 个人主机 IP、私有项目路径、内部流程说明只写在本地 `.env` 或本地 `workspace` 文件。
- `README.md` 与 `.env.example` 只保留通用示例，不写个人/组织专属信息。

当触发保护时，可在用户输入中显式附加令牌：
- ` [APPROVE_EXEC] `
- ` [APPROVE_DANGEROUS] `
- ` [ALLOW_MOCK_SSH] `
- ` [APPROVE_HOST_SWITCH] `
- ` [ALLOW_UNLISTED_HOST] `

### 2. 启动 CLI 单线程内核 (推荐)
默认以 CLI 模式启动（无 Web UI）：
```bash
npm install
npm run dev
```

### 3. 显式 CLI 命令 (等价入口)
你也可以显式使用 `cli` 脚本：
```bash
npm run cli
```
*(建议在另一个终端窗口中使用 CLI 启动时打印出的 Tape 路径执行 `tail -f <tape-path>` 实时观察 AI 的思考过程)*

---

## 🌐 远程主机控制 (Remote VM Management)

TuringClaw 天生适合作为你的**云端主脑**。如果你把它部署在 Google Cloud VM 上，你可以直接通过对话让它管理其他机器：

**示例指令：**
> "请调用 `skills/remote_mgr.py`，通过 SSH 连接到 `10.0.0.5` (用户 root)，帮我检查一下 Docker 容器的运行状态。"

TuringClaw 会自动编写执行逻辑，穿透内网，将远程主机的状态拉取回当前的物理纸带上，并向你汇报。
