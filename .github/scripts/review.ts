import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";

// ─── Config ──────────────────────────────────────────────────────────────────
const DIFF_PATH = process.env.DIFF_PATH ?? "/tmp/pr.diff";
const THRESHOLD = parseInt(process.env.GATE_THRESHOLD ?? "70", 10);
const MAX_DIFF_CHARS = 12_000;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Types ────────────────────────────────────────────────────────────────────
interface Issue {
  severity: "high" | "medium" | "low";
  file?: string;
  line?: string;
  message: string;
  suggestion?: string;
  cwe?: string;
}

interface DimensionResult {
  score: number;
  summary: string;
  issues: Issue[];
  riskLevel?: "low" | "medium" | "high";
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
    max_tokens: 1200,
    system: `You are ${role}. Respond ONLY with valid JSON — no markdown fences, no extra text.`,
    messages: [
      {
        role: "user",
        content: `${task}

Return JSON matching this exact shape:
{
  "score": <integer 0-100>,
  "summary": "<one sentence>",
  ${extraFields}
  "issues": [
    {
      "severity": "high|medium|low",
      "file": "<filename or null>",
      "line": "<line ref or null>",
      "message": "<clear description>",
      "suggestion": "<concrete fix>"
      ${extraFields.includes("cwe") ? ', "cwe": "<CWE-xxx or null>"' : ""}
    }
  ]
}

TypeScript/JavaScript diff:
\`\`\`diff
${diff}
\`\`\``,
      },
    ],
  });

  const raw = msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  return JSON.parse(raw) as DimensionResult;
}

// ─── Four review dimensions ───────────────────────────────────────────────────
async function reviewQuality(diff: string): Promise<DimensionResult> {
  return reviewDimension(
    "a senior TypeScript/JavaScript engineer doing code review",
    `Review this diff for code quality: logic errors, type safety issues, naming conventions,
complexity, dead code, missing error handling, and adherence to TS best practices.`,
    diff
  );
}

async function reviewSecurity(diff: string): Promise<DimensionResult> {
  return reviewDimension(
    "an application security engineer specialising in Node.js and TypeScript",
    `Scan for security vulnerabilities: injection flaws, hardcoded secrets, insecure dependencies,
prototype pollution, unsafe regex (ReDoS), missing auth/authz checks, XSS, CSRF, and weak crypto.`,
    diff,
    '"cwe": "<CWE-xxx or null>",'
  );
}

async function reviewTestCoverage(diff: string): Promise<DimensionResult> {
  return reviewDimension(
    "a QA engineer focused on TypeScript unit and integration testing (Jest/Vitest)",
    `Identify missing test coverage: new functions/branches with no tests, untested edge cases,
missing mocks for external calls, and lack of type-level tests. Suggest specific test cases.`,
    diff
  );
}

async function reviewImpact(diff: string): Promise<DimensionResult> {
  return reviewDimension(
    "a software architect reviewing change impact",
    `Analyse downstream impact: which modules are affected, API contract changes, breaking changes,
performance implications, and dependency graph risk.`,
    diff,
    '"riskLevel": "low|medium|high",'
  );
}

// ─── Markdown comment builder ─────────────────────────────────────────────────
function severityEmoji(s: Issue["severity"]) {
  return s === "high" ? "🔴" : s === "medium" ? "🟡" : "🟢";
}

function scoreEmoji(score: number) {
  return score >= 80 ? "✅" : score >= THRESHOLD ? "⚠️" : "❌";
}

function issueTable(issues: Issue[], showCwe = false): string {
  if (!issues.length) return "_No issues found._\n";
  const rows = issues
    .map((i) => {
      const loc = [i.file, i.line].filter(Boolean).join(":");
      const cweCol = showCwe ? ` \`${i.cwe ?? "—"}\` |` : "";
      return `| ${severityEmoji(i.severity)} ${i.severity} | \`${loc || "—"}\` |${cweCol} ${i.message} | ${i.suggestion ?? "—"} |`;
    })
    .join("\n");
  const cweHeader = showCwe ? " CWE |" : "";
  return `| Severity | Location |${cweHeader} Issue | Suggestion |\n|---|---|${showCwe ? "---|" : ""}---|---|\n${rows}\n`;
}

function buildComment(
  quality: DimensionResult,
  security: DimensionResult,
  testCov: DimensionResult,
  impact: DimensionResult,
  composite: number,
  passed: boolean
): string {
  const gateIcon = passed ? "✅" : "❌";
  const gateLabel = passed ? "PASSED — merge allowed" : "FAILED — merge blocked";

  return `## 🤖 AI PR Review Report

> **Gate: ${gateIcon} ${gateLabel}** — composite score **${composite}/100** (threshold ${THRESHOLD})

---

### ${scoreEmoji(quality.score)} Code Quality · ${quality.score}/100
${quality.summary}

${issueTable(quality.issues)}

---

### ${scoreEmoji(security.score)} Security · ${security.score}/100
${security.summary}

${issueTable(security.issues, true)}

---

### ${scoreEmoji(testCov.score)} Test Coverage · ${testCov.score}/100
${testCov.summary}

${issueTable(testCov.issues)}

---

### ${scoreEmoji(impact.score)} Change Impact · ${impact.score}/100 · Risk: \`${impact.riskLevel ?? "unknown"}\`
${impact.summary}

${issueTable(impact.issues)}

---

<details>
<summary>Score breakdown</summary>

| Dimension | Score |
|---|---|
| Code Quality | ${quality.score} |
| Security | ${security.score} |
| Test Coverage | ${testCov.score} |
| Change Impact | ${impact.score} |
| **Composite** | **${composite}** |

</details>

_Generated by [AI Review Gate](/.github/workflows/ai-review.yml) · threshold ${THRESHOLD}_
`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const raw = fs.readFileSync(DIFF_PATH, "utf8");
  const diff = raw.slice(0, MAX_DIFF_CHARS);

  if (diff.trim().length < 10) {
    console.log("No meaningful diff detected — skipping AI review.");
    fs.writeFileSync("/tmp/gate_score.txt", "100");
    fs.writeFileSync("/tmp/gate_passed.txt", "true");
    fs.writeFileSync("/tmp/pr_comment.md", "_No code changes detected — AI review skipped._");
    return;
  }

  console.error("▶ Running 4 review dimensions in parallel…");

  const [quality, security, testCov, impact] = await Promise.all([
    reviewQuality(diff),
    reviewSecurity(diff),
    reviewTestCoverage(diff),
    reviewImpact(diff),
  ]);

  const composite = Math.round(
    (quality.score + security.score + testCov.score + impact.score) / 4
  );
  const passed = composite >= THRESHOLD;

  const comment = buildComment(quality, security, testCov, impact, composite, passed);
  fs.writeFileSync("/tmp/pr_comment.md", comment);
  fs.writeFileSync("/tmp/gate_score.txt", String(composite));
  fs.writeFileSync("/tmp/gate_passed.txt", String(passed));

  // Last line → captured by GITHUB_OUTPUT
  console.log(JSON.stringify({ composite, passed, quality: quality.score, security: security.score, test: testCov.score, impact: impact.score }));
}

main().catch((e) => {
  console.error("AI review failed:", e);
  process.exit(1);
});