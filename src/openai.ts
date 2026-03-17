export type FeedbackSeverity = "info" | "warning";
export type ReviewStatus = "success" | "fallback" | "failure";

export interface FeedbackItem {
  category: string;
  severity: FeedbackSeverity;
  path?: string;
  line?: number;
  issue: string;
  suggestion: string;
}

export interface PullRequestReviewResult {
  summary: string;
  feedback: FeedbackItem[];
  status: ReviewStatus;
}

export interface ReviewPullRequestOptions {
  apiKey: string;
  model: string;
  prompt: string;
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
  };
}

export async function reviewPullRequestWithOpenAI(
  options: ReviewPullRequestOptions,
): Promise<PullRequestReviewResult> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      temperature: 0.1,
      response_format: {
        type: "json_object",
      },
      max_tokens: 800,
      messages: [
        {
          role: "system",
          content: [
            "You are an expert code reviewer.",
            "Analyze the pull request changes and produce a clear, high-signal review for the developer.",
            "Focus on what changed, likely correctness risks, missing tests, missing documentation, design improvements, and practical refactoring suggestions.",
            "Be friendly and supportive, but do not hide real issues.",
            "Mention specific files and line numbers when the diff context makes that possible.",
            "Prefer concrete, actionable feedback over generic advice.",
            "Return valid JSON only with keys summary, feedback, and status.",
            "feedback must be an array of objects with keys category, severity, path, line, issue, suggestion.",
            "severity must be info or warning.",
            "status must be success when review generation succeeds.",
          ].join("\n"),
        },
        {
          role: "user",
          content: options.prompt,
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const rawPayload = await response.text();
  const payload = parseChatResponse(rawPayload);

  if (!response.ok) {
    throw new Error(
      `OpenAI API request failed: ${response.status} ${response.statusText}${
        payload.error?.message ? ` - ${payload.error.message}` : ""
      }`,
    );
  }

  const rawContent = payload.choices?.[0]?.message?.content;
  if (!rawContent) {
    throw new Error("OpenAI response did not contain any message content.");
  }

  return normalizeReviewResult(parseReviewResult(rawContent));
}

function parseChatResponse(content: string): OpenAIChatResponse {
  try {
    return JSON.parse(content) as OpenAIChatResponse;
  } catch {
    throw new Error("OpenAI API response was not valid JSON.");
  }
}

function parseReviewResult(content: string): PullRequestReviewResult {
  try {
    return JSON.parse(content) as PullRequestReviewResult;
  } catch {
    const firstBrace = content.indexOf("{");
    const lastBrace = content.lastIndexOf("}");

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      throw new Error("OpenAI response was not valid JSON.");
    }

    return JSON.parse(content.slice(firstBrace, lastBrace + 1)) as PullRequestReviewResult;
  }
}

function normalizeReviewResult(
  result: Partial<PullRequestReviewResult>,
): PullRequestReviewResult {
  const summary = typeof result.summary === "string" ? result.summary.trim() : "";
  const status = normalizeStatus(result.status);
  const feedback = Array.isArray(result.feedback)
    ? result.feedback
        .map(normalizeFeedbackItem)
        .filter((item): item is FeedbackItem => item != null)
    : [];

  if (!summary) {
    throw new Error("OpenAI response JSON is missing a valid summary field.");
  }

  return {
    summary,
    feedback,
    status,
  };
}

function normalizeStatus(value: unknown): ReviewStatus {
  if (value === "success" || value === "fallback" || value === "failure") {
    return value;
  }

  return "success";
}

function normalizeFeedbackItem(item: unknown): FeedbackItem | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }

  const candidate = item as Record<string, unknown>;
  const category =
    typeof candidate.category === "string" && candidate.category.trim().length > 0
      ? candidate.category.trim()
      : "Suggestion";
  const severity =
    candidate.severity === "warning" ? "warning" : "info";
  const issue =
    typeof candidate.issue === "string" && candidate.issue.trim().length > 0
      ? candidate.issue.trim()
      : "";
  const suggestion =
    typeof candidate.suggestion === "string" && candidate.suggestion.trim().length > 0
      ? candidate.suggestion.trim()
      : "";

  if (!issue || !suggestion) {
    return undefined;
  }

  return {
    category,
    severity,
    path: typeof candidate.path === "string" ? candidate.path.trim() || undefined : undefined,
    line: typeof candidate.line === "number" ? candidate.line : undefined,
    issue,
    suggestion,
  };
}
