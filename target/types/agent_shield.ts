/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/agent_shield.json`.
 */
export type AgentShield = {
  "address": "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL",
  "metadata": {
    "name": "agentShield",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "AI Agent Financial Middleware for Solana - Permission controls, spending limits, and audit infrastructure for autonomous agents"
  },
  "instructions": [
    {
      "name": "closeVault",
      "docs": [
        "Close the vault entirely. Withdraws all remaining funds and closes all PDAs.",
        "Reclaims rent. Vault must have no open positions. Only the owner can call this."
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
                "path": "vault.vaultId",
                "account": "AgentVault"
              }
            ]
          },
          "relations": [
            "policy",
            "tracker"
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
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
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
                "path": "vault.vaultId",
                "account": "AgentVault"
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
      "name": "finalizeSession",
      "docs": [
        "Finalize a session after the DeFi action completes.",
        "Closes the SessionAuthority PDA and records the transaction in the audit log.",
        "Can be called by the agent or permissionlessly (for cleanup of expired sessions)."
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
                "account": "AgentVault"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "AgentVault"
              }
            ]
          },
          "relations": [
            "policy",
            "tracker",
            "session"
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
          "name": "session",
          "docs": [
            "Session rent is returned to the session's agent (who paid for it),",
            "not the arbitrary payer, to prevent rent theft."
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
                "account": "SessionAuthority"
              }
            ]
          }
        },
        {
          "name": "sessionRentRecipient",
          "docs": [
            "Validated in handler to equal session.agent."
          ],
          "writable": true
        },
        {
          "name": "vaultTokenAccount",
          "docs": [
            "Vault's PDA token account for the session's token (fee source)"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "feeDestinationTokenAccount",
          "docs": [
            "Developer fee destination token account \u2014 must match vault.fee_destination"
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "protocolTreasuryTokenAccount",
          "docs": [
            "Protocol treasury token account \u2014 must be owned by PROTOCOL_TREASURY"
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
        }
      ],
      "args": [
        {
          "name": "success",
          "type": "bool"
        }
      ]
    },
    {
      "name": "initializeVault",
      "docs": [
        "Initialize a new agent vault with policy configuration.",
        "Only the owner can call this. Creates vault PDA, policy PDA, and spend tracker PDA."
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
          "name": "feeDestination",
          "docs": [
            "The protocol treasury that receives fees"
          ]
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
          "name": "dailySpendingCap",
          "type": "u64"
        },
        {
          "name": "maxTransactionSize",
          "type": "u64"
        },
        {
          "name": "allowedTokens",
          "type": {
            "vec": "pubkey"
          }
        },
        {
          "name": "allowedProtocols",
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
        }
      ]
    },
    {
      "name": "reactivateVault",
      "docs": [
        "Reactivate a frozen vault. Optionally rotate the agent key.",
        "Only the owner can call this."
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
                "path": "vault.vaultId",
                "account": "AgentVault"
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
        }
      ]
    },
    {
      "name": "registerAgent",
      "docs": [
        "Register an agent's signing key to this vault.",
        "Only the owner can call this. One agent per vault."
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
                "path": "vault.vaultId",
                "account": "AgentVault"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "agent",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "revokeAgent",
      "docs": [
        "Kill switch. Immediately freezes the vault, preventing all agent actions.",
        "Only the owner can call this. Funds can still be withdrawn by the owner."
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
                "path": "vault.vaultId",
                "account": "AgentVault"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "updatePolicy",
      "docs": [
        "Update the policy configuration for a vault.",
        "Only the owner can call this. Cannot be called by the agent."
      ],
      "discriminator": [
        212,
        245,
        246,
        7,
        163,
        151,
        18,
        57
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
                "path": "owner"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "AgentVault"
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
          "name": "dailySpendingCap",
          "type": {
            "option": "u64"
          }
        },
        {
          "name": "maxTransactionSize",
          "type": {
            "option": "u64"
          }
        },
        {
          "name": "allowedTokens",
          "type": {
            "option": {
              "vec": "pubkey"
            }
          }
        },
        {
          "name": "allowedProtocols",
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
        }
      ]
    },
    {
      "name": "validateAndAuthorize",
      "docs": [
        "Core permission check. Called by the agent before a DeFi action.",
        "Validates the action against all policy constraints.",
        "If approved, creates a SessionAuthority PDA and updates spend tracking.",
        "If denied, reverts the entire transaction (including subsequent DeFi instructions)."
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
                "account": "AgentVault"
              },
              {
                "kind": "account",
                "path": "vault.vaultId",
                "account": "AgentVault"
              }
            ]
          },
          "relations": [
            "policy",
            "tracker"
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
          "name": "session",
          "docs": [
            "Ephemeral session PDA \u2014 `init` ensures no double-authorization"
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
          "name": "actionType",
          "type": {
            "defined": {
              "name": "ActionType"
            }
          }
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
          "name": "targetProtocol",
          "type": "pubkey"
        },
        {
          "name": "leverageBps",
          "type": {
            "option": "u16"
          }
        }
      ]
    },
    {
      "name": "withdrawFunds",
      "docs": [
        "Withdraw tokens from the vault back to the owner.",
        "Works in any vault status (Active or Frozen). Only the owner can call this."
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
                "path": "vault.vaultId",
                "account": "AgentVault"
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
      "name": "AgentVault",
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
      "name": "PolicyConfig",
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
      "name": "SessionAuthority",
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
      "name": "SpendTracker",
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
      "name": "ActionAuthorized",
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
      "name": "ActionDenied",
      "discriminator": [
        243,
        239,
        240,
        51,
        151,
        100,
        10,
        100
      ]
    },
    {
      "name": "AgentRegistered",
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
      "name": "AgentRevoked",
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
      "name": "FeesCollected",
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
      "name": "FundsDeposited",
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
      "name": "FundsWithdrawn",
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
      "name": "PolicyUpdated",
      "discriminator": [
        225,
        112,
        112,
        67,
        95,
        236,
        245,
        161
      ]
    },
    {
      "name": "SessionFinalized",
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
      "name": "VaultClosed",
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
      "name": "VaultCreated",
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
      "name": "VaultReactivated",
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
      "name": "VaultNotActive",
      "msg": "Vault is not active"
    },
    {
      "code": 6001,
      "name": "UnauthorizedAgent",
      "msg": "Unauthorized: signer is not the registered agent"
    },
    {
      "code": 6002,
      "name": "UnauthorizedOwner",
      "msg": "Unauthorized: signer is not the vault owner"
    },
    {
      "code": 6003,
      "name": "TokenNotAllowed",
      "msg": "Token not in allowed list"
    },
    {
      "code": 6004,
      "name": "ProtocolNotAllowed",
      "msg": "Protocol not in allowed list"
    },
    {
      "code": 6005,
      "name": "TransactionTooLarge",
      "msg": "Transaction exceeds maximum single transaction size"
    },
    {
      "code": 6006,
      "name": "DailyCapExceeded",
      "msg": "Daily spending cap would be exceeded"
    },
    {
      "code": 6007,
      "name": "LeverageTooHigh",
      "msg": "Leverage exceeds maximum allowed"
    },
    {
      "code": 6008,
      "name": "TooManyPositions",
      "msg": "Maximum concurrent open positions reached"
    },
    {
      "code": 6009,
      "name": "PositionOpeningDisallowed",
      "msg": "Cannot open new positions (policy disallows)"
    },
    {
      "code": 6010,
      "name": "SessionExpired",
      "msg": "Session has expired"
    },
    {
      "code": 6011,
      "name": "SessionNotAuthorized",
      "msg": "Session not authorized"
    },
    {
      "code": 6012,
      "name": "InvalidSession",
      "msg": "Invalid session: does not belong to this vault"
    },
    {
      "code": 6013,
      "name": "OpenPositionsExist",
      "msg": "Vault has open positions, cannot close"
    },
    {
      "code": 6014,
      "name": "TooManyAllowedTokens",
      "msg": "Policy configuration invalid: too many allowed tokens"
    },
    {
      "code": 6015,
      "name": "TooManyAllowedProtocols",
      "msg": "Policy configuration invalid: too many allowed protocols"
    },
    {
      "code": 6016,
      "name": "AgentAlreadyRegistered",
      "msg": "Agent already registered for this vault"
    },
    {
      "code": 6017,
      "name": "NoAgentRegistered",
      "msg": "No agent registered for this vault"
    },
    {
      "code": 6018,
      "name": "VaultNotFrozen",
      "msg": "Vault is not frozen (expected frozen for reactivation)"
    },
    {
      "code": 6019,
      "name": "VaultAlreadyClosed",
      "msg": "Vault is already closed"
    },
    {
      "code": 6020,
      "name": "InsufficientBalance",
      "msg": "Insufficient vault balance for withdrawal"
    },
    {
      "code": 6021,
      "name": "DeveloperFeeTooHigh",
      "msg": "Developer fee rate exceeds maximum (50 / 1,000,000 = 0.5 BPS)"
    },
    {
      "code": 6022,
      "name": "InvalidFeeDestination",
      "msg": "Fee destination account invalid"
    },
    {
      "code": 6023,
      "name": "InvalidProtocolTreasury",
      "msg": "Protocol treasury account does not match expected address"
    },
    {
      "code": 6024,
      "name": "TooManySpendEntries",
      "msg": "Spend entry limit reached (too many active entries in rolling window)"
    },
    {
      "code": 6025,
      "name": "InvalidAgentKey",
      "msg": "Invalid agent: cannot be the zero address"
    },
    {
      "code": 6026,
      "name": "AgentIsOwner",
      "msg": "Invalid agent: agent cannot be the vault owner"
    },
    {
      "code": 6027,
      "name": "Overflow",
      "msg": "Arithmetic overflow"
    }
  ],
  "types": [
    {
      "name": "ActionAuthorized",
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
            "name": "actionType",
            "type": {
              "defined": {
                "name": "ActionType"
              }
            }
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
            "name": "protocol",
            "type": "pubkey"
          },
          {
            "name": "rollingSpendAfter",
            "type": "u64"
          },
          {
            "name": "dailyCap",
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
      "name": "ActionDenied",
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
            "name": "reason",
            "type": "string"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "ActionType",
      "docs": [
        "Action types that agents can request"
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "Swap"
          },
          {
            "name": "OpenPosition"
          },
          {
            "name": "ClosePosition"
          },
          {
            "name": "IncreasePosition"
          },
          {
            "name": "DecreasePosition"
          },
          {
            "name": "Deposit"
          },
          {
            "name": "Withdraw"
          }
        ]
      }
    },
    {
      "name": "AgentRegistered",
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
      "name": "AgentRevoked",
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
      "name": "AgentVault",
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
            "name": "agent",
            "docs": [
              "The registered agent's signing key (Pubkey::default() if not yet registered)"
            ],
            "type": "pubkey"
          },
          {
            "name": "feeDestination",
            "docs": [
              "Developer fee destination \u2014 the wallet that receives developer fees",
              "on every finalized transaction. Set at vault creation, immutable after",
              "initialization. Protocol fees go to PROTOCOL_TREASURY separately."
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
            "name": "status",
            "docs": [
              "Vault status: Active, Frozen, or Closed"
            ],
            "type": {
              "defined": {
                "name": "VaultStatus"
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
              "Number of currently open positions (for perps tracking)"
            ],
            "type": "u8"
          },
          {
            "name": "totalFeesCollected",
            "docs": [
              "Cumulative developer fees collected from this vault (token base units).",
              "Protocol fees are tracked separately via events."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "FeesCollected",
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
      "name": "FundsDeposited",
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
      "name": "FundsWithdrawn",
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
      "name": "PolicyConfig",
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
            "name": "dailySpendingCap",
            "docs": [
              "Maximum spend per rolling 24h period (in token base units)"
            ],
            "type": "u64"
          },
          {
            "name": "maxTransactionSize",
            "docs": [
              "Maximum single transaction size (in token base units)"
            ],
            "type": "u64"
          },
          {
            "name": "allowedTokens",
            "docs": [
              "Allowed token mints the agent can interact with",
              "Bounded to MAX_ALLOWED_TOKENS entries"
            ],
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "allowedProtocols",
            "docs": [
              "Allowed program IDs the agent can call (Jupiter, Flash Trade, etc.)",
              "Bounded to MAX_ALLOWED_PROTOCOLS entries"
            ],
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "maxLeverageBps",
            "docs": [
              "Maximum leverage multiplier in basis points (e.g., 10000 = 100x, 1000 = 10x)",
              "Set to 0 to disallow leveraged positions entirely"
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
              "transaction. Fee deducted from vault, transferred to vault's",
              "fee_destination. Max MAX_DEVELOPER_FEE_RATE (50 = 0.5 BPS).",
              "Set to 0 for no developer fee. Protocol fee is always applied",
              "separately at PROTOCOL_FEE_RATE."
            ],
            "type": "u16"
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
      "name": "PolicyUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "dailyCap",
            "type": "u64"
          },
          {
            "name": "maxTransactionSize",
            "type": "u64"
          },
          {
            "name": "allowedTokensCount",
            "type": "u8"
          },
          {
            "name": "allowedProtocolsCount",
            "type": "u8"
          },
          {
            "name": "maxLeverageBps",
            "type": "u16"
          },
          {
            "name": "developerFeeRate",
            "type": "u16"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "SessionAuthority",
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
            "name": "actionType",
            "docs": [
              "The action type that was authorized (stored so finalize can record it)"
            ],
            "type": {
              "defined": {
                "name": "ActionType"
              }
            }
          },
          {
            "name": "expiresAtSlot",
            "docs": [
              "Slot-based expiry: session is valid until this slot"
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
      "name": "SessionFinalized",
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
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "SpendEntry",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "amountSpent",
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
      "name": "SpendTracker",
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
            "name": "rollingSpends",
            "docs": [
              "Rolling spend entries: (token_mint, amount, timestamp)",
              "Entries older than ROLLING_WINDOW_SECONDS are pruned on each access"
            ],
            "type": {
              "vec": {
                "defined": {
                  "name": "SpendEntry"
                }
              }
            }
          },
          {
            "name": "recentTransactions",
            "docs": [
              "Recent transaction log for on-chain audit trail",
              "Bounded to MAX_RECENT_TRANSACTIONS, oldest entries evicted (ring buffer)"
            ],
            "type": {
              "vec": {
                "defined": {
                  "name": "TransactionRecord"
                }
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
      "name": "TransactionRecord",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "timestamp",
            "type": "i64"
          },
          {
            "name": "actionType",
            "type": {
              "defined": {
                "name": "ActionType"
              }
            }
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
            "name": "protocol",
            "type": "pubkey"
          },
          {
            "name": "success",
            "type": "bool"
          },
          {
            "name": "slot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "VaultClosed",
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
      "name": "VaultCreated",
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
      "name": "VaultReactivated",
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
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "VaultStatus",
      "docs": [
        "Vault status enum"
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "Active"
          },
          {
            "name": "Frozen"
          },
          {
            "name": "Closed"
          }
        ]
      }
    }
  ]
};
