import * as core from "@actions/core";

import {
  loadPullRequestReviewData,
  parsePullRequestUrl,
  writeJobSummary,
  type PullRequestComment,
  type PullRequestFile,
  type PullRequestReviewData,
} from "./github";
import {
  reviewPullRequestWithOpenAI,
  type PullRequestReviewResult,
} from "./openai";

const DEFAULT_MODEL = "gpt-4.1-mini";
const MAX_TOTAL_PROMPT_BYTES = 120_000;
const MAX_PATCH_BYTES = 18_000;
const MAX_FILES_IN_PROMPT = 40;

function sliceUtf8Start(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }

  let low = 0;
  let high = text.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = text.slice(0, mid);

    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return text.slice(0, low);
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function truncatePatch(patch: string | undefined): string {
  if (!patch) {
    return "Patch not provided by GitHub for this file.";
  }

  if (Buffer.byteLength(patch, "utf8") <= MAX_PATCH_BYTES) {
    return patch;
  }

  return `${sliceUtf8Start(patch, MAX_PATCH_BYTES)}\n\n[... diff truncated ...]`;
}

function renderFiles(files: PullRequestFile[]): string {
  return files
    .map((file) =>
      [
        `File: ${file.path}`,
        `Status: ${file.status}`,
        `Additions: ${file.additions}`,
        `Deletions: ${file.deletions}`,
        `Changes: ${file.changes}`,
        "Patch:",
        truncatePatch(file.patch),
      ].join("\n"),
    )
    .join("\n\n==========\n\n");
}

function renderComments(comments: PullRequestComment[]): string {
  if (comments.length === 0) {
    return "No PR comments or review comments were found.";
  }

  return comments
    .map((comment) => {
      const location = comment.path
        ? `${comment.path}${comment.line != null ? `:${comment.line}` : ""}`
        : "general";

      return [
        `Type: ${comment.kind}`,
        `Author: ${comment.author}`,
        `Location: ${location}`,
        `State: ${comment.state ?? "n/a"}`,
        `Body: ${compactText(comment.body, 400)}`,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

function renderPrompt(data: PullRequestReviewData): string {
  const { pullRequest, files, comments } = data;
  const fileList = files.map((file) => file.path).join(", ");
  const prompt = [
    "You are an expert code reviewer.",
    "Review the GitHub pull request below and return a high-signal review for the developer.",
    "",
    "IMPORTANT RULES:",
    "- Summarize the overall purpose of the changes",
    "- Identify likely bugs, logic risks, missing tests, missing documentation, naming inconsistencies, and refactoring opportunities",
    "- Be clear, concise, and actionable",
    "- Use a friendly and supportive tone",
    "- Mention specific files and lines when possible",
    "- Avoid generic praise or filler",
    "- Return valid JSON only",
    "",
    `PR: ${pullRequest.htmlUrl}`,
    `Repository: ${pullRequest.owner}/${pullRequest.repo}`,
    `PR Number: ${pullRequest.pullNumber}`,
    `Title: ${pullRequest.title}`,
    `Author: ${pullRequest.author}`,
    `Draft: ${pullRequest.draft ? "yes" : "no"}`,
    `Base Branch: ${pullRequest.baseRef}`,
    `Head Branch: ${pullRequest.headRef}`,
    `Additions: ${pullRequest.additions}`,
    `Deletions: ${pullRequest.deletions}`,
    `Changed Files: ${pullRequest.changedFiles}`,
    `Issue Comments: ${pullRequest.commentCount}`,
    `Review Comments: ${pullRequest.reviewCommentCount}`,
    `Changed File Paths: ${fileList || "No files reported by GitHub."}`,
    "",
    "PR Body:",
    pullRequest.body || "No PR description provided.",
    "",
    "Existing Comment Context:",
    renderComments(comments),
    "",
    "Changed Files:",
    renderFiles(files.slice(0, MAX_FILES_IN_PROMPT)),
    "",
    "Return JSON with keys:",
    "- summary",
    "- feedback",
    "- status",
  ].join("\n");

  return sliceUtf8Start(prompt, MAX_TOTAL_PROMPT_BYTES);
}

function buildFallbackReview(
  data: PullRequestReviewData,
  reason: string,
): PullRequestReviewResult {
  const { pullRequest, files } = data;
  const topFiles = files.slice(0, 3).map((file) => file.path).join(", ");

  return {
    summary: `Metadata-only review for PR #${pullRequest.pullNumber}: "${pullRequest.title}". ${files.length} file(s) changed (+${pullRequest.additions}/-${pullRequest.deletions}). Most visible changes include ${topFiles || "the submitted files"}.`,
    feedback: [
      {
        category: "AI Review Unavailable",
        severity: "warning",
        issue: `OpenAI review generation failed: ${reason}`,
        suggestion: "Retry the workflow or review the PR manually using the changed file list and diff excerpts.",
      },
    ],
    status: "fallback",
  };
}

function renderMarkdown(
  data: PullRequestReviewData,
  review: PullRequestReviewResult,
): string {
  const statusMessage =
    review.status === "success"
      ? "PR review completed successfully."
      : review.status === "fallback"
        ? "AI review failed, so a metadata-only fallback review was returned."
        : "PR review failed before a full review could be generated.";
  const feedback =
    review.feedback.length > 0
      ? review.feedback
          .map((item) => {
            const location =
              item.path != null
                ? ` (${item.path}${item.line != null ? `:${item.line}` : ""})`
                : "";

            return `- **${item.category}**${location}: ${item.issue} Suggestion: ${item.suggestion}`;
          })
          .join("\n")
      : "- No major issues were identified.";

  return `## PR Review AI

**PR:** [#${data.pullRequest.pullNumber} ${data.pullRequest.title}](${data.pullRequest.htmlUrl})  
**Status:** \`${review.status}\`

${statusMessage}

### Summary
${review.summary}

### Feedback
${feedback}
`;
}

function getStatusMessage(result: PullRequestReviewResult): string {
  if (result.status === "success") {
    return "PR review completed successfully.";
  }

  if (result.status === "fallback") {
    return "AI review failed, using fallback review.";
  }

  return "PR review failed.";
}

async function finalizeOutputs(result: PullRequestReviewResult): Promise<void> {
  core.setOutput("review-json", JSON.stringify(result));
  core.setOutput("status", result.status);
  core.setOutput("message", getStatusMessage(result));
}

async function run(): Promise<void> {
  try {
    const prUrl = core.getInput("pr-url", { required: true });
    const githubToken = core.getInput("github-token", { required: true });
    const openaiApiKey = core.getInput("openai-api-key", { required: true });
    const model = core.getInput("model") || DEFAULT_MODEL;

    const location = parsePullRequestUrl(prUrl);
    core.info(
      `Reviewing PR #${location.pullNumber} in ${location.owner}/${location.repo}.`,
    );

    let reviewData: PullRequestReviewData;
    try {
      reviewData = await loadPullRequestReviewData(githubToken, location);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      core.error(`GitHub API Error: ${reason}`);
      throw new Error(reason);
    }

    const prompt = renderPrompt(reviewData);

    let review: PullRequestReviewResult;

    try {
      review = await reviewPullRequestWithOpenAI({
        apiKey: openaiApiKey,
        model,
        prompt,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      core.error(`OpenAI API Error: ${reason}`);
      core.warning(`OpenAI review failed. Returning metadata-only review. ${reason}`);
      review = buildFallbackReview(reviewData, reason);
    }

    await writeJobSummary(renderMarkdown(reviewData, review));
    await finalizeOutputs(review);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedResult: PullRequestReviewResult = {
      summary: "PR review could not be completed because required PR context or API data could not be loaded.",
      feedback: [],
      status: "failure",
    };

    try {
      await writeJobSummary(
        `## PR Review AI\n\n**Status:** \`failure\`\n\nPR review failed before completion.\n\n${message}\n`,
      );
    } catch {
      // Ignore summary write failure and preserve the main error path.
    }

    await finalizeOutputs(failedResult);
    core.setFailed(message);
  }
}

void run();
