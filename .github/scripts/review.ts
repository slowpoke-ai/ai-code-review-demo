import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

// ─── 类型定义 ─────────────────────────────────────────────────────────────────
interface CRRules {
  gate?: {
    threshold?: number;
    branch_overrides?: Record<string, number>;
  };
  weights?: {
    quality?: number;
    security?: number;
    test?: number;
    impact?: number;
  };
  veto?: {
    enabled?: boolean;
    rules?: Record<string, number>;
  };
  skip?: {
    paths?: string[];
    pr_title_keywords?: string[];
    min_diff_lines?: number;
  };
  quality?: {
    forbidden_patterns?: Array<{ pattern: string; message: string; severity: string }>;
    requirements?: string[];
  };
  security?: {
    extra_checks?: string[];
    high_severity_cwe?: string[];
  };
  test?: {
    min_coverage?: number;
    require_test_for_new_functions?: boolean;
    framework?: string;
    required_scenarios?: string[];
  };
  notify?: {
    manual_review_reminder?: {
      enabled?: boolean;
      score_range?: [number, number];
      message?: string;
    };
    mention_on_high_severity?: {
      enabled?: boolean;
      users?: string[];
    };
  };
}

interface Issue {
  severity: "high" | "medium" | "low";
  file?: string | null;
  line?: string | null;
  message: string;
  suggestion?: string | null;
  cwe?: string | null;
}

interface DimensionResult {
  score: number;
  summary: string;
  issues: Issue[];
  riskLevel?: "low" | "medium" | "high";
}

// ─── 配置加载 ─────────────────────────────────────────────────────────────────
function loadRules(): CRRules {
  const rulePaths = [
    path.join(process.cwd(), "../../.cr-rules.yml"),  // 项目根目录
    path.join(process.cwd(), ".cr-rules.yml"),
  ];
  for (const p of rulePaths) {
    if (fs.existsSync(p)) {
      console.error(`▶ 加载自定义规则: ${p}`);
      return yaml.load(fs.readFileSync(p, "utf8")) as CRRules;
    }
  }
  console.error("▶ 未找到 .cr-rules.yml，使用默认配置");
  return {};
}

// ─── 阈值计算（支持按分支覆盖）────────────────────────────────────────────────
function resolveThreshold(rules: CRRules): number {
  const baseBranch = process.env.BASE_BRANCH ?? "";
  const overrides = rules.gate?.branch_overrides ?? {};
  // 精确匹配
  if (overrides[baseBranch] !== undefined) return overrides[baseBranch];
  // 通配符匹配（如 feat/*）
  for (const [pattern, val] of Object.entries(overrides)) {
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
      if (regex.test(baseBranch)) return val;
    }
  }
  return rules.gate?.threshold ?? parseInt(process.env.GATE_THRESHOLD ?? "70", 10);
}

// ─── 权重计算 ─────────────────────────────────────────────────────────────────
function calcComposite(
  scores: { quality: number; security: number; test: number; impact: number },
  weights: CRRules["weights"]
): number {
  const w = {
    quality:  weights?.quality  ?? 25,
    security: weights?.security ?? 40,
    test:     weights?.test     ?? 20,
    impact:   weights?.impact   ?? 15,
  };
  const total = w.quality + w.security + w.test + w.impact;
  return Math.round(
    (scores.quality  * w.quality  +
     scores.security * w.security +
     scores.test     * w.test     +
     scores.impact   * w.impact) / total
  );
}

// ─── 一票否决检查 ─────────────────────────────────────────────────────────────
function checkVeto(
  scores: { quality: number; security: number; test: number; impact: number },
  rules: CRRules
): { vetoed: boolean; reason: string } {
  if (!rules.veto?.enabled) return { vetoed: false, reason: "" };
  for (const [dim, minScore] of Object.entries(rules.veto.rules ?? {})) {
    const actual = scores[dim as keyof typeof scores];
    if (actual < minScore) {
      return {
        vetoed: true,
        reason: `**${dim}** 维度评分 ${actual} 低于一票否决阈值 ${minScore}，直接阻断 Merge`,
      };
    }
  }
  return { vetoed: false, reason: "" };
}

// ─── JSON 安全解析 ────────────────────────────────────────────────────────────
function safeParseJSON(raw: string): DimensionResult {
  let cleaned = raw.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(cleaned) as DimensionResult;
  } catch {
    console.error("JSON parse failed, raw:", raw.slice(0, 300));
    return { score: 50, summary: "解析失败，建议人工复核", issues: [] };
  }
}

// ─── AI 调用 ──────────────────────────────────────────────────────────────────
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MAX_DIFF = 10_000;

async function reviewDimension(
  role: string,
  task: string,
  diff: string,
  extraFields = ""
): Promise<DimensionResult> {
  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    system: `你是${role}。你必须只返回合法的 JSON 对象，不能有 markdown、代码块或任何说明文字，直接以 { 开头，以 } 结尾。`,
    messages: [{
      role: "user",
      content: `${task}

返回 JSON 对象（严格格式，无多余字段）:
{
  "score": <0-100 整数>,
  "summary": "<一句话总结>",
  ${extraFields}
  "issues": [
    {
      "severity": "high|medium|low",
      "file": "<文件名或 null>",
      "line": "<行号或 null>",
      "message": "<问题描述>",
      "suggestion": "<具体修复建议>"
    }
  ]
}

代码 Diff：
${diff}`,
    }],
  });
  const raw = msg.content.filter(b => b.type === "text").map(b => (b as { type: "text"; text: string }).text).join("");
  return safeParseJSON(raw);
}

// ─── 四个维度审查 ─────────────────────────────────────────────────────────────
async function reviewQuality(diff: string, rules: CRRules) {
  const forbidden = (rules.quality?.forbidden_patterns ?? [])
    .map(r => `- 禁止模式「${r.pattern}」：${r.message}（${r.severity}）`)
    .join("\n");
  const requirements = (rules.quality?.requirements ?? [])
    .map(r => `- ${r}`).join("\n");
  return reviewDimension(
    "资深 TypeScript/JavaScript 工程师，负责代码审查",
    `审查代码质量：逻辑错误、类型安全、命名规范、复杂度、死代码、错误处理。
${forbidden ? `\n【额外禁止规则】\n${forbidden}` : ""}
${requirements ? `\n【强制要求】\n${requirements}` : ""}`,
    diff.slice(0, MAX_DIFF)
  );
}

async function reviewSecurity(diff: string, rules: CRRules) {
  const extraChecks = (rules.security?.extra_checks ?? [])
    .map(c => `- ${c}`).join("\n");
  return reviewDimension(
    "应用安全工程师，专注 Node.js/TypeScript 安全审计",
    `扫描安全漏洞：SQL 注入、硬编码密钥、弱加密、eval、路径遍历、权限缺失、XSS、原型污染。
${extraChecks ? `\n【额外安全规则】\n${extraChecks}` : ""}`,
    diff.slice(0, MAX_DIFF),
    '"cwe": "<CWE-xxx 或 null>",'
  );
}

async function reviewTest(diff: string, rules: CRRules) {
  const framework = rules.test?.framework ?? "vitest";
  const scenarios = (rules.test?.required_scenarios ?? [])
    .map(s => `- ${s}`).join("\n");
  return reviewDimension(
    `QA 工程师，熟悉 ${framework} 测试框架`,
    `分析测试覆盖：新增函数/分支是否有对应测试，边界值是否覆盖，建议具体的 ${framework} 测试用例。
${scenarios ? `\n【必须覆盖的场景】\n${scenarios}` : ""}
${rules.test?.require_test_for_new_functions ? "\n【强制要求】所有新增导出函数必须有对应测试" : ""}`,
    diff.slice(0, MAX_DIFF)
  );
}

async function reviewImpact(diff: string, _rules: CRRules) {
  return reviewDimension(
    "软件架构师，负责变更影响评估",
    "分析变更影响：涉及的模块范围、API 契约变化、Breaking Change、性能影响、依赖风险。",
    diff.slice(0, MAX_DIFF),
    '"riskLevel": "low|medium|high",'
  );
}

// ─── PR Comment 生成 ──────────────────────────────────────────────────────────
function sevEmoji(s: string) {
  return s === "high" ? "🔴" : s === "medium" ? "🟡" : "🟢";
}

function scoreBar(s: number, threshold: number) {
  return s >= 80 ? "✅" : s >= threshold ? "⚠️" : "❌";
}

function issueTable(issues: Issue[], showCwe = false): string {
  if (!issues?.length) return "_未发现问题_\n";
  const header = showCwe
    ? "| 等级 | 位置 | CWE | 问题 | 修复建议 |\n|---|---|---|---|---|"
    : "| 等级 | 位置 | 问题 | 修复建议 |\n|---|---|---|---|";
  const rows = issues.map(i => {
    const loc = `${i.file ?? ""}:${i.line ?? ""}`.replace(/^:|:$/, "") || "—";
    const cweCol = showCwe ? ` ${i.cwe ?? "—"} |` : "";
    return `| ${sevEmoji(i.severity)} ${i.severity} | \`${loc}\` |${cweCol} ${i.message} | ${i.suggestion ?? "—"} |`;
  }).join("\n");
  return `${header}\n${rows}\n`;
}

function buildComment(params: {
  quality: DimensionResult;
  security: DimensionResult;
  test: DimensionResult;
  impact: DimensionResult;
  composite: number;
  passed: boolean;
  vetoed: boolean;
  vetoReason: string;
  threshold: number;
  rules: CRRules;
  weights: Required<NonNullable<CRRules["weights"]>>;
}): string {
  const { quality, security, test, impact, composite, passed, vetoed, vetoReason, threshold, rules, weights } = params;
  const gateIcon = passed ? "✅" : "❌";
  const gateLabel = passed ? "PASSED — 允许合并" : "FAILED — 阻断合并";

  const manualReminder = (() => {
    const r = rules.notify?.manual_review_reminder;
    if (!r?.enabled || !r.score_range) return "";
    const [lo, hi] = r.score_range;
    if (composite >= lo && composite <= hi) return `\n> ${r.message ?? "建议人工复核"}\n`;
    return "";
  })();

  return `## 🤖 AI PR Review Report

> **Gate: ${gateIcon} ${gateLabel}** — 综合评分 **${composite}/100**（阈值 ${threshold}）
${vetoed ? `\n> ⛔ **一票否决**：${vetoReason}\n` : ""}${manualReminder}
---

### ${scoreBar(quality.score, threshold)} 代码质量 · ${quality.score}/100（权重 ${weights.quality}%）
${quality.summary}

${issueTable(quality.issues)}

---

### ${scoreBar(security.score, threshold)} 安全漏洞 · ${security.score}/100（权重 ${weights.security}%）
${security.summary}

${issueTable(security.issues, true)}

---

### ${scoreBar(test.score, threshold)} 测试覆盖 · ${test.score}/100（权重 ${weights.test}%）
${test.summary}

${issueTable(test.issues)}

---

### ${scoreBar(impact.score, threshold)} 变更影响 · ${impact.score}/100（权重 ${weights.impact}%）· 风险：\`${impact.riskLevel ?? "unknown"}\`
${impact.summary}

${issueTable(impact.issues)}

---

<details>
<summary>评分明细</summary>

| 维度 | 原始分 | 权重 | 加权分 |
|---|---|---|---|
| 代码质量 | ${quality.score} | ${weights.quality}% | ${Math.round(quality.score * weights.quality / 100)} |
| 安全漏洞 | ${security.score} | ${weights.security}% | ${Math.round(security.score * weights.security / 100)} |
| 测试覆盖 | ${test.score} | ${weights.test}% | ${Math.round(test.score * weights.test / 100)} |
| 变更影响 | ${impact.score} | ${weights.impact}% | ${Math.round(impact.score * weights.impact / 100)} |
| **综合** | — | — | **${composite}** |

</details>

_由 [AI Review Gate](/.github/workflows/ai-review.yml) 生成 · 阈值 ${threshold} · 规则版本 .cr-rules.yml_
`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const rules = loadRules();
  const threshold = resolveThreshold(rules);
  const weights = {
    quality:  rules.weights?.quality  ?? 25,
    security: rules.weights?.security ?? 40,
    test:     rules.weights?.test     ?? 20,
    impact:   rules.weights?.impact   ?? 15,
  };

  const raw = fs.readFileSync(process.env.DIFF_PATH ?? "/tmp/pr.diff", "utf8");
  const diff = raw.slice(0, MAX_DIFF);

  if (diff.trim().length < 10) {
    fs.writeFileSync("/tmp/gate_score.txt", "100");
    fs.writeFileSync("/tmp/gate_passed.txt", "true");
    fs.writeFileSync("/tmp/pr_comment.md", "_无代码变更，跳过 AI 审查_");
    return;
  }

  console.error("▶ 并行运行四个审查维度…");
  const [quality, security, test, impact] = await Promise.all([
    reviewQuality(diff, rules),
    reviewSecurity(diff, rules),
    reviewTest(diff, rules),
    reviewImpact(diff, rules),
  ]);

  const scores = { quality: quality.score, security: security.score, test: test.score, impact: impact.score };
  const composite = calcComposite(scores, weights);
  const { vetoed, reason: vetoReason } = checkVeto(scores, rules);
  const passed = !vetoed && composite >= threshold;

  const comment = buildComment({ quality, security, test, impact, composite, passed, vetoed, vetoReason, threshold, rules, weights });
  fs.writeFileSync("/tmp/pr_comment.md", comment);
  fs.writeFileSync("/tmp/gate_score.txt", String(composite));
  fs.writeFileSync("/tmp/gate_passed.txt", String(passed));

  console.log(JSON.stringify({ composite, passed, vetoed, threshold, ...scores }));
}

main().catch(e => { console.error("AI review error:", e); process.exit(1); });