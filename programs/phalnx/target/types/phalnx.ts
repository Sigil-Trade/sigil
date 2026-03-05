/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/phalnx.json`.
 */
export type Phalnx = {
  address: "4ZeVCqnjUgUtFrHHPG7jELUxvJeoVGHhGNgPrhBPwrHL";
  metadata: {
    name: "phalnx";
    version: "0.1.0";
    spec: "0.1.0";
    description: "On-chain guardrails for AI agents on Solana - Permission controls, spending limits, and audit infrastructure for autonomous agents (Phalnx)";
  };
  instructions: [
    {
      name: "agentTransfer";
      docs: [
        "Transfer tokens from the vault to an allowed destination.",
        "Only the agent can call this. Stablecoin-only.",
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
      name: "applyConstraintsUpdate";
      docs: ["Apply a queued constraints update after the timelock expires."];
      discriminator: [175, 103, 90, 155, 134, 91, 135, 242];
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
          relations: ["constraints", "pendingConstraints"];
        },
        {
          name: "constraints";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 110, 115, 116, 114, 97, 105, 110, 116, 115];
              },
              {
                kind: "account";
                path: "vault";
              },
            ];
          };
        },
        {
          name: "pendingConstraints";
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
                  115,
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
      name: "cancelConstraintsUpdate";
      docs: ["Cancel a queued constraints update."];
      discriminator: [169, 121, 85, 230, 154, 2, 78, 61];
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
          relations: ["pendingConstraints"];
        },
        {
          name: "pendingConstraints";
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
                  115,
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
      name: "closeInstructionConstraints";
      docs: [
        "Close instruction constraints for the vault.",
        "Only the owner can call this. Blocked when timelock > 0 (removing constraints loosens security).",
      ];
      discriminator: [145, 240, 233, 37, 11, 78, 195, 145];
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
          relations: ["policy", "constraints"];
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
          name: "constraints";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 110, 115, 116, 114, 97, 105, 110, 116, 115];
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
      name: "closeSettledEscrow";
      docs: ["Close a settled/refunded escrow PDA — owner reclaims rent."];
      discriminator: [169, 244, 164, 173, 181, 214, 139, 6];
      accounts: [
        {
          name: "signer";
          writable: true;
          signer: true;
        },
        {
          name: "sourceVault";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "source_vault.owner";
                account: "agentVault";
              },
              {
                kind: "account";
                path: "source_vault.vault_id";
                account: "agentVault";
              },
            ];
          };
          relations: ["escrow"];
        },
        {
          name: "destinationVaultKey";
          docs: [
            "Validated indirectly: if the wrong key is passed, the escrow PDA seeds won't",
            "match and Anchor will reject the account.",
          ];
        },
        {
          name: "escrow";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [101, 115, 99, 114, 111, 119];
              },
              {
                kind: "account";
                path: "sourceVault";
              },
              {
                kind: "account";
                path: "destinationVaultKey";
              },
              {
                kind: "arg";
                path: "escrowId";
              },
            ];
          };
        },
      ];
      args: [
        {
          name: "escrowId";
          type: "u64";
        },
      ];
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
      name: "createEscrow";
      docs: [
        "Create an escrow deposit between two vaults.",
        "Agent-initiated, stablecoin-only, fees deducted upfront, cap-checked.",
      ];
      discriminator: [253, 215, 165, 116, 36, 108, 68, 80];
      accounts: [
        {
          name: "agent";
          writable: true;
          signer: true;
        },
        {
          name: "sourceVault";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "source_vault.owner";
                account: "agentVault";
              },
              {
                kind: "account";
                path: "source_vault.vault_id";
                account: "agentVault";
              },
            ];
          };
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
                path: "sourceVault";
              },
            ];
          };
        },
        {
          name: "tracker";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [116, 114, 97, 99, 107, 101, 114];
              },
              {
                kind: "account";
                path: "sourceVault";
              },
            ];
          };
        },
        {
          name: "destinationVault";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "destination_vault.owner";
                account: "agentVault";
              },
              {
                kind: "account";
                path: "destination_vault.vault_id";
                account: "agentVault";
              },
            ];
          };
        },
        {
          name: "escrow";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [101, 115, 99, 114, 111, 119];
              },
              {
                kind: "account";
                path: "sourceVault";
              },
              {
                kind: "account";
                path: "destinationVault";
              },
              {
                kind: "arg";
                path: "escrowId";
              },
            ];
          };
        },
        {
          name: "sourceVaultAta";
          docs: ["Source vault's token account (vault PDA is authority)"];
          writable: true;
        },
        {
          name: "escrowAta";
          docs: [
            "Escrow-owned ATA — init_if_needed because escrow PDA is created in same ix",
          ];
          writable: true;
          pda: {
            seeds: [
              {
                kind: "account";
                path: "escrow";
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
                path: "tokenMint";
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
          name: "protocolTreasuryAta";
          docs: [
            "Protocol treasury token account (needed when protocol_fee > 0)",
          ];
          writable: true;
          optional: true;
        },
        {
          name: "feeDestinationAta";
          docs: [
            "Developer fee destination token account (needed when developer_fee > 0)",
          ];
          writable: true;
          optional: true;
        },
        {
          name: "tokenMint";
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        },
        {
          name: "associatedTokenProgram";
          address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
        },
      ];
      args: [
        {
          name: "escrowId";
          type: "u64";
        },
        {
          name: "amount";
          type: "u64";
        },
        {
          name: "expiresAt";
          type: "i64";
        },
        {
          name: "conditionHash";
          type: {
            array: ["u8", 32];
          };
        },
      ];
    },
    {
      name: "createInstructionConstraints";
      docs: [
        "Create instruction constraints for the vault.",
        "Only the owner can call this. No timelock check (additive change).",
      ];
      discriminator: [13, 182, 97, 5, 57, 136, 26, 152];
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
          name: "constraints";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 110, 115, 116, 114, 97, 105, 110, 116, 115];
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
          name: "entries";
          type: {
            vec: {
              defined: {
                name: "constraintEntry";
              };
            };
          };
        },
      ];
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
        "Revokes delegation and closes the SessionAuthority PDA.",
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
          relations: ["session"];
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
          name: "policy";
          docs: [
            "Policy config for cap checking during non-stablecoin swap finalization",
          ];
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
          docs: [
            "Zero-copy SpendTracker for recording non-stablecoin swap value",
          ];
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
          name: "vaultTokenAccount";
          docs: ["Vault's PDA token account for the session's token"];
          writable: true;
          optional: true;
        },
        {
          name: "outputStablecoinAccount";
          docs: [
            "Vault's stablecoin ATA for non-stablecoin→stablecoin swap verification.",
            "Required when session.output_mint != Pubkey::default().",
          ];
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
          name: "maxSlippageBps";
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
      name: "queueConstraintsUpdate";
      docs: ["Queue a constraints update when timelock is active."];
      discriminator: [247, 253, 233, 93, 233, 54, 53, 131];
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
          relations: ["policy", "constraints"];
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
          name: "constraints";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 110, 115, 116, 114, 97, 105, 110, 116, 115];
              },
              {
                kind: "account";
                path: "vault";
              },
            ];
          };
        },
        {
          name: "pendingConstraints";
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
                  115,
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
          name: "entries";
          type: {
            vec: {
              defined: {
                name: "constraintEntry";
              };
            };
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
          name: "maxSlippageBps";
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
      docs: [
        "Reactivate a frozen vault. Optionally add a new agent with permissions.",
      ];
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
        {
          name: "newAgentPermissions";
          type: {
            option: "u64";
          };
        },
      ];
    },
    {
      name: "refundEscrow";
      docs: [
        "Refund an escrow — source vault's agent or owner reclaims funds after expiry.",
        "Cap charge is NOT reversed (prevents cap-washing attacks).",
      ];
      discriminator: [107, 186, 89, 99, 26, 194, 23, 204];
      accounts: [
        {
          name: "sourceSigner";
          docs: ["Source vault's agent or owner"];
          writable: true;
          signer: true;
        },
        {
          name: "sourceVault";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "source_vault.owner";
                account: "agentVault";
              },
              {
                kind: "account";
                path: "source_vault.vault_id";
                account: "agentVault";
              },
            ];
          };
        },
        {
          name: "escrow";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [101, 115, 99, 114, 111, 119];
              },
              {
                kind: "account";
                path: "sourceVault";
              },
              {
                kind: "account";
                path: "escrow.destination_vault";
                account: "escrowDeposit";
              },
              {
                kind: "account";
                path: "escrow.escrow_id";
                account: "escrowDeposit";
              },
            ];
          };
        },
        {
          name: "escrowAta";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "account";
                path: "escrow";
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
                path: "tokenMint";
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
          name: "sourceVaultAta";
          writable: true;
        },
        {
          name: "rentDestination";
          writable: true;
        },
        {
          name: "tokenMint";
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
      ];
      args: [];
    },
    {
      name: "registerAgent";
      docs: [
        "Register an agent's signing key to this vault with per-agent permissions.",
        "Only the owner can call this. Up to 10 agents per vault.",
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
        {
          name: "permissions";
          type: "u64";
        },
      ];
    },
    {
      name: "revokeAgent";
      docs: [
        "Revoke a specific agent from the vault.",
        "Only the owner can call this. Freezes vault if last agent is removed.",
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
      args: [
        {
          name: "agentToRemove";
          type: "pubkey";
        },
      ];
    },
    {
      name: "settleEscrow";
      docs: [
        "Settle an escrow — destination vault's agent claims funds before expiry.",
        "For conditional escrows, proof must match the SHA-256 condition hash.",
      ];
      discriminator: [22, 135, 160, 194, 23, 186, 124, 110];
      accounts: [
        {
          name: "destinationAgent";
          writable: true;
          signer: true;
        },
        {
          name: "destinationVault";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "destination_vault.owner";
                account: "agentVault";
              },
              {
                kind: "account";
                path: "destination_vault.vault_id";
                account: "agentVault";
              },
            ];
          };
        },
        {
          name: "sourceVault";
          pda: {
            seeds: [
              {
                kind: "const";
                value: [118, 97, 117, 108, 116];
              },
              {
                kind: "account";
                path: "source_vault.owner";
                account: "agentVault";
              },
              {
                kind: "account";
                path: "source_vault.vault_id";
                account: "agentVault";
              },
            ];
          };
        },
        {
          name: "escrow";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [101, 115, 99, 114, 111, 119];
              },
              {
                kind: "account";
                path: "sourceVault";
              },
              {
                kind: "account";
                path: "destinationVault";
              },
              {
                kind: "account";
                path: "escrow.escrow_id";
                account: "escrowDeposit";
              },
            ];
          };
        },
        {
          name: "escrowAta";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "account";
                path: "escrow";
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
                path: "tokenMint";
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
          name: "destinationVaultAta";
          writable: true;
        },
        {
          name: "rentDestination";
          writable: true;
        },
        {
          name: "tokenMint";
        },
        {
          name: "tokenProgram";
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
        },
      ];
      args: [
        {
          name: "proof";
          type: "bytes";
        },
      ];
    },
    {
      name: "syncPositions";
      docs: ["Sync the vault's open position counter with the actual state."];
      discriminator: [255, 102, 161, 80, 185, 74, 140, 60];
      accounts: [
        {
          name: "owner";
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
        },
      ];
      args: [
        {
          name: "actualPositions";
          type: "u8";
        },
      ];
    },
    {
      name: "updateAgentPermissions";
      docs: [
        "Update an agent's permission bitmask.",
        "Only the owner can call this. Blocked when timelock is active.",
      ];
      discriminator: [56, 163, 109, 133, 69, 188, 163, 184];
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
      ];
      args: [
        {
          name: "agent";
          type: "pubkey";
        },
        {
          name: "newPermissions";
          type: "u64";
        },
      ];
    },
    {
      name: "updateInstructionConstraints";
      docs: [
        "Update instruction constraints for the vault.",
        "Only the owner can call this. Blocked when timelock > 0.",
      ];
      discriminator: [229, 117, 208, 238, 102, 240, 54, 74];
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
          relations: ["policy", "constraints"];
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
          name: "constraints";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [99, 111, 110, 115, 116, 114, 97, 105, 110, 116, 115];
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
          name: "entries";
          type: {
            vec: {
              defined: {
                name: "constraintEntry";
              };
            };
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
          name: "maxSlippageBps";
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
        "Validates against policy constraints, stablecoin-only enforcement,",
        "and protocol slippage verification.",
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
          docs: [
            "The token mint being spent — constrained to match token_mint arg",
          ];
        },
        {
          name: "protocolTreasuryTokenAccount";
          docs: [
            "Protocol treasury token account (needed when protocol_fee > 0)",
          ];
          writable: true;
          optional: true;
        },
        {
          name: "feeDestinationTokenAccount";
          docs: [
            "Developer fee destination token account (needed when developer_fee > 0)",
          ];
          writable: true;
          optional: true;
        },
        {
          name: "outputStablecoinAccount";
          docs: [
            "Vault's stablecoin ATA to snapshot (for non-stablecoin input swaps).",
            "Required when input token is NOT a stablecoin.",
          ];
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
        {
          name: "instructionsSysvar";
          docs: [
            "Instructions sysvar for verifying DeFi instruction program_id",
            "and protocol slippage enforcement.",
          ];
          address: "Sysvar1nstructions1111111111111111111111111";
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
      name: "escrowDeposit";
      discriminator: [56, 152, 208, 160, 159, 83, 6, 17];
    },
    {
      name: "instructionConstraints";
      discriminator: [183, 235, 149, 166, 174, 58, 98, 218];
    },
    {
      name: "pendingConstraintsUpdate";
      discriminator: [22, 206, 77, 208, 147, 121, 53, 174];
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
      name: "agentPermissionsUpdated";
      discriminator: [203, 110, 249, 149, 51, 17, 246, 63];
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
      name: "constraintsChangeApplied";
      discriminator: [112, 150, 111, 125, 243, 133, 35, 55];
    },
    {
      name: "constraintsChangeCancelled";
      discriminator: [15, 75, 104, 222, 104, 193, 65, 145];
    },
    {
      name: "constraintsChangeQueued";
      discriminator: [111, 221, 100, 149, 52, 23, 88, 212];
    },
    {
      name: "delegationRevoked";
      discriminator: [59, 158, 142, 49, 164, 116, 220, 8];
    },
    {
      name: "escrowCreated";
      discriminator: [70, 127, 105, 102, 92, 97, 7, 173];
    },
    {
      name: "escrowRefunded";
      discriminator: [132, 209, 49, 109, 135, 138, 28, 81];
    },
    {
      name: "escrowSettled";
      discriminator: [97, 27, 150, 55, 203, 179, 173, 23];
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
      name: "instructionConstraintsClosed";
      discriminator: [107, 107, 90, 8, 81, 158, 130, 86];
    },
    {
      name: "instructionConstraintsCreated";
      discriminator: [8, 170, 99, 232, 31, 216, 57, 26];
    },
    {
      name: "instructionConstraintsUpdated";
      discriminator: [159, 63, 148, 194, 150, 209, 43, 129];
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
      name: "positionsSynced";
      discriminator: [83, 33, 144, 201, 168, 13, 0, 95];
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
      msg: "Token is not a recognized stablecoin";
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
      name: "sessionNotAuthorized";
      msg: "Session not authorized";
    },
    {
      code: 6011;
      name: "invalidSession";
      msg: "Invalid session: does not belong to this vault";
    },
    {
      code: 6012;
      name: "openPositionsExist";
      msg: "Vault has open positions, cannot close";
    },
    {
      code: 6013;
      name: "tooManyAllowedProtocols";
      msg: "Policy configuration invalid: too many allowed protocols";
    },
    {
      code: 6014;
      name: "agentAlreadyRegistered";
      msg: "Agent already registered for this vault";
    },
    {
      code: 6015;
      name: "noAgentRegistered";
      msg: "No agent registered for this vault";
    },
    {
      code: 6016;
      name: "vaultNotFrozen";
      msg: "Vault is not frozen (expected frozen for reactivation)";
    },
    {
      code: 6017;
      name: "vaultAlreadyClosed";
      msg: "Vault is already closed";
    },
    {
      code: 6018;
      name: "insufficientBalance";
      msg: "Insufficient vault balance for withdrawal";
    },
    {
      code: 6019;
      name: "developerFeeTooHigh";
      msg: "Developer fee rate exceeds maximum (500 / 1,000,000 = 5 BPS)";
    },
    {
      code: 6020;
      name: "invalidFeeDestination";
      msg: "Fee destination account invalid";
    },
    {
      code: 6021;
      name: "invalidProtocolTreasury";
      msg: "Protocol treasury account does not match expected address";
    },
    {
      code: 6022;
      name: "invalidAgentKey";
      msg: "Invalid agent: cannot be the zero address";
    },
    {
      code: 6023;
      name: "agentIsOwner";
      msg: "Invalid agent: agent cannot be the vault owner";
    },
    {
      code: 6024;
      name: "overflow";
      msg: "Arithmetic overflow";
    },
    {
      code: 6025;
      name: "invalidTokenAccount";
      msg: "Token account does not belong to vault or has wrong mint";
    },
    {
      code: 6026;
      name: "timelockNotExpired";
      msg: "Timelock period has not expired yet";
    },
    {
      code: 6027;
      name: "timelockActive";
      msg: "Vault has timelock active — use queue_policy_update instead";
    },
    {
      code: 6028;
      name: "noTimelockConfigured";
      msg: "No timelock configured on this vault";
    },
    {
      code: 6029;
      name: "destinationNotAllowed";
      msg: "Destination not in allowed list";
    },
    {
      code: 6030;
      name: "tooManyDestinations";
      msg: "Too many destinations (max 10)";
    },
    {
      code: 6031;
      name: "invalidProtocolMode";
      msg: "Invalid protocol mode (must be 0, 1, or 2)";
    },
    {
      code: 6032;
      name: "invalidNonSpendingAmount";
      msg: "Non-spending action must have amount = 0";
    },
    {
      code: 6033;
      name: "noPositionsToClose";
      msg: "No open positions to close or cancel";
    },
    {
      code: 6034;
      name: "cpiCallNotAllowed";
      msg: "Instruction must be top-level (CPI calls not allowed)";
    },
    {
      code: 6035;
      name: "missingFinalizeInstruction";
      msg: "Transaction must include finalize_session after validate";
    },
    {
      code: 6036;
      name: "nonTrackedSwapMustReturnStablecoin";
      msg: "Non-stablecoin swap must return stablecoin (balance did not increase)";
    },
    {
      code: 6037;
      name: "slippageTooHigh";
      msg: "Jupiter slippage exceeds policy max_slippage_bps or quoted_out is zero";
    },
    {
      code: 6038;
      name: "invalidJupiterInstruction";
      msg: "Cannot parse Jupiter swap instruction data";
    },
    {
      code: 6039;
      name: "invalidFlashTradeInstruction";
      msg: "Cannot parse Flash Trade instruction data";
    },
    {
      code: 6040;
      name: "flashTradePriceZero";
      msg: "Flash Trade priceWithSlippage is zero";
    },
    {
      code: 6041;
      name: "dustDepositDetected";
      msg: "Top-level SPL Token transfer not allowed between validate and finalize";
    },
    {
      code: 6042;
      name: "invalidJupiterLendInstruction";
      msg: "Cannot parse Jupiter Lend instruction data";
    },
    {
      code: 6043;
      name: "slippageBpsTooHigh";
      msg: "Slippage BPS exceeds maximum (5000 = 50%)";
    },
    {
      code: 6044;
      name: "protocolMismatch";
      msg: "DeFi instruction program does not match declared target_protocol";
    },
    {
      code: 6045;
      name: "tooManyDeFiInstructions";
      msg: "Non-stablecoin swap allows exactly one DeFi instruction";
    },
    {
      code: 6046;
      name: "maxAgentsReached";
      msg: "Maximum agents per vault reached (limit: 10)";
    },
    {
      code: 6047;
      name: "insufficientPermissions";
      msg: "Agent lacks permission for this action type";
    },
    {
      code: 6048;
      name: "invalidPermissions";
      msg: "Permission bitmask contains invalid bits";
    },
    {
      code: 6049;
      name: "escrowNotActive";
      msg: "Escrow is not in Active status";
    },
    {
      code: 6050;
      name: "escrowExpired";
      msg: "Escrow has expired";
    },
    {
      code: 6051;
      name: "escrowNotExpired";
      msg: "Escrow has not expired yet";
    },
    {
      code: 6052;
      name: "invalidEscrowVault";
      msg: "Invalid escrow vault";
    },
    {
      code: 6053;
      name: "escrowConditionsNotMet";
      msg: "Escrow conditions not met";
    },
    {
      code: 6054;
      name: "escrowDurationExceeded";
      msg: "Escrow duration exceeds maximum (30 days)";
    },
    {
      code: 6055;
      name: "invalidConstraintConfig";
      msg: "Invalid constraint configuration: bounds exceeded";
    },
    {
      code: 6056;
      name: "constraintViolated";
      msg: "Instruction constraint violated";
    },
    {
      code: 6057;
      name: "invalidConstraintsPda";
      msg: "Invalid constraints PDA: wrong owner or vault";
    },
    {
      code: 6058;
      name: "noPendingConstraintsUpdate";
      msg: "No pending constraints update to apply or cancel";
    },
    {
      code: 6059;
      name: "pendingConstraintsUpdateExists";
      msg: "A pending constraints update already exists";
    },
    {
      code: 6060;
      name: "constraintsUpdateNotExpired";
      msg: "Constraints update timelock has not expired";
    },
    {
      code: 6061;
      name: "invalidPendingConstraintsPda";
      msg: "Invalid pending constraints PDA: wrong owner or vault";
    },
    {
      code: 6062;
      name: "constraintsUpdateExpired";
      msg: "Pending constraints update has expired and is stale";
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
          {
            name: "addCollateral";
          },
          {
            name: "removeCollateral";
          },
          {
            name: "placeTriggerOrder";
          },
          {
            name: "editTriggerOrder";
          },
          {
            name: "cancelTriggerOrder";
          },
          {
            name: "placeLimitOrder";
          },
          {
            name: "editLimitOrder";
          },
          {
            name: "cancelLimitOrder";
          },
          {
            name: "swapAndOpenPosition";
          },
          {
            name: "closeAndSwapPosition";
          },
          {
            name: "createEscrow";
          },
          {
            name: "settleEscrow";
          },
          {
            name: "refundEscrow";
          },
        ];
      };
    },
    {
      name: "agentEntry";
      type: {
        kind: "struct";
        fields: [
          {
            name: "pubkey";
            type: "pubkey";
          },
          {
            name: "permissions";
            type: "u64";
          },
        ];
      };
    },
    {
      name: "agentPermissionsUpdated";
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
            name: "oldPermissions";
            type: "u64";
          },
          {
            name: "newPermissions";
            type: "u64";
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
            name: "permissions";
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
            name: "remainingAgents";
            type: "u8";
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
            name: "vaultId";
            docs: [
              "Unique vault identifier (allows one owner to have multiple vaults)",
            ];
            type: "u64";
          },
          {
            name: "agents";
            docs: [
              "Registered agents with per-agent permission bitmasks (max 10)",
            ];
            type: {
              vec: {
                defined: {
                  name: "agentEntry";
                };
              };
            };
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
      name: "constraintEntry";
      type: {
        kind: "struct";
        fields: [
          {
            name: "programId";
            type: "pubkey";
          },
          {
            name: "dataConstraints";
            type: {
              vec: {
                defined: {
                  name: "dataConstraint";
                };
              };
            };
          },
        ];
      };
    },
    {
      name: "constraintOperator";
      type: {
        kind: "enum";
        variants: [
          {
            name: "eq";
          },
          {
            name: "ne";
          },
          {
            name: "gte";
          },
          {
            name: "lte";
          },
        ];
      };
    },
    {
      name: "constraintsChangeApplied";
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
      name: "constraintsChangeCancelled";
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
      name: "constraintsChangeQueued";
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
      name: "dataConstraint";
      type: {
        kind: "struct";
        fields: [
          {
            name: "offset";
            type: "u16";
          },
          {
            name: "operator";
            type: {
              defined: {
                name: "constraintOperator";
              };
            };
          },
          {
            name: "value";
            type: "bytes";
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
      name: "escrowCreated";
      type: {
        kind: "struct";
        fields: [
          {
            name: "sourceVault";
            type: "pubkey";
          },
          {
            name: "destinationVault";
            type: "pubkey";
          },
          {
            name: "escrowId";
            type: "u64";
          },
          {
            name: "amount";
            type: "u64";
          },
          {
            name: "tokenMint";
            type: "pubkey";
          },
          {
            name: "expiresAt";
            type: "i64";
          },
          {
            name: "conditionHash";
            type: {
              array: ["u8", 32];
            };
          },
        ];
      };
    },
    {
      name: "escrowDeposit";
      type: {
        kind: "struct";
        fields: [
          {
            name: "sourceVault";
            type: "pubkey";
          },
          {
            name: "destinationVault";
            type: "pubkey";
          },
          {
            name: "escrowId";
            type: "u64";
          },
          {
            name: "amount";
            type: "u64";
          },
          {
            name: "tokenMint";
            type: "pubkey";
          },
          {
            name: "createdAt";
            type: "i64";
          },
          {
            name: "expiresAt";
            type: "i64";
          },
          {
            name: "status";
            type: {
              defined: {
                name: "escrowStatus";
              };
            };
          },
          {
            name: "conditionHash";
            type: {
              array: ["u8", 32];
            };
          },
          {
            name: "bump";
            type: "u8";
          },
        ];
      };
    },
    {
      name: "escrowRefunded";
      type: {
        kind: "struct";
        fields: [
          {
            name: "sourceVault";
            type: "pubkey";
          },
          {
            name: "destinationVault";
            type: "pubkey";
          },
          {
            name: "escrowId";
            type: "u64";
          },
          {
            name: "amount";
            type: "u64";
          },
          {
            name: "refundedBy";
            type: "pubkey";
          },
        ];
      };
    },
    {
      name: "escrowSettled";
      type: {
        kind: "struct";
        fields: [
          {
            name: "sourceVault";
            type: "pubkey";
          },
          {
            name: "destinationVault";
            type: "pubkey";
          },
          {
            name: "escrowId";
            type: "u64";
          },
          {
            name: "amount";
            type: "u64";
          },
          {
            name: "settledBy";
            type: "pubkey";
          },
        ];
      };
    },
    {
      name: "escrowStatus";
      type: {
        kind: "enum";
        variants: [
          {
            name: "active";
          },
          {
            name: "settled";
          },
          {
            name: "refunded";
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
      name: "instructionConstraints";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "entries";
            type: {
              vec: {
                defined: {
                  name: "constraintEntry";
                };
              };
            };
          },
          {
            name: "bump";
            type: "u8";
          },
        ];
      };
    },
    {
      name: "instructionConstraintsClosed";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
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
      name: "instructionConstraintsCreated";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "entriesCount";
            type: "u8";
          },
          {
            name: "timestamp";
            type: "i64";
          },
        ];
      };
    },
    {
      name: "instructionConstraintsUpdated";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "entriesCount";
            type: "u8";
          },
          {
            name: "timestamp";
            type: "i64";
          },
        ];
      };
    },
    {
      name: "pendingConstraintsUpdate";
      docs: [
        "Queued instruction constraints update that becomes executable after",
        "a timelock period. Mirrors `PendingPolicyUpdate` pattern.",
        "",
        'PDA seeds: `[b"pending_constraints", vault.key().as_ref()]`',
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
            name: "entries";
            docs: ["New constraint entries to apply"];
            type: {
              vec: {
                defined: {
                  name: "constraintEntry";
                };
              };
            };
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
            name: "bump";
            docs: ["Bump seed for PDA"];
            type: "u8";
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
            name: "maxSlippageBps";
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
            name: "maxSlippageBps";
            docs: [
              "Maximum slippage tolerance for Jupiter swaps in basis points.",
              "0 = reject all swaps (vault owner must explicitly configure).",
              "Enforced on-chain via instruction introspection of Jupiter data.",
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
            name: "hasConstraints";
            docs: [
              "Whether instruction constraints PDA exists for this vault.",
              "Set true by create_instruction_constraints, false by close_instruction_constraints.",
            ];
            type: "bool";
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
            name: "maxSlippageBps";
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
      name: "positionsSynced";
      type: {
        kind: "struct";
        fields: [
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "oldCount";
            type: "u8";
          },
          {
            name: "newCount";
            type: "u8";
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
            name: "protocolFee";
            docs: [
              "Protocol fee collected during validate (for event logging in finalize)",
            ];
            type: "u64";
          },
          {
            name: "developerFee";
            docs: [
              "Developer fee collected during validate (for event logging in finalize)",
            ];
            type: "u64";
          },
          {
            name: "outputMint";
            docs: [
              "Expected output stablecoin mint for non-stablecoin→stablecoin swaps.",
              "Pubkey::default() when input is already a stablecoin (no snapshot needed).",
            ];
            type: "pubkey";
          },
          {
            name: "stablecoinBalanceBefore";
            docs: [
              "Snapshot of vault's stablecoin ATA balance before swap.",
              "0 when input is already a stablecoin.",
            ];
            type: "u64";
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
            name: "newAgentPermissions";
            type: {
              option: "u64";
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
