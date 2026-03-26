# Security Policy

## Supported Versions

| Package                   | Supported |
| ------------------------- | --------- |
| @phalnx/kit >= 0.1.0      | Yes       |
| @phalnx/core >= 0.1.0     | Yes       |
| On-chain program (phalnx) | Yes       |

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Please report security issues via one of the following channels:

- **Telegram:** [@MightyMags](https://t.me/MightyMags) (preferred for urgent issues)
- **Email:** Open a [private security advisory](https://github.com/Kaleb-Rupe/phalnx/security/advisories/new) on this repository

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

- On-chain Anchor program (`programs/phalnx/`)
- Kit SDK transaction construction (`sdk/kit/`)
- Session authority lifecycle
- Fee calculation and distribution

Out of scope:

- Denial of service against public Solana RPC endpoints
- Social engineering attacks
- Issues in third-party dependencies (report upstream)

## Bug Bounty

No formal bug bounty program at this time. Significant findings may be rewarded at the maintainer's discretion.

## Program Verification

The deployed Phalnx program can be verified against this source repository using [solana-verify](https://github.com/Ellipsis-Labs/solana-verifiable-build) (Ellipsis Labs):

### Prerequisites
- `cargo install solana-verify`
- Docker installed and running

### Verify

```bash
# Quick verification (from repo root)
npx tsx scripts/verify-program.ts --cluster devnet

# Or directly with solana-verify CLI
solana-verify verify-from-repo \
  --program-id 4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL \
  --library-name phalnx \
  --mount-path programs/phalnx \
  --url https://api.devnet.solana.com
```

### Check Upgrade Authority

```bash
solana program show 4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL --url devnet
```
