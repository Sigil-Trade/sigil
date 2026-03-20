import { expect } from "chai";
import type { PhalnxClient } from "@phalnx/sdk";
import type { McpConfig } from "../../src/config";
import {
  phalnxExecute,
  type PhalnxExecuteInput,
} from "../../src/tools-v2/phalnx-execute";
import {
  createMockConfig,
  createMockClient,
  TEST_VAULT_PDA,
} from "../helpers/mock-client";

function makeMockClientWithIntents(
  runImpl?: (intent: any, vault: any, opts: any) => Promise<any>,
) {
  const base = createMockClient();
  return {
    ...base,
    intents: {
      run:
        runImpl ??
        (async (intent: any, _vault: any, _opts: any) => ({
          signature: "mock-sig-abc",
          intent,
          summary: "Mock execution succeeded",
        })),
    },
  };
}

describe("phalnx_execute", () => {
  let mockCfg: ReturnType<typeof createMockConfig>;

  beforeEach(() => {
    mockCfg = createMockConfig();
  });

  afterEach(() => {
    mockCfg.cleanup();
  });

  it("successful execute returns text containing 'Transaction Executed Successfully'", async () => {
    const client = makeMockClientWithIntents();
    const config: McpConfig = {
      rpcUrl: "https://mock.rpc",
      agentKeypairPath: mockCfg.walletPath,
    };
    const result = await phalnxExecute(
      client as unknown as PhalnxClient,
      config,
      {
        action: "swap",
        params: {
          inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          outputMint: "So11111111111111111111111111111111111111112",
          amount: "1000000",
        },
        vault: TEST_VAULT_PDA.toBase58(),
      },
    );
    expect(result).to.include("Transaction Executed Successfully");
    expect(result).to.include("mock-sig-abc");
    expect(result).to.include("Mock execution succeeded");
  });

  it("execute without vault returns 'No vault specified' with phalnx_setup reference", async () => {
    const client = makeMockClientWithIntents();
    const config: McpConfig = {
      rpcUrl: "https://mock.rpc",
      agentKeypairPath: mockCfg.walletPath,
    };
    const result = await phalnxExecute(
      client as unknown as PhalnxClient,
      config,
      {
        action: "swap",
        params: { amount: "1000000" },
        // no vault
      },
    );
    expect(result).to.include("No vault specified");
    expect(result).to.include("phalnx_setup");
    expect(result).to.not.include("shield_");
  });

  it("execute with AgentError returns formatted error with code and recovery steps", async () => {
    const agentError = {
      message: "Daily spending cap exceeded",
      code: "SPENDING_CAP_EXCEEDED",
      category: "POLICY_VIOLATION",
      retryable: false,
      recovery_actions: [
        {
          action: "increase_cap",
          description: "Ask the vault owner to increase the daily spending cap",
          tool: "phalnx_manage",
        },
      ],
      context: { currentSpent: "4500.00", cap: "5000.00" },
    };

    const client = makeMockClientWithIntents(async () => agentError);
    const config: McpConfig = {
      rpcUrl: "https://mock.rpc",
      agentKeypairPath: mockCfg.walletPath,
    };
    const result = await phalnxExecute(
      client as unknown as PhalnxClient,
      config,
      {
        action: "swap",
        params: { amount: "1000000" },
        vault: TEST_VAULT_PDA.toBase58(),
      },
    );
    expect(result).to.include("Daily spending cap exceeded");
    expect(result).to.include("SPENDING_CAP_EXCEEDED");
    expect(result).to.include("POLICY_VIOLATION");
    expect(result).to.include("Recovery Steps");
    expect(result).to.include("increase_cap");
  });

  it("execute with escalation error returns 'Cannot Execute' and 'Do NOT silently switch'", async () => {
    const escalationError = {
      message: "Protocol not supported",
      code: "PROTOCOL_NOT_SUPPORTED",
      category: "ESCALATION_REQUIRED",
      retryable: false,
      recovery_actions: [
        {
          action: "escalate_to_human",
          description: "Tell the user this protocol is not enabled",
        },
      ],
      context: { IMPORTANT: "Do NOT silently switch to another protocol" },
    };

    const client = makeMockClientWithIntents(async () => escalationError);
    const config: McpConfig = {
      rpcUrl: "https://mock.rpc",
      agentKeypairPath: mockCfg.walletPath,
    };
    const result = await phalnxExecute(
      client as unknown as PhalnxClient,
      config,
      {
        action: "protocol",
        params: { protocolId: "unsupported" },
        vault: TEST_VAULT_PDA.toBase58(),
      },
    );
    expect(result).to.include("Cannot Execute");
    expect(result).to.include("Do NOT silently switch");
    expect(result).to.include("Protocol Escalation Required");
  });

  it("execute catches thrown errors and returns formatted error string", async () => {
    const client = makeMockClientWithIntents(async () => {
      throw new Error("Network timeout");
    });
    const config: McpConfig = {
      rpcUrl: "https://mock.rpc",
      agentKeypairPath: mockCfg.walletPath,
    };
    const result = await phalnxExecute(
      client as unknown as PhalnxClient,
      config,
      {
        action: "transfer",
        params: { amount: "1000000" },
        vault: TEST_VAULT_PDA.toBase58(),
      },
    );
    expect(result).to.be.a("string");
    expect(result).to.include("Network timeout");
  });

  it("custody wallet path produces empty signers", async () => {
    let capturedOpts: any = null;
    const client = makeMockClientWithIntents(async (_intent, _vault, opts) => {
      capturedOpts = opts;
      return { signature: "mock-sig-custody", summary: "Custody execution" };
    });
    const config: McpConfig = {
      rpcUrl: "https://mock.rpc",
      agentKeypairPath: mockCfg.walletPath,
    };
    const custodyWallet = { signTransaction: async (tx: any) => tx };
    const result = await phalnxExecute(
      client as unknown as PhalnxClient,
      config,
      {
        action: "swap",
        params: { amount: "1000000" },
        vault: TEST_VAULT_PDA.toBase58(),
      },
      custodyWallet,
    );
    expect(result).to.include("Transaction Executed Successfully");
    expect(capturedOpts.signers).to.have.length(0);
  });

  it("multiple action types execute without error", async () => {
    const actions = ["swap", "transfer", "openPosition", "deposit"] as const;
    for (const action of actions) {
      const client = makeMockClientWithIntents(async (intent) => ({
        signature: `mock-sig-${action}`,
        summary: `${action} succeeded`,
      }));
      const config: McpConfig = {
        rpcUrl: "https://mock.rpc",
        agentKeypairPath: mockCfg.walletPath,
      };
      const result = await phalnxExecute(
        client as unknown as PhalnxClient,
        config,
        {
          action,
          params: { amount: "1000000" },
          vault: TEST_VAULT_PDA.toBase58(),
        },
      );
      expect(result, `${action} should succeed`).to.include(
        "Transaction Executed Successfully",
      );
    }
  });

  it("Anchor error thrown inside run() returns formatted error with suggestion", async () => {
    const client = makeMockClientWithIntents(async () => {
      throw Object.assign(new Error("SpendingCapExceeded"), { code: 6006 });
    });
    const config: McpConfig = {
      rpcUrl: "https://mock.rpc",
      agentKeypairPath: mockCfg.walletPath,
    };
    const result = await phalnxExecute(
      client as unknown as PhalnxClient,
      config,
      {
        action: "swap",
        params: { amount: "1000000" },
        vault: TEST_VAULT_PDA.toBase58(),
      },
    );
    expect(result).to.include("SpendingCapExceeded");
    expect(result).to.include("Suggestion:");
    expect(result).to.not.include("shield_");
  });

  it("successful result includes risk flags when present", async () => {
    const client = makeMockClientWithIntents(async () => ({
      signature: "mock-sig-risk",
      summary: "Swap completed with warnings",
      precheck: {
        riskFlags: ["High slippage detected", "Low liquidity pool"],
      },
    }));
    const config: McpConfig = {
      rpcUrl: "https://mock.rpc",
      agentKeypairPath: mockCfg.walletPath,
    };
    const result = await phalnxExecute(
      client as unknown as PhalnxClient,
      config,
      {
        action: "swap",
        params: { amount: "1000000" },
        vault: TEST_VAULT_PDA.toBase58(),
      },
    );
    expect(result).to.include("Transaction Executed Successfully");
    expect(result).to.include("Risk Flags");
    expect(result).to.include("High slippage detected");
    expect(result).to.include("Low liquidity pool");
  });
});
