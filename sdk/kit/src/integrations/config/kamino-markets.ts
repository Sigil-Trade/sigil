import type { Address } from "@solana/kit";

// ─── Program Constant ───────────────────────────────────────────────────────

export const KAMINO_LENDING_PROGRAM = "KLend2g3cP87ber8CzRaqeECGwNvLFM9acPVcRkRHvM" as Address;

// ─── Reserve Config (constraint-only) ───────────────────────────────────────

/** Reserve addresses for constraint builder — token symbol → reserve PDA */
export const KAMINO_RESERVES: Record<string, { reserve: Address }> = {
  USDC: { reserve: "D6q6wuQSrifJKDDkQpJH4jZMJkGDv1NhLKpiAkQvfeWm" as Address },
  SOL:  { reserve: "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSjnTao2bNFbw" as Address },
  USDT: { reserve: "DNeuk7bXEYEYRn3MNjNFWqB5aVTW48dd55KfnKqBEhpp" as Address },
  JitoSOL: { reserve: "EVbyPKrHG6WBfm4dLxLMJpUDY43cCAcHSpnAyB5u38Zz" as Address },
  mSOL: { reserve: "HBm5i8Hno8wh4TG3apjLy6BNkb2xMuvo9bbbLsDR7NWR" as Address },
};
