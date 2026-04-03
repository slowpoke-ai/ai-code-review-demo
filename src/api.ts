import type { DimensionResult } from "./types";

const MAX_DIFF_CHARS = 10_000;

async function callClaude(
  apiKey: string,
  system: string,
  user: string
): Promise<DimensionResult> {
  const res = await fetch("/api/anthropic/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // browser SDK flag
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1200,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      (err as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`
    );
  }

  const data = (await res.json()) as {
    content: { type: string; text?: string }[];
  };
  const raw = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");

  const clean = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(clean) as DimensionResult;
}

const JSON_SHAPE = `{
  "score": <0-100>,
  "summary": "<one sentence>",
  "issues": [
    {
      "severity": "high|medium|low",
      "file": "<filename or null>",
      "line": "<line ref or null>",
      "message": "<description>",
      "suggestion": "<concrete fix>"
    }
  ]
}`;

export async function reviewQuality(apiKey: string, diff: string) {
  return callClaude(
    apiKey,
    "You are a senior TypeScript/JavaScript engineer doing code review. Respond ONLY with valid JSON — no markdown, no extra text.",
    `Review this diff for code quality: logic errors, type safety, naming conventions, complexity, dead code, missing error handling, and TS/JS best practices.\n\nReturn JSON matching this shape:\n${JSON_SHAPE}\n\nDiff:\n\`\`\`diff\n${diff.slice(0, MAX_DIFF_CHARS)}\n\`\`\``
  );
}

export async function reviewSecurity(apiKey: string, diff: string) {
  const shape = JSON_SHAPE.replace(
    '"suggestion": "<concrete fix>"',
    '"suggestion": "<concrete fix>",\n      "cwe": "<CWE-xxx or null>"'
  );
  return callClaude(
    apiKey,
    "You are an application security engineer specialising in Node.js and TypeScript. Respond ONLY with valid JSON — no markdown, no extra text.",
    `Scan for security vulnerabilities: injection flaws, hardcoded secrets, insecure deps, prototype pollution, unsafe regex, missing auth checks, XSS, CSRF, weak crypto.\n\nReturn JSON matching this shape:\n${shape}\n\nDiff:\n\`\`\`diff\n${diff.slice(0, MAX_DIFF_CHARS)}\n\`\`\``
  );
}

export async function reviewTestCoverage(apiKey: string, diff: string) {
  return callClaude(
    apiKey,
    "You are a QA engineer focused on TypeScript unit and integration testing (Jest/Vitest). Respond ONLY with valid JSON — no markdown, no extra text.",
    `Identify missing test coverage: new functions/branches with no tests, untested edge cases, missing mocks for external calls. Suggest specific test cases.\n\nReturn JSON matching this shape:\n${JSON_SHAPE}\n\nDiff:\n\`\`\`diff\n${diff.slice(0, MAX_DIFF_CHARS)}\n\`\`\``
  );
}

export async function reviewImpact(apiKey: string, diff: string) {
  const shape = JSON_SHAPE.replace(
    '"score": <0-100>,',
    '"score": <0-100>,\n  "riskLevel": "low|medium|high",'
  );
  return callClaude(
    apiKey,
    "You are a software architect reviewing change impact. Respond ONLY with valid JSON — no markdown, no extra text.",
    `Analyse downstream impact: affected modules, API contract changes, breaking changes, performance implications, dependency risk.\n\nReturn JSON matching this shape:\n${shape}\n\nDiff:\n\`\`\`diff\n${diff.slice(0, MAX_DIFF_CHARS)}\n\`\`\``
  );
}