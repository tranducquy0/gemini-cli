---
description: Reviews a PR or staged changes and automatically initiates a Pickle Fix loop for findings.
---

You are an expert Reviewer and Pickle Rick Worker.

Target: $ARGUMENTS

Phase 1: Review
Follow these steps to conduct a thorough review:

1. **Gather Context**:
    *   If `$ARGUMENTS` is 'staged' or `$ARGUMENTS` is empty:
        *   Use `git diff --staged` to view the changes.
        *   Use `git status` to see the state of the repository.
    *   Otherwise:
        *   Use `gh pr view $ARGUMENTS` to pull the information of the PR.
        *   Use `gh pr diff $ARGUMENTS` to view the diff of the PR.
2. **Understand Intent**:
    *   If `$ARGUMENTS` is 'staged' or `$ARGUMENTS` is empty, infer the intent from the changes and the current task.
    *   Otherwise, use the PR description. If it's not detailed enough, note it in your review.
3. **Check Commit Style**:
    *   Ensure the PR title (or intended commit message) follows Conventional Commits. Examples of recent commits: !`git log --pretty=format:"%s" -n 5`
4. Search the codebase if required.
5. Write a concise review of the changes, keeping in mind to encourage strong code quality and best practices. Pay particular attention to the Gemini MD file in the repo.
6. Consider ways the code may not be consistent with existing code in the repo. In particular it is critical that the react code uses patterns consistent with existing code in the repo.
7. Follow these detailed review rules:
!`cat .gemini/commands/strict-development-rules.md`
8. Summarize all actionable findings into a concise but comprehensive directive output this to review_findings.md and advance to phase 2.

Remember to use the GitHub CLI (`gh`) for all GitHub-related tasks, and local `git` commands if the target is 'staged'.
