# ALT Deployment Plan — Devnet & Mainnet

Address Lookup Table (ALT) deployment steps for Phalnx composed transactions.

---

## Pre-Deployment Checklist

- [ ] All kit tests pass (`npx mocha --require tsx sdk/kit/tests/*.test.ts`)
- [ ] Shield ALT resolution verified (V6, V6b, V10 tests)
- [ ] CU recompose preserves ALT compression (V3 test)
- [ ] Changeset committed for `@phalnx/kit`
- [ ] No open critical/high audit findings

---

## 1. ALT Creation (Per Network)

### 1a. Create the ALT

```bash
# Devnet
solana address-lookup-table create \
  --keypair <authority-keypair> \
  --url devnet \
  --output-format json

# Mainnet
solana address-lookup-table create \
  --keypair <authority-keypair> \
  --url mainnet-beta \
  --output-format json
```

Save the returned ALT address.

### 1b. Extend with Phalnx Shared Accounts

The Phalnx ALT stores 5 non-program accounts shared across composed transactions:

| # | Account | Devnet | Mainnet |
|---|---------|--------|---------|
| 0 | USDC Mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| 1 | USDT Mint | `EJwZgeZrdC8TXTQbQBoL6bfuAnFUQYtEnqbJgLeNP2io` | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |
| 2 | Protocol Treasury | `Pha1nxTreasury111111111111111111111111111111` | `Pha1nxTreasury111111111111111111111111111111` |
| 3 | Instructions Sysvar | `Sysvar1nstructions1111111111111111111111111` | `Sysvar1nstructions1111111111111111111111111` |
| 4 | Clock Sysvar | `SysvarC1ock11111111111111111111111111111111` | `SysvarC1ock11111111111111111111111111111111` |

```bash
solana address-lookup-table extend <ALT_ADDRESS> \
  --keypair <authority-keypair> \
  --url <network> \
  --addresses \
    <USDC_MINT>,<USDT_MINT>,<TREASURY>,Sysvar1nstructions1111111111111111111111111,SysvarC1ock11111111111111111111111111111111
```

### 1c. Wait for Finality

```bash
# Wait ~30s for devnet, ~60s for mainnet
solana confirm <extend-tx-signature> --url <network>
```

### 1d. Verify Contents

```bash
solana address-lookup-table get <ALT_ADDRESS> --url <network> --output json
```

Confirm the output lists exactly 5 addresses in the order above.

### 1e. Update SDK Config

Edit `sdk/kit/src/alt-config.ts`:

```typescript
export const PHALNX_ALT_DEVNET = "<new-devnet-alt-address>" as Address;
export const PHALNX_ALT_MAINNET = "<new-mainnet-alt-address>" as Address;
```

### 1f. Make ALT Immutable (Production Only)

Transfer authority to the System Program to prevent future modifications:

```bash
solana address-lookup-table set-authority <ALT_ADDRESS> \
  --keypair <authority-keypair> \
  --new-authority 11111111111111111111111111111111 \
  --url <network>
```

> **Warning:** This is irreversible. Only do this after verifying ALT contents are correct.

---

## 2. SDK Release

1. Merge `feat/kit-native-sdk` → `main`
2. CI opens a **Version Packages** PR (bumps versions, generates changelogs)
3. Review and merge the Version Packages PR
4. CI publishes to npm with OIDC provenance

Never run `npm publish` manually.

---

## 3. Mainnet Readiness Gates

Before deploying the mainnet ALT:

- [ ] Devnet ALT deployed and verified
- [ ] Devnet integration tests pass with real ALT (not placeholder)
- [ ] SDK released to npm with devnet ALT address
- [ ] At least 1 week of devnet usage without ALT-related issues
- [ ] ALT contents verified against `EXPECTED_ALT_CONTENTS_MAINNET`
- [ ] Authority transfer tested on devnet first

---

## 4. Rollback Procedure

The SDK works without ALTs (S-4 graceful degradation). Rollback steps:

1. **Immediate:** No action needed — `AltCache.resolve()` returns empty on failure, composer produces valid (larger) transactions without ALT compression
2. **If ALT is corrupted:** SDK falls back automatically. To force fallback, set ALT address back to system program placeholder in `alt-config.ts` and release
3. **If ALT authority is compromised:** ALT should already be immutable (Step 1f). If not yet immutable, immediately transfer authority to System Program

The key design principle: **ALTs are an optimization, not a requirement.** Every transaction path works without them.
