# PR Review AI

PR Review AI is an AI-powered GitHub PR reviewer that analyzes pull request changes, summarizes the overall work, flags likely issues, and provides friendly, actionable feedback for developers.

It is designed for fast review support:

- Summarize what changed
- Detect likely bugs, missing tests, naming issues, or missing documentation
- Suggest concrete improvements
- Return structured JSON that other workflows can consume

## Use In 1 Minute

```yaml
name: PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  review-pr:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      issues: read
    steps:
      - name: Review PR with AI
        uses: Neal0326/pr-review-ai@v1
        with:
          pr-url: ${{ github.event.pull_request.html_url }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          model: gpt-4.1-mini
```

## Installation And Configuration

You need two secrets:

- `GITHUB_TOKEN` for reading pull request metadata, changed files, and comments
- `OPENAI_API_KEY` for generating the AI review

In most repositories, `github-token` should be set to `${{ secrets.GITHUB_TOKEN }}` and `pr-url` should be set to `${{ github.event.pull_request.html_url }}`.

## Example Workflow

```yaml
name: PR Review

on:
  pull_request:
    types: [opened, edited, synchronize, reopened]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      issues: read
    steps:
      - name: PR Review AI
        uses: Neal0326/pr-review-ai@v1
        with:
          pr-url: ${{ github.event.pull_request.html_url }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          model: gpt-4.1-mini
```

## What It Does

1. Reads the PR URL input
2. Uses the GitHub API to fetch pull request metadata
3. Lists files changed in the PR with pagination support
4. Loads issue comments, review comments, and review state context
5. Prepares a prompt with PR summary, changed file metadata, changed file paths, and diff excerpts
6. Calls OpenAI to generate a structured review
7. Returns a JSON object with:
   - `summary`
   - `feedback`
   - `status`
8. Writes a readable markdown version to the GitHub Actions job summary

If OpenAI fails, the action returns a metadata-only fallback review instead of crashing.

## Output JSON Shape

```json
{
  "summary": "Brief summary of the PR changes.",
  "feedback": [
    {
      "category": "Missing Tests",
      "severity": "warning",
      "path": "src/auth.ts",
      "line": 42,
      "issue": "The new branch is not covered by tests.",
      "suggestion": "Add unit tests for both success and failure cases."
    }
  ],
  "status": "success"
}
```

## Inputs

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `pr-url` | Yes | | Full GitHub pull request URL to review |
| `github-token` | Yes | | GitHub token used to read PR details, files, and comments |
| `openai-api-key` | Yes | | OpenAI API key used to generate the review |
| `model` | No | `gpt-4.1-mini` | OpenAI model name |

## Outputs

| Name | Description |
| --- | --- |
| `review-json` | JSON review result containing `summary`, `feedback`, and `status` |
| `status` | Review process status string |
| `message` | Human-readable status message for the workflow run |

## Permissions

Recommended workflow permissions:

```yaml
permissions:
  contents: read
  pull-requests: read
  issues: read
```

## OpenAI API Key

This action requires an OpenAI API key.

You must provide your own key:

```yaml
with:
  openai-api-key: ${{ secrets.OPENAI_API_KEY }}
```

## Error Handling And Fallbacks

- If the GitHub API request fails, the action returns a failure status with a clear error message
- If the OpenAI request fails, the action returns a fallback review using PR metadata and changed files
- Errors are logged to the workflow output to help with debugging

## How Review Quality Is Improved

The prompt asks the model to:

- Summarize the purpose of the PR
- Look for likely bugs, missing tests, missing documentation, naming issues, and refactoring opportunities
- Reference specific files and lines when possible
- Keep feedback concise, actionable, and developer-friendly

## Notes

- Diff patches can be truncated before they are sent to OpenAI
- Very large PRs may be summarized from partial diff excerpts
- Review comments and issue comments are included as context when available
- The review tone is designed to be constructive and supportive

## Local Development

```bash
npm install
npm run verify
```

## Publishing

Before publishing:

1. Run `npm run verify`
2. Commit `dist/` artifacts
3. Tag a release such as `v1`
