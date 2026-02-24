/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/agent_shield.json`.
 */
export type AgentShield = {
  address: "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL";
  metadata: {
    name: "agentShield";
    version: "0.1.0";
    spec: "0.1.0";
    description: "On-chain guardrails for AI agents on Solana - Permission controls, spending limits, and audit infrastructure for autonomous agents";
  };
  instructions: [
    {
      name: "agentTransfer";
      docs: [
        "Transfer tokens from the vault to an allowed destination.",
        "Only the agent can call this.",
      ];
      discriminator: [199, 111, 151, 49, 124, 13, 150, 44];
      accounts: [
        {
          name: "agent";
          writable: true;
          signer: true;
        },
        {
          name: "vault";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "vault.owner";
                account: "agentVault";
              },
              {
                kind: "account";
                path: "vault.vault_id";
                account: "agentVault";
              },
            ];
          };
          relations: ["policy"];
        },
        {
          name: "policy";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [112, 111, 108, 105, 99, 121];
              },
              {
                kind: "account";
                path: "vault";
              },
            ];
          };
        },
        {
          name: "tracker";
          docs: ["Zero-copy SpendTracker"];
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [116, 114, 97, 99, 107, 101, 114];
              },
              {
                kind: "account";
                path: "vault";
              },
            ];
          };
        },
        {
          name: "oracleRegistry";
          docs: ["Protocol-level oracle registry"];
          pda: {
            seeds: [
              {
                kind: "const";
                value: [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101,
                  95,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121,
                ];
              },
            ];
          };
        },
        {
          name: "vaultTokenAccount";
          docs: ["Vault's PDA-owned token account (source)"];
          writable: true;
        },
        {
          name: "tokenMintAccount";
          docs: ["Token mint account for decimals validation"];
        },
        {
          name: "destinationTokenAccount";
          docs: ["Destination token account (must be in allowed destinations)"];
          writable: true;
        },
        {
          name: "feeDestinationTokenAccount";
          docs: ["Developer fee destination token account"];
          writable: true;
          optional: true;
        },
        {
          name: "protocolTreasuryTokenAccount";
          docs: ["Protocol treasury token account"];
          writable: true;
          optional: true;
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
      ];
      args: [
        {
          name: "amount";
          type: "u64";
        },
      ];
    },
    {
      name: "applyPendingPolicy";
      docs: ["Apply a queued policy update after the timelock expires."];
      discriminator: [114, 212, 19, 227, 89, 199, 74, 62];
      accounts: [
        {
          name: "owner";
          writable: true;
          signer: true;
          relations: ["vault"];
        },
        {
          name: "vault";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "owner";
              },
              {
                kind: "account";
                path: "vault.vault_id";
                account: "agentVault";
              },
            ];
          };
          relations: ["policy", "pendingPolicy"];
        },
        {
          name: "policy";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [112, 111, 108, 105, 99, 121];
              },
              {
                kind: "account";
                path: "vault";
              },
            ];
          };
        },
        {
          name: "pendingPolicy";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [
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
                  121,
                ];
              },
              {
                kind: "account";
                path: "vault";
              },
            ];
          };
        },
      ];
      args: [];
    },
    {
      name: "cancelPendingPolicy";
      docs: ["Cancel a queued policy update."];
      discriminator: [153, 36, 104, 200, 50, 94, 207, 33];
      accounts: [
        {
          name: "owner";
          writable: true;
          signer: true;
          relations: ["vault"];
        },
        {
          name: "vault";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "owner";
              },
              {
                kind: "account";
                path: "vault.vault_id";
                account: "agentVault";
              },
            ];
          };
          relations: ["pendingPolicy"];
        },
        {
          name: "pendingPolicy";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [
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
                  121,
                ];
              },
              {
                kind: "account";
                path: "vault";
              },
            ];
          };
        },
      ];
      args: [];
    },
    {
      name: "closeVault";
      docs: ["Close the vault entirely. Reclaims rent from all PDAs."];
      discriminator: [141, 103, 17, 126, 72, 75, 29, 29];
      accounts: [
        {
          name: "owner";
          writable: true;
          signer: true;
          relations: ["vault"];
        },
        {
          name: "vault";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "owner";
              },
              {
                kind: "account";
                path: "vault.vault_id";
                account: "agentVault";
              },
            ];
          };
          relations: ["policy"];
        },
        {
          name: "policy";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [112, 111, 108, 105, 99, 121];
              },
              {
                kind: "account";
                path: "vault";
              },
            ];
          };
        },
        {
          name: "tracker";
          docs: ["Zero-copy SpendTracker — close returns rent to owner"];
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [116, 114, 97, 99, 107, 101, 114];
              },
              {
                kind: "account";
                path: "vault";
              },
            ];
          };
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        },
      ];
      args: [];
    },
    {
      name: "depositFunds";
      docs: [
        "Deposit SPL tokens into the vault's PDA-controlled token account.",
        "Only the owner can call this.",
      ];
      discriminator: [202, 39, 52, 211, 53, 20, 250, 88];
      accounts: [
        {
          name: "owner";
          writable: true;
          signer: true;
          relations: ["vault"];
        },
        {
          name: "vault";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "owner";
              },
              {
                kind: "account";
                path: "vault.vault_id";
                account: "agentVault";
              },
            ];
          };
        },
        {
          name: "mint";
        },
        {
          name: "ownerTokenAccount";
          docs: ["Owner's token account to transfer from"];
          writable: true;
          pda: {
            seeds: [
              {
                kind: "account";
                path: "owner";
              },
              {
                kind: "const";
                value: [
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
                  169,
                ];
              },
              {
                kind: "account";
                path: "mint";
              },
            ];
            program: {
              kind: "const";
              value: [
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
                89,
              ];
            };
          };
        },
        {
          name: "vaultTokenAccount";
          docs: ["Vault's PDA-controlled token account"];
          writable: true;
          pda: {
            seeds: [
              {
                kind: "account";
                path: "vault";
              },
              {
                kind: "const";
                value: [
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
                  169,
                ];
              },
              {
                kind: "account";
                path: "mint";
              },
            ];
            program: {
              kind: "const";
              value: [
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
                89,
              ];
            };
          };
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
        {
          name: "associatedTokenProgram";
          address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        },
      ];
      args: [
        {
          name: "amount";
          type: "u64";
        },
      ];
    },
    {
      name: "finalizeSession";
      docs: [
        "Finalize a session after the DeFi action completes.",
        "Revokes delegation, collects fees, closes the SessionAuthority PDA.",
      ];
      discriminator: [34, 148, 144, 47, 37, 130, 206, 161];
      accounts: [
        {
          name: "payer";
          writable: true;
          signer: true;
        },
        {
          name: "vault";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "vault.owner";
                account: "agentVault";
              },
              {
                kind: "account";
                path: "vault.vault_id";
                account: "agentVault";
              },
            ];
          };
          relations: ["policy", "session"];
        },
        {
          name: "policy";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [112, 111, 108, 105, 99, 121];
              },
              {
                kind: "account";
                path: "vault";
              },
            ];
          };
        },
        {
          name: "session";
          docs: [
            "Session rent is returned to the session's agent (who paid for it).",
            "Seeds include token_mint for per-token concurrent sessions.",
          ];
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [115, 101, 115, 115, 105, 111, 110];
              },
              {
                kind: "account";
                path: "vault";
              },
              {
                kind: "account";
                path: "session.agent";
                account: "sessionAuthority";
              },
              {
                kind: "account";
                path: "session.authorized_token";
                account: "sessionAuthority";
              },
            ];
          };
        },
        {
          name: "sessionRentRecipient";
          writable: true;
        },
        {
          name: "vaultTokenAccount";
          docs: ["Vault's PDA token account for the session's token"];
          writable: true;
          optional: true;
        },
        {
          name: "feeDestinationTokenAccount";
          docs: ["Developer fee destination token account"];
          writable: true;
          optional: true;
        },
        {
          name: "protocolTreasuryTokenAccount";
          docs: ["Protocol treasury token account"];
          writable: true;
          optional: true;
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        },
      ];
      args: [
        {
          name: "success";
          type: "bool";
        },
      ];
    },
    {
      name: "initializeOracleRegistry";
      docs: [
        "Initialize the protocol-level oracle registry.",
        "Only called once. The authority becomes the registry admin.",
      ];
      discriminator: [190, 92, 228, 114, 56, 71, 101, 220];
      accounts: [
        {
          name: "authority";
          writable: true;
          signer: true;
        },
        {
          name: "oracleRegistry";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101,
                  95,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121,
                ];
              },
            ];
          };
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        },
      ];
      args: [
        {
          name: "entries";
          type: {
            vec: {
              defined: {
                name: "oracleEntry";
              };
            };
          };
        },
      ];
    },
    {
      name: "initializeVault";
      docs: [
        "Initialize a new agent vault with policy configuration.",
        "Only the owner can call this. Creates vault PDA, policy PDA,",
        "and zero-copy spend tracker PDA.",
      ];
      discriminator: [48, 191, 163, 44, 71, 129, 63, 164];
      accounts: [
        {
          name: "owner";
          writable: true;
          signer: true;
        },
        {
          name: "vault";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "owner";
              },
              {
                kind: "arg";
                path: "vaultId";
              },
            ];
          };
        },
        {
          name: "policy";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [112, 111, 108, 105, 99, 121];
              },
              {
                kind: "account";
                path: "vault";
              },
            ];
          };
        },
        {
          name: "tracker";
          docs: ["Zero-copy SpendTracker — 2,352 bytes fixed size"];
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [116, 114, 97, 99, 107, 101, 114];
              },
              {
                kind: "account";
                path: "vault";
              },
            ];
          };
        },
        {
          name: "feeDestination";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        },
      ];
      args: [
        {
          name: "vaultId";
          type: "u64";
        },
        {
          name: "dailySpendingCapUsd";
          type: "u64";
        },
        {
          name: "maxTransactionSizeUsd";
          type: "u64";
        },
        {
          name: "protocolMode";
          type: "u8";
        },
        {
          name: "protocols";
          type: {
            vec: "pubkey";
          };
        },
        {
          name: "maxLeverageBps";
          type: "u16";
        },
        {
          name: "maxConcurrentPositions";
          type: "u8";
        },
        {
          name: "developerFeeRate";
          type: "u16";
        },
        {
          name: "timelockDuration";
          type: "u64";
        },
        {
          name: "allowedDestinations";
          type: {
            vec: "pubkey";
          };
        },
      ];
    },
    {
      name: "queuePolicyUpdate";
      docs: ["Queue a policy update when timelock is active."];
      discriminator: [149, 18, 76, 197, 179, 193, 91, 77];
      accounts: [
        {
          name: "owner";
          writable: true;
          signer: true;
          relations: ["vault"];
        },
        {
          name: "vault";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "owner";
              },
              {
                kind: "account";
                path: "vault.vault_id";
                account: "agentVault";
              },
            ];
          };
          relations: ["policy"];
        },
        {
          name: "policy";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [112, 111, 108, 105, 99, 121];
              },
              {
                kind: "account";
                path: "vault";
              },
            ];
          };
        },
        {
          name: "pendingPolicy";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [
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
                  121,
                ];
              },
              {
                kind: "account";
                path: "vault";
              },
            ];
          };
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        },
      ];
      args: [
        {
          name: "dailySpendingCapUsd";
          type: {
            option: "u64";
          };
        },
        {
          name: "maxTransactionAmountUsd";
          type: {
            option: "u64";
          };
        },
        {
          name: "protocolMode";
          type: {
            option: "u8";
          };
        },
        {
          name: "protocols";
          type: {
            option: {
              vec: "pubkey";
            };
          };
        },
        {
          name: "maxLeverageBps";
          type: {
            option: "u16";
          };
        },
        {
          name: "canOpenPositions";
          type: {
            option: "bool";
          };
        },
        {
          name: "maxConcurrentPositions";
          type: {
            option: "u8";
          };
        },
        {
          name: "developerFeeRate";
          type: {
            option: "u16";
          };
        },
        {
          name: "timelockDuration";
          type: {
            option: "u64";
          };
        },
        {
          name: "allowedDestinations";
          type: {
            option: {
              vec: "pubkey";
            };
          };
        },
      ];
    },
    {
      name: "reactivateVault";
      docs: ["Reactivate a frozen vault. Optionally rotate the agent key."];
      discriminator: [245, 50, 143, 70, 114, 220, 25, 251];
      accounts: [
        {
          name: "owner";
          signer: true;
          relations: ["vault"];
        },
        {
          name: "vault";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "owner";
              },
              {
                kind: "account";
                path: "vault.vault_id";
                account: "agentVault";
              },
            ];
          };
        },
      ];
      args: [
        {
          name: "newAgent";
          type: {
            option: "pubkey";
          };
        },
      ];
    },
    {
      name: "registerAgent";
      docs: [
        "Register an agent's signing key to this vault.",
        "Only the owner can call this. One agent per vault.",
      ];
      discriminator: [135, 157, 66, 195, 2, 113, 175, 30];
      accounts: [
        {
          name: "owner";
          signer: true;
          relations: ["vault"];
        },
        {
          name: "vault";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "owner";
              },
              {
                kind: "account";
                path: "vault.vault_id";
                account: "agentVault";
              },
            ];
          };
        },
      ];
      args: [
        {
          name: "agent";
          type: "pubkey";
        },
      ];
    },
    {
      name: "revokeAgent";
      docs: [
        "Kill switch. Immediately freezes the vault.",
        "Only the owner can call this.",
      ];
      discriminator: [227, 60, 209, 125, 240, 117, 163, 73];
      accounts: [
        {
          name: "owner";
          signer: true;
          relations: ["vault"];
        },
        {
          name: "vault";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "owner";
              },
              {
                kind: "account";
                path: "vault.vault_id";
                account: "agentVault";
              },
            ];
          };
        },
      ];
      args: [];
    },
    {
      name: "updateOracleRegistry";
      docs: [
        "Add or remove entries from the oracle registry.",
        "Only the registry authority can call this.",
      ];
      discriminator: [184, 234, 19, 21, 41, 240, 100, 14];
      accounts: [
        {
          name: "authority";
          signer: true;
        },
        {
          name: "oracleRegistry";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101,
                  95,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121,
                ];
              },
            ];
          };
        },
      ];
      args: [
        {
          name: "entriesToAdd";
          type: {
            vec: {
              defined: {
                name: "oracleEntry";
              };
            };
          };
        },
        {
          name: "mintsToRemove";
          type: {
            vec: "pubkey";
          };
        },
      ];
    },
    {
      name: "updatePolicy";
      docs: [
        "Update the policy configuration for a vault.",
        "Only the owner can call this. Blocked when timelock > 0.",
      ];
      discriminator: [212, 245, 246, 7, 163, 151, 18, 57];
      accounts: [
        {
          name: "owner";
          signer: true;
          relations: ["vault"];
        },
        {
          name: "vault";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "owner";
              },
              {
                kind: "account";
                path: "vault.vault_id";
                account: "agentVault";
              },
            ];
          };
          relations: ["policy"];
        },
        {
          name: "policy";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [112, 111, 108, 105, 99, 121];
              },
              {
                kind: "account";
                path: "vault";
              },
            ];
          };
        },
      ];
      args: [
        {
          name: "dailySpendingCapUsd";
          type: {
            option: "u64";
          };
        },
        {
          name: "maxTransactionSizeUsd";
          type: {
            option: "u64";
          };
        },
        {
          name: "protocolMode";
          type: {
            option: "u8";
          };
        },
        {
          name: "protocols";
          type: {
            option: {
              vec: "pubkey";
            };
          };
        },
        {
          name: "maxLeverageBps";
          type: {
            option: "u16";
          };
        },
        {
          name: "canOpenPositions";
          type: {
            option: "bool";
          };
        },
        {
          name: "maxConcurrentPositions";
          type: {
            option: "u8";
          };
        },
        {
          name: "developerFeeRate";
          type: {
            option: "u16";
          };
        },
        {
          name: "timelockDuration";
          type: {
            option: "u64";
          };
        },
        {
          name: "allowedDestinations";
          type: {
            option: {
              vec: "pubkey";
            };
          };
        },
      ];
    },
    {
      name: "validateAndAuthorize";
      docs: [
        "Core permission check. Called by the agent before a DeFi action.",
        "Validates against policy constraints + oracle registry.",
        "Creates a SessionAuthority PDA, delegates tokens to agent.",
      ];
      discriminator: [22, 183, 48, 222, 218, 11, 197, 152];
      accounts: [
        {
          name: "agent";
          writable: true;
          signer: true;
        },
        {
          name: "vault";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "vault.owner";
                account: "agentVault";
              },
              {
                kind: "account";
                path: "vault.vault_id";
                account: "agentVault";
              },
            ];
          };
          relations: ["policy"];
        },
        {
          name: "policy";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [112, 111, 108, 105, 99, 121];
              },
              {
                kind: "account";
                path: "vault";
              },
            ];
          };
        },
        {
          name: "tracker";
          docs: ["Zero-copy SpendTracker"];
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [116, 114, 97, 99, 107, 101, 114];
              },
              {
                kind: "account";
                path: "vault";
              },
            ];
          };
        },
        {
          name: "oracleRegistry";
          docs: ["Protocol-level oracle registry (shared across all vaults)"];
          pda: {
            seeds: [
              {
                kind: "const";
                value: [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101,
                  95,
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121,
                ];
              },
            ];
          };
        },
        {
          name: "session";
          docs: [
            "Ephemeral session PDA — `init` ensures no double-authorization.",
            "Seeds include token_mint for per-token concurrent sessions.",
          ];
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [115, 101, 115, 115, 105, 111, 110];
              },
              {
                kind: "account";
                path: "vault";
              },
              {
                kind: "account";
                path: "agent";
              },
              {
                kind: "arg";
                path: "tokenMint";
              },
            ];
          };
        },
        {
          name: "vaultTokenAccount";
          docs: ["Vault's PDA-owned token account for the spend token"];
          writable: true;
        },
        {
          name: "tokenMintAccount";
          docs: ["The token mint being spent"];
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        },
      ];
      args: [
        {
          name: "actionType";
          type: {
            defined: {
              name: "actionType";
            };
          };
        },
        {
          name: "tokenMint";
          type: "pubkey";
        },
        {
          name: "amount";
          type: "u64";
        },
        {
          name: "targetProtocol";
          type: "pubkey";
        },
        {
          name: "leverageBps";
          type: {
            option: "u16";
          };
        },
      ];
    },
    {
      name: "withdrawFunds";
      docs: ["Withdraw tokens from the vault back to the owner."];
      discriminator: [241, 36, 29, 111, 208, 31, 104, 217];
      accounts: [
        {
          name: "owner";
          writable: true;
          signer: true;
          relations: ["vault"];
        },
        {
          name: "vault";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "owner";
              },
              {
                kind: "account";
                path: "vault.vault_id";
                account: "agentVault";
              },
            ];
          };
        },
        {
          name: "mint";
        },
        {
          name: "vaultTokenAccount";
          docs: ["Vault's PDA-controlled token account"];
          writable: true;
          pda: {
            seeds: [
              {
                kind: "account";
                path: "vault";
              },
              {
                kind: "const";
                value: [
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
                  169,
                ];
              },
              {
                kind: "account";
                path: "mint";
              },
            ];
            program: {
              kind: "const";
              value: [
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
                89,
              ];
            };
          };
        },
        {
          name: "ownerTokenAccount";
          docs: ["Owner's token account to receive funds"];
          writable: true;
          pda: {
            seeds: [
              {
                kind: "account";
                path: "owner";
              },
              {
                kind: "const";
                value: [
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
                  169,
                ];
              },
              {
                kind: "account";
                path: "mint";
              },
            ];
            program: {
              kind: "const";
              value: [
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
                89,
              ];
            };
          };
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
      ];
      args: [
        {
          name: "amount";
          type: "u64";
        },
      ];
    },
  ];
  accounts: [
    {
      name: "agentVault";
      discriminator: [232, 220, 237, 164, 157, 9, 215, 194];
    },
    {
      name: "oracleRegistry";
      discriminator: [94, 153, 19, 250, 94, 0, 12, 172];
    },
    {
      name: "pendingPolicyUpdate";
      discriminator: [77, 255, 2, 51, 79, 237, 183, 239];
    },
    {
      name: "policyConfig";
      discriminator: [219, 7, 79, 84, 175, 51, 148, 146];
    },
    {
      name: "sessionAuthority";
      discriminator: [48, 9, 30, 120, 134, 35, 172, 170];
    },
    {
      name: "spendTracker";
      discriminator: [180, 17, 195, 180, 162, 207, 239, 205];
    },
  ];
  events: [
    {
      name: "actionAuthorized";
      discriminator: [85, 90, 59, 218, 126, 8, 179, 63];
    },
    {
      name: "agentRegistered";
      discriminator: [191, 78, 217, 54, 232, 100, 189, 85];
    },
    {
      name: "agentRevoked";
      discriminator: [12, 251, 249, 166, 122, 83, 162, 116];
    },
    {
      name: "agentTransferExecuted";
      discriminator: [88, 52, 117, 69, 112, 152, 167, 40];
    },
    {
      name: "delegationRevoked";
      discriminator: [59, 158, 142, 49, 164, 116, 220, 8];
    },
    {
      name: "feesCollected";
      discriminator: [233, 23, 117, 225, 107, 178, 254, 8];
    },
    {
      name: "fundsDeposited";
      discriminator: [157, 209, 100, 95, 59, 100, 3, 68];
    },
    {
      name: "fundsWithdrawn";
      discriminator: [56, 130, 230, 154, 35, 92, 11, 118];
    },
    {
      name: "oracleRegistryInitialized";
      discriminator: [88, 111, 7, 92, 74, 14, 114, 205];
    },
    {
      name: "oracleRegistryUpdated";
      discriminator: [25, 85, 137, 57, 175, 133, 14, 77];
    },
    {
      name: "policyChangeApplied";
      discriminator: [104, 89, 5, 100, 180, 202, 52, 73];
    },
    {
      name: "policyChangeCancelled";
      discriminator: [200, 158, 226, 255, 25, 211, 30, 151];
    },
    {
      name: "policyChangeQueued";
      discriminator: [73, 231, 182, 136, 141, 120, 32, 79];
    },
    {
      name: "policyUpdated";
      discriminator: [225, 112, 112, 67, 95, 236, 245, 161];
    },
    {
      name: "sessionFinalized";
      discriminator: [33, 12, 242, 91, 206, 42, 163, 235];
    },
    {
      name: "vaultClosed";
      discriminator: [238, 129, 38, 228, 227, 118, 249, 215];
    },
    {
      name: "vaultCreated";
      discriminator: [117, 25, 120, 254, 75, 236, 78, 115];
    },
    {
      name: "vaultReactivated";
      discriminator: [197, 52, 160, 147, 159, 89, 90, 28];
    },
  ];
  errors: [
    {
      code: 6000;
      name: "vaultNotActive";
      msg: "Vault is not active";
    },
    {
      code: 6001;
      name: "unauthorizedAgent";
      msg: "Unauthorized: signer is not the registered agent";
    },
    {
      code: 6002;
      name: "unauthorizedOwner";
      msg: "Unauthorized: signer is not the vault owner";
    },
    {
      code: 6003;
      name: "tokenNotRegistered";
      msg: "Token not registered in oracle registry";
    },
    {
      code: 6004;
      name: "protocolNotAllowed";
      msg: "Protocol not allowed by policy";
    },
    {
      code: 6005;
      name: "transactionTooLarge";
      msg: "Transaction exceeds maximum single transaction size";
    },
    {
      code: 6006;
      name: "dailyCapExceeded";
      msg: "Daily spending cap would be exceeded";
    },
    {
      code: 6007;
      name: "leverageTooHigh";
      msg: "Leverage exceeds maximum allowed";
    },
    {
      code: 6008;
      name: "tooManyPositions";
      msg: "Maximum concurrent open positions reached";
    },
    {
      code: 6009;
      name: "positionOpeningDisallowed";
      msg: "Cannot open new positions (policy disallows)";
    },
    {
      code: 6010;
      name: "sessionExpired";
      msg: "Session has expired";
    },
    {
      code: 6011;
      name: "sessionNotAuthorized";
      msg: "Session not authorized";
    },
    {
      code: 6012;
      name: "invalidSession";
      msg: "Invalid session: does not belong to this vault";
    },
    {
      code: 6013;
      name: "openPositionsExist";
      msg: "Vault has open positions, cannot close";
    },
    {
      code: 6014;
      name: "tooManyAllowedProtocols";
      msg: "Policy configuration invalid: too many allowed protocols";
    },
    {
      code: 6015;
      name: "agentAlreadyRegistered";
      msg: "Agent already registered for this vault";
    },
    {
      code: 6016;
      name: "noAgentRegistered";
      msg: "No agent registered for this vault";
    },
    {
      code: 6017;
      name: "vaultNotFrozen";
      msg: "Vault is not frozen (expected frozen for reactivation)";
    },
    {
      code: 6018;
      name: "vaultAlreadyClosed";
      msg: "Vault is already closed";
    },
    {
      code: 6019;
      name: "insufficientBalance";
      msg: "Insufficient vault balance for withdrawal";
    },
    {
      code: 6020;
      name: "developerFeeTooHigh";
      msg: "Developer fee rate exceeds maximum (500 / 1,000,000 = 5 BPS)";
    },
    {
      code: 6021;
      name: "invalidFeeDestination";
      msg: "Fee destination account invalid";
    },
    {
      code: 6022;
      name: "invalidProtocolTreasury";
      msg: "Protocol treasury account does not match expected address";
    },
    {
      code: 6023;
      name: "invalidAgentKey";
      msg: "Invalid agent: cannot be the zero address";
    },
    {
      code: 6024;
      name: "agentIsOwner";
      msg: "Invalid agent: agent cannot be the vault owner";
    },
    {
      code: 6025;
      name: "overflow";
      msg: "Arithmetic overflow";
    },
    {
      code: 6026;
      name: "delegationFailed";
      msg: "Token delegation approval failed";
    },
    {
      code: 6027;
      name: "revocationFailed";
      msg: "Token delegation revocation failed";
    },
    {
      code: 6028;
      name: "oracleFeedStale";
      msg: "Oracle feed value is too stale";
    },
    {
      code: 6029;
      name: "oracleFeedInvalid";
      msg: "Cannot parse oracle feed data";
    },
    {
      code: 6030;
      name: "tokenSpendBlocked";
      msg: "Unpriced token cannot be spent (receive-only)";
    },
    {
      code: 6031;
      name: "invalidTokenAccount";
      msg: "Token account does not belong to vault or has wrong mint";
    },
    {
      code: 6032;
      name: "oracleAccountMissing";
      msg: "Oracle-priced token requires feed account in remaining_accounts";
    },
    {
      code: 6033;
      name: "oracleConfidenceTooWide";
      msg: "Oracle price confidence interval too wide";
    },
    {
      code: 6034;
      name: "oracleUnsupportedType";
      msg: "Oracle account owner is not a recognized oracle program";
    },
    {
      code: 6035;
      name: "oracleNotVerified";
      msg: "Pyth price update not fully verified by Wormhole";
    },
    {
      code: 6036;
      name: "timelockNotExpired";
      msg: "Timelock period has not expired yet";
    },
    {
      code: 6037;
      name: "timelockActive";
      msg: "Vault has timelock active — use queue_policy_update instead";
    },
    {
      code: 6038;
      name: "noTimelockConfigured";
      msg: "No timelock configured on this vault";
    },
    {
      code: 6039;
      name: "destinationNotAllowed";
      msg: "Destination not in allowed list";
    },
    {
      code: 6040;
      name: "tooManyDestinations";
      msg: "Too many destinations (max 10)";
    },
    {
      code: 6041;
      name: "invalidProtocolMode";
      msg: "Invalid protocol mode (must be 0, 1, or 2)";
    },
    {
      code: 6042;
      name: "oracleRegistryFull";
      msg: "Oracle registry is full (max 105 entries)";
    },
    {
      code: 6043;
      name: "unauthorizedRegistryAdmin";
      msg: "Unauthorized: not the oracle registry authority";
    },
    {
      code: 6044;
      name: "oraclePriceDivergence";
      msg: "Primary and fallback oracle prices diverge beyond threshold";
    },
    {
      code: 6045;
      name: "oracleBothFeedsFailed";
      msg: "Both primary and fallback oracle feeds failed";
    },
  ];
  types: [
    {
      name: "actionAuthorized";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "agent";
            type: "pubkey";
          },
          {
            name: "actionType";
            type: {
              defined: {
                name: "actionType";
              };
            };
          },
          {
            name: "tokenMint";
            type: "pubkey";
          },
          {
            name: "amount";
            type: "u64";
          },
          {
            name: "usdAmount";
            type: "u64";
          },
          {
            name: "protocol";
            type: "pubkey";
          },
          {
            name: "rollingSpendUsdAfter";
            type: "u64";
          },
          {
            name: "dailyCapUsd";
            type: "u64";
          },
          {
            name: "delegated";
            type: "bool";
          },
          {
            name: "oraclePrice";
            type: {
              option: "i128";
            };
          },
          {
            name: "oracleSource";
            type: {
              option: "u8";
            };
          },
          {
            name: "timestamp";
            type: "i64";
          },
        ];
      };
    },
    {
      name: "actionType";
      docs: ["Action types that agents can request"];
      type: {
        kind: "enum";
        variants: [
          {
            name: "swap";
          },
          {
            name: "openPosition";
          },
          {
            name: "closePosition";
          },
          {
            name: "increasePosition";
          },
          {
            name: "decreasePosition";
          },
          {
            name: "deposit";
          },
          {
            name: "withdraw";
          },
          {
            name: "transfer";
          },
        ];
      };
    },
    {
      name: "agentRegistered";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "agent";
            type: "pubkey";
          },
          {
            name: "timestamp";
            type: "i64";
          },
        ];
      };
    },
    {
      name: "agentRevoked";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "agent";
            type: "pubkey";
          },
          {
            name: "timestamp";
            type: "i64";
          },
        ];
      };
    },
    {
      name: "agentTransferExecuted";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "destination";
            type: "pubkey";
          },
          {
            name: "amount";
            type: "u64";
          },
          {
            name: "mint";
            type: "pubkey";
          },
        ];
      };
    },
    {
      name: "agentVault";
      type: {
        kind: "struct";
        fields: [
          {
            name: "owner";
            docs: ["The owner who created this vault (has full authority)"];
            type: "pubkey";
          },
          {
            name: "agent";
            docs: [
              "The registered agent's signing key (Pubkey::default() if not yet registered)",
            ];
            type: "pubkey";
          },
          {
            name: "feeDestination";
            docs: [
              "Developer fee destination — IMMUTABLE after initialization.",
              "Prevents a compromised owner from redirecting fees.",
            ];
            type: "pubkey";
          },
          {
            name: "vaultId";
            docs: [
              "Unique vault identifier (allows one owner to have multiple vaults)",
            ];
            type: "u64";
          },
          {
            name: "status";
            docs: ["Vault status: Active, Frozen, or Closed"];
            type: {
              defined: {
                name: "vaultStatus";
              };
            };
          },
          {
            name: "bump";
            docs: ["Bump seed for PDA derivation"];
            type: "u8";
          },
          {
            name: "createdAt";
            docs: ["Unix timestamp of vault creation"];
            type: "i64";
          },
          {
            name: "totalTransactions";
            docs: [
              "Total number of agent transactions executed through this vault",
            ];
            type: "u64";
          },
          {
            name: "totalVolume";
            docs: ["Total volume processed in token base units"];
            type: "u64";
          },
          {
            name: "openPositions";
            docs: ["Number of currently open positions (for perps tracking)"];
            type: "u8";
          },
          {
            name: "totalFeesCollected";
            docs: [
              "Cumulative developer fees collected from this vault (token base units)",
            ];
            type: "u64";
          },
        ];
      };
    },
    {
      name: "delegationRevoked";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "tokenAccount";
            type: "pubkey";
          },
          {
            name: "timestamp";
            type: "i64";
          },
        ];
      };
    },
    {
      name: "epochBucket";
      docs: [
        "A single epoch bucket tracking aggregate USD spend.",
        "16 bytes per bucket. USD-only — rate limiting stays client-side.",
      ];
      serialization: "bytemuck";
      repr: {
        kind: "c";
      };
      type: {
        kind: "struct";
        fields: [
          {
            name: "epochId";
            docs: ["Epoch identifier: unix_timestamp / EPOCH_DURATION"];
            type: "i64";
          },
          {
            name: "usdAmount";
            docs: ["Aggregate USD spent in this epoch (6 decimals)"];
            type: "u64";
          },
        ];
      };
    },
    {
      name: "feesCollected";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "tokenMint";
            type: "pubkey";
          },
          {
            name: "protocolFeeAmount";
            type: "u64";
          },
          {
            name: "developerFeeAmount";
            type: "u64";
          },
          {
            name: "protocolFeeRate";
            type: "u16";
          },
          {
            name: "developerFeeRate";
            type: "u16";
          },
          {
            name: "transactionAmount";
            type: "u64";
          },
          {
            name: "protocolTreasury";
            type: "pubkey";
          },
          {
            name: "developerFeeDestination";
            type: "pubkey";
          },
          {
            name: "cumulativeDeveloperFees";
            type: "u64";
          },
          {
            name: "timestamp";
            type: "i64";
          },
        ];
      };
    },
    {
      name: "fundsDeposited";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "tokenMint";
            type: "pubkey";
          },
          {
            name: "amount";
            type: "u64";
          },
          {
            name: "timestamp";
            type: "i64";
          },
        ];
      };
    },
    {
      name: "fundsWithdrawn";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "tokenMint";
            type: "pubkey";
          },
          {
            name: "amount";
            type: "u64";
          },
          {
            name: "destination";
            type: "pubkey";
          },
          {
            name: "timestamp";
            type: "i64";
          },
        ];
      };
    },
    {
      name: "oracleEntry";
      docs: ["Individual entry mapping a token mint to its oracle feed."];
      type: {
        kind: "struct";
        fields: [
          {
            name: "mint";
            docs: ["SPL token mint address"];
            type: "pubkey";
          },
          {
            name: "oracleFeed";
            docs: [
              "Pyth or Switchboard oracle feed account.",
              "Ignored when is_stablecoin is true.",
            ];
            type: "pubkey";
          },
          {
            name: "isStablecoin";
            docs: ["If true, token is 1:1 USD (no oracle read needed)"];
            type: "bool";
          },
          {
            name: "fallbackFeed";
            docs: [
              "Optional fallback oracle feed. Pubkey::default() = no fallback.",
              "Used when primary is stale/invalid. Cross-checked for divergence",
              "when both are available.",
            ];
            type: "pubkey";
          },
        ];
      };
    },
    {
      name: "oracleRegistry";
      docs: [
        "Protocol-level oracle registry — maps token mints to oracle feeds.",
        "Maintained by protocol admin. Shared across ALL vaults.",
        "Any vault can use any registered token without per-vault configuration.",
        "",
        'Seeds: `[b"oracle_registry"]`',
      ];
      type: {
        kind: "struct";
        fields: [
          {
            name: "authority";
            docs: [
              "Authority who can add/remove entries (upgradeable to multisig/DAO)",
            ];
            type: "pubkey";
          },
          {
            name: "entries";
            docs: ["Token mint → oracle feed mappings"];
            type: {
              vec: {
                defined: {
                  name: "oracleEntry";
                };
              };
            };
          },
          {
            name: "bump";
            docs: ["Bump seed for PDA"];
            type: "u8";
          },
        ];
      };
    },
    {
      name: "oracleRegistryInitialized";
      type: {
        kind: "struct";
        fields: [
          {
            name: "authority";
            type: "pubkey";
          },
          {
            name: "entryCount";
            type: "u16";
          },
        ];
      };
    },
    {
      name: "oracleRegistryUpdated";
      type: {
        kind: "struct";
        fields: [
          {
            name: "addedCount";
            type: "u16";
          },
          {
            name: "removedCount";
            type: "u16";
          },
          {
            name: "totalEntries";
            type: "u16";
          },
        ];
      };
    },
    {
      name: "pendingPolicyUpdate";
      docs: [
        "Queued policy update that becomes executable after a timelock period.",
        "Created by `queue_policy_update`, applied by `apply_pending_policy`,",
        "or cancelled by `cancel_pending_policy`.",
        "",
        'PDA seeds: `[b"pending_policy", vault.key().as_ref()]`',
      ];
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            docs: ["Associated vault pubkey"];
            type: "pubkey";
          },
          {
            name: "queuedAt";
            docs: ["Unix timestamp when this update was queued"];
            type: "i64";
          },
          {
            name: "executesAt";
            docs: ["Unix timestamp when this update becomes executable"];
            type: "i64";
          },
          {
            name: "dailySpendingCapUsd";
            type: {
              option: "u64";
            };
          },
          {
            name: "maxTransactionAmountUsd";
            type: {
              option: "u64";
            };
          },
          {
            name: "protocolMode";
            type: {
              option: "u8";
            };
          },
          {
            name: "protocols";
            type: {
              option: {
                vec: "pubkey";
              };
            };
          },
          {
            name: "maxLeverageBps";
            type: {
              option: "u16";
            };
          },
          {
            name: "canOpenPositions";
            type: {
              option: "bool";
            };
          },
          {
            name: "maxConcurrentPositions";
            type: {
              option: "u8";
            };
          },
          {
            name: "developerFeeRate";
            type: {
              option: "u16";
            };
          },
          {
            name: "timelockDuration";
            type: {
              option: "u64";
            };
          },
          {
            name: "allowedDestinations";
            type: {
              option: {
                vec: "pubkey";
              };
            };
          },
          {
            name: "bump";
            docs: ["Bump seed for PDA"];
            type: "u8";
          },
        ];
      };
    },
    {
      name: "policyChangeApplied";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "appliedAt";
            type: "i64";
          },
        ];
      };
    },
    {
      name: "policyChangeCancelled";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            type: "pubkey";
          },
        ];
      };
    },
    {
      name: "policyChangeQueued";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "executesAt";
            type: "i64";
          },
        ];
      };
    },
    {
      name: "policyConfig";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            docs: ["Associated vault pubkey"];
            type: "pubkey";
          },
          {
            name: "dailySpendingCapUsd";
            docs: [
              "Maximum aggregate spend per rolling 24h period in USD (6 decimals).",
              "$500 = 500_000_000. This is the primary spending cap.",
            ];
            type: "u64";
          },
          {
            name: "maxTransactionSizeUsd";
            docs: ["Maximum single transaction size in USD (6 decimals)."];
            type: "u64";
          },
          {
            name: "protocolMode";
            docs: [
              "Protocol access control mode:",
              "0 = all allowed (protocols list ignored)",
              "1 = allowlist (only protocols in list)",
              "2 = denylist (all except protocols in list)",
            ];
            type: "u8";
          },
          {
            name: "protocols";
            docs: [
              "Protocol pubkeys for allowlist/denylist.",
              "Bounded to MAX_ALLOWED_PROTOCOLS entries.",
            ];
            type: {
              vec: "pubkey";
            };
          },
          {
            name: "maxLeverageBps";
            docs: [
              "Maximum leverage multiplier in basis points (e.g., 10000 = 100x)",
              "Set to 0 to disallow leveraged positions entirely",
            ];
            type: "u16";
          },
          {
            name: "canOpenPositions";
            docs: [
              "Whether the agent can open new positions (vs only close existing)",
            ];
            type: "bool";
          },
          {
            name: "maxConcurrentPositions";
            docs: ["Maximum number of concurrent open positions"];
            type: "u8";
          },
          {
            name: "developerFeeRate";
            docs: [
              "Developer fee rate (rate / 1,000,000). Applied to every finalized",
              "transaction. Max MAX_DEVELOPER_FEE_RATE (500 = 5 BPS).",
            ];
            type: "u16";
          },
          {
            name: "timelockDuration";
            docs: [
              "Timelock duration in seconds for policy changes. 0 = no timelock.",
            ];
            type: "u64";
          },
          {
            name: "allowedDestinations";
            docs: [
              "Allowed destination addresses for agent transfers.",
              "Empty = any destination allowed. Bounded to MAX_ALLOWED_DESTINATIONS.",
            ];
            type: {
              vec: "pubkey";
            };
          },
          {
            name: "bump";
            docs: ["Bump seed for PDA"];
            type: "u8";
          },
        ];
      };
    },
    {
      name: "policyUpdated";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "dailyCapUsd";
            type: "u64";
          },
          {
            name: "maxTransactionSizeUsd";
            type: "u64";
          },
          {
            name: "protocolMode";
            type: "u8";
          },
          {
            name: "protocolsCount";
            type: "u8";
          },
          {
            name: "maxLeverageBps";
            type: "u16";
          },
          {
            name: "developerFeeRate";
            type: "u16";
          },
          {
            name: "timestamp";
            type: "i64";
          },
        ];
      };
    },
    {
      name: "sessionAuthority";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            docs: ["Associated vault"];
            type: "pubkey";
          },
          {
            name: "agent";
            docs: ["The agent who initiated this session"];
            type: "pubkey";
          },
          {
            name: "authorized";
            docs: [
              "Whether this session has been authorized by the permission check",
            ];
            type: "bool";
          },
          {
            name: "authorizedAmount";
            docs: ["Authorized action details (for verification in finalize)"];
            type: "u64";
          },
          {
            name: "authorizedToken";
            type: "pubkey";
          },
          {
            name: "authorizedProtocol";
            type: "pubkey";
          },
          {
            name: "actionType";
            docs: [
              "The action type that was authorized (stored so finalize can record it)",
            ];
            type: {
              defined: {
                name: "actionType";
              };
            };
          },
          {
            name: "expiresAtSlot";
            docs: ["Slot-based expiry: session is valid until this slot"];
            type: "u64";
          },
          {
            name: "delegated";
            docs: ["Whether token delegation was set up (approve CPI)"];
            type: "bool";
          },
          {
            name: "delegationTokenAccount";
            docs: [
              "The vault's token account that was delegated to the agent",
              "(only meaningful when delegated == true)",
            ];
            type: "pubkey";
          },
          {
            name: "bump";
            docs: ["Bump seed for PDA"];
            type: "u8";
          },
        ];
      };
    },
    {
      name: "sessionFinalized";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "agent";
            type: "pubkey";
          },
          {
            name: "success";
            type: "bool";
          },
          {
            name: "isExpired";
            type: "bool";
          },
          {
            name: "timestamp";
            type: "i64";
          },
        ];
      };
    },
    {
      name: "spendTracker";
      docs: [
        "Zero-copy 144-epoch circular buffer for rolling 24h USD spend tracking.",
        "Each bucket covers a 10-minute epoch. Boundary correction ensures",
        "functionally exact accuracy (~$0.000001 worst-case rounding).",
        "Rounding direction: slightly permissive (under-counts by at most $0.000001).",
        "",
        'Seeds: `[b"tracker", vault.key().as_ref()]`',
      ];
      serialization: "bytemuck";
      repr: {
        kind: "c";
      };
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            docs: ["Associated vault pubkey"];
            type: "pubkey";
          },
          {
            name: "buckets";
            docs: ["144 epoch buckets for rolling 24h spend tracking"];
            type: {
              array: [
                {
                  defined: {
                    name: "epochBucket";
                  };
                },
                144,
              ];
            };
          },
          {
            name: "bump";
            docs: ["Bump seed for PDA"];
            type: "u8";
          },
          {
            name: "padding";
            docs: ["Padding for 8-byte alignment"];
            type: {
              array: ["u8", 7];
            };
          },
        ];
      };
    },
    {
      name: "vaultClosed";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "owner";
            type: "pubkey";
          },
          {
            name: "timestamp";
            type: "i64";
          },
        ];
      };
    },
    {
      name: "vaultCreated";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "owner";
            type: "pubkey";
          },
          {
            name: "vaultId";
            type: "u64";
          },
          {
            name: "timestamp";
            type: "i64";
          },
        ];
      };
    },
    {
      name: "vaultReactivated";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "newAgent";
            type: {
              option: "pubkey";
            };
          },
          {
            name: "timestamp";
            type: "i64";
          },
        ];
      };
    },
    {
      name: "vaultStatus";
      docs: ["Vault status enum"];
      type: {
        kind: "enum";
        variants: [
          {
            name: "active";
          },
          {
            name: "frozen";
          },
          {
            name: "closed";
          },
        ];
      };
    },
  ];
};
