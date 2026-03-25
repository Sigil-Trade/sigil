// @phalnx/kit/testing — Test utilities for consumers of the Phalnx SDK.
//
// Mock utilities (unit tests — no network)

export {
  MOCK_VAULT,
  MOCK_AGENT,
  MOCK_OWNER,
  MOCK_POLICY,
  MOCK_SIGNATURE,
  MOCK_BLOCKHASH,
  USDC_MINT,
  SOL_MINT,
  createMockRpc,
  createMockAgent,
  type MockRpcOverrides,
} from "./mock-rpc.js";

export {
  createMockVaultState,
  type MockVaultStateOverrides,
} from "./mock-state.js";

// NOTE: Devnet utilities intentionally NOT re-exported here.
// devnet.ts imports node:fs + @solana/web3.js — breaks browser bundlers.
// Import directly: import { ... } from "@phalnx/kit/testing/devnet"
