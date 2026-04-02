/** Known Solana DeFi protocol program IDs */
export const KNOWN_PROTOCOLS: ReadonlyMap<string, string> = new Map([
  // DEX Aggregators
  ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "Jupiter V6"],
  ["JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcPX7a", "Jupiter V4"],
  ["JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFL2uN4e7", "Jupiter V2"],

  // Jupiter Extended
  ["JLend2fEim9xUFcaHsyGePEoBzFLvkjMi3MnPcSuCdu", "Jupiter Lend"],
  ["j1to2GQCsfSHNPfVKMcrUNyRBK8DPYECpEVPLkz1MKv", "Jupiter Trigger"],
  ["DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M", "Jupiter Recurring"],

  // DEXes
  ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "Orca Whirlpool"],
  ["9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP", "Orca Whirlpool V2"],
  ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "Raydium AMM V4"],
  ["CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", "Raydium CLMM"],
  ["CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", "Raydium CPMM"],
  ["LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", "Meteora DLMM"],
  ["Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", "Meteora Pools"],
  ["SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ", "Saber Stable Swap"],
  ["DecZY86MU5Gj7kppfUCEmd4LbXXuyZH1yHaP2NTqdiZB", "Openbook V2"],

  // Perpetuals / Leverage
  ["FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn", "Flash Trade"],
  ["FSWAPViR8ny5K96hezav8jynVubP2dJ2L7SbKzds2hwm", "Flash Composability"],
  ["dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH", "Drift Protocol"],
  ["MNGOHoFrnGrovWiCc9kHZB8xEBKM1XPYnZCpWFbRCev", "Mango Markets V4"],

  // Lending / Borrowing
  ["KLend2g3cP87ber8CzRaqeECGwNvLFM9acPVcRkRHvM", "Kamino Lending"],
  ["MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA", "Marginfi V2"],
  ["So1endDq2YkqhipRh3WViPa8hFMqDSRbsHTE15WSnBt", "Solend"],

  // Staking / Liquid Staking
  ["MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD", "Marinade Finance"],
  ["SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy", "Stake Pool Program"],
  ["J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", "Jito Staking"],

  // System Programs (always allowed)
  ["11111111111111111111111111111111", "System Program"],
  ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "Token Program"],
  ["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "Associated Token"],
  ["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "Token 2022"],
  ["ComputeBudget111111111111111111111111111111", "Compute Budget"],
  ["SysvarRent111111111111111111111111111111111", "Sysvar Rent"],
  ["SysvarC1ock11111111111111111111111111111111", "Sysvar Clock"],
]);

/** Program IDs that are always allowed (system programs, token programs) */
export const SYSTEM_PROGRAMS: ReadonlySet<string> = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ComputeBudget111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
]);

/** Common SPL token mints on Solana */
export const KNOWN_TOKENS: ReadonlyMap<
  string,
  { symbol: string; decimals: number }
> = new Map([
  // Stablecoins
  [
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    { symbol: "USDC", decimals: 6 },
  ],
  [
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    { symbol: "USDT", decimals: 6 },
  ],
  [
    "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA",
    { symbol: "USDS", decimals: 6 },
  ],

  // SOL
  [
    "So11111111111111111111111111111111111111112",
    { symbol: "SOL", decimals: 9 },
  ],

  // Wrapped BTC
  [
    "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
    { symbol: "wBTC", decimals: 8 },
  ],
  [
    "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
    { symbol: "cbBTC", decimals: 8 },
  ],

  // Ethereum
  [
    "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
    { symbol: "wETH", decimals: 8 },
  ],

  // Liquid Staking
  [
    "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    { symbol: "mSOL", decimals: 9 },
  ],
  [
    "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    { symbol: "jitoSOL", decimals: 9 },
  ],
  [
    "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
    { symbol: "bSOL", decimals: 9 },
  ],
]);

/**
 * Look up a token's symbol and decimals by mint address.
 */
export function getTokenInfo(
  mint: string,
): { symbol: string; decimals: number } | undefined {
  return KNOWN_TOKENS.get(mint);
}

/**
 * Look up a protocol's name by program ID.
 */
export function getProtocolName(programId: string): string | undefined {
  return KNOWN_PROTOCOLS.get(programId);
}

/**
 * Check if a program ID is a known system program (always allowed).
 */
export function isSystemProgram(programId: string): boolean {
  return SYSTEM_PROGRAMS.has(programId);
}

/**
 * Check if a program ID is a known DeFi protocol.
 */
export function isKnownProtocol(programId: string): boolean {
  return KNOWN_PROTOCOLS.has(programId);
}
