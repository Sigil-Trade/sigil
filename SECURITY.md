# Security Policy

## Supported Versions

| Package | Supported |
|---------|-----------|
| @agent-shield/sdk >= 0.4.0 | Yes |
| @agent-shield/mcp >= 0.4.0 | Yes |
| @agent-shield/core >= 0.1.0 | Yes |
| @agent-shield/sdk >= 0.5.0 | Yes |
| On-chain program (agent_shield) | Yes |

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Please report security issues via one of the following channels:

- **Telegram:** [@MightyMags](https://t.me/MightyMags) (preferred for urgent issues)
- **Email:** Open a [private security advisory](https://github.com/Kaleb-Rupe/agentshield/security/advisories/new) on this repository

Include as much detail as possible:

1. Description of the vulnerability
2. Steps to reproduce
3. Potential impact (funds at risk, data exposure, etc.)
4. Suggested fix (if you have one)

## Response Timeline

- **Acknowledgement:** Within 48 hours
- **Assessment:** Within 1 week
- **Fix + Disclosure:** Coordinated with reporter

## Scope

The following are in scope for security reports:

- On-chain Anchor program (`programs/agent-shield/`)
- SDK transaction construction (`sdk/typescript/`)
- MCP server tool handlers (`packages/mcp/`)
- Serverless API endpoints (`api/`)
- Session authority lifecycle
- Fee calculation and distribution

Out of scope:

- Denial of service against public Solana RPC endpoints
- Social engineering attacks
- Issues in third-party dependencies (report upstream)

## Bug Bounty

No formal bug bounty program at this time. Significant findings may be rewarded at the maintainer's discretion.
