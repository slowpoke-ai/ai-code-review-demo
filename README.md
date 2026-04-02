# AI 辅助 GitHub PR 卡点 + CI/CD 完整搭建指南

> 仓库：[slowpoke-ai/ai-code-review-demo](https://github.com/slowpoke-ai/ai-code-review-demo)  
> 技术栈：TypeScript · GitHub Actions · Claude (Anthropic) · Codecov · Gitleaks · CodeQL

---

## 目录

1. [整体架构](#整体架构)
2. [Workflow 功能说明](#workflow-功能说明)
3. [未来可扩展的 Workflows](#未来可扩展的-workflows)
4. [操作步骤：从零搭建](#操作步骤从零搭建)

---

## 整体架构

```
提 PR / push
     │
     ├── 🤖 ai-review.yml   AI 代码审查（4维度并行）→ 综合评分 < 70 阻断 Merge
     ├── 🔍 ci.yml          类型检查 → ESLint → Vitest 单测 → Codecov 覆盖率
     └── 🛡 security.yml    npm audit → CodeQL 静态分析 → Gitleaks 密钥扫描
                             （每周一凌晨 2 点也会定时全量扫描）
```

**卡点决策逻辑：**

```
四个维度评分（0-100）→ 计算综合均分
综合分 ≥ 70  →  ✅ Check 通过，允许 Merge
综合分 < 70  →  ❌ Check 失败，阻断 Merge，bot 自动在 PR 下发评论报告
```

---

## Workflow 功能说明

### 🤖 ai-review.yml — AI 代码审查卡点

**触发条件：** PR 提交 / 更新时自动触发

调用 Claude API 对 PR 的代码 diff 进行四个维度并行审查：

| 维度 | 检查内容 |
|---|---|
| 🔍 代码质量 | 逻辑错误、类型安全、命名规范、代码复杂度、死代码、错误处理缺失 |
| 🛡 安全漏洞 | SQL 注入、硬编码密钥、弱加密算法（MD5/SHA1）、eval 使用、路径遍历、缺少权限校验 |
| 🧪 测试覆盖 | 新增函数/分支缺少测试、未覆盖边界条件、缺少 Mock、建议具体测试用例 |
| 📊 变更影响 | 影响模块范围、API 契约变更、Breaking Change、性能影响、依赖风险 |

### 评分机制

分数由 **Claude 模型直接给出**，而非预设规则计算。每个维度的 prompt 要求模型返回 0-100 的整数分，模型根据 diff 内容自行判断严重程度：

| 维度 | 高分（80-100）| 中分（50-79）| 低分（0-49）|
|---|---|---|---|
| 🔍 代码质量 | 代码清晰、类型安全、有错误处理 | 有小问题但不影响功能 | 逻辑错误、滥用 any、无错误处理 |
| 🛡 安全漏洞 | 无已知漏洞 | 有低危问题 | SQL 注入、RCE、硬编码密钥等高危漏洞 |
| 🧪 测试覆盖 | 新增代码有充分测试 | 部分测试但不完整 | 完全没有测试 |
| 📊 变更影响 | 改动范围小、风险低 | 有影响但可控 | Breaking Change、影响核心模块 |

**综合分计算（四个维度权重相同）：**

```
综合分 = (代码质量分 + 安全分 + 测试分 + 影响分) / 4

综合分 ≥ 70 → ✅ 允许 Merge
综合分 < 70 → ❌ 阻断 Merge
```

阈值可直接通过环境变量调整，无需改代码：

```yaml
env:
  GATE_THRESHOLD: "70"  # 改成 80 更严格，改成 60 更宽松
```

**真实案例分析（`userController.ts`，综合分 65）：**

```
代码质量：~75  → 结构基本清晰，但有 any 类型、缺少错误处理
安全漏洞：~35  → 4处SQL注入 + 硬编码密钥 + MD5弱加密 + eval RCE
测试覆盖：~70  → 新增 8 个函数，零测试
变更影响：~80  → 改动集中，未波及其他模块

综合均分：(75 + 35 + 70 + 80) / 4 ≈ 65 → ❌ 未达阈值 70
```

安全维度的 35 分直接把综合分拉至阈值以下——**单个高危维度足以卡住整个 PR**，这正是设计意图。

**评分的局限性：**

| 问题 | 说明 |
|---|---|
| 评分有轻微波动 | 同一段代码多次调用可能有 ±5 分差异，属正常现象 |
| Diff 过大会截断 | 超过 10k 字符的 diff 被截断，建议大 PR 拆小提交 |
| 缺乏业务上下文 | AI 只能基于 diff 判断，看不到完整代码库 |
| 需配合人工 Review | 小而精的 PR 可能通过，不能完全替代人工审查 |

---

**实际效果：**

审查通过后 `github-actions bot` 自动在 PR 下发出完整报告，并设置 Check 状态。综合评分不足 70 分时 Merge 按钮锁定：

```
🤖 AI PR Review Report

Gate: ❌ FAILED — merge blocked — composite score 65/100 (threshold 70)

### ❌ Security · 45/100
发现多个高危漏洞，包括 SQL 注入和硬编码密钥

| Sev | Location | CWE | Issue | Fix |
|---|---|---|---|---|
| 🔴 high | userController.ts:21 | CWE-89 | SQL 注入：userId 直接拼接查询 | 使用参数化查询 $1,$2 |
| 🔴 high | userController.ts:9  | CWE-798 | 硬编码数据库密码 | 改用环境变量 process.env |
| 🔴 high | userController.ts:55 | CWE-95  | eval() 执行用户输入，RCE 风险 | 禁止使用 eval，改用白名单 |
| 🔴 high | userController.ts:62 | CWE-22  | 路径遍历：filename 未过滤 | 使用 path.basename 限制 |
```

---

### 🔍 ci.yml — 基础 CI

**触发条件：** push 到 main/develop 分支，或提 PR 时

| 步骤 | 工具 | 作用 |
|---|---|---|
| 类型检查 | `tsc --noEmit` | 发现 TypeScript 类型错误，编译前拦截 |
| Lint | `eslint --max-warnings 0` | 代码规范检查，零警告容忍 |
| 单元测试 | `vitest run --coverage` | 运行所有测试用例并生成覆盖率报告 |
| 覆盖率上传 | `codecov/codecov-action` | 上传报告到 Codecov，PR 下自动展示覆盖率差异 |

**实际效果：** 每次 PR 会在 Checks 面板显示四个步骤的通过状态，覆盖率下降时 Codecov bot 自动评论差异数据，帮助发现哪些新增代码没有被测试覆盖。

---

### 🛡 security.yml — 安全扫描

**触发条件：** PR、push main，以及每周一凌晨 2 点定时全量扫描

**三个并行 Job：**

| Job | 工具 | 检测内容 |
|---|---|---|
| 依赖审计 | `npm audit --audit-level=high` | 扫描所有依赖的已知 CVE 漏洞，high 以上报错 |
| CodeQL 静态分析 | `github/codeql-action` | XSS、SQL 注入、路径遍历等 100+ 种漏洞模式，结果上传 Security 面板 |
| 密钥泄露扫描 | `gitleaks/gitleaks-action` | 扫描完整 git 历史，检测 AWS Key、JWT Secret、数据库密码等 100+ 种密钥格式 |

**实际效果：** CodeQL 结果会显示在仓库 **Security and quality** 页面，形成持续的安全基线。Gitleaks 扫描历史 commit，防止密钥被意外提交后无人察觉。

---

## 未来可扩展的 Workflows

| Workflow 文件 | 功能 | 触发时机 | 核心 Action | 需要的 Secret |
|---|---|---|---|---|
| `deploy.yml` | PR 自动部署预览环境，push main 部署生产，评论预览 URL | PR / push main | `amondnet/vercel-action` | `VERCEL_TOKEN` |
| `release.yml` | 根据 commit message 自动计算版本号，生成 CHANGELOG，打 Tag | push main | `semantic-release` | `NPM_TOKEN`（可选）|
| `performance.yml` | 检查 Bundle 体积变化防止包膨胀，Lighthouse 跑性能/可访问性/SEO 评分 | PR | `andresz1/size-limit-action`、`treosh/lighthouse-ci-action` | 无 |
| `pr-hygiene.yml` | PR 标题强制符合 Conventional Commits，PR 超 500 行变更自动警告拆分 | PR | `amannn/action-semantic-pull-request`、`CodelyTV/pr-size-labeler` | 无 |
| `stale.yml` | 自动标记并关闭长期无活动的 Issue（30天）和 PR（14天） | 每天定时 | `actions/stale` | 无 |
| `e2e.yml` | 端对端测试，真实浏览器跑 Playwright/Cypress，截图存档 | PR | `microsoft/playwright-github-action` | 无 |
| `docker.yml` | 构建 Docker 镜像并推送到 Docker Hub / GHCR | push main / tag | `docker/build-push-action` | `DOCKER_TOKEN` |
| `notify.yml` | CI 失败 / PR 合并时推送 Slack / 钉钉 / 企业微信通知 | workflow_run | `slackapi/slack-github-action` | `SLACK_WEBHOOK` |
| `dependency-update.yml` | 每周自动扫描过期依赖并提 PR 更新，减少手动维护成本 | 每周定时 | Renovate / Dependabot（GitHub 原生）| 无 |
| `codeowners.yml` | 根据改动文件路径自动指定 Reviewer，无需手动 assign | PR | `actions/github-script` + CODEOWNERS 文件 | 无 |

---

## 操作步骤：从零搭建

### 第一步：获取 Anthropic API Key

1. 打开 [console.anthropic.com](https://console.anthropic.com)，登录账号
2. 左侧菜单点击 **API Keys → Create Key**，填写名称（如 `github-ai-review`）
3. **立刻复制**生成的 Key（格式：`sk-ant-api03-xxx`），关闭弹窗后无法再查看

> ⚠️ 新账号附赠 $5 免费额度，每次 AI Review 消耗约 $0.01~0.03

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
| `ANTHROPIC_API_KEY` | Anthropic Console | AI 代码审查调用 Claude API |
| `CODECOV_TOKEN` | codecov.io 仓库设置页 | 上传单测覆盖率报告 |

**配置完成后效果：**

![Secrets 配置页面](secrets-config)
> Repository secrets 页面显示两个 Secret 均已配置，状态为加密存储

---

### 第四步：配置分支保护规则

进入仓库 → **Settings → Rules → Rulesets → 新建或编辑 Ruleset**

| 配置项 | 设置值 |
|---|---|
| Ruleset Name | `main` |
| Enforcement status | **Active** |
| Target branches | `main` |
| Required Status Checks | `AI Code Review` |

**配置完成后效果：**

![分支保护规则](ruleset-config)
> Ruleset 显示 Active 状态，Target branch 锁定 `main`，Applies to 1 target  
> PR 的 Merge 按钮变灰，直到 AI Code Review Check 通过才能点击

---

### 第五步：添加 Workflow 文件

在 `.github/workflows/` 目录下创建以下三个文件。

#### `ai-review.yml`

```yaml
name: AI PR Review Gate

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  pull-requests: write
  checks: write
  contents: read

jobs:
  ai-review:
    name: AI Code Review
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install dependencies
        run: cd .github/scripts && npm install
      - name: Get PR diff
        run: |
          git fetch origin ${{ github.base_ref }}
          git diff origin/${{ github.base_ref }}...HEAD > /tmp/pr.diff
      - name: Run AI review
        working-directory: .github/scripts
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          DIFF_PATH: /tmp/pr.diff
          GATE_THRESHOLD: "70"
        run: node --loader ts-node/esm review.ts
      - name: Post PR comment
        if: always()
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            if (!fs.existsSync('/tmp/pr_comment.md')) process.exit(0);
            const body = fs.readFileSync('/tmp/pr_comment.md', 'utf8');
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body,
            });
      - name: Enforce gate
        run: |
          SCORE=$(cat /tmp/gate_score.txt 2>/dev/null || echo "0")
          PASSED=$(cat /tmp/gate_passed.txt 2>/dev/null || echo "false")
          echo "Composite score: $SCORE / 100"
          if [ "$PASSED" = "false" ]; then
            echo "AI review gate FAILED (score=$SCORE, threshold=70)"
            exit 1
          fi
```

#### `ci.yml`

```yaml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:

jobs:
  ci:
    name: Type Check / Lint / Unit Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - name: Type check
        run: npx tsc --noEmit
      - name: Lint
        run: npx eslint src --ext ts,tsx --max-warnings 0
      - name: Unit tests
        run: npx vitest run --coverage
      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          token: ${{ secrets.CODECOV_TOKEN }}
          fail_ci_if_error: false
```

#### `security.yml`

```yaml
name: Security

on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "0 2 * * 1"

permissions:
  security-events: write
  contents: read

jobs:
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

  codeql:
    name: CodeQL Analysis
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with:
          languages: javascript-typescript
          queries: security-and-quality
      - uses: github/codeql-action/autobuild@v3
      - uses: github/codeql-action/analyze@v3
        with:
          category: /language:javascript-typescript

  secret-scan:
    name: Secret Scan (Gitleaks)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

### 第六步：本地安装依赖

```bash
# 拉取最新代码
git pull origin main

# 项目依赖
npm install

# CI 需要的开发依赖
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

**验证方式：** 提交一个含安全漏洞的 PR，观察 AI Review 是否自动触发并阻断 Merge。

**Actions 运行总览效果：**

![Actions 总览](actions-overview)
> 左侧菜单显示三个已注册 Workflow：AI PR Review Gate、CI、Security  
> 每次 push 或 PR 都自动触发，列表展示所有历史运行记录和状态

**PR 卡点效果：**

![PR AI Review 结果](pr-review-result)
> - `github-actions bot` 在 PR 下自动发出审查报告
> - 综合评分 65/100 < 阈值 70 → Gate FAILED → Merge 按钮锁定
> - 开发者修复代码重新 push 后重新触发审查，直到通过为止

---

## 参考链接

- [Anthropic Console](https://console.anthropic.com) — 获取 API Key
- [Codecov](https://app.codecov.io) — 覆盖率平台
- [GitHub Actions Marketplace](https://github.com/marketplace?type=actions) — 查找更多 Actions
- [Gitleaks](https://github.com/gitleaks/gitleaks-action) — 密钥扫描
- [CodeQL](https://codeql.github.com) — GitHub 原生静态分析
- [Semantic Release](https://semantic-release.gitbook.io) — 自动发版