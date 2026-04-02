import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";

// ─── Config ──────────────────────────────────────────────────────────────────
const DIFF_PATH = process.env.DIFF_PATH ?? "/tmp/pr.diff";
const THRESHOLD = parseInt(process.env.GATE_THRESHOLD ?? "70", 10);
const MAX_DIFF_CHARS = 10_000;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Types ────────────────────────────────────────────────────────────────────
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

// ─── Safe JSON parser ─────────────────────────────────────────────────────────
function safeParseJSON(raw: string): DimensionResult {
  // 1. strip markdown code fences
  let cleaned = raw.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
  // 2. extract first { ... } block
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1) {
    cleaned = cleaned.slice(start, end + 1);
  }
  try {
    return JSON.parse(cleaned) as DimensionResult;
  } catch {
    console.error("JSON parse failed, raw response:", raw.slice(0, 500));
    return { score: 50, summary: "Parse error — manual review required", issues: [] };
  }
}

// ─── AI call helper ───────────────────────────────────────────────────────────
async function reviewDimension(
  role: string,
  task: string,
  diff: string,
  extraFields = ""
): Promise<DimensionResult> {
  const msg = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    system: `You are ${role}. You MUST respond with ONLY a valid JSON object. No markdown, no code fences, no explanation text before or after. Start your response with { and end with }.`,
    messages: [{
      role: "user",
      content: `${task}

Return a JSON object with this exact structure (no markdown, raw JSON only):
{
  "score": <integer 0-100>,
  "summary": "<one sentence>",
  ${extraFields}
  "issues": [
    {
      "severity": "high|medium|low",
      "file": "<filename or null>",
      "line": "<line ref or null>",
      "message": "<description>",
      "suggestion": "<concrete fix>"
    }
  ]
}

TypeScript/JavaScript diff to review:
${diff}`,
    }],
  });

  const raw = msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  return safeParseJSON(raw);
}

// ─── Four review dimensions ───────────────────────────────────────────────────
async function reviewQuality(diff: string) {
  return reviewDimension(
    "a senior TypeScript/JavaScript engineer",
    "Review this diff for: logic errors, type safety, naming, complexity, dead code, missing error handling.",
    diff
  );
}

async function reviewSecurity(diff: string) {
  return reviewDimension(
    "an application security engineer",
    "Scan for: SQL injection, hardcoded secrets, weak crypto (MD5/SHA1 for passwords), eval usage, path traversal, missing auth checks, XSS, prototype pollution.",
    diff,
    '"cwe": "<CWE-xxx or null>",'
  );
}

async function reviewTestCoverage(diff: string) {
  return reviewDimension(
    "a QA engineer",
    "Identify missing test coverage: functions with no tests, untested edge cases, missing mocks. Suggest specific Jest/Vitest test cases.",
    diff
  );
}

async function reviewImpact(diff: string) {
  return reviewDimension(
    "a software architect",
    "Analyse change impact: affected modules, breaking changes, performance implications, API contract changes.",
    diff,
    '"riskLevel": "low|medium|high",'
  );
}

// ─── Markdown comment ─────────────────────────────────────────────────────────
function severityEmoji(s: string) {
  return s === "high" ? "🔴" : s === "medium" ? "🟡" : "🟢";
}

function issueTable(issues: Issue[], showCwe = false): string {
  if (!issues?.length) return "_No issues found._\n";
  const header = showCwe
    ? "| Sev | Location | CWE | Issue | Fix |\n|---|---|---|---|---|"
    : "| Sev | Location | Issue | Fix |\n|---|---|---|---|";
  const rows = issues.map((i) => {
    const loc = `${i.file ?? ""}:${i.line ?? ""}`.replace(/^:|:$/, "") || "—";
    const cweCol = showCwe ? ` ${i.cwe ?? "—"} |` : "";
    return `| ${severityEmoji(i.severity)} ${i.severity} | \`${loc}\` |${cweCol} ${i.message} | ${i.suggestion ?? "—"} |`;
  }).join("\n");
  return `${header}\n${rows}\n`;
}

function buildComment(
  quality: DimensionResult, security: DimensionResult,
  test: DimensionResult, impact: DimensionResult,
  composite: number, passed: boolean
): string {
  const gateIcon = passed ? "✅" : "❌";
  const gateLabel = passed ? "PASSED — merge allowed" : "FAILED — merge blocked";
  const scoreBar = (s: number) => s >= 80 ? "✅" : s >= THRESHOLD ? "⚠️" : "❌";

  return `## 🤖 AI PR Review Report

> **Gate: ${gateIcon} ${gateLabel}** — composite score **${composite}/100** (threshold ${THRESHOLD})

---

### ${scoreBar(quality.score)} Code Quality · ${quality.score}/100
${quality.summary}

${issueTable(quality.issues)}

---

### ${scoreBar(security.score)} Security · ${security.score}/100
${security.summary}

${issueTable(security.issues, true)}

---

### ${scoreBar(test.score)} Test Coverage · ${test.score}/100
${test.summary}

${issueTable(test.issues)}

---

### ${scoreBar(impact.score)} Change Impact · ${impact.score}/100 · Risk: \`${impact.riskLevel ?? "unknown"}\`
${impact.summary}

${issueTable(impact.issues)}

---

<details>
<summary>Score breakdown</summary>

| Dimension | Score |
|---|---|
| Code Quality | ${quality.score} |
| Security | ${security.score} |
| Test Coverage | ${test.score} |
| Change Impact | ${impact.score} |
| **Composite** | **${composite}** |

</details>

_Generated by AI Review Gate · threshold ${THRESHOLD}_
`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const raw = fs.readFileSync(DIFF_PATH, "utf8");
  const diff = raw.slice(0, MAX_DIFF_CHARS);

  if (diff.trim().length < 10) {
    fs.writeFileSync("/tmp/gate_score.txt", "100");
    fs.writeFileSync("/tmp/gate_passed.txt", "true");
    fs.writeFileSync("/tmp/pr_comment.md", "_No code changes — AI review skipped._");
    return;
  }

  console.error("▶ Running 4 review dimensions in parallel…");
  const [quality, security, test, impact] = await Promise.all([
    reviewQuality(diff),
    reviewSecurity(diff),
    reviewTestCoverage(diff),
    reviewImpact(diff),
  ]);

  const composite = Math.round(
    (quality.score + security.score + test.score + impact.score) / 4
  );
  const passed = composite >= THRESHOLD;

  const comment = buildComment(quality, security, test, impact, composite, passed);
  fs.writeFileSync("/tmp/pr_comment.md", comment);
  fs.writeFileSync("/tmp/gate_score.txt", String(composite));
  fs.writeFileSync("/tmp/gate_passed.txt", String(passed));

  console.log(JSON.stringify({ composite, passed, quality: quality.score, security: security.score, test: test.score, impact: impact.score }));
}

main().catch((e) => {
  console.error("AI review error:", e);
  process.exit(1);
});
