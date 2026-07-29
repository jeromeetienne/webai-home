# AGENTS.md

This file provides guidance to Codex and other coding agents working with this project.

## Specificity

Never use a generic verb phrase when a specific verb phrase exists. Name the actual operation. If the operation differs by context, list each variant instead of merging them under a vague phrase.

## De-risk Before Building

Before writing implementation code for a feature that depends on an unproven external dependency, first name the single assumption that would make the feature impossible and prove or disprove it with the smallest live test against the real environment. Do not report a gate as passed unless the test exercised the actual constraint. Show raw output and state exactly what was tested.

## TypeScript

When writing TypeScript, use the following technologies:

- TypeScript (ES2020, strict), run via `tsx` for development.
- Zod for runtime validation of `SKILL.md` front matter.
- Commander.js for command-line argument parsing in both packages.
- Chalk for terminal colours in `bsky_cli`.

## GitHub

For GitHub tasks, use the authenticated `gh` command-line tool. Do not request a GitHub connector, Model Context Protocol server, or broad permissions when `gh` can perform the task.

When creating or editing GitHub issue bodies with multiple lines, pass real line breaks. Prefer a quoted multiline body or a temporary body file with `gh issue create --body-file` or `gh issue edit --body-file`. Never pass literal `\\n` sequences as the issue body.

## Git

### Commit messages

- Do not append a `Co-Authored-By` trailer or any Anthropic, Claude, or Codex email to commit messages.
- When a commit is about a GitHub issue, always mention the issue number in the commit message.
- If the commit fixes a GitHub issue, use `fixes #xxx` in the commit message.

### Pull requests

- Do not append generated-by lines or Claude Code, Codex, or Anthropic attribution to pull request descriptions.

### GitHub issues

- When referencing a commit in a GitHub issue, always use a link, never only the hexadecimal commit identifier.

### Referencing commits

- Whenever mentioning a commit identifier anywhere, render it as a link to that commit on its remote repository, never as bare hexadecimal text.
