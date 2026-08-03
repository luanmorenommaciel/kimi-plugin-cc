# Contributing to kimi-plugin-cc

Thank you for your interest in contributing! This document covers how to set up the development environment, run tests, and cut a release.

## Development Setup

### Prerequisites

- Node.js 20.17 or later
- Kimi Code CLI 0.x (`npm i -g @moonshot-ai/kimi-code`, or the native installer from [kimi.com/code](https://www.kimi.com/code))
- Git

### Clone and Install

```bash
git clone https://github.com/luanmorenommaciel/kimi-plugin-cc.git
cd kimi-plugin-cc
npm install
```

### Project Structure

```
kimi-plugin-cc/
├── .claude-plugin/          # Marketplace catalog
│   └── marketplace.json
├── .github/                 # CI/CD workflows
│   └── workflows/
│       └── ci.yml
├── docs/                    # Documentation
│   ├── getting-started.md
│   └── crank-loop-blueprint.md
├── plugins/kimi/            # Plugin source (distributed)
│   ├── .claude-plugin/
│   │   └── plugin.json      # Plugin manifest
│   ├── agents/              # Agent definitions for Claude
│   ├── roles/               # Role system prompts (coder, explore) composed into dispatches
│   ├── commands/            # Slash command definitions
│   ├── hooks/               # Claude Code hooks
│   ├── prompts/             # Reusable prompt templates
│   ├── schemas/             # JSON schemas for structured output
│   ├── scripts/             # Broker + lib modules
│   │   ├── broker.mjs       # Central dispatch entry point
│   │   └── lib/             # Broker library modules (one responsibility per file)
│   └── skills/              # Reusable skills
├── plugins/kimi-code/       # Native Kimi Code plugin (dual distribution)
├── scripts/                 # Repo tooling (release.mjs, lint.mjs)
├── tasks/                   # This repo's own dev task specs (T-*.md)
├── tests/                   # Test suite
│   ├── *.test.mjs           # Unit tests (Node.js built-in test runner)
│   ├── smoke.sh             # End-to-end smoke test
│   └── fixtures/            # Test fixtures
├── kimi.plugin.json         # Kimi Code plugin manifest
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE
├── NOTICE
├── package.json
└── README.md
```

## Running Tests

### Unit Tests

```bash
npm test
```

This runs all `*.test.mjs` files using Node.js's built-in test runner.

### Smoke Tests

```bash
npm run smoke
```

This runs `tests/smoke.sh`, which validates all 9 capabilities end-to-end using a temporary workspace.

> **Note:** Smoke tests require a working Kimi CLI installation and may incur API usage.

### Manual Testing

You can test the plugin in a local Claude Code session without publishing:

```bash
# In your project directory
claude --plugin-dir /path/to/kimi-plugin-cc/plugins/kimi
```

## Code Style

- Use ES modules (`.mjs` extension or `"type": "module"` in package.json)
- Prefer `async/await` over callbacks
- Use `node:fs/promises` for async file operations
- Keep lib modules focused — one responsibility per file
- All user-facing strings go through the render module for consistent formatting

## Adding a New Command

1. Create a new file in `plugins/kimi/commands/kimi:<name>.md`
2. Add front matter with `name`, `description`, `argument-hint`, and `allowed-tools`
3. Document the command in `README.md`
4. Add handling in `plugins/kimi/scripts/broker.mjs`
5. Add tests following the existing pattern — e.g. `tests/broker.test.mjs` for dispatch behavior or `tests/arg-validation.test.mjs` for flag handling
6. Update `CHANGELOG.md`

## Adding a New Prompt Template

1. Create a new file in `plugins/kimi/prompts/<name>.md`
2. Reference it from the relevant command or agent file
3. Update `README.md` if it's user-facing

## Release Process

Releases are driven by `scripts/release.mjs`:

```bash
npm run release:dry   # dry run — all checks, no changes
npm run release       # full validation (+ optional --bump / --tag / publish)
```

The script validates, in order: clean git working tree, `.mjs` syntax lint, unit + integration tests, plugin manifest validation, a broker CLI smoke test, agent/command file validation, and an `npm pack` dry-run. Use `node scripts/release.mjs --bump <patch|minor|major> [--tag]` for the version bump and git tag.

When bumping manually, the version lives in four files — keep them in sync:

- `package.json`
- `plugins/kimi/.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `kimi.plugin.json`

Then add release notes to `CHANGELOG.md` (and `plugins/kimi/CHANGELOG.md`), commit, tag `vX.Y.Z`, and push. The marketplace picks up the new version automatically.

## Security

- Never commit API keys or tokens
- The broker never stores Kimi credentials — it delegates to the local `kimi` CLI
- Session data is stored in `~/.kimi-plugin-cc/`, not in the repo

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
