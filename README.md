# AI 辅助 GitHub PR 卡点 + CI/CD 完整搭建指南

> 仓库：[slowpoke-ai/ai-code-review-demo](https://github.com/slowpoke-ai/ai-code-review-demo)
> 技术栈：TypeScript · React · GitHub Actions · CodeRabbit · Codecov · Gitleaks · CodeQL

---

## 目录

1. [背景](#背景)
2. [现状](#现状)
3. [目标](#目标)
4. [整体架构](#整体架构)
5. [Workflow 功能说明](#workflow-功能说明)
6. [自定义 AI Review vs CodeRabbit 对比](#自定义-ai-review-vs-coderabbit-对比)
7. [未来可扩展的 Workflows](#未来可扩展的-workflows)
8. [操作步骤：从零搭建](#操作步骤从零搭建)

---

## 背景

研发流程中的质量保障（QA）不只是代码审查，而是一条完整的卡点链路：

```
需求评审 → 开发 → 代码审查 → 自动化测试 → 部署检查 → 上线
```

目前团队的主要问题是**整条链路缺乏自动化卡点**，代码可以不经过任何强制检查直接合入主干再上线。代码审查只是质检的一个环节，但连这个环节目前也没有硬性约束——Review 是否认真、安全漏洞是否被发现、测试是否覆盖，完全依赖个人自觉。

传统人工 Review 的具体问题：

- **覆盖不全**：容易漏掉安全漏洞（SQL 注入、XSS、硬编码密钥等），尤其是大 PR
- **标准不一**：不同 Reviewer 的关注点和严格程度差异大，没有统一基线
- **卡点缺失**：没有自动阻断机制，问题代码可能直接合入主干

本项目的目标是先把代码审查这一环做实——用 AI 承担重复性检查工作，通过 GitHub Branch Protection 将审查结果作为 merge 的强制卡点，形成可落地的第一道防线。

---

## 现状

本项目是一个演示仓库，用于验证不同 AI 代码审查方案的实际效果。

**已跑通的 PR 案例：**

- **PR #6**（`paymentService.ts`）：支付服务，包含 SQL 注入、MD5 弱加密、eval RCE、hardcoded secrets 等 10+ 个高危漏洞，CodeRabbit 识别并发出 14 条 actionable comments，CodeQL 触发 High 级别 alert
- **PR #8**（`UserProfile.tsx`）：前端组件，包含 XSS（innerHTML/dangerouslySetInnerHTML）、Open Redirect、postMessage 无 origin 校验、localStorage 存储敏感 token 等前端典型漏洞，CodeQL 触发 3 条 alert（1 High + 2 Medium），CodeRabbit 审查进行中

**已验证的卡点效果：**

Branch Protection 配置后，PR #8 的 Merge 按钮处于锁定状态，提示：
> "At least 1 approving review is required by reviewers with write access."
> "4 failing checks" — CI、CodeQL、Gitleaks、Dependency Audit 均未通过

---

## 目标

```
提 PR / push
     │
     ├── 🤖 CodeRabbit        行内建议 + Walkthrough + 自动 approve/request changes（卡点）
     ├── 🔍 ci.yml            类型检查 → ESLint → Vitest 单测 → Codecov 覆盖率
     └── 🛡 security.yml      npm audit → CodeQL 静态分析 → Gitleaks 密钥扫描
                               （每周一凌晨 2 点也会定时全量扫描）
```

**核心卡点逻辑：**

```
CodeRabbit 审查代码
  ↓
发现 error 级问题（SQL 注入 / RCE / 硬编码密钥等）→ request changes → Merge 按钮锁定
无 error 级问题                                    → approve       → 允许 Merge
```

approve 模式的优势：
- 卡点依据更直观，开发者可以看到具体的 request changes 理由
- CodeRabbit 的行内注释直接定位到问题代码行
- 行为确定，不依赖任何参数调优

---

## 整体架构

### 当前体系

```
┌─────────────────────────────────────────────────────┐
│                    提 PR / push                       │
└──────────────┬──────────────┬───────────────────────┘
               │              │
       ┌───────▼──────┐ ┌─────▼────────────────────┐
       │  GitHub App  │ │    GitHub Actions          │
       │  CodeRabbit  │ │                            │
       │              │ │  ci.yml      security.yml  │
       │ • Walkthrough│ │  • tsc       • npm audit   │
       │ • 行内注释    │ │  • eslint    • CodeQL      │
       │ • approve /  │ │  • vitest    • Gitleaks    │
       │   req changes│ │  • codecov               │
       └──────────────┘ └────────────────────────────┘
               │
       ┌───────▼──────────────────────────────────────┐
       │           Branch Protection (Ruleset)          │
       │  • Required approvals: 1 (CodeRabbit)          │
       │  • Required status checks: coderabbitai         │
       │  • Restrict deletions                           │
       └─────────────────────────────────────────────-─┘
```

### 卡点决策流程

```
CodeRabbit 审查
    │
    ├── 发现 severity: error 的问题
    │       └── request changes → merge 锁定 🔴
    │
    └── 无 error 级问题（只有 warning）
            └── approve → merge 可用 ✅（仍可人工 Review 后再合）
```

---

## Workflow 功能说明

### 🤖 CodeRabbit — AI 代码审查卡点

**触发条件：** PR 提交 / 更新时自动触发（GitHub App，无需 Actions）

**工作内容：**

| 功能 | 说明 |
|---|---|
| PR Summary | 自动生成变更摘要，列出新增/修改/删除的功能模块 |
| Walkthrough | 逐文件说明改动内容，帮助 Reviewer 快速定位重点 |
| 行内 Comments | 在具体代码行发出建议，支持 `@coderabbitai` 交互 |
| Pre-merge checks | 运行自定义 checklist（title 格式、docstring 覆盖率等） |
| approve / request changes | 根据 `.coderabbit.yml` 的 custom_reviews 规则自动决定 |

**自定义审查规则（`.coderabbit.yml`）：**

| 规则名 | 检查内容 | Severity |
|---|---|---|
| 安全检查 | SQL 注入、硬编码密钥、弱加密、eval、路径遍历、缺少鉴权、敏感字段泄露 | error |
| 代码质量 | 禁用 console.log、禁用 any、空 catch、函数过长、缺少 JSDoc | warning |
| 测试覆盖 | 新增导出函数必须有 vitest 测试，覆盖正常/边界/异常 | warning |
| 变更影响 | Breaking Change、核心模块改动、N+1 查询、新增依赖 | warning |

---

### 🔍 ci.yml — 基础 CI

**触发条件：** push 到 main/develop 分支，或提 PR 时

| 步骤 | 工具 | 作用 |
|---|---|---|
| 类型检查 | `tsc --noEmit` | 发现 TypeScript 类型错误，编译前拦截 |
| Lint | `eslint --max-warnings 0` | 代码规范检查，零警告容忍 |
| 单元测试 | `vitest run --coverage` | 运行所有测试用例并生成覆盖率报告 |
| 覆盖率上传 | `codecov/codecov-action` | 上传报告到 Codecov，PR 下自动展示差异 |

---

### 🛡 security.yml — 安全扫描

**触发条件：** PR、push main，以及每周一凌晨 2 点定时全量扫描

**三个并行 Job：**

| Job | 工具 | 检测内容 |
|---|---|---|
| 依赖审计 | `npm audit --audit-level=high` | 扫描所有依赖的已知 CVE 漏洞，high 以上报错 |
| CodeQL 静态分析 | `github/codeql-action` | XSS、SQL 注入、Open Redirect、postMessage 等 100+ 种漏洞模式 |
| 密钥泄露扫描 | `gitleaks/gitleaks-action` | 扫描完整 git 历史，检测 100+ 种密钥格式 |

**PR #8 实际触发的 CodeQL alerts：**

| Severity | 问题 | 位置 |
|---|---|---|
| 🔴 High | Client-side XSS（user-provided value → innerHTML） | `UserProfile.tsx` |
| 🟡 Medium | Client-side URL Redirect（未校验 redirect 参数） | `UserProfile.tsx` |
| 🟡 Medium | Missing origin verification in postMessage handler | `UserProfile.tsx` |

---

## 自定义 AI Review vs CodeRabbit 对比

在引入 CodeRabbit 之前，本项目维护了一套基于 Claude API 的自研 AI 审查 workflow（`ai-review.yml`），两者的核心差异如下：

### 功能对比

| 维度 | 自研 ai-review.yml | CodeRabbit |
|---|---|---|
| **行内代码注释** | ❌ 无，只有整体报告 | ✅ 精确到代码行 |
| **PR Walkthrough** | ❌ 无 | ✅ 自动生成，逐文件说明 |
| **卡点机制** | 无（已废弃） | approve / request changes → Branch Protection |
| **卡点依据可读性** | 无 | 直接在问题代码行发注释 |
| **自定义审查规则** | Prompt 工程，灵活但需维护 | `.coderabbit.yml` 结构化配置 |
| **交互能力** | ❌ 单向输出 | ✅ `@coderabbitai` 对话，可要求重新审查、生成测试等 |
| **前端漏洞识别** | 依赖 Prompt 质量 | 较强（配合 custom_reviews 可覆盖 XSS/Open Redirect 等） |
| **运行成本** | 消耗 Anthropic API 额度 | 免费 Pro 额度内无成本 |
| **冷启动时间** | ~30-60 秒（Actions 排队 + API 调用） | ~60-120 秒（GitHub App 触发） |

### CodeRabbit 的局限性

使用过程中发现 CodeRabbit 有几个值得注意的问题：

**1. custom_reviews 对前端漏洞的覆盖依赖 Prompt 质量**

CodeRabbit 的安全检查 Prompt 针对后端场景（SQL 注入、硬编码密钥等）更为完善，前端特有的问题（`dangerouslySetInnerHTML`、postMessage origin 校验、localStorage 存储敏感数据）需要在 `.coderabbit.yml` 的 `custom_reviews` 中明确列出，否则可能只有 warning 级别注释而不会触发 request changes。

**2. 不感知完整代码库上下文**

CodeRabbit 和自研方案都只能基于 PR diff 审查，看不到调用链。例如一个函数本身无问题，但结合调用方的入参来源可能构成注入漏洞，这类跨文件的上下文问题两者都无法发现。

**3. approve 时机有延迟**

CodeRabbit 的 approve 是在完整审查结束后才发出，通常需要 1-2 分钟。如果 PR 代码量大（diff > 500 行），可能需要更长时间，期间 merge 按钮一直处于 pending 状态。

**4. 不能替代 CodeQL**

CodeRabbit 的安全检查基于 LLM 理解代码语义，而 CodeQL 做数据流分析，能追踪从 source 到 sink 的完整污点传播路径。PR #8 中 XSS 和 Open Redirect 的准确定位都来自 CodeQL，而不是 CodeRabbit。两者应该配合使用，而不是互相替代。

### CodeRabbit 安全性与代码泄漏风险

使用 CodeRabbit 意味着你的代码 diff 会被发送到第三方服务，这是一个值得认真评估的问题。

**官方声明的安全保障：**

- **不用于训练模型**：代码不会被用于训练 OpenAI 或 Anthropic 的任何模型
- **零数据留存（LLM 侧）**：发给 OpenAI / Anthropic 的请求是 ephemeral 的，LLM 不存储也不记录代码内容
- **审查完即销毁**：CodeRabbit 将代码 clone 在内存中完成审查，审查结束后立即丢弃，不在自己服务器上持久化存储代码
- **传输加密**：所有数据通过 TLS 加密传输
- **合规认证**：SOC 2 Type II、GDPR、HIPAA

**已知历史漏洞（需知情）：**

2025 年 1 月，安全研究机构 Kudelski Security 在 Black Hat 上披露了一个已修复的高危漏洞链——攻击者可通过构造恶意 PR 在 CodeRabbit 生产服务器上实现 RCE，进而泄漏其 API token 和密钥，并借助 GitHub App 权限获取约 100 万个仓库的读写权限（含私有仓库）。该漏洞已于 2025 年 1 月被 CodeRabbit 快速修复。

这个漏洞说明了一个根本性风险：**任何拥有你仓库代码审查权限的第三方 GitHub App，其自身的安全性都是你的攻击面**。

**实际使用的风险评估：**

| 场景 | 风险等级 | 建议 |
|---|---|---|
| 公开开源仓库 | 低 | 无顾虑，代码本来就是公开的 |
| 内部业务代码（非涉密） | 中 | 评估后可用，确认团队可接受代码离开内网 |
| 含核心算法 / 商业机密的代码 | 高 | 谨慎，建议走 CodeRabbit Enterprise（私有部署）或自研方案 |
| 含密钥、证书、个人数据的代码 | 极高 | 不应提交此类内容到任何仓库，与 CodeRabbit 无关 |

**如果对数据安全有顾虑的替代方案：**

- **自研 Claude API 方案**（本项目原来的 `ai-review.yml`）：代码只发给 Anthropic API，不经过任何第三方中间层，且 API 调用同样有零数据留存协议
- **CodeRabbit Enterprise**：支持私有化部署，代码不出内网
- **纯本地方案**：使用 `ollama` + 本地模型，代码完全不离开本机，但审查质量会下降

### 结论

对于大多数项目，**推荐直接使用 CodeRabbit + CodeQL 的组合**，放弃维护自研 AI Review workflow：

- CodeRabbit 负责行内建议、可读性卡点（通过 request changes）
- CodeQL 负责准确的安全漏洞检测（数据流分析）
- 自研 workflow 的唯一剩余价值是高度定制化的评分逻辑，但维护成本不低

---

## 未来可扩展的 Workflows

| Workflow | 功能 | 成熟方案 | 所需 Secret |
|---|---|---|---|
| `deploy.yml` | PR 自动部署预览环境，push main 部署生产 | [Vercel](https://vercel.com/docs/deployments/git/github) 原生 GitHub 集成，零配置 | `VERCEL_TOKEN` |
| `release.yml` | 根据 commit message 自动计算版本号、生成 CHANGELOG、打 Tag | [semantic-release](https://semantic-release.gitbook.io) + [conventional-changelog](https://github.com/conventional-changelog) | `NPM_TOKEN`（可选） |
| `performance.yml` | Bundle 体积检查 + Lighthouse 性能/可访问性/SEO 评分 | [size-limit](https://github.com/ai/size-limit) + [lighthouse-ci](https://github.com/GoogleChrome/lighthouse-ci) | 无 |
| `pr-hygiene.yml` | PR 标题强制符合 Conventional Commits，超 500 行自动警告 | [action-semantic-pull-request](https://github.com/amannn/action-semantic-pull-request) + [pr-size-labeler](https://github.com/CodelyTV/pr-size-labeler) | 无 |
| `stale.yml` | 自动标记并关闭长期无活动的 Issue / PR | [actions/stale](https://github.com/actions/stale) — GitHub 官方维护，直接用 | 无 |
| `e2e.yml` | 真实浏览器跑 Playwright，截图存档 | [Playwright GitHub Action](https://playwright.dev/docs/ci-intro) — 官方支持 CI | 无 |
| `docker.yml` | 构建镜像并推送到 GHCR | [docker/build-push-action](https://github.com/docker/build-push-action) — Docker 官方维护 | `DOCKER_TOKEN` |
| `notify.yml` | CI 失败 / PR 合并时推送通知 | [slackapi/slack-github-action](https://github.com/slackapi/slack-github-action) — Slack 官方维护 | `SLACK_WEBHOOK` |
| `dependency-update.yml` | 每周自动扫描过期依赖并提 PR | Dependabot — GitHub 原生，在 `.github/dependabot.yml` 配置即可，无需 Actions | 无 |
| `codeowners.yml` | 根据改动路径自动指定 Reviewer | `CODEOWNERS` 文件 — GitHub 原生支持，无需 Actions | 无 |

**优先级建议（按收益/成本比排序）：**

1. **`dependency-update.yml`（Dependabot）** — 最低成本，加一个配置文件就搞定，防止依赖 CVE 被动发现
2. **`pr-hygiene.yml`** — PR 标题规范是 `release.yml` 自动发版的前提，先把格式卡住
3. **`release.yml`** — semantic-release 配置完成后，版本管理和 CHANGELOG 全自动，适合有发布需求的项目
4. **`deploy.yml`（Vercel）** — 预览环境大幅降低 Review 成本，Reviewer 可以直接点链接验证

---

## 操作步骤：从零搭建

### 第一步：安装 CodeRabbit

1. 打开 [coderabbit.ai](https://coderabbit.ai)，用 GitHub 账号登录
2. 点击 **Add to GitHub** → 选择目标仓库 → 授权安装
3. 在仓库根目录创建 `.coderabbit.yml`（参考本仓库配置）

> ⚠️ `review_status` 必须是布尔值 `true` / `false`，写成字符串会静默失效

---

### 第二步：获取 CODECOV_TOKEN

1. 打开 [app.codecov.io](https://app.codecov.io)，用 GitHub 账号登录授权
2. 找到目标 repo → 进入 **Coverage** 设置页
3. 在 **Step 2** 找到 **Repository Upload Token**，复制该值（UUID 格式）

---

### 第三步：配置 GitHub Secrets

进入仓库 → **Settings → Secrets and variables → Actions → New repository secret**

| Secret 名称 | 值来源 | 用途 |
|---|---|---|
| `CODECOV_TOKEN` | codecov.io 仓库设置页 | 上传单测覆盖率报告 |

---

### 第四步：添加 Workflow 文件

在 `.github/workflows/` 目录下创建以下两个文件。

#### `ci.yml`

```yaml
name: CI

# 触发条件：
# - push 到 main / develop 主干分支时（保护主干质量基线）
# - 提 PR / 更新 PR 时（在合入前卡住问题）
on:
  push:
    branches: [main, develop]
  pull_request:

jobs:
  ci:
    name: Type Check / Lint / Unit Test
    runs-on: ubuntu-latest
    steps:
      # 拉取完整代码
      - uses: actions/checkout@v4

      # 安装 Node.js 20，启用 npm 缓存加速后续安装
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      # 严格按照 package-lock.json 安装依赖，确保 CI 环境与本地一致
      - run: npm ci

      # 类型检查：只做类型校验不产出编译产物，发现类型错误立即报错
      # --noEmit 不输出 JS 文件，纯做类型校验
      - name: Type check
        run: npx tsc --noEmit

      # Lint：零警告容忍（--max-warnings 0），有任何 ESLint warning 就 fail
      # 检查范围：src 目录下所有 .ts / .tsx 文件
      - name: Lint
        run: npx eslint src --ext ts,tsx --max-warnings 0

      # 单元测试 + 覆盖率：运行所有 vitest 测试，同时生成 coverage 报告
      # --coverage 输出 lcov 格式，供下一步上传 Codecov 使用
      - name: Unit tests
        run: npx vitest run --coverage

      # 上传覆盖率到 Codecov：PR 下会自动评论覆盖率差异（哪些新增代码没有被测试覆盖）
      # fail_ci_if_error: false 表示 Codecov 上传失败不影响 CI 整体结果
      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          token: ${{ secrets.CODECOV_TOKEN }}
          fail_ci_if_error: false
```

#### `security.yml`

```yaml
name: Security

# 触发条件：
# - PR 提交时：在代码合入前扫描，拦截新引入的漏洞
# - push 到 main 时：合入后再做一次全量确认
# - 每周一凌晨 2 点定时扫描：持续检测已有代码中的存量风险，
#   以及新公开的 CVE（即使代码没改，依赖漏洞库可能已更新）
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "0 2 * * 1"

# 最小化权限原则：
# - security-events: write  →  允许 CodeQL 将分析结果上传到 Security 面板
# - contents: read          →  只读代码，不赋予写入权限
permissions:
  security-events: write
  contents: read

jobs:
  # ── Job 1：依赖漏洞审计 ────────────────────────────────────────────
  # 扫描 package-lock.json 中所有依赖的已知 CVE
  # --audit-level=high 表示只有 high 及以上级别才报错（low/medium 只警告）
  # 扫描结果来自 npm 官方漏洞数据库，每日更新
  dependency-audit:
    name: Dependency Audit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm audit --audit-level=high

  # ── Job 2：CodeQL 静态分析 ─────────────────────────────────────────
  # GitHub 原生的语义级代码分析工具，做数据流分析（污点追踪）
  # 能追踪从 source（用户输入）到 sink（危险操作）的完整路径
  # 覆盖：XSS、SQL 注入、Open Redirect、路径遍历、postMessage 无 origin 校验等 100+ 种漏洞
  # 分析结果上传到仓库 Security and quality 面板，附带 Copilot Autofix 修复建议
  codeql:
    name: CodeQL Analysis
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # 初始化 CodeQL：指定分析语言为 TypeScript/JavaScript
      # queries: security-and-quality 同时启用安全漏洞 + 代码质量两类规则
      - uses: github/codeql-action/init@v3
        with:
          languages: javascript-typescript
          queries: security-and-quality

      # 自动构建：CodeQL 自动识别项目结构并完成必要的预处理
      - uses: github/codeql-action/autobuild@v3

      # 执行分析并将结果上传 Security 面板
      # category 用于区分多语言项目中不同语言的扫描结果
      - uses: github/codeql-action/analyze@v3
        with:
          category: /language:javascript-typescript

  # ── Job 3：密钥泄漏扫描 ───────────────────────────────────────────
  # Gitleaks 扫描完整 git 历史（fetch-depth: 0 拉取所有 commit）
  # 内置 100+ 种密钥格式的正则规则，覆盖：
  # AWS Access Key、Stripe Secret、JWT Secret、数据库密码、私钥文件等
  # 即使密钥已在后续 commit 中删除，历史记录中仍可检测到
  secret-scan:
    name: Secret Scan (Gitleaks)
    runs-on: ubuntu-latest
    steps:
      # fetch-depth: 0 拉取完整 git 历史，而非只拉最新一个 commit
      # 这样才能扫描到历史中曾经出现过的密钥
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

### 第五步：配置 Branch Protection（Ruleset）

进入仓库 → **Settings → Rules → Rulesets → New branch ruleset**

| 配置项 | 设置值 |
|---|---|
| Ruleset Name | `main` |
| Enforcement status | **Active** |
| Target branches | `main` |
| Required approvals | **1** |
| Required status checks | `coderabbitai` |
| Restrict deletions | ✅ 开启 |

配置完成后，所有 PR 在 CodeRabbit approve 之前 Merge 按钮均处于锁定状态。

---

### 第六步：安装本地依赖

```bash
npm install

npm install -D vitest @vitest/coverage-v8 eslint typescript \
  @typescript-eslint/parser @typescript-eslint/eslint-plugin
```

`package.json` 加上对应脚本：

```json
{
  "scripts": {
    "test": "vitest",
    "coverage": "vitest run --coverage",
    "lint": "eslint src --ext ts,tsx"
  }
}
```

---

### 第七步：验证完整流程

提交一个含安全漏洞的 PR，观察 CodeRabbit 是否触发 request changes 并锁定 Merge。

**预期效果：**

- CodeRabbit 在 PR 下自动发出 Walkthrough 和行内注释
- 发现 `severity: error` 的安全问题（SQL 注入 / XSS / 硬编码密钥等）→ 发出 request changes
- Branch Protection 生效 → Merge 按钮锁定，显示 "At least 1 approving review is required"
- CodeQL 在 Security and quality 面板上报具体 alert，附带 Copilot Autofix 修复建议

---

## 参考链接

- [CodeRabbit 文档](https://docs.coderabbit.ai) — 配置说明
- [CodeRabbit YAML 校验器](https://docs.coderabbit.ai/configuration/yaml-validator) — 避免配置解析错误
- [Codecov](https://app.codecov.io) — 覆盖率平台
- [GitHub Actions Marketplace](https://github.com/marketplace?type=actions) — 查找更多 Actions
- [Gitleaks](https://github.com/gitleaks/gitleaks-action) — 密钥扫描
- [CodeQL](https://codeql.github.com) — GitHub 原生静态分析
- [Semantic Release](https://semantic-release.gitbook.io) — 自动发版
- [Dependabot 配置](https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/configuring-dependabot-version-updates) — 依赖自动更新