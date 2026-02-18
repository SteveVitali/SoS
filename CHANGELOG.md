# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- MIT license
- Biome linter and formatter with project-specific rules
- Husky pre-commit hooks with lint-staged (auto-lint on commit)
- Vitest test runner with unit tests for shared utilities
- GitHub Actions CI workflow (lint, typecheck, test, build)
- SECURITY.md with responsible disclosure guidelines
- CODE_OF_CONDUCT.md (Contributor Covenant v2.1)
- GitHub issue templates (bug report, feature request) and PR template
- `.editorconfig` for consistent editor settings
- `.nvmrc` for Node.js version pinning
- `engines` field in package.json enforcing Node >= 20

### Changed

- Expanded `.gitignore` with common Node/TS/macOS patterns
- Auto-formatted entire codebase with Biome

## [0.1.0] - 2025-06-01

### Added

- Initial release
- Server: Express v5 HTTP API + Slack Socket Mode bot
- Worker: Configurable pool of Claude Code CLI executors
- Web UI: React + Vite SPA for job management
- MongoDB-backed job queue with lease-based concurrency
- LLM-powered Slack message routing (Anthropic / OpenAI-compatible)
- Slack thread context fetching and file attachment support
- Worktree pool for efficient git workspace management
- GitHub Actions and Jenkins CI provider support
- Repo registry with keyword-based auto-detection
