export type Severity = "high" | "medium" | "low";
export type RiskLevel = "low" | "medium" | "high";

export interface Issue {
  severity: Severity;
  file?: string | null;
  line?: string | null;
  message: string;
  suggestion?: string | null;
  cwe?: string | null;
}

export interface DimensionResult {
  score: number;
  summary: string;
  issues: Issue[];
  riskLevel?: RiskLevel;
}

export interface ReviewResults {
  quality: DimensionResult;
  security: DimensionResult;
  test: DimensionResult;
  impact: DimensionResult;
  gate: {
    score: number;
    passed: boolean;
    threshold: number;
  };
}

export type StageId = "idle" | "quality" | "security" | "test" | "impact" | "done";