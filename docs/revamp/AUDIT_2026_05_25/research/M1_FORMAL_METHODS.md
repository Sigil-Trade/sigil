# M-1 Formal Methods Research

**Mission:** evaluate which formal-verification techniques actually apply to Sigil's M-1 close-with-pending-state asymmetry — and which are vaporware on Solana today.

**Decision rule (user-directed):** security-first. Tooling that *can* eliminate the bug class beats tooling that merely documents it.

---

## Methodology catalog

| Technique | Applicable to Anchor? | M-1 fit | Tooling status (2026-05) |
|---|---|---|---|
| **Certora Prover (Solana / SBF)** | Yes — works on SBF bytecode, framework-agnostic | High — can express multi-handler invariants via CVLR | **Production**. Open-sourced Feb 2025; Squads v4, Kamino Lending/Vault/LIMO, Jito V1/V2, Manifest, Texture all shipped FV reports ([SecurityReports](https://github.com/Certora/SecurityReports)) |
| **Kani Rust Verifier + OtterSec harness** | Yes — Anchor-aware harness exists | Medium — proves per-ix invariants, struggles across ix | **Research prototype**. OtterSec 2023 case study only ([osec.io](https://osec.io/blog/2023-01-26-formally-verifying-solana-programs/)); no production adopter |
| **Sec3 X-Ray (static analysis)** | Yes — both Anchor & native | **Low** — rule set does not cover lifecycle/desync ([X-Ray README](https://github.com/sec3-product/x-ray/blob/main/README.md)) | Production but wrong tool for this bug |
| **Type-state programming (Rust compile-time)** | Partial — Anchor `Context<'_, T>` already uses phantom lifetimes; account structs are not type-state | High at *language* layer; zero deployed precedent on Solana | Production language feature, **near-zero ecosystem adoption** in Anchor programs |
| **Stateright (model checker)** | No — for distributed-system actors, not on-chain programs | None for M-1 | Production for Raft/Paxos; mis-fit here |
| **Prusti (deductive verifier)** | No — explicitly "research prototype, not production-ready" ([Prusti Project paper](https://pm.inf.ethz.ch/publications/AstrauskasBilyFialaGrannanMathejaMuellerPoliSummers22.pdf)) | None | Vaporware on Solana |
| **Capability-based / object-capability model** | Yes — Solana PDA + signer-seed model *is* an ocap system | High at architecture layer; can re-frame M-1 as "missing capability revocation" | Conceptual framework; no Solana-specific tool |
| **FuzzDelSol / Soteria / StateGuard** | Yes | Low–Medium — bug oracles target arithmetic, ownership, signer; lifecycle is out-of-scope ([arXiv 2309.03006](https://arxiv.org/abs/2309.03006), [arXiv 2504.07419](https://arxiv.org/html/2504.07419v1)) | Research; Soteria closed-source |

---

## Detailed evaluation of top 3 promising techniques

### 1. Certora Solana Prover + CVLR — production-ready, highest M-1 fit

The Certora Prover decompiles SBF bytecode into its IR and discharges proof obligations to SMT solvers ([Certora blog](https://www.certora.com/blog/sol-formal-verification)). Framework-agnostic — Anchor compiles to SBF like everything else. The Rust spec layer is **CVLR** (`cvlr-asserts`, `cvlr-spec`, `cvlr-macros`, `cvlr-mathint`, `cvlr-hooks`), the successor to the now-deprecated `solana-cvt` ([cvlr repo](https://github.com/Certora/cvlr)).

For M-1 the relevant primitive is the `#[rule]` macro plus `cvt_assert!` / `cvt_assume!`. A rule can call `close_vault` symbolically with the SDK-shaped account set and assert `forall pending_class P: !P.exists`. The Kamino Lending audit demonstrated structural induction across handler boundaries ([Certora Kamino](https://www.certora.com/blog/securing-kamino-lending)) — exactly the shape M-1 needs. Squads v4 and Smart Account Program both shipped FV reports against state-machine logic. Caveat: Certora published invariants are mostly *solvency* (reserve ≥ shares) not *lifecycle*; lifecycle rules are writable but the ecosystem precedent is thinner. **Verdict: applicable today.**

### 2. Kani + OtterSec Anchor harness — research-grade, useful for unit-level proofs

OtterSec built an `anchor-lang`-aware harness that autogenerates Kani proof obligations ([OtterSec case study](https://osec.io/blog/2023-01-26-formally-verifying-solana-programs/)). Strengths: bit-precise model checking, `succeeds_if`/`errors_if` macros that map cleanly to "close_vault must hard-fail when any pending_X.lamports() > 0." Weaknesses *explicitly named by OtterSec*: path explosion, CPI "difficult if not impossible to verify," custom serialization breakage. No production Solana protocol has shipped a Kani audit in three years. **Verdict: applicable for per-ix proof of the close handler; struggles across queue → cancel → close composition.**

### 3. Type-state programming (compile-time enforcement)

The Rust idiom encodes lifecycle phases in the type — `PendingPolicy<Queued>` cannot be passed to a function expecting `PendingPolicy<Applied>` ([Cliffle typestate](https://cliffle.com/blog/rust-typestate/)). Anchor partially uses this (`Context<'info, T>` lifetimes) but account *contents* are runtime-checked. The win: the contributor-drift attack vector (Jordan's `PendingPdaClass` trait + CI exhaustiveness) collapses into "the program doesn't compile." Cost: an Anchor refactor — `pending_policy: PendingPolicy<Active | Cleared>` typing would require generic account loaders. **Verdict: applicable but no precedent. Adoption cost is real engineering.**

---

## Type-state in Rust — does it apply, and how

Yes, conceptually it is the single technique that makes M-1 *unrepresentable* rather than *checked*. The encoding for Sigil:

```rust
pub struct PendingClass<S: PendingState> { _state: PhantomData<S> }
pub enum Pending { } pub enum Cleared { }
impl Sealed for PendingClass<Pending> {}
impl Sealed for PendingClass<Cleared> {}

fn close_vault<'info>(
    ctx: Context<'info, CloseVault<'info>>,
    _: PendingClass<Cleared>,  // can only be constructed by drain handlers
    _: PendingClass<Cleared>,  // one phantom witness per class
    ...
) { ... }
```

`PhantomData` carries zero runtime cost ([Rust forum](https://users.rust-lang.org/t/using-phantomdata-with-the-type-state-builder-pattern/99087)). The compiler refuses to typecheck any call site that hasn't first produced a `Cleared` witness for each class. Contributor #7 cannot ship a new pending class without adding a `PendingClass<_>` parameter — the test that fails to compile is the exhaustiveness check.

Limit: Anchor's macro-derived account contexts make this refactor non-trivial; you'd need a per-class wrapper around `AccountLoader`. Zero deployed Solana program does this today (extensive search returned no precedent). High *theoretical* fit, high *adoption* cost, zero *ecosystem risk* once shipped.

---

## Recommendation for Sigil M-1 verification posture

**Three-layer stack, security-first ordering:**

1. **Runtime hard-fail (α)** — the primary defense. Per-class lifecycle flags + uniform `require!` in close_vault. This is the on-chain guarantee.
2. **Certora rule (within audit budget)** — write one CVLR `#[rule]`: `close_vault_succeeds ⇒ all_pending_drained`. Add to the external audit SoW. Squads/Kamino precedent says this is purchasable today, not vaporware.
3. **Type-state on the SDK side (low cost, high payoff)** — encode `PendingClass<Cleared>` witnesses in `@usesigil/kit` such that `seal()` cannot construct a close transaction without first running the drain enumeration. The SDK becomes the second wall — even if α has a bug, the SDK refuses to issue the broken ix.

**Reject:** Kani (no production precedent), Prusti (research prototype), Stateright (wrong domain), X-Ray (rule set does not cover this class), Soteria (closed-source).

---

## Security-first scoring

| Technique | Defense-in-depth | Recovery | Auditor onboarding | Long-term consistency |
|---|---|---|---|---|
| α + Certora rule + SDK typestate | 5 | 5 | 5 | 5 |
| α + Certora rule | 5 | 4 | 5 | 4 |
| α alone | 4 | 4 | 4 | 4 |
| δ + γ (R3 verdict) | 3 | 3 | 3 | 3 |
| Kani harness only | 2 | 1 | 2 | 2 |
| X-Ray scan only | 1 | 1 | 2 | 1 |
| ε (status quo) | 1 | 1 | 1 | 1 |

The stack-of-three is the only configuration that scores 5 on long-term consistency — it eliminates contributor drift at three independent layers (runtime, prover, compiler). Single-layer choices all leave at least one drift vector open.

---

## Sources

- [Certora Prover repo](https://github.com/Certora/CertoraProver) | [Certora SecurityReports](https://github.com/Certora/SecurityReports) | [Certora Solana docs](https://docs.certora.com/en/latest/docs/solana/index.html)
- [CVLR (current Rust spec lib)](https://github.com/Certora/cvlr) | [solana-cvt (deprecated predecessor)](https://github.com/Certora/solana-cvt)
- [Securing Kamino Lending — Certora blog](https://www.certora.com/blog/securing-kamino-lending) | [Squads v4 FV — Squads blog](https://squads.xyz/blog/certora-formal-verification-squads-protocol-v4)
- [OtterSec Solana FV case study (Kani)](https://osec.io/blog/2023-01-26-formally-verifying-solana-programs/) | [Kani Rust Verifier](https://github.com/model-checking/kani)
- [Sec3 X-Ray repo](https://github.com/sec3-product/x-ray) | [Sec3 blog](https://sec3.dev/blog)
- [Prusti Project paper (ETH Zurich)](https://pm.inf.ethz.ch/publications/AstrauskasBilyFialaGrannanMathejaMuellerPoliSummers22.pdf)
- [Stateright](https://github.com/stateright/stateright) | [Stateright book](https://www.stateright.rs/)
- [FuzzDelSol — arXiv 2309.03006](https://arxiv.org/abs/2309.03006) | [Solana Vulnerabilities Survey 2025 — arXiv 2504.07419](https://arxiv.org/html/2504.07419v1) | [Solana resilience study — arXiv 2406.13599](https://arxiv.org/pdf/2406.13599)
- [Object-capability model (Wikipedia)](https://en.wikipedia.org/wiki/Object-capability_model) | [Awesome ocap (curated)](https://github.com/dckc/awesome-ocap)
- [Cliffle — Typestate Pattern in Rust](https://cliffle.com/blog/rust-typestate/) | [Microsoft Rust patterns: Typestate](https://microsoft.github.io/RustTraining/rust-patterns-book/ch03-the-newtype-and-type-state-patterns.html)
- [Solana account revival attacks](https://dev.to/ohmygod/solana-account-revival-attacks-how-closed-accounts-come-back-to-haunt-you-3i8f) | [Solana Security Toolbox 2026](https://dev.to/ohmygod/the-solana-security-toolbox-in-2026-a-practitioners-guide-to-fuzzing-static-analysis-and-5h7f)
