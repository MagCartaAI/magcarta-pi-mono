<p align="center">
  <a href="https://shittycodingagent.ai">
    <img src="https://shittycodingagent.ai/logo.svg" alt="pi logo" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://github.com/badlogic/pi-mono/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/badlogic/pi-mono/ci.yml?style=flat-square&branch=main" /></a>
</p>
<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

# Pi Monorepo (MagCarta fork)

This repository is the **MagCarta fork** of [pi-mono](https://github.com/badlogic/pi-mono). It serves as the base for MagCarta’s **first-party agent runtime** and tooling:

- **C07 — Agent Runtime** (`@magcarta/agent-runtime`): First-party agent execution with native hook points for the Enforcement Gateway (C08m/C08f) and ADR emission (C13). Built from the **agent** package (pi-agent-core). Governance is wired via [magcarta-gateway](https://github.com/magcarta/magcarta-gateway) (C08m) using the `GovernanceProvider` interface; decisions are logged via [magcarta-adr](https://github.com/magcarta/magcarta-adr) (C13a).
- **C19 — Visual Agent Builder**: The prototype (C19p) lives in **[magcarta-builder](https://github.com/magcarta/magcarta-builder)**; it produces Agent Manifests consumed by [magcarta-onboarding](https://github.com/magcarta/magcarta-onboarding) (C06). Production builder (C19f) is planned in Wave F.

Architecture, component decomposition, and implementation waves are defined in **[magcarta-metadata](https://github.com/magcarta/magcarta-metadata)**. Identity and discovery: [magcarta-identity](https://github.com/magcarta/magcarta-identity) (C04), [magcarta-ans](https://github.com/magcarta/magcarta-ans) (C05).

---

> **Looking for the pi coding agent?** See **[packages/coding-agent](packages/coding-agent)** for installation and usage.

Tools for building AI agents and managing LLM deployments.

## Packages

| Package | Description |
|---------|-------------|
| **[@mariozechner/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@mariozechner/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@mariozechner/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@mariozechner/pi-mom](packages/mom)** | Slack bot that delegates messages to the pi coding agent |
| **[@mariozechner/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@mariozechner/pi-web-ui](packages/web-ui)** | Web components for AI chat interfaces |
| **[@mariozechner/pi-pods](packages/pods)** | CLI for managing vLLM deployments on GPU pods |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (must be run from repo root)
```

> **Note:** `npm run check` requires `npm run build` to be run first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## License

MIT
