# Security Policy

## Supported Versions

| Package                   | Supported |
| ------------------------- | --------- |
| @usesigil/kit >= 0.1.0      | Yes       |
| @usesigil/custody >= 0.1.0  | Yes       |
| @usesigil/plugins >= 0.1.0  | Yes       |
| On-chain program (sigil) | Yes       |

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Please report security issues via one of the following channels:

- **Telegram:** [@MightyMags](https://t.me/MightyMags) (preferred for urgent issues)
- **Email:** Open a [private security advisory](https://github.com/Kaleb-Rupe/sigil/security/advisories/new) on this repository

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

- On-chain Anchor program (`programs/sigil/`)
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

The deployed Sigil program can be verified against this source repository using [solana-verify](https://github.com/Ellipsis-Labs/solana-verifiable-build) (Ellipsis Labs):

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
  --library-name sigil \
  --mount-path programs/sigil \
  --url https://api.devnet.solana.com
```

### Check Upgrade Authority

```bash
solana program show 4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL --url devnet
```

## Program Upgrade Authority

### Current State (Devnet)
- **Authority**: Single keypair (deployer)
- **Governance**: No multisig requirement
- **Rationale**: Devnet is for development; rapid iteration requires direct deploy

### Mainnet Plan (Pre-Launch Requirements)
1. **Phase 1 (Launch)**: Upgrade authority transferred to Squads V4 multisig (2-of-3)
   - Members: [to be determined -- must be distinct individuals with hardware wallets]
   - All upgrades require 2 of 3 signatures
2. **Phase 2 (Post-Audit)**: After security audit and 90-day stability period:
   - Option A: Transfer to higher-threshold multisig (3-of-5)
   - Option B: Renounce upgrade authority (program becomes immutable)
3. **Verification**: Anyone can check the current upgrade authority:
   ```bash
   solana program show 4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL
   ```

### SDK Verification (Optional)
The SDK does NOT enforce upgrade authority checks because:
- On devnet, authority changes frequently during development
- On mainnet, the authority is verifiable by anyone via RPC
- Baking authority checks into SDK would couple it to a specific governance model
- Program verification (see above) is a stronger guarantee than authority checks
