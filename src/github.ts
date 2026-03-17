import * as core from "@actions/core";
import * as github from "@actions/github";

const MAX_COMMENTS = 20;

type PullRequestFileResponse = {
  filename: string;
  status?: string | null;
  additions?: number | null;
  deletions?: number | null;
  changes?: number | null;
  patch?: string | null;
};

type PullRequestResponse = {
  number: number;
  title: string;
  body?: string | null;
  state?: string | null;
  html_url: string;
  draft?: boolean;
  user?: {
    login?: string;
  } | null;
  base?: {
    ref?: string;
    sha?: string;
  } | null;
  head?: {
    ref?: string;
    sha?: string;
  } | null;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  comments?: number;
  review_comments?: number;
};

type IssueCommentResponse = {
  user?: {
    login?: string;
  } | null;
  body?: string | null;
};

type ReviewCommentResponse = {
  user?: {
    login?: string;
  } | null;
  body?: string | null;
  path?: string | null;
  line?: number | null;
};

type ReviewResponse = {
  user?: {
    login?: string;
  } | null;
  body?: string | null;
  state?: string | null;
};

export interface PullRequestLocation {
  owner: string;
  repo: string;
  pullNumber: number;
}

export interface PullRequestFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface PullRequestComment {
  author: string;
  body: string;
  path?: string;
  line?: number;
  kind: "issue_comment" | "review_comment" | "review";
  state?: string;
}

export interface PullRequestContext {
  owner: string;
  repo: string;
  pullNumber: number;
  title: string;
  body: string;
  state: string;
  htmlUrl: string;
  draft: boolean;
  author: string;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commentCount: number;
  reviewCommentCount: number;
}

export interface PullRequestReviewData {
  pullRequest: PullRequestContext;
  files: PullRequestFile[];
  comments: PullRequestComment[];
}

function formatApiError(context: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`${context}. ${message}`);
}

async function loadAllPullRequestFiles(
  octokit: ReturnType<typeof github.getOctokit>,
  location: PullRequestLocation,
): Promise<PullRequestFile[]> {
  const files: PullRequestFile[] = [];
  let page = 1;
  let hasMorePages = true;

  while (hasMorePages) {
    const response = await octokit.rest.pulls.listFiles({
      owner: location.owner,
      repo: location.repo,
      pull_number: location.pullNumber,
      per_page: 100,
      page,
    });

    files.push(
      ...(response.data as PullRequestFileResponse[]).map((file) => ({
        path: file.filename,
        status: file.status ?? "modified",
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
        changes: file.changes ?? 0,
        patch: file.patch ?? undefined,
      })),
    );

    if (response.data.length < 100) {
      hasMorePages = false;
    } else {
      page += 1;
    }
  }

  return files;
}

async function loadIssueComments(
  octokit: ReturnType<typeof github.getOctokit>,
  location: PullRequestLocation,
): Promise<IssueCommentResponse[]> {
  try {
    return (await octokit.paginate(octokit.rest.issues.listComments, {
      owner: location.owner,
      repo: location.repo,
      issue_number: location.pullNumber,
      per_page: 100,
    })) as IssueCommentResponse[];
  } catch (error) {
    core.warning(
      formatApiError(
        `Failed to load issue comments for ${location.owner}/${location.repo}#${location.pullNumber}. Continuing without issue comments`,
        error,
      ).message,
    );
    return [];
  }
}

async function loadReviewComments(
  octokit: ReturnType<typeof github.getOctokit>,
  location: PullRequestLocation,
): Promise<ReviewCommentResponse[]> {
  try {
    return (await octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner: location.owner,
      repo: location.repo,
      pull_number: location.pullNumber,
      per_page: 100,
    })) as ReviewCommentResponse[];
  } catch (error) {
    core.warning(
      formatApiError(
        `Failed to load review comments for ${location.owner}/${location.repo}#${location.pullNumber}. Continuing without review comments`,
        error,
      ).message,
    );
    return [];
  }
}

async function loadReviews(
  octokit: ReturnType<typeof github.getOctokit>,
  location: PullRequestLocation,
): Promise<ReviewResponse[]> {
  try {
    return (await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner: location.owner,
      repo: location.repo,
      pull_number: location.pullNumber,
      per_page: 100,
    })) as ReviewResponse[];
  } catch (error) {
    core.warning(
      formatApiError(
        `Failed to load review history for ${location.owner}/${location.repo}#${location.pullNumber}. Continuing without review history`,
        error,
      ).message,
    );
    return [];
  }
}

export function parsePullRequestUrl(prUrl: string): PullRequestLocation {
  const trimmed = prUrl.trim();
  const match = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/i);

  if (!match) {
    throw new Error(`Invalid GitHub pull request URL: ${prUrl}`);
  }

  return {
    owner: match[1],
    repo: match[2],
    pullNumber: Number(match[3]),
  };
}

export async function loadPullRequestReviewData(
  githubToken: string,
  location: PullRequestLocation,
): Promise<PullRequestReviewData> {
  const octokit = github.getOctokit(githubToken);
  let pull: PullRequestResponse;
  let files: PullRequestFile[];

  try {
    const pullResponse = await octokit.rest.pulls.get({
      owner: location.owner,
      repo: location.repo,
      pull_number: location.pullNumber,
    });
    pull = pullResponse.data as PullRequestResponse;
  } catch (error) {
    throw formatApiError(
      `Failed to load PR metadata for ${location.owner}/${location.repo}#${location.pullNumber}`,
      error,
    );
  }

  try {
    files = await loadAllPullRequestFiles(octokit, location);
  } catch (error) {
    throw formatApiError(
      `Failed to load changed files for ${location.owner}/${location.repo}#${location.pullNumber}`,
      error,
    );
  }

  const issueComments = await loadIssueComments(octokit, location);
  const reviewComments = await loadReviewComments(octokit, location);
  const reviews = await loadReviews(octokit, location);

  const comments: PullRequestComment[] = [
    ...issueComments.slice(-MAX_COMMENTS).map((comment) => ({
      author: comment.user?.login ?? "unknown",
      body: comment.body ?? "",
      kind: "issue_comment" as const,
    })),
    ...reviewComments.slice(-MAX_COMMENTS).map((comment) => ({
      author: comment.user?.login ?? "unknown",
      body: comment.body ?? "",
      path: comment.path ?? undefined,
      line: typeof comment.line === "number" ? comment.line : undefined,
      kind: "review_comment" as const,
    })),
    ...reviews.slice(-MAX_COMMENTS).map((review) => ({
      author: review.user?.login ?? "unknown",
      body: review.body ?? "",
      kind: "review" as const,
      state: review.state ?? undefined,
    })),
  ]
    .filter((comment) => comment.body.trim().length > 0)
    .slice(-MAX_COMMENTS);

  return {
    pullRequest: {
      owner: location.owner,
      repo: location.repo,
      pullNumber: location.pullNumber,
      title: pull.title,
      body: pull.body ?? "",
      state: pull.state ?? "open",
      htmlUrl: pull.html_url,
      draft: Boolean(pull.draft),
      author: pull.user?.login ?? "unknown",
      baseRef: pull.base?.ref ?? "",
      headRef: pull.head?.ref ?? "",
      baseSha: pull.base?.sha ?? "",
      headSha: pull.head?.sha ?? "",
      additions: pull.additions ?? 0,
      deletions: pull.deletions ?? 0,
      changedFiles: pull.changed_files ?? files.length,
      commentCount: pull.comments ?? 0,
      reviewCommentCount: pull.review_comments ?? 0,
    },
    files,
    comments,
  };
}

export async function writeJobSummary(markdown: string): Promise<void> {
  await core.summary.addRaw(markdown, true).write({ overwrite: true });
}
