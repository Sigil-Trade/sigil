/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/sigil.json`.
 */
export type Sigil = {
  "address": "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL",
  "metadata": {
    "name": "sigil",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "On-chain guardrails for AI agents on Solana - Permission controls, spending limits, and audit infrastructure for autonomous agents (Sigil)"
  },
  "instructions": [
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
                "path": "vault.owner",
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
      "name": "allocateConstraintsPda",
      "docs": [
        "Allocate the InstructionConstraints PDA at 10,240 bytes (CPI limit).",
        "Must be followed by extend_pda calls + create_instruction_constraints",
        "in the same atomic transaction to reach full SIZE."
      ],
      "discriminator": [
        55,
        127,
        43,
        98,
        168,
        156,
        152,
        157
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
                "path": "owner"
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
          "name": "constraints",
          "docs": [
            "Account must not already exist (lamports == 0)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  115,
                  116,
                  114,
                  97,
                  105,
                  110,
                  116,
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
      "args": []
    },
    {
      "name": "allocatePendingConstraintsPda",
      "docs": [
        "Allocate the PendingConstraintsUpdate PDA at 10,240 bytes (CPI limit).",
        "Must be followed by extend_pda calls + queue_constraints_update",
        "in the same atomic transaction."
      ],
      "discriminator": [
        211,
        244,
        224,
        20,
        224,
        183,
        236,
        165
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
                "path": "owner"
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
          "name": "constraints",
          "docs": [
            "Existing constraints PDA must exist (proves there's something to update)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  115,
                  116,
                  114,
                  97,
                  105,
                  110,
                  116,
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
          "name": "pendingConstraints",
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
                  99,
                  111,
                  110,
                  115,
                  116,
                  114,
                  97,
                  105,
                  110,
                  116,
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
                "path": "vault.owner",
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
        }
      ],
      "args": []
    },
    {
      "name": "applyCloseConstraints",
      "docs": [
        "Apply a queued constraint closure after timelock expires.",
        "Closes the constraints PDA, clears policy.has_constraints, bumps policy_version."
      ],
      "discriminator": [
        133,
        184,
        235,
        88,
        53,
        237,
        43,
        145
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
                "path": "owner"
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
          "name": "constraints",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  115,
                  116,
                  114,
                  97,
                  105,
                  110,
                  116,
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
          "name": "pendingCloseConstraints",
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
                  99,
                  108,
                  111,
                  115,
                  101,
                  95,
                  99,
                  111,
                  110,
                  115,
                  116,
                  114,
                  97,
                  105,
                  110,
                  116,
                  115
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
      "name": "applyConstraintsUpdate",
      "docs": [
        "Apply a queued constraints update after the timelock expires."
      ],
      "discriminator": [
        175,
        103,
        90,
        155,
        134,
        91,
        135,
        242
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
                "path": "owner"
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
            "PolicyConfig — needed to bump policy_version on constraint changes."
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
          "name": "constraints",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  115,
                  116,
                  114,
                  97,
                  105,
                  110,
                  116,
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
          "name": "pendingConstraints",
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
                  99,
                  111,
                  110,
                  115,
                  116,
                  114,
                  97,
                  105,
                  110,
                  116,
                  115
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
                "path": "owner"
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
                "path": "owner"
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
      "name": "cancelCloseConstraints",
      "docs": [
        "Cancel a queued constraint closure."
      ],
      "discriminator": [
        150,
        125,
        186,
        114,
        40,
        105,
        237,
        184
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
                "path": "owner"
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
          "name": "pendingCloseConstraints",
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
                  99,
                  108,
                  111,
                  115,
                  101,
                  95,
                  99,
                  111,
                  110,
                  115,
                  116,
                  114,
                  97,
                  105,
                  110,
                  116,
                  115
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
      "name": "cancelConstraintsUpdate",
      "docs": [
        "Cancel a queued constraints update."
      ],
      "discriminator": [
        169,
        121,
        85,
        230,
        154,
        2,
        78,
        61
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
                "path": "owner"
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
          "name": "pendingConstraints",
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
                  99,
                  111,
                  110,
                  115,
                  116,
                  114,
                  97,
                  105,
                  110,
                  116,
                  115
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
                "path": "owner"
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
                "path": "owner"
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
      "args": []
    },
    {
      "name": "closeSettledEscrow",
      "docs": [
        "Close a settled/refunded escrow PDA — owner reclaims rent."
      ],
      "discriminator": [
        169,
        244,
        164,
        173,
        181,
        214,
        139,
        6
      ],
      "accounts": [
        {
          "name": "signer",
          "writable": true,
          "signer": true
        },
        {
          "name": "sourceVault",
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
                "path": "source_vault.owner",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "source_vault.vault_id",
                "account": "agentVault"
              }
            ]
          },
          "relations": [
            "escrow"
          ]
        },
        {
          "name": "destinationVaultKey",
          "docs": [
            "Validated indirectly: if the wrong key is passed, the escrow PDA seeds won't",
            "match and Anchor will reject the account."
          ]
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "sourceVault"
              },
              {
                "kind": "account",
                "path": "destinationVaultKey"
              },
              {
                "kind": "arg",
                "path": "escrowId"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "escrowId",
          "type": "u64"
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
                "path": "owner"
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
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "createEscrow",
      "docs": [
        "Create an escrow deposit between two vaults.",
        "Agent-initiated, stablecoin-only, fees deducted upfront, cap-checked."
      ],
      "discriminator": [
        253,
        215,
        165,
        116,
        36,
        108,
        68,
        80
      ],
      "accounts": [
        {
          "name": "agent",
          "writable": true,
          "signer": true
        },
        {
          "name": "sourceVault",
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
                "path": "source_vault.owner",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "source_vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
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
                "path": "sourceVault"
              }
            ]
          }
        },
        {
          "name": "tracker",
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
                "path": "sourceVault"
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
          "name": "destinationVault",
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
                "path": "destination_vault.owner",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "destination_vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "sourceVault"
              },
              {
                "kind": "account",
                "path": "destinationVault"
              },
              {
                "kind": "arg",
                "path": "escrowId"
              }
            ]
          }
        },
        {
          "name": "sourceVaultAta",
          "docs": [
            "Source vault's token account (vault PDA is authority)"
          ],
          "writable": true
        },
        {
          "name": "escrowAta",
          "docs": [
            "Escrow-owned ATA — init_if_needed because escrow PDA is created in same ix"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "escrow"
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
                "path": "tokenMint"
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
          "name": "protocolTreasuryAta",
          "docs": [
            "Protocol treasury token account (needed when protocol_fee > 0)"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "feeDestinationAta",
          "docs": [
            "Developer fee destination token account (needed when developer_fee > 0)"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "tokenMint"
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
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        }
      ],
      "args": [
        {
          "name": "escrowId",
          "type": "u64"
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "expiresAt",
          "type": "i64"
        },
        {
          "name": "conditionHash",
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
      "name": "createInstructionConstraints",
      "docs": [
        "Populate a pre-allocated InstructionConstraints PDA with entries.",
        "Only the owner can call this. PDA must be at full SIZE."
      ],
      "discriminator": [
        13,
        182,
        97,
        5,
        57,
        136,
        26,
        152
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
                "path": "owner"
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
          "name": "constraints",
          "docs": [
            "Verified in handler: correct size, program-owned, vault match, no discriminator yet."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  115,
                  116,
                  114,
                  97,
                  105,
                  110,
                  116,
                  115
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
          "name": "entries",
          "type": {
            "vec": {
              "defined": {
                "name": "constraintEntry"
              }
            }
          }
        },
        {
          "name": "strictMode",
          "type": "bool"
        }
      ]
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
                "path": "owner"
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
                "path": "owner"
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
      "name": "extendPda",
      "docs": [
        "Grow a program-owned PDA by up to 10,240 bytes per call.",
        "Used to extend constraints/pending PDAs to full SIZE before population."
      ],
      "discriminator": [
        13,
        211,
        140,
        90,
        104,
        28,
        141,
        200
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
                "path": "owner"
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
          "name": "pda",
          "docs": [
            "owner == crate::ID, vault bytes match, size within bounds."
          ],
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "targetSize",
          "type": "u32"
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
                "path": "vault.owner",
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
            "Policy config for outcome-based cap checking during finalization"
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
            "Vault's PDA token account for the session's token"
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
        }
      ],
      "args": []
    },
    {
      "name": "freezeVault",
      "docs": [
        "Freeze the vault immediately. Preserves all agent entries.",
        "Only the owner can call this. Use reactivate_vault to unfreeze."
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
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
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
          "name": "maxLeverageBps",
          "type": "u16"
        },
        {
          "name": "maxConcurrentPositions",
          "type": "u8"
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
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
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
      "name": "queueAgentPermissionsUpdate",
      "docs": [
        "Queue an agent permissions update. Timelock-gated.",
        "Per-agent PDA allows concurrent pending updates for different agents."
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
                "path": "owner"
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
        }
      ]
    },
    {
      "name": "queueCloseConstraints",
      "docs": [
        "Queue a constraint closure. Timelock-gated."
      ],
      "discriminator": [
        248,
        124,
        93,
        115,
        195,
        88,
        11,
        109
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
                "path": "owner"
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
          "name": "constraints",
          "docs": [
            "Verify constraints PDA exists (proves there's something to close)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  115,
                  116,
                  114,
                  97,
                  105,
                  110,
                  116,
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
          "name": "pendingCloseConstraints",
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
                  99,
                  108,
                  111,
                  115,
                  101,
                  95,
                  99,
                  111,
                  110,
                  115,
                  116,
                  114,
                  97,
                  105,
                  110,
                  116,
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
      "args": []
    },
    {
      "name": "queueConstraintsUpdate",
      "docs": [
        "Queue a constraints update when timelock is active."
      ],
      "discriminator": [
        247,
        253,
        233,
        93,
        233,
        54,
        53,
        131
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
                "path": "owner"
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
          "name": "constraints",
          "docs": [
            "Existing constraints — seeds verify PDA, bump verified via load()."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  115,
                  116,
                  114,
                  97,
                  105,
                  110,
                  116,
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
          "name": "pendingConstraints",
          "docs": [
            "Verified in handler: correct size, program-owned, vault match, no discriminator."
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
                  99,
                  111,
                  110,
                  115,
                  116,
                  114,
                  97,
                  105,
                  110,
                  116,
                  115
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
          "name": "entries",
          "type": {
            "vec": {
              "defined": {
                "name": "constraintEntry"
              }
            }
          }
        },
        {
          "name": "strictMode",
          "type": "bool"
        }
      ]
    },
    {
      "name": "queuePolicyUpdate",
      "docs": [
        "Queue a policy update when timelock is active."
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
                "path": "owner"
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
          "name": "maxLeverageBps",
          "type": {
            "option": "u16"
          }
        },
        {
          "name": "canOpenPositions",
          "type": {
            "option": "bool"
          }
        },
        {
          "name": "maxConcurrentPositions",
          "type": {
            "option": "u8"
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
          "name": "sessionExpirySlots",
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
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
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
      "name": "refundEscrow",
      "docs": [
        "Refund an escrow — source vault's agent or owner reclaims funds after expiry.",
        "Cap charge is NOT reversed (prevents cap-washing attacks)."
      ],
      "discriminator": [
        107,
        186,
        89,
        99,
        26,
        194,
        23,
        204
      ],
      "accounts": [
        {
          "name": "sourceSigner",
          "docs": [
            "Source vault's agent or owner"
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "sourceVault",
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
                "path": "source_vault.owner",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "source_vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "sourceVault"
              },
              {
                "kind": "account",
                "path": "escrow.destination_vault",
                "account": "escrowDeposit"
              },
              {
                "kind": "account",
                "path": "escrow.escrow_id",
                "account": "escrowDeposit"
              }
            ]
          }
        },
        {
          "name": "escrowAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "escrow"
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
                "path": "tokenMint"
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
          "name": "sourceVaultAta",
          "writable": true
        },
        {
          "name": "rentDestination",
          "writable": true
        },
        {
          "name": "tokenMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
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
                "path": "owner"
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
          "name": "agentSpendOverlay",
          "docs": [
            "Agent spend overlay — per-agent tracking slot."
          ],
          "writable": true
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
                "path": "owner"
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
          "name": "agentSpendOverlay",
          "docs": [
            "Agent spend overlay — release slot on revocation."
          ],
          "writable": true
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
      "name": "settleEscrow",
      "docs": [
        "Settle an escrow — destination vault's agent claims funds before expiry.",
        "For conditional escrows, proof must match the SHA-256 condition hash."
      ],
      "discriminator": [
        22,
        135,
        160,
        194,
        23,
        186,
        124,
        110
      ],
      "accounts": [
        {
          "name": "destinationAgent",
          "writable": true,
          "signer": true
        },
        {
          "name": "destinationVault",
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
                "path": "destination_vault.owner",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "destination_vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
        },
        {
          "name": "sourceVault",
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
                "path": "source_vault.owner",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "source_vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "sourceVault"
              },
              {
                "kind": "account",
                "path": "destinationVault"
              },
              {
                "kind": "account",
                "path": "escrow.escrow_id",
                "account": "escrowDeposit"
              }
            ]
          }
        },
        {
          "name": "escrowAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "escrow"
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
                "path": "tokenMint"
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
          "name": "destinationVaultAta",
          "writable": true
        },
        {
          "name": "rentDestination",
          "writable": true
        },
        {
          "name": "tokenMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "proof",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "syncPositions",
      "docs": [
        "Sync the vault's open position counter with the actual state."
      ],
      "discriminator": [
        255,
        102,
        161,
        80,
        185,
        74,
        140,
        60
      ],
      "accounts": [
        {
          "name": "owner",
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
                "path": "vault.owner",
                "account": "agentVault"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "actualPositions",
          "type": "u8"
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
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "vault.vault_id",
                "account": "agentVault"
              }
            ]
          }
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
                "path": "vault.owner",
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
                "path": "owner"
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
      "name": "escrowDeposit",
      "discriminator": [
        56,
        152,
        208,
        160,
        159,
        83,
        6,
        17
      ]
    },
    {
      "name": "instructionConstraints",
      "discriminator": [
        183,
        235,
        149,
        166,
        174,
        58,
        98,
        218
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
      "name": "pendingCloseConstraints",
      "discriminator": [
        128,
        154,
        58,
        181,
        85,
        163,
        243,
        233
      ]
    },
    {
      "name": "pendingConstraintsUpdate",
      "discriminator": [
        22,
        206,
        77,
        208,
        147,
        121,
        53,
        174
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
      "name": "closeConstraintsApplied",
      "discriminator": [
        186,
        62,
        25,
        109,
        144,
        207,
        83,
        13
      ]
    },
    {
      "name": "closeConstraintsCancelled",
      "discriminator": [
        102,
        226,
        171,
        191,
        99,
        98,
        255,
        134
      ]
    },
    {
      "name": "closeConstraintsQueued",
      "discriminator": [
        77,
        23,
        232,
        153,
        108,
        46,
        243,
        53
      ]
    },
    {
      "name": "constraintsChangeApplied",
      "discriminator": [
        112,
        150,
        111,
        125,
        243,
        133,
        35,
        55
      ]
    },
    {
      "name": "constraintsChangeCancelled",
      "discriminator": [
        15,
        75,
        104,
        222,
        104,
        193,
        65,
        145
      ]
    },
    {
      "name": "constraintsChangeQueued",
      "discriminator": [
        111,
        221,
        100,
        149,
        52,
        23,
        88,
        212
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
      "name": "escrowCreated",
      "discriminator": [
        70,
        127,
        105,
        102,
        92,
        97,
        7,
        173
      ]
    },
    {
      "name": "escrowRefunded",
      "discriminator": [
        132,
        209,
        49,
        109,
        135,
        138,
        28,
        81
      ]
    },
    {
      "name": "escrowSettled",
      "discriminator": [
        97,
        27,
        150,
        55,
        203,
        179,
        173,
        23
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
      "name": "instructionConstraintsCreated",
      "discriminator": [
        8,
        170,
        99,
        232,
        31,
        216,
        57,
        26
      ]
    },
    {
      "name": "pdaAllocated",
      "discriminator": [
        27,
        99,
        195,
        198,
        238,
        53,
        3,
        181
      ]
    },
    {
      "name": "pdaExtended",
      "discriminator": [
        67,
        151,
        95,
        79,
        12,
        11,
        51,
        242
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
      "name": "positionsSynced",
      "discriminator": [
        83,
        33,
        144,
        201,
        168,
        13,
        0,
        95
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
      "name": "leverageTooHigh",
      "msg": "Leverage exceeds maximum allowed"
    },
    {
      "code": 6008,
      "name": "tooManyPositions",
      "msg": "Maximum concurrent open positions reached"
    },
    {
      "code": 6009,
      "name": "positionOpeningDisallowed",
      "msg": "Cannot open new positions (policy disallows)"
    },
    {
      "code": 6010,
      "name": "sessionNotAuthorized",
      "msg": "Session not authorized"
    },
    {
      "code": 6011,
      "name": "invalidSession",
      "msg": "Invalid session: does not belong to this vault"
    },
    {
      "code": 6012,
      "name": "openPositionsExist",
      "msg": "Vault has open positions, cannot close"
    },
    {
      "code": 6013,
      "name": "tooManyAllowedProtocols",
      "msg": "Policy configuration invalid: too many allowed protocols"
    },
    {
      "code": 6014,
      "name": "agentAlreadyRegistered",
      "msg": "Agent already registered for this vault"
    },
    {
      "code": 6015,
      "name": "noAgentRegistered",
      "msg": "No agent registered for this vault"
    },
    {
      "code": 6016,
      "name": "vaultNotFrozen",
      "msg": "Vault is not frozen (expected frozen for reactivation)"
    },
    {
      "code": 6017,
      "name": "vaultAlreadyClosed",
      "msg": "Vault is already closed"
    },
    {
      "code": 6018,
      "name": "insufficientBalance",
      "msg": "Insufficient vault balance for withdrawal"
    },
    {
      "code": 6019,
      "name": "developerFeeTooHigh",
      "msg": "Developer fee rate exceeds maximum (500 / 1,000,000 = 5 BPS)"
    },
    {
      "code": 6020,
      "name": "invalidFeeDestination",
      "msg": "Fee destination account invalid"
    },
    {
      "code": 6021,
      "name": "invalidProtocolTreasury",
      "msg": "Protocol treasury account does not match expected address"
    },
    {
      "code": 6022,
      "name": "invalidAgentKey",
      "msg": "Invalid agent: cannot be the zero address"
    },
    {
      "code": 6023,
      "name": "agentIsOwner",
      "msg": "Invalid agent: agent cannot be the vault owner"
    },
    {
      "code": 6024,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6025,
      "name": "invalidTokenAccount",
      "msg": "Token account does not belong to vault or has wrong mint"
    },
    {
      "code": 6026,
      "name": "timelockNotExpired",
      "msg": "Timelock period has not expired yet"
    },
    {
      "code": 6027,
      "name": "noTimelockConfigured",
      "msg": "No timelock configured on this vault"
    },
    {
      "code": 6028,
      "name": "destinationNotAllowed",
      "msg": "Destination not in allowed list"
    },
    {
      "code": 6029,
      "name": "tooManyDestinations",
      "msg": "Too many destinations (max 10)"
    },
    {
      "code": 6030,
      "name": "invalidProtocolMode",
      "msg": "Invalid protocol mode (must be 0, 1, or 2)"
    },
    {
      "code": 6031,
      "name": "invalidNonSpendingAmount",
      "msg": "Non-spending action must have amount = 0"
    },
    {
      "code": 6032,
      "name": "noPositionsToClose",
      "msg": "No open positions to close or cancel"
    },
    {
      "code": 6033,
      "name": "cpiCallNotAllowed",
      "msg": "Instruction must be top-level (CPI calls not allowed)"
    },
    {
      "code": 6034,
      "name": "missingFinalizeInstruction",
      "msg": "Transaction must include finalize_session after validate"
    },
    {
      "code": 6035,
      "name": "nonTrackedSwapMustReturnStablecoin",
      "msg": "Non-stablecoin swap must return stablecoin (balance did not increase)"
    },
    {
      "code": 6036,
      "name": "swapSlippageExceeded",
      "msg": "Swap slippage exceeds policy max_slippage_bps or quoted output is zero"
    },
    {
      "code": 6037,
      "name": "invalidJupiterInstruction",
      "msg": "Cannot parse Jupiter swap instruction data"
    },
    {
      "code": 6038,
      "name": "unauthorizedTokenTransfer",
      "msg": "Top-level SPL Token transfer not allowed between validate and finalize"
    },
    {
      "code": 6039,
      "name": "slippageBpsTooHigh",
      "msg": "Slippage BPS exceeds maximum (5000 = 50%)"
    },
    {
      "code": 6040,
      "name": "protocolMismatch",
      "msg": "DeFi instruction program does not match declared target_protocol"
    },
    {
      "code": 6041,
      "name": "tooManyDeFiInstructions",
      "msg": "Spending allows at most one DeFi instruction"
    },
    {
      "code": 6042,
      "name": "maxAgentsReached",
      "msg": "Maximum agents per vault reached (limit: 10)"
    },
    {
      "code": 6043,
      "name": "insufficientPermissions",
      "msg": "Agent lacks permission for this action type"
    },
    {
      "code": 6044,
      "name": "invalidPermissions",
      "msg": "Permission bitmask contains invalid bits"
    },
    {
      "code": 6045,
      "name": "escrowNotActive",
      "msg": "Escrow is not in Active status"
    },
    {
      "code": 6046,
      "name": "escrowExpired",
      "msg": "Escrow has expired"
    },
    {
      "code": 6047,
      "name": "escrowNotExpired",
      "msg": "Escrow has not expired yet"
    },
    {
      "code": 6048,
      "name": "invalidEscrowVault",
      "msg": "Invalid escrow vault"
    },
    {
      "code": 6049,
      "name": "escrowConditionsNotMet",
      "msg": "Escrow conditions not met"
    },
    {
      "code": 6050,
      "name": "escrowDurationExceeded",
      "msg": "Escrow duration exceeds maximum (30 days)"
    },
    {
      "code": 6051,
      "name": "invalidConstraintConfig",
      "msg": "Invalid constraint configuration: bounds exceeded"
    },
    {
      "code": 6052,
      "name": "constraintViolated",
      "msg": "Instruction constraint violated"
    },
    {
      "code": 6053,
      "name": "invalidConstraintsPda",
      "msg": "Invalid constraints PDA: wrong owner or vault"
    },
    {
      "code": 6054,
      "name": "invalidPendingConstraintsPda",
      "msg": "Invalid pending constraints PDA: wrong owner or vault"
    },
    {
      "code": 6055,
      "name": "agentSpendLimitExceeded",
      "msg": "Agent rolling 24h spend exceeds per-agent spending limit"
    },
    {
      "code": 6056,
      "name": "overlaySlotExhausted",
      "msg": "Per-agent overlay is full; cannot register agent with spending limit"
    },
    {
      "code": 6057,
      "name": "agentSlotNotFound",
      "msg": "Agent has per-agent spending limit but no overlay tracking slot"
    },
    {
      "code": 6058,
      "name": "unauthorizedTokenApproval",
      "msg": "Unauthorized SPL Token Approve between validate and finalize"
    },
    {
      "code": 6059,
      "name": "invalidSessionExpiry",
      "msg": "Session expiry slots out of range (10-450)"
    },
    {
      "code": 6060,
      "name": "unconstrainedProgramBlocked",
      "msg": "Program has no constraint entry and strict mode is enabled"
    },
    {
      "code": 6061,
      "name": "protocolCapExceeded",
      "msg": "Per-protocol rolling 24h spending cap would be exceeded"
    },
    {
      "code": 6062,
      "name": "protocolCapsMismatch",
      "msg": "protocol_caps length must match protocols length when has_protocol_caps is true"
    },
    {
      "code": 6063,
      "name": "activeEscrowsExist",
      "msg": "Cannot close vault with active escrow deposits"
    },
    {
      "code": 6064,
      "name": "constraintsNotClosed",
      "msg": "Instruction constraints must be closed before closing vault"
    },
    {
      "code": 6065,
      "name": "pendingPolicyExists",
      "msg": "Pending policy update must be applied or cancelled before closing vault"
    },
    {
      "code": 6066,
      "name": "agentPaused",
      "msg": "Agent is paused and cannot execute actions"
    },
    {
      "code": 6067,
      "name": "agentAlreadyPaused",
      "msg": "Agent is already paused"
    },
    {
      "code": 6068,
      "name": "agentNotPaused",
      "msg": "Agent is not paused"
    },
    {
      "code": 6069,
      "name": "unauthorizedPostFinalizeInstruction",
      "msg": "Instructions after finalize_session must be ComputeBudget or SystemProgram only"
    },
    {
      "code": 6070,
      "name": "unexpectedBalanceDecrease",
      "msg": "Vault balance decreased more than delegated amount — potential CPI attack"
    },
    {
      "code": 6071,
      "name": "timelockTooShort",
      "msg": "Timelock duration below minimum (1800 seconds / 30 minutes)"
    },
    {
      "code": 6072,
      "name": "policyVersionMismatch",
      "msg": "Policy version mismatch — policy changed since agent's last RPC read"
    },
    {
      "code": 6073,
      "name": "pendingAgentPermsExists",
      "msg": "A pending agent permissions update already exists for this agent"
    },
    {
      "code": 6074,
      "name": "pendingCloseConstraintsExists",
      "msg": "A pending close constraints operation already exists for this vault"
    },
    {
      "code": 6075,
      "name": "activeSessionsExist",
      "msg": "Cannot close vault with active sessions (finalize pending sessions first)"
    },
    {
      "code": 6076,
      "name": "postAssertionFailed",
      "msg": "Post-execution assertion failed: account state did not satisfy constraint"
    },
    {
      "code": 6077,
      "name": "invalidPostAssertionIndex",
      "msg": "Post-assertion constraint references invalid instruction index"
    },
    {
      "code": 6078,
      "name": "constraintIndexOutOfBounds",
      "msg": "Constraint entry index out of bounds for zero-copy array"
    },
    {
      "code": 6079,
      "name": "invalidConstraintOperator",
      "msg": "Constraint operator value is not a valid ConstraintOperator discriminant"
    },
    {
      "code": 6080,
      "name": "constraintsVaultMismatch",
      "msg": "Zero-copy constraints account has wrong vault"
    },
    {
      "code": 6081,
      "name": "constraintEntryCountExceeded",
      "msg": "Cannot pack entries: entry count exceeds MAX_CONSTRAINT_ENTRIES"
    }
  ],
  "types": [
    {
      "name": "accountConstraint",
      "docs": [
        "Account-index constraint: requires a specific pubkey at a specific account index."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "index",
            "type": "u8"
          },
          {
            "name": "expected",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "accountConstraintZc",
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "expected",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "index",
            "type": "u8"
          },
          {
            "name": "padding",
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
            "name": "isSpending",
            "type": "bool"
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
            "name": "reserved",
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
        "Size calculation:",
        "8 (discriminator) + 32 (vault) + 232 × 10 (entries) + 1 (bump) + 7 (padding) + 80 (lifetime_spend) + 80 (lifetime_tx_count) = 2,528 bytes"
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
            "name": "openPositions",
            "docs": [
              "Number of currently open positions (for perps tracking).",
              "DESIGN DECISION: Counter-only. Does not store per-position details",
              "(entry price, size, liquidation price). Individual position data is",
              "protocol-specific (Flash Trade vs Drift vs Jupiter perps have different",
              "layouts). The SDK reads position details via RPC. sync_positions",
              "corrects counter drift from auto-liquidation.",
              "Found by: Persona test (Perps Developer \"Jake\")"
            ],
            "type": "u8"
          },
          {
            "name": "activeEscrowCount",
            "docs": [
              "Number of active (unsettled/unrefunded) escrow deposits from this vault"
            ],
            "type": "u8"
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
          }
        ]
      }
    },
    {
      "name": "closeConstraintsApplied",
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
      "name": "closeConstraintsCancelled",
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
      "name": "closeConstraintsQueued",
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
      "name": "constraintEntry",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "programId",
            "type": "pubkey"
          },
          {
            "name": "dataConstraints",
            "type": {
              "vec": {
                "defined": {
                  "name": "dataConstraint"
                }
              }
            }
          },
          {
            "name": "accountConstraints",
            "type": {
              "vec": {
                "defined": {
                  "name": "accountConstraint"
                }
              }
            }
          },
          {
            "name": "isSpending",
            "docs": [
              "Spending classification: 1=Spending, 2=NonSpending. Required (0 rejected)."
            ],
            "type": "u8"
          },
          {
            "name": "positionEffect",
            "docs": [
              "Position effect: 0=None, 1=Increment, 2=Decrement."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "constraintEntryZc",
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "programId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "dataConstraints",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "dataConstraintZc"
                  }
                },
                8
              ]
            }
          },
          {
            "name": "accountConstraints",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "accountConstraintZc"
                  }
                },
                5
              ]
            }
          },
          {
            "name": "dataCount",
            "type": "u8"
          },
          {
            "name": "accountCount",
            "type": "u8"
          },
          {
            "name": "isSpending",
            "docs": [
              "Spending classification: 0=Unset (treated as spending), 1=Spending, 2=NonSpending.",
              "Set by vault owner at constraint creation time. The constraint engine returns",
              "this value when it matches an entry — replaces ActionType.is_spending()."
            ],
            "type": "u8"
          },
          {
            "name": "positionEffect",
            "docs": [
              "Position tracking: 0=None, 1=Increment (opens position), 2=Decrement (closes position).",
              "Replaces ActionType.position_effect()."
            ],
            "type": "u8"
          },
          {
            "name": "padding",
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          }
        ]
      }
    },
    {
      "name": "constraintOperator",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "eq"
          },
          {
            "name": "ne"
          },
          {
            "name": "gte"
          },
          {
            "name": "lte"
          },
          {
            "name": "gteSigned"
          },
          {
            "name": "lteSigned"
          },
          {
            "name": "bitmask"
          }
        ]
      }
    },
    {
      "name": "constraintsChangeApplied",
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
      "name": "constraintsChangeCancelled",
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
      "name": "constraintsChangeQueued",
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
      "name": "dataConstraint",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "offset",
            "type": "u16"
          },
          {
            "name": "operator",
            "type": {
              "defined": {
                "name": "constraintOperator"
              }
            }
          },
          {
            "name": "value",
            "type": "bytes"
          }
        ]
      }
    },
    {
      "name": "dataConstraintZc",
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "offset",
            "type": "u16"
          },
          {
            "name": "operator",
            "type": "u8"
          },
          {
            "name": "valueLen",
            "type": "u8"
          },
          {
            "name": "value",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "padding",
            "type": {
              "array": [
                "u8",
                4
              ]
            }
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
      "name": "escrowCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "sourceVault",
            "type": "pubkey"
          },
          {
            "name": "destinationVault",
            "type": "pubkey"
          },
          {
            "name": "escrowId",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          },
          {
            "name": "conditionHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "escrowDeposit",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "sourceVault",
            "type": "pubkey"
          },
          {
            "name": "destinationVault",
            "type": "pubkey"
          },
          {
            "name": "escrowId",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "escrowStatus"
              }
            }
          },
          {
            "name": "conditionHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "escrowRefunded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "sourceVault",
            "type": "pubkey"
          },
          {
            "name": "destinationVault",
            "type": "pubkey"
          },
          {
            "name": "escrowId",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "refundedBy",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "escrowSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "sourceVault",
            "type": "pubkey"
          },
          {
            "name": "destinationVault",
            "type": "pubkey"
          },
          {
            "name": "escrowId",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "settledBy",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "escrowStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "active"
          },
          {
            "name": "settled"
          },
          {
            "name": "refunded"
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
      "name": "instructionConstraints",
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "entries",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "constraintEntryZc"
                  }
                },
                64
              ]
            }
          },
          {
            "name": "entryCount",
            "type": "u8"
          },
          {
            "name": "strictMode",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "constraintVersion",
            "docs": [
              "Constraint schema version. Always 1 for new deployments."
            ],
            "type": "u8"
          },
          {
            "name": "padding",
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          }
        ]
      }
    },
    {
      "name": "instructionConstraintsCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "entriesCount",
            "type": "u8"
          },
          {
            "name": "strictMode",
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
      "name": "pdaAllocated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "pdaType",
            "type": "u8"
          },
          {
            "name": "initialSize",
            "type": "u32"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "pdaExtended",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "oldSize",
            "type": "u32"
          },
          {
            "name": "newSize",
            "type": "u32"
          },
          {
            "name": "timestamp",
            "type": "i64"
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
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "pendingCloseConstraints",
      "docs": [
        "Queued constraint closure. Minimal — just needs the timelock gate.",
        "PDA seeds: [b\"pending_close_constraints\", vault.key().as_ref()]"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
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
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "pendingConstraintsUpdate",
      "docs": [
        "Queued instruction constraints update that becomes executable after",
        "a timelock period. Mirrors `PendingPolicyUpdate` pattern.",
        "",
        "PDA seeds: `[b\"pending_constraints\", vault.key().as_ref()]`",
        "",
        "Zero-copy layout — same entries array as InstructionConstraints",
        "plus queued_at and executes_at timestamps."
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
              "Associated vault pubkey (as raw bytes for Pod compatibility)"
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
              "New constraint entries to apply (fixed array, use entry_count for active)"
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "constraintEntryZc"
                  }
                },
                64
              ]
            }
          },
          {
            "name": "entryCount",
            "docs": [
              "Number of active entries (0..=64)"
            ],
            "type": "u8"
          },
          {
            "name": "strictMode",
            "docs": [
              "Whether to reject programs without matching constraint entries (0 = permissive, non-zero = strict)"
            ],
            "type": "u8"
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
              "Alignment padding"
            ],
            "type": {
              "array": [
                "u8",
                5
              ]
            }
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
            "name": "maxLeverageBps",
            "type": {
              "option": "u16"
            }
          },
          {
            "name": "canOpenPositions",
            "type": {
              "option": "bool"
            }
          },
          {
            "name": "maxConcurrentPositions",
            "type": {
              "option": "u8"
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
            "name": "sessionExpirySlots",
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
            "name": "bump",
            "docs": [
              "Bump seed for PDA"
            ],
            "type": "u8"
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
              "Protocol access control mode:",
              "0 = all allowed (protocols list ignored)",
              "1 = allowlist (only protocols in list)",
              "2 = denylist (all except protocols in list)"
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
            "name": "maxLeverageBps",
            "docs": [
              "DEPRECATED: Not enforced on-chain. Kept for layout stability. See Phase B3 post-assertions."
            ],
            "type": "u16"
          },
          {
            "name": "canOpenPositions",
            "docs": [
              "Whether the agent can open new positions (vs only close existing)"
            ],
            "type": "bool"
          },
          {
            "name": "maxConcurrentPositions",
            "docs": [
              "Maximum number of concurrent open positions"
            ],
            "type": "u8"
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
              "Maximum slippage tolerance for Jupiter swaps in basis points.",
              "0 = reject all swaps (vault owner must explicitly configure).",
              "Enforced on-chain via instruction introspection of Jupiter data."
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
            "name": "hasConstraints",
            "docs": [
              "Whether instruction constraints PDA exists for this vault.",
              "Set true by create_instruction_constraints, false by apply_close_constraints."
            ],
            "type": "bool"
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
            "name": "sessionExpirySlots",
            "docs": [
              "Configurable session expiry in slots. 0 = use default (SESSION_EXPIRY_SLOTS = 20).",
              "Valid range when non-zero: 10-450 slots."
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
          }
        ]
      }
    },
    {
      "name": "positionsSynced",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "oldCount",
            "type": "u8"
          },
          {
            "name": "newCount",
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
        "Borsh-serializable assertion entry (instruction parameter form)."
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
        "Phase B3 will add CrossFieldLte for leverage ratio enforcement."
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
              "Typically a Position PDA, User account, or similar protocol state."
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
              "Byte offset in the target account's data to read."
            ],
            "type": "u16"
          },
          {
            "name": "valueLen",
            "docs": [
              "Length of the value to compare (1-32 bytes)."
            ],
            "type": "u8"
          },
          {
            "name": "operator",
            "docs": [
              "Comparison operator (reuses ConstraintOperator: Eq, Ne, Gte, Lte, etc.)"
            ],
            "type": "u8"
          },
          {
            "name": "expectedValue",
            "docs": [
              "Expected value for comparison (same max as DataConstraint)."
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
              "2 = MaxIncrease: check (current - snapshot) ≤ expected_value (Phase B2)",
              "3 = NoChange: check current == snapshot (Phase B2)"
            ],
            "type": "u8"
          },
          {
            "name": "padding",
            "docs": [
              "Padding to align to 8 bytes. Total: 32 + 2 + 1 + 1 + 32 + 1 + 7 = 76",
              "Future: 4 bytes for cross-field offset_b (Phase B3 CrossFieldLte)",
              "Future: 2 bytes for cross-field multiplier (Phase B3)",
              "Future: 1 byte for cross-field flags"
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
        "Seeds: [b\"post_assertions\", vault.key()]"
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
                4
              ]
            }
          },
          {
            "name": "entryCount",
            "docs": [
              "Number of active entries (0..=4)."
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
            "name": "isSpending",
            "docs": [
              "Whether the matched constraint entry classifies this as spending.",
              "Derived from amount > 0 in validate_and_authorize."
            ],
            "type": "bool"
          },
          {
            "name": "positionEffect",
            "docs": [
              "Position effect from matched constraint entry (0=None, 1=Increment, 2=Decrement)."
            ],
            "type": "u8"
          },
          {
            "name": "expiresAtSlot",
            "docs": [
              "Slot-based expiry: session is valid until this slot"
            ],
            "type": "u64"
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
          },
          {
            "name": "isSpending",
            "docs": [
              "Whether this was a spending action."
            ],
            "type": "bool"
          },
          {
            "name": "positionEffect",
            "docs": [
              "Position effect: 0=None, 1=Increment, 2=Decrement."
            ],
            "type": "u8"
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
              "Reserved per-protocol spend counters (zeroed, no enforcement yet)"
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
            "name": "timestamp",
            "type": "i64"
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
