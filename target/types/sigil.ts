/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/sigil.json`.
 */
export type Sigil = {
  "address": "7FtAXUcrann7P5HoLG7vnWcVpozwj9nqcNm6bPwA1wuK",
  "metadata": {
    "name": "sigil",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "On-chain guardrails for AI agents on Solana - Permission controls, spending limits, and audit infrastructure for autonomous agents (Sigil)"
  },
  "instructions": [
    {
      "name": "acceptOwnershipTransfer",
      "docs": [
        "Phase 8 C26 — accept a queued ownership transfer (standard EOA path).",
        "The `new_owner` signs after the timelock window elapses. Hard-rejects",
        "when `pending.is_multisig_target == true` (use the Batch 4 multisig",
        "variant instead). Pending PDA closes; rent returns to `new_owner`.",
        "Vault.owner is overwritten; policy.policy_version bumps."
      ],
      "discriminator": [
        30,
        187,
        65,
        5,
        93,
        131,
        38,
        208
      ],
      "accounts": [
        {
          "name": "newOwner",
          "docs": [
            "The `new_owner` queued at initiate. Pubkey identity verified in the",
            "handler against `pending.new_owner` (defense-in-depth)."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "docs": [
            "Vault is mutated (owner field overwritten). PDA derivation uses the",
            "immutable `vault.vault_authority` field (LBL-01) — the seed binding",
            "survives the owner mutation that this handler performs, so subsequent",
            "owner-side ix from `new_owner` continue to resolve the same vault",
            "account. Handler-level `require_keys_eq!(pending.current_owner,",
            "vault.owner)` replaces the implicit seed-derivation binding that",
            "previously enforced the queue→accept owner match."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          },
          "relations": [
            "pending"
          ]
        },
        {
          "name": "policy",
          "docs": [
            "Policy is mutated (policy_version bump + `policy_preview_digest`",
            "recompute — see handler lines 173-223)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "pending",
          "docs": [
            "PendingOwnershipTransfer PDA. `close = new_owner` returns rent to the",
            "signer. `has_one = vault` binds the PDA to this vault explicitly",
            "(the seed derivation already enforces this via `vault.key()`, but the",
            "constraint is defense-in-depth against future seeds drift — same",
            "pattern as the §RP-1 I-2 audit-log guard)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  111,
                  119,
                  110,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "auditLogSuccess",
          "docs": [
            "Phase 7 — success audit log; entry appended after state mutation."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "slotHashesSysvar",
          "address": "SysvarS1otHashes111111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "acceptOwnershipTransferMultisig",
      "docs": [
        "Phase 8 Batch 4 — accept a queued ownership transfer via Squads V4",
        "multisig. The `multisig_pda` is an UncheckedAccount (NOT a Signer) —",
        "Squads V4 vault PDAs have no private key. Authority is enforced by",
        "(a) `multisig_pda.owner == SQUADS_V4_PROGRAM_ID`, (b) pubkey identity",
        "match against `pending.new_owner`, and (c) `pending.is_multisig_target",
        "== true`. Pending PDA closes with rent → multisig_pda. Vault.owner",
        "is overwritten; policy.policy_version bumps. `OwnershipTransferAccepted`",
        "is emitted with `via_multisig: true`."
      ],
      "discriminator": [
        112,
        147,
        61,
        110,
        221,
        182,
        203,
        99
      ],
      "accounts": [
        {
          "name": "multisigPda",
          "docs": [
            "(multisig custody disabled in V1) before reading any account."
          ],
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          },
          "relations": [
            "pending"
          ]
        },
        {
          "name": "policy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "pending",
          "docs": [
            "`has_one = vault` + the close target are retained for IDL stability. The",
            "close never runs because the handler returns `Err` before any Anchor",
            "post-handler step executes."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  111,
                  119,
                  110,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "auditLogSuccess",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "slotHashesSysvar",
          "address": "SysvarS1otHashes111111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "agentTransfer",
      "docs": [
        "Transfer tokens from the vault to an allowed destination.",
        "Only the agent can call this. Stablecoin-only."
      ],
      "discriminator": [
        199,
        111,
        151,
        49,
        124,
        13,
        150,
        44
      ],
      "accounts": [
        {
          "name": "agent",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          },
          "relations": [
            "policy"
          ]
        },
        {
          "name": "policy",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "tracker",
          "docs": [
            "Zero-copy SpendTracker"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  99,
                  107,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "agentSpendOverlay",
          "docs": [
            "Zero-copy AgentSpendOverlay — per-agent rolling spend"
          ],
          "writable": true
        },
        {
          "name": "vaultTokenAccount",
          "docs": [
            "Vault's PDA-owned token account (source)"
          ],
          "writable": true
        },
        {
          "name": "tokenMintAccount",
          "docs": [
            "Token mint account for decimals validation"
          ]
        },
        {
          "name": "destinationTokenAccount",
          "docs": [
            "Destination token account (must be in allowed destinations)"
          ],
          "writable": true
        },
        {
          "name": "feeDestinationTokenAccount",
          "docs": [
            "Developer fee destination token account"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "protocolTreasuryTokenAccount",
          "docs": [
            "Protocol treasury token account"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "auditLogSuccess",
          "docs": [
            "Phase 7 / L11-1 — success audit log; entry appended after the transfers.",
            "PDA + address-pinned sysvar are auto-resolved by the Anchor client, so",
            "existing `agent_transfer` callers need not pass them explicitly (same as",
            "`deposit_funds`)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "slotHashesSysvar",
          "address": "SysvarS1otHashes111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "expectedPolicyVersion",
          "type": "u64"
        }
      ]
    },
    {
      "name": "applyAgentGrant",
      "docs": [
        "Phase 8 PEN-CROSS-1 — apply a queued OPERATOR-class agent grant past",
        "the timelock. Inserts the agent into `vault.agents`, claims an",
        "AgentSpendOverlay slot (fail-closed when `spending_limit_usd > 0`),",
        "re-derives `policy.policy_preview_digest` with the NEW",
        "`agent_set_hash`, bumps `policy.policy_version`, closes the pending",
        "PDA, and emits `AgentGrantApplied`."
      ],
      "discriminator": [
        236,
        230,
        108,
        143,
        155,
        71,
        185,
        87
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          },
          "relations": [
            "pending"
          ]
        },
        {
          "name": "policy",
          "docs": [
            "Policy is mutated (policy_version bump + policy_preview_digest recompute)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "pending",
          "docs": [
            "PendingAgentGrant PDA. `close = owner` returns rent to the signer",
            "(mirrors register_agent rent payer). `has_one = vault` binds the PDA",
            "to this vault explicitly (defense-in-depth alongside seed derivation)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  97,
                  103,
                  101,
                  110,
                  116,
                  95,
                  103,
                  114,
                  97,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "agentSpendOverlay",
          "docs": [
            "Agent spend overlay — per-agent tracking slot. Same seeds as",
            "register_agent so the apply path lands in the same overlay."
          ],
          "writable": true
        },
        {
          "name": "auditLogSuccess",
          "docs": [
            "Phase 7 — success audit log; entry appended after state mutation."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "slotHashesSysvar",
          "address": "SysvarS1otHashes111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "applyAgentPermissionsUpdate",
      "docs": [
        "Apply a queued agent permissions update after timelock expires."
      ],
      "discriminator": [
        234,
        166,
        205,
        3,
        28,
        166,
        221,
        240
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          },
          "relations": [
            "policy"
          ]
        },
        {
          "name": "policy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "pendingAgentPerms",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  97,
                  103,
                  101,
                  110,
                  116,
                  95,
                  112,
                  101,
                  114,
                  109,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "pending_agent_perms.agent",
                "account": "pendingAgentPermissionsUpdate"
              }
            ]
          }
        },
        {
          "name": "agentSpendOverlay",
          "docs": [
            "Agent spend overlay — per-agent tracking slot."
          ],
          "writable": true
        },
        {
          "name": "auditLogSuccess",
          "docs": [
            "M-6 (audit 2026-05-21) — success audit log; entry appended after",
            "the capability / spending_limit / policy_version mutations land."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "slotHashesSysvar",
          "docs": [
            "rejects any mismatched sysvar pubkey before the handler runs."
          ],
          "address": "SysvarS1otHashes111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "applyPendingPolicy",
      "docs": [
        "Apply a queued policy update after the timelock expires."
      ],
      "discriminator": [
        114,
        212,
        19,
        227,
        89,
        199,
        74,
        62
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          },
          "relations": [
            "policy",
            "pendingPolicy"
          ]
        },
        {
          "name": "policy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "pendingPolicy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "auditLogSuccess",
          "docs": [
            "Phase 7 — success audit log; entry appended after policy applied."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "slotHashesSysvar",
          "address": "SysvarS1otHashes111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "approvePendingPolicy",
      "docs": [
        "Async cosign (2026-06-17): the bound cosigner K approves an elevated",
        "queued policy update on-chain. `apply_pending_policy` then requires",
        "`cosign_approved == true`. See `ROADMAP/COSIGN_ASYNC_APPROVAL_2026-06-17`."
      ],
      "discriminator": [
        151,
        218,
        153,
        6,
        155,
        67,
        8,
        200
      ],
      "accounts": [
        {
          "name": "cosigner",
          "docs": [
            "The bound cosigner K. Must equal `policy.cosign_session_pubkey`."
          ],
          "signer": true
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          },
          "relations": [
            "policy",
            "pendingPolicy"
          ]
        },
        {
          "name": "policy",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "pendingPolicy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "cancelAgentGrant",
      "docs": [
        "Phase 8 §RP Fix-Up B (PEN-02b CRITICAL, audit 2026-05-19) — cancel a",
        "queued OPERATOR-class agent grant during the timelock window. The",
        "`PendingAgentGrant` PDA closes; rent returns to the owner. The vault's",
        "agent set is NOT mutated (the queued agent never entered).",
        "Symmetric with `cancel_ownership_transfer` on cosign — when",
        "`policy.cosign_required == true`, the cancel also requires a non-",
        "owner signer in `remaining_accounts` (D4 decision: closes the",
        "phished-key cancel-and-re-queue bypass)."
      ],
      "discriminator": [
        193,
        182,
        191,
        195,
        80,
        150,
        140,
        196
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          },
          "relations": [
            "pending"
          ]
        },
        {
          "name": "policy",
          "docs": [
            "PolicyConfig is read-only here — only `cosign_required` is consulted",
            "(D4 symmetric cosign gate). PDA seeds derivation is the load-bearing",
            "vault binding; cosmetic `has_one = vault` is unnecessary (§RP-1 V6)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "pending",
          "docs": [
            "PendingAgentGrant PDA. `close = owner` returns rent to the signer.",
            "`has_one = vault` binds the PDA to this vault explicitly (the seed",
            "derivation already enforces this via `vault.key()`, but the constraint",
            "is defense-in-depth against future seeds drift — same pattern as the",
            "§RP-1 I-2 audit-log guard)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  97,
                  103,
                  101,
                  110,
                  116,
                  95,
                  103,
                  114,
                  97,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "auditLogSuccess",
          "docs": [
            "Phase 7 — success audit log; entry appended after state mutation."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "slotHashesSysvar",
          "address": "SysvarS1otHashes111111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "cancelAgentPermissionsUpdate",
      "docs": [
        "Cancel a queued agent permissions update."
      ],
      "discriminator": [
        92,
        232,
        92,
        115,
        110,
        238,
        235,
        55
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
        },
        {
          "name": "policy",
          "docs": [
            "PolicyConfig is read-only here — only `cosign_required` (and the bound",
            "`cosign_session_pubkey`) are consulted for the L1-1 / D4 symmetric",
            "cosign gate (audit 2026-06-15). Mirrors `cancel_agent_grant.rs:63-67`",
            "and `cancel_pending_policy.rs` (M2a). PDA seed derivation is the",
            "load-bearing vault binding; a cosmetic `has_one = vault` is unnecessary."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "pendingAgentPerms",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  97,
                  103,
                  101,
                  110,
                  116,
                  95,
                  112,
                  101,
                  114,
                  109,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "pending_agent_perms.agent",
                "account": "pendingAgentPermissionsUpdate"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "cancelOwnershipTransfer",
      "docs": [
        "Phase 8 C26 — cancel an in-flight ownership transfer. The current",
        "owner signs. Symmetric with `initiate_ownership_transfer` on cosign",
        "(D4 decision — closes the phished-key cancel-and-re-initiate bypass).",
        "Pending PDA closes; rent returns to `current_owner`."
      ],
      "discriminator": [
        2,
        184,
        195,
        105,
        138,
        142,
        154,
        75
      ],
      "accounts": [
        {
          "name": "currentOwner",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "docs": [
            "Vault binding via PDA seeds (Phase 8 LBL-01): the seeds use",
            "`vault.vault_authority` (immutable, set at init), NOT the signer key.",
            "The handler-level `require_keys_eq!(current_owner.key(),",
            "pending.current_owner)` below is now the LOAD-BEARING signer-binding",
            "check (pre-LBL-01 the seed derivation incidentally enforced this when",
            "the seed-key was `current_owner.key()`)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          },
          "relations": [
            "pending"
          ]
        },
        {
          "name": "policy",
          "docs": [
            "PolicyConfig is read-only here — `cosign_required` is the only field",
            "consulted (D4 symmetric cosign gate)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "pending",
          "docs": [
            "PendingOwnershipTransfer PDA. `close = current_owner` returns rent to",
            "the signer. `has_one = vault` defense-in-depth binds the PDA to this",
            "vault explicitly."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  111,
                  119,
                  110,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "auditLogSuccess",
          "docs": [
            "Phase 7 — success audit log; entry appended after state mutation."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "slotHashesSysvar",
          "address": "SysvarS1otHashes111111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "cancelPendingPolicy",
      "docs": [
        "Cancel a queued policy update."
      ],
      "discriminator": [
        153,
        36,
        104,
        200,
        50,
        94,
        207,
        33
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          },
          "relations": [
            "policy",
            "pendingPolicy"
          ]
        },
        {
          "name": "policy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "pendingPolicy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "closePostAssertions",
      "docs": [
        "Close post-execution assertions for a vault. Returns rent to owner."
      ],
      "discriminator": [
        226,
        172,
        252,
        173,
        29,
        236,
        59,
        248
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
        },
        {
          "name": "policy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "postAssertions",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  116,
                  95,
                  97,
                  115,
                  115,
                  101,
                  114,
                  116,
                  105,
                  111,
                  110,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "expectedDigest",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "closeVault",
      "docs": [
        "Close the vault entirely. Reclaims rent from all PDAs."
      ],
      "discriminator": [
        141,
        103,
        17,
        126,
        72,
        75,
        29,
        29
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          },
          "relations": [
            "policy"
          ]
        },
        {
          "name": "policy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "tracker",
          "docs": [
            "Zero-copy SpendTracker — close returns rent to owner"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  99,
                  107,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "agentSpendOverlay",
          "docs": [
            "Zero-copy AgentSpendOverlay — close returns rent to owner"
          ],
          "writable": true
        },
        {
          "name": "auditLogSuccess",
          "docs": [
            "Phase 7 — close success audit log; rent returns to owner.",
            "Closing here closes the close+reinit replay window: a vault can be",
            "re-initialised at the same (owner, vault_id) only after the audit",
            "logs have been reclaimed, and PEN-CROSS-2 still protects against",
            "stale-digest replay across the close boundary."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "auditLogRejected",
          "docs": [
            "Phase 7 — close rejected audit log; rent returns to owner."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  114,
                  101,
                  106,
                  101,
                  99,
                  116,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "createPostAssertions",
      "docs": [
        "Create post-execution assertions for a vault.",
        "Assertions check account data bytes AFTER DeFi instructions execute."
      ],
      "discriminator": [
        204,
        21,
        218,
        182,
        202,
        140,
        239,
        63
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
        },
        {
          "name": "policy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "postAssertions",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  116,
                  95,
                  97,
                  115,
                  115,
                  101,
                  114,
                  116,
                  105,
                  111,
                  110,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "entries",
          "type": {
            "vec": {
              "defined": {
                "name": "postAssertionEntry"
              }
            }
          }
        },
        {
          "name": "expectedDigest",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "depositFunds",
      "docs": [
        "Deposit SPL tokens into the vault's PDA-controlled token account.",
        "Only the owner can call this."
      ],
      "discriminator": [
        202,
        39,
        52,
        211,
        53,
        20,
        250,
        88
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "ownerTokenAccount",
          "docs": [
            "Owner's token account to transfer from"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "vaultTokenAccount",
          "docs": [
            "Vault's PDA-controlled token account"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "auditLogSuccess",
          "docs": [
            "Phase 7 — success audit log; entry appended after token transfer."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "slotHashesSysvar",
          "address": "SysvarS1otHashes111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "finalizeSession",
      "docs": [
        "Finalize a session after the DeFi action completes.",
        "Revokes delegation, closes SessionAuthority PDA."
      ],
      "discriminator": [
        34,
        148,
        144,
        47,
        37,
        130,
        206,
        161
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          },
          "relations": [
            "session"
          ]
        },
        {
          "name": "session",
          "docs": [
            "Session rent is returned to the session's agent (who paid for it).",
            "Seeds include token_mint for per-token concurrent sessions."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  115,
                  115,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "session.agent",
                "account": "sessionAuthority"
              },
              {
                "kind": "account",
                "path": "session.authorized_token",
                "account": "sessionAuthority"
              }
            ]
          }
        },
        {
          "name": "sessionRentRecipient",
          "writable": true
        },
        {
          "name": "policy",
          "docs": [
            "Policy config for outcome-based cap checking during finalization.",
            "Boxed to keep `try_accounts` under the 4096-byte BPF stack limit: PolicyConfig",
            "is ~1.3KB and the M1 output-ownership account pushed the FinalizeSession context",
            "8 bytes over on stable Anchor (runtime \"Access violation in stack frame\").",
            "Boxing moves the deserialized account to the heap (transparent auto-deref in the",
            "handler) — no behavior change."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "tracker",
          "docs": [
            "Zero-copy SpendTracker for recording non-stablecoin swap value"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  99,
                  107,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "agentSpendOverlay",
          "docs": [
            "Zero-copy AgentSpendOverlay — per-agent rolling spend"
          ],
          "writable": true
        },
        {
          "name": "vaultTokenAccount",
          "docs": [
            "Vault's PDA token account for the session's token.",
            "L2-1 (audit 2026-06-15): fail-fast that, when present, this ATA is owned",
            "by the vault PDA. The outcome path already re-reads the raw post-CPI",
            "owner field and asserts owner==vault, so this is defense-in-depth — but",
            "it rejects a substituted token account at account-resolution rather than",
            "deep in the handler."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "outputStablecoinAccount",
          "docs": [
            "Vault's stablecoin ATA for outcome-based spending verification.",
            "Required when session.output_mint != Pubkey::default() (all spending)."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "outputSwapAccount",
          "docs": [
            "M1 output-ownership closure — the validate-pinned VAULT-OWNED account an",
            "acquiring (stablecoin-input) swap must have credited. finalize re-reads its",
            "raw post-CPI bytes and asserts owner==vault, mint==pinned, and balance",
            "strictly INCREASED. Owner is checked in the handler (like F-Q8 above), not",
            "as a struct constraint. Boxed to keep try_accounts under the 4096 BPF",
            "stack limit. Required whenever a stablecoin-input spend moves value."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "instructionsSysvar",
          "docs": [
            "Instructions sysvar for post-finalize instruction verification."
          ],
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "auditLogSuccess",
          "docs": [
            "Phase 7 — SUCCESS-path audit log. Written when the finalize completes",
            "the non-expired branch."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "auditLogRejected",
          "docs": [
            "Phase 7 — REJECTED-path audit log. Written when the finalize takes",
            "the expired branch (permissionless-crank cleanup). Audit #2 F-19",
            "keeps this separate from the success buffer so a crank-attacker",
            "cannot displace legitimate success history."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  114,
                  101,
                  106,
                  101,
                  99,
                  116,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "slotHashesSysvar",
          "address": "SysvarS1otHashes111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "freezeVault",
      "docs": [
        "Freeze the vault immediately. Preserves all agent entries.",
        "Only the owner can call this. Use reactivate_vault to unfreeze.",
        "F2-H1 fix: pairs of (session_pda, vault_token_account) in remaining_accounts",
        "are revoked so a runaway agent cannot continue spending against an",
        "in-flight session window."
      ],
      "discriminator": [
        144,
        211,
        63,
        236,
        97,
        31,
        170,
        175
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
        },
        {
          "name": "auditLogSuccess",
          "docs": [
            "Phase 7 — success audit log; entry appended after status flip."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "slotHashesSysvar",
          "docs": [
            "Address constrained to the canonical sysvar pubkey so a tampered caller",
            "cannot substitute a stale or attacker-controlled account."
          ],
          "address": "SysvarS1otHashes111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "initializeVault",
      "docs": [
        "Initialize a new agent vault with policy configuration.",
        "Only the owner can call this. Creates vault PDA, policy PDA,",
        "and zero-copy spend tracker PDA."
      ],
      "discriminator": [
        48,
        191,
        163,
        44,
        71,
        129,
        63,
        164
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "arg",
                "path": "vaultId"
              }
            ]
          }
        },
        {
          "name": "policy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "tracker",
          "docs": [
            "Zero-copy SpendTracker"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  99,
                  107,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "agentSpendOverlay",
          "docs": [
            "Agent spend overlay — per-agent contribution tracking"
          ],
          "writable": true
        },
        {
          "name": "auditLogSuccess",
          "docs": [
            "Phase 7 — audit log of SUCCESS-path mutating instructions.",
            "Allocated at vault creation. Owner pays rent. Failure to allocate",
            "aborts vault creation (init failure → atomic rollback)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "auditLogRejected",
          "docs": [
            "Phase 7 — audit log of REJECTED finalize attempts (permissionless-",
            "crank window). Separate from success buffer per Audit #2 F-19 so a",
            "rejected-finalize burst cannot displace legitimate success history."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  114,
                  101,
                  106,
                  101,
                  99,
                  116,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "feeDestination"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "vaultId",
          "type": "u64"
        },
        {
          "name": "dailySpendingCapUsd",
          "type": "u64"
        },
        {
          "name": "maxTransactionSizeUsd",
          "type": "u64"
        },
        {
          "name": "protocolMode",
          "type": "u8"
        },
        {
          "name": "protocols",
          "type": {
            "vec": "pubkey"
          }
        },
        {
          "name": "developerFeeRate",
          "type": "u16"
        },
        {
          "name": "maxSlippageBps",
          "type": "u16"
        },
        {
          "name": "timelockDuration",
          "type": "u64"
        },
        {
          "name": "allowedDestinations",
          "type": {
            "vec": "pubkey"
          }
        },
        {
          "name": "protocolCaps",
          "type": {
            "vec": "u64"
          }
        },
        {
          "name": "observeOnly",
          "type": "bool"
        },
        {
          "name": "operatingHours",
          "type": "u32"
        },
        {
          "name": "autoPromoteGrays",
          "type": "bool"
        },
        {
          "name": "autoRevokeThreshold",
          "type": "u8"
        },
        {
          "name": "stableBalanceFloor",
          "type": "u64"
        },
        {
          "name": "perRecipientDailyCapUsd",
          "type": "u64"
        },
        {
          "name": "cosignRequired",
          "type": "bool"
        },
        {
          "name": "previewDigest",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "initiateOwnershipTransfer",
      "docs": [
        "Phase 8 C26 — initiate an ownership transfer with mandatory timelock.",
        "Owner queues a `PendingOwnershipTransfer` PDA bound to the vault.",
        "`is_multisig_target` selects between the standard EOA accept (Batch 3",
        "`accept_ownership_transfer`) and the Squads V4 accept (Batch 4",
        "`accept_ownership_transfer_multisig`). Cosign-opted-in vaults require",
        "a non-owner signer in `remaining_accounts` (interim cosign gate)."
      ],
      "discriminator": [
        22,
        108,
        197,
        103,
        223,
        145,
        132,
        65
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
        },
        {
          "name": "policy",
          "docs": [
            "PolicyConfig is read-only here — `cosign_required` is the only field",
            "consulted (ISC-129 interim cosign gate)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "pending",
          "docs": [
            "PendingOwnershipTransfer PDA. `init` ⇒ ISC-30 / 6103 path: a second",
            "initiate without an intervening `cancel_ownership_transfer` fails",
            "hard because Anchor sees the account is already initialised."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  111,
                  119,
                  110,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "auditLogSuccess",
          "docs": [
            "Phase 7 — success audit log; entry appended after state mutation."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "slotHashesSysvar",
          "address": "SysvarS1otHashes111111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "newOwner",
          "type": "pubkey"
        },
        {
          "name": "isMultisigTarget",
          "type": "bool"
        }
      ]
    },
    {
      "name": "pauseAgent",
      "docs": [
        "Pause a specific agent. Blocks all agent actions while preserving config.",
        "Only the owner can call this."
      ],
      "discriminator": [
        148,
        32,
        1,
        26,
        147,
        122,
        178,
        140
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
        },
        {
          "name": "policy",
          "docs": [
            "PEN-CROSS-5 (Phase 4 absorption) — bump policy_version on pause.",
            "Mirrors revoke semantics: pause is a kill-switch for an agent,",
            "and concurrent validate_and_authorize calls must reject with",
            "PolicyVersionMismatch instead of relying on the slower",
            "is_agent_paused constraint check."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "auditLogSuccess",
          "docs": [
            "Phase 7 — success audit log; entry appended after pause flip."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "slotHashesSysvar",
          "address": "SysvarS1otHashes111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "agentToPause",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "promoteGraylistDestination",
      "docs": [
        "TA-07 (Phase 3): owner-only fast-track promotion of a destination",
        "out of the 24h graylist window. The destination must already be on",
        "the allowlist (otherwise rejected as DestinationNotAllowed). Sets",
        "the entry's `unlock_unix` to `clock.unix_timestamp` so spending",
        "paths accept it immediately.",
        "",
        "No timelock. Promotion is a strict subset of the already-signed",
        "allowlist authorisation; the owner pays a friction cost by",
        "default but can opt out per-destination."
      ],
      "discriminator": [
        227,
        87,
        73,
        141,
        202,
        251,
        202,
        228
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          },
          "relations": [
            "policy"
          ]
        },
        {
          "name": "policy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "destination",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "queueAgentGrant",
      "docs": [
        "Phase 8 PEN-CROSS-1 — queue an OPERATOR-class agent grant with mandatory",
        "timelock. After `register_agent` was tightened to reject",
        "`capability == CAPABILITY_OPERATOR`, this is the ONLY path to add a",
        "new OPERATOR-class agent. Cosign-opted-in vaults require a non-owner",
        "signer in `remaining_accounts`. The pending PDA at",
        "`[b\"pending_agent_grant\", vault]` lives until `apply_agent_grant`",
        "(after `MIN_TIMELOCK_DURATION = 1800s`)."
      ],
      "discriminator": [
        136,
        162,
        54,
        49,
        167,
        254,
        200,
        26
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
        },
        {
          "name": "policy",
          "docs": [
            "PolicyConfig is read-only here — only `cosign_required` is consulted.",
            "PDA seeds derivation [b\"policy\", vault.key()] is the load-bearing",
            "vault binding; cosmetic `has_one = vault` is unnecessary (§RP-1 V6)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "pending",
          "docs": [
            "PendingAgentGrant PDA. `init` ⇒ duplicate-queue rejects via Anchor's",
            "\"account already in use\" path (mirrors PendingOwnershipTransfer's",
            "double-init guard)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  97,
                  103,
                  101,
                  110,
                  116,
                  95,
                  103,
                  114,
                  97,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "auditLogSuccess",
          "docs": [
            "Phase 7 — success audit log; entry appended after state mutation."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "slotHashesSysvar",
          "address": "SysvarS1otHashes111111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "agent",
          "type": "pubkey"
        },
        {
          "name": "capability",
          "type": "u8"
        },
        {
          "name": "spendingLimitUsd",
          "type": "u64"
        }
      ]
    },
    {
      "name": "queueAgentPermissionsUpdate",
      "docs": [
        "Queue an agent permissions update. Timelock-gated.",
        "Per-agent PDA allows concurrent pending updates for different agents.",
        "TA-06 (Phase 3): adds `cooldown_seconds` — per-agent cooldown stored",
        "on `AgentSpendOverlay.cooldown_seconds[slot]`. 0 disables. Bound at",
        "queue time and applied at apply time onto the agent's overlay slot.",
        "",
        "Round 2 F-RP3-2 fix (audit 2026-05-19): adds `cosign_session` —",
        "on cosign-opted-in vaults, raising capability / spending_limit OR",
        "setting a non-zero cooldown is an \"elevated mutation\" and MUST be",
        "cosigned. Non-elevated callers pass `Pubkey::default()`."
      ],
      "discriminator": [
        182,
        37,
        105,
        181,
        28,
        195,
        223,
        167
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          },
          "relations": [
            "policy"
          ]
        },
        {
          "name": "policy",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "pendingAgentPerms",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  97,
                  103,
                  101,
                  110,
                  116,
                  95,
                  112,
                  101,
                  114,
                  109,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "arg",
                "path": "agent"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "agent",
          "type": "pubkey"
        },
        {
          "name": "newCapability",
          "type": "u8"
        },
        {
          "name": "spendingLimitUsd",
          "type": "u64"
        },
        {
          "name": "cooldownSeconds",
          "type": "u64"
        },
        {
          "name": "cosignSession",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "queuePolicyUpdate",
      "docs": [
        "Queue a policy update when timelock is active.",
        "TA-09 (Phase 3): adds `cosign_session: Pubkey` arg. Pass",
        "`Pubkey::default()` for non-elevated mutations; for elevated",
        "mutations pass the cosigner pubkey and include the corresponding",
        "signer in `remaining_accounts`."
      ],
      "discriminator": [
        149,
        18,
        76,
        197,
        179,
        193,
        91,
        77
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          },
          "relations": [
            "policy"
          ]
        },
        {
          "name": "policy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "pendingPolicy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "dailySpendingCapUsd",
          "type": {
            "option": "u64"
          }
        },
        {
          "name": "maxTransactionAmountUsd",
          "type": {
            "option": "u64"
          }
        },
        {
          "name": "protocolMode",
          "type": {
            "option": "u8"
          }
        },
        {
          "name": "protocols",
          "type": {
            "option": {
              "vec": "pubkey"
            }
          }
        },
        {
          "name": "developerFeeRate",
          "type": {
            "option": "u16"
          }
        },
        {
          "name": "maxSlippageBps",
          "type": {
            "option": "u16"
          }
        },
        {
          "name": "timelockDuration",
          "type": {
            "option": "u64"
          }
        },
        {
          "name": "allowedDestinations",
          "type": {
            "option": {
              "vec": "pubkey"
            }
          }
        },
        {
          "name": "sessionExpirySeconds",
          "type": {
            "option": "u64"
          }
        },
        {
          "name": "hasProtocolCaps",
          "type": {
            "option": "bool"
          }
        },
        {
          "name": "protocolCaps",
          "type": {
            "option": {
              "vec": "u64"
            }
          }
        },
        {
          "name": "destinationMode",
          "type": {
            "option": "u8"
          }
        },
        {
          "name": "operatingHours",
          "type": {
            "option": "u32"
          }
        },
        {
          "name": "stableBalanceFloor",
          "type": {
            "option": "u64"
          }
        },
        {
          "name": "perRecipientDailyCapUsd",
          "type": {
            "option": "u64"
          }
        },
        {
          "name": "cosignRequired",
          "type": {
            "option": "bool"
          }
        },
        {
          "name": "cosignSessionPubkey",
          "type": {
            "option": "pubkey"
          }
        },
        {
          "name": "operatorGrantDelaySeconds",
          "type": {
            "option": "u64"
          }
        },
        {
          "name": "cosignSession",
          "type": "pubkey"
        },
        {
          "name": "newPolicyPreviewDigest",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "reactivateVault",
      "docs": [
        "Reactivate a frozen vault. Optionally add a new agent with permissions."
      ],
      "discriminator": [
        245,
        50,
        143,
        70,
        114,
        220,
        25,
        251
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
        },
        {
          "name": "policy",
          "docs": [
            "Round 2 F-RP3-1 fix (audit 2026-05-19): policy is now mutated by",
            "`reactivate_vault` to:",
            "1. Read `cosign_required` for the interim cosign gate (the previous",
            "handler granted FULL_CAPABILITY to a fresh agent with NO cosign",
            "gate on a cosign-opted-in vault — phished-owner instant operator",
            "grant via freeze→reactivate(attacker, FULL_CAPABILITY)).",
            "2. Bump `policy_version` after the agent push so any in-flight",
            "validate_and_authorize fails fast with PolicyVersionMismatch",
            "rather than relying on the slower vault.is_agent constraint.",
            "",
            "Policy-to-vault binding via PDA seeds — same pattern as",
            "`register_agent.rs:35-40`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "auditLogSuccess",
          "docs": [
            "Phase 7 — success audit log; entry appended after status flip."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "slotHashesSysvar",
          "address": "SysvarS1otHashes111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "newAgent",
          "type": {
            "option": "pubkey"
          }
        },
        {
          "name": "newAgentCapability",
          "type": {
            "option": "u8"
          }
        }
      ]
    },
    {
      "name": "recordAgentViolation",
      "docs": [
        "TA-17 (Phase 3): record an on-chain policy-violation failure for",
        "an agent. Owner-only. `error_code` MUST be in the policy-violation",
        "range (6074-6091); external codes (CU exhaustion, auth, init)",
        "reject with InvalidPermissions.",
        "",
        "When `agent.consecutive_failures >= policy.auto_revoke_threshold`,",
        "the agent's capability is set to DISABLED, policy_version bumps,",
        "and `AgentAutoRevoked` event fires. Subsequent",
        "validate_and_authorize calls reject with `ErrAutoRevoked` (6090).",
        "Owner re-enables via existing queue_agent_permissions_update."
      ],
      "discriminator": [
        131,
        113,
        120,
        227,
        219,
        36,
        160,
        109
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          },
          "relations": [
            "policy"
          ]
        },
        {
          "name": "policy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "auditLogSuccess",
          "docs": [
            "M-8 (audit 2026-05-21) — success audit log; entry appended ONLY",
            "when the failure counter trips `auto_revoke_threshold` and the",
            "agent is forcibly disabled. Non-trip increments don't write here",
            "(policy state is unchanged in that branch)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "slotHashesSysvar",
          "docs": [
            "rejects any mismatched sysvar pubkey before the handler runs."
          ],
          "address": "SysvarS1otHashes111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "agent",
          "type": "pubkey"
        },
        {
          "name": "errorCode",
          "type": "u32"
        }
      ]
    },
    {
      "name": "registerAgent",
      "docs": [
        "Register an agent's signing key to this vault with per-agent permissions.",
        "Only the owner can call this. Up to 10 agents per vault."
      ],
      "discriminator": [
        135,
        157,
        66,
        195,
        2,
        113,
        175,
        30
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
        },
        {
          "name": "policy",
          "docs": [
            "PEN-CROSS-5 (Phase 4 absorption) — policy is now mutated by",
            "register/revoke/pause/unpause to bump `policy_version` as a",
            "defense-in-depth OCC signal. Existing `vault.is_agent` /",
            "`is_agent_paused` constraints already reject the TOCTOU window;",
            "the version bump lets concurrent validate_and_authorize calls fail",
            "fast with PolicyVersionMismatch instead of relying on the slower",
            "constraint check.",
            "",
            "§RP-1 V6 clarification (2026-05-18): the policy-to-vault binding is",
            "enforced by the PDA seeds derivation `[b\"policy\", vault.key().as_ref()]`",
            "— functionally equivalent to `has_one = vault`. Any sibling-thread",
            "claim of an explicit `has_one = vault` constraint on this account is",
            "cosmetic; the seeds derivation is the load-bearing check. This same",
            "pattern is mirrored on `revoke_agent.rs`, `pause_agent.rs`, and",
            "`unpause_agent.rs`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "agentSpendOverlay",
          "docs": [
            "Agent spend overlay — per-agent tracking slot."
          ],
          "writable": true
        },
        {
          "name": "auditLogSuccess",
          "docs": [
            "Phase 7 — success audit log; entry appended after register completes."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "slotHashesSysvar",
          "address": "SysvarS1otHashes111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "agent",
          "type": "pubkey"
        },
        {
          "name": "capability",
          "type": "u8"
        },
        {
          "name": "spendingLimitUsd",
          "type": "u64"
        }
      ]
    },
    {
      "name": "revokeAgent",
      "docs": [
        "Revoke a specific agent from the vault.",
        "Only the owner can call this. Freezes vault if last agent is removed."
      ],
      "discriminator": [
        227,
        60,
        209,
        125,
        240,
        117,
        163,
        73
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
        },
        {
          "name": "policy",
          "docs": [
            "PEN-CROSS-5 (Phase 4 absorption) — bump policy_version on agent",
            "revocation. See register_agent.rs for the OCC rationale; revoke",
            "is the more important of the four (removing an agent must",
            "invalidate concurrent validates that race the revoke)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "agentSpendOverlay",
          "docs": [
            "Agent spend overlay — release slot on revocation."
          ],
          "writable": true
        },
        {
          "name": "auditLogSuccess",
          "docs": [
            "Phase 7 — success audit log; entry appended after revoke completes."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "slotHashesSysvar",
          "address": "SysvarS1otHashes111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "agentToRemove",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setObserveOnly",
      "docs": [
        "F-12 audit fix: direct owner-only flip of `vault.observe_only`.",
        "",
        "Mirrors `freeze_vault` simplicity (no timelock). observe_only is part",
        "of the canonical policy_preview_digest encoding; the handler recomputes",
        "the stored digest + bumps `policy_version` (OCC) on every flip and",
        "emits `ObserveOnlyChanged` for off-chain monitors.",
        "",
        "F-11 consistency: cannot flip to active (false) when both protocol",
        "and destination allowlists are empty."
      ],
      "discriminator": [
        36,
        88,
        141,
        35,
        179,
        134,
        54,
        12
      ],
      "accounts": [
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          },
          "relations": [
            "policy"
          ]
        },
        {
          "name": "policy",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        }
      ],
      "args": [
        {
          "name": "newValue",
          "type": "bool"
        }
      ]
    },
    {
      "name": "unpauseAgent",
      "docs": [
        "Unpause a paused agent. Restores ability to execute actions.",
        "Only the owner can call this."
      ],
      "discriminator": [
        46,
        125,
        165,
        212,
        241,
        143,
        190,
        95
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
        },
        {
          "name": "policy",
          "docs": [
            "PEN-CROSS-5 (Phase 4 absorption) — bump policy_version on unpause.",
            "Symmetric with pause_agent; the four agent-mutation ix",
            "(register / revoke / pause / unpause) all bump version so OCC",
            "signals fire uniformly regardless of which mutation lands."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "auditLogSuccess",
          "docs": [
            "Phase 7 — success audit log; entry appended after unpause flip."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "slotHashesSysvar",
          "address": "SysvarS1otHashes111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "agentToUnpause",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "validateAndAuthorize",
      "docs": [
        "Core permission check. Called by the agent before a DeFi action.",
        "Validates against policy constraints, stablecoin-only enforcement,",
        "and protocol slippage verification.",
        "Creates a SessionAuthority PDA, delegates tokens to agent."
      ],
      "discriminator": [
        22,
        183,
        48,
        222,
        218,
        11,
        197,
        152
      ],
      "accounts": [
        {
          "name": "agent",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          },
          "relations": [
            "policy"
          ]
        },
        {
          "name": "policy",
          "docs": [
            "Boxed to keep the `ValidateAndAuthorize::try_accounts` stack frame",
            "below BPF's 4 KB ceiling. Phase 10 D-5 added 32 bytes",
            "(`cosign_session_pubkey`) to PolicyConfig, pushing the codegen",
            "frame from 4072 to 4104 bytes (8 over). `Box` moves the deserialized",
            "wrapper to the heap, restoring headroom."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "tracker",
          "docs": [
            "Zero-copy SpendTracker"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  97,
                  99,
                  107,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "agentSpendOverlay",
          "docs": [
            "Zero-copy AgentSpendOverlay — per-agent rolling spend"
          ],
          "writable": true
        },
        {
          "name": "session",
          "docs": [
            "Ephemeral session PDA — `init` ensures no double-authorization.",
            "Seeds include token_mint for per-token concurrent sessions."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  115,
                  115,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "agent"
              },
              {
                "kind": "arg",
                "path": "tokenMint"
              }
            ]
          }
        },
        {
          "name": "vaultTokenAccount",
          "docs": [
            "Vault's PDA-owned token account for the spend token"
          ],
          "writable": true
        },
        {
          "name": "tokenMintAccount",
          "docs": [
            "The token mint being spent — constrained to match token_mint arg"
          ]
        },
        {
          "name": "protocolTreasuryTokenAccount",
          "docs": [
            "Protocol treasury token account (needed when protocol_fee > 0)"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "feeDestinationTokenAccount",
          "docs": [
            "Developer fee destination token account (needed when developer_fee > 0)"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "outputStablecoinAccount",
          "docs": [
            "Vault's stablecoin ATA to snapshot (for non-stablecoin input spending).",
            "Required when input token is NOT a stablecoin (output verification in finalize)."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "outputSwapAccount",
          "docs": [
            "M1 output-ownership pin — the VAULT-OWNED token account an acquiring swap",
            "on the STABLECOIN-INPUT path must credit. Pinned + snapshotted here;",
            "finalize asserts this exact account increased, so the agent cannot",
            "redirect the swap output to its own ATA. Must pre-exist (like the F-Q8",
            "output ATA above — the forward scan permits no in-tx ATA-create). GENERIC:",
            "any vault-owned token account of a non-input mint; no protocol knowledge.",
            "Its Token-2022 extensions (if any) are vetted by the forward scan's F-Q4",
            "destination check, since the output ATA is a writable vault-owned meta of",
            "the swap ix.",
            "",
            "Boxed: an unboxed `Option<Account>` here pushed `try_accounts` 8 bytes",
            "over the 4096 BPF stack limit; boxing moves the deserialized account to",
            "the heap (handler access is unchanged via deref)."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "instructionsSysvar",
          "docs": [
            "Instructions sysvar for verifying DeFi instruction program_id",
            "and protocol slippage enforcement."
          ],
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "tokenMint",
          "type": "pubkey"
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "targetProtocol",
          "type": "pubkey"
        },
        {
          "name": "expectedPolicyVersion",
          "type": "u64"
        },
        {
          "name": "expectedNonce",
          "type": "u64"
        },
        {
          "name": "expectedIntentDigest",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "withdrawFunds",
      "docs": [
        "Withdraw tokens from the vault back to the owner."
      ],
      "discriminator": [
        241,
        36,
        29,
        111,
        208,
        31,
        104,
        217
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vault"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.vault_authority",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
        },
        {
          "name": "policy",
          "docs": [
            "Round 2 fix (audit 2026-05-19): policy is now read by",
            "`withdraw_funds` to enforce the interim cosign gate when",
            "`policy.cosign_required == true`. `withdraw_funds` is the REAL",
            "drain primitive on cosign-opted-in vaults — a phished owner can",
            "withdraw 100% custody in a single tx without the gate. PDA",
            "seeds binding mirrors the pattern at",
            "`register_agent.rs:35-40`."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "vaultTokenAccount",
          "docs": [
            "Vault's PDA-controlled token account"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "ownerTokenAccount",
          "docs": [
            "Owner's token account to receive funds"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "auditLogSuccess",
          "docs": [
            "Phase 7 — success audit log; entry appended after token transfer."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  100,
                  105,
                  116,
                  95,
                  115,
                  117,
                  99,
                  99,
                  101,
                  115,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "slotHashesSysvar",
          "address": "SysvarS1otHashes111111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "agentSpendOverlay",
      "discriminator": [
        126,
        248,
        13,
        218,
        101,
        148,
        135,
        44
      ]
    },
    {
      "name": "agentVault",
      "discriminator": [
        232,
        220,
        237,
        164,
        157,
        9,
        215,
        194
      ]
    },
    {
      "name": "auditLogRejected",
      "discriminator": [
        211,
        117,
        26,
        31,
        160,
        74,
        242,
        204
      ]
    },
    {
      "name": "auditLogSuccess",
      "discriminator": [
        225,
        112,
        129,
        30,
        0,
        111,
        84,
        75
      ]
    },
    {
      "name": "pendingAgentGrant",
      "discriminator": [
        164,
        188,
        119,
        39,
        18,
        133,
        78,
        66
      ]
    },
    {
      "name": "pendingAgentPermissionsUpdate",
      "discriminator": [
        137,
        132,
        60,
        184,
        171,
        184,
        194,
        56
      ]
    },
    {
      "name": "pendingOwnershipTransfer",
      "discriminator": [
        205,
        223,
        35,
        217,
        245,
        217,
        152,
        38
      ]
    },
    {
      "name": "pendingPolicyUpdate",
      "discriminator": [
        77,
        255,
        2,
        51,
        79,
        237,
        183,
        239
      ]
    },
    {
      "name": "policyConfig",
      "discriminator": [
        219,
        7,
        79,
        84,
        175,
        51,
        148,
        146
      ]
    },
    {
      "name": "postExecutionAssertions",
      "discriminator": [
        1,
        104,
        4,
        208,
        143,
        120,
        4,
        77
      ]
    },
    {
      "name": "sessionAuthority",
      "discriminator": [
        48,
        9,
        30,
        120,
        134,
        35,
        172,
        170
      ]
    },
    {
      "name": "spendTracker",
      "discriminator": [
        180,
        17,
        195,
        180,
        162,
        207,
        239,
        205
      ]
    }
  ],
  "events": [
    {
      "name": "actionAuthorized",
      "discriminator": [
        85,
        90,
        59,
        218,
        126,
        8,
        179,
        63
      ]
    },
    {
      "name": "agentAutoRevoked",
      "discriminator": [
        13,
        133,
        66,
        153,
        126,
        96,
        191,
        221
      ]
    },
    {
      "name": "agentGrantApplied",
      "discriminator": [
        153,
        242,
        206,
        79,
        159,
        174,
        239,
        134
      ]
    },
    {
      "name": "agentGrantCancelled",
      "discriminator": [
        139,
        15,
        84,
        63,
        70,
        46,
        233,
        130
      ]
    },
    {
      "name": "agentGrantQueued",
      "discriminator": [
        216,
        52,
        141,
        102,
        184,
        100,
        174,
        121
      ]
    },
    {
      "name": "agentPausedEvent",
      "discriminator": [
        39,
        74,
        148,
        94,
        198,
        166,
        121,
        23
      ]
    },
    {
      "name": "agentPermissionsChangeApplied",
      "discriminator": [
        233,
        247,
        103,
        30,
        130,
        173,
        196,
        183
      ]
    },
    {
      "name": "agentPermissionsChangeCancelled",
      "discriminator": [
        107,
        21,
        129,
        77,
        1,
        136,
        68,
        216
      ]
    },
    {
      "name": "agentPermissionsChangeQueued",
      "discriminator": [
        211,
        242,
        237,
        217,
        72,
        52,
        150,
        80
      ]
    },
    {
      "name": "agentRegistered",
      "discriminator": [
        191,
        78,
        217,
        54,
        232,
        100,
        189,
        85
      ]
    },
    {
      "name": "agentRevoked",
      "discriminator": [
        12,
        251,
        249,
        166,
        122,
        83,
        162,
        116
      ]
    },
    {
      "name": "agentSpendLimitChecked",
      "discriminator": [
        107,
        128,
        60,
        144,
        163,
        83,
        45,
        215
      ]
    },
    {
      "name": "agentTransferExecuted",
      "discriminator": [
        88,
        52,
        117,
        69,
        112,
        152,
        167,
        40
      ]
    },
    {
      "name": "agentUnpausedEvent",
      "discriminator": [
        218,
        187,
        253,
        124,
        79,
        192,
        42,
        181
      ]
    },
    {
      "name": "delegationRevoked",
      "discriminator": [
        59,
        158,
        142,
        49,
        164,
        116,
        220,
        8
      ]
    },
    {
      "name": "feesCollected",
      "discriminator": [
        233,
        23,
        117,
        225,
        107,
        178,
        254,
        8
      ]
    },
    {
      "name": "fundsDeposited",
      "discriminator": [
        157,
        209,
        100,
        95,
        59,
        100,
        3,
        68
      ]
    },
    {
      "name": "fundsWithdrawn",
      "discriminator": [
        56,
        130,
        230,
        154,
        35,
        92,
        11,
        118
      ]
    },
    {
      "name": "graylistEntered",
      "discriminator": [
        71,
        189,
        127,
        11,
        219,
        84,
        46,
        219
      ]
    },
    {
      "name": "graylistPromoted",
      "discriminator": [
        169,
        36,
        32,
        86,
        203,
        34,
        0,
        36
      ]
    },
    {
      "name": "observeOnlyChanged",
      "discriminator": [
        180,
        209,
        162,
        85,
        197,
        205,
        231,
        170
      ]
    },
    {
      "name": "ownershipTransferAccepted",
      "discriminator": [
        170,
        218,
        124,
        19,
        70,
        121,
        99,
        8
      ]
    },
    {
      "name": "ownershipTransferCancelled",
      "discriminator": [
        120,
        203,
        162,
        145,
        180,
        57,
        253,
        23
      ]
    },
    {
      "name": "ownershipTransferInitiated",
      "discriminator": [
        181,
        32,
        40,
        60,
        60,
        64,
        235,
        29
      ]
    },
    {
      "name": "policyChangeApplied",
      "discriminator": [
        104,
        89,
        5,
        100,
        180,
        202,
        52,
        73
      ]
    },
    {
      "name": "policyChangeCancelled",
      "discriminator": [
        200,
        158,
        226,
        255,
        25,
        211,
        30,
        151
      ]
    },
    {
      "name": "policyChangeQueued",
      "discriminator": [
        73,
        231,
        182,
        136,
        141,
        120,
        32,
        79
      ]
    },
    {
      "name": "policyCosignApproved",
      "discriminator": [
        139,
        96,
        150,
        34,
        139,
        198,
        228,
        31
      ]
    },
    {
      "name": "postAssertionChecked",
      "discriminator": [
        166,
        106,
        92,
        10,
        195,
        60,
        247,
        125
      ]
    },
    {
      "name": "postAssertionsClosed",
      "discriminator": [
        7,
        20,
        224,
        102,
        80,
        60,
        78,
        11
      ]
    },
    {
      "name": "postAssertionsCreated",
      "discriminator": [
        49,
        89,
        152,
        110,
        58,
        20,
        68,
        31
      ]
    },
    {
      "name": "sessionFinalized",
      "discriminator": [
        33,
        12,
        242,
        91,
        206,
        42,
        163,
        235
      ]
    },
    {
      "name": "vaultClosed",
      "discriminator": [
        238,
        129,
        38,
        228,
        227,
        118,
        249,
        215
      ]
    },
    {
      "name": "vaultCreated",
      "discriminator": [
        117,
        25,
        120,
        254,
        75,
        236,
        78,
        115
      ]
    },
    {
      "name": "vaultFrozen",
      "discriminator": [
        13,
        199,
        172,
        111,
        88,
        10,
        151,
        247
      ]
    },
    {
      "name": "vaultReactivated",
      "discriminator": [
        197,
        52,
        160,
        147,
        159,
        89,
        90,
        28
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "vaultNotActive",
      "msg": "Vault is not active"
    },
    {
      "code": 6001,
      "name": "unauthorizedAgent",
      "msg": "Unauthorized: signer is not the registered agent"
    },
    {
      "code": 6002,
      "name": "unauthorizedOwner",
      "msg": "Unauthorized: signer is not the vault owner"
    },
    {
      "code": 6003,
      "name": "unsupportedToken",
      "msg": "Token is not a supported stablecoin (only USDC and USDT)"
    },
    {
      "code": 6004,
      "name": "protocolNotAllowed",
      "msg": "Protocol not allowed by policy"
    },
    {
      "code": 6005,
      "name": "transactionTooLarge",
      "msg": "Transaction exceeds maximum single transaction size"
    },
    {
      "code": 6006,
      "name": "spendingCapExceeded",
      "msg": "Rolling 24h spending cap would be exceeded"
    },
    {
      "code": 6007,
      "name": "sessionNotAuthorized",
      "msg": "Session not authorized"
    },
    {
      "code": 6008,
      "name": "invalidSession",
      "msg": "Invalid session: does not belong to this vault"
    },
    {
      "code": 6009,
      "name": "tooManyAllowedProtocols",
      "msg": "Policy configuration invalid: too many allowed protocols"
    },
    {
      "code": 6010,
      "name": "agentAlreadyRegistered",
      "msg": "Agent already registered for this vault"
    },
    {
      "code": 6011,
      "name": "noAgentRegistered",
      "msg": "No agent registered for this vault"
    },
    {
      "code": 6012,
      "name": "vaultNotFrozen",
      "msg": "Vault is not frozen (expected frozen for reactivation)"
    },
    {
      "code": 6013,
      "name": "vaultAlreadyClosed",
      "msg": "Vault is already closed"
    },
    {
      "code": 6014,
      "name": "insufficientBalance",
      "msg": "Insufficient vault balance for withdrawal"
    },
    {
      "code": 6015,
      "name": "developerFeeTooHigh",
      "msg": "Developer fee rate exceeds maximum (500 / 1,000,000 = 5 BPS)"
    },
    {
      "code": 6016,
      "name": "invalidFeeDestination",
      "msg": "Fee destination account invalid"
    },
    {
      "code": 6017,
      "name": "invalidProtocolTreasury",
      "msg": "Protocol treasury account does not match expected address"
    },
    {
      "code": 6018,
      "name": "invalidAgentKey",
      "msg": "Invalid agent: cannot be the zero address"
    },
    {
      "code": 6019,
      "name": "agentIsOwner",
      "msg": "Invalid agent: agent cannot be the vault owner"
    },
    {
      "code": 6020,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6021,
      "name": "invalidTokenAccount",
      "msg": "Token account does not belong to vault or has wrong mint"
    },
    {
      "code": 6022,
      "name": "timelockNotExpired",
      "msg": "Timelock period has not expired yet"
    },
    {
      "code": 6023,
      "name": "noTimelockConfigured",
      "msg": "No timelock configured on this vault"
    },
    {
      "code": 6024,
      "name": "destinationNotAllowed",
      "msg": "Destination not in allowed list"
    },
    {
      "code": 6025,
      "name": "tooManyDestinations",
      "msg": "Too many destinations (max 10)"
    },
    {
      "code": 6026,
      "name": "invalidProtocolMode",
      "msg": "Invalid protocol mode (must be 1 = ALLOWLIST)"
    },
    {
      "code": 6027,
      "name": "cpiCallNotAllowed",
      "msg": "Instruction must be top-level (CPI calls not allowed)"
    },
    {
      "code": 6028,
      "name": "missingFinalizeInstruction",
      "msg": "Transaction must include finalize_session after validate"
    },
    {
      "code": 6029,
      "name": "nonTrackedSwapMustReturnStablecoin",
      "msg": "Non-stablecoin swap must return stablecoin (balance did not increase)"
    },
    {
      "code": 6030,
      "name": "unauthorizedTokenTransfer",
      "msg": "Top-level SPL Token transfer not allowed between validate and finalize"
    },
    {
      "code": 6031,
      "name": "slippageBpsTooHigh",
      "msg": "Slippage BPS exceeds maximum (5000 = 50%)"
    },
    {
      "code": 6032,
      "name": "protocolMismatch",
      "msg": "DeFi instruction program does not match declared target_protocol"
    },
    {
      "code": 6033,
      "name": "tooManyDeFiInstructions",
      "msg": "Spending allows at most one DeFi instruction"
    },
    {
      "code": 6034,
      "name": "maxAgentsReached",
      "msg": "Maximum agents per vault reached (limit: 10)"
    },
    {
      "code": 6035,
      "name": "insufficientPermissions",
      "msg": "Agent lacks permission for this action type"
    },
    {
      "code": 6036,
      "name": "invalidPermissions",
      "msg": "Permission bitmask contains invalid bits"
    },
    {
      "code": 6037,
      "name": "invalidConstraintConfig",
      "msg": "Invalid constraint configuration: bounds exceeded"
    },
    {
      "code": 6038,
      "name": "agentSpendLimitExceeded",
      "msg": "Agent rolling 24h spend exceeds per-agent spending limit"
    },
    {
      "code": 6039,
      "name": "overlaySlotExhausted",
      "msg": "Per-agent overlay is full; cannot register agent with spending limit"
    },
    {
      "code": 6040,
      "name": "agentSlotNotFound",
      "msg": "Agent has per-agent spending limit but no overlay tracking slot"
    },
    {
      "code": 6041,
      "name": "unauthorizedTokenApproval",
      "msg": "Unauthorized SPL Token Approve between validate and finalize"
    },
    {
      "code": 6042,
      "name": "invalidSessionExpiry",
      "msg": "Session expiry seconds out of range (5-90)"
    },
    {
      "code": 6043,
      "name": "protocolCapExceeded",
      "msg": "Per-protocol rolling 24h spending cap would be exceeded — LEGACY counter exhaustion path. New rolling-24h amount-based cap rejections use 6086 ErrDailyCapExceeded"
    },
    {
      "code": 6044,
      "name": "protocolCapsMismatch",
      "msg": "protocol_caps length must match protocols length when has_protocol_caps is true"
    },
    {
      "code": 6045,
      "name": "pendingPolicyExists",
      "msg": "Pending policy update must be applied or cancelled before closing vault"
    },
    {
      "code": 6046,
      "name": "agentPaused",
      "msg": "Agent is paused and cannot execute actions"
    },
    {
      "code": 6047,
      "name": "agentAlreadyPaused",
      "msg": "Agent is already paused"
    },
    {
      "code": 6048,
      "name": "agentNotPaused",
      "msg": "Agent is not paused"
    },
    {
      "code": 6049,
      "name": "unauthorizedPostFinalizeInstruction",
      "msg": "Instructions after finalize_session must be ComputeBudget or SystemProgram only"
    },
    {
      "code": 6050,
      "name": "unexpectedBalanceDecrease",
      "msg": "Vault balance decreased more than delegated amount — potential CPI attack"
    },
    {
      "code": 6051,
      "name": "timelockTooShort",
      "msg": "Timelock duration below minimum (1800 seconds / 30 minutes)"
    },
    {
      "code": 6052,
      "name": "policyVersionMismatch",
      "msg": "Policy version mismatch — policy changed since agent's last RPC read"
    },
    {
      "code": 6053,
      "name": "activeSessionsExist",
      "msg": "Cannot close vault with active sessions (finalize pending sessions first)"
    },
    {
      "code": 6054,
      "name": "postAssertionFailed",
      "msg": "Post-execution assertion failed: account state did not satisfy constraint"
    },
    {
      "code": 6055,
      "name": "invalidPostAssertionIndex",
      "msg": "Post-assertion constraint references invalid instruction index"
    },
    {
      "code": 6056,
      "name": "unauthorizedPreValidateInstruction",
      "msg": "Non-infrastructure instruction detected before validate_and_authorize"
    },
    {
      "code": 6057,
      "name": "snapshotNotCaptured",
      "msg": "Delta assertion snapshot was not captured in validate_and_authorize"
    },
    {
      "code": 6058,
      "name": "invalidConstraintOperator",
      "msg": "Constraint operator value is not a valid ConstraintOperator discriminant"
    },
    {
      "code": 6059,
      "name": "zeroCopyVaultMismatch",
      "msg": "Zero-copy account vault key mismatch (defense-in-depth)"
    },
    {
      "code": 6060,
      "name": "queuedUpdateExpired",
      "msg": "Queued update is too old (>MAX_APPLY_AGE_SLOTS / >MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN) — re-queue via the matching queue/initiate ix (queue_policy_update, queue_agent_permissions_update, queue_agent_grant, or initiate_ownership_transfer) to apply. Defends against durable-nonce pre-signing (CH-1 audit 2026-05-23 extended scope to timelocked-admin PDAs)."
    },
    {
      "code": 6061,
      "name": "accountWritabilityMismatch",
      "msg": "Account writability flag does not match constraint requirement"
    },
    {
      "code": 6062,
      "name": "sysvarScanBoundExceeded",
      "msg": "Sysvar instruction scan exceeded the per-tx safety bound"
    },
    {
      "code": 6063,
      "name": "asyncFulfillmentNotPermitted",
      "msg": "Async-fulfillment program is not permitted in V1 (Jupiter Perps, Drift, Drift JIT). Spending cannot be measured because keeper submits the actual transfer in a separate transaction after finalize_session returns."
    },
    {
      "code": 6064,
      "name": "confidentialTransferBlocked",
      "msg": "Token-2022 ConfidentialTransfer not permitted between validate and finalize"
    },
    {
      "code": 6065,
      "name": "permanentDelegateBlocked",
      "msg": "Token-2022 PermanentDelegate not permitted between validate and finalize"
    },
    {
      "code": 6066,
      "name": "transferHookBlocked",
      "msg": "Token-2022 TransferHook not permitted between validate and finalize"
    },
    {
      "code": 6067,
      "name": "lamportDrainBlocked",
      "msg": "Token-2022 destructive-balance ix (opcodes 38/45/46) not permitted between validate and finalize"
    },
    {
      "code": 6068,
      "name": "batchInstructionBlocked",
      "msg": "Token-2022 Batch instruction (opcode 255) is blocked outright — wraps inner instructions and bypasses byte-0 blocklist"
    },
    {
      "code": 6069,
      "name": "invalidDestinationMode",
      "msg": "Invalid destination mode (must be 0 = RESTRICTED)"
    },
    {
      "code": 6070,
      "name": "invalidCapability",
      "msg": "Invalid agent capability value (must be 0 = Disabled, 1 = Observer, or 2 = Operator)"
    },
    {
      "code": 6071,
      "name": "policyPreviewMismatch",
      "msg": "Policy preview digest mismatch — caller's signed digest differs from recomputed canonical digest"
    },
    {
      "code": 6072,
      "name": "observeOnlyModeBlocksExecute",
      "msg": "Vault is in observe_only mode — validate_and_authorize is blocked"
    },
    {
      "code": 6073,
      "name": "activeVaultRequiresAllowlist",
      "msg": "Active (non-observe_only) vault must have at least one protocol or destination on the allowlist"
    },
    {
      "code": 6074,
      "name": "errMintNotPinned",
      "msg": "Deposit mint is not a build-time-pinned stablecoin (USDC or USDT)"
    },
    {
      "code": 6075,
      "name": "errOutsideOperatingHours",
      "msg": "Current UTC hour is outside the policy's operating_hours bitmask"
    },
    {
      "code": 6076,
      "name": "errCooldownActive",
      "msg": "Agent cooldown period has not elapsed since the last action"
    },
    {
      "code": 6077,
      "name": "errGraylistFriction",
      "msg": "Destination is graylisted (24h friction window — awaiting promote_graylist_destination or unlock)"
    },
    {
      "code": 6078,
      "name": "errGraylistFull",
      "msg": "Destination graylist is full (max 10 entries) — wait for an existing entry to unlock or promote"
    },
    {
      "code": 6079,
      "name": "errToken2022ExtensionForbidden",
      "msg": "Token-2022 mint has a forbidden extension (only MemoTransfer + MetadataPointer allowed)"
    },
    {
      "code": 6080,
      "name": "errCosignRequired",
      "msg": "Elevated policy mutation requires an owner-signed cosigning session"
    },
    {
      "code": 6081,
      "name": "errAutoRevoked",
      "msg": "Agent capability auto-revoked after consecutive policy-violation failures; owner must re-enable"
    },
    {
      "code": 6082,
      "name": "errSandwichIntegrity",
      "msg": "Bundle integrity violation: multiple validate_and_authorize instructions for the same (vault, agent, mint) tuple in one transaction"
    },
    {
      "code": 6083,
      "name": "errProtectedWritable",
      "msg": "Protected Sigil PDA passed as writable to a foreign instruction between validate and finalize"
    },
    {
      "code": 6084,
      "name": "errSessionNonceMismatch",
      "msg": "Session nonce mismatch — caller's expected_nonce does not match the session's stored nonce (durable-nonce replay defense)"
    },
    {
      "code": 6085,
      "name": "errStableFloorViolation",
      "msg": "Stable balance floor violated — combined USDC+USDT balance dropped below policy.stable_balance_floor"
    },
    {
      "code": 6086,
      "name": "errDailyCapExceeded",
      "msg": "Per-protocol daily spending cap would be exceeded (rolling 24h)"
    },
    {
      "code": 6087,
      "name": "errRecipientCapExceeded",
      "msg": "Per-recipient daily cap exceeded — recipient outflow would breach policy.per_recipient_daily_cap_usd within the rolling 24h window, or per_recipient array full with no expired slot to evict"
    },
    {
      "code": 6088,
      "name": "errMintDeltaCapExceeded",
      "msg": "R-1 MintDeltaCap: vault-mint balance decreased by more than max_net_decrease"
    },
    {
      "code": 6089,
      "name": "mintDeltaCapMisconfigured",
      "msg": "R-1 MintDeltaCap misconfigured — target account missing, mint mismatch, or owner not vault"
    },
    {
      "code": 6090,
      "name": "errAtaAuthorityChanged",
      "msg": "R-2 AtaAuthorityPin: vault-owned token account authority changed or account closed/reinitialized mid-sandwich"
    },
    {
      "code": 6091,
      "name": "errOutputBelowFloor",
      "msg": "R-3 OutputBalanceFloor: post-execution balance increase fell below the configured min_increase floor"
    },
    {
      "code": 6092,
      "name": "errDeclarationInconsistent",
      "msg": "R-4 DeclarationConsistency: declared recipient/mint does not match CPI account-meta"
    },
    {
      "code": 6093,
      "name": "ixMetaCountExceeded",
      "msg": "Foreign instruction exceeded the account-meta processing budget; the bundle is rejected rather than partially inspected"
    },
    {
      "code": 6094,
      "name": "errPendingOwnershipExists",
      "msg": "An ownership transfer is already pending; cancel it first"
    },
    {
      "code": 6095,
      "name": "errPendingOwnershipNotReady",
      "msg": "Ownership transfer timelock has not elapsed"
    },
    {
      "code": 6096,
      "name": "errInvalidFreezeReason",
      "msg": "freeze_reason value out of {{0,1,2}}"
    },
    {
      "code": 6097,
      "name": "errReactivateCooldownActive",
      "msg": "Reactivate requires 5-minute observation cooldown to elapse"
    },
    {
      "code": 6098,
      "name": "errInvalidOwnershipTarget",
      "msg": "new_owner cannot be system/program/sysvar addresses (Council ISC-128)"
    },
    {
      "code": 6099,
      "name": "errTooManyRevokePairs",
      "msg": "freeze_internal MAX_REVOKE_PAIRS = 10 exceeded (Council ISC-136)"
    },
    {
      "code": 6100,
      "name": "errPostAssertionsNotClosed",
      "msg": "PostExecutionAssertions PDA still active — call close_post_assertions first"
    },
    {
      "code": 6101,
      "name": "errDestinationIsProtectedPda",
      "msg": "Destination is a Sigil-protected PDA — rejected at queue time"
    },
    {
      "code": 6102,
      "name": "errIntentDigestMismatch",
      "msg": "AL3 intent-digest mismatch — preview digest does not match executed bundle"
    },
    {
      "code": 6103,
      "name": "errPendingAgentGrantDigestMismatch",
      "msg": "PendingAgentGrant digest mismatch between queue and apply"
    },
    {
      "code": 6104,
      "name": "errReactivateCosignRequiredForFullCapability",
      "msg": "Reactivate with FULL_CAPABILITY new agent requires cosign"
    },
    {
      "code": 6105,
      "name": "destinationAccountUnresolvable",
      "msg": "Writable DeFi account could not be resolved in remaining_accounts — destination set incomplete"
    },
    {
      "code": 6106,
      "name": "errToken2022OutputMintUnresolvable",
      "msg": "Vault-owned Token-2022 output ATA's mint is absent from remaining_accounts or not Token-2022-owned — cannot vet extensions"
    },
    {
      "code": 6107,
      "name": "errOperatorGrantRequiresTimelock",
      "msg": "OPERATOR grant requires the timelock queue path on this vault — use queue_agent_grant"
    },
    {
      "code": 6108,
      "name": "errOperatorGrantDelayTooLong",
      "msg": "operator_grant_delay_seconds exceeds the maximum (48h) — would brick grant applicability"
    },
    {
      "code": 6109,
      "name": "invalidOwnerType",
      "msg": "vault.owner_type is not a recognized discriminant (expected 0=EOA or 1=multisig)"
    },
    {
      "code": 6110,
      "name": "spendAccountingUnderflow",
      "msg": "finalize spend accounting underflow: collected fees exceed realized stablecoin outflow"
    },
    {
      "code": 6111,
      "name": "errMultisigCustodyUnsupported",
      "msg": "Squads multisig ownership custody is not supported in V1 (use a standard EOA owner)"
    },
    {
      "code": 6112,
      "name": "errOutputNotVaultOwned",
      "msg": "M1: stablecoin-input swap output must land in a vault-owned account and increase (value redirection / unacquired spend rejected)"
    },
    {
      "code": 6113,
      "name": "errFinalizeMetaUnresolvable",
      "msg": "Finalize completeness: a writable DeFi account meta is absent from remaining_accounts (F-Q1b — omission would dodge per-recipient/output attribution)"
    },
    {
      "code": 6114,
      "name": "errDeFiInstructionNotAdjacentToFinalize",
      "msg": "The counted DeFi instruction must sit immediately before finalize_session (no interleaved instruction) so finalize's attribution walks bind to the correct instruction"
    },
    {
      "code": 6115,
      "name": "errUnmeasurableSpend",
      "msg": "Spending session produced no measurable in-transaction vault outcome (no stablecoin movement and no vault-owned acquisition) — async/keeper-settled or unmeasurable; recording 0 spend is rejected"
    }
  ],
  "types": [
    {
      "name": "actionAuthorized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "usdAmount",
            "type": "u64"
          },
          {
            "name": "protocol",
            "type": "pubkey"
          },
          {
            "name": "rollingSpendUsdAfter",
            "type": "u64"
          },
          {
            "name": "dailyCapUsd",
            "type": "u64"
          },
          {
            "name": "delegated",
            "type": "bool"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "agentAutoRevoked",
      "docs": [
        "TA-17 (Phase 3): an agent's capability was auto-revoked after",
        "`consecutive_failures >= policy.auto_revoke_threshold` policy-violation",
        "failures. Owner re-enables via `queue_agent_permissions_update`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "threshold",
            "type": "u8"
          },
          {
            "name": "consecutiveFailures",
            "type": "u8"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "agentContributionEntry",
      "docs": [
        "Per-agent contribution entry within an overlay.",
        "Tracks each agent's individual spend contributions using a 24-bucket",
        "hourly epoch scheme with per-entry `last_write_epoch` for correct gap-zeroing.",
        "",
        "Layout: 32 (agent) + 8 (last_write_epoch) + 8 × 24 (contributions) = 232 bytes"
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "agent",
            "docs": [
              "Agent pubkey stored as raw bytes (zero_copy requires fixed-size)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "lastWriteEpoch",
            "docs": [
              "The epoch number of the most recent write to this entry.",
              "Used to derive which buckets are stale via modular arithmetic.",
              "epoch = unix_timestamp / OVERLAY_EPOCH_DURATION (3600)"
            ],
            "type": "i64"
          },
          {
            "name": "contributions",
            "docs": [
              "Per-epoch USD contributions from this agent.",
              "Indexed by `epoch % OVERLAY_NUM_EPOCHS`."
            ],
            "type": {
              "array": [
                "u64",
                24
              ]
            }
          }
        ]
      }
    },
    {
      "name": "agentEntry",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pubkey",
            "type": "pubkey"
          },
          {
            "name": "capability",
            "docs": [
              "Agent capability: 0=Disabled, 1=Observer (non-spending), 2=Operator (full).",
              "Replaces the 21-bit ActionType permission bitmask."
            ],
            "type": "u8"
          },
          {
            "name": "spendingLimitUsd",
            "type": "u64"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "consecutiveFailures",
            "docs": [
              "TA-17 (Phase 3 pre-execution guard #7): consecutive policy-",
              "violation failures by this agent. Solana's atomic-or-none execution",
              "means a validate-time reject rolls back its own state mutation, so",
              "the counter cannot self-increment inside the failing tx. Instead,",
              "it is incremented by the owner-only `record_agent_violation` ix,",
              "called by an off-chain monitor after observing a failed seal whose",
              "reject reason is an on-chain policy code (numeric range",
              "POLICY_VIOLATION_RANGE = 6074..=6091 — see `state/mod.rs::is_policy_violation_code`).",
              "Reset to 0 inside `validate_and_authorize` on a successful seal.",
              "When `>= policy.auto_revoke_threshold`, the agent's capability is",
              "set to CAPABILITY_DISABLED and an `AgentAutoRevoked` event is",
              "emitted. Owner re-enables via `queue_agent_permissions_update`.",
              "",
              "External codes (sysvar-scan 6068 SysvarScanBoundExceeded,",
              "async-fulfillment 6069 AsyncFulfillmentNotPermitted, auth",
              "errors 6000-6082) do NOT increment — they're not the agent's",
              "fault and auto-revoking on them would let an attacker brick",
              "a working agent.",
              "",
              "Uses 1 byte from the prior `_reserved: [u8; 7]`. 6 bytes remain",
              "reserved for future fields."
            ],
            "type": "u8"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                6
              ]
            }
          }
        ]
      }
    },
    {
      "name": "agentGrantApplied",
      "docs": [
        "Phase 8 PEN-CROSS-1 — owner applied a queued OPERATOR-class agent grant",
        "past the timelock window. The agent is now in `vault.agents` and the",
        "policy_preview_digest has been re-derived to bind the new agent_set_hash.",
        "`new_policy_version` is the post-bump version; in-flight",
        "`validate_and_authorize` ix snapshotted the prior version will fail fast",
        "with PolicyVersionMismatch under the new authority surface."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "capability",
            "type": "u8"
          },
          {
            "name": "spendingLimitUsd",
            "type": "u64"
          },
          {
            "name": "queuedAt",
            "type": "i64"
          },
          {
            "name": "appliedAt",
            "type": "i64"
          },
          {
            "name": "newPolicyVersion",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "agentGrantCancelled",
      "docs": [
        "Phase 8 §RP Fix-Up B (PEN-02b CRITICAL, audit 2026-05-19) — owner",
        "cancelled a queued OPERATOR-class agent grant during the timelock window.",
        "`cancelled_agent` echoes the agent pubkey from the closed PDA so off-chain",
        "monitors can correlate the queue ↔ cancel pair without re-fetching the",
        "now-closed PDA. Off-chain monitors should ALERT on this event for any",
        "vault they protect — if the owner did not initiate the cancel, this is",
        "a phished-key attempt to abort a legitimate grant."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "cancelledAgent",
            "type": "pubkey"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "agentGrantQueued",
      "docs": [
        "Phase 8 PEN-CROSS-1 — owner queued an OPERATOR-class agent grant. The",
        "agent is NOT yet in `vault.agents`; off-chain monitors should ALERT on",
        "this event for any vault they protect. If the owner didn't initiate the",
        "queue, this is a phished-key attack signal — the owner has",
        "`min_delay_seconds` (default 1800s = 30 min) to abort before",
        "`apply_agent_grant` can land. (A `cancel_agent_grant` instruction is",
        "planned for a follow-up batch; until then, observers should freeze the",
        "vault if the queue was unauthorized.)"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "capability",
            "type": "u8"
          },
          {
            "name": "spendingLimitUsd",
            "type": "u64"
          },
          {
            "name": "queuedAt",
            "type": "i64"
          },
          {
            "name": "executesAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "agentPausedEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "agentPermissionsChangeApplied",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "appliedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "agentPermissionsChangeCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "agentPermissionsChangeQueued",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "executesAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "agentRegistered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "capability",
            "type": "u8"
          },
          {
            "name": "spendingLimitUsd",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "agentRevoked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "remainingAgents",
            "type": "u8"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "agentSpendLimitChecked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "agentRollingSpend",
            "type": "u64"
          },
          {
            "name": "spendingLimitUsd",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "agentSpendOverlay",
      "docs": [
        "Per-vault overlay PDA tracking per-agent spend contributions.",
        "",
        "Seeds: `[b\"agent_spend\", vault.key().as_ref(), &[0u8]]`",
        "",
        "Supports up to 10 agents (matches MAX_AGENTS_PER_VAULT).",
        "",
        "Size calculation (PRE-TA-06):",
        "8 (discriminator) + 32 (vault) + 232 × 10 (entries) + 1 (bump) + 7 (padding) + 80 (lifetime_spend) + 80 (lifetime_tx_count) = 2,528 bytes",
        "Size calculation (POST-TA-06): +80 cooldown_seconds + 80 last_action_unix = 2,688 bytes"
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "docs": [
              "Associated vault pubkey"
            ],
            "type": "pubkey"
          },
          {
            "name": "entries",
            "docs": [
              "Agent contribution entries (up to MAX_OVERLAY_ENTRIES agents)"
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "agentContributionEntry"
                  }
                },
                10
              ]
            }
          },
          {
            "name": "bump",
            "docs": [
              "Bump seed for PDA"
            ],
            "type": "u8"
          },
          {
            "name": "padding",
            "docs": [
              "Padding for 8-byte alignment"
            ],
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          },
          {
            "name": "lifetimeSpend",
            "docs": [
              "Per-agent cumulative spend in USD base units. Index matches entries[i].",
              "DESIGN DECISION: Tracks spend only, NOT profit/loss.",
              "Per-agent P&L requires oracles (removed by design) and protocol-specific",
              "position reading (violates protocol-agnostic principle). Realized P&L",
              "can be derived in the SDK by correlating agent spend events with vault",
              "balance changes. See agent-analytics.ts for the SDK implementation.",
              "Found by: Persona test (Treasury Manager \"David\")",
              "Appended AFTER existing layout to preserve zero-copy byte offsets."
            ],
            "type": {
              "array": [
                "u64",
                10
              ]
            }
          },
          {
            "name": "lifetimeTxCount",
            "docs": [
              "Per-agent cumulative transaction count. Index matches entries[i].",
              "Incremented in finalize_session for EVERY successful spending session.",
              "Used for: avg TX size (lifetime_spend / lifetime_tx_count), agent activity ranking."
            ],
            "type": {
              "array": [
                "u64",
                10
              ]
            }
          },
          {
            "name": "cooldownSeconds",
            "docs": [
              "TA-06 (Phase 3 pre-execution guard #3): per-agent cooldown in seconds.",
              "Index matches entries[i].",
              "",
              "Per-AGENT, not per-vault — a per-vault cooldown was rejected per F-16",
              "because one agent's traffic would DoS all other agents on the same",
              "vault. With per-agent cooldown, each agent has its own pacing limit",
              "configured by the owner.",
              "",
              "0 = no cooldown (default). Owner configures via",
              "`queue_agent_permissions_update` (P3).",
              "",
              "Appended AFTER lifetime_spend/lifetime_tx_count to preserve existing",
              "zero-copy byte offsets per the established APPEND-ONLY pattern."
            ],
            "type": {
              "array": [
                "u64",
                10
              ]
            }
          },
          {
            "name": "lastActionUnix",
            "docs": [
              "TA-06 (Phase 3): per-agent last successful validate_and_authorize",
              "Unix timestamp. Index matches entries[i]. Written at the end of",
              "validate_and_authorize on a successful authorization. The cooldown",
              "gate compares `(now - last_action_unix) >= cooldown_seconds[i]`.",
              "",
              "0 = no prior action recorded (first authorization for this agent",
              "after registration / overlay reset). The cooldown check uses",
              "`i64::checked_sub` and treats a 0 baseline as \"no previous action\"",
              "→ cooldown auto-passes.",
              "",
              "Appended AFTER cooldown_seconds to preserve zero-copy byte offsets."
            ],
            "type": {
              "array": [
                "i64",
                10
              ]
            }
          }
        ]
      }
    },
    {
      "name": "agentTransferExecuted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "mint",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "agentUnpausedEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "agentVault",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "docs": [
              "The owner who created this vault (has full authority)"
            ],
            "type": "pubkey"
          },
          {
            "name": "vaultId",
            "docs": [
              "Unique vault identifier (allows one owner to have multiple vaults)"
            ],
            "type": "u64"
          },
          {
            "name": "agents",
            "docs": [
              "Registered agents with per-agent permission bitmasks (max 10)"
            ],
            "type": {
              "vec": {
                "defined": {
                  "name": "agentEntry"
                }
              }
            }
          },
          {
            "name": "feeDestination",
            "docs": [
              "Developer fee destination — IMMUTABLE after initialization.",
              "Prevents a compromised owner from redirecting fees."
            ],
            "type": "pubkey"
          },
          {
            "name": "status",
            "docs": [
              "Vault status: Active, Frozen, or Closed"
            ],
            "type": {
              "defined": {
                "name": "vaultStatus"
              }
            }
          },
          {
            "name": "bump",
            "docs": [
              "Bump seed for PDA derivation"
            ],
            "type": "u8"
          },
          {
            "name": "createdAt",
            "docs": [
              "Unix timestamp of vault creation"
            ],
            "type": "i64"
          },
          {
            "name": "totalTransactions",
            "docs": [
              "Total number of agent transactions executed through this vault"
            ],
            "type": "u64"
          },
          {
            "name": "totalVolume",
            "docs": [
              "Total volume processed in token base units"
            ],
            "type": "u64"
          },
          {
            "name": "totalFeesCollected",
            "docs": [
              "Cumulative developer fees collected from this vault (token base units)"
            ],
            "type": "u64"
          },
          {
            "name": "totalDepositedUsd",
            "docs": [
              "Cumulative stablecoin deposits in base units (USDC/USDT, 6 decimals).",
              "Incremented in deposit_funds for stablecoin mints only.",
              "Used for P&L: current_balance - total_deposited_usd + total_withdrawn_usd.",
              "Cumulative gross — never decremented. Informational only, never authorization input."
            ],
            "type": "u64"
          },
          {
            "name": "totalWithdrawnUsd",
            "docs": [
              "Cumulative stablecoin withdrawals in base units (USDC/USDT, 6 decimals).",
              "Incremented in withdraw_funds for stablecoin mints only."
            ],
            "type": "u64"
          },
          {
            "name": "totalFailedTransactions",
            "docs": [
              "Cumulative failed + expired session count.",
              "Incremented in finalize_session when success=false OR is_expired=true.",
              "Used for success rate: total_transactions / (total_transactions + total_failed_transactions).",
              "Informational only — never used in authorization decisions."
            ],
            "type": "u64"
          },
          {
            "name": "activeSessions",
            "docs": [
              "Number of active (not yet finalized) sessions for this vault.",
              "Incremented in validate_and_authorize, decremented in finalize_session.",
              "close_vault requires this to be 0."
            ],
            "type": "u8"
          },
          {
            "name": "observeOnly",
            "docs": [
              "Phase 2 Task 8: observe_only mode flag (independent from TA-19;",
              "included in TA-19 digest encoding at position 10).",
              "",
              "When true, ALL `validate_and_authorize` calls reject with",
              "`ObserveOnlyModeBlocksExecute`. Provides a hard, low-blast-radius",
              "kill switch separate from `VaultStatus::Frozen` — owners can stand",
              "up an observe-only vault to baseline agent behaviour before opening",
              "the execute path.",
              "",
              "Set at `initialize_vault` time; flipped post-init via the dedicated",
              "`set_observe_only` instruction (F-12 audit fix, Option (a) direct",
              "owner-only flip mirroring `freeze_vault` simplicity).",
              "",
              "APPENDED at end of struct per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": "bool"
          },
          {
            "name": "frozenAtTimestamp",
            "docs": [
              "Phase 8 — unix timestamp at which `vault.status` last transitioned to",
              "Frozen. Written by every freeze code path (manual `freeze_vault`,",
              "auto-freeze inside `revoke_agent`, future `freeze_internal` helper).",
              "Read by `reactivate_vault` to enforce the 5-minute observation",
              "cooldown (Phase 8 F-RP3-1 fix — closes the phished-owner",
              "freeze→reactivate→register-attacker-agent one-tx replay).",
              "",
              "Zero on freshly-initialized vaults that have never been frozen.",
              "APPENDED per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": "i64"
          },
          {
            "name": "freezeReason",
            "docs": [
              "Phase 8 — discriminant of the `FreezeReason` enum recording WHY the",
              "vault was last frozen. Single byte on-chain; validated via",
              "`FreezeReason::from_u8` at every write site so unknown values",
              "(3..=255) hard-reject with `SigilError::ErrInvalidFreezeReason`.",
              "",
              "Zero (Manual) on freshly-initialized vaults that have never been",
              "frozen — this is harmless because `status != Frozen` means readers",
              "of this byte gate on status first. APPENDED per F-14 APPEND-ONLY",
              "rule for Borsh stability."
            ],
            "type": "u8"
          },
          {
            "name": "ownerType",
            "docs": [
              "F-Q6 (2026-06-02) — owner-account-type discriminant: 0 = single-key EOA",
              "(`OWNER_TYPE_EOA`), 1 = N-of-M multisig / Squads V4 (`OWNER_TYPE_MULTISIG`).",
              "Set ONCE per owner from an on-chain-VERIFIED fact: `initialize_vault` = 0,",
              "`accept_ownership_transfer` (EOA) = 0, `accept_ownership_transfer_multisig`",
              "= 1. NOT bound by any digest — it is program-set (not owner-supplied), and",
              "a stale/wrong value fails SAFE to the single-key delayed-grant path in",
              "`register_agent`. Validated `<= OWNER_TYPE_MULTISIG` at the read site.",
              "",
              "Placed BEFORE `vault_authority` so the LBL-01 seed-key remains the final",
              "32 bytes (the SDK resolver reads it at `SIZE - 32`). Pre-launch — no",
              "deployed vaults constrain byte placement."
            ],
            "type": "u8"
          },
          {
            "name": "vaultAuthority",
            "docs": [
              "Phase 8 LBL-01 — immutable PDA seed-key set at `initialize_vault` time;",
              "decouples vault PDA address from owner identity to enable ownership",
              "transfer without bricking the account.",
              "",
              "Before LBL-01: vault PDA derivation used `owner.key()` (or",
              "`vault.owner`). After `accept_ownership_transfer` mutated `vault.owner`,",
              "every subsequent owner-side instruction derived a DIFFERENT PDA →",
              "Anchor `ConstraintSeeds` rejection → vault permanently bricked.",
              "",
              "After LBL-01: all 40 non-init owner-side instructions derive vault",
              "PDA from `vault.vault_authority` instead. At init, the SDK still",
              "derives the PDA from `owner.key() + vault_id` (the canonical pattern),",
              "and the handler writes `vault.vault_authority = owner.key()` so the",
              "stored seed-key equals the initial owner — the on-chain PDA address",
              "is identical to the pre-LBL-01 layout. After ownership transfer the",
              "`vault.owner` byte field changes but `vault.vault_authority` does NOT,",
              "so the PDA address stays put and downstream ix continue to resolve.",
              "",
              "**Invariant:** `vault.vault_authority` is written exactly ONCE inside",
              "`initialize_vault`. No other instruction writes this field. The SDK",
              "helper `vaultPda(owner, vaultId)` continues to use `owner` as the",
              "seed-key at init time; thereafter the SDK reads `vault.vault_authority`",
              "from the resolved state to rebuild the same PDA.",
              "",
              "APPENDED per F-14 APPEND-ONLY rule for Borsh stability — +32 bytes",
              "at the tail keeps every prior byte at its original offset."
            ],
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "auditEntry",
      "docs": [
        "Single audit-log entry. Zero-copy, fixed-size 64 bytes per entry.",
        "",
        "**Layout strategy:** `#[repr(C)]` ordered so natural alignment never",
        "introduces implicit padding (Pod derive forbids implicit padding).",
        "All fields with alignment > 1 are placed at offsets that are multiples",
        "of their alignment.",
        "",
        "Byte offsets (verified at compile time):",
        "0..32   subject          [u8;32]  align 1",
        "32..40  balance_delta_in i64      align 8 (32 % 8 = 0 ✓)",
        "40..48  balance_delta_out i64     align 8 (40 % 8 = 0 ✓)",
        "48..56  timestamp        i64      align 8 (48 % 8 = 0 ✓)",
        "56..60  slot_hash        [u8;4]   align 1",
        "60..63  blockhash        [u8;3]   align 1",
        "63..64  discriminator    u8       align 1",
        "──── total: 64 bytes, struct alignment = 8 ────",
        "",
        "**discriminator placement note:** semantically the discriminator is",
        "\"type of entry,\" but for Pod-compatible packing we place it at the",
        "trailing byte. SDK decoders read it by offset 63, not by struct field",
        "order.",
        "",
        "Audit #1 AUD3-F5: uses `slot_hashes_sysvar`, NOT deprecated",
        "`recent_blockhashes_sysvar` (deprecated in Solana 1.18+)."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "subject",
            "docs": [
              "32-byte pubkey of the entry's subject. Stored as raw bytes because",
              "`zero_copy` cannot hold `Pubkey` directly without `Pod` impl on",
              "Pubkey itself.",
              "",
              "Per-discriminator semantic (§RP-1 HIGH-2 disambiguation, 2026-05-19):",
              "disc=2  (finalize_success) → protocol pubkey (session.authorized_protocol)",
              "disc=16 (finalize_reject)  → protocol pubkey (session.authorized_protocol)",
              "disc=3  (deposit)          → SPL Token mint pubkey",
              "disc=4  (withdraw)         → SPL Token mint pubkey",
              "disc=5  (freeze)           → vault pubkey",
              "disc=6  (reactivate)       → vault pubkey",
              "disc=10 (pause_agent)      → agent pubkey",
              "disc=11 (unpause_agent)    → agent pubkey",
              "disc=12 (revoke_agent)     → agent pubkey",
              "disc=13 (register_agent)   → agent pubkey",
              "disc=14 (policy_apply)     → vault pubkey",
              "disc=15 (constraints_apply)→ vault pubkey",
              "disc=7..=9 (ownership_*)   → ownership initiate/accept/cancel",
              "disc=17 (agent_grant_queue)→ agent pubkey (Phase 8 PEN-CROSS-1 Batch 6)",
              "disc=18 (agent_grant_apply)→ agent pubkey (Phase 8 PEN-CROSS-1 Batch 6)",
              "disc=19 (agent_grant_cancel)→ agent pubkey (Phase 8 §RP Fix-Up B / PEN-02b)",
              "disc=20 (agent_perms_apply)→ agent pubkey (M-6 close, audit 2026-05-21)",
              "disc=21 (constraints_close_apply)→ vault pubkey (M-7 close, audit 2026-05-21)",
              "disc=22 (agent_auto_revoked) → agent pubkey (M-8 close, audit 2026-05-21)",
              "disc=23 (agent_transfer)   → recipient wallet (destination ATA owner) (L11-1, audit 2026-06-15)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "balanceDeltaIn",
            "docs": [
              "Stablecoin delta IN (e.g. swap output, deposit). 0 when not applicable."
            ],
            "type": "i64"
          },
          {
            "name": "balanceDeltaOut",
            "docs": [
              "Stablecoin delta OUT (e.g. swap input, withdraw, transfer). 0 when N/A."
            ],
            "type": "i64"
          },
          {
            "name": "timestamp",
            "docs": [
              "Wall-clock unix timestamp (Clock::unix_timestamp)."
            ],
            "type": "i64"
          },
          {
            "name": "slotHash",
            "docs": [
              "First 4 bytes of slot_hashes_sysvar[0].slot in LE byte order."
            ],
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "blockhash",
            "docs": [
              "First 3 bytes of slot_hashes_sysvar[0].hash."
            ],
            "type": {
              "array": [
                "u8",
                3
              ]
            }
          },
          {
            "name": "discriminator",
            "docs": [
              "See discriminator constants above (AUDIT_DISC_*). At byte offset 63."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "auditLogRejected",
      "docs": [
        "On-chain circular log of REJECTED finalize attempts for a vault.",
        "",
        "Phase 7 writes only the `finalize_session` REJECT path (expired-finalize",
        "permissionless cranks) into this buffer. Other instructions that error",
        "out roll back atomically and produce no audit entry by design.",
        "",
        "Audit #2 F-19 (audit log spam): kept separate from `AuditLogSuccess`",
        "so the rejected stream cannot displace the success history. The two",
        "buffers share the same `AuditEntry` shape so SDK decoders can be",
        "shared.",
        "",
        "Seeds: `[b\"audit_rejected\", vault.key().as_ref()]`",
        "",
        "**Layout (within 8-byte Anchor discriminator):**",
        "0..32      vault       Pubkey",
        "32..4128   entries     [AuditEntry; 64]   (64 * 64 = 4,096)",
        "4128..4129 head        u8",
        "4129..4130 count       u8",
        "4130..4143 _padding    [u8;13]",
        "4143..4144 bump        u8",
        "──── total data: 4,144 bytes ────",
        "",
        "Including 8-byte Anchor discriminator: **4,152 bytes total.**",
        "",
        "**DEVIATION FROM SPEC:** The Phase 7 spec called for `_padding: [u8;6]`",
        "with claimed SIZE = 4,145. Same Pod-alignment issue as `AuditLogSuccess`",
        "— `[AuditEntry; 64]` is 8-byte aligned, so the struct must be a multiple",
        "of 8. We widen padding from 6 → 13 to reach 4,144 data bytes; SIZE",
        "becomes 4,152."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "docs": [
              "Associated vault pubkey. Verified by PDA seeds + has_one constraints",
              "at the instruction layer."
            ],
            "type": "pubkey"
          },
          {
            "name": "entries",
            "docs": [
              "Circular-buffer entries. Same shape as success buffer."
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "auditEntry"
                  }
                },
                64
              ]
            }
          },
          {
            "name": "head",
            "docs": [
              "Next write position (0..=CAPACITY-1). Wraps modulo CAPACITY."
            ],
            "type": "u8"
          },
          {
            "name": "count",
            "docs": [
              "Total entries written, saturated at CAPACITY."
            ],
            "type": "u8"
          },
          {
            "name": "padding",
            "docs": [
              "13-byte explicit padding (Pod no-implicit-padding rule + future",
              "forward-compat appends)."
            ],
            "type": {
              "array": [
                "u8",
                13
              ]
            }
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "auditLogSuccess",
      "docs": [
        "On-chain circular log of SUCCESSFUL mutating instructions for a vault.",
        "",
        "Audit #2 F-19 (audit log spam): kept separate from `AuditLogRejected`",
        "so a permissionless-crank attacker who triggers expired-finalize",
        "rejects cannot displace legitimate success entries.",
        "",
        "Seeds: `[b\"audit_success\", vault.key().as_ref()]`",
        "",
        "**Layout (within 8-byte Anchor discriminator):**",
        "0..32      vault       Pubkey",
        "32..8224   entries     [AuditEntry; 128]   (128 * 64 = 8,192)",
        "8224..8225 head        u8",
        "8225..8226 count       u8",
        "8226..8239 _padding    [u8;13]             (alignment to make struct multiple of 8)",
        "8239..8240 bump        u8",
        "──── total data: 8,240 bytes ────",
        "",
        "Including 8-byte Anchor discriminator at front: **8,248 bytes total.**",
        "",
        "**DEVIATION FROM SPEC:** The Phase 7 spec called for `_padding: [u8;6]`",
        "with claimed SIZE = 8,241. That arithmetic is incompatible with the Pod",
        "derive (which `#[zero_copy]` applies): `[AuditEntry; 128]` has 8-byte",
        "alignment (from inner `i64` fields), so the containing struct also has",
        "8-byte alignment and `size_of::<AuditLogSuccess>()` MUST be a multiple",
        "of 8. 8,233 is not — the compiler would either insert 7 bytes of",
        "implicit trailing padding (which Pod forbids) or fail.",
        "",
        "We resolve this by widening `_padding` from 6 → 13 bytes so the data",
        "portion totals exactly 8,240 (multiple of 8), and SIZE becomes 8,248.",
        "Net cost: 7 additional bytes of rent per vault (≈ 50,000 lamports at",
        "current rent rates — negligible)."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "docs": [
              "Associated vault pubkey. Verified by PDA seeds + has_one constraints",
              "at the instruction layer."
            ],
            "type": "pubkey"
          },
          {
            "name": "entries",
            "docs": [
              "Circular-buffer entries. Indexed by `(head - 1) mod CAPACITY` for the",
              "most recent entry; oldest is at `head` when `count == CAPACITY`."
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "auditEntry"
                  }
                },
                128
              ]
            }
          },
          {
            "name": "head",
            "docs": [
              "Next write position (0..=CAPACITY-1). Wraps modulo CAPACITY."
            ],
            "type": "u8"
          },
          {
            "name": "count",
            "docs": [
              "Total entries written, saturated at CAPACITY. Used by readers to",
              "distinguish a half-filled buffer from a wrapped one."
            ],
            "type": "u8"
          },
          {
            "name": "padding",
            "docs": [
              "13-byte explicit padding to satisfy Pod's no-implicit-padding rule.",
              "Forward-compat slot for future field appends (see Phase 9+)."
            ],
            "type": {
              "array": [
                "u8",
                13
              ]
            }
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "delegationRevoked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "tokenAccount",
            "type": "pubkey"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "destinationGraylistEntry",
      "docs": [
        "TA-07 (Phase 3): one entry in `PolicyConfig.destination_graylist`.",
        "",
        "`destination` is the wallet/PDA pubkey whose ATAs are being graylisted",
        "(matches the entry in `allowed_destinations`). `unlock_unix` is the",
        "Unix timestamp at which the destination becomes spendable without",
        "the owner having to promote it.",
        "",
        "Layout: 32 + 8 = 40 bytes per entry. Bounded ≤MAX_ALLOWED_DESTINATIONS",
        "(10) so the worst-case Vec contribution to PolicyConfig SIZE is",
        "`4 + 40*10 = 404` bytes."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "unlockUnix",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "epochBucket",
      "docs": [
        "A single epoch bucket tracking aggregate USD spend.",
        "16 bytes per bucket. USD-only — rate limiting stays client-side."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "epochId",
            "docs": [
              "Epoch identifier: unix_timestamp / EPOCH_DURATION"
            ],
            "type": "i64"
          },
          {
            "name": "usdAmount",
            "docs": [
              "Aggregate USD spent in this epoch (6 decimals)"
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "feesCollected",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "protocolFeeAmount",
            "type": "u64"
          },
          {
            "name": "developerFeeAmount",
            "type": "u64"
          },
          {
            "name": "protocolFeeRate",
            "type": "u16"
          },
          {
            "name": "developerFeeRate",
            "type": "u16"
          },
          {
            "name": "transactionAmount",
            "type": "u64"
          },
          {
            "name": "protocolTreasury",
            "type": "pubkey"
          },
          {
            "name": "developerFeeDestination",
            "type": "pubkey"
          },
          {
            "name": "cumulativeDeveloperFees",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "fundsDeposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "fundsWithdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "graylistEntered",
      "docs": [
        "TA-07 (Phase 3): a destination entered the graylist with a 24h unlock",
        "(or `unlock_unix == now` if `auto_promote_grays` was true). Emitted",
        "from `apply_pending_policy` when allowed_destinations gains a new entry."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "unlockUnix",
            "type": "i64"
          },
          {
            "name": "autoPromoted",
            "type": "bool"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "graylistPromoted",
      "docs": [
        "TA-07 (Phase 3): owner promoted a destination out of the graylist via",
        "`promote_graylist_destination`. `promoted = false` when the destination",
        "was already past unlock (no-op promotion — still emitted for audit)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "promoted",
            "type": "bool"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "observeOnlyChanged",
      "docs": [
        "Emitted when `set_observe_only` flips `vault.observe_only`. Off-chain",
        "monitors use `new_policy_preview_digest` + `new_policy_version` for OCC",
        "reconciliation against their cached policy view."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "oldValue",
            "type": "bool"
          },
          {
            "name": "newValue",
            "type": "bool"
          },
          {
            "name": "newPolicyVersion",
            "type": "u64"
          },
          {
            "name": "newPolicyPreviewDigest",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "ownershipTransferAccepted",
      "docs": [
        "Phase 8 C26 — `new_owner` (or the multisig PDA, Batch 4) accepted a queued",
        "transfer past timelock. `previous_owner` is the pubkey that signed the",
        "initiate (and matches `pending.current_owner`). `via_multisig` flags the",
        "Batch 4 path so off-chain monitors can distinguish EOA vs Squads accepts."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "previousOwner",
            "type": "pubkey"
          },
          {
            "name": "newOwner",
            "type": "pubkey"
          },
          {
            "name": "viaMultisig",
            "type": "bool"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "ownershipTransferCancelled",
      "docs": [
        "Phase 8 C26 — `current_owner` cancelled a queued transfer. `cancelled_new_owner`",
        "echoes the target pubkey from the cancelled PDA so off-chain monitors",
        "can correlate cancel ↔ initiate without re-fetching the (now-closed) PDA."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "currentOwner",
            "type": "pubkey"
          },
          {
            "name": "cancelledNewOwner",
            "type": "pubkey"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "ownershipTransferInitiated",
      "docs": [
        "Phase 8 C26 — owner queued a `PendingOwnershipTransfer`. Off-chain",
        "monitors should ALERT on this event for any vault they protect — if the",
        "owner did not initiate the queue, this is a phished-key attack signal",
        "and the owner has `min_delay_seconds` (default 48h) to",
        "`cancel_ownership_transfer` before the timelock elapses."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "currentOwner",
            "type": "pubkey"
          },
          {
            "name": "newOwner",
            "type": "pubkey"
          },
          {
            "name": "queuedAt",
            "type": "i64"
          },
          {
            "name": "isMultisigTarget",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "pendingAgentGrant",
      "docs": [
        "Phase 8 PEN-CROSS-1 (Council ISC-58..65) — queued OPERATOR-class agent grant.",
        "",
        "`register_agent` (Batch 6) now hard-rejects `capability == CAPABILITY_OPERATOR`",
        "(closes the phished-owner instant-operator-grant vector). To grant an",
        "OPERATOR-class agent the owner now MUST route through the two-step queue",
        "+ apply timelock-gated path:",
        "",
        "1. `queue_agent_grant(agent, capability=OPERATOR, spending_limit_usd)` →",
        "writes this PDA, captures `queued_at`, requires cosign when",
        "`policy.cosign_required == true`.",
        "2. `apply_agent_grant()` after `now - queued_at >= min_delay_seconds` →",
        "pushes the agent into `vault.agents`, re-derives the policy preview",
        "digest with the new `agent_set_hash`, bumps `policy.policy_version`,",
        "and closes the pending PDA.",
        "",
        "PDA seeds: `[b\"pending_agent_grant\", vault.key().as_ref()]`. There is at",
        "most ONE pending OPERATOR grant per vault — `init` against a duplicate",
        "pubkey rejects via the standard Anchor \"account already in use\" path,",
        "mirroring `PendingOwnershipTransfer` and `PendingPolicyUpdate`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "docs": [
              "PDA-bound vault. Defense-in-depth duplicate of the seeds vault prefix."
            ],
            "type": "pubkey"
          },
          {
            "name": "agent",
            "docs": [
              "Agent pubkey being granted. Validated against the existing",
              "`vault.is_agent` set at apply time (the Anchor `init` of the PDA",
              "itself prevents double-queue per agent because the seed includes the",
              "vault only — apply also re-checks for double-registration)."
            ],
            "type": "pubkey"
          },
          {
            "name": "capability",
            "docs": [
              "Target capability. Hard-rejected at queue time unless `>= CAPABILITY_OPERATOR`",
              "— this is the WHOLE POINT of the queued path. Stored as u8 for wire",
              "compatibility with `vault.agents[i].capability`."
            ],
            "type": "u8"
          },
          {
            "name": "spendingLimitUsd",
            "docs": [
              "Per-agent rolling-24h spend limit (USDC face value, 6 decimals).",
              "Mirrors `register_agent`'s arg."
            ],
            "type": "u64"
          },
          {
            "name": "queuedAt",
            "docs": [
              "`Clock::unix_timestamp` at queue time. Timelock enforced as",
              "`clock.unix_timestamp - queued_at >= min_delay_seconds`."
            ],
            "type": "i64"
          },
          {
            "name": "minDelaySeconds",
            "docs": [
              "Owner-configurable timelock window (seconds). Defaults to",
              "`Self::DEFAULT_MIN_DELAY = 172_800s = 48h` — matches the",
              "`PendingOwnershipTransfer` 48h window so an OPERATOR-class grant",
              "(which is at least as elevated as ownership transfer in capability",
              "terms) gets the full observation window for the owner to detect a",
              "phished-key queue and cancel via `cancel_agent_grant`.",
              "",
              "Phase 8 §RP Fix-Up B (PEN-02a CRITICAL, audit 2026-05-19): raised",
              "from 30min → 48h. The previous default gave a phished owner only",
              "30 minutes to react. 48h matches the ownership-transfer floor; a",
              "future SDK call may permit owner-configurable shortening if",
              "`policy.timelock_duration` permits, but the V1 default is the",
              "48h floor for safety."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump."
            ],
            "type": "u8"
          },
          {
            "name": "padding",
            "docs": [
              "6-byte alignment cushion + additive headroom for future v1.1",
              "extensions (e.g. cooldown_seconds binding). Zero-init on `init`."
            ],
            "type": {
              "array": [
                "u8",
                6
              ]
            }
          },
          {
            "name": "pendingContentDigest",
            "docs": [
              "M-5 close (Bucket 2, Phase 10 PEN-CROSS-3): SHA-256 over the",
              "canonical byte encoding of the pending content (vault + agent +",
              "capability + spending_limit_usd + queued_at + min_delay_seconds +",
              "queued_at_slot — CH-1 close Bucket-3 audit 2026-05-23 folded",
              "queued_at_slot into the canonical encoder at position 7).",
              "Written once at `queue_agent_grant` and re-asserted at",
              "`apply_agent_grant` before any mutation of `vault.agents`.",
              "",
              "Defense-in-depth against discriminator-collision overwrite of",
              "this pending PDA's body between queue and apply: even if a future",
              "bug allowed a same-seed CPI to rewrite the grant fields, the",
              "digest recorded at queue time pins the owner-attested content,",
              "and the apply-time recompute would diverge and reject with",
              "`ErrPendingAgentGrantDigestMismatch`.",
              "",
              "Alignment: Anchor's `#[account]` uses Borsh on-the-wire layout, so",
              "the byte arithmetic is purely additive: 104 + 32 + 8 = 144 bytes",
              "total (CH-1 Bucket-3 added 8 bytes for queued_at_slot).",
              "`[u8; 32]` has alignment 1, so no padding is required regardless of",
              "the preceding `u8` + `[u8; 6]` shape."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "queuedAtSlot",
            "docs": [
              "CH-1 close (Bucket-3 audit 2026-05-23): slot at queue time for",
              "F-10 freshness check. Paired with `MAX_APPLY_AGE_SLOTS_TIMELOCKED_ADMIN`",
              "to defend against the Drift-April-2026 durable-nonce pre-signing",
              "attack class: a compromised owner key can pre-sign queue+apply ix",
              "in the same slot, queue NOW, then replay the pre-signed apply",
              "weeks later. Slot-based F-10 catches the \"weeks later\" case.",
              "",
              "Note: `queued_at: i64` above is the existing unix-timestamp used",
              "by the 48h timelock countdown — that semantic is unchanged. This",
              "slot field is additive and load-bearing only for the F-10 fresh-",
              "ness check."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "pendingAgentPermissionsUpdate",
      "docs": [
        "Queued agent permissions update. Timelock-gated.",
        "PDA seeds: [b\"pending_agent_perms\", vault.key().as_ref(), agent.as_ref()]",
        "Per-agent PDA — allows concurrent pending updates for different agents."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "newCapability",
            "type": "u8"
          },
          {
            "name": "reservedCap",
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          },
          {
            "name": "spendingLimitUsd",
            "type": "u64"
          },
          {
            "name": "queuedAt",
            "type": "i64"
          },
          {
            "name": "executesAt",
            "type": "i64"
          },
          {
            "name": "queuedAtSlot",
            "docs": [
              "Slot number when this update was queued. Paired with `MAX_APPLY_AGE_SLOTS`",
              "to enforce a freshness ceiling — defends against durable-nonce pre-signing",
              "attacks (F-10 audit fix, Drift Protocol April 2026 $285M analog)."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "cooldownSeconds",
            "docs": [
              "TA-06 (Phase 3): per-agent cooldown in seconds. 0 disables. Bound",
              "at apply time onto `AgentSpendOverlay.cooldown_seconds[slot]`.",
              "APPENDED at end per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": "u64"
          },
          {
            "name": "cosignDigest",
            "docs": [
              "Round 2 F-RP3-2 fix (audit 2026-05-19): cosign-binding digest for",
              "elevated mutations. When `queue_agent_permissions_update` detects",
              "that the request RAISES an agent's capability, RAISES the spending",
              "limit, or SHORTENS the cooldown — AND `policy.cosign_required ==",
              "true` — the owner MUST supply a co-signing session in the accounts.",
              "The queue handler computes a sha256 over the canonical pending args",
              "and stores it here; `apply_agent_permissions_update` re-asserts the",
              "digest equality.",
              "",
              "`[0u8; 32]` = no cosign required (non-elevated mutation OR cosign",
              "not opted in on this vault). Any non-zero digest indicates this",
              "pending was bound to a specific cosign and the apply handler MUST",
              "re-compute and equal-check.",
              "",
              "APPENDED at end per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "cosignSession",
            "docs": [
              "Round 2 F-RP3-2 fix (audit 2026-05-19): pubkey of the session that",
              "co-signed this queue. Recorded for audit. `Pubkey::default()` =",
              "no cosign (non-elevated OR not opted in).",
              "",
              "APPENDED at end per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "pendingOwnershipTransfer",
      "docs": [
        "Phase 8 — C26 ownership transfer pending state.",
        "",
        "Two-step ownership migration with mandatory timelock. The OWNER initiates",
        "a transfer to a `new_owner` pubkey (any address — EOA or Squads V4 PDA),",
        "the timelock elapses (default 172,800s = 48h), then either:",
        "- `new_owner` (standard) calls `accept_ownership_transfer`, OR",
        "- the multisig PDA itself (via Squads) calls",
        "`accept_ownership_transfer_multisig` (Batch 4 — `is_multisig_target == true`).",
        "",
        "The PDA closes on accept (rent → `new_owner`) or cancel (rent → `current_owner`).",
        "`freeze_vault` will be wired to cancel any in-flight transfer atomically in",
        "a subsequent batch (today's batch only ships the three owner-side",
        "instructions plus the PDA).",
        "",
        "Layout matches `Self::SIZE` exactly — the 6-byte tail padding keeps the",
        "account's total bytes 8-aligned for downstream zero-copy compat and gives",
        "us a safe additive cushion (any new field ≤ 6 bytes can land without",
        "growing the PDA)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "docs": [
              "PDA-bound vault. Defense-in-depth duplicate of the [b\"pending_owner\",",
              "vault.key()] seed — also lets handlers reject stale accounts that were",
              "re-created against a different vault during a close-then-reuse race."
            ],
            "type": "pubkey"
          },
          {
            "name": "currentOwner",
            "docs": [
              "Owner pubkey at queue time. `cancel_ownership_transfer` requires the",
              "signer match this field exactly (in addition to `has_one = owner` on",
              "the vault), and the PDA's rent reverts here on cancel."
            ],
            "type": "pubkey"
          },
          {
            "name": "newOwner",
            "docs": [
              "Target owner. `accept_ownership_transfer` requires the signer match",
              "this field exactly (standard EOA path). Multisig variant in Batch 4",
              "will also bind here when `is_multisig_target == true`."
            ],
            "type": "pubkey"
          },
          {
            "name": "queuedAt",
            "docs": [
              "`Clock::unix_timestamp` at queue time. Timelock is enforced as",
              "`clock.unix_timestamp - queued_at >= min_delay_seconds`."
            ],
            "type": "i64"
          },
          {
            "name": "minDelaySeconds",
            "docs": [
              "Owner-configurable timelock (seconds). Defaults to",
              "`Self::DEFAULT_MIN_DELAY` (172,800 / 48h). Owner can shorten in a",
              "future SDK call if `policy.timelock_duration` permits, but Batch 3",
              "pins the default — extension hook lives in Batch 4+."
            ],
            "type": "u64"
          },
          {
            "name": "isMultisigTarget",
            "docs": [
              "`true` means the accept path will be `accept_ownership_transfer_multisig`",
              "(Batch 4 — Squads V4 vault-PDA-signs flow). `false` means the standard",
              "EOA accept path. Today's `accept_ownership_transfer` HARD-REJECTS when",
              "this is `true` so the multisig flow cannot be silently taken by the",
              "regular handler before Batch 4 ships."
            ],
            "type": "bool"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump."
            ],
            "type": "u8"
          },
          {
            "name": "padding",
            "docs": [
              "8-byte alignment cushion + additive headroom for Batch 4+ extensions",
              "(e.g. cooldown packing, multisig-attestation digest). Zero-init on",
              "`init` and unread today."
            ],
            "type": {
              "array": [
                "u8",
                6
              ]
            }
          },
          {
            "name": "queuedAtSlot",
            "docs": [
              "CH-1 close (Bucket-3 audit 2026-05-23): slot at queue time for",
              "F-10 freshness. See pending_agent_grant.rs for the threat model."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "pendingPolicyUpdate",
      "docs": [
        "Queued policy update that becomes executable after a timelock period.",
        "Created by `queue_policy_update`, applied by `apply_pending_policy`,",
        "or cancelled by `cancel_pending_policy`.",
        "",
        "PDA seeds: `[b\"pending_policy\", vault.key().as_ref()]`"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "docs": [
              "Associated vault pubkey"
            ],
            "type": "pubkey"
          },
          {
            "name": "queuedAt",
            "docs": [
              "Unix timestamp when this update was queued"
            ],
            "type": "i64"
          },
          {
            "name": "executesAt",
            "docs": [
              "Unix timestamp when this update becomes executable"
            ],
            "type": "i64"
          },
          {
            "name": "queuedAtSlot",
            "docs": [
              "Slot number when this update was queued. Paired with `MAX_APPLY_AGE_SLOTS`",
              "to enforce a freshness ceiling — defends against durable-nonce pre-signing",
              "attacks (F-10 audit fix, Drift Protocol April 2026 $285M analog)."
            ],
            "type": "u64"
          },
          {
            "name": "dailySpendingCapUsd",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "maxTransactionAmountUsd",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "protocolMode",
            "type": {
              "option": "u8"
            }
          },
          {
            "name": "protocols",
            "type": {
              "option": {
                "vec": "pubkey"
              }
            }
          },
          {
            "name": "developerFeeRate",
            "type": {
              "option": "u16"
            }
          },
          {
            "name": "maxSlippageBps",
            "type": {
              "option": "u16"
            }
          },
          {
            "name": "timelockDuration",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "allowedDestinations",
            "type": {
              "option": {
                "vec": "pubkey"
              }
            }
          },
          {
            "name": "sessionExpirySeconds",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "hasProtocolCaps",
            "type": {
              "option": "bool"
            }
          },
          {
            "name": "protocolCaps",
            "type": {
              "option": {
                "vec": "u64"
              }
            }
          },
          {
            "name": "destinationMode",
            "docs": [
              "Destination access control mode update.",
              "Phase 2 Option A: only Some(0) (RESTRICTED) is accepted. Some(1) was deleted."
            ],
            "type": {
              "option": "u8"
            }
          },
          {
            "name": "bump",
            "docs": [
              "Bump seed for PDA"
            ],
            "type": "u8"
          },
          {
            "name": "operatingHours",
            "docs": [
              "TA-05 (Phase 3): optional update to `PolicyConfig.operating_hours`.",
              "24-bit UTC bitmask; upper 8 bits MUST be zero. Bound by TA-19 at",
              "canonical position 15.",
              "APPENDED at end per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": {
              "option": "u32"
            }
          },
          {
            "name": "cosignDigest",
            "docs": [
              "TA-09 (Phase 3 pre-execution guard #6): cosign requirement marker.",
              "When `queue_policy_update` detects an elevated mutation (raising",
              "daily cap, raising max-tx, expanding destinations/protocols, etc),",
              "the owner MUST supply a co-signing session in the accounts. The",
              "queue handler computes a sha256 over the canonical pending args",
              "and stores it here; `apply_pending_policy` re-asserts the digest.",
              "",
              "`[0u8; 32]` = no cosign required (non-elevated mutation). Any",
              "non-zero digest indicates this pending was bound to a specific",
              "cosign. At apply, the handler MUST re-compute and equal-check.",
              "",
              "APPENDED at end per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "cosignSession",
            "docs": [
              "TA-09 (Phase 3): pubkey of the session that co-signed this queue.",
              "Recorded for audit. `Pubkey::default()` = no cosign (non-elevated)."
            ],
            "type": "pubkey"
          },
          {
            "name": "newPolicyPreviewDigest",
            "docs": [
              "TA-19 (Phase 2): SHA-256 digest of the canonical Borsh encoding of the",
              "policy fields THAT WOULD RESULT FROM APPLYING this pending update over",
              "the live policy. Owner computes off-chain over the merged result and",
              "includes the digest in `queue_policy_update`; `apply_pending_policy`",
              "re-asserts the digest against a re-computed merged digest before any",
              "field is copied to the live policy. Defends against pending-PDA",
              "tampering between queue and apply (e.g., partial overwrite via a",
              "rogue program with the same account discriminator).",
              "",
              "Encoding identical to `PolicyConfig.policy_preview_digest` — see that",
              "field's doc-comment for the canonical encoding ordering.",
              "",
              "APPENDED at end of struct per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "stableBalanceFloor",
            "docs": [
              "TA-12 (Phase 5): optional update to `PolicyConfig.stable_balance_floor`.",
              "None = preserve live value; Some(n) = set to n. Bound by TA-19 at",
              "canonical digest position 18.",
              "",
              "APPENDED at end of struct per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "perRecipientDailyCapUsd",
            "docs": [
              "TA-14 (Phase 5): optional update to",
              "`PolicyConfig.per_recipient_daily_cap_usd`. None = preserve live value;",
              "Some(n) = set to n. Bound by TA-19 at canonical digest position 19.",
              "",
              "APPENDED at end of struct per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "cosignRequired",
            "docs": [
              "G6 (audit 2026-05-18 cosign opt-in): optional update to",
              "`PolicyConfig.cosign_required`. None = preserve live value;",
              "Some(true) = enable cosign on elevated mutations (safety",
              "improvement — NOT elevated); Some(false) when live is true",
              "IS elevated (one-way ratchet — disabling cosign requires cosign).",
              "Bound by TA-19 at canonical digest position 20.",
              "",
              "APPENDED at end of struct per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": {
              "option": "bool"
            }
          },
          {
            "name": "cosignSessionPubkey",
            "docs": [
              "D-5 close (audit 2026-05-19, F-RP3-1): optional update to",
              "`PolicyConfig.cosign_session_pubkey`. None = preserve live value;",
              "Some(pubkey) = set the reactivate-cosign pubkey for elevated",
              "capability grants. `Pubkey::default()` is permitted as a value",
              "(disables the gate); any other pubkey enables it.",
              "",
              "Setting this field is NOT classified as elevated by the existing",
              "7-trigger gate in `queue_policy_update` — owners opt INTO friction",
              "(the gate fires LATER on `reactivate_vault`). Disabling it",
              "(`Some(Pubkey::default())`) on a live policy where the field is",
              "currently non-default IS, however, a one-way-ratchet violation if",
              "the vault is otherwise cosign-opted-in; deferred to Phase 9",
              "alongside the broader ratchet polish — the present batch closes",
              "only the reactivate-time gate.",
              "",
              "Bound by TA-19 at canonical digest position 22.",
              "",
              "APPENDED at end of struct per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "operatorGrantDelaySeconds",
            "docs": [
              "F-Q6 (2026-06-02): optional update to",
              "`PolicyConfig.operator_grant_delay_seconds`. None = preserve live value;",
              "Some(n) = update. Bound by TA-19 at canonical digest position 22.",
              "APPENDED per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "cosignApproved",
            "docs": [
              "Async cosign approval (2026-06-17): set `true` by `approve_pending_policy`",
              "when the bound cosigner K approves an elevated queued update.",
              "`apply_pending_policy` requires this for elevated mutations — REPLACES the",
              "synchronous apply-time cosigner re-assert. Non-elevated pendings leave it",
              "`false` (unused). APPENDED per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": "bool"
          },
          {
            "name": "approvedAtSlot",
            "docs": [
              "Slot at which the cosigner approved (set by `approve_pending_policy`).",
              "`apply_pending_policy` re-anchors the F-10 freshness ceiling to THIS slot",
              "(apply within `MAX_APPLY_AGE_SLOTS` of approval, not of queue), so the",
              "cosigner has unbounded time to approve while a held apply stays bounded",
              "post-approval. `0` until approved.",
              "APPENDED per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": "u64"
          },
          {
            "name": "queuedPolicyVersion",
            "docs": [
              "`PolicyConfig.policy_version` snapshot at queue time. `approve_pending_policy`",
              "and `apply_pending_policy` require the live `policy_version` still equals this",
              "(strict staleness gate — Squads `stale_transaction_index` analog). Any policy",
              "change (incl. cosigner rotation, which bumps `policy_version`) invalidates",
              "this pending's pending approval.",
              "APPENDED per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "perRecipientCounter",
      "docs": [
        "TA-14 (Phase 5 post-exec): per-recipient rolling 24h outflow counter.",
        "48 bytes per entry (32 + 8 + 8).",
        "",
        "`recipient` is resolved from the SPL TokenAccount.owner field — NOT",
        "the ATA pubkey. The §RP brief explicitly flags ATA-vs-owner confusion",
        "as the attack class to defend against.",
        "",
        "`window_start` is the Unix timestamp at which the current 24h window",
        "began. When `now - window_start >= 86400` the slot is eligible for",
        "age-based eviction.",
        "",
        "`window_spend_usd` is the accumulated 6-decimal USDC face value spent",
        "to this recipient in the active window."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "recipient",
            "docs": [
              "Recipient wallet pubkey (NOT the ATA pubkey — Pod-compatible",
              "`[u8; 32]` since zero-copy accounts can't hold Pubkey directly)."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "windowStart",
            "docs": [
              "Unix timestamp at which the active rolling 24h window started.",
              "Zero indicates an empty slot."
            ],
            "type": "i64"
          },
          {
            "name": "windowSpendUsd",
            "docs": [
              "Accumulated 6-decimal USDC face value spent to `recipient` in",
              "the active 24h window."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "policyChangeApplied",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "appliedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "policyChangeCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "policyChangeQueued",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "executesAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "policyConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "docs": [
              "Associated vault pubkey"
            ],
            "type": "pubkey"
          },
          {
            "name": "dailySpendingCapUsd",
            "docs": [
              "Maximum aggregate spend per rolling 24h period in USD (6 decimals).",
              "$500 = 500_000_000. This is the primary spending cap."
            ],
            "type": "u64"
          },
          {
            "name": "maxTransactionSizeUsd",
            "docs": [
              "Maximum single transaction size in USD (6 decimals)."
            ],
            "type": "u64"
          },
          {
            "name": "protocolMode",
            "docs": [
              "Protocol allowlist mode. Phase 2 Option A: ONLY value 1 (ALLOWLIST)",
              "permitted. Modes 0 (ALL) and 2 (DENYLIST) deleted under L-1. Handler",
              "rejects any other value with `ErrInvalidProtocolMode`."
            ],
            "type": "u8"
          },
          {
            "name": "protocols",
            "docs": [
              "Protocol pubkeys for allowlist/denylist.",
              "Bounded to MAX_ALLOWED_PROTOCOLS entries."
            ],
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "developerFeeRate",
            "docs": [
              "Developer fee rate (rate / 1,000,000). Applied to every finalized",
              "transaction. Max MAX_DEVELOPER_FEE_RATE (500 = 5 BPS)."
            ],
            "type": "u16"
          },
          {
            "name": "maxSlippageBps",
            "docs": [
              "Maximum slippage tolerance (basis points) — generic config primitive",
              "preserved per D-5 across Phase 1 Option A demolition. Per L-1 there is",
              "no on-chain Jupiter slippage verifier in V1; this field is consumed by",
              "off-chain SDK simulators and (Phase 6) generic post-execution assertions",
              "(R-1 mint-delta cap). Validated at config time via",
              "`max_slippage_bps <= MAX_SLIPPAGE_BPS` (= 5000 BPS = 50% ceiling).",
              "0 = no slippage protection configured."
            ],
            "type": "u16"
          },
          {
            "name": "timelockDuration",
            "docs": [
              "Timelock duration in seconds for policy changes. 0 = no timelock."
            ],
            "type": "u64"
          },
          {
            "name": "allowedDestinations",
            "docs": [
              "Allowed destination addresses for agent transfers.",
              "Empty = any destination allowed. Bounded to MAX_ALLOWED_DESTINATIONS."
            ],
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "hasPendingPolicy",
            "docs": [
              "Whether a pending policy update PDA exists for this vault.",
              "Set true by queue_policy_update, false by apply/cancel_pending_policy."
            ],
            "type": "bool"
          },
          {
            "name": "hasProtocolCaps",
            "docs": [
              "Whether per-protocol spend caps are configured.",
              "Requires protocol_mode == ALLOWLIST and protocol_caps.len() == protocols.len()."
            ],
            "type": "bool"
          },
          {
            "name": "protocolCaps",
            "docs": [
              "Per-protocol daily spending caps in USD (6 decimals).",
              "Index-aligned with `protocols`. Only enforced when `has_protocol_caps = true`.",
              "A value of 0 means no per-protocol limit (global cap still applies)."
            ],
            "type": {
              "vec": "u64"
            }
          },
          {
            "name": "sessionExpirySeconds",
            "docs": [
              "Configurable session duration in seconds. 0 = use default",
              "(`SESSION_DURATION_SECONDS` = 30s). Valid range when non-zero:",
              "`MIN_SESSION_DURATION_SECONDS..=MAX_OWNER_SESSION_DURATION_SECONDS`",
              "(currently 5..=90s). Wall-clock based — see audit F5-H1."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "docs": [
              "Bump seed for PDA"
            ],
            "type": "u8"
          },
          {
            "name": "policyVersion",
            "docs": [
              "Policy version counter for OCC (optimistic concurrency control).",
              "Incremented on every apply_pending_policy and apply_constraints_update.",
              "Agents include expected_policy_version in validate_and_authorize;",
              "program rejects if version changed since the agent's RPC read."
            ],
            "type": "u64"
          },
          {
            "name": "hasPostAssertions",
            "docs": [
              "Whether native PostExecutionAssertions are configured for this vault.",
              "When true, finalize_session requires the assertions PDA in remaining_accounts.",
              "0 = no assertions, non-zero = assertions required."
            ],
            "type": "u8"
          },
          {
            "name": "destinationMode",
            "docs": [
              "Destination access control mode for `agent_transfer` and spending paths.",
              "",
              "Phase 2 Option A: only value 0 (RESTRICTED) is accepted. Permissive",
              "OPEN_WITH_CAP (1) was deleted. Closes F-4 (third-pass audit) and the",
              "subsequent owner-opt-in window definitively."
            ],
            "type": "u8"
          },
          {
            "name": "policyPreviewDigest",
            "docs": [
              "TA-19 (Phase 2): SHA-256 digest of the canonical Borsh encoding of the",
              "policy fields the owner approved at queue/init time. Bound at the same",
              "instruction where the owner signs the change, re-asserted at apply, so",
              "a compromised owner-signer or pending-PDA tampering cannot mutate the",
              "applied policy without producing a digest mismatch.",
              "",
              "CANONICAL ENCODING (FIXED — DO NOT REORDER):",
              "1. `daily_spending_cap_usd: u64`",
              "2. `max_transaction_size_usd: u64`",
              "3. `max_slippage_bps: u16`",
              "4. `developer_fee_rate: u16` — PEN-CROSS-6 (Phase 2 close-up)",
              "5. `protocol_mode: u8`",
              "6. `protocols: Vec<Pubkey>`",
              "7. `destination_mode: u8`",
              "8. `allowed_destinations: Vec<Pubkey>`",
              "9. `timelock_duration: u64`",
              "10. `session_expiry_seconds: u64`",
              "11. `observe_only: bool`",
              "12. `has_constraints: bool`",
              "13. `has_post_assertions: u8`",
              "14. `created_at_slot: u64` — PEN-CROSS-2 (Phase 2 close-up)",
              "",
              "All fields encoded as Borsh: u8/u16/u64 little-endian, `bool` as `[u8; 1]`",
              "(0 or 1), `Vec<Pubkey>` as `u32_le_len ++ pubkey_bytes_concatenated`.",
              "The SDK helper `computePolicyPreviewDigest` mirrors this encoding exactly.",
              "",
              "APPENDED at end of struct per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "createdAtSlot",
            "docs": [
              "PEN-CROSS-2 (Phase 2 close-up): the slot at which `initialize_vault`",
              "minted this PolicyConfig. Bound by TA-19 at position 14 of the",
              "canonical digest encoding.",
              "",
              "Closes the close+reinit replay window: an owner who closes a vault",
              "(via `close_vault`) and later re-inits a fresh PDA at the same",
              "(owner, vault_id) gets a new `created_at_slot`. The signed",
              "`initialize_vault` ix from the old vault encodes the OLD slot in its",
              "preview digest, so replaying that signed tx against the fresh PDA",
              "produces a digest mismatch and `PolicyPreviewMismatch` rejects it.",
              "",
              "APPENDED at end of struct per F-14 APPEND-ONLY rule."
            ],
            "type": "u64"
          },
          {
            "name": "operatingHours",
            "docs": [
              "TA-05 (Phase 3 pre-execution guard #2): 24-bit UTC operating-hours",
              "bitmask. Bit `n` (0 ≤ n ≤ 23) set → spending allowed when",
              "`clock.unix_timestamp / 3600 % 24 == n`. Upper 8 bits (24..=31)",
              "MUST be zero; rejected at write-time.",
              "",
              "Default for owners who don't narrow: 0xFFFFFF (all 24 hours enabled",
              "— equivalent to \"no operating-hours constraint\"). New vaults set",
              "this explicitly via the digest the owner signs; back-compat",
              "consideration removed per L-3 (Phase 2 TA-19 bound the field anyway).",
              "",
              "Bound by TA-19 at position 15 of the canonical digest encoding.",
              "APPENDED at end of struct per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": "u32"
          },
          {
            "name": "destinationGraylist",
            "docs": [
              "TA-07 (Phase 3 pre-execution guard #4): first-time-destination",
              "24-hour graylist friction. When a NEW destination is added to",
              "`allowed_destinations` (via queue_policy_update), it enters this",
              "graylist with `unlock_unix = now + 86400` (24h). Until either",
              "(a) the unlock time elapses OR (b) the owner calls",
              "`promote_graylist_destination` to fast-track, spending paths",
              "reject any tx routing value to that destination with",
              "`ErrGraylistFriction` (6077).",
              "",
              "Tuple is `(destination_pubkey, unlock_unix)`. Bounded ≤10 entries",
              "(max_destinations). When full, additional allowlist adds reject",
              "with `ErrGraylistFull` (6087) until an existing entry unlocks or",
              "is promoted.",
              "",
              "DESIGN: graylist entries are derived/ephemeral state — the owner's",
              "signed digest already binds the allowlist (canonical position 8),",
              "and graylist friction only delays an already-authorised destination.",
              "Therefore the graylist itself is NOT in the canonical digest",
              "encoding. Promoting accelerates the unlock but cannot widen the",
              "allowlist beyond what the owner signed.",
              "",
              "APPENDED at end of struct per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": {
              "vec": {
                "defined": {
                  "name": "destinationGraylistEntry"
                }
              }
            }
          },
          {
            "name": "autoPromoteGrays",
            "docs": [
              "TA-07 (Phase 3): if true, new destinations added to the allowlist",
              "skip the 24h graylist entirely (audit trail still recorded via",
              "emitted events). Bound by TA-19 at canonical digest position 16",
              "so the owner's choice to bypass friction is part of the signed",
              "configuration — not silently flipped.",
              "",
              "Default false. APPENDED at end per F-14 APPEND-ONLY rule."
            ],
            "type": "bool"
          },
          {
            "name": "autoRevokeThreshold",
            "docs": [
              "TA-17 (Phase 3 pre-execution guard #7): consecutive-failure",
              "threshold after which an agent's capability is auto-revoked.",
              "Owner-configurable in range 3..=20; out-of-range values rejected",
              "at policy-write time with `InvalidPermissions`. Default 5.",
              "",
              "Only on-chain policy-violation codes (6074-6091) count — see",
              "`POLICY_VIOLATION_RANGE` in finalize_session. External codes",
              "(CU exhaustion, nonce desync, auth) do NOT increment.",
              "",
              "Bound by TA-19 at canonical digest position 17. APPENDED per",
              "F-14 APPEND-ONLY rule."
            ],
            "type": "u8"
          },
          {
            "name": "stableBalanceFloor",
            "docs": [
              "TA-12 (Phase 5 post-execution invariant #1): hard floor on the",
              "combined USDC + USDT balance held by the vault. After every",
              "`finalize_session` spending path completes (CPI balance audit +",
              "rolling-cap + per-agent + per-protocol bookkeeping), the handler",
              "re-reads the vault's USDC + USDT token-account balances and",
              "asserts their sum is ≥ this value. If not, it rejects with",
              "`ErrStableFloorViolation` (6085).",
              "",
              "This is the LAST defensive line — no combination of attacks (CPI",
              "drain, per-protocol cap bypass via async fulfillment, fee",
              "inflation, slippage manipulation) may drain the vault below this",
              "line. Default 0 (no reserve — preserves all existing vault",
              "behavior). Owner-configurable via `initialize_vault` and",
              "`queue_policy_update`.",
              "",
              "Bound by TA-19 at canonical digest position 18. APPENDED per",
              "F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": "u64"
          },
          {
            "name": "perRecipientDailyCapUsd",
            "docs": [
              "TA-14 (Phase 5 post-execution invariant #2): rolling 24h",
              "per-recipient outflow cap, in 6-decimal USDC face value. When",
              "non-zero, every `finalize_session` spending path validates that",
              "the recipient's rolling 24h spend (tracked on",
              "`SpendTracker.per_recipient`) PLUS this transaction's outflow",
              "to that recipient stays ≤ this value. Otherwise rejects with",
              "`ErrRecipientCapExceeded` (6096).",
              "",
              "Default 0 (no per-recipient cap) preserves existing vault",
              "behavior. Owner-configurable via `initialize_vault` and",
              "`queue_policy_update`.",
              "",
              "Bound by TA-19 at canonical digest position 19. APPENDED per",
              "F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": "u64"
          },
          {
            "name": "cosignRequired",
            "docs": [
              "G6 (audit 2026-05-18): owner-controlled opt-in flag for TA-09",
              "cosign enforcement on elevated policy mutations.",
              "",
              "When `false` (default): elevated mutations (raising caps,",
              "expanding allowlists, weakening floors / per-recipient caps /",
              "protocol caps) require only the owner's signature — no cosign",
              "session is required. Low-friction default, suitable for solo",
              "founders, AI-agent automation, dev/test vaults, and any vault",
              "whose owner is a Squads V4 multisig PDA (multisig at the Solana",
              "layer already enforces multi-signer authorization).",
              "",
              "When `true`: TA-09 elevation checks fire. The seven elevation",
              "triggers in `queue_policy_update` (raises_daily_cap,",
              "raises_max_tx, expands_destinations, expands_protocols,",
              "lowers_floor, weakens_per_recipient_cap, weakens_protocol_caps)",
              "require a non-default `cosign_session` pubkey + a corresponding",
              "signer in `remaining_accounts` with `is_signer == true`.",
              "",
              "Toggle semantics:",
              "- **Enabling (false → true)** is NON-ELEVATED. It is a safety",
              "improvement — owner is voluntarily tightening the policy.",
              "Cosign is not required to enable cosign.",
              "- **Disabling (true → false)** IS ELEVATED. One-way-ratchet",
              "semantics: if cosign is currently ON, the owner cannot turn",
              "it OFF without producing a valid cosign signature — exactly",
              "the protection cosign was meant to provide. A phishing-",
              "compromised owner key cannot silently disable cosign and",
              "then drain via subsequent non-elevated mutations.",
              "",
              "Bound by TA-19 at canonical digest position 20. APPENDED at end",
              "of struct per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": "bool"
          },
          {
            "name": "cosignSessionPubkey",
            "docs": [
              "D-5 close (audit 2026-05-19, F-RP3-1): the cosign-session pubkey",
              "gating elevated capability grants on the `reactivate_vault` path.",
              "",
              "THREAT: a phished/leaked owner key can chain",
              "`freeze_vault → reactivate_vault(new_agent=ATTACKER, FULL_CAPABILITY)`",
              "in a single transaction. The vault's `cosign_required` flag gates",
              "elevated MUTATIONS via `queue_policy_update`, but the reactivate",
              "path grafts a new agent at FULL_CAPABILITY directly — no timelock,",
              "no cosign — yielding an instant operator-class grant.",
              "",
              "DEFENSE: when `cosign_session_pubkey != Pubkey::default()` AND the",
              "reactivate ix passes `capability == FULL_CAPABILITY` for the new",
              "agent, the handler REQUIRES a matching signer in",
              "`ctx.remaining_accounts` whose key equals this pubkey AND",
              "`is_signer == true`. Otherwise rejects with",
              "`ErrReactivateCosignRequiredForFullCapability` (6114).",
              "",
              "Default `Pubkey::default()` at `initialize_vault` time means",
              "existing vaults retain today's behavior (no cosign gate on",
              "reactivate). Owners opt in by setting a non-default value via",
              "`queue_policy_update`. Setting a non-default value here is",
              "orthogonal to `cosign_required` — the two gate different ix paths",
              "(queue/apply vs reactivate) and use different pubkey sources",
              "(`pending.cosign_session` vs this field).",
              "",
              "Bound by TA-19 at canonical digest position 22. APPENDED at end",
              "of struct per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": "pubkey"
          },
          {
            "name": "operatorGrantDelaySeconds",
            "docs": [
              "F-Q6 (2026-06-02): owner-configured delay (in seconds) before an",
              "OPERATOR capability grant takes effect. Default 0. An owner-set",
              "security control gating OPERATOR seating — bound by TA-19 at canonical",
              "digest position 22 so a tampered SDK or pending-PDA mutation cannot",
              "silently lower it between owner approval and on-chain landing.",
              "Changeable only via the timelocked `queue_policy_update` path (so",
              "lowering it is itself delayed). The single-key forced floor",
              "(`max(field, 600)`) and per-tier grant logic live in `register_agent`",
              "/ `queue_agent_grant`.",
              "",
              "APPENDED at end of struct per F-14 APPEND-ONLY rule for Borsh stability."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "policyCosignApproved",
      "docs": [
        "Async cosign approval (2026-06-17): the bound cosigner K approved an elevated",
        "queued policy update via `approve_pending_policy`. `apply_pending_policy` then",
        "requires `cosign_approved == true`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "cosigner",
            "type": "pubkey"
          },
          {
            "name": "approvedAtSlot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "postAssertionChecked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "entryIndex",
            "type": "u8"
          },
          {
            "name": "passed",
            "type": "bool"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "postAssertionEntry",
      "docs": [
        "Borsh-serializable assertion entry (instruction parameter form).",
        "",
        "Phase B3 fields (cross_field_offset_b, cross_field_multiplier_bps,",
        "cross_field_flags) DELETED in Phase 1 Option A demolition.",
        "",
        "Phase 6 appended `aux_value: [u8; 8]` + `aux_byte: u8` for the four new",
        "variants (R-1/R-2/R-3/R-4). Modes 0..3 must set both to zero; the",
        "validator enforces it."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "targetAccount",
            "type": "pubkey"
          },
          {
            "name": "offset",
            "type": "u16"
          },
          {
            "name": "valueLen",
            "type": "u8"
          },
          {
            "name": "operator",
            "type": "u8"
          },
          {
            "name": "expectedValue",
            "type": "bytes"
          },
          {
            "name": "assertionMode",
            "type": "u8"
          },
          {
            "name": "auxValue",
            "docs": [
              "Phase 6: u64 LE auxiliary value. Per-mode meaning — see ZC struct."
            ],
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "auxByte",
            "docs": [
              "Phase 6: u8 auxiliary byte. Per-mode meaning — see ZC struct."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "postAssertionEntryZc",
      "docs": [
        "Post-execution assertion: checks account data bytes AFTER the DeFi",
        "instruction executes, within the same atomic transaction.",
        "",
        "Same bytes-at-offset pattern as DataConstraintZC, but applied to",
        "account data instead of instruction data. Protocol-agnostic — the",
        "vault owner configures byte offsets from protocol documentation.",
        "",
        "Phase B1: absolute value assertions (check field ≤ max, field ≥ min).",
        "Phase B2: delta-mode assertions (MaxDecrease, MaxIncrease, NoChange).",
        "",
        "Phase B3 CrossFieldLte fields (cross_field_offset_b, cross_field_multiplier_bps,",
        "cross_field_flags) DELETED in Phase 1 Option A demolition (L-1). The two-field",
        "ratio check (field_A × 10000 ≤ multiplier_bps × field_B) was Jupiter-Perps-flavored",
        "leverage-cap logic that doesn't generalize to a per-vault generic primitive."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "targetAccount",
            "docs": [
              "The account to read after execution (passed via remaining_accounts).",
              "",
              "Per-mode interpretation:",
              "- modes 0..3 (Absolute / MaxDecrease / MaxIncrease / NoChange):",
              "protocol state account (Position PDA, User account, etc).",
              "- mode 4 MintDeltaCap with `aux_byte=1` (scope=1): the single token",
              "account whose balance we measure. With `aux_byte=0` (scope=0):",
              "UNUSED — ATAs are derived on-chain from `(vault, expected_value)`."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "offset",
            "docs": [
              "Byte offset in the target account's data to read (modes 0..3).",
              "Phase 6 modes (4) ignore this field — balances are read at the",
              "canonical SPL/Token-2022 layout offset (64..72)."
            ],
            "type": "u16"
          },
          {
            "name": "valueLen",
            "docs": [
              "Length of the value to compare (1-32 bytes) for modes 0..3.",
              "Phase 6 mode 4 ignores this field."
            ],
            "type": "u8"
          },
          {
            "name": "operator",
            "docs": [
              "Comparison operator (reuses ConstraintOperator: Eq, Ne, Gte, Lte, etc.)",
              "Modes 1..4 ignore this field."
            ],
            "type": "u8"
          },
          {
            "name": "expectedValue",
            "docs": [
              "Per-mode payload:",
              "- modes 0..3: expected value for comparison (same max as DataConstraint).",
              "- mode 4 MintDeltaCap: bytes 0..32 = mint pubkey identifying the",
              "target token. Remaining bytes are unused."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "assertionMode",
            "docs": [
              "Assertion mode:",
              "0 = Absolute: check current value against expected_value",
              "1 = MaxDecrease: check (snapshot - current) ≤ expected_value (Phase B2)",
              "NOTE: If value increases (current > snapshot), check ALWAYS PASSES (saturating sub = 0).",
              "For bidirectional protection, pair with MaxIncrease or use NoChange.",
              "2 = MaxIncrease: check (current - snapshot) ≤ expected_value (Phase B2)",
              "NOTE: If value decreases, check ALWAYS PASSES.",
              "3 = NoChange: check current == snapshot — byte-for-byte equality (Phase B2)",
              "4 = MintDeltaCap (Phase 6 R-1): vault-wide or per-account drain ceiling"
            ],
            "type": "u8"
          },
          {
            "name": "auxValue",
            "docs": [
              "Phase 6 generic auxiliary value — per-mode interpretation:",
              "- mode 4 MintDeltaCap: u64 LE = max_net_decrease (units of the mint's",
              "smallest denomination).",
              "- modes 0..3: UNUSED, must be zero (validate_entries enforces).",
              "Stored as raw bytes to keep the struct alignment at 2 (avoids a u64",
              "alignment bump that would force the entry to a multiple of 8 and",
              "regress capacity math)."
            ],
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "auxByte",
            "docs": [
              "Phase 6 generic auxiliary byte — per-mode interpretation:",
              "- mode 4 MintDeltaCap: scope (0 = vault-wide ATA enumeration,",
              "1 = single account in `target_account`).",
              "- modes 0..3: UNUSED, must be zero (validate_entries enforces).",
              "",
              "The trailing `aux_byte` brings the entry to an even size (78) which",
              "satisfies the struct's u16 alignment without a separate `_padding`",
              "field — the previous `_padding: u8` from Phase 1 demolition was",
              "absorbed here. Off-chain decoders that previously read `_padding`",
              "now read `aux_byte`; the byte position is the same so wire",
              "compatibility holds with the previous version's zero value."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "postAssertionsClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "postAssertionsCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "entryCount",
            "type": "u8"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "postExecutionAssertions",
      "docs": [
        "On-chain account storing post-execution assertions for a vault.",
        "Seeds: [b\"post_assertions\", vault.key()]",
        "",
        "Phase 6 grow: entries 4 → 8, per-entry size 70 → 78 bytes. New SIZE 672."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "docs": [
              "The vault this assertion set belongs to."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "entries",
            "docs": [
              "Assertion entries (fixed-size array, up to MAX_POST_ASSERTION_ENTRIES)."
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "postAssertionEntryZc"
                  }
                },
                8
              ]
            }
          },
          {
            "name": "entryCount",
            "docs": [
              "Number of active entries (0..=MAX_POST_ASSERTION_ENTRIES)."
            ],
            "type": "u8"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump seed."
            ],
            "type": "u8"
          },
          {
            "name": "padding",
            "docs": [
              "Reserved for future use."
            ],
            "type": {
              "array": [
                "u8",
                6
              ]
            }
          }
        ]
      }
    },
    {
      "name": "protocolSpendCounter",
      "docs": [
        "Per-protocol spend counter using simple 24h window.",
        "When current_epoch - window_start >= 144, the window is expired and resets to 0.",
        "48 bytes per entry (32 + 8 + 8)."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "protocol",
            "docs": [
              "Protocol program ID"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "windowStart",
            "docs": [
              "Window start timestamp (for future rolling window)"
            ],
            "type": "i64"
          },
          {
            "name": "windowSpend",
            "docs": [
              "Accumulated spend in window (for future cap enforcement)"
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "sessionAuthority",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "docs": [
              "Associated vault"
            ],
            "type": "pubkey"
          },
          {
            "name": "agent",
            "docs": [
              "The agent who initiated this session"
            ],
            "type": "pubkey"
          },
          {
            "name": "authorized",
            "docs": [
              "Whether this session has been authorized by the permission check"
            ],
            "type": "bool"
          },
          {
            "name": "authorizedAmount",
            "docs": [
              "Authorized action details (for verification in finalize)"
            ],
            "type": "u64"
          },
          {
            "name": "authorizedToken",
            "type": "pubkey"
          },
          {
            "name": "authorizedProtocol",
            "type": "pubkey"
          },
          {
            "name": "expiresAtTimestamp",
            "docs": [
              "Wall-clock expiry: session is valid until this `Clock::unix_timestamp`.",
              "",
              "**Why timestamp, not slot:** Solana slot times vary 400ms-1.5s under",
              "congestion. Slot-based expiry produced a 3.75x variance window between",
              "the documented and worst-case session lifetime — see audit F5-H1.",
              "Wall-clock enforcement is congestion-immune."
            ],
            "type": "i64"
          },
          {
            "name": "delegated",
            "docs": [
              "Whether token delegation was set up (approve CPI)"
            ],
            "type": "bool"
          },
          {
            "name": "delegationTokenAccount",
            "docs": [
              "The vault's token account that was delegated to the agent",
              "(only meaningful when delegated == true)"
            ],
            "type": "pubkey"
          },
          {
            "name": "protocolFee",
            "docs": [
              "Protocol fee collected during validate (for event logging in finalize)"
            ],
            "type": "u64"
          },
          {
            "name": "developerFee",
            "docs": [
              "Developer fee collected during validate (for event logging in finalize)"
            ],
            "type": "u64"
          },
          {
            "name": "outputMint",
            "docs": [
              "Stablecoin mint for outcome-based spending detection.",
              "For stablecoin input: set to authorized_token (the stablecoin being spent).",
              "For non-stablecoin input: set to the expected stablecoin output mint.",
              "Pubkey::default() for non-spending actions (no outcome check needed)."
            ],
            "type": "pubkey"
          },
          {
            "name": "stablecoinBalanceBefore",
            "docs": [
              "Snapshot of the relevant stablecoin account balance before the swap.",
              "For stablecoin input: vault_token_account.amount (taken before fee collection).",
              "For non-stablecoin input: output_stablecoin_account.amount.",
              "0 for non-spending actions."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "docs": [
              "Bump seed for PDA"
            ],
            "type": "u8"
          },
          {
            "name": "assertionSnapshots",
            "docs": [
              "Phase B2: Snapshots of target account bytes captured in validate_and_authorize",
              "before DeFi instruction executes. Index i corresponds to PostAssertionEntry i.",
              "Used by delta assertion modes (1=MaxDecrease, 2=MaxIncrease, 3=NoChange).",
              "",
              "Phase 6 grow: array length 4 → 8 to match MAX_POST_ASSERTION_ENTRIES.",
              "Adds 128 bytes (4 × 32) to SessionAuthority.",
              "",
              "**Phase 6 R-1 MintDeltaCap reuse:** for mode-4 entries, the snapshot",
              "stores `pre_sum: u64 LE` in bytes [0..8] of the 32-byte slot. Remaining",
              "24 bytes are zero-padded. `snapshot_lens[i]` is set to 8 (the u64",
              "width) so finalize can distinguish a captured R-1 snapshot from an",
              "uncaptured slot."
            ],
            "type": {
              "array": [
                {
                  "array": [
                    "u8",
                    32
                  ]
                },
                8
              ]
            }
          },
          {
            "name": "snapshotLens",
            "docs": [
              "Phase B2: Actual value_len captured for each snapshot.",
              "0 = no snapshot captured (mode 0 entries). Non-zero = snapshot was captured.",
              "finalize_session cross-checks snapshot_lens[i] == entry.value_len for",
              "modes 1..3. For mode 4 (R-1 MintDeltaCap) the field is set to 8 and",
              "finalize asserts snapshot_lens[i] == 8 before re-summing.",
              "",
              "Phase 6 grow: array length 4 → 8. Adds 4 bytes."
            ],
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "nonce",
            "docs": [
              "AC-10 (Phase 4) — monotonic session nonce closing durable-nonce replay",
              "(per Audit #1 C-1).",
              "",
              "**Semantics**",
              "- New session: `init` zero-initializes the account, so the field starts",
              "at 0. `validate_and_authorize` accepts `expected_nonce` and requires",
              "it to equal `self.nonce` at entry — a fresh session therefore demands",
              "`expected_nonce = 0` from the caller.",
              "- `finalize_session` increments `self.nonce` by 1 on every successful",
              "finalize (including the expired-cleanup path — see finalize_session.rs",
              "for the atomicity argument). The increment is atomic with the",
              "account-close: if finalize errors, the close is rolled back by the",
              "runtime and the persisted nonce stays at the pre-increment value, so",
              "a partial-fail does NOT permanent-increment the nonce.",
              "- Because `validate_and_authorize` uses `init` (not `init_if_needed`),",
              "the (vault, agent, mint) session PDA is closed at finalize and the",
              "next validate creates a fresh account starting at nonce=0. The nonce",
              "field therefore functions as an in-session counter and is checked",
              "against `expected_nonce` ONLY when the SessionAuthority account is",
              "not closed between validates — currently a no-op in the steady-state",
              "flow, present so Phase 8 ownership-transfer replay protection (M-5)",
              "can extend the same field without a state-shape migration.",
              "",
              "**Phase 8 extension contract:** the ownership-transfer flow (M-5) will",
              "reuse this field as a per-vault monotonic counter scoped to the",
              "session PDA, preserving the existing finalize-time increment semantics.",
              "Adding seeds / scope is additive; the on-chain field stays a `u64`.",
              "",
              "**Why NOT in TA-19 canonical digest:** SessionAuthority is per-session",
              "ephemeral state, not policy-owned. Including the nonce in the policy",
              "digest would require digest recomputation on every successful seal,",
              "which collapses the queue/apply timelock semantics. The nonce is",
              "orthogonal to the policy_preview_digest binding.",
              "",
              "**APPEND-ONLY**: new field at the END of SessionAuthority. SIZE grows",
              "by 8 bytes (375 → 383). Pre-existing accounts at the prior layout are",
              "not migrated (the program close+init cycle naturally retires them at",
              "the next finalize), so this is safe under a V2 program ID redeploy."
            ],
            "type": "u64"
          },
          {
            "name": "outputStablecoinAccount",
            "docs": [
              "F-Q8 — the vault stablecoin ATA pinned at validate for the",
              "non-stablecoin-input outcome check. finalize_session asserts the",
              "account it measures has THIS exact pubkey, so a compromised agent",
              "cannot substitute a different vault-owned stablecoin ATA (whose",
              "owner+mint also pass) to spoof the `current > before` return check.",
              "Set to output_stablecoin_account.key() on the non-stablecoin-input",
              "spending path; Pubkey::default() otherwise (stablecoin-input uses",
              "vault_token_account, already pinned via delegation_token_account).",
              "",
              "**APPEND-ONLY**: new field at the END of SessionAuthority. SIZE grows",
              "by 32 bytes (515 → 547). Sessions are init/close per cycle, so no",
              "migration is required."
            ],
            "type": "pubkey"
          },
          {
            "name": "outputSwapAccount",
            "docs": [
              "M1 output-ownership closure (2026-06-17) — the vault-owned token account",
              "that an acquiring spend on the **stablecoin-input** path MUST credit,",
              "pinned at validate. finalize asserts this exact account is vault-owned,",
              "holds `output_swap_mint`, and its balance strictly INCREASED, so a",
              "compromised agent cannot redirect the swap output to its own ATA",
              "(output-ownership / M1). GENERIC: the program never learns which protocol",
              "produced the swap — it checks only vault-ownership + increase.",
              "`Pubkey::default()` for non-swap / non-stablecoin-input sessions.",
              "",
              "**APPEND-ONLY**: new fields at the END of SessionAuthority. SIZE grows by",
              "72 bytes (547 → 619). Ephemeral session ⇒ no migration."
            ],
            "type": "pubkey"
          },
          {
            "name": "outputSwapMint",
            "docs": [
              "The declared acquired mint backing `output_swap_account`. Must differ from",
              "the stablecoin input mint (a genuine acquisition, not a self-transfer).",
              "`Pubkey::default()` when no swap output is declared."
            ],
            "type": "pubkey"
          },
          {
            "name": "outputSwapBalanceBefore",
            "docs": [
              "Pre-DeFi snapshot of `output_swap_account.amount`, taken at validate.",
              "finalize requires the post-DeFi balance to be strictly greater",
              "(value-blind: the vault must have acquired *something* into the pinned",
              "account; no price/oracle). 0 when no swap output is declared."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "sessionFinalized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "agent",
            "type": "pubkey"
          },
          {
            "name": "success",
            "type": "bool"
          },
          {
            "name": "isExpired",
            "type": "bool"
          },
          {
            "name": "timestamp",
            "type": "i64"
          },
          {
            "name": "actualSpendUsd",
            "docs": [
              "Actual stablecoin spend measured by balance delta (0 for non-spending actions)."
            ],
            "type": "u64"
          },
          {
            "name": "balanceAfterUsd",
            "docs": [
              "Vault stablecoin balance after this transaction (0 for non-spending)."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "spendTracker",
      "docs": [
        "Zero-copy 144-epoch circular buffer for rolling 24h USD spend tracking.",
        "Each bucket covers a 10-minute epoch. Boundary correction ensures",
        "functionally exact accuracy (~$0.000001 worst-case rounding).",
        "Rounding direction: slightly permissive (under-counts by at most $0.000001).",
        "",
        "Seeds: `[b\"tracker\", vault.key().as_ref()]`"
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "docs": [
              "Associated vault pubkey"
            ],
            "type": "pubkey"
          },
          {
            "name": "buckets",
            "docs": [
              "144 epoch buckets for rolling 24h spend tracking"
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "epochBucket"
                  }
                },
                144
              ]
            }
          },
          {
            "name": "protocolCounters",
            "docs": [
              "Per-protocol rolling 24h counters. Enforcement wired in",
              "`finalize_session.rs` — search for \"TA-13 (Phase 5 ratification)\"",
              "(two sites: the stablecoin-input branch around line 314 and the",
              "non-stablecoin-input branch around line 408). See",
              "`policy.protocol_caps` for the cap values and",
              "`PolicyConfig::get_protocol_cap` for the lookup logic. Per-protocol",
              "entries are populated by `record_protocol_spend()` when",
              "`policy.has_protocol_caps == true`.",
              "",
              "TA-13 ratification (Phase 5): the prior doc-comment claimed",
              "\"zeroed, no enforcement yet\" — this was stale. The enforcement",
              "has lived in `finalize_session` since Phase 2; this comment was",
              "the only artifact suggesting otherwise. Phase 5 ratifies the",
              "existing require! with the dedicated `ErrDailyCapExceeded` (6086)",
              "error code so off-chain monitors can disambiguate the \"rolling",
              "24h cap hit\" semantic from the legacy \"slot allocation exhausted\"",
              "path (which still returns `ProtocolCapExceeded` from inside",
              "`record_protocol_spend`)."
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "protocolSpendCounter"
                  }
                },
                10
              ]
            }
          },
          {
            "name": "lastWriteEpoch",
            "docs": [
              "Epoch of most recent record_spend() call. Enables early exit in get_rolling_24h_usd().",
              "Zero-initialized — value 0 correctly triggers early exit (current_epoch >> 144)."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "docs": [
              "Bump seed for PDA"
            ],
            "type": "u8"
          },
          {
            "name": "padding",
            "docs": [
              "Padding for 8-byte alignment"
            ],
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          },
          {
            "name": "perRecipient",
            "docs": [
              "TA-14 (Phase 5 post-exec invariant #2): per-recipient rolling 24h",
              "outflow counters. Bounded to `MAX_PER_RECIPIENT_ENTRIES` (10)",
              "entries — Vec NOT permitted in zero-copy account per F-14.",
              "10 × 48 = 480 bytes. Each entry tracks one recipient pubkey",
              "(resolved from the SPL TokenAccount.owner field — NOT the ATA",
              "pubkey) and their rolling-24h outflow USD total."
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "perRecipientCounter"
                  }
                },
                10
              ]
            }
          },
          {
            "name": "perRecipientCount",
            "docs": [
              "TA-14 (Phase 5): how many `per_recipient` slots are currently",
              "active. New entries occupy `per_recipient[per_recipient_count]`",
              "then this counter increments. Eviction is AGE-BASED only — slots",
              "whose 24h window has elapsed are eligible; LRU/churn-eviction is",
              "EXPLICITLY REJECTED per §RP requirement (prevents an attacker",
              "recycling slots by paying many distinct recipients to bypass",
              "the cap)."
            ],
            "type": "u8"
          },
          {
            "name": "paddingRecipient",
            "docs": [
              "Padding for 8-byte alignment after the new u8 counter."
            ],
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          }
        ]
      }
    },
    {
      "name": "vaultClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "vaultCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "vaultId",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "vaultFrozen",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "agentsPreserved",
            "type": "u8"
          },
          {
            "name": "sessionsRevoked",
            "docs": [
              "Number of active session SPL delegations revoked during freeze (F2-H1 fix).",
              "Caller passes (session_pda, vault_token_account) pairs in remaining_accounts;",
              "each pair whose session_pda matches the expected derivation is revoked."
            ],
            "type": "u32"
          },
          {
            "name": "timestamp",
            "type": "i64"
          },
          {
            "name": "freezeReason",
            "docs": [
              "Phase 8 — discriminant of `FreezeReason` enum recording WHY the vault",
              "was frozen. 0 = Manual (`freeze_vault`), 1 = AutoRevoke (last agent",
              "removed via `revoke_agent`), 2 = EmergencyBoard (reserved v1.1).",
              "APPENDED at end per APPEND-ONLY event-stability rule."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "vaultReactivated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "newAgent",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "newAgentCapability",
            "type": {
              "option": "u8"
            }
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "vaultStatus",
      "docs": [
        "Vault status enum"
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "active"
          },
          {
            "name": "frozen"
          },
          {
            "name": "closed"
          }
        ]
      }
    }
  ]
};
