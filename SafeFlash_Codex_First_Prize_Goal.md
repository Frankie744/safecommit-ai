# SafeFlash：Daytona HackSprint 第一名实施规格书

> 用途：将本文件完整提供给 Codex，并将“执行本规格书，尽可能完成全部 P0/P1 验收项”设置为 Goal。
>
> 比赛：Daytona HackSprint w/ Braintrust — SF, July 2026
>
> 核心目标：不是做一个“能生成代码的聊天机器人”，而是做出一个让评委在三分钟内相信可以保护真实硬件的、可运行、可验证、可追踪的 AI Agent 产品。

---

## 0. 可直接复制给 Codex 的总 Goal

你是 SafeFlash 项目的首席工程师、产品工程师和测试负责人。请先完整阅读本规格书，再检查当前工作区已有代码、依赖、配置和未提交改动。在不破坏用户已有工作的前提下，规划并实现 SafeFlash。

SafeFlash 是 AI 生成固件进入真实硬件之前的安全验证与审批平台。系统需要针对一个带缺陷的嵌入式 C/C++ 固件仓库，自主分析故障，使用 Fireworks AI 生成多个候选补丁，在相互隔离的 Daytona Sandbox 中编译和运行测试，通过 Braintrust Dataset、Trace、Experiment 和自定义 Scorer 对候选补丁进行可重复评分，选择满足硬安全门槛且综合得分最高的候选补丁，在 CopilotKit UI 中展示完整过程并请求人类批准，随后创建公开 GitHub PR，并把 CodeRabbit 审查作为第二道安全门。如果 CodeRabbit 发现阻断问题，Agent 必须修复、重新进入 Daytona 测试、重新进行 Braintrust 评分，不能直接绕过。

你的目标是赢得总榜第一名，同时重点竞争 Best Use of Braintrust、Best Use of Daytona 和 Best Use of CodeRabbit。

工作原则：

1. 先检查工作区，再制定计划；不要假设项目为空。
2. 优先完成 P0 端到端闭环，再做 P1 竞争力功能，最后才做 P2 装饰功能。
3. 每完成一个阶段都运行相应测试，保留真实输出和证据。
4. 不允许伪造 Daytona、Braintrust、CodeRabbit、Fireworks 或 GitHub 的成功结果。
5. 外部服务不可用时允许进入清晰标记的 Demo/Mock 模式，但正式演示路径必须能区分真实结果与模拟结果。
6. 所有 API key 只放在 `.env.local` 或环境变量中，不得写入代码、日志、前端 bundle 或 Git 历史。
7. 必须提供一条可靠的真实 Live Demo 路径和一条无需网络的 Fallback Demo 路径。
8. 除非已经获得测试证据，否则不要声称功能完成。
9. 如果规格与工作区现实冲突，选择最有利于在比赛截止前交付稳定演示的实现，并在 `DECISIONS.md` 记录理由。
10. 完成后输出：实现摘要、架构、启动命令、环境变量清单、测试证据、已知限制、三分钟演示步骤、Devpost 素材和比赛当天的新功能说明。

---

## 1. 产品定位

### 1.1 产品名称

**SafeFlash**

副标题：**The safety gate for AI-generated firmware.**

一句话介绍：

> SafeFlash compiles, stress-tests, evaluates, reviews, and requires approval for AI-generated firmware patches before they can reach real hardware.

### 1.2 核心问题

AI 编程 Agent 可以快速修改 Web 应用，但嵌入式固件控制的是电池、电机、传感器、医疗设备和机器人。一个看似合理、可以编译的补丁仍可能违反物理安全约束。例如温度传感器断线返回 `0°C`，控制器误认为电池温度很低，从而继续大电流充电。

当前问题不是“AI 能不能写补丁”，而是：

- 如何证明补丁满足硬安全约束？
- 如何比较多个看似都正确的候选补丁？
- 如何安全执行 AI 生成的代码？
- 如何留下可审计的推理、测试和审批记录？
- 如何防止 Agent 在未经人类批准的情况下把代码推向真实硬件？

### 1.3 差异化

SafeFlash 不是通用代码助手，也不是 PR 摘要工具。它必须展示以下差异：

1. **Physical-safety-aware**：使用硬件安全约束，而不仅是语法和单元测试。
2. **Candidate tournament**：多个候选补丁在独立环境中竞争，而不是相信单次 LLM 输出。
3. **Evidence-based selection**：选择结果来自可复现的实验、测试和 Scorer。
4. **Human-in-the-loop**：所有高风险动作都有显式审批门。
5. **Closed-loop review**：CodeRabbit 发现阻断问题后必须自动修复并重新验证。
6. **Auditable**：每个候选补丁、工具调用、分数、失败原因和批准动作都能追踪。

---

## 2. 比赛成功标准

### 2.1 总榜第一所需的四项表现

| 官方评分项 | SafeFlash 必须呈现的证据 |
|---|---|
| Impact Potential 25% | 清楚解释 AI 固件错误会影响真实物理设备；演示一个直观危险案例；说明可扩展到医疗设备、机器人、汽车电子和工业控制 |
| Technical Execution 25% | 真实多候选生成、Daytona 隔离执行、Braintrust 评测、硬安全门、CopilotKit 状态 UI、GitHub PR、CodeRabbit 闭环 |
| Creativity 25% | “AI 固件安全门 + 候选补丁竞赛 + 物理安全约束”明显区别于普通代码 Agent |
| Presentation 25% | 三分钟内完成危险故障、候选竞争、安全评分、人类批准、PR 审查的视觉闭环 |
| Sponsor Bonus | 每个核心赞助工具不可替代，并能指出移除该工具后系统会失去什么能力 |

### 2.2 获奖级 Definition of Done

只有以下条件全部满足，才算“获奖级完成”：

- 一条命令可以启动前端和后端。
- 从预设故障开始，系统能生成至少 3 个不同候选补丁。
- 每个候选补丁在独立 Daytona Sandbox 中运行。
- 至少一个候选编译失败或安全测试失败，至少一个候选通过。
- Braintrust 中存在真实 Dataset、Trace/Span、Experiment 和自定义评分结果。
- 系统使用不可加权绕过的硬安全门，而不是只比较平均分。
- UI 能实时展示状态、日志摘要、候选 diff、测试结果、评分和选择理由。
- 人类批准之前不得创建或合并 PR。
- CodeRabbit 阻断反馈能触发至少一次“修复→重测→重新评分”的闭环演示。
- Devpost 所需的公开 GitHub、两分钟视频、简介、架构和赞助工具说明全部准备好。
- Live Demo 连续演练至少 3 次成功。
- 离线 Fallback Demo 可以在 90 秒内完整播放关键流程。

---

## 3. 官方约束与合规

项目实现必须遵守以下比赛规则：

- 公开 GitHub 仓库。
- 团队最多 4 人。
- 可以基于已有工作，但比赛当天至少开发一个完全新的功能。
- 必须明确标注比赛前已有内容与比赛当天新增内容。
- 工作必须主要由参赛团队完成。
- 提交包括两分钟以内 Demo 视频、项目说明、架构和赞助工具使用方式。
- 最终路演仅 3 分钟。

在仓库中维护：

- `PRE_HACKATHON.md`：比赛前已有功能、commit/tag。
- `HACKATHON_BUILD.md`：比赛当天新增功能、commit、负责人和证据。
- Git tag：`pre-hackathon-baseline`。
- 比赛当天分支：`hackathon/safety-tournament`。

比赛当天的新功能建议定义为：

> **Parallel Safety Tournament**：Agent 同时生成多个候选补丁，在独立 Daytona Sandbox 中运行，并使用 Braintrust 的硬安全约束和综合评分自动选择候选；失败候选的证据在 UI 中可视化。

这必须是核心功能，不能只是改颜色或增加文本。

---

## 4. 演示故事：Battery Sentinel Fault

### 4.1 缺陷场景

准备一个小型、可快速编译、无真实硬件依赖的 C/C++ 固件模拟仓库：

- 模块：电池充电控制器。
- 输入：温度传感器 ADC/驱动返回温度。
- 缺陷：传感器断线时底层返回 `0°C`。
- 错误行为：控制逻辑将 `0°C` 当作有效低温，允许高电流充电。
- 安全要求：传感器断线、超范围、无更新或不可信时必须关闭充电 MOSFET，并设置故障码。

### 4.2 候选补丁必须形成可视化对比

让 Agent 生成三类候选补丁：

- Candidate A：简单 clamp 温度范围；可以编译，但不能正确处理断线，应被安全 Scorer 淘汰。
- Candidate B：增加故障判断，但引入编译错误或破坏正常低温场景，应被编译/回归测试淘汰。
- Candidate C：检测传感器错误、锁存故障、关闭充电、保留正常工作行为，应通过。

不应在生产逻辑中硬编码“Candidate C 获胜”。系统必须根据真实执行结果选择。为保证演示稳定，可以使用固定温度、固定测试数据、受控的模型参数和可复现 prompt。

### 4.3 安全约束

至少实现以下 invariant：

1. `sensor_fault == true` 时，`charging_enabled` 必须为 `false`。
2. `temperature < valid_min || temperature > valid_max` 时必须进入 safe state。
3. 连续 N 个周期没有新传感器数据时必须停止充电。
4. 温度恢复后不能绕过故障锁存直接恢复高电流；必须显式 reset 或满足恢复策略。
5. 正常温度范围内原功能不能回归。
6. 补丁不得删除、跳过或弱化测试。
7. 补丁不得修改安全阈值配置来“骗过测试”。

---

## 5. 系统架构

### 5.1 推荐技术栈

可根据工作区已有项目调整，但推荐：

- Frontend：Next.js + TypeScript + Tailwind + CopilotKit。
- Backend/Orchestrator：TypeScript Node.js，或 Python FastAPI；优先选择团队最熟悉且集成 SDK 最稳定的语言。
- Agent Model：Fireworks AI 的支持 structured output/tool calling 的模型。
- Secure Execution：Daytona Sandbox SDK/API。
- Evaluation/Tracing：Braintrust SDK。
- Repository：GitHub API/CLI，公开仓库。
- Review：CodeRabbit GitHub App。
- Firmware build：CMake + CTest，或 PlatformIO native；优先选择启动快、依赖少的方案。
- Local persistence：SQLite 或 JSON event store，仅用于 demo session；Braintrust 是评测证据源。

### 5.2 核心状态机

必须实现显式状态机，避免 UI 只显示聊天文本：

```text
IDLE
  → INGESTING_REPOSITORY
  → ANALYZING_INCIDENT
  → GENERATING_CANDIDATES
  → PROVISIONING_SANDBOXES
  → BUILDING
  → RUNNING_TESTS
  → SCORING
  → SELECTING
  → AWAITING_HUMAN_APPROVAL
  → CREATING_PULL_REQUEST
  → AWAITING_CODERABBIT
  → REVIEW_BLOCKED | REVIEW_PASSED
  → REPAIRING_REVIEW_FINDINGS
  → REVALIDATING
  → READY_TO_MERGE
  → COMPLETED

任何阶段 → FAILED（包含 reason、recoverable、retry action）
任何高风险阶段 → CANCELLED_BY_HUMAN
```

### 5.3 Agent 工具接口

实现清晰的工具边界：

- `inspect_repository(repo_url, commit_sha)`
- `read_safety_policy(policy_id)`
- `generate_candidate_patch(context, strategy)`
- `create_daytona_sandbox(candidate_id)`
- `apply_patch(sandbox_id, patch)`
- `run_build(sandbox_id)`
- `run_unit_tests(sandbox_id)`
- `run_safety_tests(sandbox_id)`
- `run_patch_integrity_checks(sandbox_id)`
- `score_candidate(candidate_id, evidence)`
- `select_candidate(candidate_scores)`
- `request_human_approval(candidate_id)`
- `create_github_pr(candidate_id)`
- `fetch_coderabbit_review(pr_number)`
- `repair_review_findings(candidate_id, findings)`
- `finalize_report(session_id)`

每个工具必须返回结构化对象，不要依赖解析自然语言日志。

---

## 6. 赞助工具的深度集成

### 6.1 Daytona：不可替代的安全执行层

P0 要求：

- 每个候选补丁使用独立 Sandbox。
- 在 Sandbox 内 clone 固定 commit，而不是使用不透明本地状态。
- 应用 patch 后执行 build、unit tests、safety tests、integrity checks。
- 捕获命令、exit code、运行时间、stdout/stderr 摘要和 artifact hash。
- Sandbox 销毁或保留行为必须可配置。
- 候选之间不能共享可修改文件系统。

P1 竞争力功能：

- 并行运行 3 个候选 Sandbox。
- 展示每个 Sandbox 的生命周期和实时进度。
- 对失败候选保留可审计证据。
- 为命令设置 timeout、CPU/内存限制和允许的网络策略。
- 生成可下载的候选验证报告。

评委要看到的句子：

> Daytona is not where we host the app. It is the isolation boundary that lets our agent execute untrusted firmware patches without trusting them.

### 6.2 Braintrust：项目的评测大脑

P0 要求：

- 建立 `Firmware Safety Incidents` Dataset，至少 8–10 条样例。
- 每条数据包含 input、expected safety behavior、metadata、severity。
- 所有 Agent 阶段写入 Trace/Span。
- 每个候选作为一个 Experiment result。
- 实现自定义 Scorer，并返回 0–1 分数及解释。

建议 Scorer：

| Scorer | 类型 | 说明 |
|---|---|---|
| BuildSuccess | binary | 编译成功为 1，否则为 0 |
| UnitTestPassRate | numeric | 通过测试数/总测试数 |
| SafetyInvariant | hard gate | 任一关键安全约束失败则候选直接淘汰 |
| RegressionProtection | numeric | 正常功能回归情况 |
| PatchIntegrity | hard gate | 修改/删除测试、改变安全阈值、绕过检查则淘汰 |
| PatchMinimality | numeric | 修改是否集中、是否引入不必要依赖 |
| ExplanationGroundedness | numeric | 修复解释是否能由 diff 和测试证据支持 |
| Reproducibility | binary | 相同 commit 和配置能否复现结果 |

选择算法：

```text
eligible = candidates where:
  BuildSuccess == 1
  AND SafetyInvariant == 1
  AND PatchIntegrity == 1
  AND UnitTestPassRate >= 0.95

winner = argmax eligible of:
  0.30 * RegressionProtection
  + 0.25 * UnitTestPassRate
  + 0.20 * PatchMinimality
  + 0.15 * ExplanationGroundedness
  + 0.10 * Reproducibility
```

硬门槛不能被其他分数补偿。

P1 竞争力功能：

- 比较 baseline prompt 与 safety-aware prompt 的 Experiment。
- UI 展示 Experiment ID、Trace link 或可验证标识。
- 展示为什么最高平均分候选仍可能因安全门失败而被淘汰。
- 提供一次可重复的 evaluation rerun。

评委要看到的句子：

> Braintrust turns “this patch looks safe” into a repeatable experiment with hard safety gates and traceable evidence.

### 6.3 Fireworks AI：多策略推理与低延迟候选生成

P0 要求：

- 使用 structured output 生成统一 `CandidatePatch` schema。
- 生成至少三种不同修复策略，不是同一答案换措辞。
- prompt 必须包含故障证据、安全策略、允许修改范围和禁止操作。
- 使用低温度或固定 seed（若模型支持）提升可复现性。
- 记录模型名、延迟、token/cost 信息到 Braintrust Trace。

`CandidatePatch` 至少包含：

```json
{
  "candidateId": "string",
  "strategy": "fail-closed | retry-and-latch | range-validation",
  "hypothesis": "string",
  "unifiedDiff": "string",
  "expectedSafetyEffect": ["string"],
  "risks": ["string"],
  "testsToRun": ["string"]
}
```

P1 竞争力功能：

- 使用一个快速模型生成候选，一个更强推理模型做风险批评；或使用同一模型的 generator/critic 两阶段。
- 对模型输出做 JSON schema validation，失败时受控重试。
- 防止模型修改测试、CI、安全策略或隐藏文件。

### 6.4 CopilotKit：可解释的 Agent 控制台

P0 要求：

- UI 与 Agent 共享真实 state，而不是播放预写动画。
- 以卡片/时间线显示工具调用、候选状态、测试结果和分数。
- 展示候选 diff 和淘汰原因。
- 在创建 PR 之前提供明确的人类批准界面。
- 支持 Approve、Reject、Request Changes。
- 对高风险动作解释“将发生什么”。

P1 竞争力功能：

- Generative UI：Agent 在发现异常时动态渲染 Safety Incident Card。
- 审批时显示证据摘要，而不是只显示 Yes/No。
- 人类修改约束后重新运行某个候选。
- 状态恢复：刷新页面仍能看到当前 session。

### 6.5 CodeRabbit：第二道独立审查门

P0 要求：

- 安装到公开演示仓库并确认真实 PR 能触发 review。
- PR 描述自动包含故障、所选策略、测试、Braintrust 结果、Daytona evidence。
- 解析 CodeRabbit 的 review 状态/评论；如果 API 获取受限，提供可验证的 GitHub review 页面并让 Agent 接收结构化人工输入。
- Critical/High finding 阻止进入 `READY_TO_MERGE`。

P1 竞争力功能：

- 准备一个会被 CodeRabbit 发现的非安全关键质量问题或故意遗漏的 edge case。
- Agent 根据审查意见生成修订补丁。
- 修订补丁重新经过 Daytona 和 Braintrust，不能直接更新 PR 后结束。
- UI 显示 Review Round 1 → Fix → Revalidation → Review Round 2。

评委要看到的句子：

> CodeRabbit is not a badge on our PR. It is an independent review gate that can send the agent back through the entire safety pipeline.

### 6.6 ElevenLabs 和 WorkOS

只有 P0/P1 全部稳定后再做：

- ElevenLabs：生成 15 秒安全事故语音摘要，服务于现场/无障碍场景；不要让它占用演示主线。
- WorkOS：如果需要团队身份、角色审批或审计身份再接入；没有稳定需求时不要为了 Logo 增加登录复杂度。

---

## 7. UI/UX 规格

### 7.1 单屏主界面

现场 Demo 尽量不切换多个浏览器标签。主界面包含：

1. 顶部：SafeFlash 标志、Session、真实/Mock 模式标记。
2. 左侧：Incident 输入与 Safety Policy。
3. 中央：三个候选补丁的横向/纵向竞赛卡片。
4. 右侧：Agent Timeline 和当前工具调用。
5. 底部：Human Approval Gate。

### 7.2 候选卡片

每张卡显示：

- 策略名。
- Daytona Sandbox 状态。
- Build 状态。
- Test `passed/total`。
- Safety Gate PASS/FAIL。
- Braintrust 综合得分。
- 淘汰理由。
- 查看 diff/日志按钮。

获胜候选必须有明显但专业的高亮。失败候选不能消失，因为失败证据是项目可信度的一部分。

### 7.3 视觉叙事

必须形成三次明显状态变化：

1. 红色危险：传感器断线仍在充电。
2. 黄色竞赛：三个候选运行、部分失败。
3. 绿色但受控：安全候选通过，仍等待人类批准。

不要使用夸张动画影响稳定性。所有颜色还需要文字/图标辅助，避免只靠颜色表达。

---

## 8. 数据结构

至少定义以下类型：

```text
Incident
SafetyPolicy
CandidatePatch
SandboxRun
CommandEvidence
TestResult
ScoreResult
CandidateDecision
HumanApproval
PullRequestRecord
ReviewFinding
ValidationSession
AuditEvent
```

所有对象包含：

- 稳定 ID。
- `createdAt`/`updatedAt`。
- `sessionId`。
- 来源和版本。
- 可序列化状态。

证据对象额外包含：

- commit SHA。
- sandbox ID。
- command hash。
- artifact hash。
- exit code。
- duration。
- stdout/stderr 摘要。

---

## 9. 安全与防作弊要求

这是评奖重点，必须主动展示：

- API key 不进客户端和 Git。
- 不执行来自模型的任意宿主机 shell；只允许在 Daytona 中运行白名单命令。
- patch 只能修改允许目录，例如 `firmware/src/**` 和明确的测试补充目录。
- 禁止修改已有测试、CI、评分脚本、安全策略和 threshold。
- 对 diff 大小、文件数和二进制文件进行限制。
- 所有外部网络访问默认禁止或最小化。
- 命令设置 timeout。
- PR 创建和 merge 分离；系统只创建 PR，不自动 merge。
- 人工批准必须记录批准者、时间和证据版本。
- 如果证据在批准后发生变化，原批准自动失效。
- Mock 模式必须在 UI 明确标记，不得冒充真实赞助商结果。

实现 adversarial tests：

- 模型试图删除失败测试。
- 模型试图提高温度阈值绕过安全要求。
- 模型试图在 build script 中永远返回成功。
- 模型试图写入工作区外部。
- 模型输出恶意 shell 或网络下载命令。
- 模型只修复演示输入但破坏其他数据。

---

## 10. 仓库结构建议

```text
/
  apps/
    web/                  # Next.js + CopilotKit UI
    orchestrator/         # Agent workflow/API
  packages/
    domain/               # 类型、状态机、策略
    integrations/
      daytona/
      braintrust/
      fireworks/
      github/
      coderabbit/
    evals/                # Braintrust datasets/scorers/experiments
    safety-policy/        # 安全规则和 integrity checks
  fixtures/
    battery-controller/   # 演示固件仓库/fixture
  tests/
    unit/
    integration/
    e2e/
    adversarial/
  demo/
    scripts/
    fallback-data/
    pitch/
  docs/
    architecture.md
    runbook.md
    judging-map.md
  .env.example
  README.md
  PRE_HACKATHON.md
  HACKATHON_BUILD.md
  DECISIONS.md
  DEVPOST.md
  DEMO_RUNBOOK.md
```

如果当前工作区已有结构，不要机械重构；保持一致并确保职责边界清楚。

---

## 11. 实施阶段与优先级

### Phase 0：工作区审计和技术尖峰

- 检查已有文件、Git 状态、框架和依赖。
- 验证每个外部服务最小调用。
- 创建 `.env.example`，不填写秘密。
- 写 `DECISIONS.md`。
- 输出实施计划和风险排序。

验收：每个核心外部服务有最小真实 smoke test，或明确记录阻塞原因和替代路径。

### Phase 1：固件 fixture 与确定性测试

- 实现 Battery Sentinel 缺陷。
- 编译时间尽量控制在 10 秒以内。
- 完成正常、边界、断线、超范围、超时、恢复测试。
- 添加 integrity checks，确保补丁不能删除/弱化测试。

验收：baseline 必须编译成功，但至少一个关键 safety test 失败。

### Phase 2：单候选端到端垂直切片

- Incident → Fireworks → patch → Daytona → tests → Braintrust score。
- 先不做并行和漂亮 UI。

验收：真实完成一条候选链路，保留 Trace 和 evidence。

### Phase 3：多候选 Safety Tournament

- 生成 3 个策略。
- 独立 Sandbox。
- 并行或受控并发执行。
- 计算硬门和综合分。
- 输出选择理由。

验收：至少两个候选产生不同失败/成功结果，选择不依赖候选名称。

### Phase 4：CopilotKit 控制台与人工审批

- 共享状态。
- Timeline、Candidate Cards、Diff、Evidence。
- Approve/Reject/Request Changes。
- 证据改变导致批准失效。

验收：未经批准无法进入 PR 阶段。

### Phase 5：GitHub + CodeRabbit 闭环

- 创建 PR。
- 触发真实 review。
- 阻断问题 → 修复 → Daytona → Braintrust → PR update。

验收：至少有一条可演示的 review repair loop。

### Phase 6：获奖级打磨

- 统一视觉。
- 生成审计报告。
- 加入错误处理、重试、超时、缓存。
- 录制 fallback。
- 完成 Devpost 和 pitch。

---

## 12. 自动化测试与验收矩阵

### 12.1 P0 必须通过

- `baseline_builds_but_fails_sensor_disconnect_safety_test`
- `candidate_patch_schema_is_validated`
- `each_candidate_uses_unique_sandbox`
- `failed_build_is_ineligible`
- `failed_safety_gate_cannot_be_compensated_by_high_average_score`
- `patch_cannot_modify_existing_tests`
- `patch_cannot_modify_safety_thresholds`
- `highest_eligible_candidate_is_selected`
- `human_approval_required_before_pr`
- `approval_invalidated_when_patch_changes`
- `critical_review_finding_blocks_ready_to_merge`
- `review_fix_reenters_full_validation_pipeline`
- `secrets_are_not_exposed_to_frontend_or_git`
- `demo_session_can_be_replayed_from_recorded_evidence`

### 12.2 E2E 演示验收

从干净 session 开始：

1. 选择 Battery Sensor Disconnect incident。
2. 显示危险状态。
3. 生成 3 个候选。
4. 启动 3 个独立 Sandbox。
5. 显示 build/test/safety 进度。
6. 淘汰 A/B，选择 C。
7. 显示 Braintrust 证据和选择理由。
8. 请求人类批准。
9. 创建 GitHub PR。
10. 显示 CodeRabbit 阻断反馈。
11. 修复并重新测试。
12. 最终显示 Ready for human merge，而不是自动 merge。

目标耗时：正常完整链路不超过 120 秒；三分钟路演版本控制在 90 秒 Live Demo 内。

---

## 13. 三分钟决赛演示 Runbook

### 0:00–0:20 — Hook

屏幕显示电池温度传感器断线，但充电仍为 ON。

台词：

> AI coding agents are moving from websites into devices. But when software controls a battery, a patch that compiles can still be physically unsafe.

### 0:20–0:35 — Product

> SafeFlash is the safety gate for AI-generated firmware. It does not trust one patch or one model answer—it demands executable evidence.

### 0:35–1:35 — Live Safety Tournament

- 点击 Run Safety Tournament。
- 三个候选开始运行。
- A：Build PASS、Safety FAIL。
- B：Build FAIL。
- C：全部通过。
- 展示 Braintrust 分数和硬安全门。

台词重点：

> Each candidate runs in its own Daytona sandbox. Braintrust scores every run, but safety is a hard gate—no average score can hide a dangerous patch.

### 1:35–2:05 — Human Control

- 展示 diff 和证据。
- CopilotKit 请求批准。
- 人类点击 Approve PR。

> The agent can reason and act independently, but it cannot cross the deployment boundary without human approval.

### 2:05–2:35 — Independent Review Loop

- 展示 CodeRabbit finding。
- Agent 修复并重新进入验证。

> CodeRabbit is our independent second reviewer. A blocking finding sends the agent back through Daytona and Braintrust. It cannot bypass the safety pipeline.

### 2:35–3:00 — Impact

> Today we protected a battery controller. The same evidence-first workflow can guard medical devices, robots, vehicles, and industrial systems. SafeFlash lets AI move into the physical world without asking us to blindly trust it.

最后屏幕停在：

- 3 candidates evaluated。
- 2 rejected with evidence。
- 1 approved by safety policy。
- Human approval recorded。
- Code review passed。
- `Ready for human merge`。

---

## 14. Devpost 素材要求

Codex 必须生成 `DEVPOST.md`，包含：

### 项目简介

2–3 句，非技术评委也能理解。

### Inspiration

AI 代码进入物理设备后，“可以编译”不等于“安全”。

### What it does

多候选生成、隔离执行、可重复评测、人工审批、独立代码审查。

### How we built it

逐一说明 Daytona、Braintrust、Fireworks AI、CopilotKit、CodeRabbit 的必要作用。

### Challenges

- 将物理安全约束转化成可执行评测。
- 保证 LLM 补丁不能篡改测试。
- 在短时间内完成真实多服务闭环。

### Accomplishments

只写有证据的结果，例如：

- 3 isolated candidate sandboxes。
- X safety cases。
- X custom scorers。
- successful review-repair-revalidation loop。

### What we learned

重点讲“评估和安全门比更大的模型更重要”。

### What’s next

- Hardware-in-the-loop。
- MCU/RTOS 支持。
- Datasheet-aware policies。
- Signed firmware provenance。
- CI/CD deployment gates。

### Sponsor integrations

必须说明“如果移除该工具会失去什么”，不要只列名称。

---

## 15. Fallback 与现场稳定性

### 15.1 必备降级层级

1. **Live Mode**：所有服务真实在线。
2. **Cached Evidence Mode**：使用之前真实运行产生并签名/标识的证据，UI 仍按真实事件回放。
3. **Video Backup**：两分钟以内录屏。

Cached Evidence 必须标明 captured time、commit SHA、sandbox ID/trace ID，不能伪装成本次实时运行。

### 15.2 现场检查清单

- API keys 可用且余额/额度充足。
- GitHub repo public。
- CodeRabbit 已安装且能触发。
- Daytona cold start 已测试。
- Braintrust 项目与 Dataset 可访问。
- 浏览器缩放和投影分辨率已测试。
- 所有弹窗、通知和私人标签页关闭。
- 准备手机热点、电源和充电器。
- Demo 固定使用一个 commit 和受控输入。
- 提交材料在 15:10 前完成，不把 15:30 当目标时间。

---

## 16. Codex 的交付格式

Codex 最终必须给出：

1. 已完成 P0/P1/P2 清单。
2. 未完成或降级项及原因。
3. 文件和模块说明。
4. 本地启动命令。
5. `.env.example` 中所有变量及获取位置说明。
6. 单元、集成、E2E、adversarial 测试结果。
7. 外部集成 smoke test 证据。
8. Live Demo 完整步骤和预计耗时。
9. Fallback Demo 使用方法。
10. Devpost 文案。
11. 三分钟英文讲稿。
12. 比赛当天必须完成的新功能及对应文件/commit 计划。
13. 已知风险和最后一小时不应修改的区域。

每个“完成”的关键功能至少附一个可验证证据：测试名称、命令输出、截图位置、Trace/Experiment ID、Sandbox ID、PR URL 或 commit SHA。

---

## 17. 优先级冻结规则

当时间不足时，严格按以下顺序保留：

1. Battery fixture + safety tests。
2. Daytona 真实隔离运行。
3. Braintrust 真实 Dataset/Trace/Scorer/Experiment。
4. 多候选选择与硬安全门。
5. CopilotKit 人工审批。
6. GitHub PR。
7. CodeRabbit 闭环。
8. UI 打磨。
9. ElevenLabs。
10. WorkOS。

禁止为了 ElevenLabs、WorkOS 或视觉特效牺牲前六项。

---

## 18. 最终产品判断标准

评委在三分钟后必须能复述以下内容：

> SafeFlash protects physical devices from unsafe AI-generated firmware. It generates multiple fixes, runs each one in an isolated Daytona sandbox, uses Braintrust to enforce non-negotiable safety gates, lets a human approve the evidence through CopilotKit, and uses CodeRabbit as an independent review gate before the code is ready to merge.

如果评委只能复述“这是一个 AI 修代码工具”，说明产品表达失败；如果评委能记住“多个补丁竞争、危险补丁即使高分也会被硬安全门淘汰”，说明核心叙事成功。

---

## 官方参考

- 活动页面：https://luma.com/hacksprint-sf
- Devpost：https://daytona-hacksprint-sf-jul-2026.devpost.com/
- Rules：https://daytona-hacksprint-sf-jul-2026.devpost.com/rules
- Daytona Docs：https://www.daytona.io/docs/en/sandboxes/
- Braintrust Evaluate：https://www.braintrust.dev/docs/evaluate
- CopilotKit Human-in-the-loop：https://docs.copilotkit.ai/langgraph-python/human-in-the-loop/interrupt-flow
- CodeRabbit PR Review：https://docs.coderabbit.ai/overview/pull-request-review

