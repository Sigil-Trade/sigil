# G0 — Multisig Hardening of Program Upgrade Authority

**Status:** PENDING USER CLI ACTION
**Audit gate:** G0 — closes the bus-factor-1 structural risk (5+ characters in audit roundtable flagged this as the single biggest unmitigated risk)
**Cost:** $0
**Risk:** Zero — adds a layer of safety, removes none

## What we're doing in plain English

Right now, the on-chain Sigil program at `7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK` can be updated (or replaced) by whatever single keypair Kaleb used to deploy it. If that one key is compromised, an attacker can deploy a malicious version of the Sigil program that drains every vault using it. There is no recovery from this.

The fix: transfer the **program upgrade authority** from your single key to the Squads multisig you created (`7tvi5yJZyjpxXnbPTcR42mKVK7qbnjRjViTXv1rckNsy`, threshold 3-of-5). After this transfer, deploying ANY update to Sigil requires 3 of your 5 multisig members to sign. A single compromised key is no longer catastrophic.

## Verification — before you start

Run this to see who currently controls upgrades:

```bash
solana program show 7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK
```

Output will include an `Authority` line. Note that pubkey down — that's your current upgrade authority. If it's your personal devnet wallet, this section will close that risk.

## The transfer command

You need:
1. The keypair file that's CURRENTLY the upgrade authority (the one that deployed Sigil)
2. `solana` CLI installed (you likely have it — it's how you deployed the first time)

Then run:

```bash
solana program set-upgrade-authority \
  7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK \
  --new-upgrade-authority 7tvi5yJZyjpxXnbPTcR42mKVK7qbnjRjViTXv1rckNsy \
  --skip-new-upgrade-authority-signer-check \
  --url https://api.devnet.solana.com
```

A few notes:
- `--skip-new-upgrade-authority-signer-check` is intentional. The new authority (your Squads multisig) is a PDA — it cannot sign with a single key. This flag tells the CLI "I'm transferring TO a multisig, don't require it to co-sign the transfer."
- `--url https://api.devnet.solana.com` if your Sigil program is on devnet (per the program ID `7FtAXUcr...` registered there). Adjust if you're on a different cluster.
- The transaction will be signed by your current upgrade authority keypair (whichever Solana CLI has configured as default — verify with `solana config get` first).

## Verification — after you transfer

```bash
solana program show 7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK
```

The `Authority` line should now read `7tvi5yJZyjpxXnbPTcR42mKVK7qbnjRjViTXv1rckNsy`. If it does — **G0 is closed.**

## What this DOES and DOES NOT change

**Does:**
- Future `solana program deploy` to this program ID requires 3-of-5 Squads approval
- A compromised single key can NO LONGER replace the Sigil program
- Bus factor 1 → bus factor 3 (three independent compromises or three approvals needed)

**Does NOT:**
- Affect any existing vaults using the program (none yet — devnet)
- Affect the `owner` of individual Sigil vaults — that's a different field, set per-vault at initialize_vault time
- Affect TA-19 digest, TA-09 cosign, or any on-chain enforcement — those are unchanged
- Require a redeploy of Sigil

## If you're stuck

Common gotchas:
1. **"Authority does not match"** → your `solana config get` default keypair isn't the current upgrade authority. Either switch the CLI default (`solana config set --keypair /path/to/correct.json`) or pass `--keypair` explicitly to the command.
2. **"Insufficient funds"** → the transferring key needs ~0.0001 SOL. Top it up if needed.
3. **"Skip-new-upgrade-authority-signer-check flag not recognized"** → very old `solana` CLI; update via `solana-install update`.
4. **You're worried you'll mess it up** → run the command on a TEST program first (deploy a tiny noop program, transfer authority to a dummy multisig, verify). Solana lets you transfer back if you control both keys, so it's reversible.

## After G0 closes

Update this doc by recording:
- Date transferred: ____________
- Old authority: ____________________________________________
- New authority: `7tvi5yJZyjpxXnbPTcR42mKVK7qbnjRjViTXv1rckNsy` ✓
- Squads members (5 keys + 3 threshold): record their identities (don't dox them — just "Kaleb personal hardware", "Kaleb co-signer 1", "trusted-friend-A cold key", etc.)

Then commit this file as the audit-trail proof.

## Why audit said this is the highest-leverage non-code fix

5 of 10 audit roundtable characters (Architect, Johannes, Skeptic, Remy, Decomposer) independently flagged bus factor 1 as the single biggest unmitigated structural risk. Architect's prescription was specifically: "Squads multisig on the deploy keypair, two external keyholders. Zero dollars cost. Phase 6 prerequisite."

This is the **cheapest, highest-impact** fix in the entire audit. Five minutes of CLI work, zero dollars, transforms the catastrophic-loss profile of the entire project.

---

## EXECUTED — 2026-05-18

**Status:** ✅ CLOSED

- **Program ID:** `7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK` (devnet)
- **Old authority:** `6wrkKTM2pjkcCAbMfRz2j3AXspavu6pq3ePcuJUE3Azp` (Kaleb's default keypair at `~/.config/solana/id.json`)
- **New authority:** `7tvi5yJZyjpxXnbPTcR42mKVK7qbnjRjViTXv1rckNsy` (Squads V4 multisig "Sigil", 3-of-5 threshold)
- **Cluster:** devnet (`https://api.devnet.solana.com`)
- **Transaction executed via:** `solana program set-upgrade-authority` from the agent-middleware session

**Verification (`solana program show 7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK --url https://api.devnet.solana.com`):**
```
Program Id: 7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK
Owner: BPFLoaderUpgradeab1e11111111111111111111111
ProgramData Address: FeBb2ZC8W3CHRLgPTFgWzX3YbFPM1TwL7rCFzswxZ8Df
Authority: 7tvi5yJZyjpxXnbPTcR42mKVK7qbnjRjViTXv1rckNsy
Last Deployed In Slot: 461260004
Data Length: 1162496 (0x11bd00) bytes
Balance: 8.09217624 SOL
```

**Bus-factor-1 structural risk MITIGATED.** Future re-deploys of Sigil to this program ID require 3 of the 5 Squads members to approve. Audit's #1-flagged structural risk (5 of 10 roundtable characters independently named it) is closed.

## Residual trust assumption — Squads V4 itself (M-10 audit 2026-05-19)

Documented for transparency. Squads V4 (program ID
`SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`) itself has an upgrade
authority held by Squads Labs. If Squads Labs is compromised — for
example, a malicious upgrade is pushed to the Squads program — every
Squads V4 multisig deployed on Solana mainnet is at risk, **including
Sigil's**.

This is an irreducible trust in the Solana ecosystem, equivalent to:
- the SPL Token program (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`)
  which holds custody of every SPL token balance
- the BPF Loader Upgradeable program
  (`BPFLoaderUpgradeab1e11111111111111111111111`) which controls all
  upgradeable program deploys
- the System program which controls all SOL transfers
- the Compute Budget program — recently sysvar-related changes affected
  every program on Solana

We accept this trust because:
1. Squads is the most-deployed and most-audited multisig program on
   Solana (~85+ programs use it as their upgrade authority as of
   2026-05). The blast radius if compromised is catastrophic across the
   entire ecosystem — Squads Labs has the strongest incentive in
   Solana to defend it.
2. Alternative custody patterns (Realms, custom multisig, hardware
   security modules + on-chain attest) all carry their own trust
   assumptions; none are dramatically better in 2026-05 timeframe.
3. The defensive layering is: Squads V4 itself is upgrade-authority-
   gated by **its own** multisig (the Squads Labs operational
   multisig). A single-key compromise at Squads Labs does NOT trigger
   immediate exposure.

**Operational mitigations Sigil holders should be aware of:**
- Monitor Squads Labs security advisories (their security@squads.so
  contact).
- The Squads program upgrade authority is itself visible on-chain:
  `solana program show SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`.
  Verifying it's still a multisig (not single-key) is a one-line
  health check.
- If Squads Labs is publicly compromised, Sigil's response is to
  freeze all vaults via the existing K3 freeze ix (single-signer,
  fast), then plan a migration to a different multisig program.

This is a documented-as-accepted residual risk. No additional
on-chain mitigation is feasible.
