import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import * as os from "os";

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

interface CRRules {
  gate?: { branch_overrides?: Record<string, string> };
  skip?: {
    paths?: string[];
    pr_title_keywords?: string[];
    min_diff_lines?: number;
  };
  quality?: {
    forbidden_patterns?: Array<{ pattern: string; message: string; severity: string }>;
    requirements?: string[];
  };
  security?: { extra_checks?: string[]; high_severity_cwe?: string[] };
  test?: { framework?: string; required_scenarios?: string[] };
  notify?: {
    manual_review_reminder?: { enabled?: boolean; message?: string };
  };
}

type Severity = "error" | "warning" | "info";
type CheckStatus = "pass" | "fail" | "warn" | "skip";

interface CheckItem {
  id: string;
  category: string;
  title: string;
  status: CheckStatus;
  severity: Severity;
  file?: string | null;
  line?: number | null;
  message: string;
  suggestion: string;
  cwe?: string | null;
  canSkip: boolean;
}

interface ReviewResult {
  checks: CheckItem[];
  passed: boolean;
  blockers: CheckItem[];
  warnings: CheckItem[];
}

// ─── 配置加载 ─────────────────────────────────────────────────────────────────

function loadRules(): CRRules {
  const candidates = [
    path.resolve(process.cwd(), "../../.cr-rules.yml"),
    path.resolve(process.cwd(), ".cr-rules.yml"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.error(`▶ 加载规则: ${p}`);
      return yaml.load(fs.readFileSync(p, "utf8")) as CRRules;
    }
  }
  console.error("▶ 使用默认规则（未找到 .cr-rules.yml）");
  return {};
}

// ─── 读取人工跳过的 ID ────────────────────────────────────────────────────────

function loadSkippedIds(): Set<string> {
  const skipFile = process.env.SKIP_IDS_FILE ?? `${os.tmpdir()}/skip_ids.txt`;
  if (!fs.existsSync(skipFile)) return new Set();
  const raw = fs.readFileSync(skipFile, "utf8").trim();
  return new Set(raw.split(/[\s,]+/).filter(Boolean));
}

// ─── JSON 安全解析 ────────────────────────────────────────────────────────────

function safeParseJSON<T>(raw: string, fallback: T): T {
  const cleaned = raw.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
  const isArray = cleaned.trimStart().startsWith("[");
  const start = isArray ? cleaned.indexOf("[") : cleaned.indexOf("{");
  const end = isArray ? cleaned.lastIndexOf("]") : cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) return fallback;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    console.error("JSON 解析失败:", cleaned.slice(0, 200));
    return fallback;
  }
}

// ─── Claude 调用 ──────────────────────────────────────────────────────────────

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MAX_DIFF = 10_000;

async function callClaude(system: string, user: string): Promise<string> {
  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: user }],
  });
  return msg.content.filter(b => b.type === "text").map(b => (b as {type:"text";text:string}).text).join("");
}

// ─── 四个维度 Checklist 审查 ──────────────────────────────────────────────────

const ITEM_SCHEMA = `[
  {
    "id": "<分类前缀-序号，如 CQ-001>",
    "category": "<分类名>",
    "title": "<检查项名称>",
    "status": "fail|warn|pass",
    "severity": "error|warning|info",
    "file": "<文件名或null>",
    "line": <行号数字或null>,
    "message": "<具体问题描述>",
    "suggestion": "<具体修复建议>",
    "cwe": "<CWE-xxx或null>",
    "canSkip": true
  }
]`;

async function checkQuality(diff: string, rules: CRRules): Promise<CheckItem[]> {
  const forbidden = (rules.quality?.forbidden_patterns ?? [])
    .map(r => `- 禁止「${r.pattern}」: ${r.message}（${r.severity}）`).join("\n");
  const requirements = (rules.quality?.requirements ?? []).map(r => `- ${r}`).join("\n");
  const raw = await callClaude(
    "你是资深 TypeScript/JavaScript 工程师。只返回 JSON 数组，不要任何 markdown 或说明文字。",
    `检查代码质量，ID 前缀 CQ-。范围：逻辑错误、类型安全(any滥用)、命名规范、函数过长(>200行)、空catch块、缺少错误处理、死代码。
${forbidden ? `\n额外禁止规则：\n${forbidden}` : ""}
${requirements ? `\n强制要求：\n${requirements}` : ""}
返回格式：${ITEM_SCHEMA}
无问题时返回 []。
Diff：${diff}`
  );
  return safeParseJSON<CheckItem[]>(raw, []);
}

async function checkSecurity(diff: string, rules: CRRules): Promise<CheckItem[]> {
  const extra = (rules.security?.extra_checks ?? []).map(c => `- ${c}`).join("\n");
  const raw = await callClaude(
    "你是应用安全工程师，专注 Node.js/TypeScript 审计。只返回 JSON 数组，不要任何 markdown 或说明文字。",
    `检查安全漏洞，ID 前缀 CS-。canSkip 安全问题设为 false。
范围：SQL注入、硬编码密钥/密码/token、弱加密(MD5/SHA1用于密码)、eval执行用户输入、路径遍历、缺少权限校验、XSS、原型污染、ReDoS、JWT无过期。
高危漏洞(SQL注入/eval/硬编码密钥)标为 status:fail severity:error canSkip:false。
${extra ? `\n额外安全规则：\n${extra}` : ""}
返回格式：${ITEM_SCHEMA}
无问题时返回 []。
Diff：${diff}`
  );
  const items = safeParseJSON<CheckItem[]>(raw, []);
  // 强制安全项不可跳过
  return items.map(i => ({ ...i, canSkip: i.severity !== "error" }));
}

async function checkTest(diff: string, rules: CRRules): Promise<CheckItem[]> {
  const framework = rules.test?.framework ?? "vitest";
  const scenarios = (rules.test?.required_scenarios ?? ["正常流程", "边界值(空值/null)", "异常处理"]).map(s => `- ${s}`).join("\n");
  const raw = await callClaude(
    `你是 QA 工程师，熟悉 ${framework}。只返回 JSON 数组，不要任何 markdown 或说明文字。`,
    `检查测试覆盖，ID 前缀 CT-。
范围：新增导出函数是否有测试、必要场景：\n${scenarios}\n外部依赖是否有 mock。
suggestion 中给出具体 ${framework} 测试用例代码示例。
返回格式：${ITEM_SCHEMA}
无问题时返回 []。
Diff：${diff}`
  );
  return safeParseJSON<CheckItem[]>(raw, []);
}

async function checkImpact(diff: string, _rules: CRRules): Promise<CheckItem[]> {
  const raw = await callClaude(
    "你是软件架构师。只返回 JSON 数组，不要任何 markdown 或说明文字。",
    `检查变更影响，ID 前缀 CI-。只报告有实际风险的项。
范围：Breaking Change、影响核心模块、API契约变更、性能风险(N+1/大循环)、依赖版本变更。
返回格式：${ITEM_SCHEMA}
无风险时返回 []。
Diff：${diff}`
  );
  return safeParseJSON<CheckItem[]>(raw, []);
}

// ─── 构建汇总 PR Comment ──────────────────────────────────────────────────────

function buildSummaryComment(result: ReviewResult, skippedIds: Set<string>): string {
  const { checks, passed, blockers, warnings } = result;
  const skipped = checks.filter(c => skippedIds.has(c.id));
  const allFail = checks.filter(c => c.status === "fail" && !skippedIds.has(c.id));
  const allWarn = checks.filter(c => c.status === "warn" && !skippedIds.has(c.id));
  const allPass = checks.filter(c => c.status === "pass");

  const icon = (c: CheckItem) => {
    if (skippedIds.has(c.id)) return "⏭";
    if (c.status === "fail") return c.severity === "error" ? "❌" : "🔴";
    if (c.status === "warn") return "⚠️";
    return "✅";
  };

  // Checklist 按分类分组
  const byCategory = checks.reduce<Record<string, CheckItem[]>>((acc, c) => {
    (acc[c.category] = acc[c.category] ?? []).push(c); return acc;
  }, {});

  const checklistMd = Object.entries(byCategory).map(([cat, items]) => {
    const rows = items.map(c => {
      const skippedTag = skippedIds.has(c.id) ? " ~~(已人工跳过)~~" : "";
      const loc = c.file ? `\`${c.file}${c.line ? `:${c.line}` : ""}\`` : "";
      const checked = c.status === "pass" || skippedIds.has(c.id);
      return `- [${checked ? "x" : " "}] ${icon(c)} **${c.id}** ${c.title}${skippedTag}${loc ? ` — ${loc}` : ""}`;
    }).join("\n");
    return `### ${cat}\n${rows}`;
  }).join("\n\n");

  // 问题明细 Table
  const problemItems = [...allFail, ...allWarn];
  const tableRows = problemItems.map(c => {
    const loc = c.file ? `\`${c.file}${c.line ? `:${c.line}` : ""}\`` : "—";
    const cwe = c.cwe ? ` \`${c.cwe}\`` : "";
    const skipOp = c.canSkip ? `\`/skip-check ${c.id}\`` : "**不可跳过**";
    return `| ${icon(c)} | \`${c.id}\` | ${c.title} | ${loc}${cwe} | ${c.message} | ${c.suggestion} | ${skipOp} |`;
  }).join("\n");

  const table = problemItems.length
    ? `| 状态 | ID | 检查项 | 位置 | 问题 | 修复建议 | 操作 |\n|---|---|---|---|---|---|---|\n${tableRows}`
    : "_无需处理的问题_ ✅";

  const skippableIds = checks
    .filter(c => c.canSkip && c.status !== "pass" && !skippedIds.has(c.id))
    .map(c => `\`${c.id}\``).join("、");

  const gateLabel = passed ? "✅ 通过 — 允许合并" : "❌ 未通过 — 阻断合并";
  const statusLine = blockers.length > 0
    ? "> 🚨 存在阻断项，请修复后重新提交"
    : warnings.length > 0
    ? "> ⚠️ 存在警告项，建议处理后合并"
    : "> ✅ 所有检查项已通过，可以合并";

  return `## 🤖 AI Code Review — Checklist Report

> **Gate: ${gateLabel}**
${statusLine}

**统计：** ❌ ${allFail.length} 个失败 · ⚠️ ${allWarn.length} 个警告 · ✅ ${allPass.length} 个通过${skipped.length > 0 ? ` · ⏭ ${skipped.length} 个已跳过` : ""}

---

## ✅ Checklist

${checklistMd}

---

## 📋 问题明细

${table}

---

<details>
<summary>📖 人工跳过指南</summary>

如需跳过某个检查项，在 PR comment 中回复：

\`\`\`
/skip-check CQ-001
/skip-check CQ-001 CT-002 CI-001
\`\`\`

> ⚠️ 安全类检查项（CS-xxx）标记为不可跳过，需 Tech Lead 审批后方可。

当前可跳过的检查项：${skippableIds || "无"}

</details>

---
_由 [AI Review Gate](/.github/workflows/ai-review.yml) 生成_`;
}

// ─── 构建行内评论 ─────────────────────────────────────────────────────────────

interface InlineComment { path: string; line: number; body: string; }

function buildInlineComments(checks: CheckItem[], skippedIds: Set<string>): InlineComment[] {
  return checks
    .filter(c => c.file && c.line && c.status !== "pass" && !skippedIds.has(c.id))
    .map(c => ({
      path: c.file!.replace(/^[ab]\//, ""),
      line: c.line!,
      body: [
        `**${c.status === "fail" ? "❌" : "⚠️"} [${c.id}] ${c.title}**`,
        ``,
        `**问题：** ${c.message}`,
        ``,
        `**建议：** ${c.suggestion}`,
        c.cwe ? `\n**CWE：** ${c.cwe}` : null,
        c.canSkip
          ? `\n> 如需跳过，在 PR comment 回复 \`/skip-check ${c.id}\``
          : `\n> ⚠️ 此项为安全问题，**不建议跳过**`,
      ].filter(l => l !== null).join("\n"),
    }));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rules = loadRules();
  const skippedIds = loadSkippedIds();
  const diff = fs.readFileSync(process.env.DIFF_PATH ?? `${os.tmpdir()}/pr.diff`, "utf8").slice(0, MAX_DIFF);

  if (diff.trim().length < 10) {
    fs.writeFileSync(`${os.tmpdir()}/gate_passed.txt`, "true");
    fs.writeFileSync(`${os.tmpdir()}/pr_comment.md`, "_无代码变更，跳过审查_");
    fs.writeFileSync(`${os.tmpdir()}/inline_comments.json`, "[]");
    return;
  }

  console.error("▶ 并行运行四个检查维度…");
  const [qualityChecks, securityChecks, testChecks, impactChecks] = await Promise.all([
    checkQuality(diff, rules),
    checkSecurity(diff, rules),
    checkTest(diff, rules),
    checkImpact(diff, rules),
  ]);

  let allChecks: CheckItem[] = [...qualityChecks, ...securityChecks, ...testChecks, ...impactChecks];
  allChecks = allChecks.map(c => skippedIds.has(c.id) ? { ...c, status: "skip" as CheckStatus } : c);

  const active = allChecks.filter(c => !skippedIds.has(c.id));
  const blockers = active.filter(c => c.status === "fail" && c.severity === "error");
  const warnings = active.filter(c => c.status === "warn" || (c.status === "fail" && c.severity === "warning"));
  const passed = blockers.length === 0;

  const result: ReviewResult = { checks: allChecks, passed, blockers, warnings };
  fs.writeFileSync(`${os.tmpdir()}/pr_comment.md`, buildSummaryComment(result, skippedIds));
  fs.writeFileSync(`${os.tmpdir()}/inline_comments.json`, JSON.stringify(buildInlineComments(allChecks, skippedIds), null, 2));
  fs.writeFileSync(`${os.tmpdir()}/gate_passed.txt`, String(passed));

  console.log(JSON.stringify({ passed, total: allChecks.length, blockers: blockers.length, warnings: warnings.length, skipped: skippedIds.size }));
}

main().catch(e => { console.error("AI review error:", e); process.exit(1); });
